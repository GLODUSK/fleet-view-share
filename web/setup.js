// Fleet View web: the start screen (sync-setup.js on the server). On Henry's own machines (private.json), before the
// page shows anything, it asks once, with two big cards: work locally, or sync with Blackbox. Sync then goes step by
// step, each one done before the next opens:
//   1. Sign in     Continue with Google in the default browser (POST /sync/open-signin). Only private.json's
//                  syncEmail is let in; another account is turned away and said so here.
//                  Blackbox's address and key come from private.json too (the server connects by itself); only a
//                  private.json without them still shows the old Connect form (POST /sync/connect)
//                  No passphrase: once signed in, the server fetches the sync key from Blackbox (or makes it there
//                  on the first machine, sync-crypto.js fetchKey); a spinner shows while it does, Try again if it can't
//   2. Accounts    each Claude letter signed in as the login Blackbox has for it. A login that is here under another
//                  letter is moved by the server itself (sync-accounts.js); a missing one has a Sign in button
//                  (POST /accounts/add { letter, email } or /accounts/login { account, email }), with the claude.ai
//                  link and a field for its code when the browser is signed in to another claude.ai account
//   3. First sync  what is on Blackbox comes here and what is here goes up; Open now skips the wait
// Sync stays off until step 2 matches (sync-run.js's gates); the screen closes by itself when the first sync is done
// (POST /sync/done). "Work locally" (POST /sync/mode { mode: 'local' }) closes it at any step; Back shows the two
// cards again without changing anything. Never on a remote browser, a fixture or the chats window.
//
//   mountSetup({ post, isRemote, fixture }) -> { open(), check() }   open(): show it now (the Sync card's "Sync with
//   Blackbox"); check(): ask the server whether it must show (at start)
import { esc } from './cards.js';

const POLL_MS = 1500;
const ACCOUNTS_EVERY_MS = 8000; // POST /sync/accounts/check while the key or step 2 waits (a sign-in may have finished)
const here = /Mac/i.test(navigator.platform || navigator.userAgent || '') ? 'this Mac' : 'this PC';
const Here = here === 'this Mac' ? 'This Mac' : 'This PC';

// ---------- pictures ----------
const svg = (d, size = 24) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const PIC = {
  cloud: '<path d="M7 18h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.2 4.5 4.5 0 0 0 7 18z"/><path d="M12 11v5"/><path d="m9.5 13.5 2.5-2.5 2.5 2.5"/>',
  device: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/>',
  cube: '<path d="M12 2.8 20 7v10l-8 4.2L4 17V7z"/><path d="M4 7l8 4.2L20 7"/><path d="M12 11.2v10"/>',
  check: '<path d="m5 12.5 4.2 4.2L19 7"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  back: '<path d="m14.5 6-6 6 6 6"/>',
  arrow: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.3-4.6L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.6L20 16"/><path d="M20 20v-4h-4"/>',
};
const GOOGLE = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>';

