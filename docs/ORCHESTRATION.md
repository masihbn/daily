# Orchestration protocol — how "Daily" gets built

**Read this before executing any step of `docs/BUILD_PLAN.md`.**

`BUILD_PLAN.md` says *what* to build and in what order. This file says
*how the session runs* — the model policy, the subagent roles, the
implement→test→fix loop, and the rules about when to stop.

---

## 0. Session setup — do this first

### Model policy (non-negotiable)

| Role | Model | Why |
|---|---|---|
| **Orchestrator** (the main session — you) | **The strongest model available** — Fable 5.1 as of 2026-09-04; Opus is the floor | Holds the whole plan, writes subagent prompts, judges whether a failure is a bad test or bad code, decides when to escalate. This is the judgment-heavy work. |
| **All subagents** | **Sonnet** | Bounded, well-specified tasks: implement one module, write one test file, run the suite and diagnose. Cheap and fast, which matters because the loop runs many times. |

**Verify you are running Opus or better before doing anything else.**
If you are on Sonnet or Haiku, tell the user and stop — do not
orchestrate from a smaller model. The user can switch with
`/model opus` (or a newer top-tier model, when one is available).
(Updated 2026-09-04, Step D.6b: the policy was written when Opus was
the top model; the rule is "top tier orchestrates, Sonnet executes",
not "Opus specifically".)

**How to enforce Sonnet on subagents:** pass `model: "sonnet"`
explicitly in every `Agent` call.

```
Agent({
  subagent_type: "general-purpose",
  model: "sonnet",
  description: "Implement dates.js",
  prompt: "<the full prompt you wrote>"
})
```

> **Do not use `subagent_type: "fork"` for these.** A fork always
> inherits the parent's model and silently ignores a `model` override —
> you would be running Opus subagents without noticing. `fork` also
> inherits your entire context, which defeats the point: subagents are
> supposed to work from the explicit prompt you wrote, not from your
> conversation history.

### Orientation

1. Read `CLAUDE.md` (auto-loads).
2. Read `docs/BUILD_PLAN.md` — Ground Rules + Architecture decisions in
   full, then find the first step not marked `DONE`.
3. Skim `docs/APP_CONCEPT.md` for the *why* behind the step you're on.
4. Confirm the previous step's status is genuinely `DONE` — meaning its
   Test Subjects section has real recorded results, not just a status
   line someone flipped.

---

## 1. The four roles

You (the orchestrator) never write feature code yourself. You write prompts, judge
results, and own the repo's state.

| Role | Model | Writes | Never touches |
|---|---|---|---|
| **Orchestrator** | Top tier (Fable 5.1 / Opus) | `BUILD_PLAN.md` statuses, commits, prompts | feature code, test code |
| **Implementer** | Sonnet | `js/**`, `css/**`, `index.html`, migrations | `tests/**` |
| **Test Author** | Sonnet | `tests/**` | `js/**`, `css/**`, `index.html` |
| **Test Runner / Diagnostician** | Sonnet | nothing (read-only diagnosis) | everything — it reports, it does not fix |

**The Implementer/Test Author file boundary is the whole point.** They
run *in parallel*, from the same interface contract you write, without
seeing each other's output. That way the tests describe the agreed
behavior rather than describing whatever the implementation happened to
do. An implementer that can edit tests will make failing tests pass by
editing them, and you will never find out.

---

## 2. The step execution loop

```
   ┌─ 1. Orchestrator writes the interface contract + two prompts
   │
   ├─ 2. Implementer (Sonnet) ──┐
   │                            ├── in parallel, one message
   ├─ 2. Test Author (Sonnet) ──┘
   │
   ├─ 3. Test Runner (Sonnet) runs the FULL suite (new + all prior)
   │
   ├─ 4. All green? ──yes──► 5. Orchestrator verifies, records, commits
   │        │
   │        no
   │        ▼
   │   Diagnostician (Sonnet) reports root cause — does NOT fix
   │        │
   │        ▼
   │   Orchestrator judges: bad code, or bad test?
   │        │
   │        ▼
   │   Dispatch a fix to the right agent ─────► back to 3
   │   (max 5 cycles, then escalate to user)
   │
   └─ End of phase? ──► HARD STOP. Deploy, hand user a checklist, wait.
```

### Step 1 — Write the interface contract

Before spawning anything, decide and write down the **exact module
interface**: file paths, exported function names, parameter shapes,
return shapes, and error behavior. Both subagents get this verbatim.

