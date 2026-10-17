// Typing into a chat another machine runs: a test of link-send.js (docs/sync-follow.md item 6), run with the system
// node:   node scripts/link-send-test.js
// A fake link (link.js's call() and online(), recording each call) and a fake sync owner list stand in for the other
// machine. It checks: each route goes to the host's route with only the fields it takes (send queued and opened there,
// answer with its option, sig, text and allowPermission, interrupt, now, unsend, activity, menu, image to /chat/image);
// the host's answer comes back as it is (its status and JSON, a 404 or 409 included); the refusals (a bad id, a bad
// field, the wrong method, a chat this machine runs, one moving either way, sync not running with or without away.json,
// no link); every way a call reaches no answer (not linked, offline, timeout, the host restarted, revoked, stopped, too
// large); an answer that isn't JSON; a link that throws; and the feed: read from the host with source while the link is
// up and online, null (this machine's copy) when it is offline, unknown, the host says no, the chat is moving or this
// machine runs it, and only since / before / limit going on. And POST /link/start (a new chat on the main computer):
// its POST /api/sessions there with the repo by origin and name (repoOf), blank without a prompt, only the fields it
// takes; the host's answer with host added; its refusals (method, device, repo, account, prompt, name, model, effort,
// no repo known, offline at once, sync not running) and every way a call reaches no answer. Exit 0 = all pass. No
// network, no files.
'use strict';
const path = require('path');
const LS = require(path.join(__dirname, '..', 'link-send.js'));

