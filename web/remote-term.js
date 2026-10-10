// Live sessions in a browser: the same term API the desktop window gives the page as window.fleetDesktop.term
// (desktop/preload.js), over a WebSocket to the server's /live (live.js) instead of the window's IPC. term.js
// uses it when the page is not the desktop window, so Edge on this PC and a browser on Henry's Mac (through
// Tailscale) run the Session and Chat tabs too.
//   open(o), create(o), sendTo(o) -> Promise<{ ok, message, ... }>   (never rejects: a failure is { ok: false, message })
//   list() -> Promise<[...]>   (rejects when it can't be answered, so term.js keeps what it has)
//   snapshot(id) -> Promise<string>   ('' when it can't be answered)
//   write(id, data), resize(id, cols, rows), kill(id)   fire and forget
//   onData(cb(id, chunk)), onExit(cb(id, code)), onRekey(cb(oldKey, id)) -> unsubscribe
// and, for term.js only:
//   onHost(cb(up)) -> unsubscribe   true when the server says the session host is reachable (after every connect);
//                                   false when it says it is not, when the socket drops, and when a drop has lasted
//                                   past the grace below
//   available()                     whether live sessions can be used now: the socket is up (or still making its
//                                   first try, or dropped less than 20 s ago) and the host was not reported down
//
// Requests are numbered ({ n, op, args }) and their replies ({ n, ok, v | message }) matched to them; events come
// as { t: 'data' | 'exit' | 'rekey' | 'sessions' | 'host' }. A snapshot's reply and the output events come on the
// one socket in the host's order, so the snapshot holds exactly the output sent before it (term.js relies on it).
// While the socket is down, calls wait for it to come back (at most 15 s), then answer as failed; writes, resizes
// and kills wait the same way and go out in order. It reconnects by itself (0.5 s, doubling to 10 s; at once when
// the page comes back to the front or the network returns). A request with no reply for 20 s (sendTo and create:
// 30 s) means the socket is dead though it looks open (a Mac that slept): it is closed and made again. Nothing is
// stored in the browser.

// the server answers within 15 s (sendTo and create: 20 s, plus reading /state), so a longer silence is a dead socket
const WAIT_MS = 15000, ANSWER_MS = 35000, STALL_MS = 20000, STALL_LONG_MS = 30000, GRACE_MS = 20000;
const LONG_OPS = new Set(['sendTo', 'create']);
const RETRY_FIRST_MS = 500, RETRY_MAX_MS = 10000;
const QUEUE_MAX = 2 << 20; // characters of writes held while the socket is down

