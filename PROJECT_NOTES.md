# Project: Personal iPhone App (no App Store)

Last updated: 2026-08-21

This is a reference doc, not an auto-loaded file — it is NOT named
CLAUDE.md on purpose, so it won't be pulled into context automatically at
the start of every session. Point a future session at it explicitly (e.g.
"read PROJECT_NOTES.md") when you want the full history. Keep it updated
as the project evolves — append to the Test Log rather than deleting past
entries, so the reasoning trail stays intact.

**This file is also the operational blueprint for the GitHub side of this
project** — how the repo is configured, how the deploy pipeline works, how
the every-5-days Supabase keepalive workflow runs, and the `gh` CLI
mechanics that weren't obvious the first time through. See "GitHub &
deployment blueprint" below before touching any of that again.

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

The live setup, as of 2026-08-21:

- **Repo**: https://github.com/masihbn/memory-test-pwa — **public**
  (required for free GitHub Pages; private-repo Pages needs paid GitHub
  Pro). Created and pushed via `gh repo create memory-test-pwa --public
  --source=. --remote=origin --push`.
- **GitHub account used**: `masihbn`, authenticated locally via `gh auth
  login` (device-code flow, credentials cached in the Windows keyring —
  future sessions should just work; check with `gh auth status`).
- **Live URL (GitHub Pages)**: https://masihbn.github.io/memory-test-pwa/
  — serves from the `main` branch, root path (`/`). Enabled via:
  `gh api repos/masihbn/memory-test-pwa/pages -X POST -f
  "source[branch]=main" -f "source[path]=/"`.
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
`main`, pushed to `github.com/masihbn/memory-test-pwa`. Tracked files:

- `index.html` — the entire app. A "Memory Test" page: big tap counter,
  `+1` / `Reset` buttons. Reads/writes the count via Supabase's REST API
  (PostgREST) with plain `fetch` — `SUPABASE_URL` / `SUPABASE_ANON_KEY`
  constants at the top of the `<script>` block are **filled in and
  live** (see GitHub & deployment blueprint above for the values).
  `localStorage` (`lastKnownCount`) is only an offline-view fallback if
  the Supabase fetch fails — never the primary store. Registers the
  service worker, includes `apple-mobile-web-app-capable` meta tags and
  an `apple-touch-icon` link (what iOS actually uses for the home screen
  icon — separate from the manifest's `icons` array).
- `manifest.json` — PWA manifest: name "Memory Test", `display:
  standalone`, references `icon-192.png` / `icon-512.png`.
- `sw.js` — minimal service worker: network-first with cache fallback on
  fetch (tries the network, caches a copy of successful responses, falls
  back to cache only if the network fetch fails/offline), cleans up any
  cache not matching the current `CACHE` constant on activate. **Bump
  `CACHE` when shipping asset changes** — see deploy pipeline above.
- `icon-192.png`, `icon-512.png` — solid blue-square placeholder icons,
  generated with a hand-rolled PNG encoder in Python (no text/logo yet,
  purely functional placeholders).
- `supabase-schema.sql` — creates the `counter` table (single row, id=1)
  and its RLS policies. Already applied to the live project — this file
  is now a record of what was run, not a pending step.
- `.github/workflows/supabase-keepalive.yml` — see keepalive section
  above. Live and verified working.
- `.gitignore` — excludes `.mcp.json` (local Claude Code MCP connector
  config, not app code, not needed to build/run/deploy the app).
- `PROJECT_NOTES.md` — this file.

**Not tracked / not present in the repo:**
- `.mcp.json` exists locally (points the Supabase MCP server at project
  `okwzgmvnsdlheuolcthn`) but is gitignored on purpose — it's
  machine/session config, not part of the deployed app.
- `.claude/settings.local.json` — excluded automatically by Claude
  Code's own global ignore rules, no action needed.

## Test log

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

**Still outstanding**: the user has not yet personally opened the live
HTTPS URL on their iPhone (Add to Home Screen, standalone launch, reload
persistence over cellular). Instructions were given; result not yet
reported back as of this writing.

## What's NOT done yet (important — don't assume it works)

- **The real iPhone/Safari test against the live HTTPS URL** hasn't been
  confirmed by the user yet — this is the one thing that can't be
  verified from this machine (service worker registration behavior in
  Safari specifically, Add to Home Screen icon rendering, standalone
  launch). Everything else about the deployment has been independently
  verified (see Test log, Attempts 2–3).
- **The app's actual feature set is undecided.** Everything so far is
  plumbing (a tap counter proving hosting + backend + installability).
  The user has not yet specified what the real day-to-day app should do.
- **RLS/security hardening is not done** and shouldn't be treated as
  "later cleanup" — it needs to happen *before* any real/personal data
  is stored, not after. See Security posture above.
- **Project structure is still a single flat `index.html`** — fine for
  a one-page plumbing test, not the shape the real app should take. See
  "Restructuring the project" — to be filled in once decided.

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

## Next steps (in order)

- [ ] **User opens https://masihbn.github.io/memory-test-pwa/ on the
      iPhone** (Safari, cellular or WiFi), Add to Home Screen, launch
      standalone, tap +1, kill and reopen. Reason: the one remaining
      unverified link in the chain — everything else about the
      deployment has already been independently confirmed from this
      machine (see Test log Attempts 2–3); this specific step needs the
      real device and hasn't been reported back yet.
- [ ] **Decide the real app concept/features.** Reason: everything built
      so far is plumbing (hosting, backend, installability) proven with
      a placeholder counter — the user hasn't yet specified what the app
      should actually do day-to-day, and that decision drives every
      structural choice from here (data model, pages/routes, whether
      auth is needed).
- [ ] **Decide and document a project structure** before adding real
      features. Reason: requested explicitly by the user this session —
      a single flat `index.html` won't scale once there's real feature
      logic, and deciding this before writing more code avoids a messy
      mid-project refactor.
- [ ] **Harden Supabase RLS (or add auth) before storing anything
      personal.** Reason: current policies allow anyone with the public
      URL to read/write data with no restriction — acceptable for a
      throwaway counter, not acceptable the moment real user data is
      involved (see Security posture above).
