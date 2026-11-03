# Time Management

TaskNotes includes features for time tracking and productivity, such as a time tracker and a Pomodoro timer.

## Time Tracking

TaskNotes has a time tracker to record the time spent on each task. Time tracking information is stored in the `timeEntries` array within each task's YAML frontmatter. Each time entry includes a start time and an end time.

Use **TaskNotes: Start time tracking for current task** and **TaskNotes: Stop time tracking for current task** from the Command Palette, hotkeys, or command-based plugins such as Buttons. These commands act on the currently open task note, not on a task link under the cursor, and do not open a selector. Starting an already running timer or stopping an inactive timer leaves entries unchanged and shows a notice. To track another task, use **TaskNotes: Start time tracking (select task)**.

The time tracking interface includes controls to start and stop tracking in task views and task cards. TaskNotes prevents duplicate active sessions on the same task. Active sessions on different tasks can exist at the same time, and total time spent on each task is calculated from completed sessions.

### Stop an Active Tracker Without Opening Its Note

Use **TaskNotes: Stop active time tracking**, or the square stop button beside the tracking timer in the desktop status bar. With one active tracker, the action stops it directly. With several, it opens a selector containing active tasks so you can stop one; cancelling leaves every tracker running. The selector cannot create new tasks. Other trackers keep running.

The command does not depend on the currently open note and can also be assigned a hotkey. The status bar's task title still opens the tracked note, while the stop button only stops tracking. If a task is deleted or its tracker stops before you choose it, no new time entry is created.

### Auto-Stop Time Tracking

TaskNotes can automatically stop time tracking when a task is marked as completed. This feature ensures that time tracking data accurately reflects work completion without requiring manual timer management.

The auto-stop feature works by monitoring task status changes across all views and interfaces. When a task's status changes from any non-completed state to a completed state (as defined by the custom status configuration), any active time tracking session for that task is automatically terminated.

**Configuration Options:** Configure these under `Settings -> TaskNotes -> Features` (Time Tracking section).

- **Auto-stop tracking** - Enable or disable the automatic stopping behavior (enabled by default)
- **Completion notification** - Show a notice when auto-stop occurs (disabled by default)

**Behavior:**

- Monitors all task status changes in real-time
- Stops only the specific task that was completed (other active timers continue)
- Preserves the recorded time data in the task's time entries
- Works with both standard and recurring task completions
- Functions across all task views (list, kanban, calendar, etc.)

The feature integrates with the custom status system, so completion detection respects your configured workflow statuses rather than relying on hardcoded completion states.

### Recurring tasks

On a recurring task, each time entry counts toward one occurrence and records it in `occurrence`, the occurrence's rule date. By default, that is the occurrence whose period contains the entry's start. A period runs from one occurrence to the next: a day for a daily task, a week for a weekly one. For "after completion" rules, it is the occurrence the task currently shows. Logging time never completes an occurrence; only marking it done does.

A recurring task's time estimate is the length of each occurrence. Its card shows progress for the occurrence the task shows, for example "1 hr logged of 5 hr estimated this occurrence". The time entry editor groups its entries by occurrence. To log time without clock times, clear an entry's start time and enter its duration. **Total tracked time** in Bases, Stats and the API stays the total across all occurrences.

```yaml
timeEntries:
  - startTime: 2026-02-03T09:00:00Z
    endTime: 2026-02-03T10:00:00Z
    occurrence: 2026-02-02
  # Time logged without clock times: start and end hold the same local midnight, and minutes holds the length
  - startTime: 2026-02-04T00:00
    endTime: 2026-02-04T00:00
    minutes: 60
    occurrence: 2026-02-02
```

Generated Bases files include `currentOccurrence` (the rule date of the occurrence a recurring task shows) and `timeTrackedThisOccurrence`. To sum a specific occurrence in your own formula, filter on its date, for example `list(timeEntries).filter(value.occurrence && date(value.occurrence).format("YYYY-MM-DD") == "2026-02-02")`.

## Pomodoro Timer

TaskNotes also includes a Pomodoro timer, which is a tool for time management that uses a timer to break down work into intervals, separated by short breaks. The Pomodoro timer in TaskNotes has a dedicated view with controls to start, stop, and reset the timer.

When a task is associated with a Pomodoro session, TaskNotes starts a task tracker if none is already running. Pomodoro only stops trackers it created; a pre-existing manual tracker is left running. After sleep or a delayed timer tick, a completed Pomodoro-owned tracker ends at the session's intended completion time, rather than the wake-up time.

## Productivity Analytics

The **Pomodoro Stats View** provides analytics and historical data about your Pomodoro sessions. This includes a history of completed sessions, as well as metrics like completion rates and total time spent on tasks. The data can be visualized to show productivity patterns over time.

![Task Statistics](../assets/feature-task-statistics.png)
