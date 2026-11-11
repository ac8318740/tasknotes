# TaskNotes - Unreleased

<!--

**Added** for new features.
**Changed** for changes in existing functionality.
**Deprecated** for soon-to-be removed features.
**Removed** for now removed features.
**Fixed** for any bug fixes.
**Security** in case of vulnerabilities.

Always acknowledge contributors and those who report issues.

Example:

```
## Fixed

- (#768) Fixed calendar view appearing empty in week and day views due to invalid time configuration values
  - Added time validation in settings UI with proper error messages and debouncing
  - Prevents "Cannot read properties of null (reading 'years')" error from FullCalendar
  - Thanks to @userhandle for reporting and help debugging
```

When a change has user-facing documentation, include a canonical tasknotes.dev link:

```
## Added

- Added materialized occurrence notes for recurring tasks. See [Recurring Tasks](https://tasknotes.dev/features/recurring-tasks/#materialized-occurrence-notes) for setup and calendar behavior.
```

-->

## Added

- In the natural language field, Backspace right after a highlighted word or phrase turns it back into plain title text. For example, "by December groceries" then no longer sets a date. The next Backspace deletes as usual. See [Highlighting in Natural Language Input](https://tasknotes.dev/features/task-management/#highlighting-in-natural-language-input).
- (#2483) Task pickers list a recurring task once, even when it has occurrence notes. The row shows how many occurrence notes it has; press Tab or click the count to list them, newest first. Searching for a month or day, such as `2026-06`, also finds them. See [Materialized Occurrence Notes](https://tasknotes.dev/features/recurring-tasks/#materialized-occurrence-notes).
- (#2491) Added a **Vault time zone** setting under **Settings → TaskNotes → General**, so a vault synced between devices in different time zones, or used while travelling, keeps one idea of today and of task times. TaskNotes uses it for day boundaries, stored times, calendars, reminders, time tracking and statistics. Changing it updates timed `due` and `scheduled` values on non-recurring tasks, absolute reminders and timeblocks so they keep the same moment; dates without a time and recurring tasks stay as they are. Formulas in Bases still use the device's time zone. See [General settings](https://tasknotes.dev/settings/general/#time-zone).
- (#2479) You can now pin timeblocks linked to a task: right-click a timeblock in the calendar, or use the **Pinned** toggle in its edit modal. TaskNotes shows a pin icon and stores `pinned: true` on the timeblock in the daily note. See [Pinned timeblocks](https://tasknotes.dev/features/calendar-integration/#pinned-timeblocks).
- (#1065) Time logged on a recurring task now counts toward one occurrence. Each time entry records its occurrence's rule date in `occurrence`. That is the occurrence whose week, month or other period contains the entry's start, or, for "after completion" rules, the occurrence the task shows. A recurring task's estimate is the length of each occurrence. Its card shows progress such as "1 hr logged of 5 hr estimated this occurrence", and **Total tracked time** stays the all-time total. Cards now say "logged" instead of "tracked". Time entries can also hold time logged without clock times, as `minutes` on an entry whose start and end are the same local midnight. See [Time Management](https://tasknotes.dev/features/time-management/#recurring-tasks)
  - The time entry editor shows one aligned row per entry with its date, start and end times, and duration. Clear the start time to log a duration without clock times. A recurring task's entries are grouped by occurrence, each with its progress against the estimate
  - Generated Bases files add `currentOccurrence` and `timeTrackedThisOccurrence` formulas, and `timeRemaining` and `efficiencyRatio` compare a recurring task's estimate with the current occurrence's time. All time formulas count `minutes` entries. Existing Bases files keep their formulas until regenerated
- (#2474) Added recurring tasks that need one occurrence per week or month on any day (`recurrence_anchor: period`), such as "water the plants once a week". Completing on any day of the period counts for that period, missed periods are not carried forward, and a `due` date stays on the period's last day. Choose **Once a week, any day** or **Once a month, any day** in the recurrence menu. See [Once per period, any day](https://tasknotes.dev/features/recurring-tasks/#once-per-period-any-day).
- (#2476) Recurring tasks can keep each occurrence open for a number of days with `recurrence_window`, for example every month on the 15th, any time up to the 22nd (`recurrence_window: 8`), or until the end of the month (`recurrence_window: month_end`). Completing on any day in the window counts for that occurrence, the occurrence stays next until its window closes, and `due` is set to the window's last day, so it becomes overdue only after the window. See [Occurrence windows](https://tasknotes.dev/features/recurring-tasks/#occurrence-windows).

## Fixed

- (#1065) New time entries on recurring tasks now require an occurrence. If TaskNotes cannot determine one, interactive timers and the time entry editor ask you to choose; cancelling leaves the entry unsaved. API and command-line callers can supply an explicit occurrence date. Editing an entry's clock times keeps its allocation; use **Change occurrence** to move it. The status bar shows the active timer's occurrence. Existing entries keep their recorded occurrence, or lack of one.
- (#2482) Fixed open calendars not showing timeblock changes made outside TaskNotes (for example by a sync tool or a hand edit to a daily note) until refreshed.
- (#2481) Fixed the timeblock edit modal dropping attachments written as links without `.md` (for example `[[Tasks/Write report]]`) when saving. Existing links now keep their original text.
