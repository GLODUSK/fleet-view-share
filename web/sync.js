// Fleet View web: the Sync card (conversation sync, docs/sync.md). A click on the header's "sync" button opens it under
// the header at the right, like the Usage card; Esc, its × or a click outside closes it.
//
// It shows, read again every 3 seconds while it is open (and only then):
//   GET /sync/status     not set up (the setup command to copy: setup needs the publishable key and stays in a
//                        terminal) / signed out / signed in as <email>, on the members list or not
//   GET /sync/activity   running or why not, and the two loops' counts and the number of conflicts in plain words
//                        (never a title, a path, a token or the key: counts, and each loop's health: when it last went
//                        through, its last error's message and time, and whether it is backing off)
//   GET /sync/setup      whether the sync key is on this PC (hasKey). No passphrase: once signed in, the server
//                        fetches the key from Blackbox by itself (sync-run.js), and this only says so
// and does, on this PC's own page only:
//   Sign in with Google  POST /sync/open-signin: the server opens the sign-in in the real default browser (Google
//                        refuses embedded windows, and this page may be inside the Fleet View window); the card then
//                        watches the status until it says signed in
//   Sign out             POST /sync/signout, after a second click in the card
//   Repos                clone.js cloneSection: the repos with synced chats and no checkout here, Clone, "Clone new
//                        repos automatically" and the clone folder (this PC's own page only)
// A remote browser (the phone, another computer) sees the same card read-only: sign-in is done on the PC.
//
// On Henry's own machines (GET /sync/setup says private) it also says whether this machine syncs with Blackbox or
// works locally, and switches it: "Sync with Blackbox" sets the mode and opens the start screen (setup.js, through
// openSetup), which walks through the steps; "Work locally" stops sync here (POST /sync/mode). While syncing, it says
// whether the Claude accounts match Blackbox's. With sync not set up, the start screen sets it up (no terminal).
//
// Your machines (link.js, docs/link.md): the other machines sync knows, whether each is linked (and online), and:
//   Link       POST /link/request { device }: the other machine's Sync card opens by itself with the request
//   the code   both cards show the same 6 digits; "The codes match" (POST /link/confirm { pid }) on BOTH machines
//              links them, each one then running what the other sends; Decline (POST /link/decline { pid }) on either
//              ends it
//   Unlink     POST /link/unlink { device }, after a second click
// GET /link/status is read with the rest while the card is open, and every 5 seconds while it is closed (this
// machine's own page only), so a request from another machine opens the card once, and marks the header button.
//
// The header pill's colour: GET /sync/activity's health (sync-run.js health(): ok, warn, bad or off, and a tip naming
// the worst part and its error), read with the rest while the card is open and every 10 seconds while it is closed
// (wherever sync is set up); health() gives the last one, and onHealth() is called when it changes (app.js draws the
// pill again).
//
//   mountSync({ post, isRemote, fixture, openSetup, onHealth }) -> { open(), close(), toggle(), isOpen(), health() }
import { esc } from './cards.js';
import { icon } from './icons.js';
import { cloneSection } from './clone.js';

