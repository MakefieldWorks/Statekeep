# Crash recovery and diagnostics

Statekeep keeps the open project in the main process. If the project renderer
crashes, a native recovery dialog offers to reload the window. A renderer that
stops responding offers **Wait** first. Unexpected helper-process exits are
logged and offer the same recovery path.

Recovery attempts to save the current project before reloading the UI. It does
not close or reopen the project: changes already received by the main process
remain in memory, and the reloaded renderer obtains that current state. If the
save fails (for example, because of an external edit or a full disk), a second
warning requires an explicit choice to reload while retaining the in-memory
project. Resolve the save/history warning before quitting. Text that was never
submitted to the app cannot be recovered.

Only one recovery prompt is active at a time. A clean process exit or a closed
project window does not trigger a prompt. Main-process crashes cannot display
this recovery dialog; reopen the app to load the last successfully saved project
and review any interrupted-history evidence.

## Privacy policy

Crash reporting is **local-only**. Statekeep does not enable Electron's crash
reporter, collect minidumps, or automatically upload crash reports or logs.
Process failures are recorded in the local logs. Raw local logs can include
paths and project metadata; **Help → Open Logs Folder** gives the user access
to those local files.

**Help → Copy Diagnostics** omits project, log, and user-data paths. It includes
the app/runtime versions, OS/architecture, Git availability, and whether a
project is open.

**Help → Export Diagnostics Bundle…** saves a single JSON file to a location
chosen by the user. It contains those diagnostics and the most recent 128 KiB
of each of the app, project, and Git logs. Only valid structural log entries
(timestamp, level, namespace, and event label) are exported. Raw lines and all
context fields, including paths, detailed errors, project names/content, and
command output, are omitted. Messages containing path/URL/email punctuation
are excluded. No project documents, archives, or credentials are attached.
Missing logs are marked unavailable. Review the exported file before sharing.

## Verification

Unit coverage checks bounded log export, omission of private context/raw lines,
recovery/save ordering, failed-save acknowledgement, prompt suppression, and
clean exits. `tests/e2e/recovery.e2e.ts` forces a real renderer crash and verifies
the recovered project and disk contents, and exercises Help diagnostics export.
Before a release, also check the native recovery and Save dialogs visibly on
each supported platform, including **Wait** and a failed-save warning.
