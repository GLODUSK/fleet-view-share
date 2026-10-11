// sync-accounts-test.js: sync-accounts.js matches this machine's Claude letters to the ones Blackbox keeps. mergeMap
// and plan on made-up account lists (the Mac's B + C after the "C instead of A" bug, a parked letter, B holding the
// wrong login, a letter with no login), then createAccountSync against an in-memory settings table and a fake
// accounts.js: it writes the list once, moves logins by itself, never overwrites a letter Blackbox has, and a list
// sealed with another key is an error. Run: node scripts/sync-accounts-test.js
'use strict';
const path = require('path');
const crypto = require('crypto');
const SA = require(path.join(__dirname, '..', 'sync-accounts.js'));
const K = require(path.join(__dirname, '..', 'sync-crypto.js'));

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const work = { id: 'u-work', email: 'henry@work.com' };
const art = { id: 'u-art', email: 'henry.art@gmail.com' };
const other = { id: 'u-other', email: 'someone@else.com' };
const at = (letter, l) => ({ letter, id: l ? l.id : null, email: l ? l.email : null });
const states = (p) => p.letters.map((l) => `${l.letter}:${l.state}${l.from ? '<' + l.from : ''}`).join(' ');

// ---------- mergeMap ----------
{
  // the Mac after the bug, first on Blackbox: B is its own, A is the login left on C
  const r = SA.mergeMap({}, [at('B', work), at('C', art)]);
  ok(r.changed, 'merge 1: the first machine writes the list');
  eq(r.map, { A: { id: 'u-art', email: 'henry.art@gmail.com' }, B: { id: 'u-work', email: 'henry@work.com' } }, 'merge 1: A is the spare login, B its own');
}
{
  // a letter Blackbox has is never changed, even when this machine has another login on it
  const r = SA.mergeMap({ A: art, B: work }, [at('A', other), at('B', other)]);
  ok(!r.changed, 'merge 2: a full list stays as it is');
}
{
  // only the missing letter is filled, from this machine's own letter
  const r = SA.mergeMap({ B: work }, [at('A', art), at('B', work)]);
  ok(r.changed && r.map.A.email === art.email && r.map.B.email === work.email, 'merge 3: the missing A is filled from A');
}
{
  // a login Blackbox has already is not added a second time under another letter
  const r = SA.mergeMap({ B: art }, [at('B', work), at('C', art)]);
  ok(!r.map.A, 'merge 4: C\'s login is B already, so A stays empty');
}
{
  // a spare login never becomes B
  const r = SA.mergeMap({ A: art }, [at('C', work)]);
  ok(!r.map.B, 'merge 5: B is filled only from B');
}

