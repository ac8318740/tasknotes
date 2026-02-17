# Unified Time Tracking Architecture — Implementation Plan (v2)

## Overview

TaskNotes has two time systems managed separately: **time entries** (past/actual time on task files) and **timeblocks** (future/scheduled time on daily notes). The `scheduled` field is a third, weaker representation — a single datetime that duplicates timeblock info without start/end times.

This plan unifies all three into a single system built on **timeblocks as the universal scheduling primitive**, with a **storage toggle** that lets users choose where data physically lives (task files or daily notes) and a **migration mechanism** to move data when they switch.

### Design Principles

1. **One copy of data, user chooses where.** Time data lives in exactly one location — task file OR daily note — determined by a settings toggle. No duplication.
2. **`scheduled` merges into timeblocks.** A scheduled task is simply a task with one or more timeblocks. One block = what `scheduled` was. Fifty blocks = multi-slot scheduling. The `scheduled` field becomes computed for backward compatibility.
3. **FieldMapper is the compatibility layer.** By computing `scheduled` from `timeBlocks[0].date` in `mapFromFrontmatter()`, all 70+ files that read `task.scheduled` work unchanged. Only ~8 files need actual modifications.
4. **Migrate, don't duplicate.** When the user flips the storage toggle, a migration process physically moves data between task files and daily notes. Data never exists in both places.

---

## 1. Schema Definitions

### 1A. Unified Time Entry — The Universal Time Primitive

Both "time blocks" (future) and "time entries" (past) share the same underlying data structure. The UI labels them differently based on whether `startTime` is before or after now, but the code treats them identically.

```typescript
// src/types.ts — new interface (after TimeBlock, ~line 510)
export interface UnifiedTimeEntry {
  id: string;            // "te-{timestamp}-{random}"
  startTime: string;     // ISO datetime: "2026-02-18T09:00:00+11:00" (required)
  endTime?: string;      // ISO datetime: "2026-02-18T11:30:00+11:00" (optional — absent if running or date-only)
  title?: string;        // Display override (falls back to task title)
  color?: string;        // Hex color override
  description?: string;  // What was done (past) or what's planned (future)
}
```

Using full ISO datetimes for `startTime`/`endTime` means entries can span midnight or multiple days naturally. No separate `date` field needed — the date is embedded in the datetime. For date-only scheduling (no specific time), `startTime` uses date-only format: `"2026-02-18"`.

**UI terminology:**
- `startTime` is in the future → displayed as **"Time block"** (scheduled work)
- `startTime` is in the past → displayed as **"Time entry"** (tracked work)

**How it replaces `scheduled`:**

| Current `scheduled` value | Equivalent `timeEntries` entry |
|---|---|
| `"2026-02-18"` (date only) | `{ id: "...", startTime: "2026-02-18" }` |
| `"2026-02-18T09:45"` (datetime) | `{ id: "...", startTime: "2026-02-18T09:45:00" }` |
| absent | `timeEntries` absent or `[]` |

**Multi-slot scheduling (new capability):**
```yaml
timeEntries:
  - id: te-1708200000000-abc123def
    startTime: "2026-02-18T09:00:00+11:00"
    endTime: "2026-02-18T11:30:00+11:00"
  - id: te-1708200000001-xyz789ghi
    startTime: "2026-02-19T14:00:00+11:00"
    endTime: "2026-02-19T16:00:00+11:00"
  - id: te-1708200000002-jkl456mno
    startTime: "2026-02-20T09:00:00+11:00"
    endTime: "2026-02-20T10:30:00+11:00"
```

**Overnight span example:**
```yaml
timeEntries:
  - id: te-1708300000000-nightshift
    startTime: "2026-02-18T22:00:00+11:00"
    endTime: "2026-02-19T06:00:00+11:00"
    title: "Night shift monitoring"
```

### 1B. Daily Note Format — Same Structure with Task Link

When stored on daily notes (via storage toggle), entries use the same `UnifiedTimeEntry` fields plus a `taskLink` for bidirectional linking. They are allocated to the daily note matching the `startTime` date.

```typescript
// src/types.ts — new interface
export interface DailyNoteTimeEntry extends UnifiedTimeEntry {
  taskLink?: string;     // Wikilink: "[[Tasks/Write Q1 report]]"
}
```

Daily note date format is handled by Obsidian's core Daily Notes plugin — no custom setting needed. The `obsidian-daily-notes-interface` library abstracts the user's configured format via `getDailyNote(moment)`.

