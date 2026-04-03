/**
 * @signet/core - YAML utilities
 */

import YAML from "yaml";

/**
 * Parse a YAML string into a JavaScript object.
 */
export function parseSimpleYaml(text: string): Record<string, unknown> {
	const parsed = YAML.parse(text);
	return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

/**
 * Format a JavaScript object as YAML.
 */
export function formatYaml(obj: Record<string, unknown>, _indent = 0): string {
	return YAML.stringify(obj, {
		indent: 2,
		simpleKeys: true,
	});
}
