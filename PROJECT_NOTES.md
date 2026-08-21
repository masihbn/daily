# Project: Personal iPhone App (no App Store)

Last updated: 2026-08-21

This is a reference doc, not an auto-loaded file — it is NOT named
CLAUDE.md on purpose, so it won't be pulled into context automatically at
the start of every session. Point a future session at it explicitly (e.g.
"read PROJECT_NOTES.md") when you want the full history. Keep it updated
as the project evolves — append to the Test Log rather than deleting past
entries, so the reasoning trail stays intact.

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
- Data can be stored in a real backend (planned: Supabase/Postgres or
  similar) for backup/"memory," with local caching for offline use.

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

## Environment notes (things that bit us, save future-self the time)

- **Machine**: Windows 11, PowerShell 5.1 available natively. A separate
  "Bash" tool is also available but it runs in what appears to be a
  **sandboxed/isolated network namespace** — a Python `http.server`
  started through it could not be reached even via `127.0.0.1` from a
  second Bash call, and `ps aux` showed the process running but nothing
  was actually listening from the caller's perspective.
  → **Lesson: use PowerShell, not Bash, for anything that needs to bind to
  a real network interface** (local test servers, anything the phone needs
  to reach). Bash is fine for git/file operations.
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
- **Windows Firewall is a likely blocker** for phone-to-PC LAN testing:
  the server responded fine to `127.0.0.1` locally, but whether the
  firewall allows inbound connections from another device (the iPhone) was
  **never confirmed either way** — the session ended before the user
  reported back. Check this first if a future LAN test fails to load on
  the phone; may need an inbound firewall rule for the port in use.

## Current repo state

Not yet a git repository. Files created so far, all in the project root:

- `index.html` — the entire test app. A "Memory Test" page: big tap
  counter, `+1` / `Reset` buttons, persists the count to `localStorage`
  (proves the "data survives app restarts" concept), registers the service
  worker, includes `apple-mobile-web-app-capable` meta tags and an
  `apple-touch-icon` link (this is what iOS actually uses for the home
  screen icon — separate from the manifest's `icons` array, which other
  platforms use).
- `manifest.json` — PWA manifest: name "Memory Test", `display: standalone`,
  references `icon-192.png` / `icon-512.png`.
- `sw.js` — minimal service worker: caches the app shell on install
  (cache-first-with-network-fallback style — fetches network, falls back
  to cache if offline), cleans up old cache versions on activate.
- `icon-192.png`, `icon-512.png` — solid blue-square placeholder icons,
  generated with a hand-rolled PNG encoder in Python (no text/logo yet,
  purely functional placeholders).

## Supabase wiring (added 2026-08-21, not yet live-tested)

`index.html` now reads/writes the counter via Supabase's REST API
(PostgREST) with plain `fetch` — no extra JS library needed. Source of
truth on load is a network fetch to Supabase; `localStorage` is now only
an offline-view cache (`lastKnownCount`), not the primary store. If
`SUPABASE_URL`/`SUPABASE_ANON_KEY` (top of the `<script>` block) are left
blank, the app falls back to local-cache-only mode and says so in the UI —
this was intentional so the app doesn't silently break before those are
filled in.

Supporting files added:
- `supabase-schema.sql` — creates the `counter` table (single row, id=1)
  and the RLS policies that let the anon key read/update it. Must be run
  once in the Supabase SQL Editor after creating the project.
- `.github/workflows/supabase-keepalive.yml` — scheduled (`cron: '0 0 */5 * *'`,
  roughly every 5 days) + manually runnable (`workflow_dispatch`) ping to
  the counter table, to stay under Supabase's 7-day free-tier auto-pause
  threshold. Needs `SUPABASE_URL` and `SUPABASE_ANON_KEY` added as repo
  secrets (Settings -> Secrets and variables -> Actions) once the repo is
  on GitHub — won't work until then.

**gh CLI is not authenticated on this machine** (`gh auth status` fails) —
repo creation/push will need either `gh auth login` first or the user
creating the repo manually on github.com.

**The "proof it's not local" test (from the plan below) has not been run
yet** — needs a live Supabase project + the URL/key filled in + a
deployment, none of which exist yet as of this writing.

## Test log

### Attempt 1 — 2026-08-21, local LAN test

**Goal**: prove the core loop works before touching GitHub — localStorage
persistence, add-to-home-screen installability, basic offline caching.

**What happened**:
1. Built the four files above.
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
iPhone over LAN and Add to Home Screen / persistence worked.

### Supabase wiring — 2026-08-21