### 1C. Updated Core Interfaces

Since time blocks and time entries are unified into one type, the existing `timeEntries` field on `TaskInfo` absorbs both past and future entries. No new array field needed — the existing `timeEntries` array now holds `UnifiedTimeEntry` objects that can represent both historical time and future schedule.

```typescript
// src/types.ts — TaskInfo: replace TimeEntry[] with UnifiedTimeEntry[]
timeEntries?: UnifiedTimeEntry[];  // Past time entries AND future time blocks (0 to N)

// src/types.ts — TaskFrontmatter: same change
timeEntries?: UnifiedTimeEntry[];

// src/types.ts — DailyNoteFrontmatter (~line 568, after timeblocks)
timeEntries?: DailyNoteTimeEntry[];   // Only present when timeEntriesStorage = "dailyNote"
```

Note: The existing `timeEntries` field mapping already exists in `FieldMapping`. The existing `TimeEntry` interface is replaced by `UnifiedTimeEntry` which is a superset (adds `id`, `title`, `color` fields; changes `startTime`/`endTime` from ISO-only to ISO-or-date-only).

### 1D. `scheduled` Field — Computed Backward Compatibility

The `scheduled` field stays in all interfaces but becomes **computed from time entries** via FieldMapper. It is never removed from type definitions, frontmatter schemas, or APIs. The 70+ files that read `task.scheduled` continue to work unchanged.

**FieldMapper behavior** (`src/services/FieldMapper.ts`):

In `mapFromFrontmatter()`:
1. Read `timeEntries` from frontmatter (existing field mapping, now returns `UnifiedTimeEntry[]`)
2. Read `scheduled` from frontmatter (existing)
3. Find future entries: filter `timeEntries` where `startTime` is in the future (or date-only)
4. If future entries exist: `scheduled = min(futureEntries[*].startTime)` — extract date portion. Future entries win.
5. If no future entries: use `scheduled` as-is — backward compatible

In `mapToFrontmatter()`:
1. Write `timeEntries` array to frontmatter (existing, now includes both past and future)
2. Also write `scheduled` as a denormalized field (`= date portion of earliest future entry`) — this enables plugin downgrade without losing scheduling info entirely

**Why denormalize `scheduled`?** If a user downgrades the plugin, tasks with future time entries but no `scheduled` would appear unscheduled. Writing both ensures graceful degradation — the old plugin sees `scheduled`, the new plugin uses time entries.

---

## 2. Storage Toggle & Settings

### 2A. Storage Location Setting

Since time blocks and time entries are now the same data type (`UnifiedTimeEntry`), there is one storage toggle for all time data:

```typescript
// src/types/settings.ts — add to TaskNotesSettings
/** Where time data physically lives: "task" = task file frontmatter, "dailyNote" = daily note frontmatter */
timeEntriesStorage: "task" | "dailyNote";
```

### 2B. Defaults

```typescript
// src/settings/defaults.ts
timeEntriesStorage: "task",      // Current behavior preserved
```

### 2C. Settings UI

In `src/settings/tabs/featuresTab.ts`:

- **Time Tracking section** (~line 515): Add `timeEntriesStorage` dropdown (`"task"` / `"dailyNote"`) using existing `configureDropdownSetting()` helper. On change, show confirmation modal and trigger migration.

Follow the existing `pomodoroStorageLocation` precedent (`src/types/settings.ts:123`) — it's the same concept (choose where data lives) with the same UX pattern (`StorageLocationConfirmationModal`).

### 2D. Settings Loading

In `src/main.ts` `loadSettings()` (~line 1324-1364), add to the spread:
```typescript
timeEntriesStorage: loadedData?.timeEntriesStorage ?? DEFAULT_SETTINGS.timeEntriesStorage,
```

This is a flat string setting, so no deep-merge needed — simple spread handles it.

---

## 3. Data Flow

### 3A. Storage Determines Everything

The storage setting is the single source of truth for where data lives and where it's read from:

```
timeEntriesStorage: "task"
  Write path: Task file frontmatter → timeEntries[] (UnifiedTimeEntry[])
  Read path:  calendar-core reads task.timeEntries[]
  Daily notes: No time entries in daily note frontmatter

timeEntriesStorage: "dailyNote"
  Write path: Daily note frontmatter → timeEntries[] (DailyNoteTimeEntry[])
  Read path:  calendar-core reads dailyNote.timeEntries[]
  Task files: No timeEntries in task frontmatter
```

