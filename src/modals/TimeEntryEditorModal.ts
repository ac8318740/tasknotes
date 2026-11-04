import { uiLocale } from "../i18n/runtime";
import { msg } from "@lingui/core/macro";
import { App, Modal, Notice, setIcon } from "obsidian";
import type { EmbeddableMarkdownEditor } from "../editor/EmbeddableMarkdownEditor";
import { TimeEntry, TaskInfo } from "../types";
import type TaskNotesPlugin from "../main";
import { MessageDescriptor } from "../i18n";
import { createTaskModalMarkdownEditor } from "./taskModalEditorAdapter";
import { format } from "date-fns";
import { allocateTimeEntry, TimeEntryOccurrenceError } from "../core/recurrence";
import { normalizeTaskUpdateInput } from "../services/task-service/taskUpdatePlanning";
import { chooseTimeEntryOccurrence } from "./TimeEntryOccurrenceModal";
import { formatTime, getTimeEntryMinutes } from "../utils/helpers";
import { fromVaultDate, toVaultDate } from "../utils/vaultTime";

export class TimeEntryEditorModal extends Modal {
	private plugin: TaskNotesPlugin;
	private task: TaskInfo;
	private timeEntries: TimeEntry[];
	private onSave: (timeEntries: TimeEntry[]) => void | Promise<void>;
	private saving = false;
	private translate: (key: MessageDescriptor, variables?: Record<string, unknown>) => string;
	private entriesContainerEl: HTMLElement;
	private keyboardHandler: ((e: KeyboardEvent) => void) | null = null;
	private totalEl: HTMLElement | null = null;
	private groupHeaders: Array<{ el: HTMLElement; key: string }> = [];
	private descriptionEditors: EmbeddableMarkdownEditor[] = [];

	constructor(
		app: App,
		plugin: TaskNotesPlugin,
		task: TaskInfo,
		onSave: (timeEntries: TimeEntry[]) => void | Promise<void>
	) {
		super(app);
		this.plugin = plugin;
		this.task = task;
		// Create a working copy of time entries
		this.timeEntries = (task.timeEntries ?? []).map((entry) => ({ ...entry }));
		this.onSave = onSave;
		this.translate = plugin.i18n.translate.bind(plugin.i18n);
	}

	onOpen() {
		const { contentEl } = this;
		this.cleanupDescriptionEditors();
		contentEl.empty();
		contentEl.addClass("time-entry-editor-modal");
		this.modalEl.addClass("time-entry-editor-modal__dialog");

		// Modal title
		this.titleEl.setText(
			this.translate(msg({ message: "Time Entries - {taskTitle}", context: "modals.timeEntryEditor.title" }), { taskTitle: this.task.title })
		);

		// Add global keyboard shortcut handler for CMD/Ctrl+Enter
		if (this.keyboardHandler) {
			this.containerEl.removeEventListener("keydown", this.keyboardHandler);
		}

		this.keyboardHandler = (e: KeyboardEvent) => {
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				this.save();
			}
		};
		this.containerEl.addEventListener("keydown", this.keyboardHandler);

		// Create container for entries
		this.entriesContainerEl = contentEl.createDiv({ cls: "time-entry-editor-modal__entries" });

		this.renderEntries();

		// Add new entry button
		const addButtonContainer = contentEl.createDiv({
			cls: "time-entry-editor-modal__add-button-container",
		});
		const addButton = addButtonContainer.createEl("button", {
			// Save is the one primary action, so adding an entry stays a plain button.
			text: this.translate(msg({ message: "Add time entry", context: "modals.timeEntryEditor.addEntry" })),
		});
		addButton.addEventListener("click", () => this.addNewEntry());

		// Footer with total time and actions
		const footer = contentEl.createDiv({ cls: "time-entry-editor-modal__footer" });

		this.totalEl = footer.createDiv({
			cls: "time-entry-editor-modal__total",
		});
		this.updateTotalDisplay();

		const buttonContainer = footer.createDiv({ cls: "time-entry-editor-modal__buttons" });

