# Project: Personal iPhone App (no App Store)

Last updated: 2026-08-21

This is a reference doc, not an auto-loaded file — it is NOT named
CLAUDE.md on purpose, so it won't be pulled into context automatically at
the start of every session. Point a future session at it explicitly (e.g.
"read docs/PROJECT_NOTES.md") when you want the full history. Keep it updated
as the project evolves — append to the Test Log rather than deleting past
entries, so the reasoning trail stays intact.

**This file is also the operational blueprint for the GitHub side of this
project** — how the repo is configured, how the deploy pipeline works, how
the every-5-days Supabase keepalive workflow runs, and the `gh` CLI
mechanics that weren't obvious the first time through. See "GitHub &
deployment blueprint" below before touching any of that again.

**As of 2026-08-21, `CLAUDE.md` (repo root) is the auto-loaded high-level
reference** for what the app is and how it's structured — read that
first in a new session. `docs/DATA_MODEL.md` has the full schema detail.
This file stays focused on deployment/ops history and the GitHub
mechanics; app/data-model content now lives in those two files instead of
here, to avoid duplicating it in two places.

## Goal

Build a personal app the user can run on their iPhone 15 without ever
submitting to the App Store or dealing with Apple review. Requirements,
in the user's words:

- **Extremely easy workflow**: develop locally → push to GitHub → app
  updates on the phone. No reinstall dance.
- **Has memory**: app data must be stored somewhere durable, not just
  on-device, so a bug or reinstall doesn't wipe everything. Needs a backup.
- **Hybrid-friendly**: if the user switches to Android later, it should
  not require rebuilding everything from scratch.

## Decision: build this as a PWA (Progressive Web App)

Considered two paths:

1. **PWA** — a website with a manifest + service worker, added to the iPhone
   home screen via Safari. Chosen approach.
2. **Native app sideloaded without the App Store** (React Native / Capacitor,
   installed via AltStore/Sideloadly or Xcode). Rejected for now.

**Why PWA won:**
- Zero Apple approval, zero sideloading tools.
- Matches the desired workflow almost exactly: host on GitHub Pages (or
  Vercel/Netlify), and every `git push` updates the live app automatically.
  The installed home-screen app picks up the new version via the service
  worker — no reinstall.
- Same code runs unmodified on Android Chrome. This *fully* satisfies the
  "hybrid" requirement — better than the fallback plan of "share a database
  format and refactor a native app," since there's no refactor at all.
- Data can be stored in a real backend (Supabase/Postgres, now live — see
  below) for backup/"memory," with local caching for offline use.

**Why native sideloading was rejected (for now):**
- Free Apple ID sideloading (AltStore/Sideloadly) means apps expire every
  7 days and must be re-signed (auto-refresh tools exist but add moving
  parts and a background dependency).
- Avoiding that requires the paid Apple Developer Program, $99/year, for
  1-year certs.
- Either way, this conflicts directly with "as simple as that" — the PWA
  route has no equivalent expiry/re-signing mechanic at all.

**Known tradeoffs of the PWA route** (accepted, revisit if they become
blockers):
- iOS caps default Cache Storage around ~50MB per origin (the Persistent
  Storage API can request an exemption from eviction, but it requires
  notification permission to invoke).
- Push notifications only work for a site added to the Home Screen (not an
  open Safari tab), and only since iOS 16.4. Safari 18.4 added "Declarative
  Web Push," a simpler mechanism that skips the service worker.
- No deep background processing / no App Store discoverability — irrelevant
  for a personal-use app.

Sources consulted (2026): mobiloud.com/blog/progressive-web-apps-ios,
magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide,
builds.io/blog (free iOS sideloading tools ranked 2026),
filipstachura.com/posts/ios-sideloading.

## GitHub & deployment blueprint

The live setup, as of 2026-08-22:

> **Renamed 2026-08-22 (Step 0.1): `memory-test-pwa` → `daily`.** Entries
> further down this file that predate that date still refer to the old
> repo and Pages URL. Those are left as written on purpose — they are the
> record of what was actually tested at the time, and rewriting them
> would make the test log claim things were verified at a URL that did
> not yet exist. Read anything above this note as current; anything in a
> dated log entry as historical.

- **Repo**: https://github.com/masihbn/daily — **public**
  (required for free GitHub Pages; private-repo Pages needs paid GitHub
  Pro). Originally created and pushed via `gh repo create memory-test-pwa
  --public --source=. --remote=origin --push`, then renamed with
  `gh repo rename daily --repo masihbn/memory-test-pwa --yes`. After a
  rename the local remote must be repointed —
  `git remote set-url origin https://github.com/masihbn/daily.git` — and
  verified with `git remote -v` plus a real `git fetch`. GitHub does
  redirect the old URL for git operations, so a stale remote keeps
  working silently and you will not notice it is wrong.
