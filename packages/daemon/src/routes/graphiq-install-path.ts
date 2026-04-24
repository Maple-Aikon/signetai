import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function getInstallScriptPath(): string {
	const thisDir = dirname(fileURLToPath(import.meta.url));
	const bundled = resolve(thisDir, "../scripts/install-graphiq.sh");
	if (existsSync(bundled)) return bundled;
	return resolve(thisDir, "../../../../scripts/install-graphiq.sh");
}
