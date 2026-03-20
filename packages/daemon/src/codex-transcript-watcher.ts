/**
 * Codex Transcript Watcher
 *
 * Watches Codex session transcript files in real-time and maintains a
 * live context file (~/.codex/.signet-live-context.md) with relevant
 * memories for the current conversation. Codex sessions are instructed
 * to read this file before each response, providing best-effort
 * per-prompt memory recall despite Codex having no native hook system.
 *
 * Architecture:
 *   Codex writes JSONL → chokidar detects change → incremental parse →
 *   extract user message → hybrid recall → atomic write to live file
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import { type UserPromptSubmitRequest, handleUserPromptSubmit } from "./hooks";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CodexLiveRecallConfig {
	readonly enabled: boolean;
	readonly debounceMs: number;
	readonly maxResults: number;
	readonly charBudget: number;
}

const DEFAULTS: CodexLiveRecallConfig = {
	enabled: true,
	debounceMs: 300,
	maxResults: 5,
	charBudget: 800,
};

export function resolveConfig(raw?: Partial<CodexLiveRecallConfig>): CodexLiveRecallConfig {
	if (!raw) return DEFAULTS;
	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULTS.enabled,
		debounceMs: typeof raw.debounceMs === "number" && raw.debounceMs > 0 ? raw.debounceMs : DEFAULTS.debounceMs,
		maxResults: typeof raw.maxResults === "number" && raw.maxResults > 0 ? raw.maxResults : DEFAULTS.maxResults,
		charBudget: typeof raw.charBudget === "number" && raw.charBudget > 0 ? raw.charBudget : DEFAULTS.charBudget,
	};
}

// ---------------------------------------------------------------------------
// Tracked session state
// ---------------------------------------------------------------------------

interface TrackedSession {
	readonly sessionKey: string;
	readonly project: string;
	transcriptPath: string | null;
	lastOffset: number;
	lastUserHash: string;
}

const sessions = new Map<string, TrackedSession>();

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function codexHome(): string {
	return join(homedir(), ".codex");
}

function sessionsDir(): string {
	return join(codexHome(), "sessions");
}

function liveContextPath(): string {
	return join(codexHome(), ".signet-live-context.md");
}

// ---------------------------------------------------------------------------
// JSONL parsing (incremental)
// ---------------------------------------------------------------------------

/**
 * Read new bytes appended to a JSONL file since the last offset,
 * extract user messages, and return them.
 */
function extractNewUserMessages(path: string, session: TrackedSession): string[] {
	let size: number;
	try {
		size = statSync(path).size;
	} catch {
		return [];
	}

	if (size <= session.lastOffset) return [];

	let content: string;
	try {
		// Read full file and slice from last offset. The transcript is
		// append-only so previously parsed bytes never change.
		content = readFileSync(path, "utf-8");
	} catch {
		return [];
	}

	const chunk = content.slice(session.lastOffset);
	session.lastOffset = content.length;

	const messages: string[] = [];
	for (const line of chunk.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}

		if (typeof parsed !== "object" || parsed === null) continue;
		const event = parsed as Record<string, unknown>;

		if (event.type !== "event_msg") continue;

		const payload = event.payload;
		if (typeof payload !== "object" || payload === null) continue;
		const msg = payload as Record<string, unknown>;

		if (msg.type === "user_message" && typeof msg.message === "string") {
			const text = msg.message.trim();
			if (text.length > 0) messages.push(text);
		}
	}

	return messages;
}

// ---------------------------------------------------------------------------
// Live context file writing (atomic)
// ---------------------------------------------------------------------------

function writeLiveContext(memories: string, sessionKey: string): void {
	const dest = liveContextPath();
	const tmp = `${dest}.tmp.${process.pid}`;
	const timestamp = new Date().toISOString();

	const content = `<!-- signet:live-context updated=${timestamp} session=${sessionKey} -->\n# Relevant Memories\n\n${memories}\n`;

	try {
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(tmp, content);
		renameSync(tmp, dest);
	} catch (e) {
		logger.warn("codex-watcher", "Failed to write live context", {
			error: e instanceof Error ? e.message : String(e),
		});
		// Clean up temp file on failure
		try {
			unlinkSync(tmp);
		} catch {
			// ignore
		}
	}
}

// ---------------------------------------------------------------------------
// Memory recall
// ---------------------------------------------------------------------------

async function recallForMessage(
	message: string,
	session: TrackedSession,
	config: CodexLiveRecallConfig,
): Promise<void> {
	// Dedup: skip if same message hash
	const hash = simpleHash(message);
	if (hash === session.lastUserHash) return;
	session.lastUserHash = hash;

	const req: UserPromptSubmitRequest = {
		harness: "codex",
		project: session.project,
		userMessage: message,
		sessionKey: session.sessionKey,
	};

	try {
		const result = await handleUserPromptSubmit(req);
		if (result.memoryCount > 0) {
			// Strip metadata header (date/time) — only keep memory lines
			const lines = result.inject.split("\n");
			const memoryLines = lines.filter((l) => l.startsWith("- ") || l.startsWith("[signet:recall"));
			if (memoryLines.length > 0) {
				writeLiveContext(memoryLines.join("\n"), session.sessionKey);
			}
		}
	} catch (e) {
		// Fail-open: log and continue
		logger.warn("codex-watcher", "Recall failed for message", {
			error: e instanceof Error ? e.message : String(e),
			sessionKey: session.sessionKey,
		});
	}
}

function simpleHash(s: string): string {
	let h = 0;
	for (let i = 0; i < s.length; i++) {
		h = ((h << 5) - h + s.charCodeAt(i)) | 0;
	}
	return h.toString(36);
}

