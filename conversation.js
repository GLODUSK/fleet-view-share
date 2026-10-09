// Fleet View chat feed: a conversation's log (its <id>.jsonl transcript) as a list of chat items, for the
// detail panel's Chat tab (web/chat.js), and the images its compose box attaches (web/compose.js).
// fleet-view.js hands GET /conversation and POST /chat/image here (see conversation() and saveImage()).
//
// Logs can be hundreds of MB, so what is kept per log is an index, not the conversation: one small record per
// chat item (its kind, key, time and where its lines are in the file, as byte offset and length), plus the
// note texts, which are short. Nothing is dropped, so `total` is the true count and "show earlier" reaches
// the start. A request reads the lines of the items it sends back from the file again (300 at most by default,
// the last 12 or so on a poll), so images and tool output are never held in memory between requests.
// The first read of a log goes through it in 8 MB chunks, one line at a time, and yields between chunks so the
// server keeps answering; later reads take only what was appended. A log that shrank or was replaced (another
// file at the same path) is read again from the start. At most MAX_LOGS logs are indexed at once; the one used
// least recently is forgotten first.
//
// The index also keeps what runs in the background (L.bg): a shell started with run_in_background (or sent to the
// background with Ctrl+B), an agent launched async, a workflow, a monitor. Each starts when its tool result says
// it was launched (toolUseResult.backgroundTaskId / taskId / agentId) and ends with the <task-notification> that
// carries its task id and a <status> (a monitor's events carry none), a TaskStop of it, or a monitor's timeout.
// A reply lists them as `bg`, only while the conversation's claude process is alive (ctx.live): a session that
// ended takes its tasks with it, and the next one is told they "didn't finish before the previous session ended".
//
// A rewind (/rewind, "Restore conversation") leaves the old lines in the file: the next prompt's parentUuid points
// back to a record before an earlier prompt. That prompt and everything after it are then dropped from the index
// (L.cut counts these, and a reply carries it so the page reloads its list).
// The messages queued while Claude is mid-turn (L.queue, in order) come from the queue-operation lines: enqueue
// adds one, popAll / remove / dequeue take one out. A reply lists them as `queue` while the claude is alive.
//
// Lines Claude Code wrote are only ever appended, so an offset stays good for the life of the file. A line that
// is not JSON, or trips the reader, is skipped.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'fleet-view');
const IMG_DIR = path.join(DATA_DIR, 'chat-images');
const FIXTURE = path.join(__dirname, 'web', 'fixtures', 'conversation-sample.json');

const PAGE = 300; // items sent when no since/before is given
const RESEND = 12; // a poll (since=n) sends again from n-12, so growing messages and tool results update
const SINCE_MAX = 2000; // a poll sends at most this many items; one further behind starts at total-2000
const LIMIT_MAX = 1000; // the most "show earlier" (before/limit) sends at once
const RECENT_MS = 30e3; // a poll also goes back to an item that changed this recently (a tool result that came late)
const LOOKBACK = 200; // ...but at most this far behind its own start
const CAP = 20000; // characters kept of each string in a tool's input, a tool result, and a note
const IMG_INLINE_MAX = 4 << 20; // bytes: a bigger image in a prompt is sent as { omitted: true }
const CHUNK = 8 << 20; // bytes read at a time
const MAX_LOGS = 6; // logs indexed at once

const IMG_SAVE_MAX = 15 << 20; // bytes: the biggest image /chat/image takes
const BODY_MAX = 21 << 20; // the request: base64 makes 15 MB into 20 MB, plus the JSON around it
const IMG_KEEP_MS = 7 * 24 * 3600e3; // saved images are deleted after a week
const IMG_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const IMG_NAME = /^[0-9a-f]{16}\.(?:png|jpg|gif|webp)$/;
const imgType = (m) => typeof m === 'string' && Object.hasOwn(IMG_TYPES, m); // never a prototype name

