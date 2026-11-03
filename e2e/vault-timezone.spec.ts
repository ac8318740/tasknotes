import { test, expect } from "@playwright/test";
import { launchObsidian, closeObsidian, ObsidianApp } from "./obsidian";

let app: ObsidianApp;

test.describe("Vault time zone", () => {
	test.beforeAll(async () => {
		app = await launchObsidian();
	});

	test.afterAll(async () => {
		if (app) await closeObsidian(app);
	});

	test("changing the vault time zone keeps the moment of stored times", async () => {
		const page = app.page;
		const changeZone = (zone: string) =>
			page.evaluate(async (z) => {
				const plugin = (window as any).app.plugins.plugins.tasknotes;
				await plugin.vaultTimeZoneRewriteService.changeTimeZone(z);
			}, zone);
		const waitForRewrite = () =>
			expect
				.poll(
					() =>
						page.evaluate(() =>
							(
								window as any
							).app.plugins.plugins.tasknotes.vaultTimeZoneRewriteService.isRewriting()
						),
					{ timeout: 30000 }
				)
				.toBe(false);

		await changeZone("Australia/Sydney");
		await waitForRewrite();

		const paths = await page.evaluate(async () => {
			const obsidian = (window as any).app;
			const plugin = obsidian.plugins.plugins.tasknotes;
			const stamp = Date.now();
			const once = await plugin.taskService.createTask({
				title: `Vault zone once ${stamp}`,
				due: "2030-06-26T09:00",
				reminders: [
					{ id: "rem_zone", type: "absolute", absoluteTime: "2030-06-26T08:30:00" },
				],
			});
			const daily = await plugin.taskService.createTask({
				title: `Vault zone daily ${stamp}`,
				due: "2030-06-26T09:00",
				recurrence: "FREQ=DAILY",
			});
			for (const p of ["2030-06-25.md", "2030-06-26.md"]) {
				const f = obsidian.vault.getAbstractFileByPath(p);
				if (f) await obsidian.vault.delete(f);
			}
			await obsidian.vault.create(
				"2030-06-26.md",
				'---\ntimeblocks:\n  - id: tb-zone-early\n    title: Early\n    startTime: "08:00"\n    endTime: "09:00"\n  - id: tb-zone-late\n    title: Late\n    startTime: "12:00"\n    endTime: "13:00"\n---\n'
			);
			return { once: once.taskInfo.path as string, daily: daily.taskInfo.path as string };
		});

		// Let the metadata cache index the new notes before the rewrite reads it.
		await page.waitForTimeout(1500);
		await changeZone("Europe/London");
		await waitForRewrite();

		const frontmatter = (path: string) =>
			page.evaluate(async (p) => {
				const obsidian = (window as any).app;
				const file = obsidian.vault.getAbstractFileByPath(p);
				if (!file) return null;
				const text: string = await obsidian.vault.read(file);
				return text.split("---")[1] ?? "";
			}, path);

		// Sydney is UTC+10 and London UTC+1 in June: 09:00 in Sydney is 00:00 in London.
		await expect.poll(() => frontmatter(paths.once)).toContain("due: 2030-06-26T00:00");
		expect(await frontmatter(paths.once)).toContain("absoluteTime: 2030-06-25T23:30:00");
		expect(await frontmatter(paths.daily)).toContain("due: 2030-06-26T09:00");

		const sameDay = await frontmatter("2030-06-26.md");
		expect(sameDay).toContain("tb-zone-late");
		expect(sameDay).toContain("startTime: 03:00");
		expect(sameDay).not.toContain("tb-zone-early");
		const dayBefore = await frontmatter("2030-06-25.md");
		expect(dayBefore).toContain("tb-zone-early");
		expect(dayBefore).toContain("startTime: 23:00");

		await changeZone("");
		await waitForRewrite();
		await page.evaluate(async (p) => {
			const obsidian = (window as any).app;
			for (const path of [p.once, p.daily, "2030-06-25.md", "2030-06-26.md"]) {
				const file = obsidian.vault.getAbstractFileByPath(path);
				if (file) await obsidian.vault.delete(file);
			}
		}, paths);
	});
});
