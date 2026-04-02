<script lang="ts">
import { API_BASE, getIdentity } from "$lib/api";
import {
	os,
	fetchTrayEntries,
	fetchWidgetHtml,
	getWidgetSandbox,
	moveToGrid,
	sendWidgetAction,
	setAgentSession,
} from "$lib/stores/os.svelte";
import Bot from "@lucide/svelte/icons/bot";
import Check from "@lucide/svelte/icons/check";
import Copy from "@lucide/svelte/icons/copy";
import Cpu from "@lucide/svelte/icons/cpu";
import ExternalLink from "@lucide/svelte/icons/external-link";
import Mic from "@lucide/svelte/icons/mic";
import Send from "@lucide/svelte/icons/send";
import User from "@lucide/svelte/icons/user";
import Wrench from "@lucide/svelte/icons/wrench";
import { onMount, tick } from "svelte";

interface ChatModelOption {
	id: string;
	label: string;
	description: string;
	provider: string;
}

interface AudioInputOption {
	id: string;
	label: string;
}

interface ToolCall {
	tool: string;
	server: string;
	result?: unknown;
	error?: string;
}

interface ChatMessage {
	role: "user" | "agent";
	content: string;
	timestamp: number;
	toolCalls?: ToolCall[];
	openedWidget?: string; // server ID of widget that was opened
}

type HeaderChatAction = "remember" | "transcribe" | "recall";

interface HeaderActionOptions {
	targetLanguage?: string;
}

interface HeaderActionResult {
	ok: boolean;
	message?: string;
	error?: string;
}

interface SendInvocation {
	messageText: string;
	displayText?: string;
	clearInput?: boolean;
}

type SpeechRecognitionInstance = {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onresult: ((event: Event) => void) | null;
	onerror: ((event: Event) => void) | null;
	onend: (() => void) | null;
	start: (track?: MediaStreamTrack) => void;
	stop: () => void;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

let messages = $state<ChatMessage[]>([]);
let input = $state("");
let loading = $state(false);
let loadingStatus = $state("");
let chatEl: HTMLDivElement | null = $state(null);
let inputEl: HTMLInputElement | null = $state(null);
let modelOptions = $state<ChatModelOption[]>([]);
let selectedModelId = $state("");
let modelOptionsLoading = $state(true);
let modelOptionsError = $state<string | null>(null);
let speechSupported = $state(false);
let listening = $state(false);
let voiceBusy = $state(false);
let voiceError = $state<string | null>(null);
let recognition: SpeechRecognitionInstance | null = null;
let activeMicStream: MediaStream | null = null;
let microphoneOptions = $state<AudioInputOption[]>([]);
let selectedMicrophoneId = $state("default");
let signetIdentityName = $state("your Signet identity");
let copiedMessageTimestamp = $state<number | null>(null);
let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
const AGENT_EXEC_TIMEOUT_MS = 30_000;

onMount(() => {
	void loadChatModels();
	void loadIdentityName();
	void loadMicrophoneOptions();
	speechSupported = Boolean(getSpeechRecognitionCtor());
	const handleDeviceChange = () => {
		void loadMicrophoneOptions();
	};
	navigator.mediaDevices?.addEventListener?.("devicechange", handleDeviceChange);
	return () => {
		if (copyResetTimer) {
			clearTimeout(copyResetTimer);
			copyResetTimer = null;
		}
		if (recognition && listening) {
			recognition.stop();
		}
		releaseActiveMicStream();
		navigator.mediaDevices?.removeEventListener?.("devicechange", handleDeviceChange);
	};
});

async function loadChatModels(): Promise<void> {
	modelOptionsLoading = true;
	modelOptionsError = null;
	try {
		const res = await fetch(`${API_BASE}/api/os/chat/models`);
		if (!res.ok) throw new Error(`Chat model request failed (${res.status})`);
		const data = (await res.json()) as {
			options?: ChatModelOption[];
			defaultModelId?: string;
		};
		const options = Array.isArray(data.options) ? data.options : [];
		modelOptions = options;

		if (typeof data.defaultModelId === "string" && options.some((opt) => opt.id === data.defaultModelId)) {
			selectedModelId = data.defaultModelId;
		} else if (options.length > 0) {
			selectedModelId = options[0]!.id;
		} else {
			selectedModelId = "";
			modelOptionsError = "No available chat providers were discovered. Install/configure Codex, Claude Code, OpenCode, or Ollama.";
		}
	} catch (err) {
		modelOptions = [];
		selectedModelId = "";
		modelOptionsError = err instanceof Error ? err.message : "Unable to load chat models";
	} finally {
		modelOptionsLoading = false;
	}
}

async function loadIdentityName(): Promise<void> {
	try {
		const identity = await getIdentity();
		const resolved = identity?.name?.trim();
		if (resolved && resolved.toLowerCase() !== "unknown") {
			signetIdentityName = resolved.toLowerCase();
		}
	} catch {
		// Keep fallback copy when identity is unavailable.
	}
}

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
	if (typeof window === "undefined") return null;
	const maybeCtor = (window as Window & { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor })
		.SpeechRecognition ??
		(window as Window & { webkitSpeechRecognition?: SpeechRecognitionCtor }).webkitSpeechRecognition;
	return maybeCtor ?? null;
}

