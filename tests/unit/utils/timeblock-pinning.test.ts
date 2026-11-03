import { App, parseYaml } from "obsidian";
import { getDailyNote } from "obsidian-daily-notes-interface";
import { setTimeblockPinned, timeblockLinksTask } from "../../../src/utils/helpers";
import { MockObsidian } from "../../helpers/obsidian-runtime";

jest.mock("obsidian-daily-notes-interface", () => ({
	getAllDailyNotes: jest.fn(() => ({})),
	getDailyNote: jest.fn(),
}));

const content = `---
timeblocks:
  - id: tb-1
    title: Write report
    startTime: "09:00"
    endTime: "10:00"
    attachments:
      - "[[Tasks/Write report]]"
    source: external
---

Body
`;

function readTimeblock(text: string): Record<string, unknown> {
	const yaml = text.split("---")[1];
	return (parseYaml(yaml) as { timeblocks: Record<string, unknown>[] }).timeblocks[0];
}

describe("timeblock pinning", () => {
	let app: App;

	beforeEach(() => {
		MockObsidian.reset();
		app = MockObsidian.createMockApp() as unknown as App;
		(window as unknown as { moment: jest.Mock }).moment = jest.fn();
	});

	it("adds pinned: true and removes the key on unpin, keeping other keys", async () => {
		const dailyNote = await app.vault.create("Daily/2026-11-02.md", content);
		(getDailyNote as jest.Mock).mockReturnValue(dailyNote);

		await setTimeblockPinned(app, "2026-11-02", "tb-1", true);
		let saved = await app.vault.read(dailyNote);
		expect(readTimeblock(saved)).toMatchObject({ pinned: true, source: "external" });
		expect(saved).toContain("Body");

		await setTimeblockPinned(app, "2026-11-02", "tb-1", false);
		saved = await app.vault.read(dailyNote);
		expect(readTimeblock(saved)).not.toHaveProperty("pinned");
		expect(readTimeblock(saved)).toHaveProperty("source", "external");
	});

	it("rejects an unknown timeblock id", async () => {
		const dailyNote = await app.vault.create("Daily/2026-11-02.md", content);
		(getDailyNote as jest.Mock).mockReturnValue(dailyNote);

		await expect(setTimeblockPinned(app, "2026-11-02", "missing", true)).rejects.toThrow(
			"Timeblock missing not found"
		);
	});

	it("only treats attachments that resolve to a task as task links", () => {
		const files: Record<string, { path: string }> = {
			"Tasks/Write report": { path: "Tasks/Write report.md" },
			"Notes/Idea": { path: "Notes/Idea.md" },
		};
		const plugin = {
			app: { metadataCache: { getFirstLinkpathDest: (link: string) => files[link] ?? null } },
			cacheManager: {
				getCachedTaskInfoSync: (path: string) =>
					path === "Tasks/Write report.md" ? { path } : null,
			},
		} as unknown as Parameters<typeof timeblockLinksTask>[0];

		expect(timeblockLinksTask(plugin, ["[[Tasks/Write report|Report]]"])).toBe(true);
		expect(timeblockLinksTask(plugin, ["[[Notes/Idea]]", "[[Missing]]"])).toBe(false);
		expect(timeblockLinksTask(plugin, undefined)).toBe(false);
	});
});