- **GitHub account used**: `masihbn`, authenticated locally via `gh auth
  login` (device-code flow, credentials cached in the Windows keyring —
  future sessions should just work; check with `gh auth status`).
- **Live URL (GitHub Pages)**: https://masihbn.github.io/daily/
  — serves from the `main` branch, root path (`/`). Originally enabled
  via: `gh api repos/masihbn/memory-test-pwa/pages -X POST -f
  "source[branch]=main" -f "source[path]=/"`. The Pages config (branch +
  path) survived the 2026-08-22 rename untouched; verify with
  `gh api repos/masihbn/daily/pages`.
  **The old Pages URL (`/memory-test-pwa/`) does not redirect reliably** —
  unlike git operations, which GitHub does redirect. Treat
  `https://masihbn.github.io/daily/` as the only canonical URL, and note
  that any home-screen icon added from the old URL is now dead and must
  be deleted and re-added.
- **Supabase project**: `okwzgmvnsdlheuolcthn`
  (`https://okwzgmvnsdlheuolcthn.supabase.co`), managed through the
  Supabase MCP server (`.mcp.json`, gitignored — see below).

### The actual push → deploy pipeline

1. Edit files locally.
2. `git add <specific files>` — stage deliberately, not `git add -A`,
   so nothing unexpected (stray temp files, anything gitignored) slips in.
3. `git commit -m "..."`.
4. `git push` (origin/main already tracked, so plain `git push` works).
5. GitHub Pages auto-rebuilds from `main` on every push. **Propagation
   took ~30–90 seconds** in testing (observed three 404s ~10s apart, then
   200) — don't assume it's broken if the live URL 404s for the first
   minute after a push.
6. **If `sw.js` or any cached asset (`index.html`, `manifest.json`,
   icons) changes, bump the `CACHE` constant in `sw.js`** (currently
   `'memtest-v1'`) — its `activate` handler deletes any cache whose name
   doesn't match `CACHE`, which is how already-installed clients (phones
   with the app added to the home screen) get told to drop stale cached
   files and fetch the new version. Forgetting this means a device that
   already cached the old assets may keep serving them for a while.

### `gh` CLI auth — gotchas hit this session

- `gh auth login --web` opens a **device-code flow**: it prints a
  one-time code and a URL (`https://github.com/login/device`); the user
  enters the code in a browser and approves. This is *not* something
  Claude can do on the user's behalf — it requires the user's own browser
  approval — but it also isn't a password entry, so it's fine for an
  agent to kick off and hand the code to the user.
- Run it with `run_in_background: true` (a bare foreground call with a
  short timeout will look like it "failed" when it's actually just
  waiting on the user — check the background output file, don't assume
  a timeout means failure).
- **`gh auth login`'s default scopes do NOT include `workflow`.** Pushing
  a commit that adds/changes anything under `.github/workflows/` gets
  rejected with `refusing to allow an OAuth App to create or update
  workflow ... without workflow scope`, *after* the repo is already
  created — annoying to discover mid-push. **Lesson for next time**:
  request the scope upfront — `gh auth login --scopes "repo,workflow"`
  — instead of doing a second `gh auth refresh -h github.com -s
  workflow` round trip (which requires a second device-code approval).
- To add a repo secret (for Actions, e.g. the keepalive workflow):
  `gh secret set SECRET_NAME --body "value" --repo owner/repo`.
- To manually trigger a workflow instead of waiting for its cron:
  `gh workflow run <file.yml> --repo owner/repo`, then check status with
  `gh run list --workflow=<file.yml> --repo owner/repo --limit 3`.

### Claude Code's auto-mode permission classifier — expect these blocks

Working autonomously in this repo, a few actions got blocked by Claude
Code's own auto-mode classifier (separate from GitHub/gh):
- Chained/compound `git` commands (e.g. `branch -m && add && status` in
  one call) sometimes got blocked even though each command individually
  was fine — if a chained command is denied, retry the pieces separately
  before assuming there's a real permission problem.
