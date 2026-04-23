import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerRouteCommands } from "./route";

const prevLog = console.log;
const prevError = console.error;
const prevExit = process.exit;
const tempDirs: string[] = [];

afterEach(() => {
	console.log = prevLog;
	console.error = prevError;
	Object.defineProperty(process, "exit", {
		configurable: true,
		value: prevExit,
	});
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) continue;
		rmSync(dir, { recursive: true, force: true });
	}
});

function createProgram(agentsDir: string): Command {
	const program = new Command();
	registerRouteCommands(program, {
		AGENTS_DIR: agentsDir,
		fetchFromDaemon: async () => null,
		secretApiCall: async () => ({ ok: false, data: null }),
	});
	return program;
}

describe("registerRouteCommands", () => {
	test("route pin refuses to rewrite an existing agent.yaml without explicit confirmation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-route-command-"));
		tempDirs.push(dir);
		const agentYamlPath = join(dir, "agent.yaml");
		const original = "# keep this operator note\nidentity:\n  name: tester\n";
		writeFileSync(agentYamlPath, original);

		const errors: string[] = [];
		console.error = (line?: unknown) => {
			errors.push(String(line ?? ""));
		};
		Object.defineProperty(process, "exit", {
			configurable: true,
			value(code?: string | number | null | undefined) {
				throw new Error(`exit ${code ?? 0}`);
			},
		});

		await expect(createProgram(dir).parseAsync(["node", "test", "route", "pin", "primary/fast"])).rejects.toThrow(
			"exit 1",
		);

		expect(readFileSync(agentYamlPath, "utf-8")).toBe(original);
		expect(errors.join("\n")).toContain("--rewrite-agent-yaml");
	});

	test("route pin rewrites agent.yaml only when explicitly confirmed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-route-command-"));
		tempDirs.push(dir);
		const agentYamlPath = join(dir, "agent.yaml");
		writeFileSync(agentYamlPath, "# keep this operator note\nidentity:\n  name: tester\n");
		console.log = () => {};

		await createProgram(dir).parseAsync(["node", "test", "route", "pin", "primary/fast", "--rewrite-agent-yaml"]);

		const yaml = readFileSync(agentYamlPath, "utf-8");
		expect(yaml).toContain("pinnedTargets:");
		expect(yaml).toContain("default: primary/fast");
	});
});
