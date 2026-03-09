import { RRule } from "rrule";
import { TaskInfo, UnifiedTimeEntry } from "../types";
import { generateTimeEntryId } from "../utils/helpers";

/**
 * Creates a UTC date from a YYYY-MM-DD string for use with RRule.
 */
function createUTCDateForRRule(dateStr: string): Date {
	const parts = dateStr.split("-");
	return new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
}

/**
 * Parse an RRULE string and return an RRule instance.
 * Handles DTSTART extraction, falls back to task.next_scheduled or task.dateCreated.
 */
function parseRRule(task: TaskInfo): RRule | null {
	if (!task.recurrence || typeof task.recurrence !== "string") return null;

	try {
		let dtstart: Date;
		const dtstartMatch = task.recurrence.match(/DTSTART:(\d{8}(?:T\d{6}Z?)?)/);

		if (dtstartMatch) {
			const dtstartStr = dtstartMatch[1];
			if (dtstartStr.length === 8) {
				const year = parseInt(dtstartStr.slice(0, 4));
				const month = parseInt(dtstartStr.slice(4, 6)) - 1;
				const day = parseInt(dtstartStr.slice(6, 8));
				dtstart = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
			} else {
				const year = parseInt(dtstartStr.slice(0, 4));
				const month = parseInt(dtstartStr.slice(4, 6)) - 1;
				const day = parseInt(dtstartStr.slice(6, 8));
				const hour = parseInt(dtstartStr.slice(9, 11)) || 0;
				const minute = parseInt(dtstartStr.slice(11, 13)) || 0;
				const second = parseInt(dtstartStr.slice(13, 15)) || 0;
				dtstart = new Date(Date.UTC(year, month, day, hour, minute, second, 0));
			}
		} else if (task.next_scheduled) {
			dtstart = createUTCDateForRRule(task.next_scheduled.substring(0, 10));
		} else if (task.dateCreated) {
			dtstart = createUTCDateForRRule(task.dateCreated.substring(0, 10));
		} else {
			return null;
		}

		const rruleString = task.recurrence.replace(/DTSTART:[^;]+;?/, "");
		const rruleOptions = RRule.parseString(rruleString);
		rruleOptions.dtstart = dtstart;

		return new RRule(rruleOptions);
	} catch (error) {
		console.error("Error parsing RRULE:", error, { recurrence: task.recurrence });
		return null;
	}
}

/**
 * Format a UTC Date from RRule as a YYYY-MM-DD string.
 */
