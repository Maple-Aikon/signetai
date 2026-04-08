interface RecallScoreFilterRow {
	readonly score?: number;
	readonly supplementary?: boolean;
}

interface RecallScoreFilterPayload {
	readonly results?: ReadonlyArray<RecallScoreFilterRow>;
}

export function applyRecallScoreThreshold(raw: unknown, minScore?: number): unknown {
	if (typeof minScore !== "number" || typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return raw;
	}

	const payload = raw as RecallScoreFilterPayload;
	const rows = Array.isArray(payload.results) ? payload.results : [];
	const filtered = rows.filter((row) => typeof row.score !== "number" || row.score >= minScore);

	return {
		...payload,
		results: filtered,
		meta: {
			totalReturned: filtered.length,
			hasSupplementary: filtered.some((row) => row.supplementary === true),
			noHits: filtered.length === 0,
		},
	};
}
