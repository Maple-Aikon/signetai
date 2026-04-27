import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

export function resolveDefaultBasePath(): string {
	const signetPath = process.env.SIGNET_PATH;
	if (signetPath) return signetPath;

	// Check workspace config
	const xdgConfigHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	const configPath = join(xdgConfigHome, "signet", "workspace.json");
	if (existsSync(configPath)) {
		try {
			const config = JSON.parse(readFileSync(configPath, "utf-8"));
			if (config.workspace) return config.workspace;
		} catch {
			// ignore malformed config
		}
	}

	return join(homedir(), ".agents");
}

export function expandHome(p: string, home = homedir()): string {
	if (p === "~") return home;
	if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
	return p;
}

export const SCHEMA_VERSION = 3;
export const SPEC_VERSION = "1.0";
export const SCHEMA_ID = "signet/v1";

export const DEFAULT_EMBEDDING_DIMENSIONS = 768;
export const DEFAULT_HYBRID_ALPHA = 0.7;
export const DEFAULT_REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
