jest.mock("rrule", () => jest.requireActual("rrule/dist/es5/rrule.js"));

import { parse } from "yaml";
import {
	getShownOccurrence,
	getTimeEntryOccurrence,
	stampTimeEntryOccurrences,
	allocateTimeEntry,
	getTimeEntryOccurrenceChoices,
} from "../../../src/core/recurrence";
import { normalizeTaskUpdateInput } from "../../../src/services/task-service/taskUpdatePlanning";
import { generateBasesFileTemplate } from "../../../src/templates/defaultBasesFiles";
import type { TaskInfo, TimeEntry } from "../../../src/types";
import { calculateTotalTimeSpent, getActiveTimeEntry } from "../../../src/utils/helpers";

// Every week on Monday, 300 minutes each week.
function weeklyTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
	return {
		title: "Personal time",
		status: "open",
		priority: "normal",
		path: "TaskNotes/Personal time.md",
		archived: false,
		recurrence: "DTSTART:20260105;FREQ=WEEKLY;BYDAY=MO",
		scheduled: "2026-02-02",
		timeEstimate: 300,
		...overrides,
	} as TaskInfo;
}

describe("time entry occurrences", () => {
	it("an entry counts toward the occurrence whose period contains its start", () => {
		const task = weeklyTask();
		expect(getTimeEntryOccurrence(task, "2026-02-04")).toBe("2026-02-02");
		expect(getTimeEntryOccurrence(task, "2026-02-02")).toBe("2026-02-02");
		expect(getTimeEntryOccurrence(task, "2026-02-09")).toBe("2026-02-09");
		// Noon UTC is the same local day in every UTC-12..+11 time zone.
		expect(getTimeEntryOccurrence(task, "2026-02-08T12:00:00Z")).toBe("2026-02-02");
	});

	it("an 'after completion' rule counts time toward the occurrence it shows", () => {
		const task = weeklyTask({ recurrence_anchor: "completion", scheduled: "2026-02-03T09:00" });
		expect(getTimeEntryOccurrence(task, "2026-02-20")).toBe("2026-02-03");
		expect(
			getTimeEntryOccurrence({ ...task, recurrence_original_date: "2026-02-01" }, "2026-02-20")
		).toBe("2026-02-01");
	});

	it("a task that does not recur has no occurrence", () => {
		expect(getTimeEntryOccurrence(weeklyTask({ recurrence: undefined }), "2026-02-04")).toBeNull();
	});

	it("stamping fills in missing occurrences and keeps recorded ones", () => {
		const entries: TimeEntry[] = [
			{ startTime: "2026-02-04", endTime: "2026-02-04", minutes: 60 },
			{ startTime: "2026-02-10", endTime: "2026-02-10", minutes: 30, occurrence: "2026-02-02" },
		];
		expect(stampTimeEntryOccurrences(weeklyTask(), entries).map((e) => e.occurrence)).toEqual([
			"2026-02-02",
			"2026-02-02",
		]);
		expect(stampTimeEntryOccurrences(weeklyTask({ recurrence: undefined }), entries)).toBe(entries);
	});

	it("progress is for the occurrence the task shows", () => {
		expect(getShownOccurrence(weeklyTask())).toBe("2026-02-02");
		expect(getShownOccurrence(weeklyTask({ recurrence_original_date: "2026-01-26" }))).toBe("2026-01-26");
		expect(getShownOccurrence(weeklyTask({ recurrence: undefined }))).toBeNull();
	});

	it("an entry moved to another week keeps its allocation unless explicitly changed", () => {
		const timeEntries: TimeEntry[] = [
			{ startTime: "2026-02-03T09:00:00Z", endTime: "2026-02-03T10:00:00Z", occurrence: "2026-02-02" },
		];
		const task = weeklyTask({ timeEntries });
		const moved = {
			...timeEntries[0],
			startTime: "2026-02-10T09:00:00Z",
			endTime: "2026-02-10T10:00:00Z",
		};
		expect(
			normalizeTaskUpdateInput({ timeEntries: [moved] }, task).timeEntries?.[0].occurrence
		).toBe("2026-02-02");
		const explicit = { ...moved, occurrence: "2026-01-26" };
		expect(
			normalizeTaskUpdateInput({ timeEntries: [explicit] }, task).timeEntries?.[0].occurrence
		).toBe("2026-01-26");
	});

	it("rejects new unallocatable entries without mutating the input", () => {
		const entry = { startTime: "2025-12-01" };
		expect(() => allocateTimeEntry(weeklyTask(), entry)).toThrow(/occurrence/i);
		expect(entry).toEqual({ startTime: "2025-12-01" });
		expect(() => normalizeTaskUpdateInput({ timeEntries: [entry] }, weeklyTask())).toThrow(
			/occurrence/i
		);
	});

	it("validates explicit allocations independently of the clock date", () => {
		expect(
			allocateTimeEntry(weeklyTask(), { startTime: "2025-12-01", occurrence: "2026-02-02" })
				.occurrence
		).toBe("2026-02-02");
		for (const occurrence of ["2026-02-03", "2026-02-30", "not-a-date", "2025-12-29"]) {
			expect(() =>
				allocateTimeEntry(weeklyTask(), { startTime: "2026-02-04", occurrence })
			).toThrow(/occurrence/i);
		}
	});

	it("keeps legacy allocations and unassigned time when appending or removing entries", () => {
		const legacy = { startTime: "2025-12-01", endTime: "2025-12-01", minutes: 30 };
		const old = {
			startTime: "2026-02-04",
			endTime: "2026-02-04",
			minutes: 45,
			occurrence: "2026-02-03",
		};
		const task = weeklyTask({ timeEntries: [legacy, old] });
		const added = { startTime: "2026-02-11", endTime: "2026-02-11", minutes: 20 };
		expect(
			normalizeTaskUpdateInput({ timeEntries: [legacy, old, added] }, task).timeEntries
		).toEqual([legacy, old, { ...added, occurrence: "2026-02-09" }]);
		expect(normalizeTaskUpdateInput({ timeEntries: [old] }, task).timeEntries).toEqual([old]);
		expect(normalizeTaskUpdateInput({ title: "Renamed" }, task).timeEntries).toBeUndefined();
		expect(() =>
			normalizeTaskUpdateInput({ timeEntries: [{ ...old, occurrence: "2026-02-10" }] }, task)
		).toThrow(/occurrence/i);
	});

	it("keeps historical allocations through combined clock edits, additions, and deletions", () => {
		const legacy = { startTime: "2026-02-04", endTime: "2026-02-04", minutes: 20 };
		const old = { ...legacy, occurrence: "2026-02-03" };
		const removed = { ...legacy, startTime: "2026-02-06", occurrence: "2026-01-26" };
		const movedLegacy = { ...legacy, startTime: "2026-02-05", endTime: "2026-02-05" };
		const movedOld = { ...old, startTime: "2026-02-12", endTime: "2026-02-12" };
		const added = {
			...legacy,
			startTime: "2026-02-11",
			endTime: "2026-02-11",
			occurrence: "2026-02-09",
		};
		const task = weeklyTask({ timeEntries: [legacy, old, removed] });
		expect(
			normalizeTaskUpdateInput({ timeEntries: [movedLegacy, movedOld, added] }, task)
				.timeEntries
		).toEqual([movedLegacy, movedOld, added]);
		expect(
			normalizeTaskUpdateInput({ timeEntries: [movedLegacy, movedOld] }, task).timeEntries
		).toEqual([movedLegacy, movedOld]);
	});

	it("reserves unchanged rows before matching clock edits and rejects extra historical allocations", () => {
		const legacy = { startTime: "2025-12-01", endTime: "2025-12-01", minutes: 20 };
		const added = { ...legacy, startTime: "2026-02-04", endTime: "2026-02-04" };
		expect(
			normalizeTaskUpdateInput(
				{ timeEntries: [added, legacy] },
				weeklyTask({ timeEntries: [legacy] })
			).timeEntries
		).toEqual([{ ...added, occurrence: "2026-02-02" }, legacy]);
		const old = { ...legacy, occurrence: "2026-02-03" };
		expect(() =>
			normalizeTaskUpdateInput(
				{ timeEntries: [old, { ...old, startTime: "2026-03-01" }] },
				weeklyTask({ timeEntries: [old] })
			)
		).toThrow(/occurrence/i);
	});

	it("accepts completion history and shown dates, not invented completion dates", () => {
		const task = weeklyTask({
			recurrence_anchor: "completion",
			scheduled: "2026-02-03",
			complete_instances: ["2026-01-28"],
			skipped_instances: ["2026-01-20"],
		});
		for (const occurrence of ["2026-02-03", "2026-01-28", "2026-01-20"]) {
			expect(
				allocateTimeEntry(task, { startTime: "2026-02-04", occurrence }).occurrence
			).toBe(occurrence);
		}
		expect(() =>
			allocateTimeEntry(task, { startTime: "2026-02-04", occurrence: "2026-02-02" })
		).toThrow(/occurrence/i);
		expect(getTimeEntryOccurrenceChoices(task, "2026-02-04")).toEqual(
			expect.arrayContaining(["2026-02-03", "2026-01-28", "2026-01-20"])
		);
	});

	it("provides future choices before the first occurrence and guards period anchors too", () => {
		expect(getTimeEntryOccurrenceChoices(weeklyTask(), "2025-12-01")).toContain("2026-01-05");
		expect(
			allocateTimeEntry(weeklyTask({ recurrence_anchor: "period" }), {
				startTime: "2026-02-04",
			}).occurrence
		).toBe("2026-02-02");
		expect(
			allocateTimeEntry(weeklyTask({ recurrence: undefined }), { startTime: "2025-12-01" })
		).toEqual({ startTime: "2025-12-01" });
	});

	it("a length without clock times is dropped once start and end differ", () => {
		const resized = { startTime: "2026-02-04T00:00", endTime: "2026-02-04T01:30", minutes: 60 };
		expect(normalizeTaskUpdateInput({ timeEntries: [resized] }).timeEntries?.[0].minutes).toBeUndefined();
	});

	it("task updates stamp time entries on recurring tasks", () => {
		const updates = normalizeTaskUpdateInput(
			{ timeEntries: [{ startTime: "2026-02-11", endTime: "2026-02-11", minutes: 45 }] },
			weeklyTask()
		);
		expect(updates.timeEntries?.[0].occurrence).toBe("2026-02-09");
	});
});

