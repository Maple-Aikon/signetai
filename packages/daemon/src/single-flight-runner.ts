export interface SingleFlightRunner {
	readonly running: boolean;
	execute(): Promise<void>;
	requestRerun(): void;
}

export function createSingleFlightRunner(
	runOnce: () => Promise<void>,
	onError?: (error: Error) => void,
): SingleFlightRunner {
	let running = false;
	let rerunRequested = false;

	return {
		get running() {
			return running;
		},
		requestRerun() {
			rerunRequested = true;
		},
		async execute() {
			if (running) {
				rerunRequested = true;
				return;
			}

			running = true;
			try {
				do {
					rerunRequested = false;
					await runOnce();
				} while (rerunRequested);
			} catch (error) {
				onError?.(error instanceof Error ? error : new Error(String(error)));
			} finally {
				running = false;
			}
		},
	};
}
