// Fleet View web: the start screen (sync-setup.js on the server). On Henry's own machines (private.json), before the
// page shows anything, it asks once: work locally, or sync with Blackbox. Sync then goes step by step, each one done
// before the next opens:
//   1. Connect     the project's address and publishable key, once per machine (POST /sync/connect)
//   2. Google      Sign in with Google in the default browser (POST /sync/open-signin), on the members list
//   3. Passphrase  the sync passphrase: set by the first machine, the same one typed on every other (POST
//                  /sync/passphrase)
//   4. Accounts    each Claude letter signed in as the login Blackbox has for it. A login that is here under another
//                  letter is moved by the server itself (sync-accounts.js); a missing one has a Sign in button
//                  (POST /accounts/add { letter, email } or /accounts/login { account, email }), with the claude.ai
//                  link and a field for its code when the browser is signed in to another claude.ai account
//   5. First sync  what is on Blackbox comes here and what is here goes up; Open now skips the wait
// Sync stays off until step 4 matches (sync-run.js's gates); the screen closes by itself when the first sync is done
// (POST /sync/done). "Work locally" (POST /sync/mode { mode: 'local' }) closes it at any step. Never on a remote
// browser, a fixture or the chats window.
//
//   mountSetup({ post, isRemote, fixture }) -> { open(), check() }   open(): show it now (the Sync card's "Sync with
//   Blackbox"); check(): ask the server whether it must show (at start)
import { esc } from './cards.js';

const POLL_MS = 1500;
const ACCOUNTS_EVERY_MS = 8000; // POST /sync/accounts/check while step 4 waits (a sign-in may have finished)
const here = /Mac/i.test(navigator.platform || navigator.userAgent || '') ? 'this Mac' : 'this PC';

