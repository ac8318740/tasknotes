import { Notice, TFile } from "obsidian";
import { msg } from "@lingui/core/macro";
import type TaskNotesPlugin from "../main";
import type { TimeBlock } from "../types";
import { uiText } from "../i18n/runtime";
import { addTimeblockToDailyNote } from "../utils/helpers";
import { createTaskNotesLogger } from "../utils/tasknotesLogger";
import { getVaultTimeZone, setVaultTimeZone, shiftWallClock } from "../utils/vaultTime";
import {
	processVaultFrontMatterWithinMutation,
	setBeforeVaultFileMutation,
	withVaultFileMutation,
} from "../services/VaultMutationService";

const tasknotesLogger = createTaskNotesLogger({ tag: "Services/VaultTimeZoneRewrite" });
const BATCH_SIZE = 50;
const BATCH_PAUSE_MS = 200;
const DEVICE_ID_KEY = "tasknotes-device-id";

export interface TaskTimeFields {
	due: string;
	scheduled: string;
	recurrence: string;
	reminders: string;
}

const isWallClockTime = (value: unknown): value is string =>
	typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value);

/**
 * Rewrite a task's timed values so they keep their moment: due and scheduled on a
 * non-recurring task, and absolute reminders. Date-only values and recurring tasks
 * (which keep their clock time) are left alone. Returns whether anything changed.
 */
export function shiftTaskFrontmatter(
	frontmatter: Record<string, unknown>,
	fields: TaskTimeFields,
	from: string,
	to: string
): boolean {
	let changed = false;
	const shift = (record: Record<string, unknown>, key: string) => {
		const value = record[key];
		if (!isWallClockTime(value)) return;
		const shifted = shiftWallClock(value, from, to);
		if (shifted !== value) {
			record[key] = shifted;
			changed = true;
		}
	};
	if (!frontmatter[fields.recurrence]) {
		shift(frontmatter, fields.due);
		shift(frontmatter, fields.scheduled);
	}
	const reminders = frontmatter[fields.reminders];
	if (Array.isArray(reminders)) {
		for (const reminder of reminders) {
			if (
				reminder &&
				typeof reminder === "object" &&
				(reminder as { type?: unknown }).type === "absolute"
			) {
				shift(reminder as Record<string, unknown>, "absoluteTime");
			}
		}
	}
	return changed;
}

/**
 * Rewrite the timeblocks of the daily note for `date` so each keeps its moment. A block
 * whose start crosses midnight belongs to another day and is returned in `moved`.
 */
export function shiftTimeblocks(
	date: string,
	blocks: TimeBlock[],
	from: string,
	to: string
): { stay: TimeBlock[]; moved: Array<{ date: string; block: TimeBlock }> } {
	const stay: TimeBlock[] = [];
	const moved: Array<{ date: string; block: TimeBlock }> = [];
	for (const block of blocks) {
		if (
			!/^\d{2}:\d{2}$/.test(block?.startTime ?? "") ||
			!/^\d{2}:\d{2}$/.test(block?.endTime ?? "")
		) {
			stay.push(block);
			continue;
		}
		const [newDate, startTime] = shiftWallClock(`${date}T${block.startTime}`, from, to).split(
			"T"
		);
		const endTime = shiftWallClock(`${date}T${block.endTime}`, from, to).split("T")[1];
		const shifted = { ...block, startTime, endTime };
		if (newDate === date) stay.push(shifted);
		else moved.push({ date: newDate, block: shifted });
	}
	return { stay, moved };
}

/**
 * After the vault timezone changes, rewrites stored wall-clock times so every task,
 * reminder and timeblock keeps its moment. Only the device that changed the setting
 * rewrites; the pending list survives restarts in the plugin settings.
 */
export class VaultTimeZoneRewriteService {
	private pending = new Set<string>();
	private inProgress = new Set<string>();
	private dailyNoteDates = new Map<string, string>();
	private running = false;

	constructor(private plugin: TaskNotesPlugin) {
		setBeforeVaultFileMutation((file) => this.rewriteFile(file));
	}

	destroy(): void {
		setBeforeVaultFileMutation(null);
	}

	/** Whether this vault still has files waiting to be rewritten. */
	isRewriting(): boolean {
		return this.running || !!this.plugin.settings.vaultTimeZoneRewrite?.pending.length;
	}

	/** Change the vault timezone and rewrite stored times. `zone` "" means the device zone. */
	async changeTimeZone(zone: string): Promise<boolean> {
		if (this.isRewriting()) {
			new Notice(
				uiText(
					msg({
						message:
							"TaskNotes is still updating times for the last time zone change. Try again when it finishes.",
						context: "services.vaultTimeZone.busy",
					})
				)
			);
			return false;
		}
		const from = getVaultTimeZone();
		this.plugin.settings.vaultTimeZone = zone;
		setVaultTimeZone(zone);
		const to = getVaultTimeZone();
		if (from !== to) {
			await this.loadDailyNoteDates();
			const pending = this.collectFiles();
			if (pending.length) {
				this.plugin.settings.vaultTimeZoneRewrite = {
					from,
					to,
					deviceId: this.deviceId(),
					pending,
				};
			}
		}
		await this.plugin.saveSettings();
		this.plugin.notifyDataChanged();
		this.plugin.emitter.trigger("settings-changed", this.plugin.settings);
		void this.resume();
		return true;
	}

