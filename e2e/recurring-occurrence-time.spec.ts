import { test, expect, type Page } from "@playwright/test";
import { parse, stringify } from "yaml";
import { closeObsidian, launchObsidian, type ObsidianApp } from "./obsidian";

const folder = `Occurrence time ${Date.now()}`;
let instance: ObsidianApp;
let page: Page;

function addDays(days: number): string {
	const now = new Date();
	const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Weekly occurrences 16, 9 and 2 days ago; the one 2 days ago is current.
const current = addDays(-2);
const previous = addDays(-9);
const rule = `DTSTART:${addDays(-16).replaceAll("-", "")};FREQ=WEEKLY`;
const taskPath = (name: string) => `${folder}/${name}.md`;

async function yaml(name: string): Promise<Record<string, any>> {
	const text = await page.evaluate(async (path) => {
		const app = (window as any).app;
		return app.vault.read(app.vault.getAbstractFileByPath(path));
	}, taskPath(name));
	return parse(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1]);
}

async function createTask(name: string, fields: Record<string, unknown>): Promise<void> {
	await page.evaluate(
		async ({ path, body }) => {
			await (window as any).app.vault.create(path, body);
		},
		{
			path: taskPath(name),
			body: `---\n${stringify({ tags: ["task"], title: name, status: "open", priority: "normal", ...fields })}---\n`,
		}
	);
}

/** The formulas the plugin writes into a generated tasks base. */
async function generatedFormulas(): Promise<Record<string, string>> {
	const text = await page.evaluate(async (path) => {
		const plugin = (window as any).app.plugins.plugins.tasknotes;
		const original = plugin.settings.commandFileMapping;
		// Only this missing path is written; existing default files are skipped.
		plugin.settings.commandFileMapping = { ...original, "open-tasks-view": path };
		try {
			await plugin.ensureBasesViewFiles();
		} finally {
			plugin.settings.commandFileMapping = original;
		}
		return (window as any).app.vault.read((window as any).app.vault.getAbstractFileByPath(path));
	}, `${folder}/Generated.base`);
	return parse(text).formulas;
}

async function openBase(name: string, view: Record<string, unknown>): Promise<void> {
	const formulas = await generatedFormulas();
	await page.evaluate(
		async ({ path, content }) => {
			const app = (window as any).app;
			for (const leaf of app.workspace.getLeavesOfType("bases")) leaf.detach();
			const file = await app.vault.create(path, content);
			await app.workspace.getLeaf("tab").openFile(file);
		},
		{
			path: `${folder}/${name}.base`,
			content: stringify({
				filters: { and: [`file.inFolder("${folder}")`, 'file.hasTag("task")'] },
				formulas,
				views: [view],
			}),
		}
	);
}


test.beforeAll(async () => {
	instance = await launchObsidian();
	page = instance.page;
	await page.evaluate(async (folder) => {
		await (window as any).app.vault.createFolder(folder);
	}, folder);

	await createTask("Weekly block", {
		recurrence: rule,
		scheduled: current,
		timeEstimate: 300,
		timeEntries: [
			{ startTime: `${previous}T09:00:00Z`, endTime: `${previous}T09:30:00Z`, occurrence: previous },
			{ startTime: addDays(-1), endTime: addDays(-1), minutes: 60, occurrence: current },
		],
	});
	// Control: a task that does not recur counts all its time against its estimate.
	await createTask("One-off", {
		timeEstimate: 300,
		timeEntries: [{ startTime: addDays(-1), endTime: addDays(-1), minutes: 60 }],
	});
});

test.afterAll(async () => {
	try {
		if (page && !page.isClosed()) {
			await page.evaluate(async (folder) => {
				const app = (window as any).app;
				const fixture = app.vault.getAbstractFileByPath(folder);
				if (fixture) await app.vault.delete(fixture, true);
			}, folder);
		}
	} finally {
		if (instance) await closeObsidian(instance);
	}
});

test("a timer on a recurring task records the current occurrence", async () => {
	await page.evaluate(async (path) => {
		const plugin = (window as any).app.plugins.plugins.tasknotes;
		let task = null;
		for (let attempt = 0; attempt < 50 && !task?.recurrence; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			task = await plugin.cacheManager.getTaskInfo(path);
		}
		if (!task?.recurrence) throw new Error("task not indexed");
		const started = await plugin.taskService.startTimeTracking(task);
		await plugin.taskService.stopTimeTracking(started);
	}, taskPath("Weekly block"));

	await expect.poll(async () => (await yaml("Weekly block")).timeEntries?.length).toBe(3);
	const entries = (await yaml("Weekly block")).timeEntries;
	expect(entries[2].occurrence).toBe(current);
	expect(entries[2].endTime).toBeTruthy();
	// The entry logged without clock times keeps its minutes through the timer's rewrite.
	expect(entries[1]).toMatchObject({ minutes: 60, occurrence: current });
});

test("the card shows the current occurrence's progress against the estimate", async () => {
	await openBase("List", {
		type: "tasknotesTaskList",
		name: "List",
		order: ["file.name", "timeEntries"],
	});

	const weekly = page.locator(`.task-card[data-task-path="${taskPath("Weekly block")}"]`).first();
	await expect(weekly).toContainText("this occurrence");
	await expect(weekly).toContainText("1 hr logged of 5 hr estimated this occurrence");
	const oneOff = page.locator(`.task-card[data-task-path="${taskPath("One-off")}"]`).first();
	await expect(oneOff).toContainText("1 hr logged");
	await expect(oneOff).not.toContainText("this occurrence");
});

test("generated Bases formulas count the current occurrence for recurring tasks", async () => {
	await openBase("Table", {
		type: "table",
		name: "Table",
		order: [
			"file.name",
			"formula.currentOccurrence",
			"formula.timeTrackedThisOccurrence",
			"formula.timeRemaining",
		],
	});

	const row = (name: string) => page.locator(".bases-tr").filter({ hasText: name });
	// Weekly: occurrence, then 60 minutes this occurrence, then 300 - 60 remaining (the earlier
	// test's seconds-long timer rounds away); the previous week's 30 minutes do not count.
	await expect(row("Weekly block")).toHaveText(`Weekly block${current}60240`);
	// One-off: no occurrence, and its 60 logged minutes count against the estimate.
	await expect(row("One-off")).toHaveText("One-off240");
});