Checked the live Supabase project via MCP (`.mcp.json` already pointed at
project ref `okwzgmvnsdlheuolcthn`, which turned out to be further along
than this file previously claimed): the `counter` table from
`supabase-schema.sql` was already created, with RLS enabled, matching the
schema file exactly. Only the client wiring was missing. Pulled the
project URL and publishable (anon) key via the Supabase MCP tools and
filled them into `index.html`'s `SUPABASE_URL` / `SUPABASE_ANON_KEY`
constants. **Not yet re-tested on the phone/LAN against the live table** —
next session (or later today) should reload the app and confirm the
counter reads/writes against Supabase instead of local-cache-only mode.

## What's NOT done yet (important — don't assume it works)

- The "memory"/backup requirement is **wired but not yet re-verified**.
  `index.html` now has real `SUPABASE_URL`/`SUPABASE_ANON_KEY` values
  pointing at the live `counter` table (see Supabase wiring note above),
  but this hasn't been reloaded/tapped on the phone or LAN yet to confirm
  reads/writes actually hit Supabase instead of falling back to
  local-cache-only mode.
- No git repository exists yet for this project.
- Nothing has been deployed anywhere reachable over the internet — only
  tested (confirmed working) on the local WiFi network.
- Service worker offline behavior hasn't actually been verified on the
  phone (requires the LAN test above to succeed first; also note iOS
  service workers need a secure context — plain `http://` over LAN may not
  let the service worker register at all, even though the page and
  localStorage will still work over plain http. This is expected and fine
  for now, since the real deployment will be HTTPS via GitHub Pages).

## Hosting & backend architecture (cost, and where data actually lives)

Researched 2026-08-21. Two separate free services, not one "server":

1. **Static hosting — GitHub Pages.** Serves `index.html`/`manifest.json`/
   `sw.js` over HTTPS. No process to manage, nothing that "runs." **Free,
   but only for public repos** on the GitHub Free plan — private-repo Pages
   needs a paid plan (GitHub Pro, ~$4/mo+). Not a real downside here: the
   repo only ever holds app code, never actual data, so public is fine.
   Site cap is 1GB, deploys time out at 10 minutes — way more than enough.
2. **Database ("memory") — Supabase** (hosted Postgres, recommended
   default). The app calls Supabase's API directly over HTTPS from the
   phone; GitHub Pages never touches the data. Free tier: 500MB database
   storage, 1GB file storage, 5GB bandwidth/month, up to 2 projects.
   **Gotcha**: free projects auto-pause after 7 days of no database
   activity (manual un-pause via dashboard, or prevent it with a scheduled
   ping — e.g. a free GitHub Actions cron job).

Data will live in two places once this is built: **on-device**
(`localStorage`/IndexedDB, fast, offline, but wiped if the app/device is)
and **in Supabase's Postgres** (the actual backup/durability layer).

Sources: eesel.ai/blog/github-pricing, costbench.com/.../github/free-plan,
itpathsolutions.com/supabase-free-tier-limits, jetadmin.io/blog/supabase-
pricing-2026-guide.

## Next steps (in order)

- [ ] **Confirm the LAN test actually worked on the phone.** Reason: this
      is the last unverified step from Attempt 1; everything downstream
      depends on knowing whether the current approach (manifest + SW +
      localStorage) even loads and installs correctly on this specific
      iPhone 15 / iOS version.
- [ ] **Deploy to a real internet-reachable server** — this is the user's
      explicitly requested next step. Planned approach: `git init`, create
      a GitHub repo, push, enable GitHub Pages. Reason: GitHub Pages gives
      free HTTPS hosting with zero server maintenance, directly matches the
      "push to GitHub → phone updates" workflow the user wants, and HTTPS
      is required for the service worker/offline caching and any future
      push notifications to work properly on iOS (LAN http testing can't
      validate this part).
- [ ] **Test the deployed URL on the iPhone over cellular data (not WiFi).**
      Reason: proves it's genuinely reachable over the internet and not
      just the local network, which is the actual point of "a server I can
      access through the Internet."
- [ ] **Re-test Add to Home Screen + persistence against the HTTPS URL.**
      Reason: confirms the production URL behaves the same as the LAN
      version, and lets us verify service worker registration/offline
      caching, which plain http couldn't validate.
- [ ] **Design and wire up the real backend for data storage** (likely
      Supabase given it's Postgres-based, has a generous free tier, and a
      simple JS client). Reason: this is the actual "memory"/backup
      requirement from the original ask — localStorage alone does not
      satisfy it, since it's lost if the app/device is wiped.
- [ ] **Decide the actual app concept/features beyond the counter test.**
      Reason: the counter was purely a plumbing test; the user hasn't yet
      specified what the real app is supposed to do day-to-day.
