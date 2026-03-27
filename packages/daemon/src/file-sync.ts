import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Write file content only when it differs from what's already on disk.
 * Returns true when a write occurred.
 */
export function writeFileIfChanged(path: string, content: string): boolean {
	const existing = existsSync(path) ? readFileSync(path, "utf-8") : null;
	if (existing === content) return false;
	writeFileSync(path, content);
	return true;
}
