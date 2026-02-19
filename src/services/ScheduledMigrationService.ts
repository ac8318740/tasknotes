/* eslint-disable no-console */
import { App, TFile, Notice } from "obsidian";
import TaskNotesPlugin from "../main";
import { TaskInfo, UnifiedTimeEntry } from "../types";
import { RecurrenceEntryService } from "./RecurrenceEntryService";
import { generateTimeEntryId } from "../utils/helpers";

/**
 * Migration service that converts legacy `scheduled` frontmatter properties
 * to planned time entries. For recurring tasks, also converts complete_instances
 * to logged time entries and generates future planned entries.
 *
 * This runs once, gated by the `scheduledToTimeEntryMigrated` setting.
 */
export class ScheduledMigrationService {
	private plugin: TaskNotesPlugin;
	private app: App;
	private recurrenceService: RecurrenceEntryService;

	constructor(plugin: TaskNotesPlugin) {
		this.plugin = plugin;
		this.app = plugin.app;
		this.recurrenceService = new RecurrenceEntryService();
	}

	/**
	 * Check if migration is needed and run it if so.
	 * Should be called on plugin startup after cache is ready.
	 */
	async checkAndMigrate(): Promise<void> {
		if (this.plugin.settings.scheduledToTimeEntryMigrated) {
			return; // Already migrated
		}

		// Count tasks that need migration
		const allTasks = await this.plugin.cacheManager.getAllTasks();
		const tasksNeedingMigration = allTasks.filter(
			(task) => task.scheduled && (!task.timeEntries || !task.timeEntries.some((e) => e.type === "planned"))
		);

		if (tasksNeedingMigration.length === 0) {
			// No tasks need migration, mark as done
			this.plugin.settings.scheduledToTimeEntryMigrated = true;
			await this.plugin.saveSettings();
			return;
		}

		// Show confirmation notice
		const confirmed = await this.showMigrationConfirmation(tasksNeedingMigration.length);
		if (!confirmed) {
			return; // User declined, will ask again next startup
		}

		await this.runMigration(tasksNeedingMigration);
	}

	/**
	 * Show a confirmation dialog before migrating.
	 */
	private showMigrationConfirmation(taskCount: number): Promise<boolean> {
		return new Promise((resolve) => {
			const { Modal } = require("obsidian");
			const modal = new (Modal as any)(this.app);
			modal.titleEl.setText("Migrate Scheduled Dates to Time Entries");
			modal.contentEl.createEl("p", {
				text: `TaskNotes has unified scheduling through time entries. ${taskCount} task(s) with legacy scheduled dates need to be migrated.`,
			});
			modal.contentEl.createEl("p", {
				text: "This will:",
			});
			const list = modal.contentEl.createEl("ul");
			list.createEl("li", { text: "Convert scheduled dates to planned time entries" });
			list.createEl("li", { text: "For recurring tasks: generate future planned entries" });
			list.createEl("li", { text: "For recurring tasks: convert completed instances to logged entries" });
			modal.contentEl.createEl("p", {
				text: "Your data will be preserved. This cannot be undone.",
				cls: "mod-warning",
			});

			const buttonContainer = modal.contentEl.createDiv({ cls: "modal-button-container" });

			buttonContainer.createEl("button", { text: "Later" }).addEventListener("click", () => {
				modal.close();
				resolve(false);
			});

			const migrateBtn = buttonContainer.createEl("button", {
				text: "Migrate Now",
				cls: "mod-cta",
			});
			migrateBtn.addEventListener("click", () => {
				modal.close();
				resolve(true);
			});

			modal.open();
		});
	}

	/**
	 * Run the actual migration on the given tasks.
	 */
	private async runMigration(tasks: TaskInfo[]): Promise<void> {
		let migratedCount = 0;
		let errorCount = 0;

		const notice = new Notice(`Migrating ${tasks.length} tasks...`, 0);

		for (const task of tasks) {
			try {
				if (task.recurrence) {
					await this.migrateRecurringTask(task);
				} else {
					await this.migrateNonRecurringTask(task);
				}
				migratedCount++;
			} catch (error) {
				console.error(`[TaskNotes] Failed to migrate task ${task.path}:`, error);
				errorCount++;
			}
		}

		notice.hide();

		// Mark migration as complete
		this.plugin.settings.scheduledToTimeEntryMigrated = true;
		await this.plugin.saveSettings();

		// Show results
		if (errorCount > 0) {
			new Notice(
				`Migration complete: ${migratedCount} tasks migrated, ${errorCount} errors. Check console for details.`,
				10000
			);
		} else {
			new Notice(`Migration complete: ${migratedCount} tasks migrated successfully.`, 5000);
		}

		// Refresh cache to pick up changes
		this.plugin.notifyDataChanged();
	}

