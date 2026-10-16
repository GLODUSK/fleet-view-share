// forks.js: telling a fork from its log, and the name it shows (Fleet View #552).
// A fork (claude --resume <id> --fork-session) is a new conversation whose log starts as a copy of its source's: the
// title lines (custom-title, agent-name, ai-title) are written again at its head with the fork's id, and every record
// copied after them keeps its source's id in session_id (sessionId is made the fork's). So the last record whose
// session_id is another conversation's names the conversation it was forked from (a fork of a fork carries both ids;
// the newest copied record is its own source's). That alone is no proof: session_id is the id the claude process
// started with, so a /clear successor's records all carry its predecessor's id too. A fork's copied records keep their
// uuids, so the first one's uuid is in the source's log as well (firstCopied, isCopied); a successor's are its own.
// Pure functions, for fleet-view.js and scripts/forks-test.js.
'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX = 'fork of ';

// one parsed record: the id of another conversation it was copied from (lowercase), or null
function recordSource(d, own) {
  const sid = d && typeof d === 'object' && typeof d.session_id === 'string' ? d.session_id.toLowerCase() : '';
  return sid && UUID_RE.test(sid) && sid !== String(own || '').toLowerCase() ? sid : null;
}

// the title lines at the start of a log, before its first message: { custom, agent, ai } (each the first of its kind)
function titlesIn(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    if (line.includes('"parentUuid"')) break;
    if (!line.startsWith('{"type":"')) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'custom-title' && typeof d.customTitle === 'string' && d.customTitle && !out.custom) out.custom = d.customTitle;
    else if (d.type === 'agent-name' && typeof d.agentName === 'string' && d.agentName && !out.agent) out.agent = d.agentName;
    else if (d.type === 'ai-title' && typeof d.aiTitle === 'string' && d.aiTitle && !out.ai) out.ai = d.aiTitle;
  }
  return out;
}

// the source's id from text (a part of a log, whole lines but maybe the last): the last record whose own session_id is
// another conversation's, or null. Only the lines holding such an id are parsed, last first, and an id inside a
// record's content (a tool's output) doesn't count: the parsed record's own field must say it.
function sourceIn(text, own) {
  text = String(text || '');
  own = String(own || '').toLowerCase();
  const hits = [...text.matchAll(/"session_id":"([0-9a-fA-F-]{36})"/g)].filter((m) => m[1].toLowerCase() !== own);
  for (let i = hits.length - 1; i >= 0; i--) {
    const at = hits[i].index, a = text.lastIndexOf('\n', at) + 1, b = text.indexOf('\n', at);
    if (b < 0) continue; // the read stopped inside this line
    let d;
    try { d = JSON.parse(text.slice(a, b)); } catch { continue; }
    const sid = recordSource(d, own);
    if (sid) return sid;
  }
  return null;
}

// The first record in text (a log's head) whose own session_id is another conversation's and that has a uuid:
// { from, uuid }, or null. A foreign session_id alone is no proof of a fork: session_id is the id the claude process
// started with, which /clear (and a "continue from where you left off") keeps, so every record of such a successor
// carries its predecessor's id. A fork's copied records keep their uuids, so this one's uuid is in its source's log
// too (copied, isCopied); a successor's records are new ones, found nowhere else.
function firstCopied(text, own) {
  text = String(text || '');
  own = String(own || '').toLowerCase();
  for (const m of text.matchAll(/"session_id":"([0-9a-fA-F-]{36})"/g)) {
    if (m[1].toLowerCase() === own) continue;
    const a = text.lastIndexOf('\n', m.index) + 1, b = text.indexOf('\n', m.index);
    if (b < 0) break; // the read stopped inside this line
    let d;
    try { d = JSON.parse(text.slice(a, b)); } catch { continue; }
    const from = recordSource(d, own);
    if (from && typeof d.uuid === 'string' && d.uuid) return { from, uuid: d.uuid };
  }
  return null;
}
// whether a source's log text (its head) holds the record with this uuid: the fork's copy came from it
const isCopied = (sourceText, uuid) => typeof uuid === 'string' && !!uuid && String(sourceText || '').includes(`"uuid":${JSON.stringify(uuid)}`);

// a fork's own name, or '' while it still goes by the one it was copied with. o: { renamed (its Fleet View name: always
// its own), remote (the name the device running it shows), custom (its /rename or agent name), ai (Claude Code's
// title) }; inherited: the names it was copied with and its source's (a name in there is not its own, nor one that
// already reads "fork of …", as another device shows an unnamed fork)
function ownName(o, inherited) {
  if (o && typeof o.renamed === 'string' && o.renamed) return o.renamed;
  const had = new Set((inherited || []).filter((x) => typeof x === 'string' && x));
  const mine = (x) => typeof x === 'string' && !!x && !had.has(x) && !x.startsWith(PREFIX);
  return [o && o.remote, o && o.custom, o && o.ai].find(mine) || '';
}

// what a fork shows: its own name, else "fork of <source>"
const label = (own, sourceName) => own || `${PREFIX}${sourceName}`;

module.exports = { UUID_RE, PREFIX, recordSource, titlesIn, sourceIn, firstCopied, isCopied, ownName, label };