### 3B. Schema Mapping Between Storage Formats

When data migrates between task files and daily notes, the schemas differ slightly. Task entries use full ISO datetimes. Daily note entries also use full ISO datetimes but add a `taskLink` field and are allocated to the daily note matching the `startTime` date.

**Task → Daily Note**
```
UnifiedTimeEntry { id, startTime (ISO), endTime (ISO), title, color, description }
  ↓ map
DailyNoteTimeEntry { id, startTime (ISO), endTime (ISO), title, color, description, taskLink: '[[task]]' }
  + taskLink added with wikilink to source task
  + allocated to daily note matching date of startTime
```

**Daily Note → Task**
```
DailyNoteTimeEntry { id, startTime (ISO), endTime (ISO), title, color, description, taskLink }
  ↓ map
UnifiedTimeEntry { id, startTime (ISO), endTime (ISO), title, color, description }
  + taskLink resolved to find target task file
  + taskLink dropped (entry lives on the task itself)
  + entries without taskLink stay on the daily note (standalone)
```

**Legacy daily note TimeBlock migration** (existing `TimeBlock` format → `UnifiedTimeEntry`):
```
TimeBlock { id, title, startTime (HH:MM), endTime (HH:MM), attachments, color }
  ↓ map (using daily note date)
UnifiedTimeEntry { id, startTime (ISO from date+HH:MM), endTime (ISO from date+HH:MM), title, color }
  + date extracted from daily note filename, combined with HH:MM → ISO
  + attachments[0] resolved to task wikilink
```

### 3C. Bidirectional Linking

Every entry that crosses the task/daily-note boundary carries a link back:

| Data Location | Link Field | Example |
|---|---|---|
| Entry on daily note | `taskLink: '[[Tasks/Write Q1 report]]'` | Wikilink to source task |
| Entry on task | `startTime: "2026-02-18T09:15:00+11:00"` | Date extractable → implicitly links to daily note |

---

## 4. Migration Mechanism

### 4A. When Migration Runs

Migration runs when the user changes the storage toggle in settings. It does NOT run automatically or in the background. The flow:

1. User changes `timeEntriesStorage` from `"dailyNote"` to `"task"` in settings
2. `TimeMigrationConfirmationModal` appears:
   - "This will move all task-linked time entries from daily notes to task files."
   - "We recommend backing up your vault before proceeding."
   - Shows count: "Found X entries across Y daily notes."
   - Cancel / Proceed buttons
3. On confirm: migration runs with progress modal
4. On complete: summary shown ("Migrated X entries. Y skipped (no task link).")

### 4B. Migration: dailyNote → task

```
for each daily note in getAllDailyNotes():
  date = extractDateFromDailyNote(dailyNote)
  entries = readFrontmatter(dailyNote).timeEntries || []
  // Also check legacy timeblocks format
  legacyBlocks = readFrontmatter(dailyNote).timeblocks || []
  standaloneEntries = []

  for each entry in entries:
    if entry has taskLink with a resolvable wikilink:
      taskFile = resolveWikilink(entry.taskLink)
      if taskFile exists:
        unifiedEntry = mapToUnifiedTimeEntry(entry)
        appendToTaskFrontmatter(taskFile, "timeEntries", unifiedEntry)
      else:
        standaloneEntries.push(entry)  // Task not found — keep on daily note
        log warning
    else:
      standaloneEntries.push(entry)  // No task link — keep on daily note

  // Also migrate legacy timeblocks with attachments
  standaloneBlocks = []
  for each block in legacyBlocks:
    if block has attachments with a resolvable task wikilink:
      taskFile = resolveWikilink(block.attachments[0])
      if taskFile exists:
        unifiedEntry = mapLegacyTimeblockToUnified(block, date)
        appendToTaskFrontmatter(taskFile, "timeEntries", unifiedEntry)
      else:
        standaloneBlocks.push(block)
    else:
      standaloneBlocks.push(block)

  // Rewrite daily note with only standalone items
  updateDailyNoteFrontmatter(dailyNote, "timeEntries", standaloneEntries)
  updateDailyNoteFrontmatter(dailyNote, "timeblocks", standaloneBlocks)
  updateDailyNoteFrontmatter(dailyNote, "timeblocks", standaloneBlocks)
```

### 4C. Migration: task → dailyNote

