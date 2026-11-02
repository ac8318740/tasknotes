import { test, expect, type Page } from "@playwright/test";
import { parse } from "yaml";
import { closeObsidian, launchObsidian, type ObsidianApp } from "./obsidian";

const folder = `Any day in period ${Date.now()}`;
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

// Periods start on the DTSTART weekday. Starting the current period 3 days ago
// keeps today mid-period on any weekday, so a recorded date of today is wrong.
const today = addDays(0);
const periodStart = addDays(-3);
const nextPeriodStart = addDays(4);

async function yaml(name: string): Promise<Record<string, any>> {
	const text = await page.evaluate(async (path) => {
		const app = (window as any).app;
		return app.vault.read(app.vault.getAbstractFileByPath(path));
	}, `${folder}/${name}.md`);
	return parse(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1]);
}

/** Creates a weekly any-day task whose rule starts on `start` and is scheduled on `scheduled`. */
async function createTask(name: string, start: string, scheduled: string): Promise<void> {
	await page.evaluate(
		async ({ path, name, scheduled, rule }) => {
			const app = (window as any).app;
			await app.vault.create(
				path,
				`---\ntags: [task]\ntitle: ${name}\nstatus: open\npriority: normal\nscheduled: ${scheduled}\nrecurrence: "${rule}"\nrecurrence_anchor: period\n---\n`
			);
		},
		{
			path: `${folder}/${name}.md`,
			name,
			scheduled,
			rule: `DTSTART:${start.replaceAll("-", "")};FREQ=WEEKLY`,
		}
	);
}

async function act(name: string, action: "complete" | "skip", date?: string): Promise<void> {
	await page.evaluate(
		async ({ path, action, date }) => {
			const plugin = (window as any).app.plugins.plugins.tasknotes;
			let task = null;
			for (let attempt = 0; attempt < 50 && !task?.recurrence; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				task = await plugin.cacheManager.getTaskInfo(path);
			}
			if (task?.recurrence_anchor !== "period") throw new Error("period anchor not read");
			const target = date ? new Date(`${date}T00:00:00Z`) : undefined;
			if (action === "complete") await plugin.toggleRecurringTaskComplete(task, target);
			else await plugin.taskService.toggleRecurringTaskSkipped(task, target);
		},
		{ path: `${folder}/${name}.md`, action, date }
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

test("a mid-period completion records the period start, and unchecking it reopens that period", async () => {
	await createTask("Weekly", periodStart, periodStart);

	await act("Weekly", "complete", today);

	await expect.poll(async () => (await yaml("Weekly")).scheduled).toBe(nextPeriodStart);
	expect((await yaml("Weekly")).complete_instances).toEqual([periodStart]);

	// Unchecking on the same mid-period day must clear that period, not credit the next one.
	await act("Weekly", "complete", today);

	await expect.poll(async () => (await yaml("Weekly")).scheduled).toBe(periodStart);
	expect((await yaml("Weekly")).complete_instances ?? []).toEqual([]);
});

test("a missed period is left behind and a skip counts for the current period", async () => {
	const missedStart = addDays(-17);
	await createTask("Missed", missedStart, missedStart);

	await act("Missed", "skip");

	await expect.poll(async () => (await yaml("Missed")).scheduled).toBe(nextPeriodStart);
	expect((await yaml("Missed")).skipped_instances).toEqual([periodStart]);
});
