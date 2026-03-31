// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { getFeaturedOfficialSkills, omitFeaturedSkills } from "./featured-skills";

const items = [
	{
		name: "community-top",
		fullName: "someone/community-top",
		installs: "9.9K",
		installsRaw: 9900,
		popularityScore: 9900,
		description: "community",
		installed: false,
		provider: "skills.sh",
	},
	{
		name: "official-built-in",
		fullName: "Signet-AI/signetai",
		installs: "built-in",
		installsRaw: 100000,
		popularityScore: 200000,
		useCount: 2,
		description: "official built in",
		installed: false,
		provider: "signet",
		official: true,
		builtin: true,
	},
	{
		name: "official-high",
		fullName: "Signet-AI/signetai",
		installs: "--",
		installsRaw: 1000,
		popularityScore: 50000,
		useCount: 11,
		description: "official high",
		installed: false,
		provider: "signet",
		official: true,
	},
	{
		name: "official-low",
		fullName: "Signet-AI/signetai",
		installs: "--",
		installsRaw: 100,
		popularityScore: 1000,
		useCount: 1,
		description: "official low",
		installed: false,
		provider: "signet",
		official: true,
	},
];

describe("featured official skills", () => {
	it("prefers actual usage over fallback popularity and built-in status", () => {
		const featured = getFeaturedOfficialSkills(items, 3);
		expect(featured.map((item) => item.name)).toEqual(["official-high", "official-built-in", "official-low"]);
	});

	it("falls back to built-in plus popularity ordering when usage data is absent", () => {
		const featured = getFeaturedOfficialSkills(
			items.map((item) => ({ ...item, useCount: undefined, lastUsedAt: undefined })),
			3,
		);
		expect(featured.map((item) => item.name)).toEqual(["official-built-in", "official-high", "official-low"]);
	});

	it("removes featured skills from the main browse grid", () => {
		const featured = getFeaturedOfficialSkills(items, 2);
		const rest = omitFeaturedSkills(items, featured);
		expect(rest.map((item) => item.name)).toEqual(["community-top", "official-low"]);
	});
});
