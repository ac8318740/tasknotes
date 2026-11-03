import { observeTranslation as mockObserveTranslation } from "../../helpers/real-i18n";
import { App } from "obsidian";
import { TimeblockInfoModal, TimeBlock } from "../../../src/modals/TimeblockInfoModal";
import { MockObsidian } from "../../helpers/obsidian-runtime";
import { getDailyNote } from "obsidian-daily-notes-interface";

jest.mock("obsidian-daily-notes-interface", () => ({
	appHasDailyNotesPluginLoaded: jest.fn(() => true),
	getAllDailyNotes: jest.fn(() => ({})),
	getDailyNote: jest.fn(),
}));

function createMockPlugin() {
	return {
		i18n: {
			translate: mockObserveTranslation(),
		},
		settings: {
			calendarViewSettings: {
				defaultTimeblockColor: "#8b5cf6",
			},
		},
		cacheManager: {
			getAllTasks: jest.fn(async () => []),
		},
		emitter: {
			trigger: jest.fn(),
		},
	} as any;
}

const existingTimeblock: TimeBlock = {
	id: "tb-1",
	title: "Standup",
	startTime: "09:00",
	endTime: "09:15",
};

function dailyNoteContent(): string {
	// `description` contains a "---" mid-line, the exact shape that used to
	// make the fragile fence detection pick the wrong end of frontmatter.
	return `---
description: "Section A --- Section B"
timeblocks:
  - id: tb-1
    title: Standup
    startTime: "09:00"
    endTime: "09:15"
---

# Daily Note Content
`;
}

