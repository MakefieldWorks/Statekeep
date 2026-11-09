---
name: Statekeep
description: A calibrated instrument panel for structured projects — theme-neutral chrome, with color reserved entirely for change.
colors:
  panel-paper: "#f8f8f7"
  surface-raised: "#ffffff"
  rail-recessed: "#fafaf9"
  hairline: "#f5f5f4"
  border-standing: "#e7e5e4"
  border-strong: "#d6d3d1"
  ink-faint: "#a8a29e"
  ink-secondary: "#78716c"
  ink-body: "#57534e"
  ink-strong: "#44403c"
  ink-primary: "#292524"
  ink-max: "#1c1917"
  added-wash: "#ecfdf5"
  added-tint: "#d1fae5"
  added-edge: "#a7f3d0"
  added-ink: "#047857"
  added-ink-deep: "#064e3b"
  removed-wash: "#fef2f2"
  removed-tint: "#fee2e2"
  removed-edge: "#fecaca"
  removed-ink: "#b91c1c"
  removed-ink-deep: "#991b1b"
  moved-wash: "#f0f9ff"
  moved-tint: "#e0f2fe"
  moved-edge: "#bae6fd"
  moved-ink: "#0369a1"
  moved-ink-deep: "#0c4a6e"
  attention-wash: "#fffbeb"
  attention-tint: "#fef3c7"
  attention-edge: "#fde68a"
  attention-signal: "#fbbf24"
  attention-ink: "#b45309"
  attention-ink-deep: "#78350f"
  schema-tint: "#ede9fe"
  schema-ink: "#6d28d9"
  mixed-wash: "#faf5ff"
  mixed-ink: "#581c87"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, Inter, Segoe UI, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.4
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Inter, Segoe UI, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Inter, Segoe UI, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Inter, Segoe UI, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
  micro:
    fontFamily: "-apple-system, BlinkMacSystemFont, Inter, Segoe UI, sans-serif"
    fontSize: "0.625rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.025em"
  eyebrow:
    fontFamily: "-apple-system, BlinkMacSystemFont, Inter, Segoe UI, sans-serif"
    fontSize: "0.625rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.18em"
  mono:
    fontFamily: "JetBrains Mono, Fira Code, Menlo, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  hairline: "0.25rem"
  control: "0.5rem"
  surface: "0.75rem"
  brand: "1rem"
  pill: "9999px"
spacing:
  gutter-tight: "4px"
  gutter: "8px"
  inset: "12px"
  panel-inset: "20px"
  row-height: "32px"
components:
  button-primary:
    backgroundColor: "{colors.ink-primary}"
    textColor: "{colors.surface-raised}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.ink-strong}"
  button-primary-disabled:
    backgroundColor: "{colors.border-strong}"
    textColor: "{colors.surface-raised}"
  button-secondary:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink-body}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
  button-secondary-hover:
    backgroundColor: "{colors.rail-recessed}"
  input-text:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink-strong}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
  tree-row:
    backgroundColor: "{colors.rail-recessed}"
    textColor: "{colors.ink-strong}"
    typography: "{typography.body}"
    rounded: "{rounded.hairline}"
    height: "32px"
    padding: "0 4px"
  tree-row-selected:
    backgroundColor: "{colors.border-standing}"
    textColor: "{colors.ink-max}"
  badge-severity-high:
    backgroundColor: "{colors.attention-tint}"
    textColor: "{colors.attention-ink}"
    typography: "{typography.micro}"
    rounded: "{rounded.pill}"
    padding: "2px 6px"
  badge-severity-medium:
    backgroundColor: "{colors.moved-tint}"
    textColor: "{colors.moved-ink}"
    rounded: "{rounded.pill}"
    padding: "2px 6px"
  badge-severity-low:
    backgroundColor: "{colors.hairline}"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.pill}"
    padding: "2px 6px"
  fold-marker:
    backgroundColor: "{colors.attention-wash}"
    textColor: "{colors.attention-ink-deep}"
    typography: "{typography.label}"
    rounded: "{rounded.hairline}"
    height: "32px"
    padding: "0 8px"
  dialog:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink-strong}"
    rounded: "{rounded.surface}"
    padding: "0"