function formatDateStr(date: Date): string {
	const y = date.getUTCFullYear();
	const m = String(date.getUTCMonth() + 1).padStart(2, "0");
	const d = String(date.getUTCDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/**
 * Check if a date string (YYYY-MM-DD) already has a time entry on that day.
 */
function hasEntryOnDate(entries: UnifiedTimeEntry[], dateStr: string): boolean {
	return entries.some((e) => e.startTime.substring(0, 10) === dateStr);
}

/**
 * Service that generates planned time entries from RRULE recurrence patterns.
 * Produces materialized entries so that all scheduling goes through time entries.
 */
export class RecurrenceEntryService {

	/**
	 * Generate planned time entries from a task's RRULE for a given window.
	 * Returns only NEW entries (does not include existing entries).
	 */
	generatePlannedEntries(task: TaskInfo, windowMonths: number = 3): UnifiedTimeEntry[] {
		const rrule = parseRRule(task);
		if (!rrule) return [];

		const now = new Date();
		const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
		const end = new Date(start);
		end.setUTCMonth(end.getUTCMonth() + windowMonths);

		const instances = rrule.between(start, end, true);
		const existingEntries = task.timeEntries || [];
		const newEntries: UnifiedTimeEntry[] = [];

		for (const instanceDate of instances) {
			const dateStr = formatDateStr(instanceDate);

			// Skip if there's already an entry on this date
			if (hasEntryOnDate(existingEntries, dateStr)) continue;

			const entry: UnifiedTimeEntry = {
				id: generateTimeEntryId(),
				type: "planned",
				fromRecurrence: true,
				startTime: dateStr,
			};

			// Compute endTime from timeEstimate if available
			if (task.timeEstimate && task.timeEstimate > 0) {
				const startMs = new Date(dateStr + "T09:00:00").getTime();
				const endMs = startMs + task.timeEstimate * 60 * 1000;
				const endDate = new Date(endMs);
				entry.startTime = dateStr + "T09:00:00";
				entry.endTime = dateStr + "T" +
					String(endDate.getHours()).padStart(2, "0") + ":" +
					String(endDate.getMinutes()).padStart(2, "0") + ":00";
			}

			newEntries.push(entry);
		}

		return newEntries;
	}

	/**
	 * Maintain the rolling window — extend if needed, prune old entries.
	 * Returns updated entries array, or null if no changes were needed.
	 */
	maintainWindow(task: TaskInfo, windowMonths: number = 3): UnifiedTimeEntry[] | null {
		const entries = [...(task.timeEntries || [])];
		const now = new Date();
		let changed = false;

		// Find furthest future fromRecurrence planned entry
		let furthestDate: Date | null = null;
		for (const e of entries) {
			if (e.type === "planned" && e.fromRecurrence) {
				const d = new Date(e.startTime);
				if (!furthestDate || d > furthestDate) {
					furthestDate = d;
				}
			}
		}

		// If the furthest entry is less than (windowMonths - 1) months ahead, generate more
		const thresholdDate = new Date(now);
		thresholdDate.setMonth(thresholdDate.getMonth() + windowMonths - 1);

		if (!furthestDate || furthestDate < thresholdDate) {
			const newEntries = this.generatePlannedEntries(
				{ ...task, timeEntries: entries },
				windowMonths
			);
			if (newEntries.length > 0) {
				entries.push(...newEntries);
				changed = true;
			}
		}

		// Prune: remove fromRecurrence planned entries older than 1 month
		const pruneDate = new Date(now);
		pruneDate.setMonth(pruneDate.getMonth() - 1);
		const pruneDateStr = formatDateStr(pruneDate);

		const beforeCount = entries.length;
		const filtered = entries.filter((e) => {
			if (e.type === "planned" && e.fromRecurrence && e.startTime.substring(0, 10) < pruneDateStr) {
				return false; // Remove old fromRecurrence planned entries
			}
			return true;
		});

		if (filtered.length !== beforeCount) {
			changed = true;
		}

		return changed ? filtered : null;
	}

	/**
	 * Regenerate entries when recurrence rule changes.
	 * Removes future fromRecurrence planned entries, keeps manual and logged entries.
	 * Returns updated entries array.
	 */
	regenerateEntries(task: TaskInfo, windowMonths: number = 3): UnifiedTimeEntry[] {
		const now = new Date();
		const nowDateStr = formatDateStr(now);

		// Keep: logged entries, manual planned entries, past fromRecurrence entries
		const kept = (task.timeEntries || []).filter((e) => {
			if (e.type === "logged") return true;
			if (e.type === "planned" && !e.fromRecurrence) return true;
			if (e.type === "planned" && e.fromRecurrence && e.startTime.substring(0, 10) < nowDateStr) return true;
			return false;
		});

		// Generate new entries from updated RRULE
		const newEntries = this.generatePlannedEntries(
			{ ...task, timeEntries: kept },
			windowMonths
		);

		return [...kept, ...newEntries];
	}

	/**
	 * Convert the planned entry closest to the given date to logged.
	 * Returns updated entries array.
	 */
	convertCompletionToLogged(task: TaskInfo, date: Date): UnifiedTimeEntry[] {
		const entries = [...(task.timeEntries || [])];
		const targetDateStr = formatDateStr(date);

		// Find the planned entry closest to the date with fromRecurrence: true
		let bestIdx = -1;
		let bestDelta = Infinity;

		for (let i = 0; i < entries.length; i++) {
			const e = entries[i];
			if (e.type === "planned" && e.fromRecurrence) {
				const entryDateStr = e.startTime.substring(0, 10);
				const delta = Math.abs(
					new Date(entryDateStr).getTime() - new Date(targetDateStr).getTime()
				);
				if (delta < bestDelta) {
					bestDelta = delta;
					bestIdx = i;
				}
			}
		}

		if (bestIdx !== -1) {
			entries[bestIdx] = { ...entries[bestIdx], type: "logged" };
		}

		return entries;
	}
}