```
for each task in getAllTasks():
  if task.timeEntries is empty: continue

  // Group entries by date (extracted from startTime ISO datetime)
  entriesByDate = groupBy(task.timeEntries, entry => extractDate(entry.startTime))

  for each (date, entries) in entriesByDate:
    dailyNote = getDailyNote(moment(date)) || createDailyNote(moment(date))

    for each entry in entries:
      dailyNoteEntry = mapToDailyNoteTimeEntry(entry, task.path)
      appendToDailyNoteFrontmatter(dailyNote, "timeEntries", dailyNoteEntry)

  removeFromTaskFrontmatter(task, "timeEntries")
```

### 4D. Edge Cases

| Scenario | Handling |
|---|---|
| **Daily note doesn't exist for a date** | Create it via `createDailyNote(moment)` — established pattern in `helpers.ts` and `PomodoroService.ts` |
| **Task file referenced by wikilink doesn't exist** | Skip that entry, leave on daily note, log warning, report count at end |
| **Active time tracking session (no endTime)** | Migrate as-is with `endTime` absent. The tracking logic picks it up at the new location. No auto-stop needed. |
| **Entry without task link (standalone)** | Stays on daily note — not migrated |
| **Large vault (1000+ tasks, 365+ daily notes)** | Process in batches of 50 with `setTimeout(0)` between batches to avoid UI blocking. Est. ~7 seconds for large vault |
| **Migration interrupted mid-process** | Progressive approach — entries already moved stay moved. Re-running migration is safe (items already at destination are skipped via ID matching) |
| **Plugin downgrade after storing on tasks** | `scheduled` is denormalized alongside time entries, so old plugin sees `scheduled`. Time entries on tasks already work in current plugin |

---

## 5. Calendar Rendering Changes

### 5A. Storage-Aware Event Generation

The calendar reads from wherever the storage setting points — never both. Since time entries and time blocks are unified, the calendar generates events from `task.timeEntries[]` (when stored on tasks) or `dailyNote.timeEntries[]` (when stored on daily notes). The UI labels events as "time block" or "time entry" based on whether `startTime` is in the future or past.

In `generateCalendarEvents()` (`src/bases/calendar-core.ts:957`):

```typescript
// Unified time entries (both past "time entries" and future "time blocks")
if (settings.timeEntriesStorage === "task") {
  // Read from task.timeEntries[] (UnifiedTimeEntry[])
  for (const task of tasks) {
    if (task.timeEntries?.length) {
      events.push(...createUnifiedTimeEvents(task, now));
    }
  }
} else {
  // Read from daily notes (DailyNoteTimeEntry[])
  events.push(...generateDailyNoteTimeEvents(plugin, visibleStart, visibleEnd, now));
}
```

### 5B. New Function: `createUnifiedTimeEvents()`

Generates calendar events from `task.timeEntries[]`, labeling as time block (future) or time entry (past):

```typescript
function createUnifiedTimeEvents(task: TaskInfo, now: Date): CalendarEvent[] {
  return (task.timeEntries || []).map(entry => {
    const startDate = new Date(entry.startTime);
    const isFuture = startDate > now;
    const isDateOnly = !entry.startTime.includes("T");
    return {
      id: `te-${entry.id}`,
      title: entry.title || task.title,
      start: entry.startTime,
      end: entry.endTime || undefined,
      allDay: isDateOnly,
      extendedProps: {
        eventType: isFuture ? "timeblock" : "timeEntry",  // UI label distinction
        taskInfo: task,
        unifiedTimeEntry: entry,
      },
    };
  });
}
```

### 5C. New Function: `generateDailyNoteTimeEvents()`

Generates calendar events from `dailyNote.timeEntries[]` (DailyNoteTimeEntry format):

```typescript
async function generateDailyNoteTimeEvents(
  plugin: TaskNotesPlugin, visibleStart: string, visibleEnd: string, now: Date
): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  const allDailyNotes = getAllDailyNotes();

  for (const [dateStr, dailyNote] of Object.entries(allDailyNotes)) {
    if (dateStr < visibleStart || dateStr > visibleEnd) continue;
    const cache = plugin.app.metadataCache.getFileCache(dailyNote);
    const timeEntries: DailyNoteTimeEntry[] = cache?.frontmatter?.timeEntries || [];

    for (const entry of timeEntries) {
      const startDate = new Date(entry.startTime);
      const isFuture = startDate > now;
      events.push({
        id: `daily-te-${entry.id}`,
        title: entry.title || entry.description || "Time entry",
        start: entry.startTime,
        end: entry.endTime || undefined,
        extendedProps: {
          eventType: isFuture ? "timeblock" : "timeEntry",
          dailyNoteTimeEntry: entry,
        },
      });
    }
  }
  return events;
}
```

