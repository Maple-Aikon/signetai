import { resolve } from "node:path";

export interface WorkspaceMismatch {
	readonly expected: string;
	readonly actual: string;
}

export function healthWorkspaceMismatch(expected: string, actual: string | null): WorkspaceMismatch | null {
	if (!actual) {
		return {
			expected: resolve(expected),
			actual: "unknown",
		};
	}

	const normalizedExpected = resolve(expected);
	const normalizedActual = resolve(actual);
	return normalizedExpected === normalizedActual
		? null
		: {
				expected: normalizedExpected,
				actual: normalizedActual,
			};
}
