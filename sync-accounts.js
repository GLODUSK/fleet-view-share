// sync-accounts.js: the Claude account letters Blackbox (Henry's sync project) expects, and this machine's matched to
// them. A synced conversation row says only `a` or `b` (docs/sync-format.md), so both machines must give each letter
// the same login, or a conversation run as one account comes back on the other machine under another one.
//
// Blackbox keeps the list as one settings row, `accounts`, sealed like every setting (sealText(json, key,
// 'setting:accounts')): { v: 1, letters: { A: { id, email }, B: { id, email } }, at }. id is the login's account
// uuid (oauthAccount.accountUuid), email its address; two logins are the same when their ids match, or, when either
// has none, their emails (case aside).
//
//   mergeMap(map, local)  -> { map, changed }   fills the letters Blackbox has no login for yet, never changes one it
//                            has: this machine's own login on that letter, or else (A only) a login of this machine
//                            that Blackbox does not have, on a letter sync does not know (C, D, ...): the one the old
//                            "C instead of A" bug left there. The first machine to sync writes the whole list.
//   plan(map, local)      -> { ok, letters: [{ letter, email, state, from?, message? }], moves: [{ from, to }] }
//                            state 'ok' (that login is on that letter here), 'move' (it is here on letter `from`:
//                            moved by itself), 'signin' (not here: sign it in on that letter), 'blocked' (a list
//                            that names one login on two letters: message says what to do by hand).
//                            B's folder never moves, so a login onto or off B is a sign-in: B's own letter says
//                            clear: X when its login is here on letter X (X is removed first, then B signs in), and
//                            a letter whose login is on B now says after: 'B' (it signs in once B has changed).
//                            moves first parks a letter that holds a login Blackbox does not want there (to the
//                            first free letter from C on, so no login is lost), then moves each login onto its
//                            letter. A 'signin' letter says here: true when its folder is here already (sign it in
//                            again: accounts.js login) or false (a new one: accounts.js add with that letter).
//   createAccountSync({ accounts, log }) -> { reconcile({ api, key }), last() }
//     reconcile reads the row (writing what mergeMap adds), plans, makes the moves when nothing is blocked, plans again
//     and remembers the result: { ok, reason, first, letters, moves, local: [{ letter, email }], at }. Nothing in it is
//     secret except the emails, which only this PC's page is given (sync-setup.js).
//   accounts: accounts.js createAccounts()'s object (letters, loginOf, relabel).
'use strict';
const path = require('path');
const K = require(path.join(__dirname, 'sync-crypto.js'));

const SETTING = 'accounts';
const LABEL = `setting:${SETTING}`;
const SYNC_LETTERS = ['A', 'B']; // the letters a conversations row knows
const SPARE = 'CDEFGHIJKLMNOPQRSTUVWXYZ';

const lower = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
const login = (l) => (l && (l.id || l.email) ? { id: l.id || null, email: l.email || null } : null);
function same(x, y) {
  if (!x || !y) return false;
  if (x.id && y.id && x.id !== x.email && y.id !== y.email) return x.id === y.id;
  return !!lower(x.email) && lower(x.email) === lower(y.email);
}
// a clean copy of a map read from Blackbox: only A and B, each { id, email } with at least one of the two
function cleanMap(m) {
  const out = {};
  const src = m && typeof m === 'object' && m.letters && typeof m.letters === 'object' ? m.letters : {};
  for (const L of SYNC_LETTERS) {
    const l = src[L] || src[L.toLowerCase()];
    if (l && typeof l === 'object' && (typeof l.id === 'string' || typeof l.email === 'string')) {
      out[L] = { id: typeof l.id === 'string' ? l.id : null, email: typeof l.email === 'string' ? l.email : null };
    }
  }
  return out;
}

// local: [{ letter, id, email }] for every letter here (no login: id and email null)
function mergeMap(map, local) {
  const out = { ...cleanMap({ letters: map || {} }) };
  let changed = false;
  const inMap = (l) => Object.values(out).some((m) => same(m, l));
  for (const L of SYNC_LETTERS) {
    if (out[L]) continue;
    const mine = local.find((x) => x.letter === L && login(x));
    let pick = mine && !inMap(mine) ? mine : null;
    // A only: B is the default login and keeps its letter, so a spare login never becomes B
    if (!pick && L === 'A' && !mine) pick = local.find((x) => SPARE.includes(x.letter) && login(x) && !inMap(x)) || null;
    if (pick) { out[L] = login(pick); changed = true; }
  }
  return { map: out, changed };
}