// ---------- small helpers ----------
const capStr = (s) => (s.length > CAP ? s.slice(0, CAP - 1) + '…' : s);
// a tool's input with every string capped (deep), so one huge Write doesn't make the reply huge
function capDeep(v, depth = 0) {
  if (typeof v === 'string') return capStr(v);
  if (!v || typeof v !== 'object' || depth > 30) return v;
  if (Array.isArray(v)) return v.map((x) => capDeep(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = capDeep(x, depth + 1);
  return out;
}
const timeOf = (ts) => { const t = typeof ts === 'string' ? Date.parse(ts) : NaN; return Number.isFinite(t) ? t : null; };
const intArg = (v, lo, hi, dflt) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };

// What a user record says once the wrappers Claude Code adds are gone: its text blocks (or its string) without
// <system-reminder> and similar blocks, and its image blocks. tool_result blocks are left out (they belong to
// their tool item).
const WRAPPERS = /<(system-reminder|local-command-caveat)>[\s\S]*?<\/\1>/g;
const IMG_MARK = /\[Image #\d+\] ?/g;
// Claude Code wraps a multi-line paste (a Reply quote is one) in <pasted_content id="8b35"> … </pasted_content id="8b35">:
// the tags go, the pasted text stays
const PASTE_TAG = /<\/?pasted_content id="[\w-]*">\n?/g;
function userView(content) {
  const texts = [], images = [];
  if (typeof content === 'string') texts.push(content);
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
      else if (b.type === 'image') images.push(b);
    }
  }
  // Claude Code puts "[Image #1]" in the text where a pasted image was; the image itself shows above it
  const strip = (t) => (images.length ? t.replace(IMG_MARK, '') : t).replace(WRAPPERS, '').replace(PASTE_TAG, '').trim();
  const text = texts.map(strip).filter(Boolean).join('\n\n');
  return { text, images };
}
// a prompt's image block, when it is one the page may show: base64, a picture type, at most 4 MB
function imageBlock(b) {
  const src = b && b.source;
  if (!src || src.type !== 'base64' || typeof src.data !== 'string' || !imgType(src.media_type)) return null;
  return Math.floor(src.data.length * 3 / 4) > IMG_INLINE_MAX ? null : src;
}
// as the page shows it: a link to GET /conversation/image (the bytes come once, and the browser keeps them), or
// { omitted: true } when it is too big or not a picture type. Polls re-send recent items; images stay out of them.
const imageOf = (id, key) => (b, n) => (imageBlock(b)
  ? { src: `/conversation/image?id=${encodeURIComponent(id)}&key=${encodeURIComponent(key)}&n=${n}` }
  : { omitted: true });
// a slash command a user record ran ("<command-name>/model</command-name> … <command-args>x</command-args>"),
// as "/model x"; null when it isn't one
function commandOf(text) {
  const m = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (!m) return null;
  const name = m[1].trim(), a = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
  const args = a ? a[1].trim() : '';
  return ((name.startsWith('/') ? name : '/' + name) + (args ? ' ' + args : '')).trim();
}
// a background task's <summary> is escaped like XML ("cd x &amp;&amp; npm test")
const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const unescapeXml = (s) => s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e) => XML_ENT[e]);
// a tool result's text: its string, or its blocks' text with images as "[image]"
function resultText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((b) => {
      if (!b || typeof b !== 'object') return '';
      if (b.type === 'text') return String(b.text || '');
      if (b.type === 'image') return '[image]';
      if (b.title && b.url) return `${b.title} ${b.url}`; // web search results
      return b.type ? `[${b.type}]` : '';
    }).filter(Boolean).join('\n');
  }
  if (c && typeof c === 'object') return c.error_code ? `[error: ${c.error_code}]` : '';
  return '';
}

// ---------- the index ----------
// log: { file, ino, birth, pos (bytes read), lineStart (where the unfinished last line starts), pieces (its
// bytes so far), items, keys, pending (tool id -> its item, until its result comes), live (the first read is
// done), used, busy (the read in progress) }
// item: { kind, key, t, refs: [[offset, length, block]] } (the lines it is built from), and for a tool its
// id and res ([offset, length] of the line with its result, null while pending); a note keeps its text
const logs = new Map(); // file -> log