const POLL_MS = 3000;
const LINK_WATCH_MS = 5000; // GET /link/status while the card is closed: a link request opens it
const FINAL_STATES = new Set(['linked', 'declined', 'failed', 'expired', 'cancelled']);
// a pairing that waits for Henry here: its code to compare, or a request that just came in
const needsYou = (p) => p.state === 'confirm' || (p.role === 'answer' && p.state === 'waiting');
const POLL_WAIT_MS = 1500; // while a sign-in is going on in the browser
const HEALTH_WATCH_MS = 10e3; // GET /sync/activity while the card is closed: the pill's colour
const SETUP_CMD = 'node sync-api.js setup --url https://<project>.supabase.co --key <the publishable key>';
const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
const ago = (iso) => {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 360) / 10} h ago`;
};
const clockOf = (iso) => { const t = Date.parse(iso || ''); return t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''; };

export function mountSync({ post, isRemote = () => false, fixture = false, openSetup = () => {}, onHealth = () => {} } = {}) {
  let card = null, timer = null, gen = 0;
  let health = null; // { level, tip } from the last /sync/activity: the pill's colour
  function setHealth(act) {
    const h = act && act.health && typeof act.health.level === 'string' ? { level: act.health.level, tip: String(act.health.tip || '') } : null;
    if ((h && h.level) === (health && health.level) && (h && h.tip) === (health && health.tip)) return;
    health = h;
    try { onHealth(h); } catch {}
  }
  let status = null, activity = null; // the last answers (null: none yet or no answer)
  let keyInfo = null; // GET /sync/setup's hasKey (and why sync is not running)
  let setup = null; // GET /sync/setup: { private, name, mode, accounts, ... } (Henry's machines only say private)
  let confirmLocal = false;
  let waiting = false; // a sign-in was started from this card
  let confirmOut = false, busy = false;
  let note = null; // { text, bad }
  let answered = false;
  let link = null; // GET /link/status
  let confirmUnlink = null; // the machine whose Unlink waits for a second click
  let cloneUi = null; // the Repos part (clone.js) while the card is open

  async function get(url) {
    if (fixture) return null;
    try { const r = await fetch(url, { cache: 'no-store' }); return await r.json(); } catch { return null; }
  }
  const remote = () => !!isRemote();

  async function refresh() {
    const my = gen;
    const [st, act, su, ln] = await Promise.all([get('/sync/status'), get('/sync/activity'), get('/sync/setup'), remote() ? null : get('/link/status')]);
    link = ln && typeof ln.running === 'boolean' ? ln : null;
    setup = su && su.private ? su : null;
    keyInfo = su && typeof su.hasKey === 'boolean' ? { hasKey: su.hasKey, reason: su.reason || '' } : null;
    setHealth(act);
    if (my !== gen || !card) return;
    answered = true;
    status = st; activity = act;
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
      // the last sign-in was lost (a renewal Supabase refused): said, never silent
      const lost = st.lost ? `<div class="sy-line sy-bad">${esc(st.lost)}${st.lostAt ? ` (${esc(ago(st.lostAt))})` : ''}</div>` : '';
      if (remote()) return `<div class="sy-line">Not signed in.</div>${lost}<div class="sy-line sy-dim">Sign-in is done on the PC, in its Sync card.</div>`;
      return `<div class="sy-line">Not signed in.</div>${lost}${st.refused ? `<div class="sy-line sy-bad">${esc(st.refused)} was turned away: only ${esc(st.onlyEmail || '')} can sync.</div>` : ''}`
        + `<div class="sy-btns"><button type="button" data-c="signin" class="sy-go"${busy || waiting ? ' disabled' : ''}>${waiting ? 'Waiting for the browser…' : 'Sign in with Google'}</button>`
        + `${waiting ? '<button type="button" data-c="signin">Open it again</button>' : ''}</div>`
        + `<div class="sy-line sy-dim">${waiting ? 'Finish the sign-in in your browser; this card updates by itself.' : `It opens in your default browser. ${st.onlyEmail ? `Sign in as ${esc(st.onlyEmail)}: no other account can sync here.` : 'Use a Google account on the sync members list.'}`}</div>`;
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
  // one loop's health: when it last went through, whether it backs off, and its last error with its time
  function partLines(label, p) {
    const h = p && p.health;
    if (!h || typeof h !== 'object') return '';
    const bits = [h.lastSuccessAt ? `last went through ${ago(h.lastSuccessAt)}` : 'nothing went through yet'];
    if (h.backingOff) bits.push(`waiting until ${clockOf(h.backoffUntil)} before it tries again`);
    let html = `<div class="sy-line sy-dim">${esc(label)}: ${esc(bits.join('; '))}.</div>`;
    const e = h.lastError;
    if (e && e.message) {
      const streak = Number(h.failStreak) || 0;
      html += `<div class="sy-line ${streak >= 3 ? 'sy-bad' : 'sy-warn'}">${esc(label)}${streak > 1 ? ` (failed ${streak} times in a row)` : ''}: ${esc(e.message)}${e.at ? ` <span class="sy-dim">at ${esc(clockOf(e.at))}</span>` : ''}</div>`;
    }
    return html;
  }
  function activityLines(a) {
    const level = a.health && a.health.level;
    if (!a.running) return `<div class="sy-line"><span class="sy-dot ${level === 'bad' ? 'bad' : 'off'}"></span>Not running: ${esc(a.reason || 'not started')}.</div>`;
    const why = level === 'ok' ? ', all clean' : level === 'warn' || level === 'bad' ? `: ${a.health.name || 'sync'}: ${a.health.why || ''}` : '';
    const lines = [`<div class="sy-line"><span class="sy-dot ${level === 'warn' ? 'warn' : level === 'bad' ? 'bad' : 'on'}"></span>Running${esc(why)}.</div>`];
    const up = a.up && typeof a.up === 'object' && !a.up.error ? a.up : null;
    const down = a.down && typeof a.down === 'object' && !a.down.error ? a.down : null;
    if (up) {
      const num = (v) => (Number.isFinite(v) ? v : 0);
      let t = `Uploading: ${num(up.synced)} of ${n(num(up.conversations), 'conversation', 'conversations')} up to date`;
      if (num(up.pending)) t += `, ${num(up.pending)} waiting`;
      if (up.lastScanAt) t += `; last look ${ago(up.lastScanAt)}`;
      lines.push(`<div class="sy-line">${esc(t)}.</div>`);
      if (up.health) lines.push(partLines('Uploads', up));
      else if (up.lastError) lines.push('<div class="sy-line sy-bad">The last upload hit an error; it tries again by itself.</div>');
    }
    if (down) {
      let t = `From other machines: ${n(Number(down.laidDown) || 0, 'conversation', 'conversations')} brought here since Fleet View started`;
      if (down.lastScanAt) t += `; last look ${ago(down.lastScanAt)}`;
      lines.push(`<div class="sy-line">${esc(t)}.</div>`);
      if (down.health) lines.push(partLines('Downloads', down));
      else if (down.lastError) lines.push('<div class="sy-line sy-bad">The last download hit an error; it tries again by itself.</div>');
    }
    const live = a.live && typeof a.live === 'object' && !a.live.error ? a.live : null;
    if (live && live.health) lines.push(partLines('Live status', live));
    const conflicts = Array.isArray(a.conflicts) ? a.conflicts.length : down && Number.isFinite(down.conflicts) ? down.conflicts : 0;
    lines.push(conflicts
      ? `<div class="sy-line sy-warn">${n(conflicts, 'conflict', 'conflicts')}: a copy on this PC differs from the synced one, so it is left alone.</div>`
      : '<div class="sy-line sy-dim">No conflicts.</div>');
    return lines.join('');
  }

  // ---------- your machines (link.js) ----------
  function pairingHtml(p) {
    const who = `<b>${esc(p.peer.name || 'the other machine')}</b>`;
    const code = p.code ? `<div class="sy-code" aria-label="code ${esc(p.code.split('').join(' '))}">${esc(p.code.slice(0, 3))} ${esc(p.code.slice(3))}</div>` : '';
    const btn = (c, label, cls = '') => `<button type="button" data-c="${c}" data-pid="${esc(p.pid)}"${cls ? ` class="${cls}"` : ''}${busy ? ' disabled' : ''}>${label}</button>`;
    const btns = (...b) => (remote() ? '' : `<div class="sy-btns">${b.join('')}</div>`);
    if (p.state === 'asking') return `<div class="sy-pair"><div class="sy-line">Asking ${who} to link…</div><div class="sy-line sy-dim">Fleet View there opens its Sync card with a code.</div>${btns(btn('link-decline', 'Cancel'))}</div>`;
    if (p.state === 'waiting') return `<div class="sy-pair"><div class="sy-line">${who} asks to link with this machine…</div><div class="sy-line sy-dim">The code shows in a moment.</div>${btns(btn('link-decline', 'Decline'))}</div>`;
    if (p.state === 'confirm') {
      return `<div class="sy-pair sy-pair-on">${code}<div class="sy-line">Does ${who} show the same code?</div>`
        + '<div class="sy-line sy-dim">Confirm only if you pressed Link on one of the two just now and both screens show these digits. Once linked, each machine runs what the other sends.</div>'
        + `${btns(btn('link-confirm', 'The codes match', 'sy-go'), btn('link-decline', 'Decline'))}</div>`;
    }
    if (p.state === 'confirmed') return `<div class="sy-pair">${code}<div class="sy-line">Confirmed here. Now confirm on ${who} too.</div>${btns(btn('link-decline', 'Cancel'))}</div>`;
    const good = p.state === 'linked';
    return `<div class="sy-line ${good ? 'sy-ok' : 'sy-warn'}">${good ? `${icon('check', 12)} ` : ''}${esc(p.message || (good ? 'Linked.' : 'It did not link.'))}</div>`;
  }
  function machineHtml(m, pairing) {
    const chip = m.linked ? `<span class="uw-chip ${m.online === true ? 'here' : m.online === false ? 'away' : ''}">${m.online === true ? 'linked · online' : m.online === false ? 'linked · offline' : 'linked'}</span>` : '';
    const seen = !m.linked && m.lastSeenAt ? `<span class="sy-dim">seen ${esc(ago(m.lastSeenAt))}</span>` : '';
    let act = '';
    if (!remote() && (!pairing || FINAL_STATES.has(pairing.state))) {
      if (confirmUnlink === m.id) {
        act = `<div class="sy-confirm"><div>Unlink ${esc(m.name)}? Neither machine can call the other until you link them again.</div>`
          + `<div class="sy-btns"><button type="button" data-c="do-unlink" data-dev="${esc(m.id)}" class="sy-danger"${busy ? ' disabled' : ''}>Unlink</button><button type="button" data-c="keep-link">Keep</button></div></div>`;
      } else act = `<div class="sy-btns"><button type="button" data-c="${m.linked ? 'unlink' : 'link'}" data-dev="${esc(m.id)}"${m.linked ? '' : ' class="sy-go"'}${busy ? ' disabled' : ''}>${m.linked ? 'Unlink' : 'Link'}</button></div>`;
    }
    return `<div class="sy-mach"><div class="sy-who"><span class="sy-email">${esc(m.name)}</span>${chip}${seen}</div>${pairing ? pairingHtml(pairing) : ''}${act}</div>`;
  }
  function linkHtml() {
    const st = status;
    if (remote() || !st || !st.configured || !st.signedIn || !link) return '';
    if (!link.running) return '<div class="sy-line sy-dim">Linking with your other machines works while sync runs here.</div>';
    const pairs = Array.isArray(link.pairings) ? link.pairings.filter((p) => p && p.peer) : [];
    const machines = Array.isArray(link.machines) ? link.machines : [];
    const byPeer = new Map();
    for (const p of pairs) if (!byPeer.has(p.peer.id) || needsYou(p) || !FINAL_STATES.has(p.state)) byPeer.set(p.peer.id, p);
    const rows = machines.map((m) => machineHtml(m, byPeer.get(m.id)));
    // a request from a machine not in the list (yet)
    for (const p of pairs) if (!machines.some((m) => m.id === p.peer.id)) rows.push(`<div class="sy-mach">${pairingHtml(p)}</div>`);
    if (!rows.length) return '<div class="sy-line sy-dim">No other machine syncs with this one yet.</div>';
    return `${rows.join('')}<div class="sy-line sy-dim">Linked machines can reach each other's chats, with keys only the two of them hold.</div>`;
  }
  function drawLink() {
    const el = card.querySelector('.sy-link');
    const h = linkHtml();
    if (el._html === h) return;
    el._html = h;
    el.innerHTML = h ? `<div class="sy-h">${icon('shield', 13)}<b>Your machines</b></div>${h}` : '';
    el.hidden = !h;
  }

  // the sync key: here, or being fetched from Blackbox (sync-run.js says why when it can't)
  function keyStep() {
    const st = status;
    if (!st || !st.configured || !st.signedIn || remote() || !keyInfo) return null;
    if (keyInfo.hasKey) return 'have';
    return /could not be fetched/.test(keyInfo.reason) ? `bad:${keyInfo.reason}` : 'wait';
  }
  function drawKey() {
    const el = card.querySelector('.sy-key');
    const step = keyStep();
    if (el._step === step) return;
    el._step = step;
    if (!step) { el.innerHTML = ''; el.hidden = true; return; }
    el.hidden = false;
    const line = step === 'have' ? '<div class="sy-line">The sync key is on this PC.</div>'
      : step === 'wait' ? `<div class="sy-line sy-dim">Getting the sync key from ${esc((setup && setup.name) || 'Blackbox')}…</div>`
        : `<div class="sy-line sy-warn">Couldn't get it from ${esc((setup && setup.name) || 'Blackbox')} (${esc((step.match(/Blackbox: (.+)\)$/) || [])[1] || 'no answer')}); it tries again every minute.</div>`;
    el.innerHTML = `<div class="sy-h">${icon('key', 13)}<b>Sync key</b></div>${line}`;
  }
  function draw() {
    if (!card) return;
    const main = card.querySelector('.sy-main');
    const html = `<section class="sy-sec">${accountHtml()}</section>`;
    if (main._html !== html) { main.innerHTML = html; main._html = html; }
    drawKey();
    drawLink();
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
    else if (c === 'link' || c === 'do-unlink' || c === 'link-confirm' || c === 'link-decline') {
      if (busy) return;
      const url = { link: '/link/request', 'do-unlink': '/link/unlink', 'link-confirm': '/link/confirm', 'link-decline': '/link/decline' }[c];
      const r = await act(url, c === 'link' || c === 'do-unlink' ? { device: b.dataset.dev } : { pid: b.dataset.pid });
      if (c === 'do-unlink') confirmUnlink = null;
      if (r && r.ok) note = c === 'do-unlink' ? { text: 'Unlinked.' } : null;
      else if (r) note = { text: r.message || 'It did not work.', bad: true };
      await refresh();
    } else if (c === 'unlink') { confirmUnlink = b.dataset.dev; note = null; }
    else if (c === 'keep-link') confirmUnlink = null;
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
      if (r && r.ok) note = { text: 'Signed out of sync on this PC.' };
      else if (r) note = { text: r.message || 'The sign-out did not work.', bad: true };
      await refresh();
    }
    draw();
  }
  function open() {
    if (card) return;
    gen++;
    answered = false; status = activity = keyInfo = link = null; note = null; confirmOut = false; busy = false; confirmUnlink = null;
    card = document.createElement('div');
    card.className = 'uw-pop sy-pop';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Conversation sync');
    card.tabIndex = -1;
    card.innerHTML = `<div class="uw-top"><span class="uw-title">${icon('sync', 14)}<b>Sync</b></span><span class="uw-sub">conversations across your machines</span>`
      + `<button type="button" class="uw-x" aria-label="close" title="close (Esc)">${icon('close', 13)}</button></div>`
      + '<div class="uw-scroll"><div class="sy-main"></div><div class="sy-sec sy-key" hidden></div><div class="sy-sec sy-act" hidden></div><div class="sy-sec sy-link" hidden></div>'
      + '<div class="sy-sec sy-clone" hidden></div>'
      + '<div class="sy-note" hidden aria-live="polite"></div></div>'
      + `<div class="uw-foot">${remote() ? 'Read-only here: sign-in and sign-out are done on the PC.' : 'Chats sync through your Supabase project, encrypted with the sync key before they leave this PC.'}</div>`;
    document.body.appendChild(card);
    draw();
    cloneUi = cloneSection(card.querySelector('.sy-clone'), { post, isRemote: remote, fixture });
    card.addEventListener('click', (ev) => { if (ev.target.closest('.uw-x')) close(); else onClick(ev); });
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
    if (cloneUi) { cloneUi.stop(); cloneUi = null; }
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
    get('/sync/status').then((st) => { if (st && st.configured) { document.body.classList.add('sync-on'); watchLinks(); watchHealth(); } });
    get('/sync/setup').then((su) => { if (su && su.private) { document.body.classList.add('sync-on'); watchHealth(); } });
  }
  // the pill's colour while the card is closed (refresh() reads it while it is open)
  let healthWatch = false;
  async function watchHealth() {
    if (healthWatch) return;
    healthWatch = true;
    for (;;) {
      if (!card) setHealth(await get('/sync/activity'));
      await new Promise((r) => setTimeout(r, HEALTH_WATCH_MS));
    }
  }
  // a link request from another machine: the card opens by itself, once per request, and the header button is marked
  // while one waits for an answer here
  const shown = new Set();
  async function watchLinks() {
    if (remote()) return;
    if (!card) {
      const st = await get('/link/status');
      const waiting = st && st.running && Array.isArray(st.pairings) ? st.pairings.filter((p) => p && needsYou(p)) : [];
      document.body.classList.toggle('link-ask', waiting.length > 0);
      const fresh = waiting.find((p) => !shown.has(p.pid));
      for (const p of waiting) shown.add(p.pid);
      if (fresh && !card) open();
    } else document.body.classList.remove('link-ask');
    setTimeout(watchLinks, LINK_WATCH_MS);
  }

  return { open, close, isOpen: () => !!card, toggle: () => (card ? close() : open()), health: () => health };
}