		const cancelButton = buttonContainer.createEl("button", {
			text: this.translate(msg({ message: "Cancel", context: "common.cancel" })),
		});
		cancelButton.addEventListener("click", () => this.close());

		const saveButton = buttonContainer.createEl("button", {
			text: this.translate(msg({ message: "Save", context: "common.save" })),
			cls: "mod-cta",
		});
		saveButton.addEventListener("click", () => this.save());
	}

	private renderEntries() {
		this.cleanupDescriptionEditors();
		this.entriesContainerEl.empty();
		this.groupHeaders = [];

		if (this.timeEntries.length === 0) {
			this.entriesContainerEl.createDiv({
				cls: "time-entry-editor-modal__empty",
				text: this.translate(msg({ message: "No time entries yet", context: "modals.timeEntryEditor.noEntries" })),
			});
			return;
		}

		// Column labels, aligned with every row below
		const labels = this.entriesContainerEl.createDiv({
			cls: "time-entry-editor-modal__row time-entry-editor-modal__labels",
			attr: { "aria-hidden": "true" },
		});
		labels.createSpan({ text: this.translate(msg({ message: "Date", context: "modals.timeEntryEditor.column.date" })) });
		labels.createSpan({ text: this.translate(msg({ message: "Start", context: "modals.timeEntryEditor.column.start" })) });
		labels.createSpan();
		labels.createSpan({ text: this.translate(msg({ message: "End", context: "modals.timeEntryEditor.column.end" })) });
		labels.createSpan({ text: this.translate(msg({ message: "Duration", context: "modals.timeEntryEditor.column.duration" })) });

		// Newest first
		const sortedEntries = [...this.timeEntries].sort(
			(a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
		);

		if (!this.task.recurrence) {
			sortedEntries.forEach((entry) => this.renderEntry(this.entriesContainerEl, entry));
			return;
		}

		// A recurring task's entries are grouped by the occurrence they count toward.
		const groups = new Map<string, TimeEntry[]>();
		for (const entry of sortedEntries) {
			const key = this.getOccurrenceKey(entry);
			groups.set(key, [...(groups.get(key) ?? []), entry]);
		}
		const keys = [...groups.keys()].sort((a, b) => (a && b ? b.localeCompare(a) : a ? -1 : 1));
		for (const key of keys) {
			const groupEl = this.entriesContainerEl.createDiv({ cls: "time-entry-editor-modal__group" });
			const headerEl = groupEl.createDiv({ cls: "time-entry-editor-modal__group-header" });
			this.groupHeaders.push({ el: headerEl, key });
			groups.get(key)?.forEach((entry) => this.renderEntry(groupEl, entry));
		}
		this.updateTotalDisplay();
	}

	private getOccurrenceKey(entry: TimeEntry): string {
		return entry.occurrence ?? "";
	}

	private renderEntry(container: HTMLElement, entry: TimeEntry) {
		const entryEl = container.createDiv({ cls: "time-entry-editor-modal__entry" });
		const row = entryEl.createDiv({ cls: "time-entry-editor-modal__row" });
		const isRunning = () => hasClockTimes(entry) && !entry.endTime;

		const dateInput = this.createInput(row, "date", msg({ message: "Date", context: "modals.timeEntryEditor.column.date" }));
		const startInput = this.createInput(row, "time", msg({ message: "Start time", context: "modals.timeEntryEditor.startTime" }));
		row.createSpan({ cls: "time-entry-editor-modal__dash", text: "\u2013" });
		const endInput = this.createInput(row, "time", msg({ message: "End time", context: "modals.timeEntryEditor.endTime" }));

		const durationEl = row.createDiv({ cls: "time-entry-editor-modal__duration" });
		const durationInput = this.createInput(durationEl, "number", msg({ message: "Duration in minutes", context: "modals.timeEntryEditor.durationLabel" }));
		durationInput.min = "0";
		durationInput.step = "1";
		const unitEl = durationEl.createSpan({ cls: "time-entry-editor-modal__unit" });

		const deleteButton = row.createEl("button", {
			cls: "time-entry-editor-modal__delete-button clickable-icon",
			attr: { "aria-label": this.translate(msg({ message: "Delete entry", context: "modals.timeEntryEditor.deleteEntry" })) },
		});
		setIcon(deleteButton, "trash-2");
		deleteButton.addEventListener("click", () => this.deleteEntry(this.timeEntries.indexOf(entry)));

		// The inputs always show the entry; every edit writes the entry, then syncs back.
		const sync = () => {
			dateInput.value = getEntryDay(entry);
			startInput.value = hasClockTimes(entry) ? getClockTime(entry.startTime) : "";
			endInput.value = hasClockTimes(entry) && entry.endTime ? getClockTime(entry.endTime) : "";
			durationInput.value = String(this.calculateDuration(entry));
			durationInput.disabled = isRunning();
			unitEl.setText(
				isRunning()
					? this.translate(msg({ message: "running", context: "modals.timeEntryEditor.running" }))
					: this.translate(msg({ message: "min", context: "modals.timeEntryEditor.minutesUnit" }))
			);
			this.updateTotalDisplay();
		};
		// A changed date or start keeps the entry's length, however long; a running entry keeps running.
		const keptMinutes = () => (isRunning() ? null : this.calculateDuration(entry));
		const moved = sync;

		dateInput.addEventListener("change", () => {
			if (!dateInput.value) return sync();
			setEntryTimes(entry, dateInput.value, startInput.value, keptMinutes());
			moved();
		});
		startInput.addEventListener("change", () => {
			const minutes = startInput.value ? keptMinutes() : this.calculateDuration(entry);
			setEntryTimes(entry, dateInput.value, startInput.value, minutes);
			moved();
		});
		endInput.addEventListener("change", () => {
			if (!endInput.value) {
				// No end means still running; an entry without clock times has none to clear.
				if (hasClockTimes(entry)) entry.endTime = undefined;
			} else if (!startInput.value) {
				// Clock times added to a length: it ends at the new end time.
				const end = new Date(`${dateInput.value}T${endInput.value}`);
				const start = new Date(end.getTime() - this.calculateDuration(entry) * 60000);
				setEntryTimes(entry, format(start, "yyyy-MM-dd"), format(start, "HH:mm"), this.calculateDuration(entry));
			} else {
				setEntryTimes(entry, dateInput.value, startInput.value, getClockMinutesBetween(startInput.value, endInput.value));
			}
			moved();
		});
		durationInput.addEventListener("change", () => {
			const minutes = Math.max(0, Math.round(Number(durationInput.value) || 0));
			setEntryTimes(entry, dateInput.value, startInput.value, minutes);
			sync();
		});
		sync();

		if (this.task.recurrence) {
			const allocation = entryEl.createEl("button", {
				text: this.translate(
					msg({
						message: "Change occurrence",
						context: "modals.timeEntryEditor.changeOccurrence",
					})
				),
			});
			allocation.addEventListener("click", async () => {
				const occurrence = await chooseTimeEntryOccurrence(
					this.app,
					this.plugin,
					this.task,
					getEntryDay(entry)
				);
				if (!occurrence) return;
				entry.occurrence = occurrence;
				this.renderEntries();
			});
		}

		const descriptionEl = entryEl.createDiv({
			cls: "time-entry-editor-modal__description-editor-container",
		});
		this.renderLazyDescriptionEditor(entry, descriptionEl);
	}

	private createInput(
		container: HTMLElement,
		type: "date" | "time" | "number",
		label: MessageDescriptor
	): HTMLInputElement {
		return container.createEl("input", {
			type,
			cls: `time-entry-editor-modal__input time-entry-editor-modal__input--${type}`,
			attr: { "aria-label": this.translate(label) },
		});
	}

	private renderLazyDescriptionEditor(entry: TimeEntry, editorContainer: HTMLElement): void {
		const textarea = editorContainer.createEl("textarea", {
			cls: "time-entry-editor-modal__description-editor-fallback",
			placeholder: this.translate(msg({ message: "What did you work on?", context: "modals.timeEntryEditor.descriptionPlaceholder" })),
		});
		textarea.value = entry.description || "";

		textarea.addEventListener("input", () => {
			entry.description = textarea.value || undefined;
		});

		textarea.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				this.save();
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.close();
			}
		});

		let hydrated = false;
		const hydrateMarkdownEditor = () => {
			if (hydrated) {
				return;
			}
			hydrated = true;

			entry.description = textarea.value || undefined;
			editorContainer.empty();

			const editor = this.createDescriptionMarkdownEditor(entry, editorContainer);
			if (editor) {
				this.descriptionEditors.push(editor);
			}
			this.focusDescriptionEditor(editorContainer);
		};

		textarea.addEventListener("focus", hydrateMarkdownEditor, { once: true });
	}

	private createDescriptionMarkdownEditor(
		entry: TimeEntry,
		editorContainer: HTMLElement
	): EmbeddableMarkdownEditor | null {
		const editor = createTaskModalMarkdownEditor(this.app, editorContainer, {
			value: entry.description || "",
			placeholder: this.translate(msg({ message: "What did you work on?", context: "modals.timeEntryEditor.descriptionPlaceholder" })),
			cls: "time-entry-editor-modal__description-editor",
			onChange: (value) => {
				entry.description = value || undefined;
			},
			onSubmit: () => this.save(),
			onEscape: () => this.close(),
			onTab: () => false,
		});

		return editor;
	}

	private focusDescriptionEditor(editorContainer: HTMLElement): void {
		window.setTimeout(() => {
			const focusTarget = editorContainer.querySelector<HTMLElement>(".cm-content, textarea");
			focusTarget?.focus();
		}, 0);
	}

	private cleanupDescriptionEditors(): void {
		this.descriptionEditors.forEach((editor) => editor.destroy());
		this.descriptionEditors = [];
	}

	private updateTotalDisplay(): void {
		for (const { el, key } of this.groupHeaders) {
			const minutes = this.timeEntries
				.filter((entry) => this.getOccurrenceKey(entry) === key)
				.reduce((total, entry) => total + this.calculateDuration(entry), 0);
			const logged = formatTime(minutes);
			const date = key
				? new Date(`${key}T00:00`).toLocaleDateString(uiLocale(), { weekday: "short", day: "numeric", month: "short" })
				: "";
			el.setText(
				!key
					? this.translate(msg({ message: "No occurrence \u00b7 {logged} logged", context: "modals.timeEntryEditor.group.noOccurrence" }), { logged })
					: this.task.timeEstimate
						? this.translate(msg({ message: "Occurrence of {date} \u00b7 {logged} logged of {estimate} estimated", context: "modals.timeEntryEditor.group.withEstimate" }), { date, logged, estimate: formatTime(this.task.timeEstimate) })
						: this.translate(msg({ message: "Occurrence of {date} \u00b7 {logged} logged", context: "modals.timeEntryEditor.group" }), { date, logged })
			);
		}

		this.totalEl?.setText(
			this.translate(msg({ message: "{logged} logged in total", context: "modals.timeEntryEditor.total" }), {
				logged: formatTime(this.calculateTotalMinutes()),
			})
		);
	}

	private calculateDuration(entry: TimeEntry): number {
		if (typeof entry.minutes === "number") return getTimeEntryMinutes(entry);
		const end = entry.endTime ? new Date(entry.endTime) : new Date();
		return Math.max(0, Math.round((end.getTime() - new Date(entry.startTime).getTime()) / 60000));
	}

	private calculateTotalMinutes(): number {
		return this.timeEntries.reduce((total, entry) => total + this.calculateDuration(entry), 0);
	}

	private async addNewEntry() {
		const now = new Date();
		const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

		const newEntry: TimeEntry = {
			startTime: oneHourAgo.toISOString(),
			endTime: now.toISOString(),
			description: "",
		};
		try {
			Object.assign(newEntry, allocateTimeEntry(this.task, newEntry));
		} catch (error) {
			if (!(error instanceof TimeEntryOccurrenceError)) throw error;
			const occurrence = await chooseTimeEntryOccurrence(
				this.app,
				this.plugin,
				error.task,
				getEntryDay(newEntry)
			);
			if (!occurrence) return;
			newEntry.occurrence = occurrence;
		}

		this.timeEntries.push(newEntry);
		this.renderEntries();
		this.updateTotalDisplay();
	}

	private deleteEntry(index: number) {
		if (index < 0) return;
		this.timeEntries.splice(index, 1);
		this.renderEntries();
		this.updateTotalDisplay();
	}

	private async save() {
		if (this.saving) return;
		// Validate entries
		for (const entry of this.timeEntries) {
			if (!entry.startTime) {
				new Notice(this.translate(msg({ message: "Start time is required", context: "modals.timeEntryEditor.validation.missingStartTime" })));
				return;
			}

			// An entry logged without clock times holds one date in both start and end.
			if (entry.endTime && typeof entry.minutes !== "number") {
				const start = new Date(entry.startTime);
				const end = new Date(entry.endTime);
				if (end <= start) {
					new Notice(this.translate(msg({ message: "End time must be after start time", context: "modals.timeEntryEditor.validation.endBeforeStart" })));
					return;
				}
			}
		}

		this.saving = true;
		try {
			while (true) {
				try {
					const { timeEntries } = normalizeTaskUpdateInput({
						timeEntries: this.timeEntries,
					});
					await this.onSave(timeEntries ?? []);
					this.close();
					return;
				} catch (error) {
					if (!(error instanceof TimeEntryOccurrenceError)) throw error;
					const entry = this.timeEntries.find(
						(item) =>
							item.startTime === error.entry.startTime &&
							item.occurrence === error.entry.occurrence
					);
					if (!entry) throw error;
					const occurrence = await chooseTimeEntryOccurrence(
						this.app,
						this.plugin,
						error.task,
						getEntryDay(entry)
					);
					if (!occurrence) return;
					entry.occurrence = occurrence;
					this.renderEntries();
				}
			}
		} catch (error) {
			console.error("Failed to save time entries:", error);
			new Notice(
				this.translate(
					msg({
						message: "Failed to save time entries",
						context: "modals.timeEntryEditor.saveFailed",
					})
				)
			);
		} finally {
			this.saving = false;
		}
	}

	onClose() {
		this.cleanupDescriptionEditors();
		this.totalEl = null;

		// Clean up keyboard handler
		if (this.keyboardHandler) {
			this.containerEl.removeEventListener("keydown", this.keyboardHandler);
			this.keyboardHandler = null;
		}

		const { contentEl } = this;
		contentEl.empty();
	}
}