---

# Design System: Statekeep

## Overview

**Creative North Star: "The Instrument Panel"**

Statekeep reads like a calibrated readout, not a document. The chrome is warm, quiet, and almost
entirely colorless — a neutral gauge face — and every bit of color on screen is a signal about
state. Density is deliberate and high: 32px rows, 12px labels, tabular numerals for counts. The
panel does not decorate itself, because a decorated instrument is a harder instrument to read.

The consequence is a discipline that runs through the whole system: **color is not available for
aesthetics.** Emerald, red, sky, amber, and violet each carry a fixed meaning about how a node
changed. Spending any of them on a button, a header, or a brand moment would degrade the diff
view, which is the product's reason to exist. What remains for expression is typography, spacing,
hairlines, and motion — and the system leans on those hard.

The most distinctive behavior is the **lens**: in compare mode, contiguous runs of unchanged rows
collapse into a single summarized fold marker, and the collapse is animated rather than snapped.
Regions of the tree literally change magnification based on relevance. That, not any color or
shape choice, is what makes the interface feel like an instrument being focused.

The interface ships with two paired theme families: **Statekeep Light / Dark** and **Statekeep
Graphite Light / Dark**. It follows the operating-system appearance by default, while people can
choose either fixed appearance and independently choose the light and dark schemes in Settings.
Themes change the instrument's chrome, never the meanings assigned to change color.

**Key Characteristics:**
- Warm Stone or cool Graphite neutral chrome, chosen as a whole theme — never mixed within a view
- Color exclusively semantic; zero decorative accents in the chrome
- High information density — 32px rows, 12px as the dominant type size
- Near-flat surfaces; depth from tonal layering and hairlines
- Light and dark chrome are paired token sets; semantic change states retain their meaning in both
- Uppercase micro-labels with wide tracking as the system's texture
- Focus expressed as a 1px ring, never a color shift
- Motion reserved for structural change (folds), not for state feedback

## Colors

A warm neutral chrome built entirely on stone, plus five semantic hues that exist only to name a
kind of change. The neutrals do all the compositional work; the accents do all the signaling.

### Primary

The system has no decorative primary. Its highest-emphasis surface is the darkest neutral.

- **Graphite** (`ink-primary`): the sole high-emphasis fill. Primary buttons, keyboard-hint chips.
  Reads nearly black but carries stone's warmth, so it never looks like a pasted-in UI kit.

### Secondary

The semantic change palette. Each hue is bound to one change type by `getDecorationClass()` in
`TreeRow.svelte` and the chip vocabulary in `FoldMarker.svelte`. These bindings are the system's
strongest invariant.

- **Verified Green** (`added-wash` / `added-tint` / `added-ink`): **added** nodes only. Row wash,
  fold-marker chip, and the success banner in the shell.
- **Withdrawn Red** (`removed-wash` / `removed-tint` / `removed-ink`): **removed** nodes, plus
  genuine error states. Also the ring on a selected ghost row.
- **Relocated Sky** (`moved-wash` / `moved-tint` / `moved-ink`): **moved-to** destinations, and
  `Medium` severity. Doubles as the compare-mode marker on the project badge.
- **Amended Amber** (`attention-wash` → `attention-ink-deep`): **renamed**, **property-changed**,
  and **template-changed** rows; `High` severity; search-match highlighting; the fold marker;
  and every advisory banner. The busiest accent in the system by a wide margin.
- **Schema Violet** (`schema-tint` / `schema-ink`): template/schema classification badges.
- **Mixed Purple** (`mixed-wash` / `mixed-ink`): a subtree containing more than one kind of change.

### Neutral

Six ink steps and five surface steps. **Statekeep Light / Dark** use the canonical warm stone
family. **Statekeep Graphite Light / Dark** use a higher-contrast, low-chroma carbon family for
people who prefer a cooler instrument surface. Both families preserve the semantic accent roles
below, so color meanings never change with a selected scheme.

