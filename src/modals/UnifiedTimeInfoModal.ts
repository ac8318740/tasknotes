import { App, Modal, Notice, Setting, setTooltip } from "obsidian";
import * as chrono from "chrono-node";
import { UnifiedTimeEntry, DailyNoteTimeEntry, TaskInfo } from "../types";
import type TaskNotesPlugin from "../main";
import { TranslationKey } from "../i18n";
import { openTaskSelector } from "./TaskSelectorWithCreateModal";
import { getTimezoneOffsetString } from "../utils/dateUtils";

export interface UnifiedTimeInfoModalOptions {
	entry: UnifiedTimeEntry;
	taskInfo?: TaskInfo;
	dailyNoteEntry?: DailyNoteTimeEntry;
	plugin: TaskNotesPlugin;
	onChange?: () => void;
	isNew?: boolean; // true = creation mode, false/undefined = edit mode
}

/**
 * Modal for viewing/editing a single UnifiedTimeEntry.
 * Replaces both TimeblockInfoModal (for unified entries) and the single-entry
 * view from TimeEntryEditorModal.
 */
export class UnifiedTimeInfoModal extends Modal {
	private options: UnifiedTimeInfoModalOptions;
	private entry: UnifiedTimeEntry;
	private plugin: TaskNotesPlugin;
	private translate: (key: TranslationKey, variables?: Record<string, any>) => string;

	// Form fields
	private titleInput!: Setting;
	private descriptionInput!: Setting;
	private colorValue: string;
	private selectedTask: TaskInfo | undefined;

	// Editable time fields
	private startDateTimeInput!: HTMLInputElement;
	private endDateTimeInput!: HTMLInputElement;

	// Task display
	private taskDisplayEl!: HTMLElement;
	private saveButton!: HTMLButtonElement;

	private keyboardHandler: ((e: KeyboardEvent) => void) | null = null;

	constructor(app: App, options: UnifiedTimeInfoModalOptions) {
		super(app);
		this.options = options;
		this.entry = { ...options.entry }; // Working copy
		this.plugin = options.plugin;
		this.translate = this.plugin.i18n.translate.bind(this.plugin.i18n);
		this.colorValue = options.entry.color || "";
		this.selectedTask = options.taskInfo;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("unified-time-info-modal");

		// Add global keyboard shortcut handler for CMD/Ctrl+Enter
		this.keyboardHandler = (e: KeyboardEvent) => {
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				this.saveEntry();
			}
		};
		this.containerEl.addEventListener("keydown", this.keyboardHandler);

		// Header — "Time Block" if future, "Time Entry" if past
		const isFuture = (window as any).moment(this.entry.startTime).isAfter((window as any).moment());
		const headingKey: TranslationKey = isFuture
			? "modals.timeInfo.titleTimeBlock"
			: "modals.timeInfo.titleTimeEntry";

		const headerEl = contentEl.createDiv({ cls: "unified-time-info-modal__header" });
		new Setting(headerEl)
			.setName(this.translate(headingKey))
			.setHeading();

		// Date & Time fields (editable)
		this.renderDateTimeFields(contentEl);
		this.renderQuickDateButtons(contentEl);

		// Title field (editable)
		this.titleInput = new Setting(contentEl)
			.setName(this.translate("modals.timeInfo.entryTitle"))
			.addText((text) => {
				text.setValue(this.entry.title || "")
					.setPlaceholder(this.selectedTask?.title || "")
					.onChange((value) => {
						this.entry.title = value;
					});
			});

		// Description field (editable)
		this.descriptionInput = new Setting(contentEl)
			.setName(this.translate("modals.timeInfo.description"))
			.addTextArea((text) => {
				text.setValue(this.entry.description || "")
					.onChange((value) => {
						this.entry.description = value;
					});
				text.inputEl.rows = 3;
			});

