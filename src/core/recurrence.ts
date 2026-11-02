export * from "@tasknotes/model/recurrence";
export type { TaskInfo } from "../types";

import {
	addDTSTARTToRecurrenceRule as addDTSTARTToRecurrenceRuleModel,
	addDTSTARTToRecurrenceRuleWithDraggedTime as addDTSTARTToRecurrenceRuleWithDraggedTimeModel,
	getNextUncompletedOccurrence as getNextUncompletedOccurrenceModel,
	updateToNextScheduledOccurrence as updateToNextScheduledOccurrenceModel,
} from "@tasknotes/model/recurrence";
import { addDaysToDateString, getDatePart, getTodayString } from "../utils/dateUtils";

type AddDTSTARTTaskInput = Parameters<typeof addDTSTARTToRecurrenceRuleModel>[0];
type AddDTSTARTWithDraggedTimeTaskInput = Parameters<
	typeof addDTSTARTToRecurrenceRuleWithDraggedTimeModel
>[0];
type RecurringTaskInput = Parameters<typeof getNextUncompletedOccurrenceModel>[0];
type RecurrenceUpdateTaskInput = Parameters<typeof updateToNextScheduledOccurrenceModel>[0];
type RecurrenceUpdateResult = ReturnType<typeof updateToNextScheduledOccurrenceModel>;

export interface RecurrenceOccurrenceOptions {
	minOccurrenceDate?: string;
}

interface RecurrenceWindowInput {
	recurrence_window?: number | "month_end";
}

export function addDTSTARTToRecurrenceRule(task: AddDTSTARTTaskInput): string | null {
	return addDTSTARTToRecurrenceRuleModel(normalizeMinutePrecisionDateInputs(task));
}

export function addDTSTARTToRecurrenceRuleWithDraggedTime(
	task: AddDTSTARTWithDraggedTimeTaskInput,
	draggedStart: Date,
	allDay: boolean
): string | null {
	return addDTSTARTToRecurrenceRuleWithDraggedTimeModel(
		normalizeMinutePrecisionDateInputs(task),
		draggedStart,
		allDay
	);
}

export function getNextUncompletedOccurrence(
	task: RecurringTaskInput & RecurrenceWindowInput,
	options?: RecurrenceOccurrenceOptions
): Date | null {
	return getNextUncompletedOccurrenceModel(task, {
		today: options?.minOccurrenceDate ?? getOpenOccurrenceFloor(task),
	});
}

export function updateToNextScheduledOccurrence(
	task: RecurrenceUpdateTaskInput & RecurrenceWindowInput,
	maintainDueOffset = true,
	options?: RecurrenceOccurrenceOptions
): RecurrenceUpdateResult {
	const next = updateToNextScheduledOccurrenceModel(task, maintainDueOffset, {
		today: options?.minOccurrenceDate ?? getOpenOccurrenceFloor(task),
	});
	const windowEnd = next.scheduled ? getWindowEnd(task, getDatePart(next.scheduled)) : null;
	if (!windowEnd) return next;

	// The window sets each occurrence's due date, so moving an occurrence inside its
	// window, or a scheduled-to-due gap that differs from the window, does not carry over.
	const dueTime = task.due ? task.due.slice(getDatePart(task.due).length) : "";
	return { ...next, due: windowEnd + dueTime };
}

/** Last open day (YYYY-MM-DD) of the occurrence on `date`, or null without a window. */
function getWindowEnd(task: RecurrenceWindowInput, date: string): string | null {
	const window = task.recurrence_window;
	if (window === "month_end") {
		const [year, month] = date.split("-").map(Number);
		return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
	}
	return typeof window === "number" && Number.isInteger(window) && window > 1
		? addDaysToDateString(date, window - 1)
		: null;
}

/** The earliest occurrence date whose window is still open on `today`. */
export function getOpenOccurrenceFloor(
	task: RecurrenceWindowInput,
	today = getTodayString()
): string {
	const window = task.recurrence_window;
	if (window === "month_end") return `${today.slice(0, 8)}01`;
	return typeof window === "number" && Number.isInteger(window) && window > 1
		? addDaysToDateString(today, 1 - window)
		: today;
}

function normalizeMinutePrecisionDateInputs<T extends { scheduled?: string; dateCreated?: string }>(
	task: T
): T {
	const scheduled = normalizeMinutePrecisionDateTime(task.scheduled);
	const dateCreated = normalizeMinutePrecisionDateTime(task.dateCreated);

	if (scheduled === task.scheduled && dateCreated === task.dateCreated) {
		return task;
	}

	return {
		...task,
		scheduled,
		dateCreated,
	};
}

function normalizeMinutePrecisionDateTime(value: string | undefined): string | undefined {
	if (!value) return value;

	const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})?$/);

	if (!match) {
		return value;
	}

	const [, date, time, zone = ""] = match;
	return `${date}T${time}:00${zone}`;
}
