# Desktop Workspace State

Statekeep stores app-level workspace state under Electron `userData`.

- Window bounds, maximized state, and fullscreen state are restored on launch.
  Bounds are ignored if they no longer intersect a current display work area.
- Tree and snapshot pane widths are restored in the renderer and clamped to the
  same ranges used by drag resize.
- The last Open Project and Create Project directories are reused as dialog
  defaults.
- Statekeep does not auto-open the last project. The welcome screen shows a
  one-click Reopen action when the last project still exists, while the File >
  Open Recent menu remains available for broader recent-project history.

## Window model

Statekeep is a single-window app with one open project at a time. The main
process owns one `ProjectManager`, and the only other window is Settings.

- A second launch does not start another instance. `requestSingleInstanceLock`
  sends its arguments to the running app, which focuses the main window and
  opens any project path it was given.
- Opening another project (File > Open, Open Recent, a double-clicked
  `.statekeep`, or the macOS `open-file` event) saves the current project
  first and then replaces it in the same window.

Multiple windows would need per-window project state in the main process and
per-window IPC routing. That is deferred until there is a concrete need.
