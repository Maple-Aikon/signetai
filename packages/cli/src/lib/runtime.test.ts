import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManagedDaemonPid } from "./runtime.js";

describe("readManagedDaemonPid", () => {
	it("accepts a live daemon pid when the command matches the daemon path", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-runtime-test-"));
		const dir = join(root, ".daemon");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "pid"), "4242\n");

		const pid = readManagedDaemonPid(root, {
			daemonPaths: ["/opt/signet/dist/daemon.js"],
			isAlive: () => true,
			readCmd: () => "bun /opt/signet/dist/daemon.js",
		});

		expect(pid).toBe(4242);

		rmSync(root, { recursive: true, force: true });
	});

	it("rejects a live reused pid when the command does not match signet daemon", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-runtime-test-"));
		const dir = join(root, ".daemon");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "pid");
		writeFileSync(path, "7777\n");

		const pid = readManagedDaemonPid(root, {
			daemonPaths: ["/opt/signet/dist/daemon.js"],
			isAlive: () => true,
			readCmd: () => "/usr/bin/python3 /tmp/something-else.py",
		});

		expect(pid).toBeNull();
		expect(existsSync(path)).toBe(true);

		rmSync(root, { recursive: true, force: true });
	});

	it("cleans up the pid file when the process is no longer alive", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-runtime-test-"));
		const dir = join(root, ".daemon");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "pid");
		writeFileSync(path, "8888\n");

		const pid = readManagedDaemonPid(root, {
			daemonPaths: ["/opt/signet/dist/daemon.js"],
			isAlive: () => false,
			readCmd: () => null,
		});

		expect(pid).toBeNull();
		expect(existsSync(path)).toBe(false);

		rmSync(root, { recursive: true, force: true });
	});
});