/** An entry logged with a start (and, unless running, an end) rather than only a duration. */
function hasClockTimes(entry: TimeEntry): boolean {
	return typeof entry.minutes !== "number";
}

/** The local day (YYYY-MM-DD) an entry belongs to; a date-only start is already one. */
function getEntryDay(entry: TimeEntry): string {
	return /^\d{4}-\d{2}-\d{2}$/.test(entry.startTime)
		? entry.startTime
		: format(toVaultDate(entry.startTime), "yyyy-MM-dd");
}

function getClockTime(timestamp: string): string {
	return format(toVaultDate(timestamp), "HH:mm");
}

/** Minutes from one clock time to the next, ending the next day when the end is earlier. */
function getClockMinutesBetween(start: string, end: string): number {
	const toMinutes = (clock: string) => {
		const [hours, minutes] = clock.split(":").map(Number);
		return hours * 60 + minutes;
	};
	return (toMinutes(end) - toMinutes(start) + 1440) % 1440;
}

/**
 * Writes the form's values onto an entry. With a start time it is a clock entry ending
 * `minutes` later, or still running when `minutes` is null. Without one it holds only a
 * length, on the day's local midnight so every reader places it on that day.
 */
export function setEntryTimes(
	entry: TimeEntry,
	day: string,
	start: string,
	minutes: number | null
): void {
	if (!start) {
		entry.startTime = `${day}T00:00`;
		entry.endTime = entry.startTime;
		entry.minutes = minutes ?? 0;
		return;
	}
	delete entry.minutes;
	const startDate = fromVaultDate(new Date(`${day}T${start}`));
	entry.startTime = startDate.toISOString();
	entry.endTime =
		minutes === null ? undefined : new Date(startDate.getTime() + minutes * 60000).toISOString();
}
