// Fleet View web: the Sync card (conversation sync, docs/sync.md). A click on the header's "sync" button opens it under
// the header at the right, like the Usage card; Esc, its × or a click outside closes it.
//
// Top to bottom: a status block (one big state, Running / Not running / Working locally / Not signed in / Not set up,
// with a ring in the health's colour: ok mint, warn gold, bad rose, off dim; then the signed-in account as a row with
// its first letter in a circle, the membership chip and a quiet Sign out), Activity (three stat tiles, then one line
// per loop where only an error stands out), the sync key in one row, Your machines, Repos, Set aside, and This machine
// (the Claude accounts, Start clean, Work locally). Each section has a small-caps heading; a confirm is an inline panel
// with a title line. Primary actions are filled cyan (sy-go), destructive ones rose (sy-danger), the rest outlined.
//
// It shows, read again every 3 seconds while it is open (and only then):
//   GET /sync/status     not set up (the setup command to copy: setup needs the publishable key and stays in a
//                        terminal) / signed out / signed in as <email>, on the members list or not
//   GET /sync/activity   running or why not, and the two loops' counts and the number of conflicts in plain words
//                        (never a title, a path, a token or the key: counts, and each loop's health: when it last went
//                        through, its last error's message and time, and whether it is backing off)
//   GET /sync/setup      whether the sync key is on this PC (hasKey). No passphrase: once signed in, the server
//                        fetches the key from Blackbox by itself (sync-run.js), and this only says so
//   GET /sync/fresh      (this machine's own page only; 404 where sync isn't set up: then none of Start clean shows)
//                        the other machines' names, whether a fresh start waits to run (pending), the last one, and
//                        the chats set aside here (newest first, at most 50, and their count)
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
// works locally, and switches it. Working locally, two choice cards: "Sync with Blackbox" (keep what's here and add
// Blackbox's) sets the mode and opens the start screen (setup.js, through openSetup), which walks through the steps;
// "Start clean from Blackbox" (below). "Work locally" stops sync here (POST /sync/mode). While syncing, it says
// whether the Claude accounts match Blackbox's. With sync not set up, the start screen sets it up (no terminal).
//
// Start clean (sync-fresh on the server): this machine mirrors the other one. Chats only on this machine are set aside,
// never deleted: they leave this machine's map and chat list and never upload, and the Set aside list brings them
// back. The shared settings (workspace names and order, hidden workspaces, map spots, teams, hidden chats) become the
// other machine's, and its repos are cloned here. Opening its confirm reads GET /sync/fresh?preview=1 once (how many
// chats would be set aside and how many stay; previewError when it could not count), never on a poll; confirming
// posts /sync/fresh { start: true }, and the server chooses sync, restarts it and starts clean before anything
// uploads. Working locally, the start screen then opens, as Sync with does; while syncing the card shows the message
// and "Starting clean…" while the answer says pending, with Cancel ({ cancel: true }). held (the set-aside list could
// not be read, so nothing uploads from here): an "Uploads held" row with Upload again ({ bringBack: 'all' }).
// Set aside on this machine (N): five rows (title, repo, when), Show all for the rest, each with Bring back (POST
// /sync/fresh { bringBack: [id] }), and Bring all back ({ bringBack: 'all' }) after a second click.
//
// Your machines (link.js, docs/link.md): the other machines sync knows, each linked (online or offline), linking (they
// link by themselves, no click), unlinked (Henry unlinked it) or offline (not linked, and not seen lately), and:
//   Unlink     POST /link/unlink { device }, after a second click: it stays unlinked on both until Link
//   Link       POST /link/request { device }: link it now (after an unlink, or when it did not link by itself)
// GET /link/status is read with the rest while the card is open (this machine's own page only).
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
const FINAL_STATES = new Set(['linked', 'declined', 'failed', 'expired', 'cancelled']);
const POLL_WAIT_MS = 1500; // while a sign-in is going on in the browser
const HEALTH_WATCH_MS = 10e3; // GET /sync/activity while the card is closed: the pill's colour
const ASIDE_SHOWN = 5; // Set aside rows before "Show all"
const SETUP_CMD = 'node sync-api.js setup --url https://<project>.supabase.co --key <the publishable key>';
const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
const ago = (iso) => {
  const t = typeof iso === 'number' ? iso : Date.parse(iso || '');
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 360) / 10} h ago` : `${Math.round(s / 86400)} d ago`;
};
const clockOf = (iso) => { const t = Date.parse(iso || ''); return t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''; };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const initial = (s) => (String(s || '').trim()[0] || '?').toUpperCase();
const spin = '<span class="sy-spin" aria-hidden="true"></span>';

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
  let fresh = null; // GET /sync/fresh (null: no answer, or sync not set up here)
  let freshOpen = false; // Start clean's confirm is open
  let freshPrev = null; // its preview: { loading } or { preview: { setAside, kept } | null, error }
  let asideAll = false, confirmBringAll = false;

  async function get(url) {
    if (fixture) return null;
    try { const r = await fetch(url, { cache: 'no-store' }); return await r.json(); } catch { return null; }
  }
  const remote = () => !!isRemote();

  async function refresh() {
    const my = gen;
    const [st, act, su, ln, fr] = await Promise.all([get('/sync/status'), get('/sync/activity'), get('/sync/setup'),
      remote() ? null : get('/link/status'), remote() ? null : get('/sync/fresh')]);
    link = ln && typeof ln.running === 'boolean' ? ln : null;
    setup = su && su.private ? su : null;
    keyInfo = su && typeof su.hasKey === 'boolean' ? { hasKey: su.hasKey, reason: su.reason || '' } : null;
    setHealth(act);
    if (my !== gen || !card) return;
    answered = true;
    status = st; activity = act;
    fresh = fr && fr.ok === true ? fr : null;
    if (waiting && st && st.signedIn) { waiting = false; note = { text: `Signed in as ${st.email || 'your Google account'}.` }; }
    draw();
  }
  function schedule() {
    clearTimeout(timer);
    if (!card) return;
    timer = setTimeout(async () => { await refresh(); schedule(); }, waiting ? POLL_WAIT_MS : POLL_MS);
  }

  // ---------- pieces ----------
  // the big state with its ring (level: ok, warn, bad, off); title and sub are HTML, escaped by the caller
  const hero = (level, title, sub) => `<div class="sy-hero"><span class="sy-ring ${level}" aria-hidden="true"><i></i></span>`
    + `<div class="sy-hero-t"><div class="sy-state">${title}</div>${sub ? `<div class="sy-sub">${sub}</div>` : ''}</div></div>`;
  const head = (ic, label, extra = '') => `<div class="sy-h">${icon(ic, 13)}<b>${label}</b>${extra}</div>`;
  const btn = (c, label, { cls = '', attrs = '', off = busy } = {}) => `<button type="button" data-c="${c}"${cls ? ` class="${cls}"` : ''}${attrs}${off ? ' disabled' : ''}>${label}</button>`;
  // a confirm: its title line, what happens, and the buttons
  const confirmHtml = (title, body, btns, danger = false) => `<div class="sy-confirm${danger ? ' danger' : ''}" role="group">`
    + `<div class="sy-ct">${title}</div>${body ? `<div class="sy-cb">${body}</div>` : ''}<div class="sy-btns">${btns}</div></div>`;

  // ---------- what the card says ----------
  let heroLevel = 'off';
  function accountHtml() {
    const st = status;
    heroLevel = 'off';
    if (!answered) return hero('off', 'Reading…', '');
    if (!st) { heroLevel = 'bad'; return hero('bad', 'No answer', 'Fleet View did not answer.'); }
    if (setup && setup.mode === 'local') {
      return hero('off', 'Working locally', `Nothing syncs with ${esc(setup.name)} here.`) + (remote() ? '' : localChoicesHtml());
    }
    if (!st.configured && setup && !remote()) {
      return hero('off', 'Not set up', `Sync with ${esc(setup.name)} is not set up on this machine yet.`)
        + `<div class="sy-btns">${btn('setup', 'Set it up', { cls: 'sy-go', off: false })}</div>`;
    }
    if (!st.configured) {
      return hero('off', 'Not set up', `Sync is not set up on this PC${st.problem ? ` (${esc(st.problem)})` : ''}.`)
        + (remote() ? '<div class="sy-line sy-dim">It is set up in a terminal on the PC.</div>'
          : '<div class="sy-line sy-dim">Set it up once in a terminal, in the Fleet View folder, with the project\'s publishable key:</div>'
            + `<div class="sy-cmd"><code>${esc(SETUP_CMD)}</code>${btn('copy', `${icon('copy', 12)}Copy`, { attrs: ' title="Copy the command"', off: false })}</div>`);
    }
    if (!st.signedIn) {
      // the last sign-in was lost (a renewal Supabase refused): said, never silent
      const lost = st.lost ? `<div class="sy-line sy-bad">${esc(st.lost)}${st.lostAt ? ` (${esc(ago(st.lostAt))})` : ''}</div>` : '';
      heroLevel = st.lost ? 'bad' : 'off';
      if (remote()) return hero(heroLevel, 'Not signed in', 'Sign-in is done on the PC, in its Sync card.') + lost;
      return hero(heroLevel, 'Not signed in', waiting ? 'Finish the sign-in in your browser; this card updates by itself.'
        : `It opens in your default browser. ${st.onlyEmail ? `Sign in as ${esc(st.onlyEmail)}: no other account can sync here.` : 'Use a Google account on the sync members list.'}`)
        + lost + (st.refused ? `<div class="sy-line sy-bad">${esc(st.refused)} was turned away: only ${esc(st.onlyEmail || '')} can sync.</div>` : '')
        + `<div class="sy-btns">${btn('signin', waiting ? `${spin}Waiting for the browser…` : 'Sign in with Google', { cls: 'sy-go', off: busy || waiting })}`
        + `${waiting ? btn('signin', 'Open it again', { off: false }) : ''}</div>`;
    }
    // signed in: the state is the activity's
    const a = activity, level = a && a.health && a.health.level;
    let top;
    if (!a) top = hero('off', 'Signed in', 'Whether it runs: no answer.');
    else if (!a.running) { heroLevel = level === 'bad' ? 'bad' : 'off'; top = hero(heroLevel, 'Not running', `${esc(cap(a.reason || 'not started'))}.`); }
    else {
      heroLevel = level === 'warn' ? 'warn' : level === 'bad' ? 'bad' : 'ok';
      const why = level === 'ok' ? 'All clean' : level === 'warn' || level === 'bad' ? `${a.health.name || 'sync'}: ${a.health.why || ''}` : '';
      top = hero(heroLevel, 'Running', esc(why));
    }
    const member = st.member === true ? '<span class="uw-chip here">on the members list</span>'
      : st.member === false ? '<span class="uw-chip away">not on the members list</span>' : '<span class="uw-chip">membership not checked yet</span>';
    let html = `${top}<div class="sy-acct"><span class="sy-av" aria-hidden="true">${esc(initial(st.email))}</span>`
      + `<span class="sy-acct-t"><span class="sy-email" title="${esc(st.email || '')}"><span class="sy-vh">Signed in as </span>${esc(st.email || 'your Google account')}</span>${member}</span>`
      + `${remote() || confirmOut ? '' : btn('signout', 'Sign out', { cls: 'sy-quiet' })}</div>`;
    if (st.member === false) html += '<div class="sy-line sy-bad">This account can read and write nothing: sign out and sign in with one on the list.</div>';
    if (remote()) return html;
    if (confirmOut) {
      html += confirmHtml('Sign out of sync on this PC?', 'Syncing stops until you sign in again; the sync key stays.',
        btn('do-out', 'Sign out', { cls: 'sy-danger' }) + btn('keep', 'Keep', { off: false }), true);
    }
    return html;
  }
  // working locally: keep what's here and add the other machine's, or start clean from it
  function localChoicesHtml() {
    const name = esc(setup.name);
    const choice = (c, cls, ic, title, desc) => `<button type="button" data-c="${c}" class="sy-choice ${cls}"${busy ? ' disabled' : ''}>`
      + `<span class="sy-cic">${icon(ic, 18)}</span><span class="sy-chx"><b>${title}</b><span class="sy-cd">${desc}</span></span><span class="sy-arrow">${icon('chevron', 15)}</span></button>`;
    return `<div class="sy-choices">${choice('to-sync', 'main', 'sync', `Sync with ${name}`, `Keep what's here and add ${name}'s.`)}`
      + `${choice('fresh-ask', freshOpen ? 'on' : '', 'down', `Start clean from ${name}`, `Set aside what's only here, then mirror ${name}.`)}</div>`
      + (freshOpen ? freshConfirmHtml(setup.name, false) : '');
  }
  // the other machine(s) a fresh start mirrors: GET /sync/fresh's others, else the sync's name
  function others() {
    const o = fresh && Array.isArray(fresh.others) ? fresh.others.filter((x) => typeof x === 'string' && x) : [];
    return o.length ? o : [(setup && setup.name) || 'Blackbox'];
  }
  // Start clean's confirm: what happens, with the preview's counts when it has them
  function freshConfirmHtml(name, many) {
    const p = freshPrev || {};
    const whose = many ? 'the other machines\'' : `${esc(name)}'s`;
    let aside;
    if (p.loading) aside = `${spin}Counting the chats only on this machine…`;
    else if (p.preview && Number.isFinite(p.preview.setAside)) {
      aside = `<b>${esc(n(p.preview.setAside, 'chat', 'chats'))}</b> only on this machine ${p.preview.setAside === 1 ? 'gets' : 'get'} set aside (not deleted; you can bring them back).`
        + (Number.isFinite(p.preview.kept) ? ` ${esc(n(p.preview.kept, 'chat stays', 'chats stay'))}.` : '');
    } else aside = 'Chats only on this machine get set aside (not deleted; you can bring them back).';
    const body = `<ul class="sy-list"><li>${aside}</li><li>Workspaces, names, map spots and teams become ${whose}.</li>`
      + `<li>${many ? 'Their' : 'Its'} repos are cloned here.</li></ul>`
      + (p.error && !p.loading ? `<div class="sy-line sy-dim">Couldn't count them now: ${esc(p.error)}.</div>` : '');
    return confirmHtml(`Start clean from ${esc(name)}?`, body, btn('fresh-go', 'Start clean', { cls: 'sy-danger' }) + btn('fresh-cancel', 'Cancel', { off: false }), true);
  }
  function activityHtml() {
    const st = status, a = activity;
    if (!st || !st.configured || !st.signedIn || !a || !a.running) return '';
    return activityLines(a);
  }
  // This machine: whether the Claude accounts match Blackbox's (Henry's machines), Start clean, and the switch to
  // working locally
  function modeHtml() {
    const st = status;
    if (!st || !st.configured) return '';
    const syncing = !!(setup && setup.mode === 'sync');
    const canFresh = !!fresh && !remote() && !!st.signedIn && !(setup && setup.mode === 'local');
    if (!syncing && !canFresh) return '';
    let html = '';
    const row = (ic, title, desc, right = '', cls = '') => `<div class="sy-orow${cls ? ` ${cls}` : ''}"><span class="sy-oic">${ic}</span><span class="sy-ot"><b>${title}</b>${desc ? `<span>${desc}</span>` : ''}</span>${right}</div>`;
    const acc = syncing ? setup.accounts : null;
    if (acc && acc.ok) html += row(icon('check', 14), 'Claude accounts match', `The same as ${esc(setup.name)}'s (${(acc.letters || []).map((l) => esc(l.letter)).join(', ')}).`, '', 'ok');
    else if (acc) html += row(icon('alert', 14), 'Claude accounts', `${esc(cap(acc.reason || 'not checked yet'))}.`, remote() ? '' : btn('setup', 'Fix them', { off: false }), 'warn');
    if (fresh && fresh.held && !remote()) {
      html += row(icon('alert', 14), 'Uploads held', 'The list of chats set aside here could not be read, so nothing uploads from this machine. Start clean again, or upload everything here again.',
        btn('do-bring-all', 'Upload again'), 'warn');
    }
    if (canFresh) {
      const o = others(), name = o.length > 1 ? `${o.slice(0, -1).join(', ')} and ${o[o.length - 1]}` : o[0];
      if (fresh.pending) html += row(spin, 'Starting clean…', `Setting aside what's only here, then mirroring ${esc(name)}.`, btn('fresh-stop', 'Cancel'), 'busy');
      else {
        const last = fresh.last && fresh.last.at ? `Last time ${esc(ago(fresh.last.at))}: ${esc(n(Number(fresh.last.setAside) || 0, 'chat', 'chats'))} set aside, ${esc(n(Number(fresh.last.kept) || 0, 'kept', 'kept'))}.` : '';
        html += row(icon('down', 14), 'Start clean', `Set aside what's only here and mirror ${esc(name)}.${last ? `<br>${last}` : ''}`,
          freshOpen ? '' : btn('fresh-ask', 'Start clean…'));
        if (freshOpen) html += freshConfirmHtml(name, o.length > 1);
      }
    }
    if (syncing && !remote()) {
      html += row(icon('computer', 14), 'Work locally', `Stop syncing here; what is on ${esc(setup.name)} stays there.`, confirmLocal ? '' : btn('to-local', 'Work locally…'));
      if (confirmLocal) {
        html += confirmHtml('Work locally on this machine?', `Sync stops here; what is on ${esc(setup.name)} stays there.`,
          btn('do-local', 'Work locally', { cls: 'sy-danger' }) + btn('keep-sync', 'Keep syncing', { off: false }), true);
      }
    }
    return html;
  }
  // Set aside on this machine: the chats a fresh start took off this machine, each with Bring back
  function asideHtml() {
    if (remote() || !fresh || !(Number(fresh.count) > 0)) return '';
    const list = Array.isArray(fresh.setAside) ? fresh.setAside.filter((x) => x && x.id) : [];
    const shown = asideAll ? list : list.slice(0, ASIDE_SHOWN);
    let html = shown.map((x) => `<div class="sy-arow"><span class="sy-at" title="${esc(x.title || '')}">${esc(x.title || 'Untitled chat')}</span>`
      + `${btn('bring', 'Bring back', { attrs: ` data-id="${esc(x.id)}"` })}`
      + `<span class="sy-as">${esc([x.repo, x.at ? `set aside ${ago(x.at)}` : ''].filter(Boolean).join(' · '))}</span></div>`).join('');
    if (list.length > ASIDE_SHOWN) html += `<div class="sy-btns">${btn('aside-more', asideAll ? 'Show fewer' : `Show all ${list.length}`, { cls: 'sy-quiet', off: false })}</div>`;
    if (Number(fresh.count) > list.length) html += `<div class="sy-line sy-dim">The ${list.length} newest show here.</div>`;
    if (confirmBringAll) {
      html += confirmHtml(`Bring all ${esc(String(fresh.count))} back?`, 'They show on this machine\'s map and chat list again, and sync from here like any other chat.',
        btn('do-bring-all', 'Bring all back', { cls: 'sy-go' }) + btn('keep-aside', 'Keep them aside', { off: false }));
    }
    const all = confirmBringAll ? '' : btn('bring-all', 'Bring all back', { cls: 'sy-quiet sy-hr' });
    return head('rewind', 'Set aside on this machine', `<span class="sy-count">${esc(String(fresh.count))}</span>${all}`)
      + '<div class="sy-line sy-dim">Chats that were only here when this machine started clean. Nothing was deleted.</div>' + html;
  }
  // one loop's health: when it last went through, whether it backs off, and its last error with its time
  function partLines(label, p, extra = '') {
    const h = p && p.health;
    if (!h || typeof h !== 'object') return '';
    const bits = [h.lastSuccessAt ? `went through ${ago(h.lastSuccessAt)}` : 'nothing went through yet'];
    if (extra) bits.push(extra);
    if (h.backingOff) bits.push(`waiting until ${clockOf(h.backoffUntil)} before it tries again`);
    const e = h.lastError, streak = Number(h.failStreak) || 0;
    const lvl = e && e.message ? (streak >= 3 ? 'bad' : 'warn') : h.backingOff ? 'warn' : 'ok';
    let html = `<div class="sy-loop"><span class="sy-ldot ${lvl}" aria-hidden="true"></span><b>${esc(label)}</b><span>${esc(bits.join(' · '))}</span></div>`;
    if (e && e.message) {
      html += `<div class="sy-err ${streak >= 3 ? 'bad' : 'warn'}">${esc(label)}${streak > 1 ? ` (failed ${streak} times in a row)` : ''}: ${esc(e.message)}${e.at ? ` <span class="sy-dim">at ${esc(clockOf(e.at))}</span>` : ''}</div>`;
    }
    return html;
  }
  function activityLines(a) {
    const num = (v) => (Number.isFinite(v) ? v : 0);
    const up = a.up && typeof a.up === 'object' && !a.up.error ? a.up : null;
    const down = a.down && typeof a.down === 'object' && !a.down.error ? a.down : null;
    const live = a.live && typeof a.live === 'object' && !a.live.error ? a.live : null;
    const conflicts = Array.isArray(a.conflicts) ? a.conflicts.length : down && Number.isFinite(down.conflicts) ? down.conflicts : 0;
    const tile = (value, label, sub, title, cls = '') => `<div class="sy-tile${cls ? ` ${cls}` : ''}" title="${esc(title)}"><span class="sy-tv">${value}</span><span class="sy-tl">${esc(label)}</span><span class="sy-ts">${esc(sub)}</span></div>`;
    const tiles = [];
    if (up) {
      const t = `Uploading: ${num(up.synced)} of ${n(num(up.conversations), 'conversation', 'conversations')} up to date${num(up.pending) ? `, ${num(up.pending)} waiting` : ''}${up.lastScanAt ? `; last look ${ago(up.lastScanAt)}` : ''}`;
      tiles.push(tile(`${num(up.synced)}<small>/${num(up.conversations)}</small>`, 'Up to date', num(up.pending) ? `${num(up.pending)} waiting` : 'all uploaded', t));
    }
    if (down) {
      const t = `From other machines: ${n(Number(down.laidDown) || 0, 'conversation', 'conversations')} brought here since Fleet View started${down.lastScanAt ? `; last look ${ago(down.lastScanAt)}` : ''}`;
      tiles.push(tile(String(Number(down.laidDown) || 0), 'Brought here', 'since start', t));
    }
    tiles.push(tile(String(conflicts), 'Conflicts', conflicts ? 'left alone' : 'none', conflicts ? `${n(conflicts, 'conflict', 'conflicts')}: a copy on this PC differs from the synced one, so it is left alone.` : 'No conflicts.', conflicts ? 'warn' : ''));
    const lines = [`<div class="sy-tiles">${tiles.join('')}</div>`, '<div class="sy-loops">'];
    if (up) {
      if (up.health) lines.push(partLines('Uploads', up, up.lastScanAt ? `last look ${ago(up.lastScanAt)}` : ''));
      else if (up.lastError) lines.push('<div class="sy-err bad">The last upload hit an error; it tries again by itself.</div>');
    }
    if (down) {
      if (down.health) lines.push(partLines('Downloads', down, down.lastScanAt ? `last look ${ago(down.lastScanAt)}` : ''));
      else if (down.lastError) lines.push('<div class="sy-err bad">The last download hit an error; it tries again by itself.</div>');
    }
    if (live && live.health) lines.push(partLines('Live status', live));
    lines.push('</div>');
    if (conflicts) lines.push(`<div class="sy-err warn">${n(conflicts, 'conflict', 'conflicts')}: a copy on this PC differs from the synced one, so it is left alone.</div>`);
    return lines.join('');
  }

  // ---------- your machines (link.js) ----------
  // the last pairing's word: that it just linked, or why it did not (it tries again by itself)
  function pairingNote(m, p) {
    if (!p || !FINAL_STATES.has(p.state) || !p.message) return '';
    const good = p.state === 'linked';
    if (!good && (m.linked || m.unlinked)) return '';
    return `<div class="sy-line ${good ? 'sy-ok' : 'sy-warn'}">${good ? `${icon('check', 12)} ` : ''}${esc(p.message)}${good ? '' : ' It tries again by itself.'}</div>`;
  }
  function machineHtml(m, pairing) {
    const linking = !m.linked && !m.unlinked && (!!m.linking || (!!pairing && !FINAL_STATES.has(pairing.state)));
    const pill = m.linked
      ? `<span class="sy-pill ${m.online === true ? 'on' : m.online === false ? 'off' : ''}">${m.online === true ? 'linked · online' : m.online === false ? 'linked · offline' : 'linked'}</span>`
      : m.unlinked ? '<span class="sy-pill off">unlinked</span>' : linking ? '<span class="sy-pill">linking…</span>' : '<span class="sy-pill off">offline</span>';
    const seen = !m.linked && m.lastSeenAt ? `<span class="sy-seen">seen ${esc(ago(m.lastSeenAt))}</span>` : '';
    let action = '', conf = '';
    if (!remote()) {
      if (confirmUnlink === m.id) {
        conf = confirmHtml(`Unlink ${esc(m.name)}?`, 'Neither machine can call the other, and they stay unlinked until you press Link.',
          btn('do-unlink', 'Unlink', { cls: 'sy-danger', attrs: ` data-dev="${esc(m.id)}"` }) + btn('keep-link', 'Keep', { off: false }), true);
      } else action = btn(m.linked || linking ? 'unlink' : 'link', m.linked || linking ? 'Unlink' : 'Link', { cls: m.linked || linking ? '' : 'sy-go', attrs: ` data-dev="${esc(m.id)}"` });
    }
    const off = m.unlinked && !conf ? '<div class="sy-line sy-dim">Unlinked: these two don\'t link by themselves until you press Link.</div>' : '';
    return `<div class="sy-mach${m.linked ? ' linked' : ''}"><div class="sy-mrow"><span class="sy-mic">${icon('computer', 16)}</span>`
      + `<span class="sy-mt"><b title="${esc(m.name)}">${esc(m.name)}</b><span class="sy-msub">${pill}${seen}</span></span>${action}</div>`
      + `${off}${pairingNote(m, pairing)}${conf}</div>`;
  }
  function linkHtml() {
    const st = status;
    if (remote() || !st || !st.configured || !st.signedIn || !link) return '';
    if (!link.running) return '<div class="sy-line sy-dim">Your machines link while sync runs here.</div>';
    const pairs = Array.isArray(link.pairings) ? link.pairings.filter((p) => p && p.peer) : [];
    const machines = Array.isArray(link.machines) ? link.machines : [];
    const byPeer = new Map(); // one pairing each: one under way, else the newest
    for (const p of pairs) { const was = byPeer.get(p.peer.id); if (!was || FINAL_STATES.has(was.state)) byPeer.set(p.peer.id, p); }
    const rows = machines.map((m) => machineHtml(m, byPeer.get(m.id)));
    // a machine not in the list (yet) that links with this one
    for (const p of byPeer.values()) {
      if (!machines.some((m) => m.id === p.peer.id) && !FINAL_STATES.has(p.state)) rows.push(`<div class="sy-mach"><div class="sy-line">${spin}Linking with <b>${esc(p.peer.name || 'another machine')}</b>…</div></div>`);
    }
    if (!rows.length) return '<div class="sy-line sy-dim">No other machine syncs with this one yet.</div>';
    return `${rows.join('')}<div class="sy-line sy-dim">Your machines signed in to sync link by themselves, and can then reach each other's chats, with keys only the two of them hold.</div>`;
  }

  // the sync key: here, or being fetched from Blackbox (sync-run.js says why when it can't)
  function keyStep() {
    const st = status;
    if (!st || !st.configured || !st.signedIn || remote() || !keyInfo) return null;
    if (keyInfo.hasKey) return 'have';
    return /could not be fetched/.test(keyInfo.reason) ? `bad:${keyInfo.reason}` : 'wait';
  }
  function keyHtml() {
    const step = keyStep();
    if (!step) return '';
    const from = esc((setup && setup.name) || 'Blackbox');
    const right = step === 'have' ? `<span class="sy-kstate ok">${icon('check', 13)}On this PC</span>`
      : step === 'wait' ? `<span class="sy-kstate">${spin}Getting it from ${from}…</span>` : `<span class="sy-kstate warn">${icon('alert', 13)}Not here yet</span>`;
    const why = step.startsWith('bad:') ? `<div class="sy-err warn">Couldn't get it from ${from} (${esc((step.match(/Blackbox: (.+)\)$/) || [])[1] || 'no answer')}); it tries again every minute.</div>` : '';
    return `<div class="sy-krow"><span class="sy-oic">${icon('key', 14)}</span><b>Sync key</b>${right}</div>${why}`;
  }
  // one section: drawn again only when its HTML changes, hidden while empty
  function put(sel, html, top = '') {
    const el = card.querySelector(sel);
    if (el._html === html) return;
    el._html = html;
    el.innerHTML = html ? top + html : '';
    el.hidden = !html;
  }
  function draw() {
    if (!card) return;
    const main = card.querySelector('.sy-main');
    const body = accountHtml();
    const html = `<section class="sy-sec sy-top" data-lvl="${heroLevel}">${body}</section>`;
    if (main._html !== html) { main.innerHTML = html; main._html = html; }
    put('.sy-act', activityHtml(), head('sync', 'Activity'));
    put('.sy-key', keyHtml());
    put('.sy-link', linkHtml(), head('shield', 'Your machines'));
    put('.sy-aside', asideHtml());
    put('.sy-mode', modeHtml(), head('settings', 'This machine'));
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
  // Start clean's preview: read once each time its confirm opens, never on a poll
  async function loadPreview() {
    const my = gen;
    freshPrev = { loading: true };
    draw();
    const j = await get('/sync/fresh?preview=1');
    if (my !== gen || !card || !freshOpen) return;
    freshPrev = j && j.ok === true ? { preview: j.preview || null, error: j.previewError || '' } : { preview: null, error: (j && j.message) || 'no answer' };
    draw();
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
    else if (c === 'link' || c === 'do-unlink') {
      if (busy) return;
      const r = await act(c === 'link' ? '/link/request' : '/link/unlink', { device: b.dataset.dev });
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
    } else if (c === 'to-local') { confirmLocal = true; freshOpen = false; note = null; }
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
    } else if (c === 'fresh-ask') {
      if (freshOpen) { freshOpen = false; freshPrev = null; } // the local choice card toggles it
      else { freshOpen = true; confirmLocal = false; note = null; loadPreview(); return; }
    } else if (c === 'fresh-cancel') { freshOpen = false; freshPrev = null; }
    else if (c === 'fresh-go') {
      if (busy || remote()) return;
      const local = !!(setup && setup.mode === 'local');
      const r = await act('/sync/fresh', { start: true });
      if (!card) return;
      freshOpen = false; freshPrev = null;
      // working locally: the server chose sync too; the start screen signs in and checks the accounts
      if (r && r.ok && local) { close(); openSetup(); return; }
      if (r && r.ok) note = { text: r.message || 'Starting clean: sync restarts and mirrors the other machine before anything uploads.' };
      else if (r) note = { text: r.message || 'It did not start.', bad: true };
      await refresh();
    } else if (c === 'fresh-stop') {
      if (busy || remote()) return;
      const r = await act('/sync/fresh', { cancel: true });
      if (r && r.ok) note = { text: r.cancelled ? 'Start clean cancelled.' : 'It had already finished.' };
      else if (r) note = { text: r.message || 'It did not cancel.', bad: true };
      await refresh();
    } else if (c === 'bring' || c === 'do-bring-all') {
      if (busy || remote()) return;
      const r = await act('/sync/fresh', { bringBack: c === 'bring' ? [b.dataset.id] : 'all' });
      confirmBringAll = false;
      if (r && r.ok) note = { text: !Number(r.count) && fresh && fresh.held ? 'Uploads go on again from this machine.' : `Brought back ${n(Number(r.count) || 0, 'chat', 'chats')}.` };
      else if (r) note = { text: r.message || 'It did not come back.', bad: true };
      await refresh();
    } else if (c === 'bring-all') { confirmBringAll = true; note = null; }
    else if (c === 'keep-aside') confirmBringAll = false;
    else if (c === 'aside-more') asideAll = !asideAll;
    draw();
  }
  function open() {
    if (card) return;
    gen++;
    answered = false; status = activity = keyInfo = link = fresh = freshPrev = null; note = null; confirmOut = false; busy = false; confirmUnlink = null;
    freshOpen = false; asideAll = false; confirmBringAll = false; confirmLocal = false;
    card = document.createElement('div');
    card.className = 'uw-pop sy-pop';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Conversation sync');
    card.tabIndex = -1;
    card.innerHTML = `<div class="uw-top"><span class="uw-title">${icon('sync', 14)}<b>Sync</b></span><span class="uw-sub">conversations across your machines</span>`
      + `<button type="button" class="uw-x" aria-label="close" title="close (Esc)">${icon('close', 13)}</button></div>`
      + '<div class="uw-scroll"><div class="sy-main"></div><div class="sy-sec sy-act" hidden></div><div class="sy-sec sy-key" hidden></div><div class="sy-sec sy-link" hidden></div>'
      + '<div class="sy-sec sy-clone" hidden></div><div class="sy-sec sy-aside" hidden></div><div class="sy-sec sy-mode" hidden></div>'
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
    get('/sync/status').then((st) => { if (st && st.configured) { document.body.classList.add('sync-on'); watchHealth(); } });
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
  return { open, close, isOpen: () => !!card, toggle: () => (card ? close() : open()), health: () => health };
}