function releaseActiveMicStream(): void {
	if (!activeMicStream) return;
	for (const track of activeMicStream.getTracks()) {
		track.stop();
	}
	activeMicStream = null;
}

async function loadMicrophoneOptions(): Promise<void> {
	if (!navigator.mediaDevices?.enumerateDevices) return;
	const devices = await navigator.mediaDevices.enumerateDevices();
	const discovered = devices
		.filter((device) => device.kind === "audioinput")
		.map((device, index) => ({
			id: device.deviceId,
			label: device.label?.trim() || `Microphone ${index + 1}`,
		}));
	const options: AudioInputOption[] = [
		{ id: "default", label: "Browser default microphone" },
		...discovered.filter((device) => device.id !== "default"),
	];
	microphoneOptions = options;
	if (!selectedMicrophoneId || !options.some((option) => option.id === selectedMicrophoneId)) {
		selectedMicrophoneId = "default";
	}
}

async function requestMicrophoneStream(deviceId?: string): Promise<MediaStream> {
	if (!navigator.mediaDevices?.getUserMedia) {
		throw new Error("Microphone capture is not supported in this browser.");
	}
	if (deviceId && deviceId !== "default") {
		try {
			return await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
		} catch {
			return await navigator.mediaDevices.getUserMedia({ audio: true });
		}
	}
	return await navigator.mediaDevices.getUserMedia({ audio: true });
}

function appendVoiceTranscript(text: string): void {
	const transcript = text.trim();
	if (!transcript) return;
	input = transcript;
	inputEl?.focus();
}

function extractTranscriptFromVoiceEvent(event: Event): string {
	const speechEvent = event as Event & {
		results?: ArrayLike<{
			isFinal?: boolean;
			0?: { transcript?: string };
			item?: (index: number) => { transcript?: string } | null;
		}> & {
			item?: (index: number) => {
				isFinal?: boolean;
				0?: { transcript?: string };
				item?: (index: number) => { transcript?: string } | null;
			} | null;
		};
	};
	const list = speechEvent.results;
	if (!list) return "";

	let transcript = "";
	for (let index = 0; index < list.length; index += 1) {
		const result = list[index] ?? list.item?.(index) ?? null;
		const primaryAlt = result?.[0] ?? result?.item?.(0) ?? null;
		const chunk = typeof primaryAlt?.transcript === "string" ? primaryAlt.transcript.trim() : "";
		if (!chunk) continue;
		transcript += `${chunk} `;
	}

	if (transcript.trim()) return transcript.trim();

	const fallbackTranscript = (event as Event & { transcript?: string }).transcript;
	return typeof fallbackTranscript === "string" ? fallbackTranscript.trim() : "";
}

async function toggleVoiceCapture(): Promise<void> {
	voiceError = null;
	if (listening) {
		voiceBusy = true;
		recognition?.stop();
		return;
	}

	const ctor = getSpeechRecognitionCtor();
	if (!ctor) {
		voiceError = "Voice input is not supported in this browser.";
		return;
	}

	voiceBusy = true;
	try {
		releaseActiveMicStream();
		activeMicStream = await requestMicrophoneStream(selectedMicrophoneId || undefined);
		await loadMicrophoneOptions();
		const inputBase = input.trim();
		recognition = new ctor();
		recognition.continuous = false;
		recognition.interimResults = true;
		recognition.lang = navigator.language || "en-US";
		recognition.onresult = (event: Event) => {
			const transcript = extractTranscriptFromVoiceEvent(event);
			if (!transcript) return;
			const merged = inputBase ? `${inputBase} ${transcript}` : transcript;
			appendVoiceTranscript(merged);
		};
		recognition.onerror = (event: Event) => {
			const errorValue = (event as Event & { error?: string }).error;
			if (errorValue === "no-speech") {
				voiceError = "No speech detected. Try speaking immediately after the mic turns active.";
			} else if (errorValue && errorValue !== "aborted") {
				voiceError = `Voice capture failed: ${errorValue}`;
			}
			listening = false;
			voiceBusy = false;
			recognition = null;
			releaseActiveMicStream();
		};
		recognition.onend = () => {
			listening = false;
			voiceBusy = false;
			recognition = null;
			releaseActiveMicStream();
		};
		listening = true;
		voiceBusy = false;
		const selectedTrack = activeMicStream.getAudioTracks()[0] ?? undefined;
		if (selectedTrack) {
			try {
				recognition.start(selectedTrack);
			} catch {
				recognition.start();
			}
		} else {
			recognition.start();
		}
	} catch (error) {
		voiceError = error instanceof Error ? error.message : "Unable to access microphone.";
		listening = false;
		voiceBusy = false;
		recognition = null;
		releaseActiveMicStream();
	}
}

async function scrollToBottom() {
	await tick();
	if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
}

/**
 * Place a widget on the grid and load its HTML.
 * Returns true if the widget was placed/already on grid.
 */