let passed = 0, failed = 0;
const ok = (c, msg) => { if (c) passed++; else { failed++; console.log(`FAIL ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: want ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const ID = '3cc58c32-e304-4d25-be3a-926c533f2ca4';
const MINE = '11111111-2222-4333-8444-555555555555';
const MOVING = '22222222-3333-4444-8555-666666666666';
const COMING = '33333333-4444-4555-8666-777777777777';
const PC = '0afc6f7f-c6f1-4f46-9d69-4e6006385910';
const REPO = path.resolve(path.sep, 'code', 'fleet-view');
const LONE = path.resolve(path.sep, 'code', 'notes');

function setup(o = {}) {
  const calls = [];
  let answer = o.answer || ((d, m, p, x) => ({ s: 200, b: { ok: true, echo: { m, p, b: x.b, q: x.q } } }));
  let online = o.online === undefined ? true : o.online;
  const link = {
    call: async (d, m, p, x = {}) => { calls.push({ d, m, p, b: x.b, q: x.q, timeoutMs: x.timeoutMs }); return answer(d, m, p, x); },
    online: () => online,
    status: () => ({ running: true, machines: [{ id: PC, name: 'BlackBox', linked: true }] }),
  };
  // this machine's folders as every machine knows them (sync-prefs.js makeTranslate's out)
  const roots = new Map([[REPO, { origin: 'GLODUSK/fleet-view', name: 'fleet-view', known: true }], [LONE, { origin: null, name: 'notes', known: true }]]);
  let linkOn = true;
  const owners = new Map([
    [ID, { device: PC.toUpperCase(), name: 'BlackBox', live: true, moving: null }],
    [MOVING, { device: PC, name: 'BlackBox', live: false, moving: 'away' }],
    [COMING, { device: PC, name: 'BlackBox', live: false, moving: 'here' }],
  ]);
  let ownersOn = true;
  const away = new Map(o.away || []);
  const ls = LS.createLinkSend({ link: () => (linkOn ? link : null), owners: () => (ownersOn ? owners : null), away: (id) => away.get(id) || null, rootOut: (f) => roots.get(f) || null });
  return {
    ls, calls,
    set answer(f) { answer = f; },
    set online(v) { online = v; },
    set linkOn(v) { linkOn = v; },
    set ownersOn(v) { ownersOn = v; },
    away,
  };
}

async function main() {
  // ---------- each route to the host's, with only its own fields ----------
  {
    const t = setup();
    let r = await t.ls.route('POST', '/link/send', null, { id: ID.toUpperCase(), text: 'hello there', queue: false, open: false, via: 'phone', from: 'x' });
    eq(r[0], 200, 'send: the host\'s status');
    eq(t.calls[0], { d: PC, m: 'POST', p: `/api/sessions/${ID}/message`, b: { text: 'hello there', queue: true, open: true }, q: undefined, timeoutMs: undefined }, 'send: queued and opened on the host, nothing the page added goes on');
    r = await t.ls.route('POST', '/link/answer', null, { id: ID, option: 2, sig: 'abc', allowPermission: true, extra: 1 });
    eq(t.calls[1].p, `/api/sessions/${ID}/answer`, 'answer: the host\'s answer route');
    eq(t.calls[1].b, { option: 2, sig: 'abc', allowPermission: true }, 'answer: option, sig, allowPermission');
    await t.ls.route('POST', '/link/answer', null, { id: ID, option: 4, text: 'my own words' });
    eq(t.calls[2].b, { option: 4, text: 'my own words' }, 'answer: a typed answer goes with its option');
    await t.ls.route('POST', '/link/answer', null, { id: ID, option: 'esc' });
    await t.ls.route('POST', '/link/answer', null, { id: ID, option: 'submit' });
    eq([t.calls[3].b, t.calls[4].b], [{ option: 'esc' }, { option: 'submit' }], 'answer: esc and submit');
    await t.ls.route('POST', '/link/interrupt', null, { id: ID, anything: 1 });
    await t.ls.route('POST', '/link/now', null, { id: ID });
    await t.ls.route('POST', '/link/unsend', null, { id: ID, text: 'take it back' });
    eq(t.calls.slice(5).map((c) => [c.m, c.p, c.b]), [
      ['POST', `/api/sessions/${ID}/interrupt`, {}], ['POST', `/api/sessions/${ID}/now`, {}], ['POST', `/api/sessions/${ID}/unsend`, { text: 'take it back' }],
    ], 'interrupt, now and unsend');
    await t.ls.route('GET', '/link/activity', { id: ID }, null);
    await t.ls.route('GET', '/link/menu', { id: ID }, null);
    eq(t.calls.slice(8).map((c) => [c.m, c.p, c.b]), [['GET', `/api/sessions/${ID}/activity`, undefined], ['GET', `/api/sessions/${ID}/menu`, undefined]], 'activity and menu: GETs, no body');
    const data = Buffer.from('fake png').toString('base64');
    await t.ls.route('POST', '/link/image', null, { id: ID, data, mime: 'image/png', path: '/etc/passwd' });
    eq([t.calls[10].p, t.calls[10].b], ['/chat/image', { data, mime: 'image/png' }], 'image: to the host\'s /chat/image, data and mime only');
    eq(await t.ls.route('GET', '/link/nope', {}, null), null, 'not one of these routes: null');
  }

  // ---------- the host's answer comes back as it is ----------
  {
    const t = setup({ answer: (d, m, p) => (p.endsWith('/activity') ? { s: 404, b: { ok: false, message: 'no such hosted session' } }
      : p.endsWith('/message') ? { s: 409, b: { ok: false, menu: true, message: 'Claude is showing a menu' } } : { s: 200, b: { ok: true } }) });
    eq(await t.ls.route('GET', '/link/activity', { id: ID }, null), [404, { ok: false, message: 'no such hosted session' }], 'a 404 from the host passes through');
    eq(await t.ls.route('POST', '/link/send', null, { id: ID, text: 'x' }), [409, { ok: false, menu: true, message: 'Claude is showing a menu' }], 'a 409 from the host passes through');
    t.answer = () => ({ s: 200, b64: 'AAAA', ct: 'image/png' });
    const r = await t.ls.route('GET', '/link/menu', { id: ID }, null);
    ok(r[0] === 502 && r[1].code === 'bad_answer', 'an answer that isn\'t JSON: 502 bad_answer');
    t.answer = () => ({ s: 204 });
    eq(await t.ls.route('POST', '/link/interrupt', null, { id: ID }), [200, { ok: true }], 'a 204 with no body: ok');
    t.answer = () => { throw new Error('boom'); };
    const x = await t.ls.route('POST', '/link/now', null, { id: ID });
    ok(x[0] === 502 && x[1].ok === false, 'a link that throws: 502, never an exception');
  }

  // ---------- refusals ----------
  {
    const t = setup({ away: [[MINE, { device: 'BlackBox', why: 'owned' }]] });
    const code = async (m, p, q, b) => { const r = await t.ls.route(m, p, q, b); return [r[0], r[1].code]; };
    eq(await code('POST', '/link/send', null, { id: 'nope', text: 'x' }), [400, 'bad_id'], 'a bad id');
    eq(await code('POST', '/link/send', null, { id: ID, text: '   ' }), [400, 'bad_request'], 'send: empty text');
    eq(await code('POST', '/link/send', null, { id: ID, text: 'x'.repeat(LS.TEXT_MAX + 1) }), [400, 'bad_request'], 'send: too long');
    eq(await code('POST', '/link/answer', null, { id: ID, option: 0 }), [400, 'bad_request'], 'answer: option 0');
    eq(await code('POST', '/link/answer', null, { id: ID, option: '1' }), [400, 'bad_request'], 'answer: option as text');
    eq(await code('POST', '/link/answer', null, { id: ID, option: 1, allowPermission: 'yes' }), [400, 'bad_request'], 'answer: allowPermission not a boolean');
    eq(await code('POST', '/link/answer', null, { id: ID, option: 1, text: '' }), [400, 'bad_request'], 'answer: empty text');
    eq(await code('POST', '/link/unsend', null, { id: ID }), [400, 'bad_request'], 'unsend: no text');
    eq(await code('POST', '/link/image', null, { id: ID, data: 'AAAA', mime: 'image/svg+xml' }), [400, 'bad_request'], 'image: not a raster image type');
    eq(await code('POST', '/link/image', null, { id: ID, data: '<script>', mime: 'image/png' }), [400, 'bad_request'], 'image: not base64');
    eq(await code('GET', '/link/send', { id: ID }, null), [405, 'bad_method'], 'the wrong method');
    eq(await code('POST', '/link/send', null, { id: MINE, text: 'x' }), [409, 'not_running'], 'not in the owners but in away.json: sync not running here');
    eq(await code('POST', '/link/send', null, { id: '44444444-5555-4666-8777-888888888888', text: 'x' }), [409, 'not_elsewhere'], 'a chat this machine runs');
    eq(await code('POST', '/link/send', null, { id: MOVING, text: 'x' }), [409, 'moving'], 'moving to the other machine');
    eq(await code('POST', '/link/send', null, { id: COMING, text: 'x' }), [409, 'moving'], 'moving here');
    t.ownersOn = false;
    eq(await code('POST', '/link/send', null, { id: ID, text: 'x' }), [409, 'not_elsewhere'], 'sync off and nothing in away.json: not elsewhere');
    t.ownersOn = true;
    t.linkOn = false;
    const r = await t.ls.route('POST', '/link/send', null, { id: ID, text: 'x' });
    ok(r[0] === 409 && r[1].code === 'not_running' && /BlackBox/.test(r[1].message), 'no link: not_running, naming the host');
    eq(t.calls.length, 0, 'no refused request reached the link');
  }

  // ---------- every way a call reaches no answer ----------
  {
    const t = setup();
    for (const [code, s, re] of [
      ['not_linked', 409, /^BlackBox isn't linked with this machine yet: they link by themselves/], ['offline', 503, /BlackBox is offline/], ['timeout', 504, /didn't answer/],
      ['pc-restarted', 409, /restarted/], ['revoked', 409, /unlinked/], ['stopped', 503, /stopped/], ['too_large', 413, /too large/], ['weird', 502, /could not be reached/],
    ]) {
      t.answer = () => ({ s: 0, b: { ok: false, code, message: 'from the link' } });
      const r = await t.ls.route('POST', '/link/send', null, { id: ID, text: 'x' });
      ok(r[0] === s && r[1].ok === false && r[1].code === (code === 'weird' ? 'weird' : code) && re.test(r[1].message), `unreached ${code}: ${s} with words (${r[0]} ${r[1].message})`);
    }
  }

  // ---------- POST /link/start: a new chat on the main computer ----------
  {
    const t = setup({ answer: (d, m, p, x) => ({ s: 200, b: { ok: true, key: 'new-3', id: ID, promptSent: !x.b.blank } }) });
    // blank (no prompt): the repo as every machine knows it, the account, blank; nothing the page added goes on
    let r = await t.ls.route('POST', '/link/start', null, { device: PC.toUpperCase(), repo: REPO, account: 'B', role: 'bot:a1b2c3d4e5f6', forkFrom: ID, temp: true, cwd: 'C:\\x', via: 'phone' });
    eq(r, [200, { ok: true, key: 'new-3', id: ID, promptSent: false, host: { device: PC, name: 'BlackBox' } }], 'start: the host\'s answer, with host');
    eq(t.calls[0], { d: PC, m: 'POST', p: '/api/sessions', b: { account: 'B', blank: true, repoOf: { origin: 'GLODUSK/fleet-view', name: 'fleet-view' } }, q: undefined, timeoutMs: undefined },
      'start: POST /api/sessions there with repoOf and blank, and only the fields it takes');
    // with a prompt, a name, a model and an effort: they go on; a repo with no origin goes by its name
    r = await t.ls.route('POST', '/link/start', null, { device: PC, repo: LONE, account: 'A', prompt: 'look at the notes', name: 'Notes', model: 'claude-opus-5-5[1m]', effort: 'high' });
    eq(r[0], 200, 'start with a prompt: 200');
    eq(t.calls[1].b, { account: 'A', prompt: 'look at the notes', name: 'Notes', model: 'claude-opus-5-5[1m]', effort: 'high', repoOf: { origin: null, name: 'notes' } }, 'start: prompt, name, model, effort, and the repo by its name');
    // the host's refusals come back as they are (no checkout there, a bad account there)
    t.answer = () => ({ s: 404, b: { ok: false, code: 'no_checkout', message: 'this machine has no checkout of fleet-view' } });
    r = await t.ls.route('POST', '/link/start', null, { device: PC, repo: REPO, account: 'B' });
    ok(r[0] === 404 && r[1].code === 'no_checkout' && r[1].host.name === 'BlackBox', 'start: no checkout there passes through');
    t.answer = () => ({ s: 200, b64: 'AAAA' });
    r = await t.ls.route('POST', '/link/start', null, { device: PC, repo: REPO, account: 'B' });
    ok(r[0] === 502 && r[1].code === 'bad_answer', 'start: an answer that isn\'t JSON: 502 bad_answer');
    t.answer = () => { throw new Error('boom'); };
    r = await t.ls.route('POST', '/link/start', null, { device: PC, repo: REPO, account: 'B' });
    ok(r[0] === 502 && r[1].ok === false, 'start: a link that throws: 502, never an exception');
    const n0 = t.calls.length;
    // refusals before anything is sent
    const code = async (b, m = 'POST') => { const x = await t.ls.route(m, '/link/start', null, b); return [x[0], x[1].code]; };
    eq(await code({ device: PC, repo: REPO, account: 'B' }, 'GET'), [405, 'bad_method'], 'start: the wrong method');
    eq(await code({ device: 'BlackBox', repo: REPO, account: 'B' }), [400, 'bad_device'], 'start: not a device id');
    eq(await code({ repo: REPO, account: 'B' }), [400, 'bad_device'], 'start: no device');
    eq(await code({ device: PC, repo: 'fleet-view', account: 'B' }), [400, 'bad_request'], 'start: a repo that isn\'t a folder path');
    eq(await code({ device: PC, account: 'B' }), [400, 'bad_request'], 'start: no repo');
    eq(await code({ device: PC, repo: REPO, account: 'b' }), [400, 'bad_request'], 'start: not an account letter');
    eq(await code({ device: PC, repo: REPO, account: 'B', prompt: '  ' }), [400, 'bad_request'], 'start: an empty prompt');
    eq(await code({ device: PC, repo: REPO, account: 'B', prompt: 'x'.repeat(LS.TEXT_MAX + 1) }), [400, 'bad_request'], 'start: a prompt too long');
    eq(await code({ device: PC, repo: REPO, account: 'B', name: 'x'.repeat(81) }), [400, 'bad_request'], 'start: a name too long');
    eq(await code({ device: PC, repo: REPO, account: 'B', name: 'a\nb' }), [400, 'bad_request'], 'start: a name with a new line');
    eq(await code({ device: PC, repo: REPO, account: 'B', model: 'opus; rm' }), [400, 'bad_request'], 'start: not a model name');
    eq(await code({ device: PC, repo: REPO, account: 'B', effort: 'huge' }), [400, 'bad_request'], 'start: not an effort');
    eq(await code({ device: PC, repo: path.resolve(path.sep, 'nowhere'), account: 'B' }), [409, 'no_repo'], 'start: a folder no repo is known for');
    t.online = false;
    r = await t.ls.route('POST', '/link/start', null, { device: PC, repo: REPO, account: 'B' });
    ok(r[0] === 503 && r[1].code === 'offline' && /BlackBox is offline/.test(r[1].message), 'start: the main computer offline: 503 offline at once, naming it');
    t.online = null;
    t.linkOn = false;
    r = await t.ls.route('POST', '/link/start', null, { device: PC, repo: REPO, account: 'B' });
    ok(r[0] === 409 && r[1].code === 'not_running', 'start: sync not running here: not_running');
    eq(t.calls.length, n0, 'start: no refused request reached the link');
    t.linkOn = true;
    // every way a call reaches no answer, as for the other routes (online unknown: it is tried)
    for (const [c, s] of [['not_linked', 409], ['offline', 503], ['timeout', 504], ['pc-restarted', 409], ['revoked', 409]]) {
      t.answer = () => ({ s: 0, b: { ok: false, code: c } });
      const x = await t.ls.route('POST', '/link/start', null, { device: PC, repo: REPO, account: 'B' });
      ok(x[0] === s && x[1].code === c && /BlackBox/.test(x[1].message), `start: unreached ${c}: ${s} (${x[0]} ${x[1].message})`);
    }
    // a device the link doesn't name: words say "the main computer"
    t.answer = () => ({ s: 0, b: { ok: false, code: 'offline' } });
    const other = await t.ls.route('POST', '/link/start', null, { device: MINE, repo: REPO, account: 'B' });
    ok(/the main computer is offline/.test(other[1].message), 'start: an unknown device is "the main computer"');
    eq(LS.startBody({ repo: REPO, account: 'B' }), { account: 'B', blank: true }, 'startBody: no prompt is blank');
  }

  // ---------- the feed ----------
  {
    const t = setup({ answer: (d, m, p, x) => (p === '/conversation' ? { s: 200, b: { id: x.q.id, total: 3, from: 0, items: [{ key: 'a' }] } } : { s: 200, b: {} }) });
    let c = await t.ls.conversation(ID, { since: 2, before: undefined, limit: 'x', evil: 1 });
    eq(c, { id: ID, total: 3, from: 0, items: [{ key: 'a' }], source: 'BlackBox' }, 'read from the host, with source');
    eq([t.calls[0].p, t.calls[0].q, t.calls[0].timeoutMs], ['/conversation', { id: ID, since: 2 }, 15000], 'only id and the numbers go on');
    t.online = false;
    eq(await t.ls.conversation(ID, {}), null, 'the host offline: this machine\'s copy');
    t.online = null;
    eq(await t.ls.conversation(ID, {}), null, 'not known to be online: this machine\'s copy');
    t.online = true;
    t.answer = () => ({ s: 404, b: { error: 'no such conversation' } });
    eq(await t.ls.conversation(ID, {}), null, 'the host says no: this machine\'s copy');
    t.answer = () => ({ s: 200, b: { nothing: true } });
    eq(await t.ls.conversation(ID, {}), null, 'an answer with no items: this machine\'s copy');
    eq(await t.ls.conversation(MOVING, {}), null, 'moving: this machine\'s copy');
    eq(await t.ls.conversation(MINE, {}), null, 'this machine runs it: this machine\'s copy');
    t.linkOn = false;
    eq(await t.ls.conversation(ID, {}), null, 'no link: this machine\'s copy');
    eq(t.ls.hostOf(ID), { device: PC, name: 'BlackBox', moving: null }, 'hostOf: the device lower-case, its name');
    eq(t.ls.hostOf('nope'), null, 'hostOf: a bad id');
  }

  console.log(`${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
