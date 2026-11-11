import { test, expect } from "@playwright/test";
import { launchObsidian, closeObsidian, type ObsidianApp } from "./obsidian";

let instance: ObsidianApp;
const stamp = Date.now();
const parentTitle = `Inheritance parent ${stamp}`;
const childTitle = `Inheritance child ${stamp}`;

async function frontmatter(title: string): Promise<Record<string, unknown> | null> {
	return instance.page.evaluate((title) => {
		const app = (window as any).app;
		const file = app.vault.getMarkdownFiles().find((file: any) => file.basename === title);
		const fm = file ? app.metadataCache.getFileCache(file)?.frontmatter : null;
		return fm ? JSON.parse(JSON.stringify(fm)) : null;
	}, title);
}

const child = async () => {
	const fm = await frontmatter(childTitle);
	return { priority: fm?.priority, contexts: fm?.contexts, inherited: fm?.inherited ?? "absent" };
};

async function setPriority(title: string, priority: string): Promise<void> {
	await instance.page.evaluate(
		async ({ title, priority }) => {
			const app = (window as any).app;
			const plugin = app.plugins.plugins.tasknotes;
			const file = app.vault.getMarkdownFiles().find((file: any) => file.basename === title);
			const task = await plugin.cacheManager.getTaskInfo(file.path);
			await plugin.taskService.updateProperty(task, "priority", priority);
		},
		{ title, priority }
	);
}

test.beforeAll(async () => {
	instance = await launchObsidian();
});

test.afterAll(async () => {
	if (!instance) return;
	try {
		await instance.page.evaluate(
			async (titles) => {
				const app = (window as any).app;
				app.plugins.plugins.tasknotes.settings.taskCreationDefaults.inheritParentTaskProperties = true;
				for (const file of app.vault.getMarkdownFiles()) {
					if (titles.includes(file.basename)) await app.vault.delete(file);
				}
			},
			[parentTitle, childTitle]
		);
	} finally {
		await closeObsidian(instance);
	}
});

test("subtasks get, follow, and give up their parent's values", async () => {
	await instance.page.evaluate(
		async ({ parentTitle, childTitle }) => {
			const plugin = (window as any).app.plugins.plugins.tasknotes;
			plugin.settings.taskCreationDefaults.inheritParentTaskProperties = true;
			await plugin.taskService.createTask({
				title: parentTitle,
				priority: "high",
				contexts: ["office"],
			});
			await new Promise((resolve) => setTimeout(resolve, 300));
			await plugin.taskService.createTask({
				title: childTitle,
				projects: [`[[${parentTitle}]]`],
			});
		},
		{ parentTitle, childTitle }
	);

	// A new subtask takes the parent's priority instead of the default.
	await expect
		.poll(child)
		.toEqual({ priority: "high", contexts: ["office"], inherited: ["priority", "contexts"] });

	// Editing the parent updates the copies.
	await setPriority(parentTitle, "low");
	await expect.poll(child, { timeout: 10000 }).toMatchObject({ priority: "low" });

	// Editing a copied value makes it the subtask's own.
	await setPriority(childTitle, "high");
	await expect
		.poll(child, { timeout: 10000 })
		.toEqual({ priority: "high", contexts: ["office"], inherited: ["contexts"] });

	// Turning the setting off removes the remaining copies.
	await instance.page.evaluate(async () => {
		const plugin = (window as any).app.plugins.plugins.tasknotes;
		plugin.settings.taskCreationDefaults.inheritParentTaskProperties = false;
		await plugin.taskInheritanceService.applyToAllTasks();
	});
	await expect
		.poll(child, { timeout: 10000 })
		.toEqual({ priority: "high", contexts: undefined, inherited: "absent" });
});
