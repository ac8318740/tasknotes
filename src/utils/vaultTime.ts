/**
 * Vault timezone.
 *
 * TaskNotes treats every local Date (one built with `new Date(y, m, d, h, min)` or read with
 * getHours/getDate, date-fns `format`, and so on) as wall-clock time in the vault timezone,
 * not in the device timezone. Code that turns a real moment into a local Date uses
 * `toVaultDate`, and code that turns a local Date back into a real moment uses
 * `fromVaultDate`. With no vault timezone set, both are identity functions.
 */

let vaultZone: string | null = null;
let partsFormatter: Intl.DateTimeFormat | null = null;

export function getDeviceTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Every IANA zone this platform knows, for pickers. */
export function supportedTimeZones(): string[] {
	const intl = Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] };
	return intl.supportedValuesOf?.("timeZone") ?? [getDeviceTimeZone()];
}

export function isValidTimeZone(zone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}

/** Set the vault timezone. Blank, invalid or equal to the device zone means "use the device zone". */
export function setVaultTimeZone(zone: string | undefined | null): void {
	const trimmed = zone?.trim() ?? "";
	vaultZone =
		trimmed && isValidTimeZone(trimmed) && trimmed !== getDeviceTimeZone() ? trimmed : null;
	partsFormatter = vaultZone ? zoneFormatter(vaultZone) : null;
}

/** The IANA zone TaskNotes uses: the vault setting, or the device zone. */
export function getVaultTimeZone(): string {
	return vaultZone ?? getDeviceTimeZone();
}

function zoneFormatter(zone: string): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		second: "numeric",
		hourCycle: "h23",
	});
}

function wallClockParts(ms: number, formatter: Intl.DateTimeFormat): number[] {
	const parts: Record<string, number> = {};
	for (const { type, value } of formatter.formatToParts(ms)) parts[type] = Number(value);
	return [parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second];
}

/** Offset of `zone` from UTC at the moment `ms`, in milliseconds. */
export function timeZoneOffsetMs(ms: number, zone: string = getVaultTimeZone()): number {
	const [y, mo, d, h, mi, s] = wallClockParts(
		ms,
		zone === vaultZone && partsFormatter ? partsFormatter : zoneFormatter(zone)
	);
	return Date.UTC(y, mo, d, h, mi, s) - (ms - (((ms % 1000) + 1000) % 1000));
}

/**
 * The real moment `moment` as a local Date whose fields read as vault wall-clock time.
 * A string without Z or an offset is already vault wall-clock time and is read as is.
 */
export function toVaultDate(moment: Date | number | string): Date {
	if (typeof moment === "string" && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(moment.trim()))
		return new Date(moment);
	const ms = new Date(moment).getTime();
	if (!vaultZone || !Number.isFinite(ms)) return new Date(ms);
	const [y, mo, d, h, mi, s] = wallClockParts(ms, partsFormatter as Intl.DateTimeFormat);
	// shortcut: a vault wall-clock time inside a device daylight-saving gap reads one hour late; rare, revisit if reported.
	return new Date(y, mo, d, h, mi, s, ((ms % 1000) + 1000) % 1000);
}

/** The local Date `wallClock` (read as vault wall-clock time) as a real moment. */
export function fromVaultDate(wallClock: Date): Date {
	if (!vaultZone || !Number.isFinite(wallClock.getTime())) return new Date(wallClock.getTime());
	const fields = [
		wallClock.getFullYear(),
		wallClock.getMonth(),
		wallClock.getDate(),
		wallClock.getHours(),
		wallClock.getMinutes(),
		wallClock.getSeconds(),
	];
	return new Date(zoneWallClockToMs(fields, vaultZone) + wallClock.getMilliseconds());
}

/** The real moment of the wall-clock fields `y..s` in `zone`; the earlier one when they occur twice. */
function zoneWallClockToMs(fields: number[], zone: string): number {
	const [y, mo, d, h, mi, s] = fields;
	const asUtc = Date.UTC(y, mo, d, h, mi, s);
	// Try the offsets either side of the guess so wall-clock times next to a DST change resolve.
	const first = asUtc - timeZoneOffsetMs(asUtc, zone);
	const second = asUtc - timeZoneOffsetMs(first, zone);
	const matching = [first, second].filter((ms) => asUtc - timeZoneOffsetMs(ms, zone) === ms);
	return matching.length ? Math.min(...matching) : Math.max(first, second);
}

/**
 * Rewrite a stored wall-clock value ("YYYY-MM-DDTHH:mm" with optional seconds) written in zone `from`
 * so it names the same moment in zone `to`. Anything else (date-only, with Z or an offset) is returned as is.
 */
export function shiftWallClock(value: string, from: string, to: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:\d{2})?$/.exec(value);
	if (!match || from === to) return value;
	const [, y, mo, d, h, mi, sec] = match;
	const ms = zoneWallClockToMs([+y, +mo - 1, +d, +h, +mi, sec ? +sec.slice(1) : 0], from);
	const [ny, nmo, nd, nh, nmi, ns] = wallClockParts(ms, zoneFormatter(to));
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${ny}-${pad(nmo + 1)}-${pad(nd)}T${pad(nh)}:${pad(nmi)}${sec ? `:${pad(ns)}` : ""}`;
}

/** Now, as vault wall-clock time. Use instead of `new Date()` wherever local fields are read. */
export function vaultNow(): Date {
	return toVaultDate(Date.now());
}