### 5D. Write Path Changes

Code that creates/updates time data must check the storage setting:

| Operation | Current Target | With Storage Toggle |
|---|---|---|
| Create time block (future) from calendar | Daily note | Check `timeEntriesStorage` → write to task or daily note |
| Create time entry (past) from calendar | N/A (new) | Check `timeEntriesStorage` → write to task or daily note |
| Calendar drag/resize | Daily note / Task file | Check setting → update at correct location |
| `TaskService.startTimeTracking` | Task file | Check `timeEntriesStorage` → write to task or daily note |
| `TaskService.stopTimeTracking` | Task file | Check `timeEntriesStorage` → write to task or daily note |

---

## 6. `scheduled` Compatibility — The FieldMapper Approach

This is the architectural centerpiece that makes the plan feasible with minimal changes.

### The Problem
82 files reference `scheduled`. Touching all of them is a massive, error-prone refactor.

### The Solution
`FieldMapper.mapFromFrontmatter()` already reads every frontmatter field into `TaskInfo`. By adding logic to compute `scheduled` from future time entries, every downstream consumer works unchanged.

### Implementation in `src/services/FieldMapper.ts`

**In `mapFromFrontmatter()` (~line 83):**
```typescript
// Read timeEntries (existing — now returns UnifiedTimeEntry[])
const timeEntriesField = this.mapping.timeEntries;
if (frontmatter[timeEntriesField] && Array.isArray(frontmatter[timeEntriesField])) {
  mapped.timeEntries = frontmatter[timeEntriesField];
}

// Read scheduled (existing)
const scheduledField = this.mapping.scheduled;
if (frontmatter[scheduledField]) {
  mapped.scheduled = String(frontmatter[scheduledField]);
}

// Compute scheduled from future time entries when present (new)
if (mapped.timeEntries && mapped.timeEntries.length > 0) {
  const now = new Date();
  const futureEntries = mapped.timeEntries
    .filter(e => new Date(e.startTime) > now)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

  if (futureEntries.length > 0) {
    const earliest = futureEntries[0];
    // Extract date (and optional time) from ISO startTime
    mapped.scheduled = earliest.startTime.includes("T")
      ? earliest.startTime.substring(0, 16)  // "2026-02-18T09:00"
      : earliest.startTime;                  // "2026-02-18"
  }
}
```

**In `mapToFrontmatter()` (~line 229):**
```typescript
// Write timeEntries (existing — now writes UnifiedTimeEntry[])
const timeEntriesField = this.mapping.timeEntries;
if (taskData.timeEntries && taskData.timeEntries.length > 0) {
  frontmatter[timeEntriesField] = taskData.timeEntries;

  // Denormalize scheduled for downgrade compatibility
  const now = new Date();
  const futureEntries = taskData.timeEntries
    .filter(e => new Date(e.startTime) > now)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

  if (futureEntries.length > 0) {
    const earliest = futureEntries[0];
    frontmatter[this.mapping.scheduled] = earliest.startTime.includes("T")
      ? earliest.startTime.substring(0, 16)
      : earliest.startTime;
  }
} else if (taskData.scheduled) {
  // No timeEntries — write scheduled directly (backward compat)
  frontmatter[this.mapping.scheduled] = taskData.scheduled;
}
```

### What This Achieves

- **0 changes** to filtering, sorting, grouping (FilterService, HierarchicalGroupingService)
- **0 changes** to NLP parsing (NaturalLanguageParser, InstantTaskConvertService)
- **0 changes** to Google Calendar sync (TaskCalendarSyncService)
- **0 changes** to recurring task logic (helpers.ts, TaskService completion handling)
- **0 changes** to reminders (NotificationService, ReminderContextMenu)
- **0 changes** to all UI modals (ScheduledDateModal, TaskModal, TaskEditModal, etc.)
- **0 changes** to context menus, task cards, editor decorations
- **0 changes** to API/MCP endpoints
- **0 changes** to templates, filename generators, folder processors
- **0 changes** to i18n locale files
- **0 changes** to 102 test files

