// Fleet View web: the Sync card (conversation sync, docs/sync.md). A click on the header's "sync" button opens it under
// the header at the right, like the Usage card; Esc, its × or a click outside closes it.
//
// It shows, read again every 3 seconds while it is open (and only then):
//   GET /sync/status     not set up (the setup command to copy: setup needs the publishable key and stays in a
//                        terminal) / signed out / signed in as <email>, on the members list or not
//   GET /sync/activity   running or why not, and the two loops' counts and the number of conflicts in plain words
//                        (never a title, a path, a token or the key: only counts are read from it)
//   GET /sync/passphrase whether the sync key is on this PC; ?first=1 once, to know if this is the first machine
// and does, on this PC's own page only:
//   Sign in with Google  POST /sync/open-signin: the server opens the sign-in in the real default browser (Google
//                        refuses embedded windows, and this page may be inside the Fleet View window); the card then
//                        watches the status until it says signed in
//   Sign out             POST /sync/signout, after a second click in the card
//   Save (passphrase)    POST /sync/passphrase { passphrase, repeat? }: the key is derived and kept on the PC; the
//                        passphrase never leaves it and is cleared from the field at once
// A remote browser (the phone, another computer) sees the same card read-only: sign-in is done on the PC.
//
// On Henry's own machines (GET /sync/setup says private) it also says whether this machine syncs with Blackbox or
// works locally, and switches it: "Sync with Blackbox" sets the mode and opens the start screen (setup.js, through
// openSetup), which walks through the steps; "Work locally" stops sync here (POST /sync/mode). While syncing, it says
// whether the Claude accounts match Blackbox's. With sync not set up, the start screen sets it up (no terminal).
//
//   mountSync({ post, isRemote, fixture, openSetup }) -> { open(), close(), toggle(), isOpen() }
import { esc } from './cards.js';
import { icon } from './icons.js';

