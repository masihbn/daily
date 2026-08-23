// Home view: trackable list + quick-log (Step 2.1, revised by Step 2.1b —
// replace-only logging + direction-aware good/bad visuals). DOM + store
// wiring only — all re-log semantics, formatting, sorting and verdict/
// symbol logic live in ./home-model.js (pure) so this file's job is
// strictly: render the DOM, read/write through js/store.js, and never let
// anything throw out of an event handler.
//
// See docs/BUILD_PLAN.md Step 2.1 and the interface contracts (CONTRACT-
// 2.1.md, CONTRACT-2.1b.md) for the exact DOM shape, refresh sequence and
// result-mapping table this file implements.

import { getStore } from '../store.js';
import { todayLocal } from '../dates.js';
import { visibleTrackables, parseNumericInput, nextValueFor, rowModel } from './home-model.js';

export function createHomeView({ store, today } = {}) {
  const st = store || getStore();
  const day = today || todayLocal();

  let container = null;
  let sectionEl = null;
  let disposed = true; // becomes false once mount() actually starts

  // Map<String(id), rawTrackable> — rebuilt on every render from the
  // store's current data, so click handlers can always look up the RAW
  // trackable.id (never a string parsed out of a data-* attribute) to
  // pass to the store.
  let byId = new Map();

  // Refresh-sequence bookkeeping (contract §3.2).
  let initialLoadDone = false;
  let lastTrackablesError = null;
  let lastEntriesError = null;

  // Per-row transient state for an in-flight or just-settled write.
  // Map<String(id), { state: 'pending'|'failed', error: string|null, optimisticValue: number }>
  // Absence from this map means "idle — read straight from the store."
  const rowStatus = new Map();
  // Ids currently awaiting a store.saveEntry/removeEntry response.
  const inFlight = new Set();

  // Numeric editor state — only one row can be editing at a time.
  let editingId = null;
  let draftText = '';
  let editorError = null;
  let focusMode = null; // 'select' | 'restore' | null, consumed after each render

  function trackableById(idStr) {
    return byId.get(idStr) || null;
  }

  function findRowEl(idStr) {
    if (!sectionEl) return null;
    const rows = sectionEl.querySelectorAll('li.trow');
    for (const li of rows) {
      if (li.dataset.trackableId === idStr) return li;
    }
    return null;
  }

  // Reads whatever is currently typed into the open editor's input back
  // into `draftText` before the DOM is torn down and rebuilt. Safe to call
  // unconditionally on every render: when there is no open editor, or no
  // existing input for it yet (a fresh "open editor" render), this is a
  // no-op. See contract §3.4.
  function captureLiveDraft() {
    if (editingId === null || !sectionEl) return;
    const li = findRowEl(editingId);
    const input = li ? li.querySelector('.trow-input') : null;
    if (input) draftText = input.value;
  }

  function computeHomeState(visCount) {
    if (!initialLoadDone && visCount === 0) return 'loading';
    if (lastTrackablesError && visCount === 0) return 'error';
    if (visCount === 0) return 'empty';
    return 'ready';
  }

  function rowViewData(t) {
    const id = String(t.id);
    const rs = rowStatus.get(id);

    if (rs && rs.state === 'pending') {
      return { entry: { value: rs.optimisticValue }, status: 'pending', errorText: null };
    }
    if (rs && rs.state === 'failed') {
      return { entry: st.getEntry(t.id, day), status: 'failed', errorText: rs.error };
    }
    const entry = st.getEntry(t.id, day);
    const status = entry && entry.pending === true ? 'pending' : 'idle';
    return { entry, status, errorText: null };
  }

  function buildRow(t) {
    const { entry, status, errorText } = rowViewData(t);
    const model = rowModel(t, entry, status);
    const isEditing = editingId === model.id;
    const disabledNow = inFlight.has(model.id);

    const li = document.createElement('li');
    li.className = 'trow';
    li.dataset.trackableId = model.id;
    li.dataset.shape = model.shape;
    li.dataset.state = model.state;
    li.dataset.logged = String(model.logged);
    // Step 2.1b: a green check means "today is good", not "logged" — for a
    // break-direction habit the unlogged state is the good one. See
    // home-model.js verdict() and CONTRACT-2.1b.md §0. data-verdict and the
    // symbol below are recomputed on every render (including the
    // synchronous optimistic one in runWrite()), so a tap on a break habit
    // flips green-check -> red-cross immediately, before the network call
    // resolves.
    li.dataset.verdict = model.verdict;

    // Decorative shape+colour cue (WCAG 1.4.1: colour is never the only
    // cue — model.statusWord/valueText already carries the meaning to
    // assistive tech, so this stays aria-hidden and gets no label of its
    // own). Rendered via CSS content, not emoji — see styles.css.
    const symbolSpan = document.createElement('span');
    symbolSpan.className = 'trow-symbol';
    symbolSpan.setAttribute('aria-hidden', 'true');
    symbolSpan.dataset.symbol = model.statusSymbol;
    li.appendChild(symbolSpan);

    const nameLink = document.createElement('a');
    nameLink.className = 'trow-name';
    nameLink.href = `#/t/${encodeURIComponent(model.id)}`;
    nameLink.textContent = model.name;
    li.appendChild(nameLink);

    const valueSpan = document.createElement('span');
    valueSpan.className = 'trow-value';
    // Boolean rows show the word cue (Done / Not yet / Clean / Logged)
    // instead of the generic Done/— formatValue() text; numeric rows are
    // unchanged.
    valueSpan.textContent = model.shape === 'boolean' ? model.statusWord : model.valueText;
    li.appendChild(valueSpan);

    if (model.shape === 'numeric' && model.directionLabel) {
      const dirSpan = document.createElement('span');
      dirSpan.className = 'trow-direction';
      dirSpan.textContent = model.directionLabel;
      li.appendChild(dirSpan);
    }

    const hintSpan = document.createElement('span');
    hintSpan.className = 'trow-hint';
    hintSpan.textContent = model.hint;
    li.appendChild(hintSpan);

    if (model.shape === 'boolean') {
      const btn = document.createElement('button');
      btn.className = 'trow-log';
      btn.type = 'button';
      btn.dataset.action = 'toggle';
      btn.setAttribute('aria-pressed', String(model.logged));
      btn.setAttribute('aria-label', `Log ${model.name} for today`);
      btn.disabled = disabledNow;
      btn.textContent = 'Log';
      li.appendChild(btn);
    } else {
      // Numeric (and defensively, any unrecognized shape) rows open the
      // compact numeric editor instead of toggling directly.
      const btn = document.createElement('button');
      btn.className = 'trow-log';
      btn.type = 'button';
      btn.dataset.action = 'open-editor';
      btn.setAttribute('aria-label', `Log ${model.name} for today`);
      btn.disabled = disabledNow;
      btn.textContent = 'Log';
      li.appendChild(btn);

      if (isEditing) {
        const form = document.createElement('form');
        form.className = 'trow-editor';

        const input = document.createElement('input');
        input.className = 'trow-input';
        // type="text" + inputmode="decimal" is deliberate, NOT
        // type="number": inputmode="decimal" is what raises iOS's numeric
        // keypad, and type="number" would silently discard a decimal-comma
        // before parseNumericInput() ever sees it. Do not "fix" this to
        // type="number".
        input.type = 'text';
        input.setAttribute('inputmode', 'decimal');
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('enterkeyhint', 'done');
        input.setAttribute('aria-label', `New value for ${model.name}`);
        input.value = draftText;
        form.appendChild(input);

        const saveBtn = document.createElement('button');
        saveBtn.className = 'trow-save';
        saveBtn.type = 'submit';
        saveBtn.dataset.action = 'save';
        saveBtn.disabled = disabledNow;
        saveBtn.textContent = 'Save';
        form.appendChild(saveBtn);

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'trow-cancel';
        cancelBtn.type = 'button';
        cancelBtn.dataset.action = 'cancel';
        cancelBtn.textContent = 'Cancel';
        form.appendChild(cancelBtn);

        li.appendChild(form);

        if (editorError) {
          const errP = document.createElement('p');
          errP.className = 'trow-error';
          errP.setAttribute('role', 'alert');
          errP.textContent = editorError;
          li.appendChild(errP);
        }
      }
    }

    if (!isEditing && status === 'failed' && errorText) {
      const errP = document.createElement('p');
      errP.className = 'trow-error';
      errP.setAttribute('role', 'alert');
      errP.textContent = errorText;
      li.appendChild(errP);
    }

    return li;
  }

  function ensureSection() {
    if (sectionEl) return sectionEl;
    sectionEl = document.createElement('section');
    sectionEl.className = 'home';
    // Exactly one click listener and one submit listener, delegated on
    // this root element, attached once here and removed in unmount().
    sectionEl.addEventListener('click', handleClick);
    sectionEl.addEventListener('submit', handleSubmit);
    container.appendChild(sectionEl);
    return sectionEl;
  }

  function render() {
    if (disposed || !container) return;

    captureLiveDraft();

    const section = ensureSection();
    const trackablesRaw = st.getTrackables();
    byId = new Map(trackablesRaw.map((t) => [String(t.id), t]));
    const vis = visibleTrackables(trackablesRaw);

    const homeState = computeHomeState(vis.length);
    const showOffline = (lastTrackablesError !== null || lastEntriesError !== null) && vis.length > 0;

    section.setAttribute('data-home-state', homeState);
    section.innerHTML = '';

    if (showOffline) {
      const p = document.createElement('p');
      p.className = 'home-offline';
      p.textContent = 'You appear to be offline — showing the last saved data.';
      section.appendChild(p);
    }

    if (vis.length > 0) {
      const ul = document.createElement('ul');
      ul.className = 'tlist';
      for (const t of vis) {
        ul.appendChild(buildRow(t));
      }
      section.appendChild(ul);

      // Step 2.2: always-visible way to reach #/new once the list is
      // non-empty (i.e. whenever data-home-state="ready"). The separate
      // empty-state link below is untouched.
      const newLink = document.createElement('a');
      newLink.className = 'home-new';
      newLink.href = '#/new';
      newLink.textContent = 'New trackable';
      section.appendChild(newLink);
    }

    if (homeState === 'empty') {
      const p = document.createElement('p');
      p.className = 'home-empty';
      p.appendChild(document.createTextNode('Nothing tracked yet. '));
      const a = document.createElement('a');
      a.href = '#/new';
      a.textContent = 'Add your first trackable';
      p.appendChild(a);
      p.appendChild(document.createTextNode('.'));
      section.appendChild(p);
    }

    if (editingId !== null) {
      const li = findRowEl(editingId);
      const input = li ? li.querySelector('.trow-input') : null;
      if (input) {
        input.focus();
        if (focusMode === 'select') input.select();
      }
    }
    focusMode = null;
  }

  // --- event handlers ------------------------------------------------------

  function applyResult(id, result) {
    const status = result && result.status;
    if (status === 'saved') {
      rowStatus.delete(id);
    } else if (status === 'queued') {
      // Already showing the optimistic value with state 'pending' from the
      // synchronous update at click time — nothing to change.
    } else {
      // 'failed', or a thrown exception normalized to this shape by the
      // caller.
      const err = result && result.error;
      const message = err && err.message ? err.message : 'Something went wrong.';
      rowStatus.set(id, { state: 'failed', error: message, optimisticValue: undefined });
    }
  }

  function runWrite(id, fn) {
    inFlight.add(id);
    render();
    fn()
      .then((result) => {
        if (disposed) return;
        applyResult(id, result);
      })
      .catch((err) => {
        if (disposed) return;
        applyResult(id, { status: 'failed', error: err });
      })
      .finally(() => {
        inFlight.delete(id);
        if (!disposed) render();
      });
  }

  function handleToggle(id) {
    if (inFlight.has(id)) return;
    const t = trackableById(id);
    if (!t) return;

    const li = findRowEl(id);
    const wasLogged = li ? li.dataset.logged === 'true' : false;
    const newLogged = !wasLogged;

    // Optimistic update happens synchronously here, before any await, so
    // the tap feels instant.
    rowStatus.set(id, { state: 'pending', error: null, optimisticValue: newLogged ? 1 : 0 });

    runWrite(id, () => {
      if (newLogged) {
        return st.saveEntry({ trackable_id: t.id, entry_date: day, value: 1 });
      }
      // Clearing a boolean day is a DELETE, never saveEntry({value: 0}) —
      // applyRelog() in aggregate.js explicitly forbids an un-toggle path.
      return st.removeEntry(t.id, day);
    });
  }

  function handleOpenEditor(id) {
    if (inFlight.has(id)) return;
    const t = trackableById(id);
    if (!t) return;
    // A stale failure from a previous attempt shouldn't linger once the
    // user starts a fresh edit.
    rowStatus.delete(id);
    editingId = id;
    editorError = null;
    draftText = '';
    focusMode = 'select';
    render();
  }

  function handleCancel() {
    editingId = null;
    editorError = null;
    draftText = '';
    render();
  }

  function handleClick(event) {
    try {
      const btn = event.target.closest ? event.target.closest('button[data-action]') : null;
      if (!btn || !sectionEl.contains(btn)) return;
      const li = btn.closest('li.trow');
      if (!li) return;
      const id = li.dataset.trackableId;
      const action = btn.dataset.action;

      if (action === 'toggle') {
        handleToggle(id);
      } else if (action === 'open-editor') {
        handleOpenEditor(id);
      } else if (action === 'cancel') {
        handleCancel();
      }
      // action === 'save' is a submit button inside the form; the
      // delegated 'submit' listener handles it, not this click listener.
    } catch {
      // No handler may ever let an exception escape.
    }
  }

  function handleSubmit(event) {
    try {
      const form = event.target && event.target.closest ? event.target.closest('form.trow-editor') : null;
      if (!form) return;
      event.preventDefault();

      const li = form.closest('li.trow');
      if (!li) return;
      const id = li.dataset.trackableId;
      const input = form.querySelector('.trow-input');
      const text = input ? input.value : '';

      const n = parseNumericInput(text);
      if (n === null) {
        editorError = 'Enter a number';
        draftText = text;
        render();
        return;
      }

      const t = trackableById(id);
      if (!t) return;

      let v;
      try {
        const entryForToday = st.getEntry(t.id, day);
        v = nextValueFor(t, entryForToday, n);
      } catch {
        editorError = 'Enter a number';
        draftText = text;
        render();
        return;
      }

      editingId = null;
      editorError = null;
      draftText = '';
      rowStatus.set(id, { state: 'pending', error: null, optimisticValue: v });

      runWrite(id, () => st.saveEntry({ trackable_id: t.id, entry_date: day, value: v }));
    } catch {
      // No handler may ever let an exception escape.
    }
  }

  // --- lifecycle -----------------------------------------------------------

  async function mount(el) {
    container = el;
    disposed = false;

    // Step 1: synchronous first paint from the store's already-hydrated
    // cache — must happen before any await.
    render();

    try {
      // Step 2.
      const tResult = await st.loadTrackables();
      lastTrackablesError = tResult.error;
      initialLoadDone = true;
      if (disposed) return;
      render();

      // Step 3: flush before reading — a queued write must reach the
      // server before we ask what today looks like.
      if (st.getOutbox().length > 0) {
        await st.flushOutbox();
        if (disposed) return;
      }

      // Step 4.
      const eResult = await st.loadEntries({ from: day, to: day });
      lastEntriesError = eResult.error;
      if (disposed) return;

      // Step 5: final render.
      render();
    } catch (err) {
      if (disposed) return;
      // store.loadTrackables()/loadEntries() never reject, but guard the
      // whole sequence anyway.
      if (!lastTrackablesError) lastTrackablesError = err;
      initialLoadDone = true;
      render();
    }
  }

  function unmount() {
    if (disposed) return;
    disposed = true;
    if (sectionEl) {
      sectionEl.removeEventListener('click', handleClick);
      sectionEl.removeEventListener('submit', handleSubmit);
    }
    if (container) {
      container.innerHTML = '';
    }
    sectionEl = null;
    container = null;
  }

  return { mount, unmount };
}
