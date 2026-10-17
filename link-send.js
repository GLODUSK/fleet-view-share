// link-send.js: typing into a chat another of Henry's machines runs (docs/sync-follow.md item 6, "Follow you";
// docs/link.md, "The Chat tab's routes"). The Chat tab sends, answers, stops and reads such a chat through the page
// routes below; each one goes to the machine that hosts it through the link (link.js call()), which reaches that
// machine's relay.js the way the phone does, and its own /api/sessions/... routes there: a message never goes into an
// open menu, a menu is answered only on purpose, and the relay's marker makes it Henry's words. The chat stays where it
// runs; nothing is written into its log here. fleet-view.js serves the routes (this machine's own page only, as the
// other /link/* routes) and asks conversation() before it answers GET /conversation from this machine's copy.
//
//   createLinkSend({ link, owners, away, rootOut })
//     link()     -> link.js's object while sync runs, else null
//     owners()   -> sync-run.js owners(): Map<id, { device, name, live, moving, bound? }> (the chats another device
//                   owns, and the ones moving between it and this one), or null
//     away(id)   -> away.json's entry for it ({ device: a name, why }) or null: sync isn't running here, but the session
//                   host still refuses it as another machine's (sync-run.js keeps away.json on a lost sign-in)
//     rootOut(folder) -> the repo a folder here is, as every machine knows it: { origin, name } (sync-prefs.js
//                   makeTranslate's out), or null
//   -> { route(m, pathname, q, b) -> Promise<[status, json]> | null (null: not one of these routes), hostOf(id),
//        conversation(id, q) -> Promise<json | null> }
//
// The routes ([method path] { what the page sends } -> the host's route, through the link):
//   POST /link/send      { id, text }                                  POST /api/sessions/:id/message { text, queue,
//                                                                      open }: queued behind a menu there, resumed
//                                                                      there when it isn't running
//   POST /link/answer    { id, option, sig?, text?, allowPermission? }  POST /api/sessions/:id/answer
//   POST /link/interrupt { id }                                        POST /api/sessions/:id/interrupt (Esc once)
//   POST /link/now       { id }                                        POST /api/sessions/:id/now
//   POST /link/unsend    { id, text }                                  POST /api/sessions/:id/unsend
//   GET  /link/activity  ?id=                                          GET  /api/sessions/:id/activity
//   GET  /link/menu      ?id=                                          GET  /api/sessions/:id/menu
//   POST /link/image     { id, data, mime }                            POST /chat/image (-> { path } on the host)
// The host's answer comes back as it is (its status and JSON). When it can't be reached the answer is this machine's:
// { ok: false, code, message } with code
//   bad_id 400, bad_request 400 (a field that isn't right), too_large 413,
//   not_elsewhere 409 (this machine runs it, or nobody else owns it), moving 409 (a move under way: wait),
//   not_running 409 (sync isn't running here, so the link isn't either), not_linked 409 ("<host> isn't linked with
//   this machine yet: …"), revoked 409, pc-restarted 409 (the host restarted mid-request: a POST may have gone in),
//   offline 503, stopped 503, timeout 504, and bad_answer 502 (the host answered with something that isn't JSON).
// Only the routes' own fields go on, and never a body field the page did not set here: a page can't reach any other
// route of the host's through these.
//
// A new chat on the main computer (Henry, 2026-10-17: chats started on the other computer run on the main one):
//   POST /link/start { device, repo, account, prompt?, name?, model?, effort? }
//     -> that machine's POST /api/sessions { repoOf: { origin, name }, account, prompt | blank: true, name?, model?,
//        effort? }: repo is this machine's folder, sent as the repo it is (rootOut) so that machine starts it in its
//        own checkout (api.js; 404 no_checkout when it has none); no prompt starts it blank, for Henry to type into.
//        Its answer comes back as it is ({ ok, key, id, … }, the id once Claude Code named it) with host: { device,
//        name } added. Refusals as above, and: bad_device 400 (not a sync device id), no_repo 409 (the folder is no
//        repo rootOut knows), offline 503 at once when the link says that machine is off (nothing is sent).
//
// conversation(id, q): a chat another machine hosts, read from that machine while the link to it is up (online), as
// the phone reads it: its /conversation answer with source: '<host's name>' added; null (fleet-view.js then answers
// from this machine's synced copy, with source: 'local') when it isn't another machine's, is moving, the link is down
// or the host said no. q: { since, before, limit } (numbers, as the page sends them).
'use strict';
const path = require('path');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEXT_MAX = 400000; // a message's text (the relay's part size; parts carry more, but no one types this much)
const ANSWER_MAX = 10000; // a question's typed answer
const IMAGE_MAX = 21000000; // an image as base64 (15 MB, the host's own limit for /chat/image)
const IMG_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const CONV_MS = 15000; // a feed read from the host: the page asks again a second later anyway