describe("time entries logged without clock times", () => {
	const entries: TimeEntry[] = [
		{ startTime: "2026-02-04T09:00:00Z", endTime: "2026-02-04T10:00:00Z" },
		{ startTime: "2026-02-05", endTime: "2026-02-05", minutes: 45 },
	];

	it("count their minutes toward the total", () => {
		expect(calculateTotalTimeSpent(entries)).toBe(105);
	});

	it("are not running timers", () => {
		expect(getActiveTimeEntry(entries)).toBeNull();
	});
});

describe("default Bases time formulas", () => {
	const fieldMapping = {
		status: "status",
		scheduled: "scheduled",
		recurrence: "recurrence",
		timeEstimate: "timeEstimate",
		timeEntries: "timeEntries",
	};
	const plugin = {
		settings: {
			taskTag: "task",
			taskIdentificationMethod: "tag",
			customPriorities: [{ value: "normal", label: "Normal", weight: 1 }],
			customStatuses: [{ value: "done", label: "Done", isCompleted: true }],
			defaultVisibleProperties: ["status"],
			calendarViewSettings: { firstDay: 1 },
			userFields: [],
			fieldMapping,
		},
		fieldMapper: {
			toUserField: (key: string) =>
				(fieldMapping as Record<string, string>)[key] ??
				(key === "recurrenceOriginalDate" ? "recurrence_original_date" : key),
			getMapping: () => fieldMapping,
		},
	};
	const formulas = parse(generateBasesFileTemplate("open-tasks-view", plugin as any)).formulas;

	it("count the current occurrence against a recurring task's estimate", () => {
		expect(formulas.currentOccurrence).toContain("recurrence_original_date");
		expect(formulas.timeTrackedThisOccurrence).toContain("value.occurrence");
		expect(formulas.timeRemaining).toContain("formula.currentOccurrence");
		expect(formulas.efficiencyRatio).toContain("formula.currentOccurrence");
	});

	it("count entries logged without clock times", () => {
		for (const name of ["timeRemaining", "timeTrackedThisWeek", "timeTrackedToday", "timeTrackedFormatted"]) {
			expect(formulas[name]).toContain("value.minutes");
		}
	});
});
