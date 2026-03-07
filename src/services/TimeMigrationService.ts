import { TFile, parseYaml, stringifyYaml } from "obsidian";
import type TaskNotesPlugin from "../main";
import {
	UnifiedTimeEntry,
	DailyNoteTimeEntry,
	TimeBlock,
	DailyNoteFrontmatter,
} from "../types";
import { generateTimeEntryId } from "../utils/helpers";
import { getTimezoneOffsetString } from "../utils/dateUtils";

// ── Result types ────────────────────────────────────────────────────────

export interface MigrationResult {
	migratedCount: number;
	skippedCount: number;
	errorCount: number;
	errors: string[];
}

export interface MigrationCount {
	entries: number;
	sources: number;
}

// ── Schema mapping functions ────────────────────────────────────────────

/**
 * Strip the daily-note-specific `taskLink` field to produce a plain UnifiedTimeEntry.
 */
export function mapToUnifiedTimeEntry(entry: DailyNoteTimeEntry): UnifiedTimeEntry {
	// Destructure to omit taskLink
	const { taskLink: _taskLink, ...unified } = entry;
	return unified;
}

/**
 * Add a taskLink wikilink so the entry can live on a daily note while still
 * pointing back to its owning task file.
 */
export function mapToDailyNoteTimeEntry(
	entry: UnifiedTimeEntry,
	taskPath: string,
): DailyNoteTimeEntry {
	// Build a wikilink from the task path (strip .md extension)
	const linkPath = taskPath.replace(/\.md$/, "");
	return {
		...entry,
		taskLink: `[[${linkPath}]]`,
	};
}

/**
 * Convert a legacy HH:MM-based TimeBlock into a UnifiedTimeEntry by combining
 * the block's times with the supplied date string (YYYY-MM-DD).
 */
