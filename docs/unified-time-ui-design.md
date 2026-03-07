# Unified Time Architecture — UI/UX Design Document

## Overview

This document specifies the UI/UX changes required to support the unified time architecture where time blocks (future) and time entries (past) share the same `UnifiedTimeEntry` data type. The design covers five areas: calendar click behavior, time block/entry info modal, task modal "Time" section, creation flows, and visual design.

---

## Implementation Status

### Completed

| Area | What was done | Key files |
|------|---------------|-----------|
| **UnifiedTimeInfoModal** | Full 665-line modal with CRUD, dynamic heading, NLP date input option, quick date buttons, color picker, task linking, Ctrl+Enter save | `src/modals/UnifiedTimeInfoModal.ts` |
| **Task modal "Time" section** | UPCOMING/HISTORY groups with indigo/green dots, add buttons, collapsible history (>5), total tracked time, click-to-edit, auto-refresh | `src/modals/TaskEditModal.ts` |
| **Calendar context menu** | Conditional menu item: future → "Create time block" (clock), past → "Create time entry" (play) | `src/bases/CalendarView.ts` |
| **Calendar event click** | Merged handlers — unified entries open UnifiedTimeInfoModal, legacy timeblocks converted to UnifiedTimeEntry format | `src/bases/CalendarView.ts:1150–1186` |
| **Kanban/TaskList/TaskCard** | Scheduled date chip click opens UnifiedTimeInfoModal instead of DateContextMenu | `src/bases/KanbanView.ts`, `src/bases/TaskListView.ts`, `src/ui/TaskCard.ts` |
| **Settings dropdown** | `timeEntriesStorage` dropdown ("task" / "dailyNote") with TimeMigrationConfirmationModal | `src/settings/tabs/featuresTab.ts` |
| **CSS** | All `.time-section-*` classes (~80 lines) | `styles/time-entry-editor-modal.css` |
| **i18n** | ~56 new keys for modals, migration, settings, time section | `src/i18n/resources/en.ts` |
| **Deprecation markings** | `@deprecated` on TimeblockInfoModal and TimeblockCreationModal | `src/modals/TimeblockInfoModal.ts`, `src/modals/TimeblockCreationModal.ts` |

### Remaining UI/UX Work

| # | Area | What needs to be done | Design doc section | Notes |
|---|------|----------------------|-------------------|-------|
| 1 | **Past entry creation flow** | `handleUnifiedTimeEntryCreation()` currently falls through to old `handleTimeEntryCreation()` for past entries (line 1350 of `calendar-core.ts`). Should use the unified modal flow with task selector instead. | Section 4 | The future path already opens UnifiedTimeInfoModal in creation mode; the past path should do the same. |
| 2 | **Remove `enableTimeblocking` guard** | `CalendarView.ts:1688` still gates the time entry menu item behind `enableTimeblocking`. The design doc says to remove this since time blocking is now integral to the unified system. | Section 1 | Guard is `enableTimeblocking \|\| info.start <= new Date()` — the past fallback works but the future path is still gated. |
| 3 | **Deprecate old creation functions** | `handleTimeblockCreation()` (line 1213) and `handleTimeEntryCreation()` (line 1244) in `calendar-core.ts` still exist and are called. Mark them `@deprecated` and migrate remaining callers to `handleUnifiedTimeEntryCreation()`. | Section 4 | `handleTimeEntryCreation` is still called from the past-entry branch of the unified function. |
| 4 | **Legacy entry fallback in event click** | `handleEventClick()` falls back to `openTimeEntryEditor()` for entries without an `id` (line 1166). Entries created by the old system lack IDs. Need a migration path or generate IDs on read. | Section 2 | Could add ID generation in FieldMapper when reading entries without IDs. |
| 5 | **Mark `TimeEntryEditorModal` deprecated** | `TimeblockInfoModal` and `TimeblockCreationModal` are marked deprecated but `TimeEntryEditorModal` is not. Design doc says to keep it for bulk editing but mark deprecated for single-entry use. | Section 2 | Still used by `main.ts:openTimeEntryEditor()` and as fallback in calendar event click. |
| 6 | **Storage-aware write paths** | Several write operations (calendar drag/resize, `TaskService.startTimeTracking`/`stopTimeTracking`) don't yet check `timeEntriesStorage` to route writes to task file vs daily note. | Architecture plan Section 5D | Currently all writes go to task files regardless of the setting. |
| 7 | **Daily note time event rendering** | `generateDailyNoteTimeEvents()` function described in architecture plan (Section 5C) for reading entries from daily notes when `timeEntriesStorage = "dailyNote"` — not yet implemented in calendar-core. | Architecture plan Section 5B/5C | Calendar currently only reads time entries from task files. |
| 8 | **NLP date input toggle** | Setting `nlpDateTimeInput` exists and the modal supports it, but there's no UI toggle in the settings tab to enable/disable it. | Section 2 (modal) | The modal code checks the setting but users can't change it via settings UI. |

