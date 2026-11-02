import { test, expect, type Page } from "@playwright/test";
import { parse } from "yaml";
import { closeObsidian, launchObsidian, type ObsidianApp } from "./obsidian";

const folder = `Occurrence window ${Date.now()}`;
let instance: ObsidianApp;
let page: Page;

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

function addDays(days: number): string {
	const now = new Date();
	const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// A weekly rule whose latest occurrence was 3 days ago, open for 5 days (until tomorrow).
// Dates are relative to today, so the specs behave the same on any weekday.
const openOccurrence = addDays(-3);
const openUntil = addDays(1);
const nextOccurrence = addDays(4);
const rule = `DTSTART:${addDays(-10).replaceAll("-", "")};FREQ=WEEKLY`;

async function yaml(name: string): Promise<Record<string, any>> {
	const text = await page.evaluate(async (path) => {
		const app = (window as any).app;
		return app.vault.read(app.vault.getAbstractFileByPath(path));
	}, `${folder}/${name}.md`);
	return parse(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1]);
}

async function createTask(name: string, extra: string): Promise<void> {
	await page.evaluate(
		async ({ path, body }) => {
			await (window as any).app.vault.create(path, body);
		},
		{
			path: `${folder}/${name}.md`,
			body: `---\ntags: [task]\ntitle: ${name}\nstatus: open\npriority: normal\nrecurrence: "${rule}"\nrecurrence_window: 5\n${extra}---\n`,
		}
	);
}

async function act(name: string, action: "complete" | "skip"): Promise<void> {
	await page.evaluate(
		async ({ path, action }) => {
			const plugin = (window as any).app.plugins.plugins.tasknotes;
			let task = null;
			for (let attempt = 0; attempt < 50 && !task?.recurrence; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				task = await plugin.cacheManager.getTaskInfo(path);
			}
			if (!task?.recurrence) throw new Error("task not indexed");
			if (action === "complete") await plugin.toggleRecurringTaskComplete(task);
			else await plugin.taskService.toggleRecurringTaskSkipped(task);
		},
		{ path: `${folder}/${name}.md`, action }
	);
}

test.beforeAll(async () => {
	instance = await launchObsidian();
	page = instance.page;
	await page.evaluate(async (folder) => {
		await (window as any).app.vault.createFolder(folder);
	}, folder);
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

test("skipping a missed occurrence keeps the open one next, due on its window's last day", async () => {
	await createTask("Missed", `scheduled: ${addDays(-10)}\n`);

	await act("Missed", "skip");

	await expect.poll(async () => (await yaml("Missed")).scheduled).toBe(openOccurrence);
	const after = await yaml("Missed");
	expect(after.skipped_instances).toEqual([addDays(-10)]);
	expect(after.due).toBe(openUntil);
});

test("completing an occurrence moved inside its window keeps the next due date on the window", async () => {
	await createTask(
		"Moved",
		`scheduled: ${addDays(0)}\nrecurrence_original_date: ${openOccurrence}\ndue: ${openUntil}\n`
	);

	await act("Moved", "complete");

	await expect.poll(async () => (await yaml("Moved")).scheduled).toBe(nextOccurrence);
	const after = await yaml("Moved");
	expect(after.complete_instances).toEqual([openOccurrence]);
	expect(after.due).toBe(addDays(8));
});