const QUEUED = -2; // a user item's block number when its line is a queued_command attachment
// a user item's content: the message's, or the queued prompt's
const userContent = (d, ref) => (!d ? null : ref[2] === QUEUED ? d.attachment && d.attachment.prompt : d.message && d.message.content);
function add(L, it) {
  if (L.keys.has(it.key)) return null; // the same record twice (a log that repeats part of itself)
  L.keys.add(it.key);
  L.items.push(it);
  return it;
}
function addNote(L, key, t, text) {
  text = String(text || '').trim();
  return text ? add(L, { kind: 'note', key, t, text: capStr(text) }) : null;
}
// ---------- background tasks ----------
const BG_TOOLS = /^(?:Bash|PowerShell|Agent|Task|Workflow|Monitor)$/;
const BG_MAX_MS = 24 * 3600e3; // one still "running" after a day lost its notice: not shown
const firstLineOf = (v) => (typeof v === 'string' ? v.trim().split(/\r?\n/)[0].slice(0, 160) : '');
// a tool call that may start a background task (or stop one): what to call it, until its result says
function bgUse(L, b) {
  const i = b.input && typeof b.input === 'object' ? b.input : {};
  if (b.name === 'TaskStop' || b.name === 'KillShell') {
    const tid = i.task_id || i.shell_id;
    if (typeof tid === 'string') L.bgUse.set(b.id, { stop: tid });
    return;
  }
  if (!BG_TOOLS.test(String(b.name || ''))) return;
  const kind = /^(?:Agent|Task)$/.test(b.name) ? 'agent' : b.name === 'Workflow' ? 'workflow' : b.name === 'Monitor' ? 'monitor' : 'shell';
  const label = firstLineOf(i.description) || firstLineOf(i.name) || firstLineOf(i.command) || firstLineOf(i.prompt) || b.name;
  L.bgUse.set(b.id, { kind, label, detail: kind === 'agent' ? firstLineOf(i.subagent_type) : kind === 'shell' ? firstLineOf(i.command) : '' });
}
// its result: a task id when it went to the background
function bgResult(L, toolId, d) {
  const u = L.bgUse.get(toolId);
  if (!u) return;
  L.bgUse.delete(toolId);
  if (u.stop) { L.bg.delete(u.stop); return; }
  const r = d && d.toolUseResult;
  if (!r || typeof r !== 'object') return;
  const tid = r.backgroundTaskId || (r.status === 'async_launched' || u.kind === 'monitor' ? r.taskId || r.agentId : null);
  if (typeof tid !== 'string' || !tid) return;
  const t = timeOf(d.timestamp) || Date.now();
  L.bg.set(tid, {
    id: tid, kind: u.kind, t,
    label: (u.kind === 'workflow' && firstLineOf(r.summary)) || u.label,
    detail: u.kind === 'workflow' ? firstLineOf(r.workflowName) : u.detail,
    until: u.kind === 'monitor' && !r.persistent && Number.isFinite(r.timeoutMs) ? t + r.timeoutMs : 0,
  });
}
// a <task-notification>: the tasks it names end when it has a status (a monitor's events have none)
function bgNotice(L, text) {
  const st = /<status>([^<]*)<\/status>/.exec(text);
  if (!st || st[1].trim() === 'running') return;
  for (const m of text.matchAll(/<task-id>([^<]*)<\/task-id>/g)) L.bg.delete(m[1].trim());
}
// what the page shows: the tasks still running, oldest first
function bgList(L) {
  const now = Date.now();
  return [...L.bg.values()].filter((b) => now - b.t < BG_MAX_MS && (!b.until || now < b.until))
    .map(({ id, kind, label, detail, t }) => ({ id, kind, label, detail, t }));
}

function toolResult(L, id, off, len, d) {
  bgResult(L, id, d);
  const it = L.pending.get(id);
  if (!it) return;
  it.res = [off, len];
  if (L.live) it.changed = Date.now();
  L.pending.delete(id);
}