---

## 1. Calendar Click Behavior

### Current Implementation

**File:** `src/bases/CalendarView.ts:1629–1719` — `handleDateSelect()`

Currently, selecting a time range on the calendar shows a context menu with:
1. **"Create task"** — always shown
2. **"Create timeblock"** — shown if `enableTimeblocking` is true (line 1661)
3. **"Create time entry"** — always shown (line 1672)
4. **"Create external calendar event"** — shown if external calendars are connected

The context menu currently does **not** distinguish between past and future selections — all three options always appear.

### Proposed Changes

**Modify `handleDateSelect()` in `src/bases/CalendarView.ts:1629`:**

Add past/future detection based on whether `info.start` is before or after `now`. Change the context menu to label the time-related option appropriately:

```
const now = new Date();
const isFuture = info.start >= now;
```

**Context menu changes:**

| Selection | Menu item | Label | Icon |
|-----------|-----------|-------|------|
| Future time slot | Time block option | "Create time block" | `clock` |
| Past time slot | Time entry option | "Create time entry" | `play` |
| Any slot | Task option | "Create task" | `check-square` |

**Specific code changes:**

1. **Replace the two separate menu items** (lines 1661–1679) with a **single conditional item**:

```typescript
// In handleDateSelect(), after "Create task" item:
const now = new Date();
const isFuture = info.start >= now;

menu.addItem((item) => {
    item.setTitle(isFuture ? "Create time block" : "Create time entry")
        .setIcon(isFuture ? "clock" : "play")
        .onClick(async () => {
            this.expectImmediateUpdate();
            await handleUnifiedTimeEntryCreation(
                info.start, info.end, info.allDay, isFuture, this.plugin
            );
        });
});
```

2. **Remove the `enableTimeblocking` guard** — time blocking is now integral to the unified system, not a separate feature toggle.

3. **Pre-populate the creation modal** with the selected time range — already handled by passing `info.start` and `info.end` to the creation function.

### Files to Modify

| File | Lines | Change |
|------|-------|--------|
| `src/bases/CalendarView.ts` | 1629–1719 | Replace two separate timeblock/time-entry menu items with one conditional item; add past/future detection |
| `src/bases/calendar-core.ts` | 1067–1168 | Replace `handleTimeblockCreation()` and `handleTimeEntryCreation()` with unified `handleUnifiedTimeEntryCreation()` |

---

## 2. Time Block/Entry Info Modal (Click Existing Event)

### Current Implementation

Two separate modals exist:

1. **`TimeblockInfoModal`** (`src/modals/TimeblockInfoModal.ts`) — shown when clicking a timeblock event on the calendar. Manages timeblock data on **daily note frontmatter** (`frontmatter.timeblocks[]`). Fields: title, description, color, attachments. Has edit + delete capability. 541 lines.

2. **`TimeEntryEditorModal`** (`src/modals/TimeEntryEditorModal.ts`) — shown when clicking a time entry event. Manages time entries on **task file frontmatter** (`task.timeEntries[]`). Shows a list of all time entries for that task with datetime-local inputs. 283 lines.

**Event click handler:** `CalendarView.ts:1148–1187` — `handleEventClick()`:
- Line 1153: `eventType === "timeblock"` → calls `showTimeblockInfoModal()`
- Line 1160: `eventType === "timeEntry"` → calls `plugin.openTimeEntryEditor()`