async function openWidgetForServer(serverId: string): Promise<boolean> {
	const entry = os.entries.find((e) => e.id === serverId);
	if (!entry) {
		// Refresh tray entries in case the server was just installed
		await fetchTrayEntries();
		const refreshed = os.entries.find((e) => e.id === serverId);
		if (!refreshed) return false;
	}

	const target = os.entries.find((e) => e.id === serverId);
	if (!target) return false;

	// Move to grid if not already there
	if (target.state !== "grid") {
		await moveToGrid(serverId);
	}

	// Ensure widget HTML is loaded
	await fetchWidgetHtml(serverId);

	// Highlight the widget briefly
	highlightWidget(serverId);

	return true;
}

/** Flash a highlight border on a widget to draw attention */
function highlightWidget(serverId: string): void {
	const gridItems = document.querySelectorAll(".grid-item");
	for (const item of gridItems) {
		const card = item.querySelector(".widget-card");
		if (!card) continue;
		// Check if this grid item contains the target widget
		const titleEl = item.querySelector(".widget-title");
		const entry = os.entries.find((e) => e.id === serverId);
		if (titleEl && entry && titleEl.textContent?.toLowerCase().includes(entry.name.toLowerCase())) {
			item.classList.add("widget-chat-highlight");
			item.scrollIntoView({ behavior: "smooth", block: "nearest" });
			setTimeout(() => item.classList.remove("widget-chat-highlight"), 2000);
			break;
		}
	}
}

let agentRunning = $state(false);

/**
 * Execute a visual agent task — the AI cursor clicks through the widget
 * while the user watches in real-time.
 */
async function executeAgentTask(serverId: string, task: string): Promise<string> {
	agentRunning = true;

	try {
		// 1. Open the widget on the grid
		loadingStatus = `opening ${serverId.replace("ghl-", "")}...`;
		const opened = await openWidgetForServer(serverId);
		if (!opened) throw new Error(`Could not open widget for ${serverId}`);

		// Wait for widget to be ready and PageController to initialize
		await new Promise((r) => setTimeout(r, 1500));

		// 2. Start agent session on daemon
		loadingStatus = "starting agent...";
		const ctl = new AbortController();
		const timeout = setTimeout(() => ctl.abort(), AGENT_EXEC_TIMEOUT_MS);
		let execRes: Response;
		try {
			execRes = await fetch(`${API_BASE}/api/os/agent-execute`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ serverId, task }),
				signal: ctl.signal,
			});
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				throw new Error("Timed out while starting agent session");
			}

			throw err;
		} finally {
			clearTimeout(timeout);
		}
		const execData = await execRes.json();

		if (!execRes.ok || !execData.sessionId) {
			throw new Error(execData.error || "Failed to start agent session");
		}

		const sessionId = execData.sessionId;

		setAgentSession({
			serverId,
			status: "starting",
			currentStep: 0,
			totalSteps: 20,
		});

		// 3. Connect to SSE stream for agent events
		return await new Promise<string>((resolve, reject) => {
			const evtSource = new EventSource(`${API_BASE}/api/os/agent-events?session=${sessionId}`);
			let result = "Agent task completed";

			evtSource.onmessage = async (e) => {
				try {
					const event = JSON.parse(e.data);

					if (event.type === "connected") return;

					if (event.type === "agentStart") {
						// Tell the widget iframe to show the mask/cursor
						const sandbox = getWidgetSandbox(event.serverId);
						if (sandbox) sandbox.agentStart();
						return;
					}

					if (event.type === "agentStop") {
						// Tell the widget iframe to hide the mask/cursor
						const sandbox = getWidgetSandbox(event.serverId);
						if (sandbox) sandbox.agentStop();
						return;
					}

					if (event.type === "getDomState") {
						// Daemon is requesting DOM state — get it from the widget
						const sandbox = getWidgetSandbox(event.serverId);
						if (!sandbox) {
							await fetch(`${API_BASE}/api/os/agent-state`, {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({
									sessionId,
									domState: { success: false, error: "Widget sandbox not found" },
								}),
							});
							return;
						}

						try {
							const domState = await sandbox.getDomState();
							await fetch(`${API_BASE}/api/os/agent-state`, {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({ sessionId, domState }),
							});
						} catch (err) {
							await fetch(`${API_BASE}/api/os/agent-state`, {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({
									sessionId,
									domState: { success: false, error: err instanceof Error ? err.message : String(err) },
								}),
							});
						}
						return;
					}

					if (event.type === "executeAction") {
						// Daemon wants us to execute an action in the widget
						const sandbox = getWidgetSandbox(event.serverId);
						if (sandbox && event.data?.action) {
							try {
								await sandbox.executeAction(event.data.action);
							} catch (err) {
								console.warn("executeAction error:", err);
							}
						}
						return;
					}

					if (event.type === "status") {
						const d = event.data as { step?: number; status?: string; message?: string };
						loadingStatus = d?.message || `step ${d?.step}...`;
						setAgentSession({
							serverId: event.serverId,
							status: (d?.status as "observing" | "thinking" | "acting") || "starting",
							currentStep: d?.step || 0,
							totalSteps: 20,
							lastAction: d?.message,
						});
						scrollToBottom();
						return;
					}

					if (event.type === "done") {
						const d = event.data as { summary?: string };
						result = d?.summary || "Task completed";
						setAgentSession(null);
						evtSource.close();
						resolve(result);
						return;
					}

					if (event.type === "error") {
						const d = event.data as { error?: string };
						setAgentSession(null);
						evtSource.close();
						reject(new Error(d?.error || "Agent error"));
						return;
					}
				} catch (err) {
					console.warn("Agent SSE parse error:", err);
				}
			};

			evtSource.onerror = () => {
				setAgentSession(null);
				evtSource.close();
				reject(new Error("Agent event stream disconnected"));
			};

			// Timeout after 5 minutes
			setTimeout(() => {
				setAgentSession(null);
				evtSource.close();
				reject(new Error("Agent execution timed out"));
			}, 300000);
		});
	} finally {
		agentRunning = false;
		setAgentSession(null);
	}
}