function plan(map, local) {
  const m = cleanMap({ letters: map || {} });
  const here = local.map((x) => ({ ...x }));
  const taken = new Set(here.map((x) => x.letter));
  const free = () => { const x = [...SPARE].find((c) => !taken.has(c)); if (x) taken.add(x); return x || null; };
  const letters = [], moves = [];
  const wanted = (l) => SYNC_LETTERS.find((L) => m[L] && same(m[L], l)) || null;
  // a letter that holds a login Blackbox does not want there is parked first (only A: B never moves), so a login can
  // move onto it. A letter with no login at all is parked as well: a sign-in or a move needs the letter free
  for (const L of SYNC_LETTERS) {
    if (!m[L] || L === 'B') continue;
    const cur = here.find((x) => x.letter === L);
    if (!cur || same(m[L], cur)) continue;
    const holder = here.find((x) => x !== cur && same(m[L], x));
    // B's login never moves (blocked below); with no holder an empty letter is simply signed in where it is
    if (holder && holder.letter === 'B') continue;
    if (!holder && !login(cur)) continue;
    const to = free();
    if (!to) continue;
    moves.push({ from: L, to });
    cur.letter = to;
  }
  for (const L of SYNC_LETTERS) {
    const want = m[L];
    if (!want) continue;
    const email = want.email || null;
    const holder = here.find((x) => same(want, x));
    if (holder && holder.letter === L) { letters.push({ letter: L, email, state: 'ok' }); continue; }
    if (holder && holder.letter !== 'B' && L !== 'B') {
      letters.push({ letter: L, email, state: 'move', from: originalLetter(local, holder) });
      moves.push({ from: holder.letter, to: L });
      holder.letter = L;
      continue;
    }
    // B's folder is never renamed, so a login goes onto or off B by signing in instead. One login is on one letter
    // only (accounts.js turns a second away), which sets the order: B first, then the letter that wants B's old login
    if (holder && L === 'B') {
      // Blackbox's B is here on another letter: that letter is removed first (accounts.js remove: its login is backed
      // up, its folder moved aside), then B signs in as it, in place of the login B has now
      const bNow = here.find((x) => x.letter === 'B');
      letters.push({ letter: 'B', email, state: 'signin', here: !!bNow, clear: holder.letter, ...(bNow && login(bNow) ? { replaces: bNow.email || null } : {}) });
      continue;
    }
    if (holder && holder.letter === 'B' && m.B && !same(m.B, holder)) {
      // B has this letter's login now: B signs in as Blackbox's B first, then this letter signs in as B's old one
      letters.push({ letter: L, email, state: 'signin', here: !!here.find((x) => x.letter === L), after: 'B' });
      continue;
    }
    if (holder) {
      // only a list that names one login on two letters gets here: B's folder is never renamed
      const msg = holder.letter === 'B'
        ? `Claude B here is signed in as ${holder.email || 'the account'} that Blackbox has as Claude ${L}. Sign Claude B in again as ${(m.B && m.B.email) || 'Blackbox\'s Claude B'}, then this one can be added as ${L}.`
        : `Blackbox has ${email || 'this account'} as Claude B, but here it is Claude ${holder.letter}. Remove Claude ${holder.letter}, then sign Claude B in again as ${email || 'that account'}.`;
      letters.push({ letter: L, email, state: 'blocked', message: msg });
      continue;
    }
    // here: the letter's folder is here already (sign it in again), else a new one is made for it; replaces: B's
    // own login, which a sign-in as Blackbox's B takes the place of
    const cur = here.find((x) => x.letter === L);
    const replaces = cur && login(cur) && !wanted(cur) ? cur.email || null : null;
    letters.push({ letter: L, email, state: 'signin', here: !!cur, ...(replaces ? { replaces } : {}) });
  }
  return { ok: letters.length > 0 && letters.every((l) => l.state === 'ok'), letters, moves };
}
const originalLetter = (local, x) => { const o = local.find((l) => same(l, x)); return o ? o.letter : x.letter; };