export function mapLegacyTimeblockToUnified(
	block: TimeBlock,
	date: string,
): UnifiedTimeEntry {
	const tzSuffix = getTimezoneOffsetString();
	const startISO = `${date}T${block.startTime}:00${tzSuffix}`;
	const endISO = `${date}T${block.endTime}:00${tzSuffix}`;

	const [sh, sm] = block.startTime.split(":").map(Number);
	const [eh, em] = block.endTime.split(":").map(Number);
	const duration = (eh * 60 + em) - (sh * 60 + sm);

	return {
		id: generateTimeEntryId(),
		startTime: startISO,
		endTime: endISO,
		title: block.title,
		color: block.color,
		description: block.description,
		duration: duration > 0 ? duration : undefined,
	};
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Extract the date portion (YYYY-MM-DD) from an ISO datetime string. */
function dateFromISO(iso: string): string {
	return iso.slice(0, 10);
}

/**
 * Read a file's raw content, split it into frontmatter object and body text.
 * Returns `null` if the file has no frontmatter block.
 */
async function readFrontmatterAndBody(
	plugin: TaskNotesPlugin,
	file: TFile,
): Promise<{ frontmatter: Record<string, any>; body: string } | null> {
	const content = await plugin.app.vault.read(file);
	if (!content.startsWith("---")) return null;

	const endIdx = content.indexOf("---", 3);
	if (endIdx === -1) return null;

	const yamlText = content.substring(3, endIdx);
	const bodyText = content.substring(endIdx + 3);

	try {
		const fm = parseYaml(yamlText) || {};
		return { frontmatter: fm, body: bodyText };
	} catch {
		return null;
	}
}

/**
 * Write frontmatter + body back to a file.
 */
async function writeFrontmatterAndBody(
	plugin: TaskNotesPlugin,
	file: TFile,
	frontmatter: Record<string, any>,
	body: string,
): Promise<void> {
	const yamlText = stringifyYaml(frontmatter);
	const newContent = `---\n${yamlText}---${body}`;
	await plugin.app.vault.modify(file, newContent);
}

/**
 * Yield to the UI thread to prevent long-running migrations from blocking.
 */
function yieldToUI(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

const BATCH_SIZE = 50;
const WRITE_CONCURRENCY = 5;

/**
 * Resolve a wikilink string like `[[Tasks/Write Q1 report]]` to a TFile.
 * Returns null if the link cannot be resolved.
 */
function resolveWikilink(plugin: TaskNotesPlugin, wikilink: string): TFile | null {
	// Strip [[ and ]] plus any alias after |
	const inner = wikilink.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0].trim();
	return plugin.app.metadataCache.getFirstLinkpathDest(inner, "");
}

// ── Migration: Daily Note → Task ────────────────────────────────────

/**
 * Migrate time entries FROM daily notes TO their respective task files.
 *
 * Uses a three-phase approach for performance:
 *  Phase 1: Scan daily notes, collect entries, group by destination task.
 *  Phase 2: Batch-write to task files (one write per task, concurrent).
 *  Phase 3: Clean up source daily notes (concurrent).
 *
 * Uses entry `id` for idempotency — entries already present at the
 * destination are skipped.
 */
export async function migrateDailyNoteToTask(
	plugin: TaskNotesPlugin,
	onProgress?: (progress: { migrated: number; total: number; phase?: "collecting" | "writing" | "cleanup" }) => void,
): Promise<MigrationResult> {
	const result: MigrationResult = {
		migratedCount: 0,
		skippedCount: 0,
		errorCount: 0,
		errors: [],
	};

	const {
		getAllDailyNotes,
	} = await import("obsidian-daily-notes-interface");

	let allDailyNotes: Record<string, TFile>;
	try {
		allDailyNotes = getAllDailyNotes();
	} catch (e) {
		result.errors.push("Failed to load daily notes. Is the Daily Notes plugin enabled?");
		result.errorCount++;
		return result;
	}

	const dailyNoteFiles = Object.values(allDailyNotes);
	const timeEntriesField = plugin.fieldMapper.toUserField("timeEntries");

	// ── Phase 1: Collect entries and group by destination task ──

	interface DailyNoteState {
		file: TFile;
		entriesToKeep: DailyNoteTimeEntry[];
		legacyConverted: DailyNoteTimeEntry[];
		frontmatter: Record<string, any>;
		body: string;
		modified: boolean;
	}

	interface PendingWrite {
		entry: UnifiedTimeEntry;
		source: DailyNoteState;
		originalEntry: DailyNoteTimeEntry;
	}

	const taskBatches = new Map<string, { taskFile: TFile; pending: PendingWrite[] }>();
	const dailyNoteStates: DailyNoteState[] = [];
	const taskEntryCache = new Map<string, Set<string>>();
	let total = 0;
	let processed = 0;

	for (const dnFile of dailyNoteFiles) {
		const parsed = await readFrontmatterAndBody(plugin, dnFile);
		if (!parsed) continue;

		const { frontmatter, body } = parsed;
		const fm = frontmatter as DailyNoteFrontmatter;

		// Derive the date from the daily note filename (YYYY-MM-DD)
		const dateMatch = dnFile.basename.match(/(\d{4}-\d{2}-\d{2})/);
		const noteDate = dateMatch ? dateMatch[1] : dnFile.basename;

		// Collect entries to migrate from unified timeEntries
		let entries: DailyNoteTimeEntry[] = [];
		if (Array.isArray(fm.timeEntries)) {
			entries = [...fm.timeEntries];
		}

		// Also convert legacy timeblocks
		const legacyConverted: DailyNoteTimeEntry[] = [];
		if (Array.isArray(fm.timeblocks)) {
			for (const block of fm.timeblocks) {
				if (block && block.startTime && block.endTime) {
					const unified = mapLegacyTimeblockToUnified(block, noteDate);
					// Legacy timeblocks with attachments: use the first attachment as taskLink
					const taskLink = block.attachments?.[0];
					legacyConverted.push({ ...unified, taskLink });
				}
			}
		}

		const allEntries = [...entries, ...legacyConverted];
		if (allEntries.length === 0) continue;

		// Partition entries: those with a taskLink can be migrated, others stay
		const toMigrate: DailyNoteTimeEntry[] = [];
		const toKeepOnDailyNote: DailyNoteTimeEntry[] = [];

		for (const entry of allEntries) {
			if (entry.taskLink) {
				toMigrate.push(entry);
			} else {
				toKeepOnDailyNote.push(entry);
			}
		}

		if (toMigrate.length === 0) continue;

		total += toMigrate.length;

		const state: DailyNoteState = {
			file: dnFile,
			entriesToKeep: toKeepOnDailyNote,
			legacyConverted,
			frontmatter,
			body,
			modified: false,
		};

		for (const entry of toMigrate) {
			const taskFile = resolveWikilink(plugin, entry.taskLink!);
			if (!taskFile) {
				result.errors.push(
					`Could not resolve task link "${entry.taskLink}" in ${dnFile.path}`,
				);
				result.errorCount++;
				// Keep entry on daily note if we can't resolve it
				state.entriesToKeep.push(entry);
				processed++;
				onProgress?.({ migrated: processed, total });
				continue;
			}

			// Populate task entry cache for idempotency
			if (!taskEntryCache.has(taskFile.path)) {
				const taskParsed = await readFrontmatterAndBody(plugin, taskFile);
				const existingEntries: UnifiedTimeEntry[] =
					(taskParsed?.frontmatter?.[timeEntriesField] as UnifiedTimeEntry[]) || [];
				taskEntryCache.set(
					taskFile.path,
					new Set(existingEntries.map((e) => e.id)),
				);
			}

			const existingIds = taskEntryCache.get(taskFile.path)!;

			// Idempotency: skip if already at destination
			if (existingIds.has(entry.id)) {
				result.skippedCount++;
				state.modified = true; // still remove from daily note
				processed++;
				onProgress?.({ migrated: processed, total });
				continue;
			}

			// Queue for batch write
			if (!taskBatches.has(taskFile.path)) {
				taskBatches.set(taskFile.path, { taskFile, pending: [] });
			}
			taskBatches.get(taskFile.path)!.pending.push({
				entry: mapToUnifiedTimeEntry(entry),
				source: state,
				originalEntry: entry,
			});
			existingIds.add(entry.id);
			state.modified = true;
			processed++;
			onProgress?.({ migrated: processed, total });
		}

		dailyNoteStates.push(state);

		if (processed % BATCH_SIZE === 0) {
			await yieldToUI();
		}
	}

	// ── Phase 2: Batch write to task files with concurrency ──
	// One processFrontMatter call per task file instead of per entry.

	const taskBatchList = Array.from(taskBatches.values());

	for (let i = 0; i < taskBatchList.length; i += WRITE_CONCURRENCY) {
		const chunk = taskBatchList.slice(i, i + WRITE_CONCURRENCY);
		onProgress?.({
			migrated: Math.min(i + WRITE_CONCURRENCY, taskBatchList.length),
			total: taskBatchList.length,
			phase: "writing",
		});
		await Promise.all(chunk.map(async ({ taskFile, pending }) => {
			try {
				await plugin.app.fileManager.processFrontMatter(taskFile, (taskFm) => {
					if (!taskFm[timeEntriesField]) {
						taskFm[timeEntriesField] = [];
					}
					taskFm[timeEntriesField].push(...pending.map((p) => p.entry));
				});
				result.migratedCount += pending.length;
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				result.errors.push(`Error writing entries to ${taskFile.path}: ${msg}`);
				result.errorCount += pending.length;
				// Return entries to their source daily notes so no data is lost
				for (const p of pending) {
					p.source.entriesToKeep.push(p.originalEntry);
				}
			}
		}));
		await yieldToUI();
	}

	// ── Phase 3: Clean up source daily notes with concurrency ──
	// Uses cached frontmatter/body from Phase 1 (no re-read needed since
	// Phase 2 only wrote to task files, not daily notes).

	const modifiedStates = dailyNoteStates.filter((s) => s.modified);

	for (let i = 0; i < modifiedStates.length; i += WRITE_CONCURRENCY) {
		const chunk = modifiedStates.slice(i, i + WRITE_CONCURRENCY);
		onProgress?.({
			migrated: Math.min(i + WRITE_CONCURRENCY, modifiedStates.length),
			total: modifiedStates.length,
			phase: "cleanup",
		});
		await Promise.all(chunk.map(async (state) => {
			const fm = state.frontmatter;

			// Replace timeEntries with only those that should stay
			if (state.entriesToKeep.length > 0) {
				fm.timeEntries = state.entriesToKeep;
			} else {
				delete fm.timeEntries;
			}

			// Remove legacy timeblocks that were converted and migrated
			if (state.legacyConverted.length > 0 && Array.isArray(fm.timeblocks)) {
				const remainingLegacy = fm.timeblocks.filter(
					(tb: TimeBlock) => !tb.attachments?.[0],
				);
				if (remainingLegacy.length > 0) {
					fm.timeblocks = remainingLegacy;
				} else {
					delete fm.timeblocks;
				}
			}

			await writeFrontmatterAndBody(plugin, state.file, fm, state.body);
		}));
		await yieldToUI();
	}

	return result;
}

// ── Migration: Task → Daily Note ────────────────────────────────────

/**
 * Migrate time entries FROM task files TO daily notes.
 *
 * Uses a three-phase approach for performance:
 *  Phase 1: Scan tasks, collect entries, find/create daily notes, group
 *           by destination daily note.
 *  Phase 2: Batch-write to daily notes (one write per note, concurrent).
 *  Phase 3: Clean up source task files (concurrent).
 *
 * Uses entry `id` for idempotency.
 */
export async function migrateTaskToDailyNote(
	plugin: TaskNotesPlugin,
	onProgress?: (progress: { migrated: number; total: number; phase?: "collecting" | "writing" | "cleanup" }) => void,
): Promise<MigrationResult> {
	const result: MigrationResult = {
		migratedCount: 0,
		skippedCount: 0,
		errorCount: 0,
		errors: [],
	};

	const {
		getAllDailyNotes,
		getDailyNote,
		createDailyNote,
	} = await import("obsidian-daily-notes-interface");

	const timeEntriesField = plugin.fieldMapper.toUserField("timeEntries");
	const allTasks = await plugin.cacheManager.getAllTasks();

	// Pre-count total entries for progress reporting
	let total = 0;
	for (const task of allTasks) {
		if (task.timeEntries) total += task.timeEntries.length;
	}

	// ── Phase 1: Collect entries and group by destination daily note ──

	// Load daily notes map once; refresh only after creating new notes
	let allDailyNotesMap = getAllDailyNotes();
	const dailyNoteCache = new Map<string, TFile>();

	// Per-daily-note: entries to write
	const dailyNoteBatches = new Map<string, { dailyNote: TFile; entries: DailyNoteTimeEntry[] }>();

	// Per-daily-note: existing entry IDs for idempotency
	const dailyNoteEntryCache = new Map<string, Set<string>>();

	// Per-task: entry IDs queued or skipped for migration
	const taskMigratedIds = new Map<string, { taskFile: TFile; ids: Set<string> }>();

	// Track IDs that were queued for writing (not skipped)
	const queuedEntryIds = new Set<string>();

	let processed = 0;

	for (const task of allTasks) {
		if (!task.timeEntries || task.timeEntries.length === 0) continue;

		const taskFile = plugin.app.vault.getAbstractFileByPath(task.path);
		if (!(taskFile instanceof TFile)) continue;

		// Group entries by date
		const entriesByDate = new Map<string, UnifiedTimeEntry[]>();
		for (const entry of task.timeEntries) {
			if (!entry.startTime) continue;
			const date = dateFromISO(entry.startTime);
			if (!entriesByDate.has(date)) {
				entriesByDate.set(date, []);
			}
			entriesByDate.get(date)!.push(entry);
		}

		const migratedIds = new Set<string>();

		for (const [date, entries] of entriesByDate) {
			try {
				// Find or create daily note for this date (with caching)
				let dailyNote = dailyNoteCache.get(date);
				if (!dailyNote) {
					const moment = (window as any).moment(date);
					dailyNote = getDailyNote(moment, allDailyNotesMap) ?? undefined;

					if (!dailyNote) {
						try {
							dailyNote = await createDailyNote(moment);
							allDailyNotesMap = getAllDailyNotes();
						} catch (e) {
							const msg = e instanceof Error ? e.message : String(e);
							result.errors.push(
								`Failed to create daily note for ${date}: ${msg}`,
							);
							result.errorCount += entries.length;
							processed += entries.length;
							onProgress?.({ migrated: processed, total });
							continue;
						}
					}

					if (!dailyNote) {
						result.errors.push(`Could not find or create daily note for ${date}`);
						result.errorCount += entries.length;
						processed += entries.length;
						onProgress?.({ migrated: processed, total });
						continue;
					}

					dailyNoteCache.set(date, dailyNote);
				}

				// Get or populate the daily note entry cache
				if (!dailyNoteEntryCache.has(dailyNote.path)) {
					const dnParsed = await readFrontmatterAndBody(plugin, dailyNote);
					const existingEntries: DailyNoteTimeEntry[] =
						(dnParsed?.frontmatter?.timeEntries as DailyNoteTimeEntry[]) || [];
					dailyNoteEntryCache.set(
						dailyNote.path,
						new Set(existingEntries.map((e) => e.id)),
					);
				}

				const existingIds = dailyNoteEntryCache.get(dailyNote.path)!;

				// Queue entries for batch write
				for (const entry of entries) {
					if (existingIds.has(entry.id)) {
						result.skippedCount++;
						migratedIds.add(entry.id);
						continue;
					}

					const dailyEntry = mapToDailyNoteTimeEntry(entry, task.path);

					if (!dailyNoteBatches.has(dailyNote.path)) {
						dailyNoteBatches.set(dailyNote.path, { dailyNote, entries: [] });
					}
					dailyNoteBatches.get(dailyNote.path)!.entries.push(dailyEntry);
					existingIds.add(entry.id);
					migratedIds.add(entry.id);
					queuedEntryIds.add(entry.id);
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				result.errors.push(
					`Error migrating entries for date ${date} from ${task.path}: ${msg}`,
				);
				result.errorCount += entries.length;
			}

			processed += entries.length;
			onProgress?.({ migrated: processed, total });
			if (processed % BATCH_SIZE === 0) {
				await yieldToUI();
			}
		}

		if (migratedIds.size > 0) {
			taskMigratedIds.set(task.path, { taskFile, ids: migratedIds });
		}
	}

	// ── Phase 2: Batch write to daily notes with concurrency ──
	// One writeFrontmatterAndBody call per daily note instead of per date-group.

	const successfulEntryIds = new Set<string>();
	const dailyNoteBatchList = Array.from(dailyNoteBatches.values());

	for (let i = 0; i < dailyNoteBatchList.length; i += WRITE_CONCURRENCY) {
		const chunk = dailyNoteBatchList.slice(i, i + WRITE_CONCURRENCY);
		onProgress?.({
			migrated: Math.min(i + WRITE_CONCURRENCY, dailyNoteBatchList.length),
			total: dailyNoteBatchList.length,
			phase: "writing",
		});
		await Promise.all(chunk.map(async ({ dailyNote, entries }) => {
			try {
				const dnParsed = await readFrontmatterAndBody(plugin, dailyNote);
				if (dnParsed) {
					const dnFm = dnParsed.frontmatter;
					if (!dnFm.timeEntries) {
						dnFm.timeEntries = [];
					}
					dnFm.timeEntries.push(...entries);
					await writeFrontmatterAndBody(
						plugin,
						dailyNote,
						dnFm,
						dnParsed.body,
					);
				}
				result.migratedCount += entries.length;
				for (const e of entries) {
					successfulEntryIds.add(e.id);
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				result.errors.push(
					`Error writing entries to daily note ${dailyNote.path}: ${msg}`,
				);
				result.errorCount += entries.length;
			}
		}));
		await yieldToUI();
	}

	// ── Phase 3: Clean up source task files with concurrency ──
	// Only remove entries that were successfully written or already existed.

	const taskCleanupList = Array.from(taskMigratedIds.values()).filter(
		({ ids }) => {
			for (const id of ids) {
				// Entry is safe to remove if it was successfully written or was skipped
				if (successfulEntryIds.has(id) || !queuedEntryIds.has(id)) return true;
			}
			return false;
		},
	);

	for (let i = 0; i < taskCleanupList.length; i += WRITE_CONCURRENCY) {
		const chunk = taskCleanupList.slice(i, i + WRITE_CONCURRENCY);
		onProgress?.({
			migrated: Math.min(i + WRITE_CONCURRENCY, taskCleanupList.length),
			total: taskCleanupList.length,
			phase: "cleanup",
		});
		await Promise.all(chunk.map(async ({ taskFile, ids }) => {
			try {
				// Only remove IDs that were successfully written or were skipped
				const safeToRemove = new Set<string>();
				for (const id of ids) {
					if (successfulEntryIds.has(id) || !queuedEntryIds.has(id)) {
						safeToRemove.add(id);
					}
				}

				await plugin.app.fileManager.processFrontMatter(taskFile, (taskFm) => {
					if (Array.isArray(taskFm[timeEntriesField])) {
						taskFm[timeEntriesField] = taskFm[timeEntriesField].filter(
							(e: UnifiedTimeEntry) => !safeToRemove.has(e.id),
						);
						if (taskFm[timeEntriesField].length === 0) {
							delete taskFm[timeEntriesField];
						}
					}
				});
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				result.errors.push(
					`Error removing migrated entries from ${taskFile.path}: ${msg}`,
				);
				result.errorCount++;
			}
		}));
		await yieldToUI();
	}

	return result;
}

// ── Preview count ───────────────────────────────────────────────────────

/**
 * Count how many entries are available to migrate in the given direction.
 * Used by the confirmation modal to show the user what will happen.
 */
export async function countMigratableEntries(
	plugin: TaskNotesPlugin,
	direction: "toTask" | "toDailyNote",
): Promise<MigrationCount> {
	if (direction === "toTask") {
		return countDailyNoteEntries(plugin);
	} else {
		return countTaskEntries(plugin);
	}
}

async function countDailyNoteEntries(plugin: TaskNotesPlugin): Promise<MigrationCount> {
	let entries = 0;
	let sources = 0;

	const { getAllDailyNotes } = await import("obsidian-daily-notes-interface");

	let allDailyNotes: Record<string, TFile>;
	try {
		allDailyNotes = getAllDailyNotes();
	} catch {
		return { entries: 0, sources: 0 };
	}

	for (const dnFile of Object.values(allDailyNotes)) {
		const parsed = await readFrontmatterAndBody(plugin, dnFile);
		if (!parsed) continue;

		const fm = parsed.frontmatter as DailyNoteFrontmatter;
		let count = 0;

		if (Array.isArray(fm.timeEntries)) {
			count += fm.timeEntries.filter((e) => e.taskLink).length;
		}
		if (Array.isArray(fm.timeblocks)) {
			count += fm.timeblocks.filter((tb) => tb.attachments?.[0]).length;
		}

		if (count > 0) {
			entries += count;
			sources++;
		}
	}

	return { entries, sources };
}

async function countTaskEntries(plugin: TaskNotesPlugin): Promise<MigrationCount> {
	let entries = 0;
	let sources = 0;

	const allTasks = await plugin.cacheManager.getAllTasks();

	for (const task of allTasks) {
		if (task.timeEntries && task.timeEntries.length > 0) {
			entries += task.timeEntries.length;
			sources++;
		}
	}

	return { entries, sources };
}