---

## 7. API Changes

### 7A. Existing API — Automatic Support

The `PUT /api/tasks/:id` endpoint accepts `TaskInfo` properties. The `timeEntries` field already exists on `TaskInfo` — it now accepts `UnifiedTimeEntry[]` which is a superset of the old `TimeEntry[]`. No new endpoints needed.

External sync tools (SkedPal) can:
1. Write time entries (including future time blocks) via `PUT /api/tasks/:id` with `{ timeEntries: [...] }`
2. Continue writing `scheduled` directly — FieldMapper handles it

### 7B. Future: Dedicated Time Entry Management Endpoints (Optional)

```
GET    /api/tasks/:id/time-entries
POST   /api/tasks/:id/time-entries
PUT    /api/tasks/:id/time-entries/:entryId
DELETE /api/tasks/:id/time-entries/:entryId
```

Not required for initial implementation — the existing `PUT /api/tasks/:id` handles the full `timeEntries` array.

---

## 8. Migration Strategy

### Phase 1: This PR (Schema + FieldMapper + Storage Toggle + UI)

No automatic data migration. Everything is backward compatible:

- Tasks with `scheduled` and no future time entries: work exactly as before
- Tasks with future time entries: `scheduled` is computed, everything works
- Daily note timeblocks (legacy format): work as before via existing code path
- Storage toggle defaults to `"task"` — current behavior preserved

### Phase 2: User-Initiated Migration (Via Settings Toggle)

When a user changes the storage toggle, the migration mechanism (Section 4) moves their data. This is the migration path — user-initiated, shown with a confirmation modal, and can go in either direction. Also handles legacy `TimeBlock` format on daily notes by converting to `UnifiedTimeEntry`.

### Phase 3: External Sync Daemon Update (Post-PR)

Update SkedPal sync daemon to write time entries (including future blocks) via `PUT /api/tasks/:id` with `{ timeEntries: [...] }`. This is an external change, not a plugin code change.

---

## 9. File-by-File Change List

### Core Schema (3 files)

| File | Change |
|------|--------|
| `src/types.ts` | Add `UnifiedTimeEntry` interface (replaces `TimeEntry`). Add `DailyNoteTimeEntry` interface (extends `UnifiedTimeEntry` with `taskLink`). Update `timeEntries` type on `TaskInfo` and `TaskFrontmatter` from `TimeEntry[]` to `UnifiedTimeEntry[]`. Add `timeEntries?: DailyNoteTimeEntry[]` to `DailyNoteFrontmatter`. |
| `src/settings/defaults.ts` | Add `timeEntriesStorage: "task"` to `DEFAULT_SETTINGS`. |
| `src/types/settings.ts` | Add `timeEntriesStorage: "task" | "dailyNote"` to `TaskNotesSettings`. |

### FieldMapper — The Compatibility Layer (1 file)

| File | Change |
|------|--------|
| `src/services/FieldMapper.ts` | In `mapFromFrontmatter()`: compute `scheduled` from earliest future time entry. In `mapToFrontmatter()`: denormalize `scheduled` from earliest future time entry for downgrade compat. Handle `UnifiedTimeEntry` serialization (superset of old `TimeEntry`). |

### Settings UI (2 files)

| File | Change |
|------|--------|
| `src/main.ts` | Add `timeEntriesStorage` to settings loading (~line 1324). |
| `src/settings/tabs/featuresTab.ts` | Add `timeEntriesStorage` dropdown in Time Tracking section. Wire up confirmation modal + migration trigger on change. |

### Migration Service (2 new files)

| File | Change |
|------|--------|
| `src/services/TimeMigrationService.ts` **(NEW)** | Schema mapping functions (task↔dailyNote), legacy `TimeBlock` → `UnifiedTimeEntry` conversion, migration algorithms for both directions, progress tracking, error handling. |
| `src/modals/TimeMigrationConfirmationModal.ts` **(NEW)** | Confirmation modal with vault count preview, backup recommendation, progress bar, summary report. Pattern: extend existing `StorageLocationConfirmationModal`. |

### Calendar Rendering (2 files)

| File | Change |
|------|--------|
| `src/bases/calendar-core.ts` | Add `createUnifiedTimeEvents()`. Add `generateDailyNoteTimeEvents()`. Modify `generateCalendarEvents()` to branch on `timeEntriesStorage` setting. Update event type assignment (future = "timeblock", past = "timeEntry"). |
| `src/bases/CalendarView.ts` | Pass storage settings to event generation. Update click handlers: future clicks → "Create time block" option, past clicks → "Create time entry" option. Handle click on time block/entry → show info modal with task link. |

