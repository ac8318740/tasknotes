import { App, Modal } from "obsidian";
import { OverlapResult } from "../utils/timeTrackingUtils";

/**
 * Modal that displays overlapping time entries and asks the user to confirm
 * adjustments before saving an edited time entry.
 */
export class OverlapConfirmationModal extends Modal {
	private overlaps: OverlapResult[];
	private resolve: ((confirmed: boolean) => void) | null = null;

	constructor(app: App, overlaps: OverlapResult[]) {
		super(app);
		this.overlaps = overlaps;
	}

	public show(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("overlap-confirmation-modal");

		const headingEl = contentEl.createEl("h3");
		headingEl.setText("Overlapping Time Entries");
		headingEl.style.margin = "0 0 8px 0";

		contentEl.createEl("p", {
			text: `The following ${this.overlaps.length === 1 ? "time entry" : "time entries"} will be adjusted to resolve overlaps:`,
		});

		const listEl = contentEl.createEl("div", { cls: "overlap-confirmation-modal__list" });
		listEl.style.maxHeight = "300px";
		listEl.style.overflowY = "auto";
		listEl.style.marginBottom = "16px";

		const moment = (window as any).moment;

		for (const overlap of this.overlaps) {
			const itemEl = listEl.createDiv({ cls: "overlap-confirmation-modal__item" });
			itemEl.style.padding = "8px 12px";
			itemEl.style.marginBottom = "6px";
			itemEl.style.borderRadius = "6px";
			itemEl.style.border = "1px solid var(--background-modifier-border)";

			// Task title
			const titleEl = itemEl.createEl("div");
			titleEl.style.fontWeight = "600";
			titleEl.style.marginBottom = "6px";
			titleEl.setText(overlap.task.title);

			const origDate = moment(overlap.entry.startTime).format("MMM D");
			const origStartTime = moment(overlap.entry.startTime).format("h:mm A");
			const origEndTime = overlap.entry.endTime
				? moment(overlap.entry.endTime).format("h:mm A")
				: "running";

			const labelWidth = "42px";

			// "From:" line — original time range, all muted
			const fromEl = itemEl.createEl("div");
			fromEl.style.fontSize = "0.9em";
			fromEl.style.marginBottom = "2px";
			const fromLabel = fromEl.createEl("span", { text: "From:" });
			fromLabel.style.display = "inline-block";
			fromLabel.style.width = labelWidth;
			const fromRange = fromEl.createEl("span", { text: `${origDate}, ${origStartTime} – ${origEndTime}` });
			fromRange.style.color = "var(--text-muted)";

			// "To:" line — new time range with changed parts in accent color
			const toEl = itemEl.createEl("div");
			toEl.style.fontSize = "0.9em";
			const toLabel = toEl.createEl("span", { text: "To:" });
			toLabel.style.display = "inline-block";
			toLabel.style.width = labelWidth;

			if (overlap.action === "remove") {
				const removed = toEl.createEl("span", { text: `${origDate}, ${origStartTime} – ${origEndTime}` });
				removed.style.color = "var(--text-error)";
				removed.style.textDecoration = "line-through";
				const removedNote = toEl.createEl("span", { text: " (removed)" });
				removedNote.style.color = "var(--text-error)";
			} else if (overlap.action === "adjust-start" && overlap.newStartTime) {
				const newStartTime = moment(overlap.newStartTime).format("h:mm A");
				const newDate = moment(overlap.newStartTime).format("MMM D");
				// Date part — highlight if changed
				const dateChanged = newDate !== origDate;
				const dateSpan = toEl.createEl("span", { text: `${dateChanged ? newDate : origDate}, ` });
				dateSpan.style.color = dateChanged ? "var(--text-accent)" : "var(--text-muted)";
				// Start time — changed (accent)
				const startSpan = toEl.createEl("span", { text: newStartTime });
				startSpan.style.color = "var(--text-accent)";
				// Separator + end time — unchanged (muted)
				const endSpan = toEl.createEl("span", { text: ` – ${origEndTime}` });
				endSpan.style.color = "var(--text-muted)";
			} else if (overlap.action === "adjust-end" && overlap.newEndTime) {
				const newEndTime = moment(overlap.newEndTime).format("h:mm A");
				// Date + start time — unchanged (muted)
				const startSpan = toEl.createEl("span", { text: `${origDate}, ${origStartTime} – ` });
				startSpan.style.color = "var(--text-muted)";
				// End time — changed (accent)
				const endSpan = toEl.createEl("span", { text: newEndTime });
				endSpan.style.color = "var(--text-accent)";
			}
		}

		// Button container
		const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
		buttonContainer.style.display = "flex";
		buttonContainer.style.justifyContent = "flex-end";
		buttonContainer.style.gap = "8px";
		buttonContainer.style.marginTop = "20px";

		const cancelBtn = buttonContainer.createEl("button", {
			text: "Cancel",
		});
		cancelBtn.addEventListener("click", () => {
			if (this.resolve) {
				const r = this.resolve;
				this.resolve = null;
				this.close();
				r(false);
			}
		});

		const confirmBtn = buttonContainer.createEl("button", {
			text: "Confirm",
			cls: "mod-cta",
		});
		confirmBtn.addEventListener("click", () => {
			if (this.resolve) {
				const r = this.resolve;
				this.resolve = null;
				this.close();
				r(true);
			}
		});

		// Focus cancel button by default for safety
		setTimeout(() => cancelBtn.focus(), 50);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		// Ensure promise is resolved even if modal is closed via Escape or clicking outside
		if (this.resolve) {
			const r = this.resolve;
			this.resolve = null;
			r(false);
		}
	}
}