// one record of the log: what it adds to the chat
function ingest(L, d, off, len) {
  if (!d || typeof d !== 'object' || Array.isArray(d) || d.isSidechain) return;
  if (d.type === 'queue-operation') { queueOp(L, d); return; }
  // a prompt whose parent comes before an earlier prompt: a rewind went back there, so what followed goes
  if (d.type === 'user' && !d.isMeta && isPrompt(d) && typeof d.parentUuid === 'string' && L.at.has(d.parentUuid)) {
    const n = L.at.get(d.parentUuid);
    if (n < L.items.length && L.items.slice(n).some((it) => it.kind === 'user')) cutTo(L, n);
  }
  try { ingestRecord(L, d, off, len); } finally { if (typeof d.uuid === 'string') L.at.set(d.uuid, L.items.length); }
}
// a typed prompt, not a tool's result
const isPrompt = (d) => { const c = d.message && d.message.content; return typeof c === 'string' || (Array.isArray(c) && !c.some((b) => b && b.type === 'tool_result')); };
// drop the items from n on (a rewind's abandoned branch)
function cutTo(L, n) {
  for (const it of L.items.splice(n)) {
    L.keys.delete(it.key);
    if (it.kind === 'tool') L.pending.delete(it.id);
  }
  for (const [u, k] of L.at) if (k > n) L.at.delete(u);
  L.cut++;
}
// the queue of messages typed while Claude works
function queueOp(L, d) {
  const text = typeof d.content === 'string' ? d.content : '';
  if (d.operation === 'enqueue') { L.queue.push(text); return; }
  if (!/^(?:popAll|remove|dequeue)$/.test(String(d.operation))) return;
  const i = L.queue.indexOf(text);
  if (i >= 0) L.queue.splice(i, 1);
  else if (d.operation === 'dequeue') L.queue.shift();
}
function ingestRecord(L, d, off, len) {
  const t = timeOf(d.timestamp);
  const uid = typeof d.uuid === 'string' ? d.uuid : 'o' + off;
  const last = L.items[L.items.length - 1];
  if (d.type === 'system') {
    if (d.subtype !== 'api_error') return;
    const e = d.error || {};
    const text = `API error: ${e.formatted || e.message || 'unknown'}` + (d.retryAttempt ? ` (retry ${d.retryAttempt} of ${d.maxRetries || '?'})` : '');
    // retries come one after another: one note that shows the latest
    if (last && last.kind === 'note' && last.apiRetry) { last.text = capStr(text); last.t = t; last.changed = Date.now(); return; }
    const n = addNote(L, 'n:' + uid, t, text);
    if (n) n.apiRetry = true;
    return;
  }
  // a message typed while Claude was mid-turn: Claude Code logs it only as this attachment, when it reads it
  if (d.type === 'attachment') {
    const a = d.attachment;
    if (!a || a.type !== 'queued_command') return;
    if (typeof a.prompt === 'string' && a.prompt.startsWith('<task-notification>')) { bgNotice(L, a.prompt); return; }
    if (a.commandMode && a.commandMode !== 'prompt') return;
    const u = userView(a.prompt);
    if (!u.text && !u.images.length) return;
    if (/^<cross-session-message[\s>]/.test(u.text)) return; // another session's message, not yours
    add(L, { kind: 'user', key: 'u:' + uid, t, refs: [[off, len, QUEUED]] });
    return;
  }
  const m = d.message;
  if (!m || typeof m !== 'object') return;
  const c = m.content;
  if (d.type === 'assistant') {
    if (d.isApiErrorMessage) { addNote(L, 'n:' + uid, t, userView(c).text); return; }
    if (!Array.isArray(c)) return;
    const mid = typeof m.id === 'string' ? m.id : uid;
    c.forEach((b, i) => {
      if (!b || typeof b !== 'object') return;
      if (b.type === 'text') {
        if (typeof b.text !== 'string' || !b.text.trim()) return;
        // Claude Code writes each block of a reply as its own line: text blocks of one message, one after
        // another, are one chat item
        const prev = L.items[L.items.length - 1];
        if (prev && prev.kind === 'assistant' && prev.mid === mid) { prev.refs.push([off, len, i]); if (L.live) prev.changed = Date.now(); return; }
        add(L, { kind: 'assistant', key: `a:${uid}:${i}`, t, mid, refs: [[off, len, i]] });
      } else if (b.type === 'thinking') {
        if (typeof b.thinking === 'string' && b.thinking.trim()) add(L, { kind: 'thinking', key: `th:${uid}:${i}`, t, refs: [[off, len, i]] });
      } else if ((b.type === 'tool_use' || b.type === 'server_tool_use') && typeof b.id === 'string') {
        const it = add(L, { kind: 'tool', key: 't:' + b.id, t, id: b.id, refs: [[off, len, i]], res: null });
        if (it) { L.pending.set(b.id, it); bgUse(L, b); }
      } else if (typeof b.type === 'string' && b.type.endsWith('_tool_result') && typeof b.tool_use_id === 'string') {
        toolResult(L, b.tool_use_id, off, len, null); // a server tool's result (web search) comes in the same message
      }
    });
    return;
  }
  if (d.type !== 'user') return;
  if (Array.isArray(c)) for (const b of c) if (b && b.type === 'tool_result' && typeof b.tool_use_id === 'string') toolResult(L, b.tool_use_id, off, len, d);
  if (d.isMeta) return;
  if (d.isCompactSummary) { addNote(L, 'n:' + uid, t, 'Conversation compacted\n\n' + userView(c).text); return; }
  const u = userView(c);
  if (!u.text && !u.images.length) return; // only tool results, or only wrappers
  // what a slash command printed ("Set model to Opus 5.5"): a note under the command; nothing when it printed nothing
  const out = /^<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/.exec(u.text);
  if (out) {
    const text = out[2].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
    if (text) addNote(L, 'n:' + uid, t, text);
    return;
  }
  if (/^<local-command-std(?:out|err)>/.test(u.text)) return;
  const cmd = commandOf(u.text);
  if (cmd) { addNote(L, 'n:' + uid, t, cmd); return; }
  if (/^\[Request interrupted by user[^\]]*\]$/.test(u.text)) { addNote(L, 'n:' + uid, t, u.text); return; }
  if (/^<task-notification>/.test(u.text)) {
    bgNotice(L, u.text);
    const s = /<summary>([\s\S]*?)<\/summary>/.exec(u.text);
    addNote(L, 'n:' + uid, t, s ? unescapeXml(s[1]) : 'background task update');
    return;
  }
  add(L, { kind: 'user', key: 'u:' + uid, t, refs: [[off, len, -1]] });
}