	/** Continue an unfinished rewrite started on this device. */
	async resume(): Promise<void> {
		const rewrite = this.plugin.settings.vaultTimeZoneRewrite;
		if (this.running || !rewrite || rewrite.deviceId !== this.deviceId()) return;
		this.running = true;
		this.pending = new Set(rewrite.pending);
		await this.loadDailyNoteDates();
		const total = this.pending.size;
		const progress = (done: number) =>
			uiText(
				msg({
					message: "Updating times for the new time zone: {done} of {total} notes",
					context: "services.vaultTimeZone.progress",
				}),
				{ done, total }
			);
		const notice = new Notice(progress(0), 0);
		try {
			while (this.pending.size) {
				notice.setMessage(progress(total - this.pending.size));
				for (const path of [...this.pending].slice(0, BATCH_SIZE)) {
					const file = this.plugin.app.vault.getAbstractFileByPath(path);
					if (file instanceof TFile) await withVaultFileMutation(file, async () => {});
					this.pending.delete(path);
				}
				rewrite.pending = [...this.pending];
				await this.plugin.saveSettingsDataOnly();
				await sleep(BATCH_PAUSE_MS);
			}
			if (this.plugin.settings.vaultTimeZoneRewrite === rewrite) {
				this.plugin.settings.vaultTimeZoneRewrite = undefined;
				await this.plugin.saveSettingsDataOnly();
			}
			notice.setMessage(
				uiText(
					msg({
						message: "Times updated for the new time zone.",
						context: "services.vaultTimeZone.done",
					})
				)
			);
			window.setTimeout(() => notice.hide(), 4000);
		} finally {
			this.running = false;
		}
	}

	private deviceId(): string {
		const app = this.plugin.app;
		let id = app.loadLocalStorage(DEVICE_ID_KEY) as string | null;
		if (!id) {
			id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
			app.saveLocalStorage(DEVICE_ID_KEY, id);
		}
		return id;
	}

	private fields(): TaskTimeFields {
		const mapper = this.plugin.fieldMapper;
		return {
			due: mapper.toUserField("due"),
			scheduled: mapper.toUserField("scheduled"),
			recurrence: mapper.toUserField("recurrence"),
			reminders: mapper.toUserField("reminders"),
		};
	}

	private async loadDailyNoteDates(): Promise<void> {
		this.dailyNoteDates.clear();
		try {
			const { getAllDailyNotes } = await import("obsidian-daily-notes-interface");
			for (const [uid, file] of Object.entries(getAllDailyNotes())) {
				// Keys look like "day-2026-11-03T00:00:00+11:00"; the date is the first ten characters after "day-".
				if (uid.startsWith("day-")) this.dailyNoteDates.set(file.path, uid.slice(4, 14));
			}
		} catch {
			// Daily notes plugin not enabled: there are no timeblocks to move.
		}
	}

	/** Paths of task notes and daily notes holding a time that would move. */
	private collectFiles(): string[] {
		const { metadataCache } = this.plugin.app;
		const fields = this.fields();
		const paths = new Set([
			...this.plugin.cacheManager.getAllTaskPaths(),
			...this.dailyNoteDates.keys(),
		]);
		return [...paths].filter((path) => {
			const frontmatter = metadataCache.getCache(path)?.frontmatter;
			if (!frontmatter) return false;
			const probe = structuredClone(frontmatter) as Record<string, unknown>;
			const timeblocks = probe.timeblocks;
			return (
				shiftTaskFrontmatter(probe, fields, "UTC", "Etc/GMT-1") ||
				(this.dailyNoteDates.has(path) &&
					Array.isArray(timeblocks) &&
					timeblocks.length > 0)
			);
		});
	}

	/** Rewrite one pending file. Runs inside the file's mutation queue, before any other change to it. */
	private async rewriteFile(file: TFile): Promise<void> {
		const rewrite = this.plugin.settings.vaultTimeZoneRewrite;
		if (!rewrite || !this.pending.has(file.path) || this.inProgress.has(file.path)) return;
		this.inProgress.add(file.path);
		try {
			const { from, to } = rewrite;
			const date = this.dailyNoteDates.get(file.path);
			let moved: Array<{ date: string; block: TimeBlock }> = [];
			await processVaultFrontMatterWithinMutation(
				this.plugin.app,
				file,
				(frontmatter: Record<string, unknown>) => {
					shiftTaskFrontmatter(frontmatter, this.fields(), from, to);
					if (date && Array.isArray(frontmatter.timeblocks)) {
						const result = shiftTimeblocks(
							date,
							frontmatter.timeblocks as TimeBlock[],
							from,
							to
						);
						frontmatter.timeblocks = result.stay;
						moved = result.moved;
					}
				}
			);
			// Done before moving blocks, so a block moved back into this note is not shifted twice.
			this.pending.delete(file.path);
			for (const { date: target, block } of moved) {
				const targetPath = [...this.dailyNoteDates].find(([, d]) => d === target)?.[0];
				const targetFile =
					targetPath && this.plugin.app.vault.getAbstractFileByPath(targetPath);
				if (targetFile instanceof TFile) await this.rewriteFile(targetFile);
				await addTimeblockToDailyNote(this.plugin.app, target, block);
			}
		} catch (error) {
			// Leave the file as it is rather than block the change that triggered this.
			this.pending.delete(file.path);
			tasknotesLogger.error("Failed to update times for the vault timezone:", {
				category: "configuration",
				operation: "rewrite-vault-timezone",
				details: { path: file.path },
				error,
			});
		} finally {
			this.inProgress.delete(file.path);
		}
	}
}