function buildSessionTranscript(limit = 16): string {
	const recent = messages.slice(-limit);
	return recent
		.map((msg, index) => `${index + 1}. ${msg.role.toUpperCase()}: ${msg.content}`)
		.join("\n");
}

async function sendInvocation(invocation: SendInvocation): Promise<boolean> {
	const text = invocation.messageText.trim();
	if (!text || loading) return false;
	if (!selectedModelId) {
		messages.push({
			role: "agent",
			content:
				modelOptionsError ||
				"No chat provider is selected. Start the branch daemon and make sure /api/os/chat/models is reachable.",
			timestamp: Date.now(),
		});
		await scrollToBottom();
		return false;
	}

	messages.push({ role: "user", content: invocation.displayText?.trim() || text, timestamp: Date.now() });
	if (invocation.clearInput) input = "";
	loading = true;
	loadingStatus = "thinking...";
	scrollToBottom();

	try {
		// Send to chat endpoint — LLM decides if this needs visual agent or direct tools
		const res = await fetch(`${API_BASE}/api/os/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: text, modelId: selectedModelId }),
		});
		const data = (await res.json().catch(() => ({}))) as {
			response?: string;
			error?: string;
			useAgent?: boolean;
			agentServerId?: string;
			agentTask?: string;
			toolCalls?: ToolCall[];
		};
		if (!res.ok) {
			throw new Error(data.error || `Chat request failed (${res.status})`);
		}

		// ═══════════════════════════════════════════════════════════════
		// VISUAL AGENT MODE — LLM decided this needs the AI cursor
		// ═══════════════════════════════════════════════════════════════
		if (data.useAgent && data.agentServerId) {
			// Show the LLM's immediate response first
			messages.push({
				role: "agent",
				content: data.response ?? "starting visual agent...",
				timestamp: Date.now(),
			});
			scrollToBottom();

			loadingStatus = "starting visual agent...";

			try {
				const agentResult = await executeAgentTask(data.agentServerId, data.agentTask || text);
				messages.push({
					role: "agent",
					content: agentResult,
					timestamp: Date.now(),
					openedWidget: data.agentServerId,
				});
			} catch (err) {
				messages.push({
					role: "agent",
					content: `agent hit a wall: ${err instanceof Error ? err.message : String(err)}`,
					timestamp: Date.now(),
				});
			}

			return true;
		}

		// ═══════════════════════════════════════════════════════════════
		// DIRECT TOOL MODE — standard tool calls (read operations)
		// ═══════════════════════════════════════════════════════════════
		const toolCalls: ToolCall[] = data.toolCalls ?? [];

		// If tools were called, open the related widget(s) and trigger actions
		let openedWidget: string | undefined;
		if (toolCalls.length > 0) {
			const serverIds = [...new Set(toolCalls.map((tc) => tc.server))];
			for (const sid of serverIds) {
				loadingStatus = `opening ${sid.replace("ghl-", "")}...`;
				const opened = await openWidgetForServer(sid);
				if (opened) openedWidget = sid;
			}

			for (const tc of toolCalls) {
				if (tc.error) continue;
				const tool = tc.tool;
				const sid = tc.server;

				// Mutation tools → refresh the widget to show changes
				const isMutation =
					tool.startsWith("create_") ||
					tool.startsWith("update_") ||
					tool.startsWith("delete_") ||
					tool.startsWith("add_") ||
					tool.startsWith("remove_") ||
					tool.startsWith("merge_");

				if (isMutation) {
					loadingStatus = `updating ${sid.replace("ghl-", "")}...`;
					await new Promise((r) => setTimeout(r, 800));
					sendWidgetAction(sid, "refresh");
				}

				if (tc.result) {
					try {
						const resultData = typeof tc.result === "string" ? JSON.parse(tc.result) : tc.result;
						const content = resultData?.content?.[0]?.text;
						const parsed = content ? JSON.parse(content) : resultData;

						const firstName = parsed?.contact?.firstName || parsed?.firstName || "";
						const lastName = parsed?.contact?.lastName || parsed?.lastName || "";
						const name =
							`${firstName} ${lastName}`.trim() || parsed?.contactName || parsed?.name || parsed?.title || null;

						if (name && isMutation) {
							await new Promise((r) => setTimeout(r, 3000));
							sendWidgetAction(sid, "highlight", { text: name });
						}
					} catch {
						// Result parsing failed — skip highlight
					}
				}
			}
		}

		messages.push({
			role: "agent",
			content: data.response ?? data.error ?? "No response",
			timestamp: Date.now(),
			toolCalls,
			openedWidget,
		});
		return true;
	} catch (err) {
		messages.push({
			role: "agent",
			content: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
			timestamp: Date.now(),
		});
		return false;
	} finally {
		loading = false;
		loadingStatus = "";
		scrollToBottom();
	}
}

export async function triggerHeaderAction(
	action: HeaderChatAction,
	options: HeaderActionOptions = {},
): Promise<HeaderActionResult> {
	if (loading) {
		return { ok: false, error: "Chat is busy right now. Wait for the current response to finish." };
	}

	if (action === "transcribe") {
		const sourceText = input.trim();
		if (!sourceText) {
			return { ok: false, error: "Paste text into the chat input first, then click Transcribe." };
		}
		const targetLanguage = options.targetLanguage?.trim() || "English";
		const sent = await sendInvocation({
			messageText: [
				"You are Signet OS Transcribe mode.",
				`Transcribe and translate the provided text into ${targetLanguage}.`,
				"Preserve intent, tone, and key details.",
				"Return only the final transcription in the target language.",
				"Text:",
				sourceText,
			].join("\n\n"),
			displayText: `Transcribe to ${targetLanguage}:\n${sourceText}`,
			clearInput: true,
		});
		return sent
			? { ok: true, message: `Transcribe request sent through chat (${targetLanguage}).` }
			: { ok: false, error: "Transcribe request failed. Check the latest chat output." };
	}

	const transcript = buildSessionTranscript();
	if (!transcript) {
		return { ok: false, error: "No active chat session yet. Start chatting first." };
	}

	if (action === "remember") {
		const sent = await sendInvocation({
			messageText: [
				"You are Signet OS Remember mode.",
				"Use this current chat session transcript as context.",
				"Persist the important long-term facts from this session if memory tools are available.",
				"Then reply with: (1) what you remembered, (2) confidence, (3) any items not stored.",
				"Session transcript:",
				transcript,
			].join("\n\n"),
			displayText: "Remember everything important from this current session.",
		});
		return sent
			? { ok: true, message: "Remember request sent through chat." }
			: { ok: false, error: "Remember request failed. Check the latest chat output." };
	}

	const focus = input.trim();
	const sent = await sendInvocation({
		messageText: [
			"You are Signet OS Recall mode.",
			"Compare relevant saved memories with the active session context.",
			"Highlight similarities, differences, missing facts, and potential conflicts.",
			"If memory tools are available, use them before answering.",
			focus ? `Focus query: ${focus}` : "Focus query: current session",
			"Session transcript:",
			transcript,
		].join("\n\n"),
		displayText: focus
			? `Recall and compare memories against this context:\n${focus}`
			: "Recall and compare memories against this session.",
		clearInput: Boolean(focus),
	});
	return sent
		? { ok: true, message: "Recall request sent through chat." }
		: { ok: false, error: "Recall request failed. Check the latest chat output." };
}

async function send() {
	const text = input.trim();
	if (!text) return;
	await sendInvocation({ messageText: text, displayText: text, clearInput: true });
}

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		send();
	}
}

function handleInputDragOver(e: DragEvent): void {
	const types = e.dataTransfer?.types;
	if (!types) return;
	if (!types.includes("application/x-signet-chat-snippet")) return;
	e.preventDefault();
	if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
}

function insertTextAtCursor(target: HTMLInputElement, text: string): void {
	const start = target.selectionStart ?? target.value.length;
	const end = target.selectionEnd ?? target.value.length;
	const before = target.value.slice(0, start);
	const after = target.value.slice(end);
	target.value = `${before}${text}${after}`;
	const nextPos = start + text.length;
	target.selectionStart = nextPos;
	target.selectionEnd = nextPos;
	input = target.value;
}

function handleInputDrop(e: DragEvent): void {
	const snippet = e.dataTransfer?.getData("application/x-signet-chat-snippet")?.trim();
	if (!snippet) return;
	e.preventDefault();
	if (!inputEl) {
		input = `${input}${input ? " " : ""}${snippet}`.trim();
		return;
	}
	insertTextAtCursor(inputEl, snippet);
}

async function copyMessageContent(content: string, timestamp: number): Promise<void> {
	const text = content.trim();
	if (!text) return;
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
		} else {
			const area = document.createElement("textarea");
			area.value = text;
			area.style.position = "fixed";
			area.style.opacity = "0";
			document.body.appendChild(area);
			area.focus();
			area.select();
			document.execCommand("copy");
			area.remove();
		}
		copiedMessageTimestamp = timestamp;
		if (copyResetTimer) clearTimeout(copyResetTimer);
		copyResetTimer = setTimeout(() => {
			if (copiedMessageTimestamp === timestamp) {
				copiedMessageTimestamp = null;
			}
		}, 1800);
	} catch {
		// Ignore clipboard failures silently; chat remains usable.
	}
}

function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function getWidgetName(serverId: string): string {
	const entry = os.entries.find((e) => e.id === serverId);
	return entry?.name ?? serverId;
}

function scrollToWidget(serverId: string): void {
	highlightWidget(serverId);
}

// Agent mode is now auto-detected by the LLM in os-chat.ts
// No manual /agent command needed — just type naturally
</script>

<div class="agent-chat">
	<!-- Message history -->
	<div class="chat-messages" bind:this={chatEl}>
		{#if messages.length === 0}
			<div class="chat-empty">
				<Bot class="size-5 opacity-30" />
				<span class="sig-label" style="color: var(--sig-text-muted)">
					Ask {signetIdentityName} a question, or anything you want.
				</span>
			</div>
		{/if}

		{#each messages as msg (msg.timestamp)}
			<div class="chat-msg chat-msg--{msg.role}">
				<div class="chat-msg-icon">
					{#if msg.role === "user"}
						<User class="size-3" />
					{:else}
						<Bot class="size-3" />
					{/if}
				</div>
				<div class="chat-msg-body">
					{#if msg.role === "agent"}
						<div class="chat-msg-actions">
							<button
								class="chat-copy-btn"
								type="button"
								title="Copy response"
								onclick={() => copyMessageContent(msg.content, msg.timestamp)}
							>
								{#if copiedMessageTimestamp === msg.timestamp}
									<Check class="size-3" />
								{:else}
									<Copy class="size-3" />
								{/if}
							</button>
						</div>
					{/if}
					<div class="chat-msg-content">{msg.content}</div>
					{#if msg.toolCalls && msg.toolCalls.length > 0}
						<div class="chat-tool-calls">
							{#each msg.toolCalls as tc}
								<div class="chat-tool-call">
									<Wrench class="size-2.5" />
									<span class="chat-tool-name">{tc.server}/{tc.tool}</span>
									{#if tc.error}
										<span class="chat-tool-error">failed</span>
									{:else}
										<span class="chat-tool-ok">done</span>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
					{#if msg.openedWidget}
						<button
							class="chat-widget-link"
							onclick={() => scrollToWidget(msg.openedWidget!)}
						>
							<ExternalLink class="size-2.5" />
							<span>Showing in {getWidgetName(msg.openedWidget)}</span>
						</button>
					{/if}
					<span class="chat-msg-time">{formatTime(msg.timestamp)}</span>
				</div>
			</div>
		{/each}

		{#if loading}
			<div class="chat-msg chat-msg--agent">
				<div class="chat-msg-icon">
					{#if agentRunning}
						<Cpu class="size-3 agent-pulse" />
					{:else}
						<Bot class="size-3" />
					{/if}
				</div>
				<div class="chat-msg-body">
					<div class="chat-thinking" class:agent-active={agentRunning}>
						{#if agentRunning}
							<span class="agent-indicator"></span>
						{:else}
							<span class="dot"></span>
							<span class="dot"></span>
							<span class="dot"></span>
						{/if}
						<span class="chat-status-text">{loadingStatus}</span>
					</div>
				</div>
			</div>
		{/if}
	</div>

	<!-- Input bar -->
	<div class="chat-input-bar">
		{#if modelOptionsError}
			<div class="chat-model-error">{modelOptionsError}</div>
		{/if}
		{#if voiceError}
			<div class="chat-model-error">{voiceError}</div>
		{/if}
		<div class="chat-input-controls">
			<select
				class="chat-mic-select"
				bind:value={selectedMicrophoneId}
				disabled={loading || listening || microphoneOptions.length === 0}
				title="Choose microphone"
			>
				{#if microphoneOptions.length > 0}
					{#each microphoneOptions as mic (mic.id)}
						<option value={mic.id}>{mic.label}</option>
					{/each}
				{:else}
					<option value="" disabled>No microphones found</option>
				{/if}
			</select>
			<select
				class="chat-model-select"
				bind:value={selectedModelId}
				disabled={loading || modelOptionsLoading}
				title="Choose chat model"
			>
				{#if modelOptions.length > 0}
					{#each modelOptions as option (option.id)}
						<option value={option.id}>{option.label}</option>
					{/each}
				{:else}
					<option value="" disabled>No providers found</option>
				{/if}
			</select>
		</div>
		<div class="chat-input-compose">
			<input
				type="text"
				class="chat-input"
				placeholder="Ask your agent..."
				bind:this={inputEl}
				bind:value={input}
				onkeydown={handleKeydown}
				ondragover={handleInputDragOver}
				ondrop={handleInputDrop}
				disabled={loading}
			/>
			{#if speechSupported}
				<button
					class="chat-voice-btn"
					class:active={listening}
					title={listening ? "Stop voice input" : "Use microphone"}
					onclick={toggleVoiceCapture}
					disabled={loading || (voiceBusy && !listening)}
				>
					{#if listening}
						<span class="chat-voice-bars" aria-hidden="true">
							<span class="bar"></span>
							<span class="bar"></span>
							<span class="bar"></span>
						</span>
					{:else}
						<Mic class="size-3.5" />
					{/if}
				</button>
			{/if}
			<button
				class="chat-send-btn"
				title="Send message"
				onclick={send}
				disabled={loading || !selectedModelId || !input.trim()}
			>
				<Send class="size-3.5" />
			</button>
		</div>
	</div>
</div>

<style>
	.agent-chat {
		display: flex;
		flex-direction: column;
		border-top: 1px solid var(--sig-border);
		background: var(--sig-bg);
		max-height: 360px;
		min-height: 140px;
	}

	.chat-messages {
		flex: 1;
		overflow-y: auto;
		padding: var(--space-sm) var(--space-md);
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.chat-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: var(--space-lg) var(--space-md);
		text-align: center;
		opacity: 0.7;
	}

	.chat-msg {
		display: flex;
		gap: 8px;
		max-width: 85%;
		animation: chatFadeIn 0.15s ease-out;
	}

	.chat-msg--user {
		align-self: flex-end;
		flex-direction: row-reverse;
	}

	.chat-msg--agent {
		align-self: flex-start;
	}

	.chat-msg-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		background: var(--sig-surface);
		border: 1px solid var(--sig-border);
		color: var(--sig-text-muted);
		flex-shrink: 0;
		padding: 0;
	}

	.chat-msg-icon :global(svg) {
		width: 12px;
		height: 12px;
		color: currentColor;
	}

	.chat-msg--agent .chat-msg-icon {
		border-color: color-mix(in srgb, var(--sig-highlight) 62%, var(--sig-warning));
		background: color-mix(in srgb, var(--sig-highlight) 11%, var(--sig-surface));
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--sig-highlight) 30%, transparent), var(--sig-glow-highlight);
		color: var(--sig-text-muted);
	}

	.chat-msg--user .chat-msg-icon {
		background: color-mix(in srgb, var(--sig-surface) 90%, var(--sig-bg));
		border-color: color-mix(in srgb, var(--sig-warning) 55%, var(--sig-border));
		color: var(--sig-text-muted);
	}

	.chat-msg--user .chat-msg-icon :global(svg) {
		color: color-mix(in srgb, var(--sig-highlight) 84%, var(--sig-warning));
		background: color-mix(in srgb, var(--sig-highlight) 22%, transparent);
		border: 1px solid color-mix(in srgb, var(--sig-highlight) 58%, var(--sig-warning));
		border-radius: 999px;
		padding: 1px;
		box-shadow: var(--sig-glow-highlight);
	}

	.chat-msg-body {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.chat-msg-actions {
		display: flex;
		justify-content: flex-end;
		margin-bottom: 1px;
	}

	.chat-copy-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		padding: 0;
		border-radius: 6px;
		border: 1px solid var(--sig-border);
		background: var(--sig-bg);
		color: var(--sig-text-muted);
		cursor: pointer;
		transition: all var(--dur) var(--ease);
	}

	.chat-copy-btn:hover {
		border-color: var(--sig-highlight);
		color: var(--sig-highlight);
		background: color-mix(in srgb, var(--sig-highlight) 10%, var(--sig-bg));
	}

	.chat-msg-content {
		font-family: var(--font-mono);
		font-size: 12px;
		line-height: 1.5;
		color: var(--sig-text);
		background: var(--sig-surface);
		border: 1px solid var(--sig-border);
		border-radius: 8px;
		padding: 6px 10px;
		word-break: break-word;
		white-space: pre-wrap;
	}

	.chat-msg--user .chat-msg-content {
		background: color-mix(in srgb, var(--sig-accent) 8%, var(--sig-surface));
		border-color: color-mix(in srgb, var(--sig-accent) 20%, var(--sig-border));
	}

	.chat-msg-time {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
		padding: 0 4px;
		opacity: 0.6;
	}

	.chat-msg--user .chat-msg-time {
		text-align: right;
	}

	.chat-tool-calls {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-top: 2px;
	}

	.chat-tool-call {
		display: flex;
		align-items: center;
		gap: 4px;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		padding: 2px 6px;
		background: color-mix(in srgb, var(--sig-accent) 5%, var(--sig-bg));
		border-radius: 4px;
		border: 1px solid var(--sig-border);
	}

	.chat-tool-name {
		font-weight: 600;
		color: var(--sig-accent);
	}

	.chat-tool-ok {
		color: var(--sig-success, #5a7a5a);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.chat-tool-error {
		color: var(--sig-danger, #7a4a4a);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.chat-widget-link {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-accent);
		padding: 2px 8px;
		background: color-mix(in srgb, var(--sig-accent) 8%, var(--sig-bg));
		border: 1px solid color-mix(in srgb, var(--sig-accent) 25%, var(--sig-border));
		border-radius: 4px;
		cursor: pointer;
		margin-top: 2px;
		transition: all 0.15s ease;
	}

	.chat-widget-link:hover {
		background: color-mix(in srgb, var(--sig-accent) 15%, var(--sig-bg));
		border-color: var(--sig-accent);
	}

	/* Thinking dots */
	.chat-thinking {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 6px 10px;
		background: var(--sig-surface);
		border: 1px solid var(--sig-border);
		border-radius: 8px;
	}

	.chat-status-text {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		margin-left: 4px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--sig-text-muted);
		animation: dotPulse 1.2s ease-in-out infinite;
	}

	.dot:nth-child(2) {
		animation-delay: 0.2s;
	}

	.dot:nth-child(3) {
		animation-delay: 0.4s;
	}

	@keyframes dotPulse {
		0%, 60%, 100% {
			opacity: 0.2;
			transform: scale(0.8);
		}
		30% {
			opacity: 1;
			transform: scale(1);
		}
	}

	/* Agent mode styles */
	.agent-active {
		border-color: var(--sig-electric, #39b6ff) !important;
		background: color-mix(in srgb, var(--sig-electric, #39b6ff) 8%, var(--sig-surface)) !important;
	}

	.agent-indicator {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--sig-electric, #39b6ff);
		animation: agentPulse 1s ease-in-out infinite;
	}

	:global(.agent-pulse) {
		color: var(--sig-electric, #39b6ff) !important;
		animation: agentPulse 1s ease-in-out infinite;
	}

	@keyframes agentPulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	@keyframes chatFadeIn {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	/* Input bar */
	.chat-input-bar {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 8px;
		padding: 8px var(--space-md);
		border-top: 1px solid var(--sig-border);
		background: var(--sig-surface);
		flex-shrink: 0;
	}

	.chat-model-error {
		width: 100%;
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 1.4;
		color: var(--sig-danger, #8a4545);
	}

	.chat-input-controls {
		display: flex;
		gap: 6px;
		width: 100%;
	}

	.chat-model-select,
	.chat-mic-select {
		flex: 1 1 220px;
		min-width: 0;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text);
		background: var(--sig-bg);
		border: 1px solid var(--sig-border);
		border-radius: 6px;
		padding: 6px 8px;
		outline: none;
		transition: border-color var(--dur) var(--ease);
	}

	.chat-model-select:focus,
	.chat-mic-select:focus {
		border-color: var(--sig-accent);
	}

	.chat-model-select:disabled,
	.chat-mic-select:disabled {
		opacity: 0.5;
	}

	.chat-input-compose {
		position: relative;
		width: 100%;
	}

	.chat-input {
		width: 100%;
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--sig-text);
		background: var(--sig-bg);
		border: 1px solid color-mix(in srgb, var(--sig-highlight) 65%, var(--sig-border));
		border-radius: 6px;
		padding: 8px 78px 8px 10px;
		outline: none;
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--sig-highlight) 22%, transparent);
		transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
	}

	.chat-input::placeholder {
		color: var(--sig-text-muted);
		opacity: 0.6;
	}

	.chat-input:focus {
		border-color: var(--sig-highlight);
		box-shadow: var(--sig-glow-highlight);
	}

	.chat-input:disabled {
		opacity: 0.5;
	}

	.chat-send-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		position: absolute;
		right: 6px;
		top: 50%;
		transform: translateY(-50%);
		width: 30px;
		height: 30px;
		padding: 0;
		border: 1px solid var(--sig-border);
		border-radius: 6px;
		background: var(--sig-surface);
		color: var(--sig-text-muted);
		cursor: pointer;
		transition: all var(--dur) var(--ease);
		z-index: 2;
	}

	.chat-voice-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		position: absolute;
		right: 42px;
		top: 50%;
		transform: translateY(-50%);
		width: 30px;
		height: 30px;
		padding: 0;
		border: 1px solid var(--sig-border);
		border-radius: 6px;
		background: var(--sig-surface);
		color: var(--sig-text-muted);
		cursor: pointer;
		transition: all var(--dur) var(--ease);
		z-index: 2;
	}

	.chat-voice-btn:hover:not(:disabled) {
		border-color: var(--sig-highlight);
		color: var(--sig-highlight);
		background: color-mix(in srgb, var(--sig-highlight) 10%, var(--sig-surface));
	}

	.chat-voice-btn.active {
		border-color: color-mix(in srgb, var(--sig-highlight) 70%, var(--sig-warning));
		color: var(--sig-highlight);
		box-shadow: var(--sig-glow-highlight);
	}

	.chat-voice-btn:disabled {
		opacity: 0.3;
		cursor: default;
	}

	.chat-voice-bars {
		display: inline-flex;
		align-items: flex-end;
		gap: 2px;
		height: 12px;
	}

	.chat-voice-bars .bar {
		width: 2px;
		height: 100%;
		border-radius: 2px;
		background: currentColor;
		transform-origin: center bottom;
		animation: chatVoiceWave 0.9s ease-in-out infinite;
	}

	.chat-voice-bars .bar:nth-child(2) {
		animation-delay: 0.15s;
	}

	.chat-voice-bars .bar:nth-child(3) {
		animation-delay: 0.3s;
	}

	@keyframes chatVoiceWave {
		0%,
		100% {
			transform: scaleY(0.35);
			opacity: 0.45;
		}
		50% {
			transform: scaleY(1);
			opacity: 1;
		}
	}

	.chat-send-btn:hover:not(:disabled) {
		border-color: var(--sig-accent);
		color: var(--sig-accent);
		background: color-mix(in srgb, var(--sig-accent) 8%, var(--sig-surface));
	}

	.chat-send-btn:disabled {
		opacity: 0.3;
		cursor: default;
	}
</style>
