import { TFile, parseYaml, stringifyYaml } from "obsidian";
import type TaskNotesPlugin from "../main";
import {
	UnifiedTimeEntry,
	DailyNoteTimeEntry,
	TimeBlock,
	DailyNoteFrontmatter,
} from "../types";
import { generateTimeEntryId } from "../utils/helpers";

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
	const startISO = `${date}T${block.startTime}:00`;
	const endISO = `${date}T${block.endTime}:00`;

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
 * Called every BATCH_SIZE items.
 */
function yieldToUI(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

const BATCH_SIZE = 50;

/**
 * Resolve a wikilink string like `[[Tasks/Write Q1 report]]` to a TFile.
 * Returns null if the link cannot be resolved.
 */
function resolveWikilink(plugin: TaskNotesPlugin, wikilink: string): TFile | null {
	// Strip [[ and ]] plus any alias after |
	const inner = wikilink.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0].trim();
	return plugin.app.metadataCache.getFirstLinkpathDest(inner, "");
}

// ── Migration: Daily Note  Task ────────────────────────────────────

/**
 * Migrate time entries FROM daily notes TO their respective task files.
 *
 * For each daily note that has `timeEntries` (or legacy `timeblocks`):
 *  - Entries WITH a `taskLink` are moved to the linked task file.
 *  - Entries WITHOUT a `taskLink` stay on the daily note.
 *  - Legacy `timeblocks` are converted to UnifiedTimeEntry first.
 *
 * Uses entry `id` for idempotency  entries already present at the
 * destination are skipped.
 */
export async function migrateDailyNoteToTask(
	plugin: TaskNotesPlugin,
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

	// Cache of task files we've already resolved  path  existing entry IDs
	const taskEntryCache = new Map<string, Set<string>>();

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
		let legacyConverted: DailyNoteTimeEntry[] = [];
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

		let dailyNoteModified = false;

		for (const entry of toMigrate) {
			try {
				const taskFile = resolveWikilink(plugin, entry.taskLink!);
				if (!taskFile) {
					result.errors.push(
						`Could not resolve task link "${entry.taskLink}" in ${dnFile.path}`,
					);
					result.errorCount++;
					// Keep entry on daily note if we can't resolve it
					toKeepOnDailyNote.push(entry);
					continue;
				}

				// Get or populate the task entry cache
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
					dailyNoteModified = true; // still remove from daily note
					continue;
				}

				// Add entry to task file via processFrontMatter for atomic write
				const unifiedEntry = mapToUnifiedTimeEntry(entry);
				await plugin.app.fileManager.processFrontMatter(taskFile, (taskFm) => {
					if (!taskFm[timeEntriesField]) {
						taskFm[timeEntriesField] = [];
					}
					taskFm[timeEntriesField].push(unifiedEntry);
				});

				existingIds.add(entry.id);
				result.migratedCount++;
				dailyNoteModified = true;
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				result.errors.push(`Error migrating entry ${entry.id}: ${msg}`);
				result.errorCount++;
				// Keep the entry on the daily note so no data is lost
				toKeepOnDailyNote.push(entry);
			}

			processed++;
			if (processed % BATCH_SIZE === 0) {
				await yieldToUI();
			}
		}

		// Update the daily note: keep only non-migrated entries, remove legacy timeblocks
		if (dailyNoteModified) {
			const updatedParsed = await readFrontmatterAndBody(plugin, dnFile);
			if (updatedParsed) {
				const updatedFm = updatedParsed.frontmatter;

				// Replace timeEntries with only those that should stay
				if (toKeepOnDailyNote.length > 0) {
					updatedFm.timeEntries = toKeepOnDailyNote;
				} else {
					delete updatedFm.timeEntries;
				}

				// Remove legacy timeblocks that were converted and migrated
				if (legacyConverted.length > 0 && Array.isArray(updatedFm.timeblocks)) {
					// If all legacy timeblocks had task links and were migrated, remove
					const remainingLegacy = updatedFm.timeblocks.filter(
						(tb: TimeBlock) => !tb.attachments?.[0],
					);
					if (remainingLegacy.length > 0) {
						updatedFm.timeblocks = remainingLegacy;
					} else {
						delete updatedFm.timeblocks;
					}
				}

				await writeFrontmatterAndBody(plugin, dnFile, updatedFm, updatedParsed.body);
			}
		}
	}

	return result;
}

// ── Migration: Task  Daily Note ────────────────────────────────────

/**
 * Migrate time entries FROM task files TO daily notes.
 *
 * For each task file with `timeEntries`:
 *  - Group entries by date (from startTime).
 *  - For each date, find or create the corresponding daily note.
 *  - Add entries as DailyNoteTimeEntry (with taskLink pointing back to the task).
 *  - Remove migrated entries from the task file.
 *
 * Uses entry `id` for idempotency.
 */
export async function migrateTaskToDailyNote(
	plugin: TaskNotesPlugin,
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

	// Cache daily note entry IDs to avoid duplicates
	const dailyNoteEntryCache = new Map<string, Set<string>>();

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
				// Find or create daily note for this date
				const moment = (window as any).moment(date);
				let allDailyNotes = getAllDailyNotes();
				let dailyNote = getDailyNote(moment, allDailyNotes);

				if (!dailyNote) {
					try {
						dailyNote = await createDailyNote(moment);
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						result.errors.push(
							`Failed to create daily note for ${date}: ${msg}`,
						);
						result.errorCount += entries.length;
						continue;
					}
				}

				if (!dailyNote) {
					result.errors.push(`Could not find or create daily note for ${date}`);
					result.errorCount += entries.length;
					continue;
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

				// Add each entry to the daily note
				const entriesToAdd: DailyNoteTimeEntry[] = [];

				for (const entry of entries) {
					if (existingIds.has(entry.id)) {
						result.skippedCount++;
						migratedIds.add(entry.id);
						continue;
					}

					const dailyEntry = mapToDailyNoteTimeEntry(entry, task.path);
					entriesToAdd.push(dailyEntry);
					existingIds.add(entry.id);
					migratedIds.add(entry.id);
					result.migratedCount++;
				}

				if (entriesToAdd.length > 0) {
					// Read current daily note content and append entries
					const dnParsed = await readFrontmatterAndBody(plugin, dailyNote);
					if (dnParsed) {
						const dnFm = dnParsed.frontmatter;
						if (!dnFm.timeEntries) {
							dnFm.timeEntries = [];
						}
						dnFm.timeEntries.push(...entriesToAdd);
						await writeFrontmatterAndBody(
							plugin,
							dailyNote,
							dnFm,
							dnParsed.body,
						);
					}
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				result.errors.push(
					`Error migrating entries for date ${date} from ${task.path}: ${msg}`,
				);
				result.errorCount += entries.length;
			}

			processed += entries.length;
			if (processed % BATCH_SIZE === 0) {
				await yieldToUI();
			}
		}

		// Remove migrated entries from the task file
		if (migratedIds.size > 0) {
			try {
				await plugin.app.fileManager.processFrontMatter(taskFile, (taskFm) => {
					if (Array.isArray(taskFm[timeEntriesField])) {
						taskFm[timeEntriesField] = taskFm[timeEntriesField].filter(
							(e: UnifiedTimeEntry) => !migratedIds.has(e.id),
						);
						if (taskFm[timeEntriesField].length === 0) {
							delete taskFm[timeEntriesField];
						}
					}
				});
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				result.errors.push(
					`Error removing migrated entries from ${task.path}: ${msg}`,
				);
				result.errorCount++;
			}
		}
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
