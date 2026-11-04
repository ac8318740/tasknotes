import { App, SuggestModal } from "obsidian";
import { msg } from "@lingui/core/macro";
import type TaskNotesPlugin from "../main";
import { getTimeEntryOccurrenceChoices, isTimeEntryOccurrence } from "../core/recurrence";

type OccurrenceTask = Parameters<typeof getTimeEntryOccurrenceChoices>[0];

/** Selecting an allocation never writes the task; only the caller's eventual save does. */
export function chooseTimeEntryOccurrence(
	app: App,
	plugin: TaskNotesPlugin,
	task: OccurrenceTask,
	reference: string
): Promise<string | null> {
	return new Promise((resolve) => {
		class OccurrenceModal extends SuggestModal<string> {
			private choices = getTimeEntryOccurrenceChoices(task, reference);

			getSuggestions(query: string): string[] {
				const date = query.trim();
				if (isTimeEntryOccurrence(task, date)) return [date];
				return this.choices.filter((choice) => choice.includes(date)).slice(0, 100);
			}

			renderSuggestion(date: string, el: HTMLElement): void {
				el.setText(date);
			}

			onChooseSuggestion(date: string): void {
				resolve(date);
			}

			onClose(): void {
				super.onClose();
				// Obsidian closes before calling onChooseSuggestion.
				window.setTimeout(() => resolve(null), 0);
			}
		}
		const modal = new OccurrenceModal(app);
		modal.setPlaceholder(
			plugin.i18n.translate(
				msg({
					message:
						"Choose occurrence (YYYY-MM-DD), or fix the task's recurrence if no dates are available",
					context: "modals.timeEntryOccurrence.placeholder",
				})
			)
		);
		modal.setInstructions([
			{
				command: "Esc",
				purpose: plugin.i18n.translate(
					msg({
						message: "Cancel without saving",
						context: "modals.timeEntryOccurrence.cancel",
					})
				),
			},
		]);
		modal.open();
	});
}