### Proposed Changes: Unified `UnifiedTimeInfoModal`

**Create a new modal** that replaces both existing modals. It should handle both time blocks (future) and time entries (past) with the same UI, just different labeling.

**Why a new modal instead of refactoring `TimeblockInfoModal`?**
- `TimeblockInfoModal` writes directly to daily note frontmatter via YAML parsing — the unified system needs to write via `TaskService.updateTask()` or daily note depending on the storage setting
- `TimeEntryEditorModal` shows a list of all entries — the new modal should show info for a **single** entry
- Both are ~300-500 lines of tightly coupled code; a new modal is cleaner

**New file:** `src/modals/UnifiedTimeInfoModal.ts`

**Constructor parameters:**
```typescript
interface UnifiedTimeInfoModalOptions {
    entry: UnifiedTimeEntry;          // The entry to view/edit
    taskInfo?: TaskInfo;              // The associated task (if stored on task)
    dailyNoteEntry?: DailyNoteTimeEntry; // The daily note entry (if stored on daily note)
    plugin: TaskNotesPlugin;
    onChange?: () => void;            // Callback after save/delete
}
```

**Modal layout:**

```
┌─────────────────────────────────────────┐
│ [clock icon] Time Block                 │  ← or "Time Entry" if past
│ ─────────────────────────────────────── │
│ Date & Time: Feb 18, 2026 09:00–11:30  │  ← read-only display
│                                         │
│ Title: [________________]               │  ← editable text input
│                                         │
│ Description: [_________________]        │  ← editable textarea
│              [_________________]        │
│                                         │
│ Color: [■ #6366f1]                      │  ← color picker
│                                         │
│ Task: [[Write Q1 report]] →             │  ← clickable link to task (opens task)
│                                         │  ← or task selector if creating from calendar
│ ─────────────────────────────────────── │
│ [Delete]              [Cancel] [Save]   │
└─────────────────────────────────────────┘
```

**Key differences from current `TimeblockInfoModal`:**
- **Task link** field: Shows the associated task as a clickable wikilink. Click opens the task file. If creating from calendar (no task yet), shows a task selector button.
- **No "attachments" field**: Unified entries don't have attachments — that was a legacy timeblock concept. The task file itself is the attachment.
- **Storage-aware save**: Checks `settings.timeEntriesStorage` to write to task file or daily note.
- **Heading label**: "Time Block" if `startTime` is in the future, "Time Entry" if in the past.

**Event click handler changes in `CalendarView.ts:1148–1163`:**

Replace the two separate handlers with one:

```typescript
// Handle unified time entry click (both timeblock and timeEntry)
if ((eventType === "timeblock" || eventType === "timeEntry") &&
    info.event.extendedProps.unifiedTimeEntry) {
    const entry = info.event.extendedProps.unifiedTimeEntry;
    const taskInfo = info.event.extendedProps.taskInfo;
    showUnifiedTimeInfoModal(entry, taskInfo, this.plugin, () => this.expectImmediateUpdate());
    return;
}
```

### Files to Modify/Create

| File | Change |
|------|--------|
| `src/modals/UnifiedTimeInfoModal.ts` **(NEW)** | ~300 lines. Single-entry info/edit/delete modal. Storage-aware save. Task link display. |
| `src/bases/CalendarView.ts` | Lines 1148–1163: Merge timeblock and timeEntry click handlers into one |
| `src/bases/calendar-core.ts` | Add `showUnifiedTimeInfoModal()` export (replaces `showTimeblockInfoModal()`) |
| `src/modals/TimeblockInfoModal.ts` | **Keep for now** — still needed for legacy daily note timeblocks until migration. Mark as deprecated. |
| `src/modals/TimeEntryEditorModal.ts` | **Keep for now** — still used by `openTimeEntryEditor()` in `main.ts:2805` for bulk editing. Can be refactored later. |

---

## 3. Task Modal "Time" Section

### Current Implementation

**`TaskModal.ts`** (abstract base) defines the modal layout in `createModalContent()` (line 541):

