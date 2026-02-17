import { Modal, Notice, Setting } from "obsidian";
import type TaskNotesPlugin from "../main";
import {
	countMigratableEntries,
	migrateDailyNoteToTask,
	migrateTaskToDailyNote,
	MigrationCount,
} from "../services/TimeMigrationService";

/**
 * Confirmation modal shown when the user changes the `timeEntriesStorage` setting.
 * Displays migration direction, entry count, and a backup warning before proceeding.
 */
export class TimeMigrationConfirmationModal extends Modal {
	private plugin: TaskNotesPlugin;
	private direction: "toTask" | "toDailyNote";
	private onConfirm: () => void;
	private onCancel: () => void;

	constructor(
		plugin: TaskNotesPlugin,
		direction: "toTask" | "toDailyNote",
		onConfirm: () => void,
		onCancel: () => void,
	) {
		super(plugin.app);
		this.plugin = plugin;
		this.direction = direction;
		this.onConfirm = onConfirm;
		this.onCancel = onCancel;
	}

	private t(key: string, params?: Record<string, string | number>): string {
		return this.plugin.i18n.translate(key, params);
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		// Title
		new Setting(contentEl)
			.setName(this.t("modals.timeMigration.title"))
			.setHeading();

		// Description
		const descKey = this.direction === "toTask"
			? "modals.timeMigration.toTaskDescription"
			: "modals.timeMigration.toDailyNoteDescription";
		contentEl.createEl("p", {
			text: this.t(descKey),
		});

		// Loading state while counting entries
		const countEl = contentEl.createEl("p", {
			text: "...",
		});

		// Backup warning
		const warningEl = contentEl.createEl("p");
		const strongWarning = warningEl.createEl("strong");
		strongWarning.textContent = this.t("modals.timeMigration.backupWarning");

		// Buttons (initially disabled until count completes)
		const buttonContainer = contentEl.createEl("div", { cls: "modal-button-container" });
		buttonContainer.style.display = "flex";
		buttonContainer.style.gap = "10px";
		buttonContainer.style.justifyContent = "flex-end";
		buttonContainer.style.marginTop = "20px";

		const cancelButton = buttonContainer.createEl("button", {
			text: this.t("modals.timeMigration.cancel"),
		});
		cancelButton.addEventListener("click", () => {
			this.onCancel();
			this.close();
		});

		const proceedButton = buttonContainer.createEl("button", {
			text: this.t("modals.timeMigration.proceed"),
			cls: "mod-cta",
		});
		proceedButton.disabled = true;

		// Fetch the count asynchronously
		let migrationCount: MigrationCount;
		try {
			migrationCount = await countMigratableEntries(this.plugin, this.direction);
			countEl.textContent = this.t("modals.timeMigration.countLabel", {
				entries: migrationCount.entries,
				sources: migrationCount.sources,
			});

			if (migrationCount.entries === 0) {
				proceedButton.disabled = true;
				proceedButton.textContent = this.t("modals.timeMigration.proceed");
			} else {
				proceedButton.disabled = false;
			}
		} catch (e) {
			countEl.textContent = this.t("modals.timeMigration.error");
			return;
		}

		proceedButton.addEventListener("click", async () => {
			proceedButton.disabled = true;
			proceedButton.textContent = "...";

			try {
				const migrationResult =
					this.direction === "toTask"
						? await migrateDailyNoteToTask(this.plugin)
						: await migrateTaskToDailyNote(this.plugin);

				new Notice(
					this.t("modals.timeMigration.success", {
						migrated: migrationResult.migratedCount,
						skipped: migrationResult.skippedCount,
					}),
				);

				if (migrationResult.errors.length > 0) {
					console.warn("Migration completed with errors:", migrationResult.errors);
				}

				this.onConfirm();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				new Notice(this.t("modals.timeMigration.error") + ": " + msg);
				console.error("Migration failed:", e);
				this.onCancel();
			}

			this.close();
		});

		// Focus the proceed button
		window.setTimeout(() => {
			if (!proceedButton.disabled) {
				proceedButton.focus();
			}
		}, 50);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