function createAccountSync(o = {}) {
  const accounts = o.accounts;
  if (!accounts || typeof accounts.letters !== 'function') throw new Error('createAccountSync needs accounts.js');
  const log = typeof o.log === 'function' ? o.log : () => {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  let last = null;
  let running = null;

  const localNow = () => accounts.letters().map((letter) => {
    const l = accounts.loginOf(letter);
    return { letter, id: l ? l.id || null : null, email: l ? l.email || null : null };
  });
  async function readMap(api, key) {
    const rows = await api.rest('GET', 'settings', { query: { select: 'value_enc', key: `eq.${SETTING}` } });
    if (!Array.isArray(rows) || !rows.length) return null;
    let v = null;
    try { v = JSON.parse(K.openText(rows[0].value_enc, key, LABEL)); } catch {}
    if (!v || v.v !== 1) throw Object.assign(new Error('Blackbox\'s account list does not open with this sync key'), { code: 'bad_blob' });
    return cleanMap(v);
  }
  function writeMap(api, key, map) {
    const body = { v: 1, letters: map, at: new Date(now()).toISOString() };
    return api.rest('POST', 'settings', {
      query: { on_conflict: 'user_id,key' }, prefer: 'resolution=merge-duplicates,return=minimal',
      body: { key: SETTING, value_enc: K.sealText(JSON.stringify(body), key, LABEL) },
    });
  }
  async function once({ api, key }) {
    let local = localNow();
    const had = await readMap(api, key);
    const merged = mergeMap(had || {}, local);
    let map = merged.map;
    if (merged.changed) {
      await writeMap(api, key, map);
      // two machines writing at once: what is there now is what counts
      map = (await readMap(api, key)) || map;
      log(`sync: Blackbox's Claude accounts are now ${SYNC_LETTERS.filter((L) => map[L]).map((L) => `${L} = ${map[L].email || 'a login'}`).join(', ')}`);
    }
    let p = plan(map, local);
    const blocked = p.letters.some((l) => l.state === 'blocked');
    const moved = [];
    if (!p.ok && !blocked && p.moves.length) {
      for (const mv of p.moves) {
        const [code, r] = await accounts.relabel(mv.from, mv.to);
        if (code !== 200) { log(`sync: could not move Claude ${mv.from} to ${mv.to}: ${r && r.message}`); break; }
        moved.push({ ...mv, signedIn: r.signedIn });
      }
      local = localNow();
      p = plan(map, local);
    }
    // a letter moved whose login did not follow the folder (the Keychain on a Mac) needs a sign-in again
    const lost = new Set(moved.filter((m) => m.signedIn === false).map((m) => m.to));
    const letters = p.letters.map((l) => (l.state === 'ok' && lost.has(l.letter) ? { ...l, state: 'signin', again: true } : l));
    const ok = letters.length > 0 && letters.every((l) => l.state === 'ok');
    const todo = letters.filter((l) => l.state !== 'ok').sort((x, y) => (x.after ? 1 : 0) - (y.after ? 1 : 0));
    const reason = ok ? '' : todo.some((l) => l.state === 'blocked') ? 'the Claude accounts here need a change by hand to match Blackbox\'s'
      : `sign in ${todo.map((l) => `Claude ${l.letter}`).join(todo.some((l) => l.after) ? ', then ' : ' and ')} to match Blackbox's accounts`;
    return {
      ok, reason, first: !had, letters, moved,
      local: local.map(({ letter, email }) => ({ letter, email })),
      at: new Date(now()).toISOString(),
    };
  }
  return {
    // one at a time; a call while one runs gets that one's answer
    reconcile(args) {
      if (running) return running;
      running = once(args).then((r) => { last = r; return r; }, (e) => {
        last = { ok: false, reason: `Blackbox's account list could not be read (${e && e.message})`, error: true, at: new Date(now()).toISOString() };
        return last;
      }).finally(() => { running = null; });
      return running;
    },
    last: () => last,
    forget() { last = null; },
  };
}

module.exports = { createAccountSync, mergeMap, plan, same, cleanMap, SETTING, SYNC_LETTERS };
