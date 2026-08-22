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
export const SUPABASE_URL = 'https://okwzgmvnsdlheuolcthn.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_JL-5T3kRE0jH0kLqKCcH9Q_-ljk_rxB';