```
splitLeftColumn:
  ├── Primary input (title or NLP)
  ├── Action bar (due, scheduled, status, priority, recurrence, reminders)
  ├── Details container (title in edit mode, fields: contexts, tags, time estimate, projects, subtasks, dependencies)
  └── Additional sections (hook for subclasses)

splitRightColumn:
  └── Details editor (markdown)

Bottom:
  └── Action buttons (Open note, Save, Cancel)
```

**`TaskEditModal.ts`** overrides `createAdditionalSections()` (line 323) to add:
1. Completions calendar section (for recurring tasks)
2. Metadata section (tracked time total, created/modified dates, file path)

**Existing time display:** The metadata section (line 448) shows `calculateTotalTimeSpent()` as a single line ("Total tracked time: 2h 30m"). No individual entries are shown.

### Proposed Changes: Add "Time" Section

Add a new `createTimeSection()` method to `TaskEditModal`, called from `createAdditionalSections()`.

**Position in modal:** Between the completions calendar and the metadata section:

```typescript
protected createAdditionalSections(container: HTMLElement): void {
    this.createCompletionsCalendarSection(container);
    this.createTimeSection(container);  // NEW
    this.createMetadataSection(container);
}
```

**Section layout:**

```
┌─────────────────────────────────────────┐
│ Time                                    │
│ ─────────────────────────────────────── │
│                                         │
│ UPCOMING (future time blocks)           │
│ ┌─────────────────────────────────────┐ │
│ │ ■ Feb 19, 09:00–11:30              │ │  ← indigo dot
│ │   Sprint planning                   │ │  ← entry title (or task title fallback)
│ │   in 2 days                         │ │  ← relative date
│ ├─────────────────────────────────────┤ │
│ │ ■ Feb 20, 14:00–16:00              │ │
│ │   Code review session               │ │
│ │   in 3 days                         │ │
│ └─────────────────────────────────────┘ │
│ [+ Add time block]                      │  ← button, indigo text
│                                         │
│ HISTORY (past time entries)             │
│ ┌─────────────────────────────────────┐ │
│ │ ● Feb 17, 10:15–12:00  (1h 45m)   │ │  ← green dot
│ │   Initial draft                     │ │
│ │   today                             │ │
│ ├─────────────────────────────────────┤ │
│ │ ● Feb 15, 09:00–10:30  (1h 30m)   │ │
│ │   Research                          │ │
│ │   2 days ago                        │ │
│ └─────────────────────────────────────┘ │
│ [+ Add time entry]                      │  ← button, green text
│                                         │
│ Total tracked: 3h 15m                   │  ← summary line
└─────────────────────────────────────────┘
```

**Implementation details:**

```typescript
private createTimeSection(container: HTMLElement): void {
    const timeEntries = this.task.timeEntries || [];

    // Only show section if there are entries or the feature is enabled
    if (timeEntries.length === 0 && !this.plugin.settings.calendarViewSettings.enableTimeblocking) {
        return;
    }

    const timeContainer = container.createDiv("time-section-container");

    // Section header with separator
    container.createEl("hr", { cls: "task-modal__section-separator" });
    const timeLabel = timeContainer.createDiv("detail-label");
    timeLabel.textContent = "Time";  // i18n key: modals.taskEdit.sections.time

    const now = new Date();

    // Split entries into future (time blocks) and past (time entries)
    const futureEntries = timeEntries
        .filter(e => new Date(e.startTime) > now)
        .sort((a, b) => a.startTime.localeCompare(b.startTime));  // ascending (soonest first)

    const pastEntries = timeEntries
        .filter(e => new Date(e.startTime) <= now)
        .sort((a, b) => b.startTime.localeCompare(a.startTime));  // descending (most recent first)

    // Render future time blocks
    if (futureEntries.length > 0) {
        this.renderTimeEntryGroup(timeContainer, "Upcoming", futureEntries, "future");
    }

    // "Add time block" button
    this.createAddTimeButton(timeContainer, "Add time block", "future");

    // Render past time entries
    if (pastEntries.length > 0) {
        this.renderTimeEntryGroup(timeContainer, "History", pastEntries, "past");
    }

    // "Add time entry" button
    this.createAddTimeButton(timeContainer, "Add time entry", "past");

    // Total tracked time summary
    const totalMinutes = calculateTotalTimeSpent(pastEntries);
    if (totalMinutes > 0) {
        const totalDiv = timeContainer.createDiv("time-section__total");
        totalDiv.textContent = `Total tracked: ${formatTime(totalMinutes)}`;
    }
}
```