- **Panel Paper** (`panel-paper`): the app body ground. Deliberately *not* stone-50 — a hair
  warmer and greener. It is the one hand-chosen color in the system; preserve it exactly.
- **Surface Raised** (`surface-raised`): content panels, the titlebar, dialogs, inputs. The
  figure against the recessed rail.
- **Rail Recessed** (`rail-recessed`): the left tree pane, inset detail blocks, quoted values.
  Recession is signaled by tone, not by a shadow.
- **Hairline** (`hairline`) and **Standing Border** (`border-standing`): the two divider weights.
  Hairline separates within a panel; standing border separates panel from panel.
- **Strong Border** (`border-strong`): input strokes and the disabled-button fill.
- **Ink** (`ink-faint` → `ink-max`): faint for metadata and placeholders, secondary for supporting
  copy, body for labels and controls, strong for tree rows and body text, primary for headings,
  max for the selected row.

### Named Rules

**The Reserved Spectrum Rule.** Color in Statekeep means *something changed*. No hue may be spent on
branding, emphasis, category, or delight. If a new element needs to stand out, it earns it through
weight, size, spacing, or a hairline — never a color the diff view is already using.

**The Theme-Neutral Rule.** Every neutral comes from the active theme's family. Statekeep themes
use warm stone; Graphite themes use low-chroma carbon. Never mix the two families in a component,
and never use `gray`, `zinc`, `neutral`, or raw `slate` utilities. (One `text-slate-600` survives
in the codebase; it is a defect, not a precedent.)

**The Amber Overload Rule.** Amber already carries renamed, property-changed, template-changed,
High severity, search matches, folds, and advisories. It is at capacity. New advisory states must
reuse an existing amber pattern exactly or find a non-color signal — do not add a seventh meaning.

### Themes

Themes are a complete map of semantic tokens, not a collection of component-level overrides.
`src/shared/theme.ts` owns the built-in definitions and the renderer applies their values as CSS
custom properties. Tailwind utilities are bridged to those roles in `tailwind.config.js`, which
keeps existing component markup independent of a specific palette.

The current preference stores an appearance mode plus separate light and dark theme IDs:

```ts
interface AppearancePreference {
  mode: 'system' | 'light' | 'dark'
  lightThemeId: string
  darkThemeId: string
}
```

That pairing is intentional. Settings exposes a separate selector for each scheme, so a person can
pair any built-in light theme with any built-in dark theme; System mode simply resolves the
matching one. The shipped families are **Statekeep** (warm Stone) and **Graphite** (cool carbon).
When user-defined theme packs arrive, they follow the same pairing model. A theme pack must provide
every named token, declare `light` or `dark`, use validated hex colors, and meet contrast checks.
It may supply token values only — never arbitrary CSS.

## Typography

**Display / Body Font:** system UI stack — `-apple-system`, `BlinkMacSystemFont`, then `Inter`,
`Segoe UI`, `sans-serif`
**Mono Font:** `JetBrains Mono`, `Fira Code`, `Menlo`, `monospace`

**Character:** the system face, used deliberately rather than by default. Statekeep wants to look
like it belongs to the operating system it runs on, so it inherits the native face and spends its
typographic personality on *scale and case* instead of on a distinctive family. The result is
instrument-like: small, tight, evenly weighted, with uppercase micro-labels doing the annotating.

### Hierarchy

There is no display tier in the desktop shell — the largest routine text is 18px, and it appears
only on launch and empty screens. The working range is 10–14px.

- **Display** (600, 18px / 1.4): launch screen and empty-state headings only. Never inside a
  working project window.
- **Title** (600, 14px / 1.4): project name in the titlebar, dialog titles, section headings.
- **Body** (400, 14px / 1.5): tree rows, input values, prose in dialogs. The reading tier.
- **Label** (500, 12px / 1.4): the dominant tier by volume — buttons, banners, table cells,
  metadata, hints. When in doubt, a new control is 12px medium.