export function createRemoteTerm(url = `${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}/live`) {
  let ws = null, open = false, everOpen = false, tries = 0, closedAt = 0;
  let hostUp = null; // what the server last said: true, false, or null before it said anything
  let seq = 0, retryTimer = null, graceTimer = null, backoff = RETRY_FIRST_MS;
  const pending = new Map(); // n -> { op, done(ok, v|message), timer, at }
  let held = []; let heldSize = 0; // { send(), until, size } made while the socket was down, in order
  const dataL = new Set(), exitL = new Set(), rekeyL = new Set(), hostL = new Set();
  const fire = (set, ...a) => { for (const cb of set) { try { cb(...a); } catch (e) { console.error(e); } } };
  const listen = (set) => (cb) => {
    if (typeof cb !== 'function') return () => {};
    set.add(cb);
    return () => { set.delete(cb); };
  };

  function connect() {
    clearTimeout(retryTimer); retryTimer = null;
    if (ws) return;
    let s;
    try { s = new WebSocket(url); } catch { tries++; return retry(); }
    ws = s;
    s.onopen = () => {
      if (ws !== s) return;
      open = true; everOpen = true; tries = 0; backoff = RETRY_FIRST_MS;
      clearTimeout(graceTimer); graceTimer = null;
      // what waited for the socket goes out now, in the order it was made
      const q = held; held = []; heldSize = 0;
      for (const h of q) { clearTimeout(h.timer); h.send(); }
    };
    s.onmessage = (e) => { if (ws === s) onMessage(e.data); };
    s.onclose = () => { if (ws === s) dropped(); };
    s.onerror = () => {};
  }

  function retry() {
    if (retryTimer) return;
    retryTimer = setTimeout(connect, backoff);
    backoff = Math.min(RETRY_MAX_MS, backoff * 2);
  }

  function dropped() {
    const was = open;
    ws = null; open = false; tries++;
    if (was) closedAt = Date.now();
    // replies that were on their way won't come now
    for (const [n, p] of pending) { pending.delete(n); clearTimeout(p.timer); p.done(false, 'the connection to Fleet View dropped'); }
    if (was) {
      fire(hostL, false);
      // past the grace the page treats live sessions as away until the socket is back
      clearTimeout(graceTimer);
      graceTimer = setTimeout(() => { graceTimer = null; if (!open) fire(hostL, false); }, GRACE_MS + 50);
    } else if (tries === 2 && !everOpen) fire(hostL, false); // the first tries failed: say so once
    retry();
  }

  function onMessage(data) {
    if (typeof data !== 'string') return;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.n !== undefined) {
      const p = pending.get(m.n);
      if (!p) return;
      pending.delete(m.n);
      clearTimeout(p.timer);
      p.done(m.ok === true, m.ok === true ? m.v : String(m.message || 'it failed'));
      return;
    }
    if (m.t === 'data') fire(dataL, m.id, m.d);
    else if (m.t === 'exit') fire(exitL, m.id, m.code ?? null);
    else if (m.t === 'rekey') fire(rekeyL, m.from, m.id);
    else if (m.t === 'host') { hostUp = !!m.up; fire(hostL, hostUp); }
  }

  // run send() now when the socket is up, else when it is back (at most WAIT_MS; then fail())
  function whenOpen(send, fail, size = 0) {
    if (!ws) connect();
    if (open) { send(); return; }
    if (heldSize + size > QUEUE_MAX) { fail(); return; }
    const h = { send, size };
    h.timer = setTimeout(() => {
      const i = held.indexOf(h);
      if (i >= 0) { held.splice(i, 1); heldSize -= size; }
      fail();
    }, WAIT_MS);
    held.push(h);
    heldSize += size;
  }

  // a request with a reply: done(ok, v | message) runs once
  function request(op, args, done) {
    whenOpen(() => {
      if (!open) { done(false, 'the connection to Fleet View dropped'); return; }
      const n = ++seq;
      const p = { op, done, at: Date.now() };
      p.timer = setTimeout(() => { if (pending.delete(n)) done(false, 'Fleet View did not answer'); }, ANSWER_MS);
      pending.set(n, p);
      try { ws.send(JSON.stringify({ n, op, args })); } catch { if (pending.delete(n)) { clearTimeout(p.timer); done(false, 'the connection to Fleet View dropped'); } }
    }, () => done(false, everOpen ? 'lost the connection to Fleet View on the PC; try again in a moment' : "can't reach Fleet View's live sessions"));
  }
  // fire and forget, in order with everything else
  function tell(op, args, size = 0) {
    whenOpen(() => { if (open) { try { ws.send(JSON.stringify({ op, args })); } catch {} } }, () => {}, size);
  }
  // open / create / sendTo: { ok: false, message } instead of failing
  const invoke = (op, o) => new Promise((resolve) => request(op, [o], (ok, v) => {
    if (ok && v && typeof v === 'object') resolve(v);
    else resolve({ ok: false, message: ok ? 'no answer' : v });
  }));
  const acct = (a) => (typeof a === 'string' && /^[a-z]$/i.test(a) ? a.toUpperCase() : 'B');
  const size = (x) => ({ cols: Number(x.cols) || undefined, rows: Number(x.rows) || undefined });

  // a socket that looks open but answers nothing (the Mac slept, the network changed): make it again
  setInterval(() => {
    if (!open) return;
    const now = Date.now();
    for (const p of pending.values()) if (now - p.at > (LONG_OPS.has(p.op) ? STALL_LONG_MS : STALL_MS)) { try { ws.close(); } catch {} dropped(); return; }
  }, 5000);
  const soon = () => { if (!ws) { backoff = RETRY_FIRST_MS; connect(); } };
  window.addEventListener('online', soon);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') soon(); });

  connect();

  return {
    open: (o) => {
      const x = o && typeof o === 'object' ? o : {};
      return invoke('open', { id: String(x.id || ''), cwd: typeof x.cwd === 'string' ? x.cwd : null, account: acct(x.account), ...size(x) });
    },
    sendTo: (o) => {
      const x = o && typeof o === 'object' ? o : {};
      return invoke('sendTo', { id: String(x.id || ''), cwd: typeof x.cwd === 'string' ? x.cwd : null, account: acct(x.account), ...size(x) });
    },
    create: (o) => {
      const x = o && typeof o === 'object' ? o : {};
      return invoke('create', { cwd: typeof x.cwd === 'string' ? x.cwd : '', account: acct(x.account), ...size(x), ...(typeof x.forkFrom === 'string' ? { forkFrom: x.forkFrom } : {}) });
    },
    write: (id, data) => { if (typeof data === 'string' && data) tell('write', [String(id), data], data.length); },
    resize: (id, cols, rows) => tell('resize', [String(id), Math.floor(Number(cols)) || 0, Math.floor(Number(rows)) || 0]),
    kill: (id) => tell('kill', [String(id)]),
    list: () => new Promise((resolve, reject) => request('list', [], (ok, v) => (ok && Array.isArray(v) ? resolve(v) : reject(new Error(ok ? 'not a list' : v))))),
    snapshot: (id) => new Promise((resolve) => request('snapshot', [String(id)], (ok, v) => resolve(ok && typeof v === 'string' ? v : ''))),
    onData: listen(dataL),
    onExit: listen(exitL),
    onRekey: listen(rekeyL),
    onHost: listen(hostL),
    available: () => {
      if (hostUp === false) return false;
      if (open) return true;
      if (!everOpen) return tries < 2;
      return hostUp === true && Date.now() - closedAt < GRACE_MS;
    },
    // the host's state as the server last said it (null before), and whether the socket is up: for messages
    hostUp: () => hostUp,
    connected: () => open,
  };
}
