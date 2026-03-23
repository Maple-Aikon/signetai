/**
 * Agent registry store — manages the list of agents and their live state
 * for the Agent Control Room.
 */

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

/** Reactive room state */
export const room = $state({
	agents: [] as Agent[],
	selectedId: null as string | null,
	loading: false,
	error: null as string | null,
});

/** Assign colors round-robin */
let colorIdx = 0;
export function nextColor(): G3Color {
	const c = G3_COLORS[colorIdx % G3_COLORS.length];
	colorIdx++;
	return c;
}

/** Fetch agents from daemon — demo data for Phase 1 */
export async function fetchAgents(): Promise<void> {
	room.loading = true;
	try {
		room.agents = [
			{
				id: "oogie",
				name: "Oogie",
				role: "assistant",
				color: "bondi",
				status: "active",
				source: { type: "clawdbot", sessionKey: "agent:main:main" },
				lastActivity: "chatting in #sig",
				model: "claude-opus-4-6",
			},
			{
				id: "coder",
				name: "Code Agent",
				role: "developer",
				color: "tangerine",
				status: "active",
				source: { type: "process", pid: 1234, name: "claude" },
				lastActivity: "editing os-chat.ts",
				model: "claude-sonnet-4-6",
			},
			{
				id: "research",
				name: "Research",
				role: "researcher",
				color: "grape",
				status: "idle",
				source: { type: "clawdbot", sessionKey: "agent:main:subagent:abc" },
				lastActivity: "waiting for task",
			},
			{
				id: "scraper",
				name: "Web Scraper",
				role: "scraper",
				color: "lime",
				status: "active",
				source: { type: "process", pid: 5678, name: "agent-browser" },
				lastActivity: "scanning upwork.com",
			},
			{
				id: "ghl",
				name: "GHL Hub",
				role: "crm",
				color: "strawberry",
				status: "active",
				source: { type: "mcp", serverId: "ghl-contacts-hub" },
				lastActivity: "16 tools available",
			},
			{
				id: "poly",
				name: "Polymarket",
				role: "trading",
				color: "blueberry",
				status: "error",
				source: { type: "clawdbot", sessionKey: "agent:main:subagent:poly" },
				lastActivity: "API timeout",
			},
		];
	} finally {
		room.loading = false;
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
