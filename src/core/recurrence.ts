export * from "@tasknotes/model/recurrence";
export type { TaskInfo } from "../types";

import {
	addDTSTARTToRecurrenceRule as addDTSTARTToRecurrenceRuleModel,
	addDTSTARTToRecurrenceRuleWithDraggedTime as addDTSTARTToRecurrenceRuleWithDraggedTimeModel,
	generateRecurringInstances,
	getNextUncompletedOccurrence as getNextUncompletedOccurrenceModel,
	updateToNextScheduledOccurrence as updateToNextScheduledOccurrenceModel,
} from "@tasknotes/model/recurrence";
import { format } from "date-fns";
import {
	addDaysToDateString,
	formatDateForStorage,
	getDatePart,
	getTodayString,
	parseDateToUTC,
} from "../utils/dateUtils";
import { toVaultDate } from "../utils/vaultTime";

type AddDTSTARTTaskInput = Parameters<typeof addDTSTARTToRecurrenceRuleModel>[0];
type AddDTSTARTWithDraggedTimeTaskInput = Parameters<
	typeof addDTSTARTToRecurrenceRuleWithDraggedTimeModel
>[0];
type RecurringTaskInput = Parameters<typeof getNextUncompletedOccurrenceModel>[0];
type RecurrenceUpdateTaskInput = Parameters<typeof updateToNextScheduledOccurrenceModel>[0];
type PeriodTaskInput = Parameters<typeof generateRecurringInstances>[0];
type RecurrenceUpdateResult = ReturnType<typeof updateToNextScheduledOccurrenceModel>;

export interface RecurrenceOccurrenceOptions {
	minOccurrenceDate?: string;
}

type TimeEntryOccurrenceTask = PeriodTaskInput & {
	recurrence_anchor?: string;
	recurrence_original_date?: string;
};

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
	return getNextUncompletedOccurrenceModel(task, { today: getOccurrenceFloor(task, options) });
}

export function updateToNextScheduledOccurrence(
	task: RecurrenceUpdateTaskInput & RecurrenceWindowInput,
	maintainDueOffset = true,
	options?: RecurrenceOccurrenceOptions
): RecurrenceUpdateResult {
	const next = updateToNextScheduledOccurrenceModel(task, maintainDueOffset, {
		today: getOccurrenceFloor(task, options),
	});
	if (isPeriodAnchor(task)) return withPeriodDue(task, next);
	const windowEnd = next.scheduled ? getWindowEnd(task, getDatePart(next.scheduled)) : null;
	if (!windowEnd) return next;

	// The window sets each occurrence's due date, so moving an occurrence inside its
	// window, or a scheduled-to-due gap that differs from the window, does not carry over.
	const dueTime = task.due ? task.due.slice(getDatePart(task.due).length) : "";
	return { ...next, due: windowEnd + dueTime };
}

