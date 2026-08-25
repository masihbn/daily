// Supabase connection constants — the single source of truth for these.
// Both the app and the test helpers (tests/helpers/supabase.mjs) import
// from here, so a project change is a one-line edit in one place.
//
// These come from the Supabase dashboard -> Project Settings -> API Keys.
// This is the "Publishable key" (older projects call it "anon key") — it is
// DESIGNED to be public/embedded in client code, safe to commit. Row
// Level Security policies (set up in Supabase, not here) are what
// actually control access, not secrecy of this key. Never put the
// "Secret key" (aka "service_role key") here — that one bypasses RLS
// entirely and must never appear in client-side code.
// Step D.4: allow Node to override these so the test tiers can be pointed at
// a SEPARATE Supabase project, instead of writing to the one holding the
// user's real logged data.
//
// This is inert in the browser. `process` does not exist there, so the
// deployed app always gets the literals below — verified by a unit test that
// asserts the fallbacks are exactly the production values.
//
// The tradeoff, stated plainly: this puts a test-shaped concern into app
// code. The alternatives were worse for this project — dependency-injecting
// the URL through every module that reaches api.js, or introducing a build
// step to swap the constants, and "no build step" is a foundational rule
// here. Ten guarded lines in one file is the smaller cost.
function envOverride(name) {
  try {
    if (typeof process === 'undefined' || !process || !process.env) return null;
    const raw = process.env[name];
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    // Any environment where touching `process` throws is, by definition, not
    // one running the tests.
    return null;
  }
}

export const SUPABASE_URL =
  envOverride('DAILY_SUPABASE_URL') ?? 'https://okwzgmvnsdlheuolcthn.supabase.co';
export const SUPABASE_ANON_KEY =
  envOverride('DAILY_SUPABASE_KEY') ?? 'sb_publishable_JL-5T3kRE0jH0kLqKCcH9Q_-ljk_rxB';
