# Keyboard, focus, contrast, and motion QA

## Implemented behavior

- `Cmd/Ctrl+W` closes the native window. `Cmd/Ctrl+Shift+W` closes only the project and returns to the project hub.
- Add Child: `Cmd/Ctrl+Enter`; Add Sibling: `Cmd/Ctrl+Shift+Enter`.
- Move Up/Down: `Cmd/Ctrl+Alt+Up/Down`; Move To: `Cmd/Ctrl+Shift+M`; Delete: `Cmd/Ctrl+Backspace` (existing confirmation still applies).
- Create Snapshot: `Cmd/Ctrl+Alt+S`; Compare Snapshots: `Cmd/Ctrl+Alt+C`. These open the snapshot panel and focus the relevant input so users can review before acting.
- Structural node commands are disabled while editing text or working in another dialog. Root-level sibling/move/delete commands are disabled.
- Custom dialogs use `lib/modal-focus.ts` to focus the first editable control (or first button), contain Tab/Shift+Tab, make the background inert, and restore the opener. Native `dialog.showModal()` components use browser focus handling. Escape dismisses a dialog when an operation is not busy.
- Tree rows expose explicit levels, sibling positions, and sibling counts because the virtualized DOM cannot infer hierarchy. Arrow keys navigate; Right expands or enters children; Left collapses or returns to the parent; Home/End move to the first/last visible item; Enter selects; Space toggles a selection. Typing searches the tree.
- Shift+F10/the context-menu key opens node actions. Up/Down/Home/End navigate the menu; Enter activates; Escape/Tab close and return focus to the tree.
- A persistent polite status region announces project toasts.
- Reduced-motion preference suppresses global CSS transitions/animations as well as the existing tree lens animation handling.
- Increased contrast strengthens secondary text and control borders. Forced colors uses system selection/focus colors. Readable faint/muted/body text tokens meet 4.5:1 on primary surfaces in all four built-in themes.

## Automated checks

Run `bun run build`, then `bunx playwright test tests/e2e/keyboard-accessibility.e2e.ts tests/e2e/menu.e2e.ts`.

The keyboard smoke opens an example project, edits a node through the context menu, searches, and saves a snapshot without mouse input. Other checks exercise modal Tab containment/restoration, tree hierarchy semantics, and reduced-motion/forced-colors emulation. The visual capture test attaches light, dark, and high-contrast PNGs to Playwright results for review; the captures are evidence to inspect, not approved visual baselines.

Unit coverage includes menu command presence/accelerators, enabled-state guards for text editing/dialogs, and text token contrast against raised/canvas/recessed surfaces.

## Manual release verification still required

Browser emulation cannot establish OS assistive-technology compatibility. Before closing #52/#53, record these results with the tested artifact, OS version, theme, and screenshots:

1. On Windows High Contrast and macOS Increase Contrast, inspect focus outlines, selection, disabled controls, imported previews, and snapshot comparison badges in each theme. Ensure state is understandable without color alone.
2. With VoiceOver on macOS and Narrator (or NVDA) on Windows, open/create/edit/search/snapshot using only the keyboard. Confirm dialog names, initial focus, tree level/position/selection announcements, toast announcements, and restored focus after dismissal.
3. For every custom and native modal, check Tab/Shift+Tab containment, Escape/Cancel, Enter on focused buttons, and busy-state dismissal guards. Include import, templates, duplicate, move, batch edit, archive, external-change, history, revert, and recovery dialogs.
4. Test the virtual tree across off-screen rows, deep nesting, multi-selection, and compare folds/ghosts. Confirm Home/End, parent/child navigation, context menu keys, and search match cycling with the screen reader active.
5. Enable OS Reduce Motion and inspect the project hub, tree, dialogs, and compare transitions. Review the captured PNGs at the intended display scale for clipping, low-contrast controls, and focus visibility.

Some keyboard chords can be reserved by OS utilities or assistive technology. The corresponding menu actions remain available; document conflicts found on supported systems before choosing alternate chords.
