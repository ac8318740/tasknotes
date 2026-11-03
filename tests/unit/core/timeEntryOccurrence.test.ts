import { parse } from "yaml";
import {
	getShownOccurrence,
	getTimeEntryOccurrence,
	stampTimeEntryOccurrences,
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

	it("an entry moved to another week follows it, unless the caller set its occurrence", () => {
		const timeEntries: TimeEntry[] = [
			{ startTime: "2026-02-03T09:00:00Z", endTime: "2026-02-03T10:00:00Z", occurrence: "2026-02-02" },
		];
		const task = weeklyTask({ timeEntries });
		const moved = { ...timeEntries[0], startTime: "2026-02-10T09:00:00Z", endTime: "2026-02-10T10:00:00Z" };
		expect(normalizeTaskUpdateInput({ timeEntries: [moved] }, task).timeEntries?.[0].occurrence).toBe("2026-02-09");
		const explicit = { ...moved, occurrence: "2026-01-26" };
		expect(normalizeTaskUpdateInput({ timeEntries: [explicit] }, task).timeEntries?.[0].occurrence).toBe("2026-01-26");
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
