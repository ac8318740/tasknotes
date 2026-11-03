/**
 * Vault time zone at the edges: calendar events coming in, tasks going out,
 * and API date filters. Jest runs in UTC, so a Sydney vault zone (UTC+10 in June)
 * shows whether each boundary uses the vault zone rather than the device zone.
 */
import { CalendarExportService } from "../../../src/services/CalendarExportService";
import { ICSNoteService } from "../../../src/services/ICSNoteService";
import { dateAddRuntimeValue } from "../../../src/api/TaskNotesAPI";
import { setVaultTimeZone } from "../../../src/utils/vaultTime";
import { ICSEvent, TaskInfo } from "../../../src/types";
import { PluginFactory } from "../../helpers/mock-factories";

describe("vault time zone boundaries", () => {
	beforeEach(() => setVaultTimeZone("Australia/Sydney"));
	afterEach(() => setVaultTimeZone(""));

	it("reads an incoming calendar moment in the vault zone", () => {
		const service = new ICSNoteService(PluginFactory.createMockPlugin({}));
		const event = {
			id: "e1",
			subscriptionId: "s1",
			title: "Standup",
			start: "2030-06-25T23:00:00.000Z",
			end: "2030-06-26T00:00:00.000Z",
			allDay: false,
		} as ICSEvent;

		// shortcut: reaches a private helper, keep in step if it is renamed
		const scheduled = (
			service as unknown as { computeScheduledFromICSEvent(e: ICSEvent): string }
		).computeScheduledFromICSEvent(event);

		expect(scheduled).toBe("2030-06-26T09:00");
	});

	it("exports a vault wall-clock task time as the real moment", () => {
		const task = {
			title: "Call",
			path: "tasks/call.md",
			scheduled: "2030-06-26T09:00",
			status: "todo",
		} as TaskInfo;

		const ics = CalendarExportService.generateICSContent(task);

		expect(ics).toContain("DTSTART:20300625T230000Z");
	});

	it("adds days to an API date in the vault calendar", () => {
		expect(
			dateAddRuntimeValue({ fn: "dateAdd", value: "2030-06-25T20:00:00Z", amount: 1, unit: "day" })
		).toBe("2030-06-27");
		expect(dateAddRuntimeValue({ fn: "dateAdd", value: "2030-06-25", amount: 1, unit: "day" })).toBe(
			"2030-06-26"
		);
	});
});
