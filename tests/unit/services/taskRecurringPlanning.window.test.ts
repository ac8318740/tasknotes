import {
	getNextUncompletedOccurrence,
	updateToNextScheduledOccurrence,
} from "../../../src/core/recurrence";
import { mapTaskFromFrontmatter, mapTaskToFrontmatter } from "../../../src/core/fieldMapping";
import { DEFAULT_FIELD_MAPPING } from "../../../src/core/defaultFieldMapping";
import {
	buildRecurringTaskCompletePlan,
	buildRecurringTaskSkippedPlan,
	getRecurringTaskActionDate,
} from "../../../src/services/task-service/taskRecurringPlanning";
import type { TaskInfo } from "../../../src/types";
import { getTodayString } from "../../../src/utils/dateUtils";

jest.mock("../../../src/utils/dateUtils", () => ({
	...jest.requireActual("../../../src/utils/dateUtils"),
	getTodayString: jest.fn(),
}));

const mockGetTodayString = getTodayString as jest.MockedFunction<typeof getTodayString>;

// Every month on the 15th, open from the 15th to the 22nd (8 days).
function monthlyTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
	return {
		title: "Monthly report",
		status: "open",
		priority: "normal",
		path: "TaskNotes/Monthly report.md",
		archived: false,
		recurrence: "DTSTART:20261015;FREQ=MONTHLY;BYMONTHDAY=15",
		recurrence_window: 8,
		scheduled: "2026-11-15",
		due: "2026-11-22",
		complete_instances: ["2026-10-15"],
		skipped_instances: [],
		...overrides,
	} as TaskInfo;
}

function utc(date: string): Date {
	return new Date(`${date}T00:00:00.000Z`);
}

const planInput = { currentTimestamp: "2026-11-18T10:00:00Z", maintainDueDateOffsetInRecurring: false };

function complete(task: TaskInfo, targetDate = getRecurringTaskActionDate(task)) {
	return buildRecurringTaskCompletePlan({ freshTask: task, targetDate, ...planInput });
}

function skip(task: TaskInfo, targetDate = getRecurringTaskActionDate(task)) {
	return buildRecurringTaskSkippedPlan({ freshTask: task, targetDate, ...planInput });
}

