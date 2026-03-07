import { TFile } from "obsidian";
import type TaskNotesPlugin from "../main";
import { UnifiedTimeEntry, TaskInfo } from "../types";
import { mapToDailyNoteTimeEntry, mapToUnifiedTimeEntry } from "./TimeMigrationService";
import { getActiveTimeEntry } from "../utils/helpers";

export class TimeEntryStorageService {
	constructor(private plugin: TaskNotesPlugin) {}

	/** Extract date portion (YYYY-MM-DD) from startTime (handles both "2026-03-07" and "2026-03-07T09:00:00+11:00") */
	private dateForEntry(entry: UnifiedTimeEntry): string {
		return entry.startTime.slice(0, 10);
	}

	/** Get or create a daily note for a given date string (YYYY-MM-DD) */
	private async getOrCreateDailyNote(date: string): Promise<TFile> {
		const { getDailyNote, getAllDailyNotes, createDailyNote } = await import("obsidian-daily-notes-interface");
		const moment = (window as any).moment(date);
		const allDailyNotes = getAllDailyNotes();
		let dailyNote = getDailyNote(moment, allDailyNotes);
		if (!dailyNote) {
			dailyNote = await createDailyNote(moment);
		}
		if (!dailyNote) {
			throw new Error(`Failed to create daily note for ${date}`);
		}
		return dailyNote;
	}