This is the highest-leverage thing you do. If the contract is vague, the
implementer and test author will diverge and you'll burn a fix cycle on
a mismatch that was your fault, not theirs.

### Step 2 — Spawn Implementer and Test Author in parallel

Both `Agent` calls go in **one message** so they run concurrently.

### Step 3 — Run the full suite

Spawn the Test Runner *after* both have reported. It runs **the entire
suite, not just the new tests** — see §4.

### Step 4 — On failure, diagnose before fixing

The Diagnostician's job is to explain, not repair. It reports: which
tests failed, the actual vs. expected values, the root cause, and a
proposed fix. **You** then make the call that Sonnet should not make
alone:

> **Is the code wrong, or is the test wrong?**

Both happen. A test author working only from a contract can encode a
misreading of it. But the default assumption must be **the code is
wrong** — because the alternative is the failure mode where tests get
"corrected" until they pass and the suite becomes decorative.

**Never let a subagent weaken, delete, skip, or loosen a test to make it
pass.** If a test genuinely encodes wrong expectations, *you* decide
that, and the change gets recorded in the step's Test Subjects with the
reasoning. A test changed to accommodate an implementation is a test
that has stopped testing anything.

### Step 5 — Verify before recording

Do not trust "done" from a subagent. Before flipping a status:

- Read the actual diff (`git diff`), not the subagent's summary of it.
- Confirm the test suite really ran and really passed — look at the
  output, not the claim.
- Confirm `sw.js`'s `CACHE` was bumped if any cached asset changed.
- Confirm the step's **Test Subjects** section in `BUILD_PLAN.md` is
  filled in with what was actually tested and the result.
- Then set the step's status to `DONE` and commit.

---

## 3. Prompt templates

Every subagent starts cold. It has none of your context. Everything it
needs must be in the prompt.

### Implementer prompt

```
You are implementing ONE step of a build plan for a personal PWA
habit/metric tracker called "Daily". You are NOT designing anything —
the design is settled. Build exactly what is specified.

## Project constraints (violating any of these is a bug)
- Plain HTML/CSS/JS. NO build step, NO bundler, NO framework.
- Native ES modules (`<script type="module">`). Never assume file://.
- Backend is Supabase via raw fetch (PostgREST). No Supabase JS client.
- If you change any cached asset, bump the `CACHE` constant in sw.js.
- Read CLAUDE.md and docs/BUILD_PLAN.md "Ground rules" before starting.

## Your task
<paste the BUILD_PLAN step verbatim: Goal, Deliverables,
 Implementation notes>

## Interface contract — implement EXACTLY these signatures
<exact exports, params, returns, error behavior>

## Boundaries
- You may ONLY edit: <explicit file list>
- You must NOT create or edit anything under tests/. A separate agent
  is writing the tests in parallel, against this same contract.
- If the contract seems wrong or ambiguous, STOP and report the
  ambiguity. Do not resolve it yourself and do not invent behavior.

## Report back
- What you changed, file by file.
- Any assumption you had to make.
- Anything you could not do.
```

### Test Author prompt

```
You are writing tests for ONE step of a build plan for a personal PWA
called "Daily". You are writing tests AGAINST A CONTRACT — the
implementation is being written in parallel by another agent and you
cannot see it. Test the specified behavior, not an implementation.

## Test stack
- Pure logic (dates, aggregation, normalization): Node's built-in test
  runner — `node --test`. Zero dependencies. These are the important
  ones; be thorough here.
- UI / integration: Playwright (devDependency, test-only, never shipped).
- Supabase-touching tests: create trackables named `__test__<something>`
  and delete them in teardown. NEVER touch rows that aren't yours.

## Your task
<paste the BUILD_PLAN step's Goal + Implementation notes>

## Interface contract — test EXACTLY these signatures
<same contract given to the implementer, verbatim>

## Cases you MUST cover
<the orchestrator's explicit list — see §5 for how to derive it>

## Boundaries
- You may ONLY create/edit files under tests/.
- You must NOT edit anything under js/, css/, or index.html.
- Tests must be deterministic. No dependence on the real current date,
  on network flakiness, or on test execution order.
- If the contract is ambiguous, STOP and report it. Do not guess.

## Report back
- Test files created, and what each covers.
- Any case in the required list you could not test, and why.
```

### Test Runner / Diagnostician prompt