// what a call that reached no answer means for the page -> [status, code, message]
function unreached(code, name) {
  switch (code) {
    case 'not_linked': return [409, 'not_linked', `${name} isn't linked with this machine yet: they link by themselves while both are online (press Link in the Sync card if you unlinked it)`];
    case 'revoked': return [409, 'revoked', `${name} unlinked this machine: press Link in the Sync card to link them again`];
    case 'offline': return [503, 'offline', `${name} is offline`];
    case 'timeout': return [504, 'timeout', `${name} didn't answer in time`];
    case 'pc-restarted': return [409, 'pc-restarted', `${name} restarted while this was being sent: check before sending it again`];
    case 'stopped': return [503, 'stopped', 'Sync stopped on this machine'];
    case 'too_large': return [413, 'too_large', `That is too large to send to ${name}`];
    default: return [502, code || 'unreached', `${name} could not be reached`];
  }
}

const isText = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

// each route: method, the host's path for a conversation id, and the body the host gets from the page's (null: a
// GET) -> the body, or a string saying what is wrong
const ROUTES = {
  '/link/send': {
    m: 'POST', path: (id) => `/api/sessions/${id}/message`,
    body: (b) => (isText(b.text, TEXT_MAX) ? { text: b.text, queue: true, open: true } : `text must be the message (at most ${TEXT_MAX} characters)`),
  },
  '/link/answer': {
    m: 'POST', path: (id) => `/api/sessions/${id}/answer`,
    body: (b) => {
      const o = b.option;
      if (!(o === 'esc' || o === 'submit' || (Number.isInteger(o) && o >= 1 && o <= 99))) return 'option must be an option\'s number, "submit" or "esc"';
      const out = { option: o };
      if (b.sig != null) { if (typeof b.sig !== 'string' || b.sig.length > 2000) return 'sig must be the menu\'s sig'; out.sig = b.sig; }
      if (b.text != null) { if (!isText(b.text, ANSWER_MAX)) return `text must be the answer (at most ${ANSWER_MAX} characters)`; out.text = b.text; }
      if (b.allowPermission != null) { if (typeof b.allowPermission !== 'boolean') return 'allowPermission must be true or false'; out.allowPermission = b.allowPermission; }
      return out;
    },
  },
  '/link/interrupt': { m: 'POST', path: (id) => `/api/sessions/${id}/interrupt`, body: () => ({}) },
  '/link/now': { m: 'POST', path: (id) => `/api/sessions/${id}/now`, body: () => ({}) },
  '/link/unsend': {
    m: 'POST', path: (id) => `/api/sessions/${id}/unsend`,
    body: (b) => (isText(b.text, TEXT_MAX) ? { text: b.text } : 'text must be the queued message'),
  },
  '/link/activity': { m: 'GET', path: (id) => `/api/sessions/${id}/activity`, body: null },
  '/link/menu': { m: 'GET', path: (id) => `/api/sessions/${id}/menu`, body: null },
  '/link/image': {
    m: 'POST', path: () => '/chat/image',
    body: (b) => (typeof b.data === 'string' && b.data.length > 0 && b.data.length <= IMAGE_MAX && /^[A-Za-z0-9+/=\s]+$/.test(b.data.slice(0, 4096))
      ? (IMG_MIMES.has(b.mime) ? { data: b.data, mime: b.mime } : 'mime must be image/png, image/jpeg, image/gif or image/webp')
      : 'data must be the image as base64 (at most 15 MB)'),
  },
};

