/**
 * Agent registry store — manages the list of agents and their live state
 * for the Agent Control Room.
 */

import { API_BASE } from "$lib/api";

export interface Agent {
	id: string;
	name: string;
	role: string;
	color: string;
	status: "active" | "idle" | "error" | "offline";
	source: AgentSource;
	lastActivity?: string;
	lastMessage?: string;
	uptime?: number;
	tokens?: { input: number; output: number; cost: number };
	model?: string;
	toolCount?: number;
}

export type AgentSource =
	| { type: "clawdbot"; sessionKey: string }
	| { type: "process"; pid: number; name: string }
	| { type: "mcp"; serverId: string }
	| { type: "manual"; label: string };

const G3_COLORS = [
	"bondi",
	"tangerine",
	"grape",
	"lime",
	"strawberry",
	"blueberry",
	"sage",
	"ruby",
	"indigo",
	"snow",
	"graphite",
	"flower",
] as const;

export type G3Color = (typeof G3_COLORS)[number];

/** Stable color assignment by agent id */
const colorMap = new Map<string, string>();

function assignColor(id: string): string {
	const existing = colorMap.get(id);
	if (existing) return existing;
	const color = G3_COLORS[colorMap.size % G3_COLORS.length];
	colorMap.set(id, color);
	return color;
}

/** Reactive room state */
export const room = $state({
	agents: [] as Agent[],
	selectedId: null as string | null,
	loading: false,
	error: null as string | null,
});

/** Assign colors round-robin (legacy compat) */
let colorIdx = 0;
export function nextColor(): G3Color {
	const c = G3_COLORS[colorIdx % G3_COLORS.length];
	colorIdx++;
	return c;
}

/** Fetch agents from daemon — real discovery via /api/room/agents */
export async function fetchAgents(): Promise<void> {
	room.loading = true;
	room.error = null;
	try {
		const res = await fetch(`${API_BASE}/api/room/agents`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		if (!Array.isArray(data.agents)) throw new Error("Invalid response");

		room.agents = data.agents.map((a: Record<string, unknown>) => ({
			id: String(a.id || ""),
			name: String(a.name || "Unknown"),
			role: String(a.role || "agent"),
			color: assignColor(String(a.id || "")),
			status: String(a.status || "offline") as Agent["status"],
			source: a.source as AgentSource,
			lastActivity: a.lastActivity ? String(a.lastActivity) : undefined,
			lastMessage: a.lastMessage ? String(a.lastMessage) : undefined,
			model: a.model ? String(a.model) : undefined,
			toolCount: typeof a.toolCount === "number" ? a.toolCount : undefined,
		}));
	} catch (err) {
		room.error = err instanceof Error ? err.message : String(err);
		// Keep existing agents on error; only clear if we never had any
		if (room.agents.length === 0) {
			room.agents = [];
		}
	} finally {
		room.loading = false;
	}
}

/** Auto-refresh polling */
let refreshTimer: ReturnType<typeof setInterval> | null = null;

export function startPolling(): void {
	if (refreshTimer) return;
	fetchAgents();
	refreshTimer = setInterval(fetchAgents, 10_000);
}

export function stopPolling(): void {
	if (refreshTimer) {
		clearInterval(refreshTimer);
		refreshTimer = null;
	}
}

export function selectAgent(id: string | null): void {
	room.selectedId = id;
}

/** Pad grid to 12 slots (4×3) */
export function getGridSlots(): (Agent | null)[] {
	const slots: (Agent | null)[] = [...room.agents];
	while (slots.length < 12) slots.push(null);
	return slots.slice(0, 12);
}