describe("TimeblockInfoModal frontmatter fence detection", () => {
	let app: App;

	beforeEach(() => {
		MockObsidian.reset();
		app = MockObsidian.createMockApp() as unknown as App;
	});

	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("preserves unrelated frontmatter and body when updating a timeblock", async () => {
		const dailyNote = await app.vault.create("Daily/2026-05-16.md", dailyNoteContent());
		(getDailyNote as jest.Mock).mockReturnValue(dailyNote);

		const plugin = createMockPlugin();
		const modal = new TimeblockInfoModal(
			app,
			plugin,
			{ ...existingTimeblock },
			new Date("2026-05-16"),
			"2026-05-16"
		);
		(modal as any).timeblock.title = "Standup (updated)";

		await (modal as any).updateTimeblockInDailyNote();

		const finalContent = await app.vault.read(dailyNote);
		expect(finalContent).toContain("description: Section A --- Section B");
		expect(finalContent).toContain("# Daily Note Content");
		expect(finalContent).toContain("Standup (updated)");
	});

	it("preserves unrelated frontmatter and body when deleting a timeblock", async () => {
		const dailyNote = await app.vault.create("Daily/2026-05-16.md", dailyNoteContent());
		(getDailyNote as jest.Mock).mockReturnValue(dailyNote);

		const plugin = createMockPlugin();
		const modal = new TimeblockInfoModal(
			app,
			plugin,
			{ ...existingTimeblock },
			new Date("2026-05-16"),
			"2026-05-16"
		);

		await (modal as any).deleteTimeblockFromDailyNote();

		const finalContent = await app.vault.read(dailyNote);
		expect(finalContent).toContain("description: Section A --- Section B");
		expect(finalContent).toContain("# Daily Note Content");
		expect(finalContent).not.toContain("Standup");
	});
	it("keeps a task link written without .md when the modal saves", async () => {
		const task = await app.vault.create("Tasks/Write report.md", "---\ntitle: Write report\n---\n");
		const dailyNote = await app.vault.create(
			"Daily/2026-05-16.md",
			`---
timeblocks:
  - id: tb-1
    title: Write report
    startTime: "09:00"
    endTime: "10:00"
    attachments:
      - "[[Tasks/Write report]]"
    pinned: true
---
`
		);
		(getDailyNote as jest.Mock).mockReturnValue(dailyNote);
		(app.metadataCache as any).getFirstLinkpathDest = (link: string) =>
			link === "Tasks/Write report" ? task : null;

		const plugin = createMockPlugin();
		plugin.app = app;
		plugin.cacheManager.getCachedTaskInfoSync = (path: string) =>
			path === task.path ? { path } : null;
		const modal = new TimeblockInfoModal(
			app,
			plugin,
			{
				id: "tb-1",
				title: "Write report",
				startTime: "09:00",
				endTime: "10:00",
				attachments: ["[[Tasks/Write report]]"],
				pinned: true,
			},
			new Date("2026-05-16"),
			"2026-05-16"
		);
		await modal.onOpen();
		await (modal as any).handleSave();

		const finalContent = await app.vault.read(dailyNote);
		expect(finalContent).toContain("[[Tasks/Write report]]");
		expect(finalContent).not.toContain("Write report.md]]");
		expect(finalContent).toContain("pinned: true");
	});
	describe("pinned timeblocks", () => {
		const pinnedNote = (extra = "") => `---
timeblocks:
  - id: tb-1
    title: Write report
    startTime: "09:00"
    endTime: "10:00"
    attachments:
      - "[[Tasks/Write report]]"
    pinned: true${extra}
---
`;
		const pinnedBlock = (): TimeBlock => ({
			id: "tb-1",
			title: "Write report",
			startTime: "09:00",
			endTime: "10:00",
			attachments: ["[[Tasks/Write report]]"],
			pinned: true,
		});

		async function openModal(taskResolves: boolean) {
			const task = await app.vault.create("Tasks/Write report.md", "---\ntitle: Write report\n---\n");
			(app.metadataCache as any).getFirstLinkpathDest = (link: string) =>
				link === "Tasks/Write report" ? task : null;
			const plugin = createMockPlugin();
			plugin.app = app;
			plugin.cacheManager.getCachedTaskInfoSync = (path: string) =>
				taskResolves && path === task.path ? { path } : null;
			const modal = new TimeblockInfoModal(app, plugin, pinnedBlock(), new Date("2026-05-16"), "2026-05-16");
			await modal.onOpen();
			return modal as any;
		}

		it("keeps a pin it cannot verify when saving other edits", async () => {
			const dailyNote = await app.vault.create("Daily/2026-05-16.md", pinnedNote());
			(getDailyNote as jest.Mock).mockReturnValue(dailyNote);
			const modal = await openModal(false);
			modal.titleInput.value = "Write report draft";
			await modal.handleSave();

			const finalContent = await app.vault.read(dailyNote);
			expect(finalContent).toContain("Write report draft");
			expect(finalContent).toContain("pinned: true");
		});

		it("keeps changes made to the file while the modal was open", async () => {
			const dailyNote = await app.vault.create("Daily/2026-05-16.md", pinnedNote());
			(getDailyNote as jest.Mock).mockReturnValue(dailyNote);
			const modal = await openModal(true);
			await app.vault.modify(
				dailyNote,
				pinnedNote("\n    source: outside").replace('startTime: "09:00"', 'startTime: "11:00"')
			);
			await modal.handleSave();

			const finalContent = await app.vault.read(dailyNote);
			expect(finalContent).toContain("source: outside");
			expect(finalContent).toMatch(/startTime: "?11:00/);
			expect(finalContent).toContain("pinned: true");
		});

		it("clears the pin when the edit removes the last task link", async () => {
			const dailyNote = await app.vault.create("Daily/2026-05-16.md", pinnedNote());
			(getDailyNote as jest.Mock).mockReturnValue(dailyNote);
			const modal = await openModal(true);
			modal.selectedAttachments = [];
			await modal.handleSave();

			const finalContent = await app.vault.read(dailyNote);
			expect(finalContent).not.toContain("pinned");
			expect(finalContent).not.toContain("attachments");
		});
	});
});