- **Micro** (600, 10px, uppercase, `0.025em`): change badges, fold chips, row status markers.
- **Eyebrow** (600, 10px, uppercase, `0.18em`): the wordmark above the project name. The widest
  tracking in the system, used once.
- **Mono** (400, 12px): raw property values, IDs, paths, and anything the user might copy.

### Named Rules

**The Twelve-Pixel Floor Rule.** 12px is the smallest *readable* tier. 10px is permitted only for
uppercase micro-labels, where the caps height keeps it legible. Never set sentence-case prose at
10px.

**The Tabular Numeral Rule.** Any number that appears in a column or updates in place — child
counts, node totals, chip counts — is `tabular-nums`. Digits that shift width make a panel twitch.

## Layout

A three-region desktop shell inside a fixed viewport. The body is `overflow: hidden` and 100vh;
scrolling belongs to panes, never to the window.

- **Titlebar** (full width, 10px vertical inset): brand mark in a 40px rounded-`brand` tile,
  wordmark eyebrow over project name over node count, a mode badge, then right-aligned actions.
  On platforms with inset window controls, the leading inset grows to 80px and the bar becomes a
  drag region — chrome is platform-aware rather than uniform.
- **Banner stack** (full width, below the titlebar): advisory rows, `12px` type, full-bleed tinted
  bands with a matching bottom border. They push content rather than overlaying it.
- **Left rail** (user-resizable via a drag handle, `rail-recessed`): search field, then the
  virtualized tree.
- **Center and right panes**: content and inspector on `surface-raised`, separated by standing
  borders.

**Spacing rhythm** is a 4px base with the working steps at 4 / 8 / 12 / 20px. Panel headers and
footers use `20px` horizontal by `12–16px` vertical; inset blocks use `12px × 8px`; row internals
use `4px` gaps. The 20px panel inset is what keeps a dense app from feeling cramped — it is the
single most load-bearing spacing value in the system.

**Row height is 32px, fixed.** The tree is virtualized (`@tanstack/svelte-virtual`) and the lens
animation interpolates row heights directly, so a variable row height would break both.

There are no responsive breakpoints. This is a desktop window with user-dragged pane widths, not a
fluid document. Panes must degrade by truncating (`truncate`, `min-w-0`) rather than by reflowing.

## Elevation & Depth

The system is **near-flat by practice**: depth comes from tonal layering — `rail-recessed` panes
against `surface-raised` panels, separated by `hairline` and `border-standing` — not from shadows.
Across the entire renderer there are roughly a dozen shadow utilities, and they cluster almost
entirely on modal dialogs and toasts.

This is an observed pattern, not yet a ratified invariant. It is strong enough to design against
and worth making explicit if it holds.

### Shadow Vocabulary

- **Overlay** (`box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)`):
  modal dialogs. Paired with a `rgb(0 0 0 / 0.3)` scrim.
- **Floating** (`box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)`):
  transient toasts.
- **Seated** (`box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05)`): the rare element that must lift a hair
  off the panel without becoming an overlay.

### Named Rules

**The Overlay-Only Shadow Guideline.** Today a shadow means *this floats above the app* — panels,
cards, rows, inputs, and banners are flat and get their separation from tone and hairlines. Treat
that as the working default until it is ratified as an invariant. If something seems to need a
shadow to be findable, check its tonal placement first.

## Shapes

A four-step radius ladder that maps to how far an element is from the user's cursor:

- **Hairline** (4px): tree rows, fold markers, inline chips, table wrappers. The tightest step,
  used where dozens of shapes stack — larger radii at this density read as mush.
- **Control** (8px): buttons, inputs, inset blocks, banners. The default for anything clickable.
- **Surface** (12px): dialog shells.
- **Brand** (16px): the brand-mark tile only.
- **Pill** (full): status badges and severity chips. The pill is what distinguishes a *state
  readout* from a *control* — nothing pill-shaped is ever clickable.

Borders are 1px, always. There is no 2px border anywhere in the system; emphasis comes from border
*color* stepping up (`hairline` → `border-standing` → `border-strong`), never from weight.