describe("recurrence_window (an occurrence stays open for a number of days)", () => {
	beforeEach(() => {
		mockGetTodayString.mockReturnValue("2026-11-18");
	});

	it("a completion inside the window credits that window's occurrence", () => {
		const plan = complete(monthlyTask(), utc("2026-11-18"));

		expect(plan.dateStr).toBe("2026-11-15");
		expect(plan.updatedTask.scheduled).toBe("2026-12-15");
		expect(plan.updatedTask.due).toBe("2026-12-22");
	});

	it("an occurrence whose window is still open stays next after an older one is handled", () => {
		const plan = skip(monthlyTask({ complete_instances: [], scheduled: "2026-10-15", due: undefined }));

		expect(plan.dateStr).toBe("2026-10-15");
		expect(plan.updatedTask.scheduled).toBe("2026-11-15");
		expect(plan.updatedTask.due).toBe("2026-11-22");
	});

	it("the window, not a moved scheduled date, sets the next due date", () => {
		const plan = complete(
			monthlyTask({ scheduled: "2026-11-19", recurrence_original_date: "2026-11-15" })
		);

		expect(plan.dateStr).toBe("2026-11-15");
		expect(plan.updatedTask.scheduled).toBe("2026-12-15");
		expect(plan.updatedTask.due).toBe("2026-12-22");
	});

	it("an occurrence is next until its last open day, then the following one is", () => {
		const task = monthlyTask();
		const next = () => getNextUncompletedOccurrence(task)?.toISOString().slice(0, 10);

		mockGetTodayString.mockReturnValue("2026-11-22");
		expect(next()).toBe("2026-11-15");
		mockGetTodayString.mockReturnValue("2026-11-23");
		expect(next()).toBe("2026-12-15");
	});

	it("keeps the due time and spans the same days in a shorter month", () => {
		mockGetTodayString.mockReturnValue("2027-01-20");
		const plan = complete(
			monthlyTask({
				scheduled: "2027-01-15",
				due: "2027-01-22T17:00",
				complete_instances: [],
			})
		);

		expect(plan.updatedTask.scheduled).toBe("2027-02-15");
		expect(plan.updatedTask.due).toBe("2027-02-22T17:00");
	});

	it("a one-day or missing window leaves due dates to the existing offset rules", () => {
		for (const recurrence_window of [1, undefined]) {
			const next = updateToNextScheduledOccurrence(
				monthlyTask({ recurrence_window, scheduled: "2026-11-15", due: undefined }),
				false,
				{ minOccurrenceDate: "2026-11-16" }
			);
			expect(next).toEqual({ scheduled: "2026-12-15", due: null });
		}
	});

	it("reads and writes recurrence_window through the field mapping", () => {
		const read = (value: unknown, mapping = DEFAULT_FIELD_MAPPING, key = "recurrence_window") =>
			mapTaskFromFrontmatter(mapping, { title: "T", [key]: value }, "T.md").recurrence_window;

		expect(read(8)).toBe(8);
		expect(read("month_end")).toBe("month_end");
		expect(read("monthEnd")).toBeUndefined();
		expect(read("8")).toBeUndefined();
		expect(read(0)).toBeUndefined();
		expect(read(2.5)).toBeUndefined();
		expect(read(8, { ...DEFAULT_FIELD_MAPPING, recurrenceWindow: "open_days" }, "open_days")).toBe(8);

		const legacy = { ...DEFAULT_FIELD_MAPPING };
		delete legacy.recurrenceWindow;
		expect(mapTaskToFrontmatter(legacy, { recurrence_window: 8 }).recurrence_window).toBe(8);
	});

	describe("month_end (open until the last day of the occurrence's month)", () => {
		const monthEnd = (overrides: Partial<TaskInfo> = {}) =>
			monthlyTask({ recurrence_window: "month_end", due: "2026-11-30", ...overrides });

		it("sets due to the last day of each month, including February", () => {
			mockGetTodayString.mockReturnValue("2027-01-20");
			const plan = complete(
				monthEnd({ scheduled: "2027-01-15", due: "2027-01-31", complete_instances: [] })
			);

			expect(plan.dateStr).toBe("2027-01-15");
			expect(plan.updatedTask.scheduled).toBe("2027-02-15");
			expect(plan.updatedTask.due).toBe("2027-02-28");
		});

		it("an occurrence is next until its month ends", () => {
			const task = monthEnd();
			const next = () => getNextUncompletedOccurrence(task)?.toISOString().slice(0, 10);

			mockGetTodayString.mockReturnValue("2026-11-30");
			expect(next()).toBe("2026-11-15");
			mockGetTodayString.mockReturnValue("2026-12-01");
			expect(next()).toBe("2026-12-15");
		});

		it("skipping a missed occurrence late in the month keeps this month's open", () => {
			mockGetTodayString.mockReturnValue("2026-11-28");
			const plan = skip(monthEnd({ complete_instances: [], scheduled: "2026-10-15", due: undefined }));

			expect(plan.updatedTask.scheduled).toBe("2026-11-15");
			expect(plan.updatedTask.due).toBe("2026-11-30");
		});

		it("a weekly occurrence stays open until the end of its own month", () => {
			mockGetTodayString.mockReturnValue("2026-11-24");
			const next = updateToNextScheduledOccurrence(
				monthEnd({ recurrence: "DTSTART:20261102;FREQ=WEEKLY", scheduled: "2026-11-23" }),
				false,
				{ minOccurrenceDate: "2026-11-24" }
			);

			expect(next).toEqual({ scheduled: "2026-11-30", due: "2026-11-30" });
		});
	});
});
