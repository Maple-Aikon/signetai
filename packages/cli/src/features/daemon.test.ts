import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { doRestart, doStart, doStop, requestPipelinePauseApi, summarizePipelineToggle } from "./daemon.js";

describe("requestPipelinePauseApi", () => {
	it("uses the live daemon pause endpoint when available", async () => {
		const result = await requestPipelinePauseApi(3850, true, async (input, init) => {
			expect(String(input)).toBe("http://localhost:3850/api/pipeline/pause");
			expect(init?.method).toBe("POST");
			return new Response(
				JSON.stringify({
					success: true,
					changed: true,
					paused: true,
					file: "/tmp/agent.yaml",
					mode: "paused",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		expect(result).toEqual({
			kind: "ok",
			data: {
				success: true,
				changed: true,
				paused: true,
				file: "/tmp/agent.yaml",
				mode: "paused",
			},
		});
	});

	it("falls back when the live endpoint is unavailable", async () => {
		const result = await requestPipelinePauseApi(3850, false, async () => {
			return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
		});

		expect(result).toEqual({ kind: "fallback" });
	});

	it("surfaces daemon API errors instead of silently falling back", async () => {
		await expect(
			requestPipelinePauseApi(3850, true, async () => {
				return new Response(JSON.stringify({ error: "Pipeline transition already in progress" }), {
					status: 409,
					headers: { "Content-Type": "application/json" },
				});
			}),
		).rejects.toThrow("Pipeline transition already in progress");
	});
});

describe("summarizePipelineToggle", () => {
	it("reports resume as still disabled when the pause flag clears under disabled mode", () => {
		expect(summarizePipelineToggle(false, "disabled", true)).toEqual({
			title: "Pipeline pause cleared, still disabled",
			detail:
				"  Pause flag cleared, but the pipeline is still disabled in config. Enable it before extraction can run.",
		});
	});
});

function makeDeps(overrides?: Partial<Parameters<typeof doRestart>[1]>): Parameters<typeof doRestart>[1] {
	return {
		agentsDir: "/tmp/.agents",
		defaultPort: 3850,
		extractPathOption: () => null,
		getDaemonStatus: async () => ({
			running: true,
			pid: 42,
			uptime: 1,
			version: "0.77.1",
			host: "127.0.0.1",
			bindHost: "0.0.0.0",
			networkMode: "local",
			extraction: null,
		}),
		hasDaemonProcess: async () => false,
		isDaemonRunning: async () => false,
		normalizeAgentPath: (pathValue) => pathValue,
		signetLogo: () => "",
		sleep: async () => {},
		startDaemon: async () => true,
		stopDaemon: async () => true,
		...overrides,
	};
}

describe("daemon lifecycle recovery", () => {
	it("restart stops a stale daemon process even when health checks say stopped", async () => {
		const calls: string[] = [];
		const deps = makeDeps({
			hasDaemonProcess: async () => true,
			startDaemon: async () => {
				calls.push("start");
				return true;
			},
			stopDaemon: async () => {
				calls.push("stop");
				return true;
			},
		});

		await doRestart({ openclaw: false }, deps);

		expect(calls).toEqual(["stop", "start"]);
	});

	it("stop attempts cleanup for a stale daemon process even when health checks fail", async () => {
		let stopped = false;
		const deps = makeDeps({
			hasDaemonProcess: async () => true,
			stopDaemon: async () => {
				stopped = true;
				return true;
			},
		});

		await doStop({}, deps);

		expect(stopped).toBe(true);
	});
});

// Regression: #429 — failure paths must exit non-zero
describe("daemon exit codes on failure", () => {
	let exitSpy: ReturnType<typeof spyOn>;

	afterEach(() => {
		exitSpy?.mockRestore();
	});

	it("doStart exits with code 1 when startDaemon returns false", async () => {
		exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});

		const deps = makeDeps({ startDaemon: async () => false });

		await expect(doStart({}, deps)).rejects.toThrow("EXIT_1");
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it("doStop exits with code 1 when stopDaemon returns false", async () => {
		exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});

		const deps = makeDeps({
			isDaemonRunning: async () => true,
			stopDaemon: async () => false,
		});

		await expect(doStop({}, deps)).rejects.toThrow("EXIT_1");
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it("doRestart exits with code 1 when startDaemon returns false", async () => {
		exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});

		const deps = makeDeps({ startDaemon: async () => false });

		await expect(doRestart({ openclaw: false }, deps)).rejects.toThrow("EXIT_1");
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it("doRestart exits with code 1 when stopDaemon returns false during restart", async () => {
		exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});

		const deps = makeDeps({
			isDaemonRunning: async () => true,
			stopDaemon: async () => false,
		});

		await expect(doRestart({ openclaw: false }, deps)).rejects.toThrow("EXIT_1");
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});