// POST /link/start's body as that machine's POST /api/sessions takes it (with repoOf for repo) -> the body, or a
// string saying what is wrong. The same checks as api.js startSession, so a bad field is told here
const NAME_MAX = 80;
const NAME_BAD = /[\x00-\x1f\x7f-\x9f]/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9.\-\[\]]{0,59}$/;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
function startBody(b) {
  if (typeof b.repo !== 'string' || !b.repo || b.repo.length > 1024 || !path.isAbsolute(b.repo)) return 'repo must be the folder here (an absolute path)';
  if (typeof b.account !== 'string' || !/^[A-Z]$/.test(b.account)) return 'account must be a Claude account letter';
  const out = { account: b.account };
  if (b.prompt != null) { if (!isText(b.prompt, TEXT_MAX)) return `prompt must be text (at most ${TEXT_MAX} characters)`; out.prompt = b.prompt; } else out.blank = true;
  if (b.name != null) { if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > NAME_MAX || NAME_BAD.test(b.name)) return `name must be text of 1 to ${NAME_MAX} characters`; out.name = b.name; }
  if (b.model != null) { if (typeof b.model !== 'string' || !MODEL_RE.test(b.model)) return 'model must be a model name like opus or claude-opus-5-5[1m]'; out.model = b.model; }
  if (b.effort != null) { if (!EFFORTS.includes(b.effort)) return `effort must be one of ${EFFORTS.join(', ')}`; out.effort = b.effort; }
  return out;
}