### UI — Task Modal Time Section (1-2 files)

| File | Change |
|------|--------|
| `src/modals/TaskModal.ts` | Add "Time" section showing historical time entries and future time blocks. Add inline creation for both. Visual past/future distinction. |
| `src/modals/TimeblockCreationModal.ts` | Refactor to create `UnifiedTimeEntry` objects. Check `timeEntriesStorage` setting for write target. Add task association field. Rename/restructure as needed. |

### Write Path (2 files)

| File | Change |
|------|--------|
| `src/services/TaskService.ts` | In `startTimeTracking()`/`stopTimeTracking()`: check `timeEntriesStorage` — write `UnifiedTimeEntry` to task file or daily note. Generate entry `id` field. |
| `src/utils/helpers.ts` | Add `validateUnifiedTimeEntry()` type guard. Add helper for writing time entries to task/daily note frontmatter based on storage setting. |

### MdBase Schema (1 file)

| File | Change |
|------|--------|
| `src/services/MdbaseSpecService.ts` | Update `timeEntries` field definition to reflect `UnifiedTimeEntry` schema: `{ id: string, startTime: datetime, endTime?: datetime, title?: string, color?: string, description?: string }`. |

### Internationalization (1+ files)

| File | Change |
|------|--------|
| `src/i18n/resources/en.ts` (+ other locales) | Add keys for storage toggle labels, migration modal text, "time block" vs "time entry" labels, task modal time section labels. |

### Tests (new test files)

| File | Change |
|------|--------|
| `tests/unit/services/FieldMapper.test.ts` | Add tests: `UnifiedTimeEntry` round-trip, computed `scheduled` from future entries, empty entries fallback, denormalized `scheduled` write, backward compat with old `TimeEntry` format. |
| `tests/unit/services/TimeMigrationService.test.ts` **(NEW)** | Tests for both migration directions, schema mapping, legacy `TimeBlock` conversion, edge cases (missing tasks, orphaned entries, active sessions). |
| `tests/unit/bases/calendar-core.test.ts` | Add tests: `createUnifiedTimeEvents()`, `generateDailyNoteTimeEvents()`, storage-aware branching, future/past event type labeling. |
| `tests/unit/utils/helpers.test.ts` | Add tests: `validateUnifiedTimeEntry()`. |

### No Changes Required (70+ files)

All files that only read `task.scheduled` — filtering, sorting, grouping, NLP, Google Calendar sync, recurring tasks, reminders, modals, context menus, task cards, editor decorations, API endpoints, MCP tools, templates, locale files, and 102 existing test files — require **zero changes** due to the FieldMapper compatibility layer.

---

## 10. UI/UX Design

Full UI/UX specifications are in [`docs/unified-time-ui-design.md`](./unified-time-ui-design.md). Summary of the five design areas:

### 10A. Calendar Click Behavior

**File:** `src/bases/CalendarView.ts` — `handleDateSelect()` (line 1629)

Currently shows three separate menu items (create task, create timeblock, create time entry) with no past/future distinction. Replace the two time-related items with a **single conditional item**:

- `info.start >= now` → **"Create time block"** (icon: `clock`)
- `info.start < now` → **"Create time entry"** (icon: `play`)

Remove the `enableTimeblocking` guard — time blocking is now integral to the unified system.

### 10B. Unified Time Info Modal (Click Existing Event)

**New file:** `src/modals/UnifiedTimeInfoModal.ts` (~350 lines)

Replaces both `TimeblockInfoModal` and `TimeEntryEditorModal` for single-entry viewing. Shows:
- Date & time range (read-only)
- Editable title, description, color
- Clickable task link (wikilink → opens task file)
- Delete / Cancel / Save buttons
- Heading: "Time Block" if future, "Time Entry" if past

**Storage-aware save:** Checks `settings.timeEntriesStorage` to write to task file or daily note.

**Event click handler** (`CalendarView.ts:1148`): Merge the two separate handlers (timeblock → `showTimeblockInfoModal`, timeEntry → `openTimeEntryEditor`) into one that opens `UnifiedTimeInfoModal`.

Existing `TimeblockInfoModal` and `TimeEntryEditorModal` are kept but marked deprecated.

