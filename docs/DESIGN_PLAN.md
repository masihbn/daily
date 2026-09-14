# Daily — Design pass (Phase U) execution plan

**Purpose.** v1 is built (`docs/BUILD_PLAN.md`, 2026-09-14). This plan
makes it *look* like a product the user wants to open ten times a day,
and adds the one new capability the user asked for: full-screen,
sideways-scrolling charts. It is executed exactly like `BUILD_PLAN.md`:
one numbered step at a time, under `docs/ORCHESTRATION.md` (top-tier
orchestrator writes a contract; Sonnet Implementer and Test Author work
in parallel from it; the full suite must be green; commit, push, bump
`sw.js` `CACHE`, device check).

**Read first:** `CLAUDE.md`, `docs/ORCHESTRATION.md`, the Ground rules
and Step Contract in `docs/BUILD_PLAN.md` (they all apply here
unchanged), then this file top to bottom.

**Status legend:** `TODO` · `IN PROGRESS` · `DONE` · `BLOCKED`

---

## 0. Decisions the user made (2026-09-14) — do not re-litigate

1. **Neutral accent.** The app's own accent is no longer iOS blue. The
   trackables' colours are the colour in the app; the app chrome is
   near-monochrome so they pop. Green/red stay for good/bad verdicts.
2. **Home keeps one card per trackable**, made beautiful — not a
   compact list. Density improves through spacing and hierarchy, not by
   removing the card.
3. **Full-screen charts open from an Expand control.** Tapping Expand
   shows the chart landscape immediately (the app rotates the view
   itself when the phone is held portrait; a physically rotated phone
   simply fills the screen). The chart scrolls sideways with native
   momentum, y axis pinned. No pinch-zoom in this pass.
4. **Order of screens and every other design call is the
   orchestrator's.** The user reviews screenshots before a deploy and
   the real app after it, and says go / change.

## 1. Ground rules specific to this pass

- **Looks change, behaviour does not.** No step in this plan changes a
  route's data flow, the store, the API, the service worker's policy,
  or any chart's numbers. If a step needs behaviour to change (U.4 adds
  routes; U.2 adds a bottom sheet), the contract says so explicitly and
  the tests cover it. Everything else is CSS, markup and copy.
- **Selectors are an API.** The e2e suite (209 tests) finds elements by
  class (`section.detail`, `.trow-log`, `.detail-range[data-range]`,
  `.bounds-period`, `.trend-period`, `.hm-cell`, `.tform-*`,
  `.settings-*`, `.signin-*`, `.lock-*`, `#nav a[href]`, …) and by
  `data-*` state attributes (`data-verdict`, `data-home-state`,
  `data-detail-state`, `data-slot`, `data-route`, `aria-pressed`,
  `aria-current`). **Every existing class and data attribute is kept.**
  New design-system classes are *added* next to them
  (`class="trow-log btn btn--secondary"`), never substituted. When a
  step must change a user-visible text the tests assert on, the
  contract lists the old and new string and the Test Author updates the
  assertion — that is a contract change, not a weakened test.
- **No new runtime dependency** unless a step says so. The icon set is
  inline SVG in our own module. Chart.js + annotation stay the only CDN
  scripts.
- **No visual snapshot tests.** Decided at U.0: every step changes the
  look, so snapshot PNGs would be regenerated every step and bloat the
  public repo. The visual check is `scripts/screenshots.mjs` (below)
  reviewed by the orchestrator and the user, then the phone.
- **Dark first, light audited.** Every step's screenshots are taken in
  both schemes. A step is not DONE if light mode is broken.
- **Accessibility floor stays.** 44pt tap targets on EVERY interactive
  control — buttons, segmented items, chips, calendar arrows, the small
  "Log" button; only non-interactive status pills may be shorter (four
  pre-U.0 e2e tests assert the floor on `.trow-log`, `.detail-range`,
  `.trend-period`, `.hm-nav`, and U.0's first cut violated it — the
  code was fixed, not the tests). Colour never the
  only cue, `aria-*` states kept, focus-visible rings, `prefers-reduced-
  motion` respected wherever motion is added.
