import chalk from "chalk";
import type { Command } from "commander";

interface DreamDeps {
	readonly fetchFromDaemon: <T>(path: string, opts?: RequestInit & { timeout?: number }) => Promise<T | null>;
}

interface DreamState {
	readonly tokensSinceLastPass: number;
	readonly lastPassAt: string | null;
	readonly lastPassId: string | null;
	readonly lastPassMode: string | null;
}

interface DreamPass {
	readonly id: string;
	readonly mode: string;
	readonly status: string;
	readonly startedAt: string;
	readonly completedAt: string | null;
	readonly tokensConsumed: number | null;
	readonly mutationsApplied: number | null;
	readonly mutationsSkipped: number | null;
	readonly mutationsFailed: number | null;
	readonly summary: string | null;
	readonly error: string | null;
}

interface DreamStatus {
	readonly enabled: boolean;
	readonly worker: { readonly running: boolean; readonly active: boolean };
	readonly state: DreamState;
	readonly config: {
		readonly provider: string;
		readonly model: string;
		readonly tokenThreshold: number;
		readonly backfillOnFirstRun: boolean;
	};
	readonly passes: readonly DreamPass[];
}

interface TriggerResult {
	readonly success: boolean;
	readonly passId: string;
	readonly applied: number;
	readonly skipped: number;
	readonly failed: number;
	readonly summary: string;
	readonly error?: string;
}

export function registerDreamCommands(program: Command, deps: DreamDeps): void {
	const dream = program.command("dream").description("Manage dreaming memory consolidation");

	dream
		.command("status")
		.description("Show dreaming worker status and recent passes")
		.action(async () => {
			const data = await deps.fetchFromDaemon<DreamStatus>("/api/dream/status");
			if (!data) {
				console.error(chalk.red("Failed to get dreaming status (is the daemon running?)"));
				process.exit(1);
			}

			console.log(chalk.bold("\n  Dreaming Status\n"));

			const enabled = data.enabled ? chalk.green("enabled") : chalk.dim("disabled");
			const worker = data.worker.running
				? data.worker.active
					? chalk.yellow("running pass")
					: chalk.green("idle")
				: chalk.dim("stopped");

			console.log(`  ${chalk.dim("Enabled:")}    ${enabled}`);
			console.log(`  ${chalk.dim("Worker:")}     ${worker}`);
			console.log(`  ${chalk.dim("Provider:")}   ${data.config.provider} / ${data.config.model}`);
			console.log(
				`  ${chalk.dim("Threshold:")}  ${data.state.tokensSinceLastPass} / ${data.config.tokenThreshold} tokens`,
			);

			if (data.state.lastPassAt) {
				console.log(`  ${chalk.dim("Last pass:")}  ${data.state.lastPassAt} (${data.state.lastPassMode})`);
			} else {
				console.log(`  ${chalk.dim("Last pass:")}  ${chalk.dim("never")}`);
			}

			if (data.passes.length > 0) {
				console.log(chalk.bold("\n  Recent Passes\n"));
				console.log(
					`  ${chalk.dim("STATUS".padEnd(12))}${chalk.dim("MODE".padEnd(14))}${chalk.dim("MUTATIONS".padEnd(24))}${chalk.dim("STARTED")}`,
				);
				for (const pass of data.passes) {
					const status =
						pass.status === "completed"
							? chalk.green(pass.status)
							: pass.status === "failed"
								? chalk.red(pass.status)
								: chalk.yellow(pass.status);
					const mutations =
						pass.mutationsApplied !== null
							? `${pass.mutationsApplied}ok/${pass.mutationsSkipped ?? 0}skip/${pass.mutationsFailed ?? 0}err`
							: "-";
					console.log(
						`  ${status.padEnd(12 + (status.length - pass.status.length))}${pass.mode.padEnd(14)}${mutations.padEnd(24)}${pass.startedAt}`,
					);
					if (pass.summary) {
						console.log(`  ${chalk.dim(pass.summary.slice(0, 100))}`);
					}
					if (pass.error) {
						console.log(`  ${chalk.red(pass.error.slice(0, 100))}`);
					}
				}
			}
			console.log();
		});

	dream
		.command("trigger")
		.description("Manually trigger a dreaming pass")
		.option("--compact", "Run in compaction mode (full graph cleanup)")
		.action(async (opts: { compact?: boolean }) => {
			const mode = opts.compact ? "compact" : "incremental";
			console.log(chalk.dim(`\n  Triggering ${mode} dreaming pass...\n`));

			const result = await deps.fetchFromDaemon<TriggerResult>("/api/dream/trigger", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode }),
				timeout: 360_000, // 6 min — dreaming can be slow
			});

			if (!result) {
				console.error(chalk.red("Failed to trigger dreaming pass (is the daemon running?)"));
				process.exit(1);
			}

			if (result.error) {
				console.error(chalk.red(`  Error: ${result.error}`));
				process.exit(1);
			}

			console.log(chalk.green("  Dreaming pass complete"));
			console.log(`  ${chalk.dim("Pass ID:")}    ${result.passId}`);
			console.log(`  ${chalk.dim("Applied:")}    ${result.applied} mutations`);
			console.log(`  ${chalk.dim("Skipped:")}    ${result.skipped} mutations`);
			console.log(`  ${chalk.dim("Failed:")}     ${result.failed} mutations`);
			console.log(`  ${chalk.dim("Summary:")}    ${result.summary}`);
			console.log();
		});
}
