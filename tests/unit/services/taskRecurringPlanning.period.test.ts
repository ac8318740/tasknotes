import {
	getRecurrencePeriodStart,
	updateToNextScheduledOccurrence,
} from "../../../src/core/recurrence";
import { mapTaskFromFrontmatter } from "../../../src/core/fieldMapping";
import { DEFAULT_FIELD_MAPPING } from "../../../src/core/defaultFieldMapping";
import {
	buildRecurrenceOptions,
	type BuildRecurrenceOptionsInput,
} from "../../../src/components/RecurrenceContextMenu";
import {
	buildRecurringTaskCompletePlan,
	buildRecurringTaskSkippedPlan,
	getRecurringTaskActionDate,
} from "../../../src/services/task-service/taskRecurringPlanning";
import type { TaskInfo } from "../../../src/types";
import { getDefaultTaskCardTargetDate } from "../../../src/ui/taskCardState";
import { getTodayString } from "../../../src/utils/dateUtils";

jest.mock("../../../src/utils/dateUtils", () => ({
	...jest.requireActual("../../../src/utils/dateUtils"),
	getTodayString: jest.fn(),
}));

const mockGetTodayString = getTodayString as jest.MockedFunction<typeof getTodayString>;

// 2026-11-02 is a Monday.
function weeklyTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
	return {
		title: "Call Mom",
		status: "open",
		priority: "normal",
		path: "TaskNotes/Call Mom.md",
		archived: false,
		recurrence: "DTSTART:20261102;FREQ=WEEKLY",
		recurrence_anchor: "period",
		scheduled: "2026-11-02",
		due: "2026-11-08",
		complete_instances: [],
		skipped_instances: [],
		...overrides,
	} as TaskInfo;
}

function monthlyTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
	return weeklyTask({
		recurrence: "DTSTART:20261101;FREQ=MONTHLY",
		scheduled: "2026-11-01",
		due: "2026-11-30",
		...overrides,
	});
}

function utc(date: string): Date {
	return new Date(`${date}T00:00:00.000Z`);
}

function complete(task: TaskInfo, targetDate = getRecurringTaskActionDate(task)) {
	return buildRecurringTaskCompletePlan({
		freshTask: task,
		targetDate,
		currentTimestamp: "2026-11-04T10:00:00Z",
		maintainDueDateOffsetInRecurring: true,
	});
}