- `git add .mcp.json` specifically was blocked — the classifier treats
  MCP config files as secret-shaped. Resolution: it doesn't need to be
  committed anyway (it's local machine config, not app code), so it's
  gitignored instead of fought.
- **Creating the public GitHub repo and pushing required explicit
  in-chat user confirmation**, even under a standing "keep doing
  everything yourself" instruction — publishing/publicizing content is
  treated as its own permission gate regardless of general autonomy
  instructions. Expect this every time a new public-facing action (new
  repo, new public deploy) comes up, not just the first one.

### The every-5-days Supabase keepalive workflow

File: `.github/workflows/supabase-keepalive.yml`. Supabase free-tier
projects auto-pause after 7 days with zero database activity; this pings
the `counter` table every 5 days (`cron: '0 0 */5 * *'`) so that never
happens, and is also runnable on demand (`workflow_dispatch`).

- **Requires two repo secrets**: `SUPABASE_URL` and `SUPABASE_ANON_KEY`
  — **set and verified working** as of 2026-08-21 (`gh secret set ...`,
  then a manual `gh workflow run` completed with `success` in ~9s).
  These are the same publishable/anon values embedded in `index.html` —
  not sensitive, safe to have as plain repo secrets (see Security
  posture below for what "anon key" access actually means).
- It just does an HTTP GET against
  `$SUPABASE_URL/rest/v1/counter?id=eq.1&select=value` with the anon key
  as both `apikey` and `Authorization: Bearer`, and fails the job (exit
  1) if the response is >= 400.
- **Nothing else to maintain here** unless the Supabase project URL/key
  ever changes (e.g. project recreated) — if so, update both repo
  secrets and `index.html`'s constants together.

## Security posture (current — read before adding anything sensitive)

The current setup is intentionally wide open, appropriate for a
throwaway counter but **not appropriate once the app stores anything
personal**:

- The GitHub Pages URL is fully public, no auth, indexable — anyone with
  the link (or who finds the repo) can load the app.
- `supabase-schema.sql`'s RLS policies grant the `anon` role both
  `select` and `update` on the `counter` row with `using (true)` — i.e.
  **no restriction at all**. Combined with the anon/publishable key
  being embedded in plain text in the page source (this is by design —
  Supabase's publishable key is meant to be public, RLS is supposed to
  be the actual gate), this means **anyone who finds the URL or extracts
  the key can read and modify the counter**, not just view it. (No
  `insert`/`delete` policies exist, so those stay blocked.)
- This is a non-issue for a placeholder tap counter. **It is a real
  design constraint the moment the app stores anything the user cares
  about being private** (notes, health data, anything personal) — at
  that point this needs either: (a) Supabase Auth wired in with RLS
  policies scoped to `auth.uid()` instead of `using (true)`, or (b) some
  other access-control layer before the public URL is acceptable for
  real data.

## Environment notes (things that bit us, save future-self the time)

- **Machine**: Windows 11, PowerShell 5.1 available natively. A separate
  "Bash" tool is also available but it runs in what appears to be a
  **sandboxed/isolated network namespace** — a Python `http.server`
  started through it could not be reached even via `127.0.0.1` from a
  second Bash call, and `ps aux` showed the process running but nothing
  was actually listening from the caller's perspective.
  → **Lesson: use PowerShell, not Bash, for anything that needs to bind to
  a real network interface** (local test servers, anything the phone needs
  to reach). Bash is fine for git/gh/file operations.
- **Icon generation via GDI+ hangs**: `Add-Type -AssemblyName System.Drawing`
  + `System.Drawing.Bitmap`/`Graphics` in a non-interactive PowerShell
  session hung indefinitely (killed after a 2-minute timeout, exit 143).
  Likely needs an STA/GUI context that isn't available headlessly.
  → **Lesson: don't use System.Drawing/GDI+ for headless image generation
  on this machine.** Pure Python (manually building PNG bytes with
  `zlib` + `struct`, no Pillow needed) worked fine and is the fallback.
- **Python is available at two different paths** — `/c/Python313/python`
  (native Windows Python) and `/c/msys64/mingw64/bin/python3` (msys2/mingw
  build, this is the one Bash's `python3` resolves to by default). Node
  v22.19.0 is also installed.
- The machine's WiFi LAN IPv4 (for phone testing on the same network) was
  `10.0.0.125` at time of writing — **this is a DHCP address and will
  likely change**; re-run `ipconfig` (look under "Wireless LAN adapter
  Wi-Fi" → IPv4 Address) rather than trusting this value later.
- **Windows Firewall was a suspected blocker** for phone-to-PC LAN
  testing but turned out not to be an issue in practice — the Attempt 1
  LAN test below was later confirmed working from the iPhone.
- **The Claude-in-Chrome browser extension can disconnect between
  conversation turns.** A tab/session that worked earlier in a session
  returned "Browser extension is not connected" later in the same
  session with no obvious trigger. → **Lesson: don't assume browser
  automation is available just because it worked earlier — call
  `tabs_context_mcp` fresh and be ready to fall back to `curl`/
  `Invoke-WebRequest` plus direct Supabase queries (via MCP) to verify
  deployed behavior when the extension isn't cooperating.**

## Current repo state

**Is now a real git repository**, initialized 2026-08-21, default branch
`main`, pushed to `github.com/masihbn/memory-test-pwa`. Reorganized
2026-08-21 (Attempt 4 below) from a flat root into folders — see
`CLAUDE.md` for the folder map. Tracked files:

- `index.html` — entry point, still the placeholder tap-counter UI (the
  real skill-tracker UI hasn't been built yet). Links `css/styles.css`
  and `js/app.js` instead of inline `<style>`/`<script>`.
- `css/styles.css`, `js/app.js` — extracted from what used to be inline
  in `index.html`. `app.js` has the `SUPABASE_URL`/`SUPABASE_ANON_KEY`
  constants, **filled in and live** (see GitHub & deployment blueprint
  above for the values), reads/writes the `counter` table, and falls
  back to a `localStorage` cache (`lastKnownCount`) only if the Supabase
  fetch fails.
- `manifest.json` — PWA manifest, icons now point at `icons/`.
- `sw.js` — network-first-with-cache-fallback service worker; `CACHE`
  bumped to `memtest-v2` after the folder reorg changed its `ASSETS`
  list. **Bump `CACHE` again on any future asset change** — see deploy
  pipeline above.
- `icons/icon-192.png`, `icons/icon-512.png` — solid blue-square
  placeholder icons (hand-rolled PNG encoder, no text/logo yet).
- `supabase/migrations/0001_init_counter.sql` — the original `counter`
  table + RLS (renamed from the old root-level `supabase-schema.sql`).
- `supabase/migrations/0002_skills_tracker.sql` — the `skills` +
  `skill_entries` tables for the real app concept (see Attempt 4 below
  and `docs/DATA_MODEL.md` for the full design). Applied live.
- `CLAUDE.md` — new, auto-loaded high-level project reference.
- `docs/DATA_MODEL.md` — new, full schema reference and rationale.
- `.github/workflows/supabase-keepalive.yml` — see keepalive section
  above. Live and verified working. (Still pings `counter` specifically
  — harmless, its only job is to generate DB activity, doesn't need to
  target the "real" tables.)
- `.gitignore` — excludes `.mcp.json` (local Claude Code MCP connector
  config, not app code, not needed to build/run/deploy the app).
- `docs/PROJECT_NOTES.md` — this file.

**Not tracked / not present in the repo:**
- `.mcp.json` exists locally (points the Supabase MCP server at project
  `okwzgmvnsdlheuolcthn`) but is gitignored on purpose — it's
  machine/session config, not part of the deployed app.
- `.claude/settings.local.json` — excluded automatically by Claude
  Code's own global ignore rules, no action needed.

## Test log

### Attempt 8 — 2026-08-23, Step 2.1b on the real iPhone

**Goal**: verify the two product changes the user asked for after using
2.1 — replace-only logging, and direction-aware good/bad visuals.

**User-confirmed on device: all good, no issues found.** Four rows render;
`Smoking` (a `break` boolean) shows the green check reading **Clean**
before anything is logged and flips to a red cross reading **Logged** when
tapped; `Workout` (a `build` boolean) goes muted → green check;
re-logging `Calories` **replaced** rather than added.

**The design point worth remembering:** a green check means *"today is
good"*, not *"logged"*. Both a done Workout and an untouched Smoking show
green, because both mean today went well. This reads as a bug to anyone
who assumes check = logged — it is deliberate, and the reasoning
(WCAG 1.4.1 plus how Loop / Streaks / Quitzilla handle negative habits) is
recorded in `APP_CONCEPT.md` under the 2026-08-22 decision.

**Live trackables at this point** (real user rows, NOT `__test__`
fixtures, so the suite's sweep cannot touch them): `Workout` 365,
`Calories` 366, `Weight` 367, `Smoking` 468.

### Attempt 7 — 2026-08-22, Step 2.1 deploy checkpoint on the real iPhone

**Goal**: the extra checkpoint the user asked for after Step 2.1 (see
`BUILD_PLAN.md` Step 2.1's banner). First time the Phase 1 data layer
(`api.js` / `store.js` / `dates.js` / `aggregate.js`) has run in Mobile
Safari at all — before this they had only ever executed in Node.

**Seeded data.** The home screen had nothing to tap, because creating
trackables is Step 2.2. Three real rows were inserted directly with the
user's explicit approval — `Workout` (boolean), `Calories`
(numeric/cumulative/kcal), `Weight` (numeric/state/kg), ids 365–367,
`target_type='none'` and `bounds_enabled=false` since targets and bounds
are Step 2.2 / Phase 3. They were verified through the app's own
PostgREST query (`archived=is.false&order=sort_order.asc,id.asc`), not
just via SQL. **These are real user rows, not test fixtures** — the
suite's sweep only ever deletes names starting `__test__`, so it cannot
touch them.

**What passed** (user-confirmed on device): all three rows render in
`sort_order`; the boolean toggles to Done and back; the numeric keypad
comes up rather than QWERTY; **cumulative adds** (320 then 500 → 820);
**state replaces** (78.4 then 79.1 → 79.1, not 157.5); invalid input
shows "Enter a number" without saving; **an Airplane-Mode log survived a
force-quit and reconnect** — the first real-world confirmation that the
`localStorage` outbox works on iOS rather than against a mocked 503; and
the nav-race fix holds (tap Home then Settings quickly → Settings stays
highlighted).

**No device-only bugs found this round.** Worth contrasting with Attempt
6, which found two layout bugs invisible to the suite: the difference is
that this step's risk was concentrated in logic that the e2e tier could
genuinely exercise in a real browser, whereas Phase 0's risk was in
`env()` insets and standalone display mode, which Playwright does not
emulate at all.

### Attempt 6 — 2026-08-22, Phase 0 gate on the real iPhone

**Goal**: verify the renamed URL, the new app shell, and Add to Home
Screen from `https://masihbn.github.io/daily/`. This is the first device
check of the **"Daily" app itself** — Attempt 5 only ever exercised the
placeholder tap-counter, so it does not cover any of this.

**What passed** (user-confirmed): the new URL loads; nav between Home /
Compare / Settings swaps content with no reload; taps feel immediate (no
300ms delay); the `#/nope` route renders a real not-found view without
silently redirecting; Add to Home Screen works from the new URL;
standalone launch shows the correct icon and lands on Home; the shell
still opens in Airplane Mode from the home screen.

**Two layout bugs found — both invisible to the automated suite:**

1. **Header overlapped the status bar.** "Daily" rendered on top of the
   system clock (screenshot read "Daily8:40"). Cause: nothing applied
   `env(safe-area-inset-top)`. `viewport-fit=cover` plus
   `apple-mobile-web-app-status-bar-style: black-translucent` puts the
   content *under* the status bar by design, so the CSS must inset its
   own chrome. Fixed with `padding-top: calc(16px +
   env(safe-area-inset-top, 0px))` on the header — padding, not margin,
   so the header's background still paints up through the inset.
2. **A 59pt strip of bare screen below the bottom nav** in standalone
   mode. **RESOLVED — but only after two wrong fixes shipped.** The full
   sequence is kept here because the process lesson is worth more than
   the fix.

   - *Wrong guess 1:* "`#nav` uses `bottom: env(safe-area-inset-bottom)`,
     which lifts the bar and leaves the strip unpainted." Disproved by
     reading the CSS — `#nav` was already `bottom: 0` with the inset as
     `padding-bottom`, the correct pattern.
   - *Wrong guess 2:* "`html` has no background, so `body`'s colour
     propagates to the canvas and the gap beyond the layout viewport
     paints in the page colour." Shipped `html { background:
     var(--bg-elevated) }`. No change on the device.
   - *The decisive clue came from the user:* the bug appears in the
     installed app but never in Safari. Safari's own toolbar covers that
     region, so `env(safe-area-inset-bottom)` is `0` there and non-zero
     in standalone. That made it measurable.
   - *Then: stop guessing, instrument.* A temporary diagnostic readout
     was added to the settings view, dumping viewport, screen,
     `visualViewport`, standalone flags, all four safe-area insets
     (measured with a hidden probe element, since JS cannot read `env()`
     directly) and `getBoundingClientRect()` for `#nav`, `body` and
     `documentElement`. One screenshot settled it:

     ```
     screen.height:       852.0
     window.innerHeight:  793.0     (852 - 793 = 59 = safe-area-inset-top)
     safe-area-inset-top:  59.0
     #nav: top=714.0 bottom=793.0
     gap below nav (innerHeight - nav.bottom): 0.0
     ```

     `gap = 0.0` retired both earlier theories in a single line: the nav
     had been flush with the bottom of the layout viewport the whole
     time. The **web view itself** was 59pt short of the screen.
   - *Root cause:* `apple-mobile-web-app-status-bar-style:
     black-translucent` makes iOS position the view at the physical top
     (content under the notch) while still sizing it as `screenHeight -
     statusBarHeight`. The deficit falls off the bottom, **outside the
     view**, which is why no CSS fix — however correct — could paint it.
   - *Fix:* `content="black"`. iOS then positions the view below the
     status bar and sizes it correctly. `viewport-fit=cover` and all
     `env(safe-area-inset-*)` rules were kept; with `black`,
     `safe-area-inset-top` reports `0`, so the header padding collapses
     to its intended 16px on its own. Tradeoff: the notch strip is now
     solid black rather than the header colour — imperceptible in dark
     mode, noticeable in light.
   - *Guard:* a text-level assertion that no `<meta>` tag sets
     `black-translucent`, carrying the measurements and mechanism in its
     comment. Someone will eventually want the translucent bar back for
     aesthetics; that comment is what should stop them.

   **The lesson: instrument before theorising.** The tools to measure
   this existed from the first report. Choosing to reason remotely
   instead cost three round trips and shipped two wrong fixes to the
   user's phone. For any standalone-only iOS layout bug, add the readout
   first.

**The lesson worth keeping: Playwright cannot see either bug.** It does
not emulate safe-area insets, so `env(safe-area-inset-*)` evaluates to
`0` in headless Chromium and the e2e "nav is inside the viewport" test
passes happily on broken CSS. Safe-area layout is **device-only
verification**. The suite now carries structural guards asserting the
CSS *contains* correct safe-area rules (every `env()` has a `0px`
fallback, etc.) — those cannot prove correct rendering, only prevent
silent removal, and they are commented as such.

**A second, smaller pattern — it bit three times in one day.** Every
text-level assertion added that day initially accused correct code,
because none of them anchored the match to the construct they cared
about:

| Assertion | What it actually matched |
|---|---|
| `/@latest/` over `index.html` | a comment explaining why `@latest` is avoided |
| `/bottom\s*:\s*env\(/` over the CSS | `padding-bottom: env(...)` — the *correct* rule, since "padding-bottom" ends in "bottom" |
| `/black-translucent/` over `index.html` | the comment documenting why not to use `black-translucent` |

Each looked like a real failure and each was a false alarm. The middle
one was the worst: it could never pass on correct CSS, so the "obvious"
way to go green was to delete the correct padding. **A text-level
assertion that does not anchor its match will eventually accuse correct
code, and a suite that cries wolf is how tests get "corrected" until
they stop testing anything.** All three now match the construct itself —
an extracted URL, a property with a `(?<![-\w])` lookbehind, a `<meta>`
tag's `content` attribute.

**Cache bumps this session**: `memtest-v2` → `daily-v3` (rename) →
`daily-v4` (app shell) → `daily-v5` (safe-area) → `daily-v6` (canvas,
wrong fix) → `daily-v7` (diagnostics) → `daily-v8` (status-bar fix) →
`daily-v9` (diagnostics removed). Every one was required because a
cached asset actually changed. Worth noting how often this came up: on
iOS the installed app will happily keep serving the old bundle, and more
than once a "the fix didn't work" report was really "the phone never
received the fix" — check the served `CACHE` value before re-diagnosing
anything.

### Attempt 1 — 2026-08-21, local LAN test

**Goal**: prove the core loop works before touching GitHub — localStorage
persistence, add-to-home-screen installability, basic offline caching.

**What happened**:
1. Built the four core files (index.html, manifest.json, sw.js, icons).
2. First tried serving via Bash tool's `python3 -m http.server 8000` in the
   background — looked like it started (process visible in `ps aux`) but
   was unreachable even from `curl 127.0.0.1:8000` in a follow-up Bash call.
   See "Bash sandboxed network" note above. Killed this attempt.
3. Restarted the same server via the **PowerShell** tool instead — confirmed
   working with `Invoke-WebRequest http://127.0.0.1:8000/index.html` →
   `200`.
4. Generated icons — GDI+/System.Drawing approach hung for 2 minutes and
   was abandoned; switched to a pure-Python PNG encoder, which worked
   immediately.
5. Found LAN IP (`10.0.0.125`) via `ipconfig`.
6. Gave the user instructions to open `http://10.0.0.125:8000/index.html`
   on their iPhone (same WiFi), Add to Home Screen, tap the counter, kill
   the app, reopen, and confirm the count persisted.

**Status: CONFIRMED** (user report, 2026-08-21) — the page loaded on the
iPhone over LAN and Add to Home Screen / persistence worked. (This was
against the `localStorage`-only version, before Supabase wiring.)

### Attempt 2 — 2026-08-21, Supabase wiring + verification (no phone needed)

Checked the live Supabase project via MCP (`.mcp.json` already pointed at
project ref `okwzgmvnsdlheuolcthn`, further along than this file had
claimed): the `counter` table from `supabase-schema.sql` already existed
with RLS enabled, matching the schema file exactly. Only the client
wiring was missing. Pulled the project URL and publishable/anon key via
Supabase MCP tools and filled them into `index.html`.

**Verified the full read/write/reload cycle end-to-end without touching
the phone**, using a local PowerShell-served HTTP server + Chrome browser
automation + direct Supabase SQL queries as three independent checkpoints:
1. Page load → UI showed `4`, matching a direct `select value from
   counter where id=1` query run moments before.
2. Clicked `+1` in the browser → UI showed "saved to Supabase," value `5`.
3. Direct DB query (bypassing the app) → confirmed `value: 5` at the
   exact same timestamp shown in the UI. Proves the write actually hit
   Postgres, not just local app state.
4. Fresh page reload → re-fetched `5` from Supabase (not from any cached
   local value) — proves reads are live, not stale.

**Status: CONFIRMED.** Supabase wiring works correctly. (Left the live
counter at `5` from this test — cosmetic only, reset to `0` on request.)

### Attempt 3 — 2026-08-21, git + GitHub + Pages + keepalive setup

1. `git init`, default branch renamed to `main`.
2. `.gitignore` added (excludes `.mcp.json` — see Security/blueprint
   sections above for why).
3. Initial commit: 9 files (all tracked files listed above except
   `.gitignore` was a 10th... see "Current repo state" for the exact
   list).
4. `gh auth login` (device-code flow) — user approved in browser.
5. User explicitly confirmed (via an in-chat prompt) creating a public
   repo and pushing — see "auto-mode classifier" note above for why that
   confirmation was required even under a general "do it yourself"
   instruction.
6. `gh repo create memory-test-pwa --public --source=. --remote=origin
   --push` — repo created, but push initially **rejected** (missing
   `workflow` OAuth scope for the `.github/workflows/` file). Fixed with
   `gh auth refresh -h github.com -s workflow` (second device-code
   approval), then `git push -u origin main` succeeded.
7. GitHub Pages enabled via `gh api .../pages -X POST` targeting
   `main` / `/`. Confirmed live within ~40 seconds
   (`https://masihbn.github.io/memory-test-pwa/` → HTTP 200, and its
   HTML source confirmed to contain the correct filled-in Supabase
   URL/key).
8. `SUPABASE_URL` / `SUPABASE_ANON_KEY` repo secrets set (user confirmed
   first). Keepalive workflow manually triggered — **completed
   successfully** in ~9 seconds.

**Status: CONFIRMED** — repo, Pages, and keepalive workflow are all live
and verified working.

**Follow-up, now resolved**: at the time of writing, the user had not yet
personally opened the live HTTPS URL on their iPhone. That gap was closed
later the same day — see **Attempt 5** below.

## What's NOT done yet (important — don't assume it works)

- ~~**The real iPhone/Safari test against the live HTTPS URL.**~~
  **DONE 2026-08-21** — confirmed working end-to-end on the device by
  the user. See Test log, Attempt 5. This was the last unverified link
  in the deployment chain.
- ~~**The app's actual feature set is undecided.**~~ **RESOLVED
  2026-08-21** — the concept is settled and recorded in
  `docs/APP_CONCEPT.md` (product name "Daily"; generic trackables,
  re-log semantics, four chart types, bounded metrics), and broken into
  an ordered build plan in `docs/BUILD_PLAN.md`.
- **The app itself is still not built.** Everything shipped so far is
  plumbing (a tap counter proving hosting + backend + installability).
  This is the actual remaining work — see `docs/BUILD_PLAN.md`.
- **RLS/security hardening is not done.** Deliberately deferred to
  `BUILD_PLAN.md` Step 5.3, after the v1 feature set stabilizes — this
  is a recorded, accepted tradeoff (`APP_CONCEPT.md` → "RLS/auth
  hardening timing"), not an oversight. It still must happen before the
  app is shared, exposed more broadly, or treated as finished. See
  Security posture above.
- ~~**Project structure is still a single flat `index.html`.**~~
  **RESOLVED 2026-08-21** — reorganized into folders in Attempt 4 (see
  `CLAUDE.md` for the map). The JS will split further into ES modules
  at `BUILD_PLAN.md` Step 0.3.

## Hosting & backend architecture (cost, and where data actually lives)

Researched 2026-08-21. Two separate free services, not one "server":

1. **Static hosting — GitHub Pages.** Serves `index.html`/`manifest.json`/
   `sw.js` over HTTPS. No process to manage, nothing that "runs." **Free,
   but only for public repos** on the GitHub Free plan — private-repo Pages
   needs a paid plan (GitHub Pro, ~$4/mo+). Not a real downside here: the
   repo only ever holds app code, never actual data, so public is fine
   *for now* — revisit if the app itself needs to not be publicly loadable
   (see Security posture above; that's a separate concern from repo
   visibility). Site cap is 1GB, deploys time out at 10 minutes — way
   more than enough.
2. **Database ("memory") — Supabase** (hosted Postgres). The app calls
   Supabase's API directly over HTTPS from the phone; GitHub Pages never
   touches the data. Free tier: 500MB database storage, 1GB file
   storage, 5GB bandwidth/month, up to 2 projects. **Gotcha**: free
   projects auto-pause after 7 days of no database activity — handled by
   the keepalive workflow above.

Data lives in two places: **on-device** (`localStorage`/IndexedDB, fast,
offline, but wiped if the app/device is) and **in Supabase's Postgres**
(the actual backup/durability layer, now live and verified).

Sources: eesel.ai/blog/github-pricing, costbench.com/.../github/free-plan,
itpathsolutions.com/supabase-free-tier-limits, jetadmin.io/blog/supabase-
pricing-2026-guide.

### Attempt 4 — 2026-08-21, project pivot: skill/habit tracker + reorg

User specified the real app concept: a skill/habit tracker. Log skills
that aren't necessarily daily (e.g. "workout" 3-4x/week), some
boolean/done-not-done (workout) and some numeric (calories, cigarette
count), with two planned views: a monthly calendar (days marked when
logged) and a weekly trend chart (count/amount per week over time).

Two things done in response:
1. **Designed and applied the real schema** — `skills` +
   `skill_entries` tables, live on Supabase (verified via
   `list_tables`). Full rationale in `docs/DATA_MODEL.md`. Carries
   forward the same open-RLS pattern as `counter` (`using (true)`),
   tracked explicitly as a gap to close before storing anything the
   user would mind being exposed — see `docs/DATA_MODEL.md`'s Security
   status section and docs/PROJECT_NOTES.md's own Security posture section
   above.
2. **Reorganized the flat repo root** into `css/`, `js/`, `icons/`,
   `supabase/migrations/`, `docs/` — done with `git mv` to preserve file
   history. `index.html`/`manifest.json`/`sw.js` stayed at root (PWA/
   GitHub Pages convention; service worker scope depends on where it's
   served from). `sw.js`'s `CACHE` constant bumped to `memtest-v2` per
   the deploy-pipeline rule above, since its `ASSETS` list changed.
   Added `CLAUDE.md` (new, auto-loaded) as the high-level project
   reference, and `docs/DATA_MODEL.md` for full schema detail — see the
   pointer note near the top of this file.

**The actual skill-tracking UI (calendar view, weekly chart, add/edit
skill, log an entry) has NOT been built yet.** `index.html` is still the
placeholder tap-counter, just moved into the new file layout. That's the
next real chunk of work.

### Attempt 5 — 2026-08-21, live HTTPS iPhone test (closes the last plumbing gap)

**Goal**: verify the one link in the chain that cannot be checked from
this machine — real Safari on the real device, against the live GitHub
Pages HTTPS URL rather than the LAN test server used in Attempt 1.

**What was tested** (`https://masihbn.github.io/memory-test-pwa/`):
1. Page loads in iOS Safari over HTTPS.
2. Add to Home Screen — icon renders correctly.
3. Launching from the home screen opens **standalone** (no Safari
   chrome), i.e. the manifest's `display` mode is being honored.
4. Tapping `+1` writes through to Supabase.
5. Killing the app and reopening shows the persisted value.

**Status: CONFIRMED** (user report, 2026-08-21). All five steps worked.

**Why this mattered**: Attempt 1 only ever proved the *localStorage*
version worked over a LAN HTTP server. Service worker registration
behaves differently in Safari over real HTTPS, and Add-to-Home-Screen /
standalone launch have no desktop equivalent to test against — so until
this attempt, the deployment was verified everywhere *except* the one
environment it actually has to run in.

**What this does and does not prove**: it validates the full
plumbing chain — GitHub Pages hosting, HTTPS, PWA installability,
standalone launch, service worker, and Supabase read/write from the
device. It says nothing about the real app, which doesn't exist yet;
the thing tested here is the placeholder tap-counter, which Step 0.3 of
`docs/BUILD_PLAN.md` deletes. Device verification of the *actual*
"Daily" app is a separate, still-open item — `BUILD_PLAN.md` Step 5.4.

## Next steps (in order)

- [x] **User opens https://masihbn.github.io/memory-test-pwa/ on the
      iPhone** (Safari, Add to Home Screen, standalone launch, tap +1,
      kill and reopen). **DONE 2026-08-21 — see Test log, Attempt 5.**
      Reason it mattered: it was the one remaining unverified link in
      the chain — everything else about the deployment had already been
      independently confirmed from this machine (Test log Attempts 2–3),
      but Safari-specific service worker behavior, home-screen icon
      rendering and standalone launch needed the real device. All
      confirmed working.
- [ ] **Build the actual "Daily" app** per **`docs/BUILD_PLAN.md`** —
      that file is now the ordered, step-by-step execution plan (18
      steps, 5 phases), superseding this one-line item. Start at the
      first step not marked `DONE`. Reason: the concept is resolved
      (`docs/APP_CONCEPT.md`), the plumbing is fully verified as of
      Attempt 5, and everything built so far is scaffolding rather than
      the product itself.
- [ ] **Harden Supabase RLS (or add auth) before adding more sensitive
      skills.** Reason: `skills`/`skill_entries` currently carry forward
      the same wide-open `using (true)` policy as the test counter —
      acceptable for the current placeholder data, but should be fixed
      before logging anything (health specifics, journal-style notes)
      the user would mind being exposed if the URL/key leaked. See
      `docs/DATA_MODEL.md` → Security status.
