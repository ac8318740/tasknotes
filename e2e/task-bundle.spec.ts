import { test, expect } from "@playwright/test";
import { launchObsidian, closeObsidian, type ObsidianApp } from "./obsidian";

let instance: ObsidianApp;
let original: boolean;
const title = `Call the bank ${Date.now()}`;
const editor = () =>
	instance.page.locator(".modal .tn-task-modal__markdown-editor--nlp .cm-content");
const bundleToggle = () =>
	instance.page
		.locator(".modal .setting-item")
		.filter({ has: instance.page.locator(".setting-item-name", { hasText: /^Bundle$/ }) })
		.locator(".checkbox-container");

async function bundleValue(): Promise<unknown> {
	return instance.page.evaluate((title) => {
		const app = (window as any).app;
		const file = app.vault.getMarkdownFiles().find((file: any) => file.basename === title);
		return file
			? (app.metadataCache.getFileCache(file)?.frontmatter?.bundle ?? "absent")
			: "no file";
	}, title);
}

test.beforeAll(async () => {
	instance = await launchObsidian();
	original = await instance.page.evaluate(() => {
		const plugin = (window as any).app.plugins.plugins.tasknotes;
		const value = plugin.settings.enableNaturalLanguageInput;
		plugin.settings.enableNaturalLanguageInput = true;
		return value;
	});
});

test.afterAll(async () => {
	if (!instance) return;
	try {
		await instance.page.evaluate(
			async ({ original, title }) => {
				const app = (window as any).app;
				app.plugins.plugins.tasknotes.settings.enableNaturalLanguageInput = original;
				for (const file of app.vault.getMarkdownFiles()) {
					if (file.basename === title) await app.vault.delete(file);
				}
			},
			{ original, title }
		);
	} finally {
		await closeObsidian(instance);
	}
});

test("the bundle keyword and the modal toggle write and remove bundle: true", async () => {
	await instance.page.evaluate(() =>
		(window as any).app.plugins.plugins.tasknotes.openTaskCreationModal()
	);
	await expect(editor()).toBeVisible();
	await editor().click();
	await instance.page.keyboard.insertText(`${title} bundle`);

	await expect(editor().locator(".tn-nlp-highlight--field")).toHaveText(["bundle"]);
	await expect(instance.page.locator(".modal .nl-preview-container")).toContainText("Bundle");

	await instance.page.locator(".modal button.mod-cta").filter({ hasText: /^Save/ }).click();
	await expect(editor()).toHaveCount(0);
	await expect.poll(bundleValue).toBe(true);

	await instance.page.evaluate(async (title) => {
		const app = (window as any).app;
		const plugin = app.plugins.plugins.tasknotes;
		const file = app.vault.getMarkdownFiles().find((file: any) => file.basename === title);
		await plugin.openTaskEditModal(await plugin.cacheManager.getTaskInfo(file.path));
	}, title);
	await expect(bundleToggle()).toHaveClass(/is-enabled/);
	await bundleToggle().click();
	await expect(bundleToggle()).not.toHaveClass(/is-enabled/);
	await instance.page.locator(".modal button.mod-cta").filter({ hasText: /^Save/ }).click();
	await expect(bundleToggle()).toHaveCount(0);
	await expect.poll(bundleValue).toBe("absent");
});