### 10C. Task Modal "Time" Section

**File:** `src/modals/TaskEditModal.ts`

Add `createTimeSection()` called from `createAdditionalSections()`, positioned between completions calendar and metadata:

```
┌─────────────────────────────────────────┐
│ Time                                    │
│ UPCOMING                                │
│  ■ Feb 19, 09:00–11:30                  │  ← indigo dot, ascending by startTime
│    Sprint planning · in 2 days          │
│  [+ Add time block]                     │  ← indigo text
│ HISTORY                                 │
│  ● Feb 17, 10:15–12:00  (1h 45m)       │  ← green dot, descending by startTime
│    Initial draft · today                │
│  [+ Add time entry]                     │  ← green text
│ Total tracked: 3h 15m                   │
└─────────────────────────────────────────┘
```

- Click any entry → opens `UnifiedTimeInfoModal`
- "Add time block" defaults to tomorrow 09:00–10:00
- "Add time entry" defaults to now-1h to now
- Move "Total tracked time" from metadata section to here

### 10D. Unified Creation Flow

**File:** `src/bases/calendar-core.ts`

Replace `handleTimeblockCreation()` (line 1067) and `handleTimeEntryCreation()` (line 1098) with a single `handleUnifiedTimeEntryCreation(start, end, allDay, isFuture, plugin)`:

1. Open task selector (user picks which task)
2. Create `UnifiedTimeEntry` with selected times
3. Open `UnifiedTimeInfoModal` in creation mode (`isNew: true`) for optional title/description
4. Save via storage-aware path

From task modal: task is already known, so skip task selector — open `UnifiedTimeInfoModal` directly.

### 10E. Visual Design

| Type | Color | Hex | Border | CSS Variable |
|------|-------|-----|--------|-------------|
| Time block (future) | Indigo | `#6366f1` | Solid | `--tn-timeblock-color` |
| Time entry (past) | Green | `#10b981` | Dashed | `--tn-timeentry-color` |

Existing calendar CSS (`data-event-type` attributes + `applyTimeblockStyling()`) works with unified entries — no changes needed. New CSS classes added for task modal time section (~80 lines).

### 10F. UI File Changes Summary

| File | Change |
|------|--------|
| `src/modals/UnifiedTimeInfoModal.ts` **(NEW)** | ~350 lines. Single-entry info/edit/delete modal. |
| `src/bases/CalendarView.ts` | Merge context menu items + event click handlers |
| `src/bases/calendar-core.ts` | Add `handleUnifiedTimeEntryCreation()`, `showUnifiedTimeInfoModal()`. Deprecate old handlers. |
| `src/modals/TaskEditModal.ts` | Add `createTimeSection()` with entry list, add buttons, total |
| CSS (modal styles) | Add `.time-section-*` classes (~80 lines) |
| `src/i18n/resources/en.ts` | Add keys for time section, info modal, labels |
| `src/modals/TimeblockInfoModal.ts` | **Deprecated** — keep for legacy format |
| `src/modals/TimeblockCreationModal.ts` | **Deprecated** — keep for legacy format |
| `src/modals/TimeEntryEditorModal.ts` | **Keep** — still useful for bulk editing |

---

## 11. Implementation Sequence

1. **Types & interfaces** — `UnifiedTimeEntry`, `DailyNoteTimeEntry`, updated `TaskInfo`, `TaskFrontmatter`, `DailyNoteFrontmatter`
2. **FieldMapper** — `UnifiedTimeEntry` read/write + computed `scheduled` + denormalized write
3. **Defaults & settings** — Storage setting, `loadSettings()` update
4. **Validation** — `validateUnifiedTimeEntry()` in helpers
5. **MdbaseSpec** — Updated `timeEntries` schema definition
6. **TimeMigrationService** — Schema mapping functions + migration algorithms + legacy conversion
7. **TimeMigrationConfirmationModal** — Confirmation + progress UI
8. **Calendar core** — `createUnifiedTimeEvents()`, `generateDailyNoteTimeEvents()`, storage-aware branching
9. **CalendarView** — Click handling, future/past context menus, storage-aware event generation
10. **Task modal** — Time section with past entries + future blocks
11. **Write paths** — Storage-aware writes in creation modal, `TaskService`
12. **Settings UI** — Storage dropdown in `featuresTab.ts`
13. **i18n** — Translation keys
14. **Tests** — All new logic