```
You are running the regression suite for the "Daily" PWA and diagnosing
any failures. You are a DIAGNOSTICIAN — you do NOT fix anything.

## Run
From PowerShell (not the Bash tool — Bash on this machine runs in an
isolated network namespace and local servers are unreachable from it):
  npm test
This runs the ENTIRE suite: every test from every previously completed
step, plus this step's new tests.

## If everything passes
Report: total tests run, pass count, and the runtime. Done.

## If anything fails
For EACH failure report:
- The test name and file.
- Expected vs. actual, verbatim.
- Your root-cause analysis — what is actually wrong, not just what the
  assertion said.
- Whether you believe the CODE is wrong or the TEST is wrong, and why.
- A specific proposed fix (file + what to change).

Then STOP. Do not edit any file. The orchestrator decides what to change.

## Critical
Never make a test pass by changing the test. If you believe a test
encodes a wrong expectation, say so and explain — that is a decision for
the orchestrator, not for you.
```

---

## 4. The regression suite grows and is always run in full

This is the core discipline the user asked for.

- **Every step adds tests. No step removes them.**
- **Every test run is the full suite** — all tests from all completed
  steps, every time. Never "just the new ones."
- A step is not `DONE` until the *entire* suite is green, not just its
  own tests. If Step 3.2 breaks a Step 1.2 test, Step 3.2 is not done.

**Why in full, every time:** the whole risk profile of this project is
regression. `aggregate.js` and `dates.js` get consumed by five different
charts built across three phases. A change to ISO-week handling in Phase
3 can silently corrupt the Phase 2 heatmap. Cheap, fast, always-run
tests are the only thing that catches that.

### Layout

```
package.json         test-only: Playwright devDependency + npm scripts.
                      NOT part of the deploy. GitHub Pages ignores it.
node_modules/        gitignored.
tests/
  unit/              node --test. Pure fns. Fast, run constantly.
  integration/       real PostgREST calls against __test__ rows.
  e2e/               Playwright. Real browser, real canvas, real SW.
  helpers/
    supabase.mjs     __test__ row creation + teardown + stale sweep.
    server.mjs       zero-dep static server for Playwright's webServer.
```

`npm test` runs all three tiers in order (fast → slow) and fails on the
first tier that fails.

### Test data isolation

> **Changing at Step D.4 (2026-08-25).** Tests are moving to a **second
> Supabase project**, because the live one now holds the user's real
> logged data. Until D.4 lands, everything below still applies and the
> `__test__` convention is the only thing protecting that data. After
> D.4, the convention stays (it is cheap and it is defence in depth) but
> the live project is no longer the target.

Tests write to the **live** Supabase project, so isolation is by naming
convention and is mandatory:

- Every test-created trackable is named `__test__<step>_<case>`.
- Teardown deletes them. Entries cascade via the FK.
- **The suite sweeps stale `__test__*` rows before it starts** — a
  crashed run leaves orphans, and orphans accumulate into flaky tests.
- **Nothing may ever delete or modify a row not prefixed `__test__`.**
  This is the guardrail protecting real logged data. Put it in every
  test-touching prompt.

---

## 5. Deriving the test cases (this is your job, not the subagent's)

The `BUILD_PLAN.md` Test Subjects sections are deliberately empty. You
fill them by specifying cases in the Test Author's prompt. Don't ask for
"good coverage" — enumerate. Derive cases from four sources:

1. **The contract** — every function, its happy path and its documented
   error behavior.
2. **The Implementation notes' explicit warnings.** `BUILD_PLAN.md`
   calls out specific traps; each one is a test case. Examples already
   written down there:
   - `todayLocal()` must not shift day near midnight in a non-UTC zone.
   - `parseLocal()` must not interpret `'2026-08-21'` as UTC midnight.
   - `isoWeekKey()` must handle the late-Dec/early-Jan year boundary,
     where the ISO week year differs from the calendar year.
   - `normalizeSeries()` must not return `NaN` when `min === max`.
   - `applyRelog()` — all three semantics: boolean idempotent,
     cumulative adds, state replaces.
   - Zero-entry weeks must render as explicit gaps, not be omitted.
   - `average` must use days-with-an-entry as its denominator.
3. **Boundaries and degenerate inputs** — empty series, one data point,
   a single day, a leap day, a DST transition, a trackable with no
   entries at all, more data than the rolling window and less.