**Entry rendering (`renderTimeEntryGroup`):**

Each entry row shows:
- **Color dot**: indigo (`#6366f1`) for future, green (`#10b981`) for past
- **Date & time range**: e.g., "Feb 19, 09:00–11:30"
- **Duration**: e.g., "(1h 30m)" — only for past entries with endTime
- **Title**: entry title or "(no title)"
- **Relative date**: e.g., "in 2 days", "today", "3 days ago" — using Obsidian's moment
- **Click handler**: Opens `UnifiedTimeInfoModal` for that entry
- **Delete button**: Small × button on hover

**"Add time block/entry" button behavior:**

When clicked from the task modal:
- Task is already known (no task selector needed)
- Opens a lightweight inline form or a small modal with: start datetime, end datetime, title, description
- Pre-populates start time: for "Add time entry" → now minus 1 hour to now; for "Add time block" → tomorrow at 09:00 to 10:00
- Saves via `TaskService.updateTask()` (appends to `timeEntries[]`)

### Files to Modify

| File | Lines | Change |
|------|-------|--------|
| `src/modals/TaskEditModal.ts` | 323–326 | Add `this.createTimeSection(container)` call in `createAdditionalSections()` |
| `src/modals/TaskEditModal.ts` | new method | Add `createTimeSection()`, `renderTimeEntryGroup()`, `renderTimeEntryRow()`, `createAddTimeButton()` methods (~150 lines) |
| `src/modals/TaskEditModal.ts` | 448–492 | Remove the "Total tracked time" line from `createMetadataSection()` — it moves to the Time section |

---

## 4. Creation Flow

### Current Creation Flows

| Source | What's created | Modal used | Where data is written |
|--------|---------------|------------|----------------------|
| Calendar drag → "Create timeblock" | Legacy `TimeBlock` | `TimeblockCreationModal` | Daily note `timeblocks[]` |
| Calendar drag → "Create time entry" | `TimeEntry` | Task selector + inline save | Task file `timeEntries[]` |
| Calendar drag → "Create task" | Full task | `TaskCreationModal` | Task file (new file) |

### Proposed Unified Creation Flow

**From calendar (time range selected):**

Replace `handleTimeblockCreation()` and `handleTimeEntryCreation()` with a single `handleUnifiedTimeEntryCreation()`:

```typescript
export async function handleUnifiedTimeEntryCreation(
    start: Date,
    end: Date,
    allDay: boolean,
    isFuture: boolean,
    plugin: TaskNotesPlugin
): Promise<void> {
    if (allDay) {
        new Notice("Time entries must have specific times. Use week or day view.");
        return;
    }

    // Open task selector first — user picks which task this time belongs to
    const allTasks = await plugin.cacheManager.getAllTasks();
    const unarchivedTasks = allTasks.filter(t => !t.archived);

    openTaskSelector(plugin, unarchivedTasks, async (selectedTask) => {
        if (!selectedTask) return;

        const newEntry: UnifiedTimeEntry = {
            id: generateTimeEntryId(),
            startTime: start.toISOString(),
            endTime: end.toISOString(),
            title: "",
            description: "",
        };

        // Optionally show info modal for additional details
        showUnifiedTimeInfoModal(newEntry, selectedTask, plugin, () => {
            plugin.emitter.trigger(EVENT_DATA_CHANGED);
        }, { isNew: true });
    });
}
```

**From task modal ("Add time block" / "Add time entry" button):**

Task is already known. Show a minimal creation form:

