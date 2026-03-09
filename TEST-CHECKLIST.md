# Unified Time Architecture — Test Checklist

## Storage-Aware Writes (Workstream A)

### In "task" mode (default — should work exactly as before)
- [x] Start time tracking on a task — verify entry appears in task file frontmatter
- [x] Stop time tracking — verify endTime is set in task file
- [x] Edit a time entry via the unified modal — verify changes saved to task file
- [x] Delete a time entry via the unified modal — verify removed from task file

### In "dailyNote" mode (switch in settings)
- [x] Migration prompt appears when switching — run it
- [x] Migration shows progress (X of Y entries migrated, or percentage)
- [x] Start time tracking — verify entry appears on today's daily note (with taskLink), NOT on the task file
- [x] Stop time tracking — verify endTime updated on the daily note
- [x] Open Task Edit modal — verify the Time section loads and shows entries (lazy-loaded from daily notes)
- [x] Create a time block from the calendar for a future date — verify saved to that date's daily note
- [x] Delete an entry via the unified modal — verify removed from the daily note
- [x] Check the task file — `scheduled` field should be present (denormalized), but `timeEntries` should be absent
- [ ] Switch back to "task" mode — verify migration moves entries back to task files

## Calendar Flow Unification (Workstream B)

- [ ] Past entry creation: Right-click a past time slot on the calendar — "Create time entry" — should open the unified modal (with task picker inside), not the old task selector flow
- [ ] Future entry creation: Right-click a future time slot — "Create time block" — should open the unified modal
- [ ] No enableTimeblocking gate: The "Create time block/entry" menu item should always appear in the context menu, even if enableTimeblocking is off in settings
- [ ] Calendar event display: Time entries on the calendar should show entry titles (not just task titles) and support both past and future entries with correct colors
- [ ] Click an entry on the calendar: Should always open the unified modal — no fallback to the old bulk editor

## FieldMapper & Modal Fixes (Workstream C)

- [ ] Old entries without IDs (from before unified time architecture): open the calendar or task modal — they should now work with the unified modal instead of falling back to the legacy editor
- [ ] Editing an entry in the unified modal — save — verify it round-trips correctly

## Exclusive Time Tracking

- [x] Auto-stop: Start tracking task A, then start tracking task B — task A should auto-stop
- [x] Timestamp consistency: startTime and endTime should both use local timezone format (not UTC Z)
- [x] Overlap detection on edit: Edit a past entry to extend its time range into another entry — confirmation modal should appear listing affected entries
- [x] Overlap resolution: After confirming, overlapping entries should be adjusted (start/end pushed) or removed (if fully covered)
- [ ] Setting toggle: "Exclusive time tracking" in Settings > Features > Time Tracking — toggling off should disable both auto-stop and overlap detection

## Migration Issues (found during testing)

- [ ] FIX: Migration confirmation modal heading not left-aligned with text below it (padding issue)
- [ ] FIX: Migration shows no progress indicator — needs X of Y or percentage
- [ ] INVESTIGATE: "Failed to read the daily note template" error during migration — determine if plugin bug or vault config issue