// ---------------------------------------------------------------------------
// Transcript file discovery
// ---------------------------------------------------------------------------

/**
 * Find the newest JSONL file in the sessions directory that was created
 * after the session was registered.
 */
function discoverTranscript(session: TrackedSession): string | null {
	if (session.transcriptPath && existsSync(session.transcriptPath)) {
		return session.transcriptPath;
	}

	const dir = sessionsDir();
	if (!existsSync(dir)) return null;

	// Walk the date-based directory structure to find the newest file
	try {
		const now = new Date();
		const year = now.getFullYear().toString();
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		const todayDir = join(dir, year, month, day);

		if (!existsSync(todayDir)) return null;

		const files = readdirSync(todayDir)
			.filter((f: string) => f.endsWith(".jsonl"))
			.sort()
			.reverse();

		if (files.length === 0) return null;

		// Return the newest file
		return join(todayDir, files[0]);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Watcher lifecycle
// ---------------------------------------------------------------------------

let fsWatcher: FSWatcher | null = null;
let activeConfig: CodexLiveRecallConfig = DEFAULTS;
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function handleTranscriptChange(path: string): void {
	// Find which session this transcript belongs to
	let session: TrackedSession | null = null;
	for (const [, s] of sessions) {
		if (s.transcriptPath === path) {
			session = s;
			break;
		}
	}

	if (!session) {
		// Try to match by discovery (new file appeared)
		for (const [, s] of sessions) {
			if (!s.transcriptPath) {
				const discovered = discoverTranscript(s);
				if (discovered === path) {
					s.transcriptPath = path;
					session = s;
					break;
				}
			}
		}
	}

	if (!session) return;

	// Debounce per-file
	const existing = debounceTimers.get(path);
	if (existing) clearTimeout(existing);

	const captured = session;
	debounceTimers.set(
		path,
		setTimeout(() => {
			debounceTimers.delete(path);
			processTranscriptUpdate(path, captured).catch((e) =>
				logger.warn("codex-watcher", "Process failed", {
					error: e instanceof Error ? e.message : String(e),
				}),
			);
		}, activeConfig.debounceMs),
	);
}

async function processTranscriptUpdate(path: string, session: TrackedSession): Promise<void> {
	const messages = extractNewUserMessages(path, session);
	if (messages.length === 0) return;

	// Process the latest user message only (most relevant for recall)
	const latest = messages[messages.length - 1];
	await recallForMessage(latest, session, activeConfig);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the Codex transcript watcher. Call once at daemon startup.
 */
export function startCodexTranscriptWatcher(config?: Partial<CodexLiveRecallConfig>): void {
	activeConfig = resolveConfig(config);

	if (!activeConfig.enabled) {
		logger.info("codex-watcher", "Codex live recall disabled");
		return;
	}

	const dir = sessionsDir();
	if (!existsSync(dir)) {
		// Codex not installed — nothing to watch. The watcher will be
		// started on first session registration instead.
		logger.info("codex-watcher", "Sessions dir not found, deferring", {
			path: dir,
		});
		return;
	}

	startWatcher();
}

function startWatcher(): void {
	if (fsWatcher) return;

	const dir = sessionsDir();
	fsWatcher = watch(join(dir, "**", "*.jsonl"), {
		persistent: true,
		ignoreInitial: true,
	});

	fsWatcher.on("change", handleTranscriptChange);
	fsWatcher.on("add", handleTranscriptChange);

	logger.info("codex-watcher", "Transcript watcher started", {
		dir,
	});
}

/**
 * Register a Codex session for live recall tracking.
 * Called from the codex-watch-start hook endpoint.
 */
export function registerCodexSession(sessionKey: string, project: string): void {
	if (!activeConfig.enabled) return;

	sessions.set(sessionKey, {
		sessionKey,
		project,
		transcriptPath: null,
		lastOffset: 0,
		lastUserHash: "",
	});

	// Ensure watcher is running (may have been deferred if sessions dir
	// didn't exist at startup)
	if (!fsWatcher && existsSync(sessionsDir())) {
		startWatcher();
	}

	logger.info("codex-watcher", "Session registered", {
		sessionKey,
		project,
	});
}

/**
 * Unregister a Codex session and clean up.
 * Called from the session-end hook handler.
 */
export function unregisterCodexSession(sessionKey: string): void {
	const session = sessions.get(sessionKey);
	if (!session) return;

	sessions.delete(sessionKey);

	// Clear any pending debounce timer
	if (session.transcriptPath) {
		const timer = debounceTimers.get(session.transcriptPath);
		if (timer) {
			clearTimeout(timer);
			debounceTimers.delete(session.transcriptPath);
		}
	}

	// Clean up live context file if no more active sessions
	if (sessions.size === 0) {
		removeLiveContextFile();
	}

	logger.info("codex-watcher", "Session unregistered", {
		sessionKey,
	});
}

/**
 * Stop the watcher and clean up all state. Called on daemon shutdown.
 */
export function stopCodexTranscriptWatcher(): void {
	if (fsWatcher) {
		fsWatcher.close();
		fsWatcher = null;
	}

	for (const timer of debounceTimers.values()) {
		clearTimeout(timer);
	}
	debounceTimers.clear();
	sessions.clear();
	removeLiveContextFile();

	logger.info("codex-watcher", "Transcript watcher stopped");
}

function removeLiveContextFile(): void {
	try {
		const path = liveContextPath();
		if (existsSync(path)) unlinkSync(path);
	} catch {
		// ignore
	}
}