// one line of the log (its bytes, and where it is in the file)
function line(L, buf, off) {
  // records that are never chat (titles, file snapshots, modes, costs...) start with their type: skip them unread
  const head = buf.toString('latin1', 0, Math.min(buf.length, 24));
  if (head.startsWith('{"type":"') && !/^\{"type":"(?:user|assistant|system|attachment|queue-operation)"/.test(head)) return;
  let d;
  try { d = JSON.parse(buf.toString('utf8')); } catch { return; }
  try { ingest(L, d, off, buf.length); } catch {}
}

// read what the log has past L.pos, in chunks, a line at a time
async function readMore(L) {
  const fh = await fs.promises.open(L.file, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const { bytesRead: n } = await fh.read(buf, 0, CHUNK, L.pos);
      if (!n) break;
      const chunk = buf.subarray(0, n);
      let s = 0;
      for (let nl = chunk.indexOf(10, 0); nl >= 0; nl = chunk.indexOf(10, s)) {
        const part = chunk.subarray(s, nl);
        const whole = L.pieces.length ? Buffer.concat([...L.pieces, part]) : part;
        if (whole.length) line(L, whole, L.lineStart);
        L.pieces = [];
        L.lineStart = L.pos + nl + 1;
        s = nl + 1;
      }
      if (s < n) L.pieces.push(Buffer.from(chunk.subarray(s))); // copied: buf is read into again
      L.pos += n;
      if (n < CHUNK) break;
      await new Promise((r) => setImmediate(r));
    }
  } finally { await fh.close(); }
  L.live = true;
}