4. **Regression cases** — every bug found during a fix cycle becomes a
   permanent test. This is non-negotiable: a bug that escaped once will
   escape again.

Bias heavily toward **unit tests on pure functions**. They are fast,
deterministic, and cover where the real bugs live. Use Playwright for a
small number of high-value smoke checks (page loads without throwing,
a log round-trips, a chart renders a canvas) — not for logic.

---

## 6. Failure loop and escalation

On a failing suite: diagnose → orchestrator judges → dispatch fix →
re-run **full** suite. Repeat.

**Escalate to the user after 5 failed cycles on the same failure.** When
you escalate, report: what the test expects, what actually happens, the
five things tried, and your honest best theory of what's really wrong.
Do not just say "still failing."

Before cycle 5, if two consecutive cycles produce the same diagnosis,
stop and rethink rather than re-dispatching — repeating a fix that
already failed is not a cycle worth spending.

### Absolute blockers — stop immediately, don't spend cycles

Escalate on sight, regardless of cycle count:

- **Anything needing a credential, an approval, or a device only the
  user has** — `gh auth`, a browser login, testing on the iPhone.
- **Any public or hard-to-reverse action** — creating/renaming a repo,
  changing Pages settings, force-pushing, deleting data. These need
  explicit confirmation every time, even under standing autonomy
  instructions. (Recorded in `PROJECT_NOTES.md`; expect Claude Code's
  own permission classifier to gate them too.)
- **A contradiction inside `APP_CONCEPT.md`**, or a step that can't be
  built as specified. Do not resolve a design conflict unilaterally —
  that doc is the record of the user's decisions.
- **Anything implying schema change beyond what the step authorizes**,
  or any temptation to touch RLS outside its own step. **That step is now
  D.7, not 5.3** (moved 2026-08-25 — see `BUILD_PLAN.md`'s decision log).
  The rule is unchanged in spirit: RLS changes happen in one authorized
  step, never opportunistically from another.
- **Test data isolation broken** — a test touched a non-`__test__` row.
  Stop everything; this risks real logged data.

---

## 7. Phase gates — hard stop

**At the end of every phase, stop and wait for the user.** Confirmed
explicitly: do not begin the next phase on an unverified foundation.

At each gate:

1. Confirm the full suite is green.
2. Commit and push. Wait for GitHub Pages (~30–90s; a 404 in the first
   minute is normal, not a failure).
3. Give the user a **short, concrete manual test script** — the specific
   taps to perform on their phone and what they should see. Not "please
   test the app."
4. Note anything you could not verify from this machine and are relying
   on them to check (Safari service worker behavior, Add to Home Screen,
   standalone launch, the CSV download path, Face ID).
5. **Stop. Wait for their verdict.** Fold their feedback in before
   starting the next phase.

Within a phase, keep moving without pausing between steps.

---

## 8. Bookkeeping (every step, no exceptions)

- Update the step's **Status** in `BUILD_PLAN.md`.
- Fill in the step's **Test Subjects** with what was actually tested and
  the result — this is the project's evidence trail. "Tested, works" is
  not acceptable; name the cases and the outcome.
- Commit with a real message explaining *why*, staging deliberately
  (`git add <files>`, never `git add -A`).
- Append to `docs/PROJECT_NOTES.md`'s Test log for anything device-
  verified or any gotcha worth saving future-you the time.
- Keep `docs/DATA_MODEL.md` describing what is *actually live* after any
  migration.

---

## 9. Quick reference

| Question | Answer |
|---|---|
| Orchestrator model | Top tier — Fable 5.1 as of 2026-09-04; Opus is the floor |
| Subagent model | Sonnet, passed explicitly as `model: "sonnet"` |
| Subagent type | `general-purpose` — **never `fork`** (ignores model override) |
| Implementer + Test Author | Parallel, one message, strict file boundaries |
| Test scope per run | Always the FULL suite |
| Who may edit tests to pass | Nobody without orchestrator approval |
| Fix cycles before escalating | 5 |
| Phase gate | Hard stop, wait for user |
| Within a phase | Keep moving |
| Test data | `__test__*` prefix, swept and torn down. Moving to a second Supabase project at Step D.4 |
| Never touch during v1 | RLS policies (**Step D.7**, moved from 5.3), the `counter` table |
| Current step | **Phase D** — see `BUILD_PLAN.md`. Feature work parked at 3.3b; resume at 3.4 |