	/**
	 * Migrate a non-recurring task: convert scheduled → planned time entry.
	 */
	private async migrateNonRecurringTask(task: TaskInfo): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(task.path);
		if (!(file instanceof TFile)) return;

		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const scheduledField = this.plugin.fieldMapper.toUserField("scheduled");
			const timeEntriesField = this.plugin.fieldMapper.toUserField("timeEntries");

			const scheduledValue = frontmatter[scheduledField];
			if (!scheduledValue) return;

			// Create planned time entry from scheduled value
			const rawValue = String(scheduledValue);
			const hasTime = rawValue.includes("T");
			const newEntry: UnifiedTimeEntry = {
				id: generateTimeEntryId(),
				type: "planned",
				startTime: rawValue,
			};

			if (hasTime) {
				// Timed entry: endTime from timeEstimate or default 60 min
				const durationMin = task.timeEstimate && task.timeEstimate > 0
					? task.timeEstimate : 60;
				const startMs = new Date(rawValue).getTime();
				newEntry.endTime = new Date(startMs + durationMin * 60 * 1000).toISOString();
				newEntry.duration = durationMin;
			}
			// Date-only entries stay as-is: all-day tasks don't need endTime

			// Add to existing time entries
			const entries: UnifiedTimeEntry[] = Array.isArray(frontmatter[timeEntriesField])
				? [...frontmatter[timeEntriesField]]
				: [];
			entries.push(newEntry);
			frontmatter[timeEntriesField] = entries;

			// Remove scheduled from frontmatter
			delete frontmatter[scheduledField];
		});
	}

	/**
	 * Migrate a recurring task:
	 * 1. Generate planned entries for the next N months
	 * 2. Convert complete_instances → logged time entries
	 * 3. Remove scheduled, complete_instances, skipped_instances from frontmatter
	 */
	private async migrateRecurringTask(task: TaskInfo): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(task.path);
		if (!(file instanceof TFile)) return;

		const windowMonths = this.plugin.settings.recurrenceWindowMonths || 3;

		// Generate planned entries from RRULE
		const plannedEntries = this.recurrenceService.generatePlannedEntries(task, windowMonths);

		// Convert complete_instances to logged entries
		const loggedEntries: UnifiedTimeEntry[] = [];
		const completeInstances = task.complete_instances || [];
		const skippedInstances = task.skipped_instances || [];

		for (const dateStr of completeInstances) {
			loggedEntries.push({
				id: generateTimeEntryId(),
				type: "logged",
				fromRecurrence: true,
				startTime: dateStr,
			});
		}

		// Combine: existing non-scheduled entries + new planned + logged from completions
		const existingEntries = (task.timeEntries || []).filter(
			(e) => e.type !== "planned" || !e.fromRecurrence
		);

		const allEntries = [...existingEntries, ...plannedEntries, ...loggedEntries];

		// Filter out entries for skipped dates (they are simply absent)
		const skippedSet = new Set(skippedInstances);
		const filteredEntries = allEntries.filter(
			(e) => !skippedSet.has(e.startTime.substring(0, 10))
		);

		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const scheduledField = this.plugin.fieldMapper.toUserField("scheduled");
			const timeEntriesField = this.plugin.fieldMapper.toUserField("timeEntries");
			const completeInstancesField = this.plugin.fieldMapper.toUserField("completeInstances");
			const skippedInstancesField = this.plugin.fieldMapper.toUserField("skippedInstances");

			// Write merged time entries
			frontmatter[timeEntriesField] = filteredEntries;

			// Remove legacy fields
			delete frontmatter[scheduledField];
			delete frontmatter[completeInstancesField];
			delete frontmatter[skippedInstancesField];
		});
	}
}