- **iOS standalone traps stay respected.** `viewport-fit=cover`, safe-
  area insets on all four sides (landscape puts the notch on a side),
  `apple-mobile-web-app-status-bar-style` stays `black` (see
  `index.html`'s comment — do not "fix" it to black-translucent),
  inputs ≥16px so Safari does not zoom, `touch-action: manipulation`.

## 2. Tooling added by this pass

- **`scripts/screenshots.mjs`** (not deployed; uses the Playwright
  devDependency and `tests/helpers/e2e-session.mjs`). Starts nothing:
  run the static server first (`node tests/helpers/server.mjs 8123` in
  PowerShell), then `node scripts/screenshots.mjs <outDir>`. Renders
  every screen with a fixed fixture set (five trackables, 200 days of
  seeded data, an overlay and a compare selection pre-chosen) at 390×844
  @2x in dark and light, plus landscape and the fullscreen routes once
  U.4 exists. Zero network: every REST call is fulfilled from fixtures.
  The orchestrator runs it before and after each step and sends the
  user the pairs. Sonnet subagents may run it too but never edit it
  without the contract saying so.

## 3. The design system (decided here, built in U.0)

**Tokens** (`:root`, dark default; light under
`@media (prefers-color-scheme: light)`; both blocks define every token):

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#0b0b0e` | `#f2f2f7` | page |
| `--surface` | `#151518` | `#ffffff` | cards, tab bar, sheets |
| `--surface-2` | `#1f1f24` | `#f2f2f5` | inset controls, segmented track |
| `--surface-3` | `#2b2b31` | `#e5e5ea` | pressed / selected segment |
| `--fg` | `#f5f5f7` | `#0b0b0e` | primary text |
| `--fg-2` | `#a1a1aa` | `#5c5c66` | secondary text |
| `--fg-3` | `#6e6e78` | `#8e8e96` | tertiary, placeholders |
| `--hairline` | `rgba(255,255,255,.08)` | `rgba(0,0,0,.08)` | dividers |
| `--accent` | `var(--fg)` | `var(--fg)` | primary buttons, selection |
| `--accent-fg` | `#0b0b0e` | `#ffffff` | text on accent |
| `--good` / `--good-bg` | `#30d158` / 14% | `#1f9c46` / 12% | verdict |
| `--bad` / `--bad-bg` | `#ff453a` / 14% | `#d9362e` / 12% | verdict, danger |
| `--warn` | `#ffb340` | `#b26a00` | outbox pending |
| `--focus` | `rgba(245,245,247,.45)` | `rgba(11,11,14,.35)` | focus ring |

Legacy names `--bg-elevated`, `--fg-muted`, `--border`, `--danger` are
kept as aliases of the new tokens for one step (U.0) and removed in
U.7 once nothing references them.

**Type** (system font stack unchanged): `--t-lg-title 34px/1.15
700`, `--t-title 22px/1.2 700`, `--t-head 17px/1.3 600`, `--t-body
17px/1.4 400`, `--t-sub 15px/1.4 400`, `--t-cap 13px/1.35 500`,
`--t-micro 11px/1.2 600 uppercase tracking .04em`. Numbers that are
values (today's value, axis, ranges) get `font-variant-numeric:
tabular-nums`.

**Space** 4pt: `--s1 4 --s2 8 --s3 12 --s4 16 --s5 24 --s6 32`.
**Radius** `--r-ctl 10px --r-card 16px --r-sheet 22px --r-pill 999px`.
**Elevation**: none in dark (surfaces do the work); in light one soft
shadow token `--shadow: 0 1px 2px rgba(0,0,0,.06), 0 4px 16px
rgba(0,0,0,.05)`.

**Component kit** (classes, all additive):

- `.btn` base; `.btn--primary` (accent fill, accent-fg text),
  `.btn--secondary` (surface-2 fill, hairline, fg text), `.btn--ghost`
  (no fill, fg-2 text), `.btn--danger` (bad-bg fill, bad text),
  `.btn--sm` (44px tall, tighter padding and caption font), `.btn--icon`
  (44×44 round, one glyph). Pressed
  state via `:active { transform: scale(.97); opacity: .85 }` (skipped
  under reduced motion). Disabled: `opacity: .4`.
- `.seg` segmented control: `display:flex`, surface-2 track, 4px
  padding, radius `--r-ctl`; `.seg__item` fills equally, 44px tall (the
  track is therefore 52px), fg-2 text; `[aria-pressed="true"]` gets surface-3 fill, fg text,
  weight 600.
- `.chip` pill: surface-2, hairline, 44px tall, fg-2; `[aria-pressed="true"]`
  surface-3 + fg; a leading `.chip__dot` takes the trackable colour.
- `.card`: surface fill, radius `--r-card`, padding `--s4`, light-mode
  shadow; `.card__title` (t-head) and `.card__sub` (t-cap fg-2) in a
  `.card__head` flex row with an optional trailing action.
- `.list` / `.list__row`: inset grouped list (iOS Settings style):
  surface, radius card, rows separated by hairline, 52px min height,
  trailing control slot `.list__trail`.
- `.field`: label (t-cap fg-2 uppercase) above `.input` (surface-2,
  hairline, radius ctl, 48px, 17px text, focus ring `--focus`).
- `.pill`: status label 24px tall, t-cap, colour variants `--good`,
  `--bad`, `--warn`, neutral.
- `.title-bar`: per-screen top bar (built in U.1).
- The global `button { … }` rule becomes a **reset only** (font, colour
  inherit, no background/border/padding, `touch-action`, tap highlight
  off). Every button in the app is then styled by its own class or a
  `.btn` variant. This is the one U.0 change with any risk: every
  existing button class must be re-checked in both schemes.

**Chrome icons**: `js/ui-icons.js`, `uiIconSvg(key)` returning an inline
`<svg viewBox="0 0 24 24" aria-hidden="true" …>` with `stroke:
currentColor`, 1.75 stroke, round joins. Keys: `home`, `compare`,
`settings`, `back`, `forward`, `plus`, `expand`, `close`, `check`,
`chevron-left`, `chevron-right`, `chevron-down`, `edit`, `share`,
`lock`, `wifi-off`, `clock`. Same table-of-constants pattern as
`js/icons.js` (the only innerHTML the views use is our own constant
markup).

---

## Step U.0 — Foundations: tokens, type, component kit, chrome icons

**Status:** DONE (2026-09-14) — suite-verified; device check with U.1.
Contract `CONTRACT-U.0.md` (session scratchpad). One fix cycle (below).
`sw.js` `CACHE` → `daily-v45`.

**Goal.** Every screen is restyled onto the new tokens and kit with no
markup change and no behaviour change; the accent is neutral; the
global `button` rule is gone.

**Preconditions.** v1 DONE (it is).

**Deliverables.** `css/styles.css` (rewritten top section: tokens, type,
kit; every existing component rule migrated to tokens and to the kit's
metrics), `js/ui-icons.js` (new), `scripts/screenshots.mjs` (new,
orchestrator-owned), `sw.js` (`ASSETS` += `./js/ui-icons.js`, `CACHE`
bump), `docs/DESIGN_PLAN.md` (this file, statuses),
`tests/unit/ui-icons.test.mjs` (new), `tests/unit/design-tokens.test.mjs`
(new, text-level assertions on `styles.css` like
`tests/unit/sw-assets.test.mjs`).

**Implementation notes.**
- No `.js` view file changes. No `index.html` change beyond nothing.
  `js/ui-icons.js` is added to `sw.js` `ASSETS` now so U.1 can use it
  offline without another bump-and-relaunch cycle for the icon file.
- Migration rule for existing CSS: keep every selector; replace every
  literal colour with a token; replace paddings/radii with the scale;
  give each existing button class the metrics of the `.btn` variant it
  will get in later steps (`.trow-log` → secondary sm; `.tform-save`,
  `.signin-submit`, `.settings-window-save`, `.settings-export-all`,
  `.day-save`, `.lock-unlock`, `.settings-applock-toggle` → primary;
  `.detail-range`, `.trend-period`, `.bounds-period` → segmented-item
  look while still being standalone buttons; `.overlay-chip`,
  `.compare-chip` → chip; `.tform-cancel`, `.trow-cancel`,
  `.day-cancel`, `.signin-toggle`, `.lock-signout` → ghost;
  `.tform-archive-confirm`, `.tform-delete` → danger).
- Trackable names on Home (`.trow-name`) stop being blue: `--fg`,
  weight 600, no underline.
- Verdict tint on `.trow` and `.hm-cell` drops from 18% to the
  `--good-bg`/`--bad-bg` 14%/12% values; the 4px left bar stays.
- Chart.js reads colours from CSS custom properties at render time
  already (`getComputedStyle`), so grid/tick colours follow the tokens
  without JS changes — verify, and if any chart file hard-codes a hex,
  list it in Test Subjects for U.3 rather than touching charts here.
- Light mode: `header`, `#nav`, cards get `--shadow`; `html` background
  stays `--surface` (the iOS banding fix in `styles.css`'s comment
  still applies).

**Test Subjects.**

Suite after this step: **4599 green** — 4336 unit (two new files), 54
integration, 209 e2e. New: `js/ui-icons.js`, `scripts/screenshots.mjs`,
`tests/unit/ui-icons.test.mjs`, `tests/unit/design-tokens.test.mjs`;
changed: `css/styles.css` (rewritten onto tokens + kit, every selector
kept), `sw.js`.

*Unit.* ui-icons: the 17 keys frozen and unique; every glyph is a
24-grid `currentColor` stroke SVG with no hex, no script, no handlers;
hostile keys → `''`, never throws; prototype keys rejected.
design-tokens (text-level, like `sw-assets.test.mjs`): every §3 token
defined in both scheme blocks with `--accent` literal per scheme; the
four legacy aliases; none of the six old palette literals anywhere; the
bare `button {}` rule is a reset (no accent background, no radius); the
14 kit classes exist; `:focus-visible` and reduced-motion blocks exist;
all 115 pre-U.0 selectors still exist; `sw.js` lists `ui-icons.js` and
`daily-v45`.

*The fix cycle.* Four pre-existing e2e tests (`.trow-log`,
`.detail-range`, `.trend-period`, `.hm-nav` ≥ 44px) failed at 36px:
the contract's kit metrics (`.btn--sm` 36, `.seg__item` 36, `.chip` 32)
contradicted the plan's own 44pt floor. Ruling: the code was wrong;
every interactive control got `min-height: 44px` (segmented tracks are
therefore 52px); the tests were not touched; §1 and §3 of this plan now
say so explicitly.

*Screenshots reviewed (dark + light):* home, detail ×3, compare,
settings, new, edit, sign-in, lock, landscape. Coherent monochrome
chrome; trackable colours and verdicts are the only saturated colour.
Known nits left for their own steps: Home's boolean word ("Done") is
oversized and misaligned (U.2); the "Trackable" title and the "Daily"
header still stack (U.1).

---

## Step U.1 — Shell: title bar, tab bar with icons, status pills

**Status:** DONE (2026-09-14) — suite-verified; device check pending
(pinged with U.0). Contract `CONTRACT-U.1.md`. No fix cycle. `sw.js`
`CACHE` → `daily-v46`.

**Goal.** The permanent "Daily" header is gone; each screen has its own
title bar (large title on tabs, back button + compact title elsewhere);
the tab bar has icons; offline/outbox indicators are small pills that do
not push content.

**Preconditions.** U.0.

**Deliverables.** `index.html`, `js/main.js`, `js/net-status.js`,
`js/outbox-sync.js` (render functions only), `css/styles.css`, `sw.js`
bump; tests: `tests/e2e/shell.test.mjs` updated per contract,
`tests/unit/net-status.test.mjs` if the render signature changes.

**Implementation notes.**
- `<header>` keeps its id-bearing children (`#outbox-status`,
  `#net-status`) — they become pills positioned top-right inside a new
  `.title-bar`. The `<h1>Daily</h1>` is removed; the document `<title>`
  stays "Daily".
- `main.js` renders `<h1>` for each route today (`Today`, `Trackable`,
  `New Trackable`, `Edit Trackable`, `Compare`, `Settings`, `Sign in`,
  `Locked`). Those `<h1>` elements stay (tests read `#app h1`), but move
  into a `.title-bar` element with: a leading back button
  (`a.title-bar__back[href="#/"]`, `uiIconSvg('back')`) on `detail`,
  `new`, `edit`; no back on the three tab routes. The detail route's
  `<h1>` text becomes the trackable's name once loaded (contract: the
  view exposes it; `main.js` sets `Trackable` as the placeholder, the
  detail view updates `#app h1` on first successful render — text
  assertion in `detail.test.mjs` updated from "Trackable" to the
  fixture name). Large-title style on tabs, compact on the others.
- Tab bar: three `<a data-route>` stay, each gains an SVG icon above a
  13px label; active = `--fg`, inactive = `--fg-3`; 49pt + safe area;
  `backdrop-filter: saturate(180%) blur(20px)` over a 92% surface.
- Status pills: `#net-status` "Offline" with `wifi-off` icon;
  `#outbox-status` "N unsent" with `clock` icon, warn colour. Text
  content the tests assert (`OFFLINE_TEXT`) is a contract change → the
  exported constant changes and its unit test with it.
- View transitions: none yet (U.7).

**Test Subjects.**

Suite after this step: **4609 green** — 4336 unit, 54 integration, 219
e2e (+10). Changed: `index.html` (`#title-bar` / `#title` /
`#title-back`, status `<p>`s as pills, `#nav.tab-bar`), `js/main.js`
(`setTitle`, `decorateNav`, no `<h1>` in `#app` any more), `js/views/
detail.js` (`onTitle`, sent once per text change, never throws),
`css/styles.css`, `sw.js`.

*E2E added:* shell S-T1–S-T6 (large title on the three tabs, compact +
back on new/not-found, tab links carry an icon and a label with
unchanged text, signed-out shows "Sign in" with the tab bar hidden);
detail D-T1–D-T3 (title becomes the trackable name once ready, "Not
found" for an unknown id, edit route's back points at the trackable);
applock (locked launch shows "Locked", compact, no back).

*Decisions at execution time:* status texts unchanged (they became pills
by CSS only); the U.0 design-tokens T9 test that pinned `daily-v45`
was changed to a floor (`daily-v(\d+)`, N ≥ 45) because every design
step bumps the cache — a contract correction, recorded here.

---

## Step U.2 — Home cards

**Status:** TODO

**Goal.** Each trackable card reads at a glance: identity (colour icon),
name, today's value or state, verdict, and one obvious action — and a
day's worth of cards fits on one screen.

**Preconditions.** U.1.

**Deliverables.** `js/views/home.js` (markup only: added classes, one
new element), `js/views/home-model.js` (only if a new text is needed),
`css/styles.css`, `sw.js` bump; `tests/e2e/home.test.mjs` updated for
any contract text change; unit tests for any new pure helper.

**Implementation notes.**
- Card layout (grid, 3 columns: 44px icon well / flexible / trailing):
  row 1 — icon in a tinted round well (`.trow-icon` gets a background
  of the trackable colour at 16%), `.trow-name` (17/600), trailing
  `.trow-value` (22/700 tabular, or the boolean word in 15/600).
  Row 2 — `.trow-status` pill (verdict colour) + `.trow-direction` as a
  13px caption, then `.trow-hint` in `--fg-3`.
  Trailing column: `.trow-log` becomes a 40px round icon button
  (`check` glyph for boolean, `plus` for numeric) with
  `aria-label` unchanged and the visible text "Log" kept for the tests
  via a `.visually-hidden` span (contract: the button's accessible name
  and `textContent` remain "Log").
- Verdict: `data-verdict="good"` → icon well ring `--good`, card tint
  `--good-bg`, 4px left bar `--good`; `bad` likewise; neutral → none.
- Numeric editor (`form.trow-editor`) becomes an inline row under the
  card body with a `.input` and primary/ghost buttons; no bottom sheet
  in this pass (keeps the tested inline behaviour: `input.trow-input`
  focus/select, Save/Cancel).
- "New trackable" (`a.home-new`) becomes a full-width secondary button
  at the end of the list — kept in the DOM where it is (tests).
- The `Today` `<h1>` gains a `.title-bar__sub` with the long date
  ("Monday, 14 September") from `todayLocal()` — pure formatter in
  `home-model.js` with a unit test.

**Test Subjects.** _(filled by the executing session)_

---

## Step U.3 — Detail screen and chart styling

**Status:** TODO

**Goal.** The detail screen has a hero header, calm calendar, one
consistent segmented control per card, and charts that look designed.
Each chart card has an Expand control (wired in U.4).

**Preconditions.** U.2.

**Deliverables.** `js/views/detail.js` (markup: added classes, Expand
buttons, overlay picker relocation), `js/charts/heatmap.js`,
`js/charts/weekly.js`, `js/charts/bounds.js`, `js/charts/overlay.js`,
`css/styles.css`, `sw.js` bump; e2e `detail/heatmap/weekly/bounds/
overlay.test.mjs` updated only where the contract moves an element.

**Implementation notes.**
- Hero (`.detail-head`): icon in colour well 56px, name 28/700, unit +
  direction as a caption line, and a new "today" line (today's value or
  "Not logged today") from the entries already loaded; Edit becomes a
  `btn--icon` with the `edit` glyph (text "Edit" visually hidden — tests
  use `.detail-edit`).
- Range chips (`.detail-ranges` / `.detail-range`) become a `.seg`
  control; period chips (`.trend-periods`, `.bounds-periods`) likewise.
  `aria-pressed` semantics unchanged.
- Calendar: cells become circles-in-squares: number always visible,
  logged day = solid disc in the trackable colour (`.hm-fill`), verdict
  = a 6px dot under the number (good/bad) rather than a flood; today =
  1.5px ring `--fg`. Same DOM, `data-verdict`/`data-cell-state` kept.
- Chart pass (Chart.js options only, numbers unchanged): line width 2,
  point radius 0 with 4px on hover/nearest, area fill under lines
  (gradient of the series colour to transparent, `plugins` hook), grid
  `--hairline` only on y, x ticks horizontal with `maxRotation: 0`,
  `autoSkip` targeting ≤6 labels, font 11px `--fg-3`, tooltip styled to
  tokens, bands as soft fills (`--good-bg`) with 1px dashed edges,
  target line 1.5px dashed with a small right-aligned label, bar radius
  4px, overlay bars 40% alpha. Canvas heights 220px (weekly), 260px
  (range).
- Overlay picker: moves from its own slot below the Range card into the
  Range card's head as a `.chip` row ("Overlay: Workout ▾" style chip
  opening the existing chip list inline). DOM contract: the picker
  element keeps its classes (`.overlay-picker`, `.overlay-chip`) and
  `data-overlays`; the `chart-slot[data-slot="overlay"]` wrapper stays
  as the container, only its position in the DOM changes (tests that
  locate `.chart-slot[data-slot="overlay"] .overlay-picker` still pass).
- Expand: `button.chart-expand` (icon `expand`, aria-label "Expand
  <title>") in each chart card head (Weekly trend, Range). In U.3 it
  navigates to the U.4 route; until U.4 lands it is rendered `hidden`.

**Test Subjects.** _(filled by the executing session)_

---

## Step U.4 — Full-screen charts (landscape, sideways scroll)

**Status:** TODO

**Goal.** Expand on any chart opens a full-screen landscape view of that
chart with the whole selected range scrollable sideways, y axis pinned,
starting at today; the back gesture / Close returns to the screen.

**Preconditions.** U.3.

**Deliverables.** `js/router.js` (routes), `js/main.js` (route wiring,
nav hidden on the fullscreen route), `js/views/fullscreen.js` (new),
`js/charts/scroll.js` (new: pure sizing math + the pinned-axis plugin),
`css/styles.css`, `sw.js` (`ASSETS` += two files, bump); tests:
`tests/unit/router.test.mjs` (extended), `tests/unit/chart-scroll.test.mjs`
(new), `tests/e2e/fullscreen.test.mjs` (new).

**Implementation notes.**
- Routes: `#/t/:id/chart/:kind` with `kind ∈ {trend, range}` →
  `{ name: 'chart', params: { id, kind } }`; `#/compare/chart` →
  `{ name: 'compare-chart', params: {} }`. Any other `kind` → notfound.
  Because it is a real hash route, the iOS back gesture and the browser
  Back button close it, and a relaunch lands back on it harmlessly.
- Orientation. iOS Safari (incl. standalone PWAs) does not implement
  `screen.orientation.lock()`; the manifest has no `orientation` key,
  so the phone may physically rotate. Behaviour: the fullscreen section
  is `position: fixed; inset: 0` and reads `matchMedia('(orientation:
  portrait)')`. In portrait it sets `data-rotated="true"` and CSS
  rotates it: `width: 100vh; height: 100vw; transform: rotate(90deg)
  translateY(-100%); transform-origin: top left` (a `100dvh`/`100dvw`
  pair where supported). In landscape no transform. It re-evaluates on
  the media query's `change` event, so rotating the phone while open
  just swaps between the two modes. Safe-area insets are applied on the
  visual left/right (the notch side) in both modes.
- Sizing (`js/charts/scroll.js`, pure): `pxPerBucket(period)` = 14px
  day / 28px week / 44px month; `canvasWidth(bucketCount, period,
  viewportWidth)` = `max(viewportWidth − axisWidth, bucketCount × px)`;
  `axisWidth` = 52. The chart canvas lives in `.fs-track` whose width is
  that number, inside `.fs-scroll` (`overflow-x: auto; overflow-y:
  hidden; -webkit-overflow-scrolling: touch; overscroll-behavior-x:
  contain`). After render, `scrollLeft = scrollWidth` (today at the
  right edge). A `wheel`/drag needs nothing extra: native scroll.
- Pinned y axis: a second `<canvas class="fs-axis">` absolutely
  positioned at the visual left, `axisWidth` wide, full height; a small
  Chart.js plugin (`pinnedAxisPlugin` in `scroll.js`, pure function of
  `chart` and the axis canvas) runs `afterRender` and `drawImage`s the
  chart canvas's `[0, chartArea.left]` strip (device pixels) onto it;
  the chart's own y axis stays drawn but is under the scrolling edge so
  the pinned copy is what the user sees. Right axis for an overlay is
  pinned the same way on the right when `model.overlays.length > 0`.
- What is drawn: the same model the detail card draws (`weeklyModel` /
  `boundsModel` with the current range and period; the compare route
  uses `compareModel`) — the fullscreen view imports the same builders
  and calls the same `renderWeekly`/`renderBounds`/`renderCompare` with
  an options override `{ canvas, fullscreen: true }` (each render fn
  gains an optional second argument; default behaviour unchanged, unit
  tests prove the default path is untouched). Range and period
  selection are shared with the detail view through the same
  `localStorage` keys the detail view already persists (contract lists
  them), so the fullscreen opens with what the card showed.
- Controls (all inside the rotated section): top row — Close
  (`btn--icon`, `close` glyph, navigates back if `history.length > 1`
  else to `#/t/:id`), title ("Calories · Range"), range `.seg`
  (3M/6M/1Y/All), period `.seg` (Daily/Weekly/Monthly), and for the
  range chart the overlay chip. Bottom row — nothing (the chart fills).
  Tab bar hidden on these routes.
- Loading: reuses the detail view's entries load for the trackable
  (whole history for the range/all cases) through the store; shows the
  same "Loading…" then chart. Offline uses cached entries like the
  card.
- Reduced motion: no animation on open; otherwise a 200ms fade.

**Test Subjects.** _(filled by the executing session)_

---

## Step U.5 — Compare screen

**Status:** TODO

**Goal.** Compare is one calm screen: a scrolling chip row, one control
bar, one legend, and the same chart styling and Expand as detail.

**Preconditions.** U.4.

**Deliverables.** `js/views/compare.js`, `js/charts/compare.js`,
`css/styles.css`, `sw.js` bump; `tests/e2e/compare.test.mjs` updated
where the contract moves elements.

**Implementation notes.**
- Chips in a single horizontally scrolling row (`.compare-chips` gets
  `overflow-x: auto`, `scroll-snap-type: x proximity`), each with the
  colour dot; the count line ("3 selected") becomes the title bar
  subtitle.
- Range `.seg` and period `.seg` on one row (two controls, 50/50) —
  the same classes and `aria-pressed` semantics.
- The Chart.js legend is turned off; the key list (`.compare-key`)
  is the legend and moves above the chart under the controls, one line
  per series: dot, name, min–max range.
- Chart: line 2px, points 0/4, y axis −5..105 with the pinned ticks
  stays; x ticks horizontal.
- Expand → `#/compare/chart` (U.4).

**Test Subjects.** _(filled by the executing session)_

---

## Step U.6 — Forms, Settings, Sign in, Lock

**Status:** TODO

**Goal.** Create/edit, Settings, Sign in and Lock look like the rest of
the app: grouped inset lists, segmented choices instead of native
radios, a live preview of the trackable being edited.

**Preconditions.** U.2 (needs the card look for the preview).

**Deliverables.** `js/views/trackable.js`, `js/views/settings.js`,
`js/views/signin.js`, `js/views/lock.js`, `css/styles.css`, `sw.js`
bump; e2e tests for those screens updated only for contract-listed
text/position changes.

**Implementation notes.**
- Trackable form: fields grouped into `.card`s (Basics: name, icon,
  colour · Type: shape, direction · Goal: target, bounds). Radio groups
  keep their `<input type="radio" name=…>` (tests + semantics) but are
  styled as a `.seg` (inputs visually hidden, labels are the segments,
  `:checked + label` selected). Icon grid tints the glyphs with the
  currently selected colour. A live preview card (`.tform-preview`,
  built from the same DOM shape as a Home card, read-only) sits at the
  top and updates on `input`.
- Save/Cancel become a sticky bottom bar above the tab bar (`.tform-
  actions`): primary Save, ghost Cancel; archive/delete stay at the
  end of the form in a danger row with the existing confirm flow.
- Settings: each `section.settings-block[data-block]` becomes a `.card`
  with a `.list` inside. Rolling window: value + Save in one row.
  Order: rows with the two `btn--icon` chevrons. Archived: rows with an
  Unarchive ghost button. Export: one row "Export everything" primary +
  the per-trackable list collapsed under a "Per trackable" disclosure
  (`<details>`; the `.settings-export-*` elements stay in the DOM, just
  inside it). App lock: status pill + toggle button. Account: email row
  + Sign out danger button. Footer: `.settings-version` in `--fg-3`.
- Sign in: centred column, app icon (`icons/icon-192.png`) 72px, title,
  two `.field`s, Show/Hide as a ghost inside the password field's
  trailing slot, primary Sign in. Same classes.
- Lock: centred column, `lock` glyph 48px, "Locked", Unlock primary,
  "Sign out instead" ghost. Same classes and auto-prompt behaviour.

**Test Subjects.** _(filled by the executing session)_

---

## Step U.7 — Motion, states, light-mode audit, icon, cleanup

**Status:** TODO

**Goal.** The app feels finished: route transitions, press states,
skeleton loading, consistent empty/error states, light mode checked on
every screen, refreshed app icon and theme colour, dead CSS removed.

**Preconditions.** U.6.

**Deliverables.** `css/styles.css`, `js/main.js` (transition hook only),
the views' loading markup (`Loading…` → skeleton blocks with the same
classes, e.g. `.chart-slot-loading` becomes a shimmer block whose text
stays for the tests), `icons/*`, `manifest.json` (`theme_color`,
`background_color`), `index.html` (`meta theme-color` per scheme via
`media`), `sw.js` bump.

**Implementation notes.**
- Route transition: `#app` gets `data-transition="in"` on render; CSS
  fades/slides 160ms; `prefers-reduced-motion: reduce` disables.
- Skeletons: `.skeleton` shimmer class on the loading placeholders;
  keep their text for screen readers (visually hidden).
- Empty states: one `.empty` component (glyph, line, action) used by
  Home empty, Compare no-selection, Settings nothing archived.
- Remove the legacy token aliases and any rule no longer matched (audit
  with the screenshot script and grep for each selector in `js/`).
- App icon: new 512/192 PNGs (a simple mark on `--bg`), maskable
  variants if easy; `theme-color` `#0b0b0e` dark / `#f2f2f7` light.

**Test Subjects.** _(filled by the executing session)_

---

## ⛔ PHASE U GATE — hard stop

Deploy, then the user walks every screen on the phone in dark and
light, portrait and landscape, incl. one full-screen chart scrolled
back a year, Face ID lock, an offline launch. Record the verdict in
`docs/PROJECT_NOTES.md`'s Test log, update `CLAUDE.md`'s status and
test count, and close this plan the way `BUILD_PLAN.md` was closed.

---

## Decision log

- **2026-09-14** — Plan written after a screenshot survey of every
  screen (dark, light, landscape) with fixture data. User decisions in
  §0. Orchestrator decisions: screen order follows daily use (shell →
  home → detail → fullscreen → compare → forms/settings → polish); no
  snapshot tests; no pinch-zoom; chrome icons as our own inline SVG
  module; the accent token is the foreground colour, so a "primary"
  button is white-on-black in dark and black-on-white in light.
- **2026-09-14** — **U.0 executed.** Tokens, type scale, kit, chrome
  icons, global button reset. One fix cycle: the 44pt tap floor beat the
  contract's 36px small-control metrics (code fixed, tests untouched).
- **2026-09-14** — **U.1 executed.** Per-route title bar with back
  button, tab bar icons, status pills; `#app` no longer holds an `<h1>`.
  Suite 4609 green.