// the log's index, brought up to date with the file
async function load(file) {
  const st = await fs.promises.stat(file);
  let L = logs.get(file);
  // another file at the same path, or one that shrank: read it again
  if (L && (L.ino !== st.ino || L.birth !== st.birthtimeMs || st.size < L.pos)) L = null;
  if (!L) {
    L = { file, ino: st.ino, birth: st.birthtimeMs, pos: 0, lineStart: 0, pieces: [], items: [], keys: new Set(), pending: new Map(), at: new Map(), cut: 0, queue: [], bg: new Map(), bgUse: new Map(), live: false, used: 0, busy: null };
    logs.set(file, L);
  }
  L.used = Date.now();
  if (logs.size > MAX_LOGS) {
    const old = [...logs.values()].filter((x) => x !== L && !x.busy).sort((a, b) => a.used - b.used);
    for (const x of old.slice(0, logs.size - MAX_LOGS)) logs.delete(x.file);
  }
  if (st.size > L.pos && !L.busy) L.busy = readMore(L).finally(() => { L.busy = null; });
  if (L.busy) await L.busy;
  return L;
}

// ---------- building items for the reply ----------
// reads the lines a reply needs, each once
function lineReader(file) {
  let fd = null;
  const seen = new Map();
  return {
    get(off, len) {
      if (seen.has(off)) return seen.get(off);
      let d = null;
      try {
        if (fd === null) fd = fs.openSync(file, 'r');
        const b = Buffer.allocUnsafe(len);
        fs.readSync(fd, b, 0, len, off);
        d = JSON.parse(b.toString('utf8'));
      } catch {}
      seen.set(off, d);
      return d;
    },
    close() { if (fd !== null) try { fs.closeSync(fd); } catch {} },
  };
}
const blockOf = (d, i) => { const c = d && d.message && d.message.content; return Array.isArray(c) && c[i] && typeof c[i] === 'object' ? c[i] : null; };

function build(it, rd, id) {
  const base = { kind: it.kind, key: it.key, t: it.t };
  if (it.kind === 'note') return { ...base, text: it.text };
  if (it.kind === 'assistant') return { ...base, text: it.refs.map(([o, n, i]) => (blockOf(rd.get(o, n), i) || {}).text || '').filter(Boolean).join('\n\n') };
  if (it.kind === 'thinking') { const [o, n, i] = it.refs[0]; return { ...base, text: String((blockOf(rd.get(o, n), i) || {}).thinking || '') }; }
  if (it.kind === 'user') {
    const [o, n] = it.refs[0], d = rd.get(o, n);
    const u = userView(userContent(d, it.refs[0]));
    return { ...base, text: u.text, images: u.images.map(imageOf(id, it.key)) };
  }
  // tool
  const [o, n, i] = it.refs[0], b = blockOf(rd.get(o, n), i) || {};
  let result = null;
  if (it.res) {
    const d = rd.get(it.res[0], it.res[1]), c = d && d.message && d.message.content;
    const r = Array.isArray(c) ? c.find((x) => x && x.tool_use_id === it.id) : null;
    result = r ? { text: capStr(resultText(r.content)), isError: r.is_error === true } : { text: '', isError: false };
  }
  return { ...base, id: it.id, name: String(b.name || ''), input: capDeep(b.input && typeof b.input === 'object' ? b.input : {}), result };
}