	/** Write (add or update) a single entry to the correct storage */
	async writeEntry(task: TaskInfo, entry: UnifiedTimeEntry, mode: "add" | "update"): Promise<void> {
		if (this.plugin.settings.timeEntriesStorage === "task") {
			// Write to task file
			const file = this.plugin.app.vault.getAbstractFileByPath(task.path);
			if (!(file instanceof TFile)) throw new Error(`Cannot find task file: ${task.path}`);
			const timeEntriesField = this.plugin.fieldMapper.toUserField("timeEntries");
			await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
				if (!fm[timeEntriesField]) fm[timeEntriesField] = [];
				if (mode === "add") {
					fm[timeEntriesField].push(entry);
				} else {
					const idx = fm[timeEntriesField].findIndex((e: any) => e.id === entry.id);
					if (idx !== -1) {
						fm[timeEntriesField][idx] = entry;
					} else {
						fm[timeEntriesField].push(entry);
					}
				}
			});
		} else {
			// Write to daily note
			const date = this.dateForEntry(entry);
			const dailyNote = await this.getOrCreateDailyNote(date);
			const dailyEntry = mapToDailyNoteTimeEntry(entry, task.path);
			await this.plugin.app.fileManager.processFrontMatter(dailyNote, (fm) => {
				if (!fm.timeEntries) fm.timeEntries = [];
				if (mode === "add") {
					fm.timeEntries.push(dailyEntry);
				} else {
					const idx = fm.timeEntries.findIndex((e: any) => e.id === entry.id);
					if (idx !== -1) {
						fm.timeEntries[idx] = dailyEntry;
					} else {
						fm.timeEntries.push(dailyEntry);
					}
				}
			});
		}
		await this.updateDenormalizedScheduled(task, undefined);
	}

	/** Delete an entry by ID from the correct storage */
	async deleteEntry(task: TaskInfo, entryId: string): Promise<void> {
		const timeEntriesField = this.plugin.fieldMapper.toUserField("timeEntries");
		if (this.plugin.settings.timeEntriesStorage === "task") {
			const file = this.plugin.app.vault.getAbstractFileByPath(task.path);
			if (!(file instanceof TFile)) throw new Error(`Cannot find task file: ${task.path}`);
			await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
				if (Array.isArray(fm[timeEntriesField])) {
					fm[timeEntriesField] = fm[timeEntriesField].filter((e: any) => e.id !== entryId);
					if (fm[timeEntriesField].length === 0) delete fm[timeEntriesField];
				}
			});
		} else {
			// Scan daily notes for the entry
			const { getAllDailyNotes } = await import("obsidian-daily-notes-interface");
			const allDailyNotes = getAllDailyNotes();
			for (const dnFile of Object.values(allDailyNotes)) {
				const cache = this.plugin.app.metadataCache.getFileCache(dnFile as TFile);
				const entries = cache?.frontmatter?.timeEntries;
				if (Array.isArray(entries) && entries.some((e: any) => e.id === entryId)) {
					await this.plugin.app.fileManager.processFrontMatter(dnFile as TFile, (fm) => {
						if (Array.isArray(fm.timeEntries)) {
							fm.timeEntries = fm.timeEntries.filter((e: any) => e.id !== entryId);
							if (fm.timeEntries.length === 0) delete fm.timeEntries;
						}
					});
					break;
				}
			}
		}
		await this.updateDenormalizedScheduled(task, undefined);
	}

	/** Replace all entries for a task (used by updateTask interceptor) */
	async writeAllEntries(task: TaskInfo, entries: UnifiedTimeEntry[]): Promise<void> {
		if (this.plugin.settings.timeEntriesStorage === "task") {
			const file = this.plugin.app.vault.getAbstractFileByPath(task.path);
			if (!(file instanceof TFile)) throw new Error(`Cannot find task file: ${task.path}`);
			const timeEntriesField = this.plugin.fieldMapper.toUserField("timeEntries");
			await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
				if (entries.length > 0) {
					fm[timeEntriesField] = entries;
				} else {
					delete fm[timeEntriesField];
				}
			});
		} else {
			// For dailyNote mode: read existing entries, diff and update
			const existingEntries = await this.readEntries(task);
			const existingIds = new Set(existingEntries.map(e => e.id));
			const newIds = new Set(entries.map(e => e.id));

			// Delete entries that are no longer present
			for (const existing of existingEntries) {
				if (!newIds.has(existing.id)) {
					await this.deleteEntry(task, existing.id);
				}
			}

			// Add or update entries
			for (const entry of entries) {
				if (existingIds.has(entry.id)) {
					await this.writeEntry(task, entry, "update");
				} else {
					await this.writeEntry(task, entry, "add");
				}
			}
		}
		await this.updateDenormalizedScheduled(task, entries);
	}

	/** Read all entries for a task from the correct storage */
	async readEntries(task: TaskInfo): Promise<UnifiedTimeEntry[]> {
		if (this.plugin.settings.timeEntriesStorage === "task") {
			return task.timeEntries || [];
		}
		// dailyNote mode: scan daily notes for entries with matching taskLink
		const { getAllDailyNotes } = await import("obsidian-daily-notes-interface");
		const allDailyNotes = getAllDailyNotes();
		const taskLinkPath = task.path.replace(/\.md$/, "");
		const results: UnifiedTimeEntry[] = [];

		for (const dnFile of Object.values(allDailyNotes)) {
			const cache = this.plugin.app.metadataCache.getFileCache(dnFile as TFile);
			const entries = cache?.frontmatter?.timeEntries;
			if (!Array.isArray(entries)) continue;
			for (const entry of entries) {
				if (entry.taskLink) {
					const linkPath = entry.taskLink.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0].trim();
					if (linkPath === taskLinkPath) {
						results.push(mapToUnifiedTimeEntry(entry));
					}
				}
			}
		}
		return results;
	}

	/** Get the active (running) time entry for a task, checking the correct storage */
	async getActiveEntry(task: TaskInfo): Promise<UnifiedTimeEntry | null> {
		const entries = this.plugin.settings.timeEntriesStorage === "dailyNote"
			? await this.readEntries(task)
			: task.timeEntries || [];
		return (getActiveTimeEntry(entries) as UnifiedTimeEntry | null) ?? null;
	}

	/**
	 * Find all running timer entries across all tasks.
	 * In task file mode, scans all tasks from the cache.
	 * In daily note mode, checks today's daily note for entries without endTime.
	 */
	async findRunningEntries(): Promise<{ taskPath: string; entry: UnifiedTimeEntry }[]> {
		if (this.plugin.settings.timeEntriesStorage === "task") {
			const allTasks = await this.plugin.cacheManager.getAllTasks();
			const results: { taskPath: string; entry: UnifiedTimeEntry }[] = [];
			for (const task of allTasks) {
				const active = getActiveTimeEntry(task.timeEntries || []) as UnifiedTimeEntry | null;
				if (active) {
					results.push({ taskPath: task.path, entry: active });
				}
			}
			return results;
		}

		// Daily note mode: check today's daily note for running entries
		const { getDailyNote, getAllDailyNotes } = await import("obsidian-daily-notes-interface");
		const moment = (window as any).moment();
		const allDailyNotes = getAllDailyNotes();
		const todayNote = getDailyNote(moment, allDailyNotes);
		if (!todayNote) return [];

		const cache = this.plugin.app.metadataCache.getFileCache(todayNote);
		const entries = cache?.frontmatter?.timeEntries;
		if (!Array.isArray(entries)) return [];

		const results: { taskPath: string; entry: UnifiedTimeEntry }[] = [];
		for (const entry of entries) {
			if (entry.startTime && !entry.endTime && entry.type !== "planned" && entry.startTime.includes("T")) {
				if (entry.taskLink) {
					const linkPath = entry.taskLink.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0].trim();
					const file = this.plugin.app.metadataCache.getFirstLinkpathDest(linkPath, "");
					if (file) {
						results.push({ taskPath: file.path, entry: mapToUnifiedTimeEntry(entry) });
					}
				}
			}
		}
		return results;
	}

	/** Update the denormalized `scheduled` field on the task file based on earliest future planned entry */
	private async updateDenormalizedScheduled(task: TaskInfo, entries?: UnifiedTimeEntry[]): Promise<void> {
		if (this.plugin.settings.timeEntriesStorage !== "dailyNote") return;

		const allEntries = entries ?? await this.readEntries(task);
		const file = this.plugin.app.vault.getAbstractFileByPath(task.path);
		if (!(file instanceof TFile)) return;

		const now = new Date();
		const planned = allEntries
			.filter(e => e.type === "planned")
			.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
		const target = planned.find(e => new Date(e.startTime) >= now) || planned[0];

		const scheduledField = this.plugin.fieldMapper.toUserField("scheduled");
		await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
			if (target) {
				const startTime = target.startTime;
				fm[scheduledField] = startTime.length === 10 ? startTime : startTime.substring(0, 10);
			}
			// Don't remove scheduled if no planned entries — can't distinguish manual vs derived
		});
	}
}