const POLL_MS = 3000;
const POLL_WAIT_MS = 1500; // while a sign-in is going on in the browser
const SETUP_CMD = 'node sync-api.js setup --url https://<project>.supabase.co --key <the publishable key>';
const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
const ago = (iso) => {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 360) / 10} h ago`;
};

export function mountSync({ post, isRemote = () => false, fixture = false, openSetup = () => {} } = {}) {
  let card = null, timer = null, gen = 0;
  let status = null, activity = null, key = null; // the last answers (null: none yet or no answer)
  let setup = null; // GET /sync/setup: { private, name, mode, accounts, ... } (Henry's machines only say private)
  let confirmLocal = false;
  let firstDevice = null; // asked once per card opening, when the key is missing
  let waiting = false; // a sign-in was started from this card
  let confirmOut = false, busy = false;
  let note = null; // { text, bad }
  let answered = false;

  async function get(url) {
    if (fixture) return null;
    try { const r = await fetch(url, { cache: 'no-store' }); return await r.json(); } catch { return null; }
  }
  const remote = () => !!isRemote();

  async function refresh() {
    const my = gen;
    const [st, act, su] = await Promise.all([get('/sync/status'), get('/sync/activity'), get('/sync/setup')]);
    setup = su && su.private ? su : null;
    let k = null;
    if (st && st.configured && st.signedIn && !remote()) {
      k = await get('/sync/passphrase');
      if (k && k.ok && !k.hasKey && firstDevice === null) {
        const f = await get('/sync/passphrase?first=1');
        if (f && typeof f.firstDevice === 'boolean') firstDevice = f.firstDevice;
      }
    }
    if (my !== gen || !card) return;
    answered = true;
    status = st; activity = act; key = k && k.ok ? k : null;
    if (waiting && st && st.signedIn) { waiting = false; note = { text: `Signed in as ${st.email || 'your Google account'}.` }; }
    draw();
  }
  function schedule() {
    clearTimeout(timer);
    if (!card) return;
    timer = setTimeout(async () => { await refresh(); schedule(); }, waiting ? POLL_WAIT_MS : POLL_MS);
  }

  // ---------- what the card says ----------
  function accountHtml() {
    const st = status;
    if (!answered) return '<div class="sy-line sy-dim">Reading…</div>';
    if (!st) return '<div class="sy-line sy-bad">Fleet View did not answer.</div>';
    if (setup && setup.mode === 'local') {
      return `<div class="sy-line">This machine works locally: nothing syncs with ${esc(setup.name)}.</div>`
        + (remote() ? '' : `<div class="sy-btns"><button type="button" data-c="to-sync" class="sy-go"${busy ? ' disabled' : ''}>Sync with ${esc(setup.name)}</button></div>`);
    }
    if (!st.configured && setup && !remote()) {
      return `<div class="sy-line">Sync with ${esc(setup.name)} is not set up on this machine yet.</div>`
        + `<div class="sy-btns"><button type="button" data-c="setup" class="sy-go">Set it up</button></div>`;
    }
    if (!st.configured) {
      return `<div class="sy-line">Sync is not set up on this PC${st.problem ? ` (${esc(st.problem)})` : ''}.</div>`
        + (remote() ? '<div class="sy-line sy-dim">It is set up in a terminal on the PC.</div>'
          : '<div class="sy-line sy-dim">Set it up once in a terminal, in the Fleet View folder, with the project\'s publishable key:</div>'
            + `<div class="sy-cmd"><code>${esc(SETUP_CMD)}</code><button type="button" data-c="copy" title="Copy the command">${icon('copy', 12)}Copy</button></div>`);
    }
    if (!st.signedIn) {
      if (remote()) return '<div class="sy-line">Not signed in.</div><div class="sy-line sy-dim">Sign-in is done on the PC, in its Sync card.</div>';
      return '<div class="sy-line">Not signed in.</div>'
        + `<div class="sy-btns"><button type="button" data-c="signin" class="sy-go"${busy || waiting ? ' disabled' : ''}>${waiting ? 'Waiting for the browser…' : 'Sign in with Google'}</button>`
        + `${waiting ? '<button type="button" data-c="signin">Open it again</button>' : ''}</div>`
        + `<div class="sy-line sy-dim">${waiting ? 'Finish the sign-in in your browser; this card updates by itself.' : 'It opens in your default browser. Use a Google account on the sync members list.'}</div>`;
    }
    const member = st.member === true ? '<span class="uw-chip here">on the members list</span>'
      : st.member === false ? '<span class="uw-chip away">not on the members list</span>' : '<span class="uw-chip">membership not checked yet</span>';
    let html = `<div class="sy-who"><span class="sy-email" title="${esc(st.email || '')}">Signed in as <b>${esc(st.email || 'your Google account')}</b></span>${member}</div>`;
    if (st.member === false) html += '<div class="sy-line sy-bad">This account can read and write nothing: sign out and sign in with one on the list.</div>';
    if (remote()) return `${html}<div class="sy-line sy-dim">Sign-in and sign-out are done on the PC.</div>`;
    if (confirmOut) {
      html += '<div class="sy-confirm"><div>Sign out of sync on this PC? Syncing stops until you sign in again; the sync key stays.</div>'
        + `<div class="sy-btns"><button type="button" data-c="do-out" class="sy-danger"${busy ? ' disabled' : ''}>Sign out</button><button type="button" data-c="keep">Keep</button></div></div>`;
    } else html += `<div class="sy-btns"><button type="button" data-c="signout"${busy ? ' disabled' : ''}>Sign out</button></div>`;
    return html;
  }
  function activityHtml() {
    const st = status, a = activity;
    if (!st || !st.configured) return '';
    if (!a) return '<div class="sy-line sy-dim">Whether it runs: no answer.</div>' + modeHtml();
    return activityLines(a) + modeHtml();
  }
  // Henry's machines: whether the Claude accounts match Blackbox's, and the switch to working locally
  function modeHtml() {
    if (!setup || setup.mode !== 'sync') return '';
    const acc = setup.accounts;
    let html = '';
    if (acc && acc.ok) html += `<div class="sy-line sy-dim">Claude accounts match ${esc(setup.name)}'s (${(acc.letters || []).map((l) => esc(l.letter)).join(', ')}).</div>`;
    else if (acc && !remote()) html += `<div class="sy-line sy-warn">Claude accounts: ${esc(acc.reason || 'not checked yet')}.</div><div class="sy-btns"><button type="button" data-c="setup">Fix them</button></div>`;
    if (remote()) return html;
    if (confirmLocal) {
      return `${html}<div class="sy-confirm"><div>Work locally on this machine? Sync stops here; what is on ${esc(setup.name)} stays there.</div>`
        + `<div class="sy-btns"><button type="button" data-c="do-local" class="sy-danger"${busy ? ' disabled' : ''}>Work locally</button><button type="button" data-c="keep-sync">Keep syncing</button></div></div>`;
    }
    return `${html}<div class="sy-btns"><button type="button" data-c="to-local"${busy ? ' disabled' : ''}>Work locally instead</button></div>`;
  }
  function activityLines(a) {
    if (!a.running) return `<div class="sy-line"><span class="sy-dot off"></span>Not running: ${esc(a.reason || 'not started')}.</div>`;
    const lines = ['<div class="sy-line"><span class="sy-dot on"></span>Running.</div>'];
    const up = a.up && typeof a.up === 'object' && !a.up.error ? a.up : null;
    const down = a.down && typeof a.down === 'object' && !a.down.error ? a.down : null;
    if (up) {
      const num = (v) => (Number.isFinite(v) ? v : 0);
      let t = `Uploading: ${num(up.synced)} of ${n(num(up.conversations), 'conversation', 'conversations')} up to date`;
      if (num(up.pending)) t += `, ${num(up.pending)} waiting`;
      if (up.lastScanAt) t += `; last look ${ago(up.lastScanAt)}`;
      lines.push(`<div class="sy-line">${esc(t)}.</div>`);
      if (up.lastError) lines.push('<div class="sy-line sy-bad">The last upload hit an error; it tries again by itself.</div>');
    }
    if (down) {
      let t = `From other machines: ${n(Number(down.laidDown) || 0, 'conversation', 'conversations')} brought here since Fleet View started`;
      if (down.lastScanAt) t += `; last look ${ago(down.lastScanAt)}`;
      lines.push(`<div class="sy-line">${esc(t)}.</div>`);
      if (down.lastError) lines.push('<div class="sy-line sy-bad">The last download hit an error; it tries again by itself.</div>');
    }
    const conflicts = Array.isArray(a.conflicts) ? a.conflicts.length : down && Number.isFinite(down.conflicts) ? down.conflicts : 0;
    lines.push(conflicts
      ? `<div class="sy-line sy-warn">${n(conflicts, 'conflict', 'conflicts')}: a copy on this PC differs from the synced one, so it is left alone.</div>`
      : '<div class="sy-line sy-dim">No conflicts.</div>');
    return lines.join('');
  }

  // the passphrase form: its own element, drawn again only when its step changes, so what is typed stays
  function keyStep() {
    const st = status;
    if (!st || !st.configured || !st.signedIn || remote() || !key) return null;
    if (key.hasKey) return 'have';
    return firstDevice ? 'first' : 'form';
  }
  function drawKey() {
    const el = card.querySelector('.sy-key');
    const step = keyStep();
    if (el._step === step) return;
    el._step = step;
    if (!step) { el.innerHTML = ''; el.hidden = true; return; }
    el.hidden = false;
    if (step === 'have') {
      el.innerHTML = `<div class="sy-h">${icon('key', 13)}<b>Sync key</b></div><div class="sy-line">The sync key is on this PC.</div>`;
      return;
    }
    el.innerHTML = `<div class="sy-h">${icon('key', 13)}<b>Sync passphrase</b></div>`
      + `<div class="sy-line sy-dim">${step === 'first'
        ? 'No machine has a sync passphrase yet: choose one (8 or more characters).'
        : 'Type the sync passphrase you set on your other machine.'} Every machine uses the same one, and it never leaves this PC.</div>`
      + '<form class="sy-form" autocomplete="off">'
      + `<input type="password" class="sy-pass" minlength="8" maxlength="1024" placeholder="${step === 'first' ? 'choose a passphrase' : 'the sync passphrase'}" autocomplete="off" spellcheck="false" aria-label="Sync passphrase">`
      + (step === 'first' ? '<input type="password" class="sy-pass2" minlength="8" maxlength="1024" placeholder="repeat it" autocomplete="off" spellcheck="false" aria-label="Repeat the passphrase">' : '')
      + '<button type="submit" class="sy-go">Save</button></form>';
  }
  function draw() {
    if (!card) return;
    const main = card.querySelector('.sy-main');
    const html = `<section class="sy-sec">${accountHtml()}</section>`;
    if (main._html !== html) { main.innerHTML = html; main._html = html; }
    drawKey();
    const act = card.querySelector('.sy-act');
    const ah = activityHtml();
    if (act._html !== ah) { act.innerHTML = ah ? `<div class="sy-h">${icon('sync', 13)}<b>Activity</b></div>${ah}` : ''; act._html = ah; act.hidden = !ah; }
    const nt = card.querySelector('.sy-note');
    const text = note ? note.text : '';
    if (nt.textContent !== text) nt.textContent = text;
    nt.className = `sy-note${note && note.bad ? ' bad' : ''}`;
    nt.hidden = !note;
  }

  // ---------- what it does ----------
  async function act(url, body) {
    busy = true;
    draw();
    const r = await Promise.resolve(post(url, body)).catch(() => null);
    busy = false;
    if (!r) note = { text: 'Fleet View did not answer.', bad: true };
    return r;
  }
  async function onClick(ev) {
    const b = ev.target.closest('button[data-c]');
    if (!b || !card) return;
    const c = b.dataset.c;
    if (c === 'copy') {
      try { await navigator.clipboard.writeText(SETUP_CMD); note = { text: 'Copied: fill in the URL and the publishable key, then run it.' }; } catch { note = { text: SETUP_CMD }; }
    } else if (c === 'signin') {
      if (busy) return;
      note = null;
      const r = await act('/sync/open-signin', {});
      if (r && r.ok) { waiting = true; note = { text: r.message || 'Your browser is opening the Google sign-in.' }; schedule(); }
      else if (r) note = { text: r.message || 'The sign-in did not start.', bad: true };
    } else if (c === 'setup') { close(); openSetup(); return; }
    else if (c === 'to-sync') {
      if (busy) return;
      const r = await act('/sync/mode', { mode: 'sync' });
      if (r && r.ok) { close(); openSetup(); return; }
      if (r) note = { text: r.message || 'It did not switch.', bad: true };
    } else if (c === 'to-local') { confirmLocal = true; note = null; }
    else if (c === 'keep-sync') confirmLocal = false;
    else if (c === 'do-local') {
      if (busy) return;
      const r = await act('/sync/mode', { mode: 'local' });
      confirmLocal = false;
      if (r && r.ok) note = { text: 'This machine works locally now; sync stopped.' };
      else if (r) note = { text: r.message || 'It did not switch.', bad: true };
      await refresh();
    } else if (c === 'signout') { confirmOut = true; note = null; }
    else if (c === 'keep') confirmOut = false;
    else if (c === 'do-out') {
      if (busy) return;
      const r = await act('/sync/signout', {});
      confirmOut = false;
      if (r && r.ok) { note = { text: 'Signed out of sync on this PC.' }; firstDevice = null; }
      else if (r) note = { text: r.message || 'The sign-out did not work.', bad: true };
      await refresh();
    }
    draw();
  }
  async function onSubmit(ev) {
    ev.preventDefault();
    if (busy || !card) return;
    const f = ev.target.closest('.sy-form');
    const p1 = f.querySelector('.sy-pass'), p2 = f.querySelector('.sy-pass2');
    const pass = p1.value;
    if (pass.length < 8) { note = { text: 'The passphrase needs at least 8 characters.', bad: true }; draw(); p1.focus(); return; }
    if (p2 && p2.value !== pass) { note = { text: 'The two passphrases do not match.', bad: true }; draw(); p2.focus(); return; }
    const body = p2 ? { passphrase: pass, repeat: p2.value } : { passphrase: pass };
    // nothing keeps it here: the fields are cleared at once, whatever the answer
    p1.value = ''; if (p2) p2.value = '';
    note = { text: 'Checking the passphrase…' };
    for (const x of f.querySelectorAll('input, button')) x.disabled = true;
    const r = await act('/sync/passphrase', body);
    body.passphrase = body.repeat = null;
    if (!card) return;
    for (const x of f.querySelectorAll('input, button')) x.disabled = false;
    if (r && r.ok) { note = { text: r.message || 'The sync key is saved on this PC.' }; await refresh(); }
    else {
      if (r) note = { text: r.message || 'The passphrase was not taken.', bad: true };
      draw();
      f.querySelector('.sy-pass')?.focus();
    }
  }

  function open() {
    if (card) return;
    gen++;
    answered = false; status = activity = key = null; firstDevice = null; note = null; confirmOut = false; busy = false;
    card = document.createElement('div');
    card.className = 'uw-pop sy-pop';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Conversation sync');
    card.tabIndex = -1;
    card.innerHTML = `<div class="uw-top"><span class="uw-title">${icon('sync', 14)}<b>Sync</b></span><span class="uw-sub">conversations across your machines</span>`
      + `<button type="button" class="uw-x" aria-label="close" title="close (Esc)">${icon('close', 13)}</button></div>`
      + '<div class="uw-scroll"><div class="sy-main"></div><div class="sy-sec sy-key" hidden></div><div class="sy-sec sy-act" hidden></div>'
      + '<div class="sy-note" hidden aria-live="polite"></div></div>'
      + `<div class="uw-foot">${remote() ? 'Read-only here: sign-in, sign-out and the passphrase are done on the PC.' : 'Chats sync through your Supabase project, encrypted with the sync key before they leave this PC.'}</div>`;
    document.body.appendChild(card);
    draw();
    card.addEventListener('click', (ev) => { if (ev.target.closest('.uw-x')) close(); else onClick(ev); });
    card.addEventListener('submit', onSubmit);
    card.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } });
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    document.addEventListener('keydown', escKey, true);
    card.focus({ preventScroll: true });
    refresh().then(schedule);
  }
  function close() {
    if (!card) return;
    clearTimeout(timer);
    timer = null;
    gen++;
    card.remove();
    card = null;
    waiting = false;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escKey, true);
  }
  const outside = (ev) => { if (card && !card.contains(ev.target) && !ev.target.closest('.count.sync')) close(); };
  const escKey = (ev) => { if (ev.key === 'Escape' && card) { ev.stopPropagation(); ev.preventDefault(); close(); } };

  // the header button shows only where sync is set up (a friend's install has no config): asked once at start
  // and on Henry's own machines (private), where it is how to switch between Blackbox and working locally
  if (!fixture) {
    get('/sync/status').then((st) => { if (st && st.configured) document.body.classList.add('sync-on'); });
    get('/sync/setup').then((su) => { if (su && su.private) document.body.classList.add('sync-on'); });
  }

  return { open, close, isOpen: () => !!card, toggle: () => (card ? close() : open()) };
}