// ---------- GET /conversation?id=<id>[&since=<n>][&before=<k>&limit=<m>] ----------
// ctx: { sendJson, find(id) -> { file } | { demo: true } | null, fail(e) }
async function conversation(req, res, ctx) {
  const q = new URL(req.url, 'http://x').searchParams;
  const id = q.get('id') || '';
  const where = ctx.find(id);
  if (!where) return ctx.sendJson(res, 404, { error: 'no such conversation' });
  if (where.demo) {
    // --demo has no logs: the page's sample conversation when there is one, else nothing
    let out = { id, total: 0, from: 0, items: [] };
    try { const j = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')); if (j && Array.isArray(j.items)) out = { ...j, id }; } catch {}
    return ctx.sendJson(res, 200, out);
  }
  let L;
  try { L = await load(where.file); } catch { return ctx.sendJson(res, 404, { error: 'its log is gone' }); }
  const total = L.items.length;
  let from, to = total;
  if (q.has('before')) {
    to = intArg(q.get('before'), 0, total, total);
    from = Math.max(0, to - intArg(q.get('limit'), 1, LIMIT_MAX, PAGE));
  } else if (q.has('since')) {
    const n = intArg(q.get('since'), 0, total, total);
    from = Math.max(0, n - RESEND, total - SINCE_MAX);
    // a tool result that arrived for an item before that (parallel tool calls, a long agent): go back to it
    const now = Date.now();
    for (let i = from - 1; i >= Math.max(0, from - LOOKBACK, total - SINCE_MAX); i--) if (now - (L.items[i].changed || 0) < RECENT_MS) from = i;
  } else from = Math.max(0, total - PAGE);
  const rd = lineReader(L.file);
  let items;
  try { items = L.items.slice(from, to).map((it) => build(it, rd, id)); } finally { rd.close(); }
  const live = !!(ctx.live && ctx.live(id));
  ctx.sendJson(res, 200, { id, total, from, items, bg: live ? bgList(L) : [], queue: live ? L.queue.slice(0, 50) : [], cut: L.cut });
}

// ---------- the automation API's transcript (api.js GET /api/sessions/:id/transcript) ----------
// The same items, compact, for a script or another Claude to read: { total, from, items: [{ i, type, t, text?,
// tool? }] }, type 'user' | 'assistant' | 'tool' | 'note' | 'thinking'. Text is cut to 4000 characters; a tool
// gives its name, its input as one line (300) and its result (2000, null while it runs). Default the last 50
// items; since=n gives the items from n on; limit at most 500.
const T_TEXT = 4000, T_INPUT = 300, T_RESULT = 2000, T_DEFAULT = 50, T_MAX = 500;
const cut = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// a tool's input as one line: the field that says what it does (a command, a file, a pattern...), else its JSON
const INPUT_KEYS = ['command', 'pattern', 'file_path', 'path', 'url', 'query', 'description', 'prompt', 'skill', 'notebook_path', 'task_id'];
function inputLine(input) {
  const i = input && typeof input === 'object' ? input : {};
  const parts = [];
  for (const k of INPUT_KEYS) if (typeof i[k] === 'string' && i[k].trim() && parts.push(oneLine(i[k])) >= 2) break;
  let s = parts.join(' · ');
  if (!s) { try { s = oneLine(JSON.stringify(i)); } catch { s = ''; } }
  return cut(s, T_INPUT);
}
async function transcriptOf(file, o = {}) {
  const L = await load(file);
  const total = L.items.length;
  const limit = intArg(o.limit, 1, T_MAX, T_DEFAULT);
  const from = o.since != null && o.since !== '' ? intArg(o.since, 0, total, total) : Math.max(0, total - limit);
  const to = Math.min(total, from + limit);
  const rd = lineReader(L.file);
  const items = [];
  try {
    for (let i = from; i < to; i++) {
      const b = build(L.items[i], rd, '');
      const it = { i, type: b.kind, t: b.t || null };
      if (b.kind === 'tool') {
        it.tool = { name: b.name, input: inputLine(b.input), result: b.result ? cut(b.result.text, T_RESULT) : null, isError: !!(b.result && b.result.isError) };
      } else {
        let text = b.text || '';
        if (b.images && b.images.length) text = `${text}${text ? ' ' : ''}[${b.images.length} image${b.images.length > 1 ? 's' : ''}]`;
        it.text = cut(text, T_TEXT);
      }
      items.push(it);
    }
  } finally { rd.close(); }
  return { total, from, items };
}

// ---------- GET /conversation/image?id=<id>&key=<item key>&n=<i> ----------
// one image of a prompt, as bytes (its link in the user item above)
async function conversationImage(req, res, ctx) {
  const q = new URL(req.url, 'http://x').searchParams;
  const id = q.get('id') || '', key = q.get('key') || '', n = intArg(q.get('n'), 0, 99, -1);
  const where = ctx.find(id);
  const miss = () => ctx.sendJson(res, 404, { error: 'no such image' });
  if (!where || where.demo || n < 0) return miss();
  let L;
  try { L = await load(where.file); } catch { return miss(); }
  const it = L.items.find((x) => x.key === key && x.kind === 'user');
  if (!it) return miss();
  const rd = lineReader(L.file);
  let src = null;
  try { const d = rd.get(it.refs[0][0], it.refs[0][1]); src = imageBlock(userView(userContent(d, it.refs[0])).images[n]); } finally { rd.close(); }
  if (!src) return miss();
  const bytes = Buffer.from(src.data, 'base64');
  res.writeHead(200, { 'Content-Type': src.media_type, 'Content-Length': bytes.length, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}

// ---------- POST /chat/image { data: <base64>, mime } ----------
// The compose box's attachment, saved where Claude Code can read it (the prompt then names the file):
// %LOCALAPPDATA%\fleet-view\chat-images\<16 hex>.<ext>. The bytes must start like the type they claim and be
// at most 15 MB. Files there older than a week are deleted on each save (only names this code makes).
const MAGIC = {
  'image/png': (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a,
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.length > 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6)),
  'image/webp': (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
};
function pruneImages() {
  const now = Date.now();
  let names = [];
  try { names = fs.readdirSync(IMG_DIR); } catch { return; }
  for (const f of names) {
    if (!IMG_NAME.test(f)) continue;
    const p = path.join(IMG_DIR, f);
    try { if (now - fs.statSync(p).mtimeMs > IMG_KEEP_MS) fs.unlinkSync(p); } catch {}
  }
}
function saveImage(req, res, ctx) {
  const parts = [];
  let size = 0, tooBig = false, done = false;
  const reply = (code, obj) => { if (!done) { done = true; ctx.sendJson(res, code, obj); } };
  req.on('data', (b) => {
    if (tooBig) return;
    size += b.length;
    if (size <= BODY_MAX) return void parts.push(b);
    // too big: answer now and stop reading (the rest is dropped, not buffered)
    tooBig = true; parts.length = 0;
    reply(413, { error: 'the image is bigger than 15 MB' });
    req.resume();
  });
  req.on('error', () => reply(400, { error: 'the upload broke off' }));
  req.on('end', () => {
    if (tooBig) return;
    let j = null;
    try { j = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch {}
    parts.length = 0;
    const mime = j && j.mime, ext = imgType(mime) ? IMG_TYPES[mime] : null;
    if (!ext || typeof j.data !== 'string') return reply(400, { error: 'send { data: <base64>, mime: image/png, jpeg, gif or webp }' });
    const b64 = j.data.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return reply(400, { error: 'data is not base64' });
    const bytes = Buffer.from(b64, 'base64');
    if (!bytes.length) return reply(400, { error: 'the image is empty' });
    if (bytes.length > IMG_SAVE_MAX) return reply(400, { error: 'the image is bigger than 15 MB' });
    if (!MAGIC[mime](bytes)) return reply(400, { error: `that is not a ${mime.slice(6).toUpperCase()} image` });
    const file = path.join(IMG_DIR, crypto.randomBytes(8).toString('hex') + '.' + ext);
    try {
      fs.mkdirSync(IMG_DIR, { recursive: true });
      pruneImages();
      fs.writeFileSync(file, bytes, { flag: 'wx' });
    } catch (e) {
      if (ctx.log) ctx.log(`chat image: could not save ${file}: ${e.message}`);
      return reply(500, { error: 'could not save the image' });
    }
    reply(200, { path: file });
  });
}

module.exports = { conversation, conversationImage, saveImage, transcriptOf, _test: { load, build, lineReader, logs, bgList } };
