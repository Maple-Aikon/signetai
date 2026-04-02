/** Shared types for the Signet browser extension */

export interface Memory {
	readonly id: string;
	readonly content: string;
	readonly created_at: string;
	readonly who: string;
	readonly importance: number;
	readonly tags?: string | readonly string[] | null;
	readonly source_type?: string;
	readonly type?: string;
	readonly pinned?: boolean;
	readonly score?: number;
	readonly source?: "hybrid" | "vector" | "keyword";
}

export interface MemoryStats {
	readonly total: number;
	readonly withEmbeddings: number;
	readonly critical: number;
}

export interface DaemonStatus {
	readonly status: string;
	readonly version: string;
	readonly pid: number;
	readonly uptime: number;
	readonly startedAt: string;
	readonly port: number;
	readonly host: string;
	readonly agentsDir: string;
	readonly memoryDb: boolean;
}

export interface HealthResponse {
	readonly status: string;
	readonly version?: string;
	readonly uptime?: number;
}

export interface PipelineStatus {
	readonly status: string;
	readonly queue?: number;
	readonly processing?: number;
	readonly deadLetter?: number;
}

export interface Identity {
	readonly name: string;
	readonly creature: string;
	readonly vibe: string;
}

export interface RecallResult {
	readonly memories: readonly Memory[];
	readonly query: string;
	readonly count: number;
}

export interface RememberRequest {
	readonly content: string;
	readonly tags?: string;
	readonly importance?: number;
	readonly type?: string;
	readonly who?: string;
	readonly source_type?: string;
}

export interface BrowserToolRequest {
	readonly action:
		| "send-page"
		| "send-selection"
		| "capture-page"
		| "bookmark-page"
		| "write-note"
		| "transcribe-selection";
	readonly payload: string;
	readonly pageTitle?: string;
	readonly pageUrl?: string;
	readonly note?: string;
	readonly selectedText?: string;
	readonly links?: readonly string[];
	readonly images?: readonly string[];
	readonly videos?: readonly string[];
	readonly audio?: readonly string[];
	readonly files?: readonly { name: string; type: string; size: number }[];
	readonly dispatchToHarness?: boolean;
}

export interface BrowserToolResult {
	readonly success: boolean;
	readonly memoryStored: boolean;
	readonly dispatched: boolean;
	readonly memoryId?: string;
	readonly response?: string;
	readonly error?: string;
	readonly toolCalls?: readonly unknown[];
}

export type ThemeMode = "auto" | "dark" | "light";

export interface ExtensionConfig {
	readonly daemonUrl: string;
	readonly authToken: string;
	readonly theme: ThemeMode;
}

export const DEFAULT_CONFIG: ExtensionConfig = {
	daemonUrl: "http://localhost:3850",
	authToken: "",
	theme: "auto",
} as const;