Focus is a **ring, not a border**: `ring-1` in `ink-faint` on interactive elements, so the ring sits
outside the box and never shifts layout. The fold marker escalates to `ring-2` in
`attention-signal` because it is the one control that must be findable mid-animation.

## Components

### Buttons

- **Shape:** softly rounded (8px `control`), 1px border or none, no shadow.
- **Primary:** `ink-primary` fill, white text, 12px medium, `8px 16px`. Hover steps to
  `ink-strong`; disabled flattens to `border-strong` with `cursor-not-allowed`.
- **Secondary:** `surface-raised` fill, `border-standing` stroke, `ink-body` text, `6px 12px`.
  Hover fills to `rail-recessed`.
- **Hover / Focus:** `transition-colors` only (150ms, Tailwind's default — a couple of elements
  opt down to 100ms) — buttons change color, never size or position. Focus is `ring-1` `ink-faint`.
- **Cursor:** every button is `cursor-default`, not `cursor-pointer`. This is a native-desktop
  convention and is applied consistently; keep it.

### Chips

- **Severity badges** (on decorated tree rows): pill, 10px semibold uppercase, `2px 6px`.
  High → amber tint, Medium → sky tint, Low → stone tint. **The chip's text always names the change
  type** — the tint is redundant reinforcement, never the sole carrier.
- **Classification badges** (in the diff list): 4px radius, tinted fill with matching ink, labeled
  `Structural` / `Dependency` / `Data` / `Schema` / `Ordering`.
- **Fold chips**: `3 added`, `2 moved` — count plus word, tinted to the change hue.

### Cards / Containers

- **Corner:** 12px `surface` for dialogs; inset blocks use 8px `control`.
- **Background:** `surface-raised` for panels; `rail-recessed` for inset or quoted content.
- **Shadow:** none, except modal dialogs (see Elevation).
- **Border:** 1px `border-standing`; `hairline` for internal dividers.
- **Padding:** `20px` horizontal, `12–16px` vertical for panel headers/footers; `12px × 8px` for
  inset blocks.

### Inputs / Fields

- **Style:** `surface-raised` fill, 1px `border-standing` stroke, 8px radius, `6px 12px`, 14px text,
  `ink-faint` placeholder.
- **Focus:** `outline-none` plus `ring-1` `ink-faint`. No glow, no border-color change, no scale.
- **Search field:** an 14px inline SVG magnifier at `12px` from the leading edge with matching
  `pl-8` padding, and a `✕` clear affordance that appears only when the field has content.
- **Selection:** the app disables text selection globally; inputs, textareas, and anything marked
  `.selectable` re-enable it. New read-and-copy surfaces must opt in explicitly.

### Navigation

The tree is the navigation. Rows are 32px, 4px radius, 14px text, indented by depth via inline
`padding-left`.

- **Default:** `ink-strong` on the transparent rail.
- **Hover:** `hairline` fill.
- **Focused (roving tabindex):** `ring-1` `border-strong`.
- **Selected:** `border-standing` fill with `ink-max` text — a tone step, not an accent color.
- **Search match:** `ring-1` amber, with the matched substring wrapped in an amber `<mark>`.
- **Compare decoration:** the semantic wash for its change type, plus labeled badges.

Selection, focus, match, and change-decoration are four independent signals that can co-occur on a
single row. They are kept distinguishable by using four different *mechanisms* — fill, ring,
ring-color, and wash — rather than four colors of the same mechanism.

### The Lens (signature)

The defining component. In compare mode, `density-layer.ts` partitions the row stream into
contiguous sections of uniform density — `full`, `summarized`, or `hidden` — and every run of two
or more unchanged rows collapses into a single **fold marker**.

- **Fold marker:** 32px tall, 4px radius, `attention-wash` fill with `attention-edge` border,
  `attention-ink-deep` text. A `▸` glyph, then `"47 items folded"`, then per-change count chips,
  then a pill-shaped total. When it contains the current selection it escalates to a filled
  `attention-tint` with a matching ring.