// ---------- plan ----------
{
  const p = SA.plan({ A: art, B: work }, [at('B', work), at('C', art)]);
  eq(states(p), 'A:move<C B:ok', 'plan 1: the Mac: C moves to A');
  eq(p.moves, [{ from: 'C', to: 'A' }], 'plan 1: one move');
  ok(!p.ok, 'plan 1: not ok until it moved');
}
{
  const p = SA.plan({ A: art, B: work }, [at('A', art), at('B', work)]);
  ok(p.ok && !p.moves.length && states(p) === 'A:ok B:ok', 'plan 2: matching letters are ok');
}
{
  // A holds a login Blackbox does not want there: it is parked (kept), then C's login moves onto A
  const p = SA.plan({ A: art, B: work }, [at('A', other), at('B', work), at('C', art)]);
  eq(p.moves, [{ from: 'A', to: 'D' }, { from: 'C', to: 'A' }], 'plan 3: A parked on D, then C to A');
  eq(states(p), 'A:move<C B:ok', 'plan 3: states');
}
{
  // B holds A's login (the PC wrote the list the other way round): B's folder never moves, so it is two sign-ins:
  // B as Blackbox's B first (after removing the letter that has that login), then A as B's old one
  const p = SA.plan({ A: work, B: art }, [at('B', work), at('C', art)]);
  eq(states(p), 'A:signin B:signin', 'plan 4: the Mac the other way round: two sign-ins');
  ok(p.letters[0].after === 'B' && p.letters[0].here === false, 'plan 4: A waits for B, in a new folder');
  ok(p.letters[1].clear === 'C' && p.letters[1].replaces === work.email && p.letters[1].here === true, 'plan 4: B removes C first and takes the place of its login');
  ok(!p.moves.length, 'plan 4: no move touches B');
  // after C is removed and B is signed in as art: only A, a plain sign-in
  const q = SA.plan({ A: work, B: art }, [at('B', art)]);
  ok(states(q) === 'A:signin B:ok' && !q.letters[0].after, 'plan 4b: B done, A signs in');
  ok(SA.plan({ A: work, B: art }, [at('A', work), at('B', art)]).ok, 'plan 4c: then they match');
  // an exact swap of A and B: B removes A first, A waits for B
  const r = SA.plan({ A: work, B: art }, [at('A', art), at('B', work)]);
  ok(r.letters[1].clear === 'A' && r.letters[0].after === 'B' && !r.moves.length, 'plan 4d: A and B swapped');
  // a list with one login on two letters is the only one left blocked
  ok(SA.plan({ A: work, B: work }, [at('B', work)]).letters[0].state === 'blocked', 'plan 4e: one login on two letters is blocked');
}
{
  // a login that is not here: signed in on its letter; an empty A folder is signed in where it is (no parking)
  const p = SA.plan({ A: art, B: work }, [at('A', null), at('B', work)]);
  eq(states(p), 'A:signin B:ok', 'plan 5: A needs a sign-in');
  ok(p.letters[0].here === true && !p.moves.length, 'plan 5: in A\'s own folder, nothing parked');
  const q = SA.plan({ A: art, B: work }, [at('B', work)]);
  ok(q.letters[0].here === false, 'plan 5b: no A folder: a new one');
}
{
  // an empty A folder with the login on C: A is parked so C can move in
  const p = SA.plan({ A: art, B: work }, [at('A', null), at('B', work), at('C', art)]);
  eq(p.moves, [{ from: 'A', to: 'D' }, { from: 'C', to: 'A' }], 'plan 6: empty A parked for the move');
}
{
  // B signed in as a login Blackbox does not have: a sign-in as Blackbox's B, which takes its place
  const p = SA.plan({ A: art, B: work }, [at('A', art), at('B', other)]);
  eq(states(p), 'A:ok B:signin', 'plan 7: B needs a sign-in');
  ok(p.letters[1].replaces === other.email && p.letters[1].here === true, 'plan 7: it says whose place it takes');
}
{
  // the same login told apart by its id; by email (any case) when an id is missing
  ok(SA.same({ id: 'u1', email: 'a@x.com' }, { id: 'u1', email: 'other@x.com' }), 'same 1: by id');
  ok(!SA.same({ id: 'u1', email: 'a@x.com' }, { id: 'u2', email: 'a@x.com' }), 'same 2: different ids differ');
  ok(SA.same({ id: null, email: 'A@x.com' }, { id: 'u2', email: 'a@x.com' }), 'same 3: by email without an id');
  ok(SA.same({ id: 'a@x.com', email: 'a@x.com' }, { id: 'u2', email: 'a@x.com' }), 'same 4: an id that is the email counts as none');
}
{
  // a Blackbox list with only B: A is not asked for
  const p = SA.plan({ B: work }, [at('B', work), at('C', art)]);
  ok(p.ok && p.letters.length === 1, 'plan 8: only the letters Blackbox has');
  ok(!SA.plan({}, [at('B', work)]).ok, 'plan 9: an empty list is never ok');
}