		// Color picker
		new Setting(contentEl)
			.setName(this.translate("modals.timeInfo.color"))
			.addText((text) => {
				text.inputEl.type = "color";
				text.setValue(this.colorValue || this.plugin.settings.calendarViewSettings.defaultTimeblockColor);
				text.onChange((value) => {
					this.colorValue = value;
				});
			});

		// Task section
		this.renderTaskSection(contentEl);

		// Action buttons
		this.renderActions(contentEl);

		// Focus the title input
		window.setTimeout(() => {
			const inputEl = this.titleInput.controlEl.querySelector("input");
			if (inputEl) inputEl.focus();
		}, 50);
	}

	/**
	 * Render date/time inputs — either native datetime-local pickers
	 * or NLP text fields depending on the user's setting.
	 */
	private renderDateTimeFields(containerEl: HTMLElement): void {
		if (this.plugin.settings.nlpDateTimeInput) {
			this.renderNlpDateTimeFields(containerEl);
		} else {
			this.renderNativeDateTimeFields(containerEl);
		}
	}

	private renderNativeDateTimeFields(containerEl: HTMLElement): void {
		const moment = (window as any).moment;
		const start = moment(this.entry.startTime);

		new Setting(containerEl)
			.setName(this.translate("modals.timeInfo.startTime"))
			.addText((text) => {
				this.startDateTimeInput = text.inputEl;
				this.startDateTimeInput.type = "datetime-local";
				text.setValue(start.format("YYYY-MM-DDTHH:mm"));
			});

		new Setting(containerEl)
			.setName(this.translate("modals.timeInfo.endTime"))
			.addText((text) => {
				this.endDateTimeInput = text.inputEl;
				this.endDateTimeInput.type = "datetime-local";
				if (this.entry.endTime) {
					const end = moment(this.entry.endTime);
					text.setValue(end.format("YYYY-MM-DDTHH:mm"));
				} else {
					text.setValue("");
				}
			});
	}

	/**
	 * NLP text fields: user types natural language like "9am 2/18" or "tomorrow 3pm".
	 * Parses live as the user types (debounced) and shows the result beneath the field.
	 */
	private renderNlpDateTimeFields(containerEl: HTMLElement): void {
		const moment = (window as any).moment;
		const start = moment(this.entry.startTime);
		const startSuggestion = start.format("MMM D, YYYY h:mm A");

		// Hidden inputs to store parsed ISO values
		this.startDateTimeInput = document.createElement("input");
		this.startDateTimeInput.type = "hidden";
		this.startDateTimeInput.value = start.format("YYYY-MM-DDTHH:mm");

		this.endDateTimeInput = document.createElement("input");
		this.endDateTimeInput.type = "hidden";
		if (this.entry.endTime) {
			this.endDateTimeInput.value = moment(this.entry.endTime).format("YYYY-MM-DDTHH:mm");
		}

		// Start time NLP input
		const startSetting = new Setting(containerEl)
			.setName(this.translate("modals.timeInfo.startTime"));
		// Show initial parsed value
		startSetting.setDesc(start.format("ddd, MMM D YYYY h:mm A"));
		startSetting.addText((text) => {
			text.setPlaceholder(startSuggestion);
			text.inputEl.addClass("nlp-datetime-input");
			text.setValue(startSuggestion);
			this.attachNlpParser(text.inputEl, startSetting, this.startDateTimeInput, true);
		});

		// End time NLP input
		const endSuggestion = this.entry.endTime
			? moment(this.entry.endTime).format("MMM D, YYYY h:mm A")
			: "";
		const endSetting = new Setting(containerEl)
			.setName(this.translate("modals.timeInfo.endTime"));
		if (this.entry.endTime) {
			endSetting.setDesc(moment(this.entry.endTime).format("ddd, MMM D YYYY h:mm A"));
		}
		endSetting.addText((text) => {
			text.setPlaceholder(endSuggestion || "e.g., 2pm today");
			text.inputEl.addClass("nlp-datetime-input");
			if (endSuggestion) text.setValue(endSuggestion);
			this.attachNlpParser(text.inputEl, endSetting, this.endDateTimeInput, false);
		});
	}

	/**
	 * Attach live NLP parsing to a text input. Debounces at 250ms so we don't
	 * parse on every keystroke, but the user sees near-instant feedback.
	 */
	private attachNlpParser(
		inputEl: HTMLInputElement,
		setting: Setting,
		hiddenInput: HTMLInputElement,
		required: boolean
	): void {
		const moment = (window as any).moment;
		let debounceTimer: ReturnType<typeof setTimeout> | null = null;

		const parseAndUpdate = () => {
			const val = inputEl.value.trim();
			if (!val) {
				hiddenInput.value = "";
				setting.setDesc(required ? "Type a date/time…" : "");
				inputEl.removeClass("nlp-datetime-error");
				return;
			}
			const parsed = chrono.parseDate(val);
			if (parsed) {
				hiddenInput.value = moment(parsed).format("YYYY-MM-DDTHH:mm");
				inputEl.removeClass("nlp-datetime-error");
				inputEl.addClass("nlp-datetime-valid");
				setting.setDesc(moment(parsed).format("ddd, MMM D YYYY h:mm A"));
			} else {
				inputEl.removeClass("nlp-datetime-valid");
				inputEl.addClass("nlp-datetime-error");
				setting.setDesc("Could not parse date/time");
			}
		};

		inputEl.addEventListener("input", () => {
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(parseAndUpdate, 250);
		});

		// Also parse immediately on blur (in case debounce hasn't fired yet)
		inputEl.addEventListener("blur", () => {
			if (debounceTimer) {
				clearTimeout(debounceTimer);
				debounceTimer = null;
			}
			parseAndUpdate();
		});
	}

	/**
	 * Render quick-date shortcut buttons for common scheduling options.
	 */
	private renderQuickDateButtons(containerEl: HTMLElement): void {
		const moment = (window as any).moment;
		const quickActionsEl = containerEl.createDiv({ cls: "modal-form__quick-actions" });

		quickActionsEl.createEl("span", {
			text: this.translate("modals.timeInfo.quickDates" as any),
			cls: "modal-form__quick-actions-label",
		});

		const buttonsEl = quickActionsEl.createDiv({ cls: "modal-form__quick-actions-buttons" });

		const today = moment().startOf("day");
		const commonDates: Array<{ label: string; date: any }> = [
			{ label: "Today", date: moment().startOf("day") },
			{ label: "Tomorrow", date: moment().add(1, "day").startOf("day") },
			{ label: "This weekend", date: moment().day(6).startOf("day") },
			{ label: "Next week", date: moment().add(1, "week").startOf("isoWeek") },
			{ label: "Next month", date: moment().add(1, "month").startOf("month") },
		];

		if (commonDates[2].date.isSameOrBefore(today)) {
			commonDates[2].date = moment().add(1, "week").day(6).startOf("day");
		}

		for (const { label, date } of commonDates) {
			const btn = buttonsEl.createEl("button", {
				text: label,
				cls: "modal-form__quick-action-btn",
			});
			btn.addEventListener("click", (e) => {
				e.preventDefault();
				this.applyQuickDate(date.toDate());
			});
		}

		if (!this.options.isNew) {
			const relativeDates: Array<{ label: string; amount: number; unit: string }> = [
				{ label: "+1 day", amount: 1, unit: "day" },
				{ label: "-1 day", amount: -1, unit: "day" },
				{ label: "+1 week", amount: 1, unit: "week" },
				{ label: "-1 week", amount: -1, unit: "week" },
			];

			for (const { label, amount, unit } of relativeDates) {
				const btn = buttonsEl.createEl("button", {
					text: label,
					cls: "modal-form__quick-action-btn",
				});
				btn.addEventListener("click", (e) => {
					e.preventDefault();
					const currentStart = this.startDateTimeInput.value;
					if (currentStart) {
						const newDate = moment(currentStart).add(amount, unit as any).toDate();
						this.applyQuickDate(newDate);
					}
				});
			}
		}
	}

	/**
	 * Apply a quick date selection — update start time and shift end time by same delta.
	 */
	private applyQuickDate(newDate: Date): void {
		const moment = (window as any).moment;
		const currentStartVal = this.startDateTimeInput.value;
		const oldStart = currentStartVal ? moment(currentStartVal) : moment();
		const newStart = moment(newDate);

		if (newStart.hour() === 0 && newStart.minute() === 0 && oldStart.hour() !== 0) {
			newStart.hour(oldStart.hour()).minute(oldStart.minute());
		}

		const delta = newStart.diff(oldStart);
		this.startDateTimeInput.value = newStart.format("YYYY-MM-DDTHH:mm");

		if (this.endDateTimeInput.value) {
			const oldEnd = moment(this.endDateTimeInput.value);
			const newEnd = oldEnd.add(delta, "milliseconds");
			this.endDateTimeInput.value = newEnd.format("YYYY-MM-DDTHH:mm");
		}

		if (this.plugin.settings.nlpDateTimeInput) {
			const settings = this.contentEl.querySelectorAll(".setting-item");
			settings.forEach((settingEl) => {
				const nameEl = settingEl.querySelector(".setting-item-name");
				if (!nameEl) return;
				const descEl = settingEl.querySelector(".setting-item-description");
				const inputEl = settingEl.querySelector("input.nlp-datetime-input") as HTMLInputElement;
				if (!descEl || !inputEl) return;

				const name = nameEl.textContent || "";
				if (name === this.translate("modals.timeInfo.startTime" as any)) {
					inputEl.value = newStart.format("MMM D, YYYY h:mm A");
					descEl.textContent = newStart.format("ddd, MMM D YYYY h:mm A");
				} else if (name === this.translate("modals.timeInfo.endTime" as any) && this.endDateTimeInput.value) {
					const endMoment = moment(this.endDateTimeInput.value);
					inputEl.value = endMoment.format("MMM D, YYYY h:mm A");
					descEl.textContent = endMoment.format("ddd, MMM D YYYY h:mm A");
				}
			});
		}
	}

	/**
	 * Render task selector / display section.
	 * In creation mode without a task: shows a "Select task" button.
	 * With a task: shows the task name as a clickable link with a "Change" button.
	 */
	private renderTaskSection(containerEl: HTMLElement): void {
		this.taskDisplayEl = containerEl.createDiv({ cls: "unified-time-info-modal__task" });
		this.refreshTaskDisplay();
	}

	private refreshTaskDisplay(): void {
		this.taskDisplayEl.empty();
		this.updateSaveButtonState();

		const setting = new Setting(this.taskDisplayEl)
			.setName(this.translate("modals.timeInfo.task"));

		if (this.selectedTask) {
			// Show task name as a clickable link
			setting.addButton((button) => {
				button
					.setButtonText(this.selectedTask!.title)
					.setClass("clickable-icon")
					.onClick(() => {
						this.plugin.app.workspace.openLinkText(this.selectedTask!.path, "");
						this.close();
					});
			});

			// Change button
			setting.addButton((button) => {
				button
					.setButtonText(this.translate("modals.timeInfo.changeTask"))
					.onClick(() => this.openTaskPicker());
			});
		} else {
			// No task selected — show picker button
			setting.addButton((button) => {
				button
					.setButtonText(this.translate("modals.timeInfo.selectTask"))
					.setCta()
					.onClick(() => this.openTaskPicker());
			});
		}
	}

	private async openTaskPicker(): Promise<void> {
		const tasks = await this.plugin.cacheManager.getAllTasks();
		openTaskSelector(
			this.plugin,
			tasks,
			(task) => {
				if (task) {
					this.selectedTask = task;
					this.refreshTaskDisplay();
				}
			},
			{ placeholder: this.translate("modals.timeInfo.selectTask") }
		);
	}

	/**
	 * Render the Delete / Cancel / Save action buttons.
	 */
	private renderActions(containerEl: HTMLElement): void {
		const actionsEl = containerEl.createDiv({ cls: "unified-time-info-modal__actions" });
		actionsEl.style.display = "flex";
		actionsEl.style.justifyContent = "space-between";
		actionsEl.style.alignItems = "center";
		actionsEl.style.marginTop = "20px";

		// Delete button (left side) — only shown in edit mode
		if (!this.options.isNew) {
			const deleteButton = actionsEl.createEl("button", {
				text: this.translate("modals.timeInfo.delete"),
				cls: "mod-warning",
			});
			deleteButton.addEventListener("click", () => this.handleDelete());
		} else {
			// Spacer to keep right buttons aligned
			actionsEl.createDiv();
		}

		// Right side buttons
		const rightButtons = actionsEl.createDiv();
		rightButtons.style.display = "flex";
		rightButtons.style.gap = "8px";

		const cancelButton = rightButtons.createEl("button", {
			text: this.translate("modals.timeInfo.cancel"),
		});
		cancelButton.addEventListener("click", () => this.close());

		this.saveButton = rightButtons.createEl("button", {
			text: this.options.isNew
				? this.translate("modals.timeInfo.create")
				: this.translate("modals.timeInfo.save"),
			cls: "mod-cta",
		});
		this.saveButton.addEventListener("click", () => this.saveEntry());
		this.updateSaveButtonState();
	}

	private updateSaveButtonState(): void {
		if (!this.saveButton) return;
		const enabled = !!this.selectedTask;
		this.saveButton.disabled = !enabled;
		this.saveButton.style.opacity = enabled ? "1" : "0.5";
		if (!enabled) {
			setTooltip(this.saveButton, this.translate("modals.timeInfo.taskRequired"), { placement: "top" });
		} else {
			this.saveButton.removeAttribute("aria-label");
		}
	}

	/**
	 * Build the updated entry from form field values.
	 */
	private buildUpdatedEntry(): UnifiedTimeEntry {
		const titleEl = this.titleInput.controlEl.querySelector("input") as HTMLInputElement | null;
		const descEl = this.descriptionInput.controlEl.querySelector("textarea") as HTMLTextAreaElement | null;

		// datetime-local value is "YYYY-MM-DDTHH:mm"
		const startVal = this.startDateTimeInput.value;
		const endVal = this.endDateTimeInput.value;

		const tzSuffix = getTimezoneOffsetString();
		const startTime = startVal ? `${startVal}:00${tzSuffix}` : this.entry.startTime;
		const endTime = endVal ? `${endVal}:00${tzSuffix}` : this.entry.endTime;

		return {
			...this.entry,
			startTime,
			endTime,
			title: titleEl?.value?.trim() || undefined,
			description: descEl?.value?.trim() || undefined,
			color: this.colorValue || undefined,
		};
	}

	/**
	 * Save the entry back to the task's timeEntries array.
	 * If autoStopOtherTimeTracking is enabled and the entry has an endTime,
	 * detects overlapping time entries across all tasks and prompts the user
	 * to confirm adjustments before saving.
	 */
	private async saveEntry(): Promise<void> {
		// Validate: task must be selected
		if (!this.selectedTask) {
			new Notice(this.translate("modals.timeInfo.taskRequired"));
			return;
		}

		// Validate: start time is required
		if (!this.startDateTimeInput.value) {
			new Notice(this.translate("modals.timeInfo.timeRequired"));
			return;
		}

		try {
			const updatedEntry = this.buildUpdatedEntry();
			const task = this.selectedTask;

			// Overlap detection: check if this entry overlaps with others
			const proceed = await this.plugin.timeEntryStorageService.checkAndResolveOverlaps(updatedEntry);
			if (!proceed) return;

			// Save the edited entry itself
			const entries = [...(await this.plugin.timeEntryStorageService.readEntries(task))];

			if (this.options.isNew) {
				entries.push(updatedEntry);
			} else {
				const idx = entries.findIndex((e) => e.id === updatedEntry.id);
				if (idx !== -1) {
					entries[idx] = updatedEntry;
				} else {
					// Entry not found (maybe task changed) — append
					entries.push(updatedEntry);
				}
			}

			await this.plugin.taskService.updateTask(task, { timeEntries: entries });

			this.options.onChange?.();
			this.plugin.emitter.trigger("data-changed");

			const noticeKey = this.options.isNew
				? "modals.timeInfo.created"
				: "modals.timeInfo.saved";
			new Notice(this.translate(noticeKey));
			this.close();
		} catch (error) {
			console.error("Error saving time entry:", error);
			new Notice(String(error));
		}
	}

	/**
	 * Delete the entry from the task's timeEntries array after confirmation.
	 */
	private async handleDelete(): Promise<void> {
		const confirmed = await this.showDeleteConfirmation();
		if (!confirmed) return;

		try {
			if (this.selectedTask) {
				const task = this.selectedTask;
				await this.plugin.timeEntryStorageService.deleteEntry(task, this.entry.id);
			}

			this.options.onChange?.();
			this.plugin.emitter.trigger("data-changed");

			new Notice(this.translate("modals.timeInfo.deleted"));
			this.close();
		} catch (error) {
			console.error("Error deleting time entry:", error);
			new Notice(String(error));
		}
	}

	/**
	 * Show a confirmation modal before deleting.
	 */
	private async showDeleteConfirmation(): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			modal.titleEl.setText(this.translate("modals.timeInfo.confirmDelete"));

			const content = modal.contentEl;
			const entryTitle = this.entry.title || this.selectedTask?.title || "";
			content.createEl("p", {
				text: `Are you sure you want to delete "${entryTitle}"?`,
			});
			content.createEl("p", {
				text: "This action cannot be undone.",
				cls: "mod-warning",
			});

			const buttonContainer = content.createDiv({ cls: "modal-button-container" });
			buttonContainer.style.display = "flex";
			buttonContainer.style.justifyContent = "flex-end";
			buttonContainer.style.gap = "8px";
			buttonContainer.style.marginTop = "20px";

			const cancelBtn = buttonContainer.createEl("button", {
				text: this.translate("modals.timeInfo.cancel"),
			});
			cancelBtn.addEventListener("click", () => {
				modal.close();
				resolve(false);
			});

			const deleteBtn = buttonContainer.createEl("button", {
				text: this.translate("modals.timeInfo.delete"),
				cls: "mod-warning",
			});
			deleteBtn.addEventListener("click", () => {
				modal.close();
				resolve(true);
			});

			modal.open();

			// Focus cancel button by default for safety
			setTimeout(() => cancelBtn.focus(), 50);
		});
	}

	onClose() {
		// Clean up keyboard handler
		if (this.keyboardHandler) {
			this.containerEl.removeEventListener("keydown", this.keyboardHandler);
			this.keyboardHandler = null;
		}

		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * Convenience function to open the UnifiedTimeInfoModal.
 */
export function showUnifiedTimeInfoModal(
	entry: UnifiedTimeEntry,
	taskInfo: TaskInfo | undefined,
	plugin: TaskNotesPlugin,
	onChange?: () => void,
	options?: { isNew?: boolean }
): void {
	const modal = new UnifiedTimeInfoModal(plugin.app, {
		entry,
		taskInfo,
		plugin,
		onChange,
		isNew: options?.isNew,
	});
	modal.open();
}
