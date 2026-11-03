import {
	fromVaultDate,
	getVaultTimeZone,
	setVaultTimeZone,
	shiftWallClock,
	toVaultDate,
	vaultNow,
} from "../../../src/utils/vaultTime";

// Jest pins the device zone to UTC (jest.config.js).
describe("vaultTime", () => {
	afterEach(() => {
		setVaultTimeZone(null);
		jest.useRealTimers();
	});

	it("is the identity with no vault zone", () => {
		setVaultTimeZone("");
		const moment = new Date("2026-11-03T01:20:08.123Z");
		expect(getVaultTimeZone()).toBe("UTC");
		expect(toVaultDate(moment).getTime()).toBe(moment.getTime());
		expect(fromVaultDate(moment).getTime()).toBe(moment.getTime());
	});

	it("ignores an invalid zone", () => {
		setVaultTimeZone("Not/AZone");
		expect(getVaultTimeZone()).toBe("UTC");
	});

	it("reads a moment as vault wall-clock time and back", () => {
		setVaultTimeZone("Australia/Sydney");
		const moment = new Date("2026-11-03T01:20:08.123Z"); // 12:20:08 in Sydney (AEDT, +11)
		const wall = toVaultDate(moment);
		expect([
			wall.getDate(),
			wall.getHours(),
			wall.getMinutes(),
			wall.getSeconds(),
			wall.getMilliseconds(),
		]).toEqual([3, 12, 20, 8, 123]);
		expect(fromVaultDate(wall).toISOString()).toBe(moment.toISOString());
	});

	it("reads a string without a zone as vault wall-clock time", () => {
		setVaultTimeZone("America/New_York");
		const wall = toVaultDate("2026-11-03T00:00");
		expect([wall.getDate(), wall.getHours()]).toEqual([3, 0]);
	});

	it("handles wall-clock times around a vault daylight-saving change", () => {
		setVaultTimeZone("America/New_York");
		// 2026-11-01 01:30 happens twice in New York; the earlier (EDT) moment wins.
		expect(fromVaultDate(new Date(2026, 10, 1, 1, 30)).toISOString()).toBe(
			"2026-11-01T05:30:00.000Z"
		);
		// 2026-03-08 02:30 does not exist in New York; it resolves to a moment an hour later.
		expect(fromVaultDate(new Date(2026, 2, 8, 2, 30)).toISOString()).toBe(
			"2026-03-08T07:30:00.000Z"
		);
	});

	it("shifts a stored wall-clock value to the same moment in another zone", () => {
		expect(shiftWallClock("2026-11-03T09:00", "Australia/Sydney", "Europe/London")).toBe(
			"2026-11-02T22:00"
		);
		expect(shiftWallClock("2026-11-02T22:00:30", "Europe/London", "Australia/Sydney")).toBe(
			"2026-11-03T09:00:30"
		);
		expect(shiftWallClock("2026-11-03", "Australia/Sydney", "UTC")).toBe("2026-11-03");
		expect(shiftWallClock("2026-11-03T09:00Z", "Australia/Sydney", "UTC")).toBe(
			"2026-11-03T09:00Z"
		);
	});

	it("gives now as vault wall-clock time", () => {
		jest.useFakeTimers().setSystemTime(new Date("2026-11-02T20:00:00Z"));
		setVaultTimeZone("Australia/Sydney");
		const now = vaultNow();
		expect([now.getDate(), now.getHours()]).toEqual([3, 7]);
	});
});