function createLinkSend(o = {}) {
  const linkOf = typeof o.link === 'function' ? o.link : () => null;
  const ownersOf = typeof o.owners === 'function' ? o.owners : () => null;
  const awayOf = typeof o.away === 'function' ? o.away : () => null;
  const rootOutOf = typeof o.rootOut === 'function' ? o.rootOut : () => null;
  const no = (s, code, message) => [s, { ok: false, code, message }];

  // POST /link/start (see the top): a new chat on that machine, in its own checkout of the repo
  async function start(m, b) {
    if (m !== 'POST') return no(405, 'bad_method', 'POST');
    const x = b && typeof b === 'object' ? b : {};
    const device = String(x.device || '').toLowerCase();
    if (!UUID_RE.test(device)) return no(400, 'bad_device', 'device must be a sync device id');
    const body = startBody(x);
    if (typeof body === 'string') return no(400, 'bad_request', body);
    let r = null;
    try { r = rootOutOf(x.repo); } catch {}
    const origin = r && typeof r.origin === 'string' && r.origin ? r.origin : null;
    const rname = r && typeof r.name === 'string' && r.name ? r.name : null;
    if (!origin && !rname) return no(409, 'no_repo', `${x.repo} is no repo Fleet View knows`);
    let link = null;
    try { link = linkOf(); } catch {}
    let name = 'the main computer';
    try {
      const st = link && typeof link.status === 'function' ? link.status() : null;
      const mm = st && Array.isArray(st.machines) ? st.machines.find((y) => y && String(y.id || '').toLowerCase() === device) : null;
      if (mm && typeof mm.name === 'string' && mm.name) name = mm.name;
    } catch {}
    if (!link || typeof link.call !== 'function') return no(409, 'not_running', `Sync isn't running on this machine, so it can't reach ${name}`);
    let on = null;
    try { on = typeof link.online === 'function' ? link.online(device) : null; } catch {}
    if (on === false) { const [s, code, message] = unreached('offline', name); return no(s, code, message); }
    let res;
    try { res = await link.call(device, 'POST', '/api/sessions', { b: { ...body, repoOf: { origin, name: rname } } }); } catch (e) { res = { s: 0, b: { code: 'unreached', message: String((e && e.message) || e) } }; }
    if (!res || !res.s) {
      const [s, code, message] = unreached(res && res.b && res.b.code, name);
      return no(s, code, message);
    }
    if (res.b === undefined || res.b === null || typeof res.b !== 'object' || Array.isArray(res.b)) return no(502, 'bad_answer', `${name} answered ${res.s} without the expected JSON`);
    return [res.s, { ...res.b, host: { device, name } }];
  }

  // the machine another device's chat runs on: { device, name, moving } or null
  function hostOf(id) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
    let m = null;
    try { m = ownersOf(); } catch {}
    const e = m && typeof m.get === 'function' ? m.get(id.toLowerCase()) : null;
    if (!e || typeof e !== 'object' || typeof e.device !== 'string' || !e.device) return null;
    return { device: e.device.toLowerCase(), name: (typeof e.name === 'string' && e.name) || 'the other machine', moving: e.moving || null };
  }

  async function route(m, pathname, q, b) {
    if (pathname === '/link/start') return start(m, b);
    const r = ROUTES[pathname];
    if (!r) return null;
    if (m !== r.m) return no(405, 'bad_method', r.m);
    const id = String((r.m === 'GET' ? q && q.id : b && b.id) || '').toLowerCase();
    if (!UUID_RE.test(id)) return no(400, 'bad_id', 'give a conversation id');
    let body = null;
    if (r.body) {
      body = r.body(b && typeof b === 'object' ? b : {});
      if (typeof body === 'string') return no(400, 'bad_request', body);
    }
    const h = hostOf(id);
    if (!h) {
      let a = null;
      try { a = awayOf(id); } catch {}
      if (a) return no(409, 'not_running', `Sync isn't running on this machine: sign in to sync (the Sync card) to type into this chat on ${a.device || 'the other machine'}`);
      return no(409, 'not_elsewhere', 'This chat runs on this machine');
    }
    if (h.moving) return no(409, 'moving', h.moving === 'here' ? `It is moving here from ${h.name}: wait a moment` : `It is moving to ${h.name}: wait a moment`);
    let link = null;
    try { link = linkOf(); } catch {}
    if (!link || typeof link.call !== 'function') return no(409, 'not_running', `Sync isn't running on this machine, so it can't reach ${h.name}`);
    let res;
    try { res = await link.call(h.device, r.m, r.path(id), r.m === 'POST' ? { b: body } : {}); } catch (e) { res = { s: 0, b: { code: 'unreached', message: String((e && e.message) || e) } }; }
    if (!res || !res.s) {
      const [s, code, message] = unreached(res && res.b && res.b.code, h.name);
      return no(s, code, message);
    }
    if (res.b === undefined || res.b === null || typeof res.b !== 'object') {
      if (res.s === 204) return [200, { ok: true }];
      return no(502, 'bad_answer', `${h.name} answered ${res.s} without the expected JSON`);
    }
    return [res.s, res.b];
  }

  // GET /conversation for a chat another machine hosts, read there (see the top)
  async function conversation(id, q = {}) {
    const h = hostOf(id);
    if (!h || h.moving) return null;
    let link = null;
    try { link = linkOf(); } catch {}
    if (!link || typeof link.call !== 'function') return null;
    let on = null;
    try { on = typeof link.online === 'function' ? link.online(h.device) : null; } catch {}
    if (on !== true) return null;
    const qq = { id: id.toLowerCase() };
    for (const k of ['since', 'before', 'limit']) if (Number.isSafeInteger(q[k]) && q[k] >= 0) qq[k] = q[k];
    let res;
    try { res = await link.call(h.device, 'GET', '/conversation', { q: qq, timeoutMs: CONV_MS }); } catch { return null; }
    if (!res || res.s !== 200 || !res.b || typeof res.b !== 'object' || !Array.isArray(res.b.items)) return null;
    return { ...res.b, source: h.name };
  }

  return { route, hostOf, conversation };
}

module.exports = { createLinkSend, ROUTES, unreached, startBody, TEXT_MAX, IMAGE_MAX };