function withPeriodDue(task: PeriodTaskInput, next: RecurrenceUpdateResult): RecurrenceUpdateResult {
	if (!next.scheduled || !next.due) return next;

	// A period's due date is its last day, which a fixed offset misses for months.
	const periodEnd = getRecurrencePeriodEnd(task, parseDateToUTC(getDatePart(next.scheduled)));
	if (!periodEnd) return next;
	return {
		...next,
		due: formatDateForStorage(periodEnd) + next.due.slice(getDatePart(next.due).length),
	};
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

export function getRecurrenceSearchDays(recurrence: string): number {
	const intervalMatch = recurrence.match(/(?:^|;)INTERVAL=(\d+)(?:;|$)/);
	const interval = intervalMatch ? Number.parseInt(intervalMatch[1], 10) : 1;

	if (recurrence.includes("FREQ=DAILY")) return Math.max(30, interval * 2);
	if (recurrence.includes("FREQ=WEEKLY")) return Math.max(90, interval * 7 * 2);
	if (recurrence.includes("FREQ=MONTHLY")) return Math.max(400, interval * 31 * 2);
	if (recurrence.includes("FREQ=YEARLY")) return Math.max(800, interval * 366 * 2);
	return 365;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Plugin-only anchor: one occurrence per period, done on any day in it. The model
 * does not list it yet and reads it as "scheduled", so older readers see a fixed rule.
 */
export function isPeriodAnchor(task: { recurrence_anchor?: string }): boolean {
	return task.recurrence_anchor === "period";
}

/**
 * With recurrence_anchor "period", each rule occurrence opens a period that runs
 * until the next occurrence. Returns the occurrence whose period contains `date`.
 */
export function getRecurrencePeriodStart(task: PeriodTaskInput, date: Date): Date | null {
	if (!task.recurrence) return null;
	const lookBack = new Date(date.getTime() - getRecurrenceSearchDays(task.recurrence) * DAY_MS);
	return generateRecurringInstances(task, lookBack, date).pop() ?? null;
}

/** Last day of the period opened by `periodStart`. */
export function getRecurrencePeriodEnd(task: PeriodTaskInput, periodStart: Date): Date | null {
	if (!task.recurrence) return null;
	const searchDays = getRecurrenceSearchDays(task.recurrence);
	const nextStart = generateRecurringInstances(
		task,
		new Date(periodStart.getTime() + DAY_MS),
		new Date(periodStart.getTime() + searchDays * DAY_MS)
	)[0];
	return nextStart ? parseDateToUTC(formatDateForStorage(new Date(nextStart.getTime() - DAY_MS))) : null;
}

/**
 * The period a plain "complete" or "skip" acts on: the shown occurrence's period,
 * or today's period once the shown one has passed (missed periods stay missed).
 */
export function getPeriodActionDate(task: PeriodTaskInput): Date {
	const today = getTodayString();
	const scheduled = task.scheduled ? getDatePart(task.scheduled) : today;
	const target = parseDateToUTC(scheduled > today ? scheduled : today);
	return getRecurrencePeriodStart(task, target) ?? target;
}

/**
 * The occurrence (its rule date, YYYY-MM-DD) that time logged at `timestamp` counts toward:
 * the shown occurrence for "after completion" rules, else the one whose period contains it.
 * Null for a task that does not recur or a time before its first occurrence.
 */
export function getTimeEntryOccurrence(
	task: TimeEntryOccurrenceTask,
	timestamp: string
): string | null {
	if (!task.recurrence) return null;
	if (task.recurrence_anchor === "completion") return getShownOccurrence(task);
	// A date-only value is already a local day; a timestamp is read in local time.
	const day = /^\d{4}-\d{2}-\d{2}$/.test(timestamp)
		? timestamp
		: format(toVaultDate(timestamp), "yyyy-MM-dd");
	const periodStart = getRecurrencePeriodStart(task, parseDateToUTC(day));
	return periodStart ? formatDateForStorage(periodStart) : null;
}

/**
 * Rule date (YYYY-MM-DD) of the occurrence a recurring task shows: the original date of a
 * moved occurrence, else its scheduled date. Progress on cards and in Bases is for this one.
 */
export function getShownOccurrence(task: TimeEntryOccurrenceTask): string | null {
	if (!task.recurrence) return null;
	const shown = task.recurrence_original_date ?? task.scheduled;
	return shown ? getDatePart(shown) : null;
}

/**
 * The occurrence of an entry whose start moved: derived again from the new start, except that
 * "after completion" rules keep the one recorded, since every new start maps to the shown one.
 */
export function getMovedTimeEntryOccurrence(
	task: TimeEntryOccurrenceTask,
	entry: { startTime: string; occurrence?: string }
): string | undefined {
	if (task.recurrence_anchor === "completion" && entry.occurrence) return entry.occurrence;
	return getTimeEntryOccurrence(task, entry.startTime) ?? undefined;
}

/** Fills in `occurrence` on a recurring task's entries that lack one; other entries are unchanged. */
export function stampTimeEntryOccurrences<T extends { startTime: string; occurrence?: string }>(
	task: TimeEntryOccurrenceTask,
	entries: T[]
): T[] {
	if (!task.recurrence) return entries;
	return entries.map((entry) => {
		if (entry.occurrence || !entry.startTime) return entry;
		const occurrence = getTimeEntryOccurrence(task, entry.startTime);
		return occurrence ? { ...entry, occurrence } : entry;
	});
}

function getOccurrenceFloor(
	task: RecurringTaskInput & RecurrenceWindowInput,
	options?: RecurrenceOccurrenceOptions
): string {
	const floor = options?.minOccurrenceDate ?? getOpenOccurrenceFloor(task);
	if (!isPeriodAnchor(task)) return floor;
	// The period containing the floor is still open, so its start stays eligible.
	const periodStart = getRecurrencePeriodStart(task, parseDateToUTC(floor));
	return periodStart ? formatDateForStorage(periodStart) : floor;
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