```typescript
private createAddTimeButton(container: HTMLElement, label: string, type: "future" | "past"): void {
    const btn = container.createEl("button", {
        text: `+ ${label}`,
        cls: `time-section__add-button time-section__add-button--${type}`,
    });

    btn.addEventListener("click", () => {
        const now = new Date();
        let startTime: Date, endTime: Date;

        if (type === "future") {
            // Default: tomorrow 09:00–10:00
            startTime = new Date(now);
            startTime.setDate(startTime.getDate() + 1);
            startTime.setHours(9, 0, 0, 0);
            endTime = new Date(startTime);
            endTime.setHours(10, 0, 0, 0);
        } else {
            // Default: now-1h to now
            endTime = new Date(now);
            startTime = new Date(now.getTime() - 60 * 60 * 1000);
        }

        const newEntry: UnifiedTimeEntry = {
            id: generateTimeEntryId(),
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
        };

        // Open info modal in creation mode
        const modal = new UnifiedTimeInfoModal(this.plugin.app, {
            entry: newEntry,
            taskInfo: this.task,
            plugin: this.plugin,
            isNew: true,
            onChange: () => {
                // Refresh the time section
                this.refreshTimeSection();
            },
        });
        modal.open();
    });
}
```

### Approach: Refactor or New?

**Recommendation: New unified function + keep `TimeblockCreationModal` as deprecated.**

- `TimeblockCreationModal` writes directly to daily note YAML — this is the legacy path
- The new flow uses `UnifiedTimeInfoModal` for both creation and editing
- `TimeblockCreationModal` can remain for backward compatibility until legacy timeblock format is fully migrated

### Files to Modify/Create

| File | Change |
|------|--------|
| `src/bases/calendar-core.ts` | Replace `handleTimeblockCreation()` (line 1067) and `handleTimeEntryCreation()` (line 1098) with `handleUnifiedTimeEntryCreation()`. Keep old functions but mark deprecated. |
| `src/modals/UnifiedTimeInfoModal.ts` | Support `isNew: true` mode where Save creates instead of updates |
| `src/modals/TimeblockCreationModal.ts` | Mark as deprecated. Keep for legacy daily note timeblock creation if needed. |

---

## 5. Visual Design

### Color System

| Type | Color | Hex | CSS Variable | Border Style | Usage |
|------|-------|-----|-------------|-------------|-------|
| Time block (future) | Indigo | `#6366f1` | `--tn-timeblock-color` | Solid, 2px | Calendar events, dots in task modal |
| Time entry (past) | Green | `#10b981` | `--tn-timeentry-color` | Dashed, 2px | Calendar events, dots in task modal |

These colors match the existing calendar event styling:
- `calendar-core.ts:821` — timeblock default color is `#6366f1`
- `calendar-core.ts:528` — time entry colors handled via `data-event-type="timeEntry"` CSS

### Calendar Event Styling

**Existing (keep):**
- `applyTimeblockStyling()` at `calendar-core.ts:1273`: solid border, `fc-timeblock-event` class
- Time entries use `data-event-type="timeEntry"` for CSS-based styling

**Change:** Update `createUnifiedTimeEvents()` (new function from architecture plan Section 5B) to set the correct event type based on future/past:

```typescript
extendedProps: {
    eventType: isFuture ? "timeblock" : "timeEntry",
    // ...
}
```

This ensures existing CSS rules apply correctly without changes.

### Task Modal Time Section Styling

**New CSS classes** (add to existing modal CSS file):

```css
/* Time section container */
.time-section-container {
    margin-top: 8px;
}

/* Group header (Upcoming / History) */
.time-section__group-header {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin: 12px 0 4px 0;
}

/* Individual time entry row */
.time-section__entry {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 4px;
    cursor: pointer;
    transition: background-color 0.1s ease;
}

.time-section__entry:hover {
    background-color: var(--background-modifier-hover);
}

/* Color indicator dot */
.time-section__dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-top: 5px;
    flex-shrink: 0;
}

.time-section__dot--future {
    background-color: #6366f1;
}

.time-section__dot--past {
    background-color: #10b981;
}

/* Entry info */
.time-section__entry-info {
    flex: 1;
    min-width: 0;
}

.time-section__entry-time {
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--text-normal);
}

.time-section__entry-duration {
    font-size: 0.8rem;
    color: var(--text-muted);
    margin-left: 4px;
}

.time-section__entry-title {
    font-size: 0.8rem;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.time-section__entry-relative {
    font-size: 0.75rem;
    color: var(--text-faint);
}

/* Add button */
.time-section__add-button {
    background: none;
    border: 1px dashed var(--background-modifier-border);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 0.8rem;
    cursor: pointer;
    margin: 4px 0;
    width: 100%;
    text-align: left;
}

.time-section__add-button--future {
    color: #6366f1;
}

.time-section__add-button--past {
    color: #10b981;
}

.time-section__add-button:hover {
    background-color: var(--background-modifier-hover);
}

/* Total tracked summary */
.time-section__total {
    font-size: 0.8rem;
    color: var(--text-muted);
    padding: 8px 0 4px 0;
    border-top: 1px solid var(--background-modifier-border);
    margin-top: 8px;
}
```