export function mountSetup({ post, isRemote = () => false, fixture = false } = {}) {
  let root = null, timer = null, info = null, busy = false, note = null, lastAccountsCheck = 0;
  let drawnStep = null; // the step whose form is in the page (drawn again only when the step changes, so typing stays)
  let choosing = false; // Back: the two cards again, the server's choice unchanged until one is picked
  let googleAt = 0; // when the Google sign-in was opened (the button then says it waits for the browser)
  const name = () => (info && info.name) || 'Blackbox';
  const onlyEmail = () => (info && info.onlyEmail) || '';

  async function get(url) {
    try { const r = await fetch(url, { cache: 'no-store' }); return await r.json(); } catch { return null; }
  }

  function step() {
    const i = info;
    if (!i || !i.mode || choosing) return 'choose';
    if (!i.configured) return i.autoConnect ? 'connecting' : 'connect';
    if (!i.signedIn || i.member === false) return 'google';
    if (!i.hasKey) return 'key';
    if (!i.accounts || !i.accounts.ok) return 'accounts';
    return 'first';
  }
  const steps = () => [...(info && !info.autoConnect ? [['connect', 'Connect']] : []),
    ['google', 'Sign in'], ['accounts', 'Claude accounts'], ['first', 'First sync']];

  // ---------- drawing ----------
  function frame() {
    root = document.createElement('div');
    root.className = 'su-screen';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Start Fleet View');
    root.innerHTML = '<div class="su-glow a"></div><div class="su-glow b"></div><div class="su-grid"></div><div class="su-drag"></div>'
      + '<div class="su-stage"></div>';
    root.addEventListener('click', onClick);
    root.addEventListener('submit', onSubmit);
    document.body.appendChild(root);
    document.body.classList.add('su-open');
  }
  function draw() {
    if (!root) return;
    const s = step();
    const stage = root.querySelector('.su-stage');
    const wantKind = s === 'choose' ? 'choose' : 'flow';
    if (stage.dataset.kind !== wantKind) {
      stage.dataset.kind = wantKind;
      drawnStep = null;
      stage.innerHTML = wantKind === 'choose' ? chooseHtml()
        : '<div class="su-card"><div class="su-top"></div><div class="su-steps"></div><div class="su-body"></div>'
          + '<div class="su-status" aria-live="polite"></div><div class="su-foot"></div></div>';
    }
    if (wantKind === 'choose') {
      for (const b of stage.querySelectorAll('button[data-c]')) b.disabled = busy;
      stage.querySelector('.su-status').innerHTML = noteHtml();
      return;
    }
    stage.querySelector('.su-top').innerHTML = topHtml();
    const list = steps(), idx = list.findIndex(([k]) => k === (s === 'connecting' ? 'google' : s === 'key' ? 'accounts' : s));
    stage.querySelector('.su-steps').innerHTML = list.map(([, label], i) =>
      `<div class="su-step ${i < idx ? 'done' : i === idx ? 'now' : ''}"><span class="su-n">${i < idx ? svg(PIC.check, 12) : i + 1}</span><span class="su-sl">${esc(label)}</span></div>`).join('<span class="su-bar"></span>');
    if (drawnStep !== s) { drawnStep = s; stage.querySelector('.su-body').innerHTML = body(s); focusFirst(); }
    liveParts(s);
    stage.querySelector('.su-status').innerHTML = noteHtml();
    stage.querySelector('.su-foot').innerHTML = `<button type="button" class="su-link" data-c="local"${busy ? ' disabled' : ''}>Work locally instead</button>`;
  }
  const noteHtml = () => (note ? `<div class="su-note ${note.bad ? 'bad' : 'ok'}">${esc(note.text)}</div>` : '');
  function topHtml() {
    return `<button type="button" class="su-back" data-c="back" title="Back"${busy ? ' disabled' : ''}>${svg(PIC.back, 18)}</button>`
      + `<div class="su-link-pic"><span class="su-pic pc">${svg(PIC.device, 22)}</span><span class="su-wire"><i></i></span><span class="su-pic box">${svg(PIC.cube, 22)}</span></div>`
      + `<div class="su-title">Sync with ${esc(name())}</div>`
      + `<div class="su-sub">${Here} and your other machines share the same conversations.</div>`;
  }
  function chooseHtml() {
    const n = esc(name());
    const li = (t) => `<li>${svg(PIC.check, 14)}<span>${t}</span></li>`;
    return '<div class="su-hero">'
      + `<div class="su-logo">${svg(PIC.sync, 26)}</div>`
      + '<h1 class="su-h1">Welcome to Fleet View</h1>'
      + `<p class="su-lead">How should ${here} work? You can change it later from the Sync card in the header.</p></div>`
      + '<div class="su-choices">'
      + `<button type="button" class="su-choice sync" data-c="sync"><span class="su-badge">Recommended</span>`
      + `<span class="su-ic">${svg(PIC.cloud, 26)}</span><b>Sync with ${n}</b>`
      + `<span class="su-desc">Your conversations follow you between machines.</span>`
      + `<ul>${li('Chats from your other machines show up here')}${li('Pick up any conversation where you left off')}${li(onlyEmail() ? `A quick Google sign-in as ${esc(onlyEmail())}` : 'A quick Google sign-in')}</ul>`
      + `<span class="su-cta">Sync with ${n}${svg(PIC.arrow, 16)}</span></button>`
      + `<button type="button" class="su-choice local" data-c="local"><span class="su-ic">${svg(PIC.device, 26)}</span><b>Work locally</b>`
      + `<span class="su-desc">Only what is on ${here}.</span>`
      + `<ul>${li(`Everything stays on ${here}`)}${li('Nothing is sent anywhere')}${li('Turn sync on any time')}</ul>`
      + `<span class="su-cta">Work locally${svg(PIC.arrow, 16)}</span></button>`
      + '</div><div class="su-status" aria-live="polite"></div>';
  }
  function focusFirst() {
    const el = root.querySelector('.su-body input, .su-body button.su-go, .su-body button.su-google');
    if (el) setTimeout(() => { try { el.focus(); } catch {} }, 30);
  }
  function body(s) {
    if (s === 'connecting') return `<div class="su-wait"><span class="su-spin"></span>Connecting to ${esc(name())}…</div>`;
    if (s === 'connect') {
      return `<form class="su-form" data-f="connect"><div class="su-p">${esc(name())}'s address and its <b>publishable</b> key (Supabase dashboard, Settings, API keys). Once per machine; a secret key is refused.</div>`
        + '<label>Address<input name="url" type="url" placeholder="https://<project>.supabase.co" autocomplete="off" spellcheck="false" required></label>'
        + '<label>Publishable key<input name="key" type="password" placeholder="sb_publishable_…" autocomplete="off" spellcheck="false" required></label>'
        + '<div class="su-btns"><button class="su-go" type="submit">Connect</button></div></form>';
    }
    if (s === 'google') return '<div class="su-live" data-l="google"></div>';
    if (s === 'key') return '<div class="su-live" data-l="key"></div>';
    if (s === 'accounts') return '<div class="su-live" data-l="accounts"></div>';
    return '<div class="su-live" data-l="first"></div>';
  }
  // the parts read again on every poll (no inputs in them, except the code fields, kept while focused)
  function liveParts(s) {
    const el = root.querySelector('.su-live');
    if (!el) return;
    if (el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    if (s === 'google') el.innerHTML = googleHtml();
    else if (s === 'key') el.innerHTML = keyHtml();
    else if (s === 'accounts') el.innerHTML = accountsHtml();
    else if (s === 'first') el.innerHTML = firstHtml();
  }
  function googleHtml() {
    const i = info, only = onlyEmail();
    if (i.signedIn && i.member === false) {
      return `<div class="su-note bad">${esc(i.email || 'That Google account')} is not on ${esc(name())}'s members list, so it can read and write nothing.</div>`
        + '<div class="su-btns"><button type="button" data-c="signout">Sign out and use another</button></div>';
    }
    const waiting = googleAt && Date.now() - googleAt < 10 * 60e3 && !i.refused;
    const refused = i.refused ? `<div class="su-note bad">That was ${esc(i.refused)}. Only ${esc(only)} can sync with ${esc(name())}: sign in again and pick it.</div>` : '';
    const btn = `<button type="button" class="su-google" data-c="google"${busy ? ' disabled' : ''}>${GOOGLE}<span>${waiting ? 'Open the sign-in again' : 'Continue with Google'}</span></button>`;
    const who = only ? `<div class="su-who">${svg(PIC.lock, 14)}<span>Only <b>${esc(only)}</b> can sync. Any other account is turned away.</span></div>` : '';
    const wait = waiting ? '<div class="su-wait"><span class="su-spin"></span>Finish signing in in your browser. This moves on by itself.</div>'
      : '<div class="su-p su-dim su-center">It opens in your default browser.</div>';
    return refused + btn + wait + who;
  }
  // signed in, the key not here yet: sync-run.js fetches it from Blackbox (it says why when it can't)
  function keyHtml() {
    const why = /could not be fetched/.test(info.reason || '') ? (info.reason.match(/Blackbox: (.+)\)$/) || [])[1] || 'no answer' : '';
    if (why) return `<div class="su-note bad">Couldn't get the sync key from ${esc(name())} (${esc(why)}).</div><div class="su-btns"><button type="button" data-c="recheck"${busy ? ' disabled' : ''}>Try again</button></div>`;
    return `<div class="su-wait"><span class="su-spin"></span>Signed in as ${esc(info.email || onlyEmail() || 'you')}. Getting the sync key from ${esc(name())}…</div>`;
  }
  function accountsHtml() {
    const a = info.accounts;
    if (!a) return `<div class="su-wait"><span class="su-spin"></span>Reading the Claude accounts on ${esc(name())}…</div>`;
    if (a.error) return `<div class="su-note bad">${esc(a.reason)}</div><div class="su-btns"><button type="button" data-c="recheck">Try again</button></div>`;
    const jobs = info.signins || {};
    const rows = (a.letters || []).map((l) => {
      const j = jobs[l.letter];
      const who = `<span class="su-letter">${esc(l.letter)}</span><span class="su-who2"><b>Claude ${esc(l.letter)}</b><span class="su-email">${esc(l.email || '')}</span></span>`;
      if (l.state === 'ok') return `<div class="su-acct ok">${who}<span class="su-mark">${svg(PIC.check, 16)}</span></div>`;
      if (l.state === 'move') return `<div class="su-acct">${who}<span class="su-mark"><span class="su-spin"></span></span><div class="su-why su-dim">Here as Claude ${esc(l.from)}: moving it to ${esc(l.letter)}…</div></div>`;
      if (l.state === 'blocked') return `<div class="su-acct bad">${who}<span class="su-mark">!</span><div class="su-why">${esc(l.message || '')}</div></div>`;
      let act;
      if (j && j.status === 'waiting') {
        act = `<div class="su-why">${esc(j.message || 'Finish the sign-in in your browser.')}</div>`
          + (j.url ? `<div class="su-why">Signed in to another claude.ai account in the browser? Open <a href="${esc(j.url)}" target="_blank" rel="noopener">this link</a> in a private window, then paste the code it shows:</div>`
            + `<form class="su-code" data-f="code" data-a="${esc(l.letter)}"><input name="code" autocomplete="off" spellcheck="false" placeholder="Code"><button type="submit">Send</button>`
            + `<button type="button" data-c="cancel" data-a="${esc(l.letter)}">Stop</button></form>` : '');
      } else {
        const msg = j && j.status !== 'done' && j.message ? `<div class="su-why su-bad">${esc(j.message)}</div>` : '';
        const warn = l.replaces ? `<div class="su-why su-warn">Claude B here is ${esc(l.replaces)}; signing it in as ${esc(l.email || 'Blackbox\'s')} takes its place.</div>` : '';
        act = `${l.again ? '<div class="su-why">Its login stayed behind when it moved: sign it in again.</div>' : ''}${warn}${msg}`
          + `<div class="su-btns"><button type="button" class="su-go" data-c="acct" data-a="${esc(l.letter)}" data-e="${esc(l.email || '')}" data-h="${l.here ? 1 : 0}"${busy ? ' disabled' : ''}>Sign in</button></div>`;
      }
      return `<div class="su-acct">${who}<span class="su-mark dim">○</span>${act}</div>`;
    }).join('');
    const top = a.first ? `<div class="su-p su-dim">${Here} is the first machine on ${esc(name())}: these become its accounts. Every other machine signs in the same ones on the same letters.</div>`
      : `<div class="su-p su-dim">Each conversation lives under a Claude letter. Sign in the same login on each letter here; one that is here under another letter is moved by itself.</div>`;
    return top + `<div class="su-accts">${rows}</div>`;
  }
  function firstHtml() {
    const i = info, p = i.progress;
    if (!i.running) return `<div class="su-wait"><span class="su-spin"></span>Starting sync${i.reason ? ` (${esc(i.reason)})` : ''}…</div>`;
    const up = p && p.up, down = p && p.down;
    const row = (done, label, value) => `<div class="su-prog ${done ? 'done' : ''}"><span class="su-mark">${done ? svg(PIC.check, 16) : '<span class="su-spin"></span>'}</span><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
    return row(!!(down && down.lastScanAt), 'From your other machines', down && down.lastScanAt ? `${Number(down.laidDown) || 0} brought here` : 'looking…')
      + row(!!(up && up.lastScanAt), `From ${here}`, up && up.lastScanAt ? `${Number(up.synced) || 0} of ${Number(up.conversations) || 0} up to date${up.pending ? `, ${up.pending} on the way` : ''}` : 'looking…')
      + '<div class="su-btns"><button type="button" class="su-go wide" data-c="open">Open Fleet View now</button></div>'
      + '<div class="su-p su-dim su-center">Sync carries on in the background.</div>';
  }

  // ---------- doing ----------
  async function act(fn) {
    if (busy) return;
    busy = true; note = null; draw();
    try { await fn(); } finally { busy = false; await refresh(); }
  }
  const said = (r, okText) => { note = r && r.ok ? (okText ? { text: okText } : null) : { text: (r && r.message) || 'Fleet View did not answer.', bad: true }; return !!(r && r.ok); };

  function onClick(e) {
    const b = e.target.closest('button[data-c]');
    if (!b || b.disabled) return;
    const c = b.dataset.c;
    if (c === 'sync') act(async () => { if (said(await post('/sync/mode', { mode: 'sync' }))) choosing = false; });
    else if (c === 'local') act(async () => { if (said(await post('/sync/mode', { mode: 'local' }))) close(); });
    else if (c === 'back') { choosing = true; note = null; draw(); }
    else if (c === 'google') act(async () => { if (said(await post('/sync/open-signin', {}))) googleAt = Date.now(); });
    else if (c === 'signout') act(async () => { said(await post('/sync/signout', {})); });
    else if (c === 'recheck') act(checkAccounts);
    else if (c === 'acct') {
      const a = b.dataset.a, email = b.dataset.e || undefined;
      act(async () => { said(b.dataset.h === '1' ? await post('/accounts/login', { account: a, email }) : await post('/accounts/add', { letter: a, email }), 'Your browser is opening claude.ai to sign in.'); });
    } else if (c === 'cancel') act(async () => { said(await post('/accounts/cancel', { account: b.dataset.a })); });
    else if (c === 'open') act(finish);
  }
  function onSubmit(e) {
    const f = e.target.closest('form[data-f]');
    if (!f) return;
    e.preventDefault();
    const v = (n) => (f.elements[n] ? f.elements[n].value : '');
    if (f.dataset.f === 'connect') {
      const body = { url: v('url').trim(), key: v('key').trim() };
      act(async () => { if (said(await post('/sync/connect', body), `Connected to ${name()}.`)) f.reset(); });
    } else if (f.dataset.f === 'code') {
      const body = { account: f.dataset.a, code: v('code').trim() };
      act(async () => { said(await post('/accounts/code', body)); });
    }
  }
  async function checkAccounts() {
    lastAccountsCheck = Date.now();
    await post('/sync/accounts/check', {});
  }
  async function finish() {
    await post('/sync/done', {});
    close();
  }

  // ---------- reading ----------
  let lastJobs = '';
  async function refresh() {
    const i = await get('/sync/setup');
    if (!i) { note = { text: 'Fleet View did not answer; trying again.', bad: true }; draw(); return; }
    info = i;
    if (!root) return;
    if (!i.ask && i.mode !== 'sync') { close(); return; }
    if (i.signedIn || i.refused) googleAt = 0;
    const s = step();
    // the key comes with the sign-in's own check; a while without it, the server looks again (POST /sync/accounts/check)
    if (s === 'key' && Date.now() - lastAccountsCheck > ACCOUNTS_EVERY_MS) checkAccounts().then(() => setTimeout(refresh, 300));
    if (s === 'accounts') {
      // a sign-in that just finished, or a while since the last look: the server looks at the accounts again
      const jobs = JSON.stringify(Object.entries(i.signins || {}).map(([a, j]) => [a, j.status]));
      const finished = jobs !== lastJobs && Object.values(i.signins || {}).some((j) => j.status === 'done');
      lastJobs = jobs;
      if (finished || Date.now() - lastAccountsCheck > ACCOUNTS_EVERY_MS) checkAccounts().then(() => setTimeout(refresh, 300));
    }
    if (s === 'first' && i.ready) { await finish(); return; }
    draw();
  }
  function schedule() {
    clearTimeout(timer);
    if (!root) return;
    timer = setTimeout(async () => { await refresh(); schedule(); }, POLL_MS);
  }
  function open() {
    if (root || fixture || isRemote()) return;
    frame();
    drawnStep = null; choosing = false;
    refresh().then(schedule);
  }
  function close() {
    clearTimeout(timer);
    if (root) root.remove();
    root = null;
    document.body.classList.remove('su-open');
  }
  async function check() {
    if (fixture || isRemote()) return;
    const i = await get('/sync/setup');
    if (i && i.ask) { info = i; open(); }
  }
  return { open, check, close };
}