export function mountSetup({ post, isRemote = () => false, fixture = false } = {}) {
  let root = null, timer = null, info = null, busy = false, note = null, firstDevice = null, lastAccountsCheck = 0;
  let drawnStep = null; // the step whose form is in the page (drawn again only when the step changes, so typing stays)
  const name = () => (info && info.name) || 'Blackbox';

  async function get(url) {
    try { const r = await fetch(url, { cache: 'no-store' }); return await r.json(); } catch { return null; }
  }

  function step() {
    const i = info;
    if (!i || !i.mode) return 'choose';
    if (!i.configured) return 'connect';
    if (!i.signedIn || i.member === false) return 'google';
    if (!i.hasKey) return 'passphrase';
    if (!i.accounts || !i.accounts.ok) return 'accounts';
    return 'first';
  }
  const STEPS = [['connect', 'Connect'], ['google', 'Google'], ['passphrase', 'Passphrase'], ['accounts', 'Accounts'], ['first', 'First sync']];

  // ---------- drawing ----------
  function frame() {
    root = document.createElement('div');
    root.className = 'su-screen';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Start Fleet View');
    root.innerHTML = '<div class="su-drag"></div><div class="su-card"><div class="su-head"></div><div class="su-steps"></div>'
      + '<div class="su-body"></div><div class="su-status" aria-live="polite"></div><div class="su-foot"></div></div>';
    root.addEventListener('click', onClick);
    root.addEventListener('submit', onSubmit);
    document.body.appendChild(root);
    document.body.classList.add('su-open');
  }
  function draw() {
    if (!root) return;
    const s = step();
    const head = root.querySelector('.su-head');
    head.innerHTML = s === 'choose'
      ? `<div class="su-title">How should ${here} work?</div><div class="su-sub">Asked once. The Sync card in the header can change it later.</div>`
      : `<div class="su-title">Sync with ${esc(name())}</div><div class="su-sub">Each step opens when the one before it is done. Sync starts only when the Claude accounts match.</div>`;
    const idx = STEPS.findIndex(([k]) => k === s);
    root.querySelector('.su-steps').innerHTML = s === 'choose' ? '' : STEPS.map(([k, label], i) =>
      `<div class="su-step ${i < idx ? 'done' : i === idx ? 'now' : ''}"><span class="su-n">${i < idx ? '✓' : i + 1}</span>${esc(label)}</div>`).join('');
    if (drawnStep !== s) { drawnStep = s; root.querySelector('.su-body').innerHTML = body(s); focusFirst(); }
    liveParts(s);
    root.querySelector('.su-status').innerHTML = note ? `<div class="${note.bad ? 'su-bad' : 'su-ok'}">${esc(note.text)}</div>` : '';
    root.querySelector('.su-foot').innerHTML = s === 'choose' ? ''
      : `<button type="button" class="su-link" data-c="local"${busy ? ' disabled' : ''}>Work locally instead</button>`;
  }
  function focusFirst() {
    const el = root.querySelector('.su-body input, .su-body button.su-go');
    if (el) setTimeout(() => { try { el.focus(); } catch {} }, 30);
  }
  function body(s) {
    if (s === 'choose') {
      return '<div class="su-choices">'
        + `<button type="button" class="su-choice" data-c="sync"><b>Sync with ${esc(name())}</b><span>Your conversations from your other machines come to ${here}, and the ones here go to them. You sign in with Google, type the sync passphrase and sign in the same Claude accounts.</span></button>`
        + `<button type="button" class="su-choice" data-c="local"><b>Work locally</b><span>Only what is on ${here}. Nothing is sent anywhere.</span></button>`
        + '</div>';
    }
    if (s === 'connect') {
      return `<form class="su-form" data-f="connect"><div class="su-p">${esc(name())}'s address and its <b>publishable</b> key (Supabase dashboard, Settings, API keys). Once per machine; a secret key is refused.</div>`
        + '<label>Address<input name="url" type="url" placeholder="https://<project>.supabase.co" autocomplete="off" spellcheck="false" required></label>'
        + '<label>Publishable key<input name="key" type="password" placeholder="sb_publishable_…" autocomplete="off" spellcheck="false" required></label>'
        + '<div class="su-btns"><button class="su-go" type="submit">Connect</button></div></form>';
    }
    if (s === 'google') return '<div class="su-live" data-l="google"></div>';
    if (s === 'passphrase') {
      return '<form class="su-form" data-f="passphrase"><div class="su-p su-pass-what"></div>'
        + '<label>Passphrase<input name="passphrase" type="password" autocomplete="off" minlength="8" required></label>'
        + '<label class="su-repeat" hidden>Again<input name="repeat" type="password" autocomplete="off" minlength="8"></label>'
        + '<div class="su-btns"><button class="su-go" type="submit">Save</button></div></form>';
    }
    if (s === 'accounts') return '<div class="su-live" data-l="accounts"></div>';
    return '<div class="su-live" data-l="first"></div>';
  }
  // the parts read again on every poll (no inputs in them, except the code fields, kept while focused)
  function liveParts(s) {
    const el = root.querySelector('.su-live');
    if (s === 'passphrase') {
      const what = root.querySelector('.su-pass-what');
      if (what) what.textContent = firstDevice ? `${here} is the first machine on ${name()}: choose the sync passphrase and type it twice. Every other machine types the same one. Only a key made from it is kept here.`
        : `Type the sync passphrase you chose on your other machine. Only a key made from it is kept here.`;
      const rep = root.querySelector('.su-repeat');
      if (rep) rep.hidden = !firstDevice;
      return;
    }
    if (!el) return;
    if (el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    if (s === 'google') el.innerHTML = googleHtml();
    else if (s === 'accounts') el.innerHTML = accountsHtml();
    else if (s === 'first') el.innerHTML = firstHtml();
  }
  function googleHtml() {
    const i = info;
    if (i.signedIn && i.member === false) {
      return `<div class="su-p su-bad">${esc(i.email || 'That Google account')} is not on ${esc(name())}'s members list, so it can read and write nothing.</div>`
        + '<div class="su-btns"><button type="button" data-c="signout">Sign out and use another</button></div>';
    }
    return `<div class="su-p">Sign in with the Google account on ${esc(name())}'s members list. It opens in your default browser; this screen moves on by itself.</div>`
      + `<div class="su-btns"><button type="button" class="su-go" data-c="google"${busy ? ' disabled' : ''}>Sign in with Google</button></div>`;
  }
  function accountsHtml() {
    const a = info.accounts;
    if (!a) return '<div class="su-p su-dim">Reading the Claude accounts on ' + esc(name()) + '…</div>';
    if (a.error) return `<div class="su-p su-bad">${esc(a.reason)}</div><div class="su-btns"><button type="button" data-c="recheck">Try again</button></div>`;
    const jobs = info.signins || {};
    const rows = (a.letters || []).map((l) => {
      const j = jobs[l.letter];
      const who = `<b>Claude ${esc(l.letter)}</b><span class="su-email">${esc(l.email || '')}</span>`;
      if (l.state === 'ok') return `<div class="su-acct ok"><span class="su-mark">✓</span>${who}</div>`;
      if (l.state === 'move') return `<div class="su-acct"><span class="su-mark">↻</span>${who}<span class="su-dim">here as Claude ${esc(l.from)}: moving it to ${esc(l.letter)}…</span></div>`;
      if (l.state === 'blocked') return `<div class="su-acct bad"><span class="su-mark">!</span>${who}<div class="su-why">${esc(l.message || '')}</div></div>`;
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
          + `<div class="su-btns"><button type="button" class="su-go" data-c="acct" data-a="${esc(l.letter)}" data-e="${esc(l.email || '')}" data-h="${l.here ? 1 : 0}"${busy ? ' disabled' : ''}>Sign in as ${esc(l.email || 'that account')}</button></div>`;
      }
      return `<div class="su-acct"><span class="su-mark">○</span>${who}${act}</div>`;
    }).join('');
    const top = a.first ? `<div class="su-p">${here === 'this Mac' ? 'This Mac' : 'This PC'} is the first machine on ${esc(name())}: these become its accounts. Every other machine signs in the same ones on the same letters.</div>`
      : `<div class="su-p">${esc(name())} keeps each conversation under a Claude letter. Sign in the same login on each letter here; one that is here under another letter is moved by itself.</div>`;
    return top + `<div class="su-accts">${rows}</div>`;
  }
  function firstHtml() {
    const i = info, p = i.progress;
    if (!i.running) return `<div class="su-p su-dim">Starting sync${i.reason ? ` (${esc(i.reason)})` : ''}…</div>`;
    const up = p && p.up, down = p && p.down;
    const lines = [];
    lines.push(down && down.lastScanAt ? `From your other machines: ${Number(down.laidDown) || 0} brought here.` : 'Looking at what is on ' + name() + '…');
    lines.push(up && up.lastScanAt ? `From ${here}: ${Number(up.synced) || 0} of ${Number(up.conversations) || 0} up to date${up.pending ? `, ${up.pending} on the way` : ''}.` : 'Looking at what is here…');
    return lines.map((t) => `<div class="su-p">${esc(t)}</div>`).join('')
      + '<div class="su-btns"><button type="button" data-c="open">Open now; keep syncing in the background</button></div>';
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
    if (c === 'sync') act(async () => { said(await post('/sync/mode', { mode: 'sync' })); });
    else if (c === 'local') act(async () => { if (said(await post('/sync/mode', { mode: 'local' }))) close(); });
    else if (c === 'google') act(async () => { said(await post('/sync/open-signin', {}), 'Your browser is opening the Google sign-in.'); });
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
    } else if (f.dataset.f === 'passphrase') {
      const body = { passphrase: v('passphrase') };
      if (firstDevice) body.repeat = v('repeat');
      for (const el of f.querySelectorAll('input')) el.value = '';
      act(async () => { said(await post('/sync/passphrase', body)); });
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
    const s = step();
    if (s === 'passphrase' && firstDevice === null) {
      const f = await get('/sync/passphrase?first=1');
      if (f && typeof f.firstDevice === 'boolean') firstDevice = f.firstDevice;
    }
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
    drawnStep = null;
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
