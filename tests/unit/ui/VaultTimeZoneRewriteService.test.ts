import { shiftTaskFrontmatter, shiftTimeblocks } from "../../../src/ui/VaultTimeZoneRewriteService";
import type { TimeBlock } from "../../../src/types";

const fields = {
	due: "due",
	scheduled: "scheduled",
	recurrence: "recurrence",
	reminders: "reminders",
};
const SYDNEY = "Australia/Sydney"; // +11 in November
const LONDON = "Europe/London"; // +0 in November

describe("shiftTaskFrontmatter", () => {
	it("keeps the moment of timed values and leaves dates alone", () => {
		const fm: Record<string, unknown> = {
			due: "2026-11-03T09:00",
			scheduled: "2026-11-04",
			reminders: [
				{ id: "a", type: "absolute", absoluteTime: "2026-11-03T08:30:00" },
				{ id: "r", type: "relative", relatedTo: "due", offset: "-PT15M" },
			],
		};
		expect(shiftTaskFrontmatter(fm, fields, SYDNEY, LONDON)).toBe(true);
		expect(fm.due).toBe("2026-11-02T22:00");
		expect(fm.scheduled).toBe("2026-11-04");
		expect((fm.reminders as Array<Record<string, unknown>>)[0].absoluteTime).toBe(
			"2026-11-02T21:30:00"
		);
		expect((fm.reminders as Array<Record<string, unknown>>)[1]).toEqual({
			id: "r",
			type: "relative",
			relatedTo: "due",
			offset: "-PT15M",
		});
	});

	it("keeps the clock time of recurring tasks", () => {
		const fm: Record<string, unknown> = { due: "2026-11-03T09:00", recurrence: "FREQ=DAILY" };
		expect(shiftTaskFrontmatter(fm, fields, SYDNEY, LONDON)).toBe(false);
		expect(fm.due).toBe("2026-11-03T09:00");
	});

	it("leaves values with an explicit offset alone", () => {
		const fm: Record<string, unknown> = { due: "2026-11-03T09:00:00+11:00" };
		expect(shiftTaskFrontmatter(fm, fields, SYDNEY, LONDON)).toBe(false);
	});
});

describe("shiftTimeblocks", () => {
	const block = (id: string, startTime: string, endTime: string): TimeBlock =>
		({ id, title: id, startTime, endTime }) as TimeBlock;

	it("shifts blocks and moves ones whose start crosses midnight", () => {
		const { stay, moved } = shiftTimeblocks(
			"2026-11-03",
			[block("late", "14:00", "15:00"), block("early", "09:00", "10:00")],
			SYDNEY,
			LONDON
		);
		expect(stay).toEqual([block("late", "03:00", "04:00")]);
		expect(moved).toEqual([{ date: "2026-11-02", block: block("early", "22:00", "23:00") }]);
	});

	it("keeps a block that comes to span midnight on its start day", () => {
		const { stay, moved } = shiftTimeblocks(
			"2026-11-03",
			[block("span", "10:30", "11:30")],
			SYDNEY,
			LONDON
		);
		expect(moved).toEqual([{ date: "2026-11-02", block: block("span", "23:30", "00:30") }]);
		expect(stay).toEqual([]);
	});
});