- **Ghosts are never folded.** Removed and moved-from placeholders are the reason the user opened
  compare mode; the lens always renders them at full density.
- **Morphing:** transitions are interpolated, not snapped. `lens-animation.ts` merges the outgoing
  and incoming row sequences, tags each item `entering` / `exiting` / `stable`, and drives heights
  from 0 → full (or the reverse) on an `easeInOutCubic` curve — **160ms per item, staggered across a
  280ms total window.** Fold identity is derived from the snapshot pair plus boundary anchors, so a
  fold that splits animates as one marker leaving and two arriving.
- **Reduced motion:** `prefersReducedMotion()` exists and must be honored by any new motion.

### Ghost Row (signature)

A removed or moved-from node, rendered in place as a tombstone: italic, `line-through` with
`ink-faint` decoration, reduced to 40% opacity (60% on hover, 70% when selected), and terminated by
an uppercase micro-label reading `removed` or `was here`. Selecting one loads it into the detail
pane in read-only mode.

It is worth studying as the system's best piece of craft: it communicates absence through five
simultaneous non-color signals — opacity, italic, strikethrough, a text label, and the loss of
interactivity — and adds a red ring only as a sixth.

## Do's and Don'ts

### Do:

- **Do** reserve all color for change semantics. A new element earns emphasis through weight,
  size, spacing, or a hairline. (The Reserved Spectrum Rule)
- **Do** use the selected theme's neutral family for every neutral. Never `gray`, `zinc`,
  `neutral`, or raw `slate` utilities.
- **Do** pair every change hue with a non-color signal — a text label, a glyph, an opacity shift, a
  strikethrough. Colorblind-safe change states are a binding product requirement. The incumbent
  system meets it for `added`, `moved-to`, `renamed`, `property-changed`, `template-changed`,
  `order-changed`, and `mixed` (each gets exactly one labeled badge from `BADGE_LABELS` in
  `tree-rows.ts`), and for removals via the ghost row's five stacked signals. The one uncovered
  path is a *decorated* row carrying status `removed` — `getDecorationClass()` gives it a red wash
  and `BADGE_LABELS` has no entry, so it would be hue-only. Any new change state must ship its own
  label; a tinted background alone fails the requirement.
- **Do** express focus as `ring-1` in `ink-faint`, outside the box, so nothing shifts.
- **Do** keep tree rows at exactly 32px. Virtualization and the lens animation both depend on it.
- **Do** set counts and columnar numbers in `tabular-nums`.
- **Do** mark `cursor-default` on buttons. This is a desktop app, not a web page.
- **Do** honor `prefersReducedMotion()` on anything that animates.
- **Do** keep new colors token-addressable rather than hard-coded. A token must have a valid value
  in every theme before the component that uses it ships.
- **Do** truncate with `truncate` + `min-w-0` when a pane narrows. Panes shrink; they don't reflow.

### Don't:

- **Don't** introduce a brand accent into the chrome. The teal-and-gold mark
  (`#49a390`, `#268576`, `#bdab34`) is **not currently binding** — the logo is unsettled, and the UI
  deliberately shares none of its palette. Resolve the mark before drawing anything from it.
- **Don't** add a seventh meaning to amber. (The Amber Overload Rule)
- **Don't** reach for a shadow on a panel, card, row, input, or banner without deciding to change
  the system. Shadows currently mean *floating above the app*, and that pattern is unbroken across
  the renderer — but it is a working default, not a ratified invariant. (The Overlay-Only Shadow
  Guideline)
- **Don't** use a 2px border. Emphasis steps through border color, never weight.
- **Don't** set sentence-case prose below 12px. 10px is for uppercase micro-labels only.
- **Don't** animate hover or focus states. Motion is reserved for structural change — folds
  opening and closing — so that movement on screen always means the tree's shape changed.
- **Don't** add scattered `dark:` variants or a component-specific override. Every theme change
  belongs in the shared token definitions so the system remains extensible.
- **Don't** make anything pill-shaped clickable. The pill silhouette is reserved for state readouts.
