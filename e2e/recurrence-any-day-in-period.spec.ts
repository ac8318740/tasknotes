import { test, expect, type Page } from "@playwright/test";
import { parse } from "yaml";
import { closeObsidian, launchObsidian, type ObsidianApp } from "./obsidian";

const folder = `Any day in period ${Date.now()}`;
let instance: ObsidianApp;
let page: Page;
let weekStart: (offsetWeeks: number) => string;

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

function localDate(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(date: string, days: number): string {
	const [year, month, day] = date.split("-").map(Number);
	return localDate(new Date(year, month - 1, day + days));
}

async function yaml(name: string): Promise<Record<string, any>> {
	const text = await page.evaluate(async (path) => {
		const app = (window as any).app;
		return app.vault.read(app.vault.getAbstractFileByPath(path));
	}, `${folder}/${name}.md`);
	return parse(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1]);
}

/** Creates a weekly any-day task whose scheduled period starts `offsetWeeks` from this week. */
async function createTask(name: string, offsetWeeks: number): Promise<void> {
	const start = weekStart(offsetWeeks);
	await page.evaluate(
		async ({ path, name, start, end, rule }) => {
			const app = (window as any).app;
			await app.vault.create(
				path,
				`---\ntags: [task]\ntitle: ${name}\nstatus: open\npriority: normal\nscheduled: ${start}\ndue: ${end}\nrecurrence: "${rule}"\nrecurrence_anchor: period\n---\n`
			);
		},
		{
			path: `${folder}/${name}.md`,
			name,
			start,
			end: addDays(start, 6),
			rule: `DTSTART:${start.replaceAll("-", "")};FREQ=WEEKLY`,
		}
	);
}

async function act(name: string, action: "complete" | "skip", date?: string): Promise<void> {
	await page.evaluate(
		async ({ path, action, date }) => {
			const plugin = (window as any).app.plugins.plugins.tasknotes;
			let task = null;
			for (let attempt = 0; attempt < 50 && task?.recurrence_anchor !== "period"; attempt++) {
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
	const firstDay: number = await page.evaluate(async (folder) => {
		const app = (window as any).app;
		await app.vault.createFolder(folder);
		return app.plugins.plugins.tasknotes.settings.calendarViewSettings.firstDay ?? 0;
	}, folder);
	const today = new Date();
	const thisWeek = localDate(
		new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() - firstDay + 7) % 7))
	);
	weekStart = (offsetWeeks) => addDays(thisWeek, offsetWeeks * 7);
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

test("completing on any day records the period start and moves to the next period", async () => {
	await createTask("Weekly", 0);

	await act("Weekly", "complete");

	await expect.poll(async () => (await yaml("Weekly")).scheduled).toBe(weekStart(1));
	const done = await yaml("Weekly");
	expect(done.complete_instances).toEqual([weekStart(0)]);
	expect(done.due).toBe(addDays(weekStart(1), 6));
	expect(done.recurrence_anchor).toBe("period");

	// Unchecking today's period reopens it.
	await act("Weekly", "complete", localDate(new Date()));
	await expect.poll(async () => (await yaml("Weekly")).scheduled).toBe(weekStart(0));
	expect((await yaml("Weekly")).complete_instances ?? []).toEqual([]);
});

test("a missed period is left behind and a skip counts for the current period", async () => {
	await createTask("Missed", -2);

	await act("Missed", "skip");

	await expect.poll(async () => (await yaml("Missed")).scheduled).toBe(weekStart(1));
	expect((await yaml("Missed")).skipped_instances).toEqual([weekStart(0)]);
});
