// Fill these in from Supabase dashboard -> Project Settings -> API Keys.
// Use the "Publishable key" (older projects call it "anon key") — it is
// DESIGNED to be public/embedded in client code, safe to commit. Row
// Level Security policies (set up in Supabase, not here) are what
// actually control access, not secrecy of this key. Never put the
// "Secret key" (aka "service_role key") here — that one bypasses RLS
// entirely and must never appear in client-side code.
const SUPABASE_URL = 'https://okwzgmvnsdlheuolcthn.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_JL-5T3kRE0jH0kLqKCcH9Q_-ljk_rxB';

const countEl = document.getElementById('count');
const metaEl = document.getElementById('meta');
const configured = SUPABASE_URL && SUPABASE_ANON_KEY;

const headers = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
  'Content-Type': 'application/json',
};

function setStatus(text) {
  metaEl.textContent = text;
}

function cacheLocally(value) {
  // Offline-only fallback view, never the source of truth.
  localStorage.setItem('lastKnownCount', String(value));
}

async function fetchFromCloud() {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/counter?id=eq.1&select=value',
    { headers }
  );
  if (!res.ok) throw new Error('Supabase fetch failed: ' + res.status);
  const rows = await res.json();
  if (!rows.length) throw new Error('No counter row found (id=1)');
  return rows[0].value;
}

async function writeToCloud(value) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/counter?id=eq.1', {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify({ value, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error('Supabase write failed: ' + res.status);
  const rows = await res.json();
  return rows[0].value;
}

async function load() {
  if (!configured) {
    const cached = localStorage.getItem('lastKnownCount');
    countEl.textContent = cached ?? '0';
    setStatus('SUPABASE_URL / SUPABASE_ANON_KEY not set yet — showing local cache only');
    return;
  }
  try {
    const value = await fetchFromCloud();
    countEl.textContent = value;
    cacheLocally(value);
    setStatus('loaded from Supabase at ' + new Date().toLocaleTimeString());
  } catch (err) {
    const cached = localStorage.getItem('lastKnownCount');
    countEl.textContent = cached ?? '0';
    setStatus('offline — showing last known value (' + err.message + ')');
  }
}

async function bump(delta) {
  const next = delta === 0 ? 0 : Number(countEl.textContent) + delta;
  countEl.textContent = next;
  if (!configured) {
    cacheLocally(next);
    setStatus('SUPABASE_URL / SUPABASE_ANON_KEY not set yet — showing local cache only');
    return;
  }
  try {
    const confirmed = await writeToCloud(next);
    countEl.textContent = confirmed;
    cacheLocally(confirmed);
    setStatus('saved to Supabase at ' + new Date().toLocaleTimeString());
  } catch (err) {
    setStatus('save failed, not synced — ' + err.message);
  }
}

document.getElementById('inc').addEventListener('click', () => bump(1));
document.getElementById('reset').addEventListener('click', () => bump(0));

load();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js');
  });
}