### Sorting in Task Modal

- **Future entries (Upcoming):** Ascending by `startTime` — soonest first
- **Past entries (History):** Descending by `startTime` — most recent first
- **Grouping:** Optionally group by date if many entries, but start without grouping for simplicity

### Info Modal Styling

The `UnifiedTimeInfoModal` should use existing Obsidian modal patterns:
- CSS class: `unified-time-info-modal`
- Use `Setting` components for form fields (consistent with `TimeblockInfoModal`)
- Header changes color based on type: indigo heading for future, green heading for past
- Minimal additional CSS needed — leverage existing `.timeblock-info-modal` styles

---

## 6. Summary of All File Changes

### New Files

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `src/modals/UnifiedTimeInfoModal.ts` | View/edit/delete a single `UnifiedTimeEntry`. Storage-aware save. Task link. | ~350 |

### Modified Files

| File | Key Changes |
|------|-------------|
| `src/bases/CalendarView.ts` | `handleDateSelect()`: merge timeblock/time-entry menu into one conditional item with past/future detection. `handleEventClick()`: merge timeblock/timeEntry handlers. |
| `src/bases/calendar-core.ts` | Add `handleUnifiedTimeEntryCreation()`, `showUnifiedTimeInfoModal()`. Deprecate `handleTimeblockCreation()`, `handleTimeEntryCreation()`, `showTimeblockInfoModal()`. |
| `src/modals/TaskEditModal.ts` | Add `createTimeSection()` with entry list, add buttons, and total. Call from `createAdditionalSections()`. Remove tracked time from metadata section. |
| CSS (modal styles) | Add `.time-section-*` classes for task modal time section (~80 lines) |
| `src/i18n/resources/en.ts` | Add keys: `modals.taskEdit.sections.time`, `modals.timeInfo.*`, time section labels |

### Deprecated (Keep but Mark)

| File | Reason |
|------|--------|
| `src/modals/TimeblockInfoModal.ts` | Replaced by `UnifiedTimeInfoModal`. Keep for legacy daily note timeblock format. |
| `src/modals/TimeblockCreationModal.ts` | Replaced by unified creation flow. Keep for legacy format. |
| `src/modals/TimeEntryEditorModal.ts` | Keep — still useful for bulk time entry editing from command palette. |

### No Changes Needed

| File | Why |
|------|-----|
| `src/modals/TaskModal.ts` | Abstract base — the `createAdditionalSections()` hook already supports extension. No changes needed. |
| `src/modals/TaskCreationModal.ts` | Task creation modal doesn't need a time section — time entries are added after task exists. |
| Existing CSS for calendar events | `data-event-type` attribute + existing timeblock/timeEntry CSS rules work with unified entries. |

---

## 7. Implementation Sequence

1. **`UnifiedTimeInfoModal`** — New modal for viewing/editing single entries (standalone, testable)
2. **Calendar click behavior** — Merge context menu items, add past/future detection
3. **Calendar event click** — Update `handleEventClick()` to use `UnifiedTimeInfoModal`
4. **Task modal Time section** — Add `createTimeSection()` to `TaskEditModal`
5. **Creation flow unification** — `handleUnifiedTimeEntryCreation()` in `calendar-core.ts`
6. **CSS** — Add time section styles
7. **i18n** — Add translation keys

Steps 1-3 can be done together as they form the "calendar interaction" unit. Steps 4-5 form the "task modal" unit. Steps 6-7 are cross-cutting.
