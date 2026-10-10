// Fork from one of your messages (Fork on a message in the chat feed, chat.js; app.js starts the fork).
//
// The fork starts as a copy of the whole conversation (claude --resume <id> --fork-session, host.js create). Then,
// inside the fork, this types /rewind, moves up its list to that message and presses Enter, and on Claude Code's
// confirm menu picks "Restore conversation" (never the code: the fork works in the same folder as the original, so
// restoring code would undo the original's edits too). The fork then holds the history from before that message,
// and the original is untouched. What the restore puts back in the fork's prompt is cleared there, and the message
// goes to the fork's chat box instead (handto.js), to edit and send.
// Claude Code's own --resume-session-at would cut the history at start, but it only works in print mode (checked on
// 2.1.296: an interactive fork with it kept everything), so the fork goes back the way a person would.
//
// forkAt(key, text, nth) -> Promise<{ ok, message }>. key: the fork's host key (new-<n>; followed to its id when the
// host re-keys it), text: the message as the feed shows it, nth: which of the messages with that text, counted
// from the newest (the /rewind list has the newest at the bottom).
import { termApi, hosts, screenMarked, screenReady, screenText, typeInto, growRows, onRekey } from './term.js';
import { parsePromptBox, parseRewind, rewindMatches, parseMenu, parseSpinner } from './compose.js';
import { handToChat } from './handto.js';

const READY_MS = 1500; // its prompt shows, empty and idle, this long before /rewind goes in
const START_MAX_MS = 3 * 60e3; // a fork waiting longer than this (a trust dialog no one answers) is left as it is
const REWIND_ROWS = 24; // /rewind's list needs about this many rows (compose.js)
const ENTER_DELAY_MS = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jobs = new Set(); // the forks going back now: { key, ... }, key follows the re-key
onRekey((oldKey, id) => { for (const j of jobs) if (j.key === oldKey) j.key = id; });

export async function forkAt(key, text, nth = 0) {
  const j = { key, text: String(text || ''), nth: Math.max(0, nth | 0) };
  jobs.add(j);
  try { return await run(j); } catch (e) { return { ok: false, message: String(e?.message || e) }; } finally { jobs.delete(j); }
}

async function run(j) {
  const alive = () => !!hosts.get(j.key)?.alive;
  const rows = (n = 60) => (alive() ? screenMarked(j.key, n).map((l) => l.replace(/[\x01\x02]/g, '')) : []);
  const menu = () => (alive() ? parseMenu(screenText(j.key, 40, { rows: true })) : null);
  const write = (d) => {
    const t = termApi();
    if (!t || !alive()) return false;
    try { t.write(j.key, d); return true; } catch { return false; }
  };
  const gone = { ok: false, message: 'the fork ended before it went back to your message' };

  // 1. up: its screen read, the prompt empty, no menu (a trust question waits for you), nothing running
  let since = 0;
  for (const end = Date.now() + START_MAX_MS; ; await sleep(300)) {
    if (!alive()) return gone;
    if (Date.now() > end) return { ok: false, message: 'the fork was not ready to go back within 3 minutes' };
    screenText(j.key, 40); // the first look builds its off-screen view
    const L = rows();
    const ready = screenReady(j.key) && L.length > 0 && !menu() && parsePromptBox(L)?.text === '' && !parseSpinner(L.slice(-40))?.strong;
    if (!ready) since = 0;
    else if (!since) since = Date.now();
    else if (Date.now() - since >= READY_MS) break;
  }

  // 2. /rewind, up its list to the message (the nth of that text from the newest), Enter
  if (growRows(j.key, REWIND_ROWS)) await sleep(600);
  if ((await typeInto(write, '/rewind')) === false) return gone;
  await sleep(ENTER_DELAY_MS);
  write('\r');
  let r = null;
  for (let i = 0; i < 20 && !r; i++) { await sleep(150); r = parseRewind(rows(80)); }
  if (!r) return { ok: false, message: '/rewind didn\'t open its list in the fork' };
  let seen = 0, last = r.sig, picked = false;
  for (let i = 0; i < 500 && !picked; i++) {
    if (!write('\x1b[A')) return gone;
    let n = null;
    for (let k = 0; k < 8; k++) { await sleep(60); n = parseRewind(rows(80)); if (!n || n.sig !== last) break; }
    if (!n) return { ok: false, message: 'the /rewind list closed in the fork' };
    if (n.sig === last) break; // the top, and it wasn't there
    last = n.sig;
    if (rewindMatches(n.sel, j.text) && seen++ === j.nth) { write('\r'); picked = true; }
  }
  if (!picked) { write('\x1b'); return { ok: false, message: 'that message isn\'t in the fork\'s /rewind list' }; }

  // 3. the confirm menu: "Restore conversation" (not "Restore code and conversation", its default when files changed)
  let opt = null;
  for (let i = 0; i < 40 && !opt; i++) {
    await sleep(150);
    opt = (menu()?.options || []).find((o) => /^Restore conversation$/i.test(String(o.label || '').trim())) || null;
  }
  if (!opt) { write('\x1b'); return { ok: false, message: 'Claude Code didn\'t offer to restore the conversation' }; }
  write(String(opt.n));

  // 4. the restore puts the message back in its prompt: cleared there, it goes to the fork's chat box
  let box = null;
  for (let i = 0; i < 40; i++) { await sleep(200); if (!alive()) return gone; box = menu() ? null : parsePromptBox(rows()); if (box && box.text) break; }
  for (let i = 0; i < 40 && box && box.text; i++) {
    if (!write('\x15'.repeat(Math.min(box.lines + 1, 30)))) break;
    await sleep(120);
    box = parsePromptBox(rows());
  }
  handToChat(j.key, { text: j.text });
  return { ok: true, message: 'went back to just before your message' };
}