describe("recurrence_anchor: period (one occurrence per period, any day)", () => {
	beforeEach(() => {
		mockGetTodayString.mockReturnValue("2026-11-04");
	});

	it("maps every day of a period to the occurrence that opens it", () => {
		const task = weeklyTask();
		const start = (date: string) =>
			getRecurrencePeriodStart(task, utc(date))?.toISOString().slice(0, 10);

		expect(start("2026-11-02")).toBe("2026-11-02");
		expect(start("2026-11-04")).toBe("2026-11-02");
		expect(start("2026-11-08")).toBe("2026-11-02");
		expect(start("2026-11-09")).toBe("2026-11-09");
		expect(start("2026-11-01")).toBeUndefined();
	});

	it("records a mid-period completion under the period start and shows the next period", () => {
		const plan = complete(weeklyTask());

		expect(plan.dateStr).toBe("2026-11-02");
		expect(plan.updatedTask.complete_instances).toEqual(["2026-11-02"]);
		expect(plan.updatedTask.scheduled).toBe("2026-11-09");
		expect(plan.updatedTask.due).toBe("2026-11-15");
	});

	it("uncompleting reopens the current period", () => {
		const plan = complete(
			weeklyTask({ complete_instances: ["2026-11-02"], scheduled: "2026-11-09", due: "2026-11-15" }),
			utc("2026-11-04")
		);

		expect(plan.newComplete).toBe(false);
		expect(plan.updatedTask.complete_instances).toEqual([]);
		expect(plan.updatedTask.scheduled).toBe("2026-11-02");
		expect(plan.updatedTask.due).toBe("2026-11-08");
	});

	it("completing early from the card acts on the shown future period, not the done one", () => {
		const task = weeklyTask({
			complete_instances: ["2026-11-02"],
			scheduled: "2026-11-09",
			due: "2026-11-15",
		});

		const plan = complete(task);

		expect(plan.newComplete).toBe(true);
		expect(plan.updatedTask.complete_instances).toEqual(["2026-11-02", "2026-11-09"]);
		expect(plan.updatedTask.scheduled).toBe("2026-11-16");
	});

	it("rolls over: a missed period is left behind and the action counts for the current one", () => {
		mockGetTodayString.mockReturnValue("2026-11-11");
		const task = weeklyTask();

		expect(updateToNextScheduledOccurrence(task)).toEqual({
			scheduled: "2026-11-09",
			due: "2026-11-15",
		});

		const plan = complete(task);
		expect(plan.dateStr).toBe("2026-11-09");
		expect(plan.updatedTask.complete_instances).toEqual(["2026-11-09"]);
		expect(plan.updatedTask.scheduled).toBe("2026-11-16");
		expect(plan.updatedTask.due).toBe("2026-11-22");
	});

	it("does not credit a missed earlier period when the current one is already done", () => {
		mockGetTodayString.mockReturnValue("2026-11-11");
		const plan = complete(
			weeklyTask({ complete_instances: ["2026-11-09"], scheduled: "2026-11-16", due: "2026-11-22" }),
			utc("2026-11-11")
		);

		expect(plan.newComplete).toBe(false);
		expect(plan.dateStr).toBe("2026-11-09");
	});

	it("points the task card at the period it would act on", () => {
		const day = (task: TaskInfo) =>
			getDefaultTaskCardTargetDate(task).toISOString().slice(0, 10);

		expect(day(weeklyTask())).toBe("2026-11-02");
		mockGetTodayString.mockReturnValue("2026-11-11");
		expect(day(weeklyTask())).toBe("2026-11-09");
		expect(day(weeklyTask({ scheduled: "2026-11-16" }))).toBe("2026-11-16");
	});

	it("skips the current period", () => {
		mockGetTodayString.mockReturnValue("2026-11-11");
		const task = weeklyTask();

		const plan = buildRecurringTaskSkippedPlan({
			freshTask: task,
			targetDate: getRecurringTaskActionDate(task),
			currentTimestamp: "2026-11-11T10:00:00Z",
			maintainDueDateOffsetInRecurring: true,
		});

		expect(plan.dateStr).toBe("2026-11-09");
		expect(plan.updatedTask.skipped_instances).toEqual(["2026-11-09"]);
		expect(plan.updatedTask.scheduled).toBe("2026-11-16");
	});

	it("uses calendar months and keeps due on the last day of each month", () => {
		mockGetTodayString.mockReturnValue("2026-11-18");
		const november = complete(monthlyTask());
		expect(november.dateStr).toBe("2026-11-01");
		expect(november.updatedTask.scheduled).toBe("2026-12-01");
		expect(november.updatedTask.due).toBe("2026-12-31");

		mockGetTodayString.mockReturnValue("2027-01-20");
		const january = complete(monthlyTask({ scheduled: "2027-01-01", due: "2027-01-31" }));
		expect(january.dateStr).toBe("2027-01-01");
		expect(january.updatedTask.scheduled).toBe("2027-02-01");
		expect(january.updatedTask.due).toBe("2027-02-28");
	});

	it("keeps the period anchor when reading frontmatter", () => {
		const task = mapTaskFromFrontmatter(
			DEFAULT_FIELD_MAPPING,
			{ title: "Call Mom", recurrence: "DTSTART:20261102;FREQ=WEEKLY", recurrence_anchor: "period" },
			"TaskNotes/Call Mom.md"
		);

		expect(task.recurrence_anchor).toBe("period");
	});

	it("starts the any-day weekly preset on the configured first day of the week", () => {
		const translate: BuildRecurrenceOptionsInput["translate"] = (key) => String(key);
		const anyDay = (firstDay: number) =>
			buildRecurrenceOptions({ scheduledDate: "2026-11-04", firstDay, translate }).filter(
				(option) => option.anchor === "period"
			);

		expect(anyDay(1).map((option) => option.value)).toEqual([
			"DTSTART:20261102;FREQ=WEEKLY",
			"DTSTART:20261101;FREQ=MONTHLY",
		]);
		expect(anyDay(0)[0].value).toBe("DTSTART:20261101;FREQ=WEEKLY");
	});
});