// ---------- createAccountSync ----------
function fakeApi() {
  const rows = new Map();
  const api = {
    rows, writes: 0,
    async rest(method, table, o = {}) {
      if (table !== 'settings') throw new Error('unexpected table ' + table);
      if (method === 'GET') {
        const k = /^eq\.(.+)$/.exec(o.query.key)[1];
        return rows.has(k) ? [{ value_enc: rows.get(k) }] : [];
      }
      if (method === 'POST') { api.writes++; rows.set(o.body.key, o.body.value_enc); return null; }
      throw new Error('unexpected ' + method);
    },
  };
  return api;
}
function fakeAccounts(init, o = {}) {
  const have = new Map(Object.entries(init));
  const calls = [];
  return {
    calls, have,
    letters: () => [...have.keys()].sort((x, y) => (x === 'B' ? -1 : y === 'B' ? 1 : x < y ? -1 : 1)),
    loginOf: (a) => have.get(a) || null,
    async relabel(from, to) {
      calls.push(`${from}>${to}`);
      if (o.refuse) return [409, { ok: false, message: 'a session runs on it' }];
      have.set(to, have.get(from)); have.delete(from);
      return [200, { ok: true, signedIn: o.lost ? false : true }];
    },
  };
}
(async () => {
  const key = crypto.randomBytes(32);
  {
    // the Mac, first on Blackbox: writes A = art, B = work, then moves C to A by itself
    const api = fakeApi(), acc = fakeAccounts({ B: work, C: art });
    const s = SA.createAccountSync({ accounts: acc });
    const r = await s.reconcile({ api, key });
    ok(r.ok && r.first, 'sync 1: ok, and it was the first');
    eq(acc.calls, ['C>A'], 'sync 1: C moved to A');
    const saved = JSON.parse(K.openText(api.rows.get('accounts'), key, 'setting:accounts'));
    ok(saved.v === 1 && saved.letters.A.email === art.email && saved.letters.B.email === work.email, 'sync 1: the list is sealed on Blackbox');
    eq(r.local, [{ letter: 'B', email: work.email }, { letter: 'A', email: art.email }].sort((x, y) => (x.letter === 'B' ? -1 : 1)), 'sync 1: the letters after the move');
    const again = await s.reconcile({ api, key });
    ok(again.ok && !again.first && api.writes === 1, 'sync 1: a second look writes nothing');
  }
  {
    // the other machine, signed in to B only: A is a sign-in, and nothing is written over Blackbox's list
    const api = fakeApi(), key2 = key;
    api.rows.set('accounts', K.sealText(JSON.stringify({ v: 1, letters: { A: art, B: work } }), key2, 'setting:accounts'));
    const acc = fakeAccounts({ B: work });
    const r = await SA.createAccountSync({ accounts: acc }).reconcile({ api, key: key2 });
    ok(!r.ok && /sign in Claude A/.test(r.reason) && api.writes === 0, 'sync 2: A needs a sign-in, nothing written');
    ok(r.letters[0].state === 'signin' && r.letters[0].email === art.email && r.letters[0].here === false, 'sync 2: it names the login and a new letter');
  }
  {
    // a move refused (a session runs on C): not ok, nothing else moved, it says why
    const api = fakeApi(), acc = fakeAccounts({ B: work, C: art }, { refuse: true });
    const r = await SA.createAccountSync({ accounts: acc, log: () => {} }).reconcile({ api, key });
    ok(!r.ok && r.letters.find((l) => l.letter === 'A').state === 'move', 'sync 3: a refused move leaves it not ok');
  }
  {
    // the Mac's Keychain: the login did not follow the folder, so the letter needs a sign-in again
    const api = fakeApi(), acc = fakeAccounts({ B: work, C: art }, { lost: true });
    const r = await SA.createAccountSync({ accounts: acc }).reconcile({ api, key });
    const a = r.letters.find((l) => l.letter === 'A');
    ok(!r.ok && a.state === 'signin' && a.again === true, 'sync 4: a lost login asks for a sign-in again');
  }
  {
    // the Mac with B and C the other way round from Blackbox: nothing moves by itself, the reason says the order
    const api = fakeApi();
    api.rows.set('accounts', K.sealText(JSON.stringify({ v: 1, letters: { A: work, B: art } }), key, 'setting:accounts'));
    const acc = fakeAccounts({ B: work, C: art });
    const r = await SA.createAccountSync({ accounts: acc }).reconcile({ api, key });
    ok(!r.ok && !acc.calls.length && api.writes === 0, 'sync 5: B in the way: no move, nothing written');
    ok(/sign in Claude B, then Claude A/.test(r.reason), `sync 5: B first, then A (${r.reason})`);
  }
  {
    // a list sealed with another key: an error result, not a crash, and nothing written
    const api = fakeApi();
    api.rows.set('accounts', K.sealText(JSON.stringify({ v: 1, letters: { B: work } }), crypto.randomBytes(32), 'setting:accounts'));
    const s = SA.createAccountSync({ accounts: fakeAccounts({ B: work }) });
    const r = await s.reconcile({ api, key });
    ok(!r.ok && r.error === true && api.writes === 0 && s.last() === r, 'sync 6: another key is an error');
  }
  {
    // two reconciles at once share one look
    const api = fakeApi(), acc = fakeAccounts({ B: work, C: art });
    const s = SA.createAccountSync({ accounts: acc });
    const [x, y] = await Promise.all([s.reconcile({ api, key }), s.reconcile({ api, key })]);
    ok(x === y && acc.calls.length === 1, 'sync 7: one at a time');
  }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
