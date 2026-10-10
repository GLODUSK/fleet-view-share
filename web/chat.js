// Chat tab: a live Claude Code conversation shown as a chat, read from its transcript through the server
// (GET /conversation, see fleet-view.js), with the compose box (compose.js) underneath. The compose box types
// into the same live session the Session tab runs; this file only shows the conversation.
//
// detail.js calls renderChatPane(pane, s, opts) about once a second while the tab shows. The first call builds
// the pane (a feed, and a slot for the compose box); every call is cheap. While the tab shows, the feed asks the
// server for what changed every second (?since=<total>, which re-sends the last few items so tool results and
// growing replies update) and re-renders only the items whose JSON changed. It stops asking when the calls stop.
//
// Rendering: your messages are bubbles on the right; Claude's replies are markdown (marked, then DOMPurify, raw
// HTML shown as text, only http/https/mailto links), code blocks as cards with a language label and Copy,
// highlighted (highlight.js) when they scroll near the view; thinking is one collapsed violet row; every tool
// call is one compact row that opens to show what it did (a red/green diff for edits, a checklist for todos).
// The work between two messages (the thinking and tool rows in a row) folds into one quiet line, "Ran 3 commands,
// read 2 files", that opens to show those rows; while a step runs, the line says which. Todo lists, plans and
// questions stay out in the open.
// Selecting text shows a Reply button that hands the text to the compose box (the 'fv-chat-quote' event).
// A "/pickup <file>" note has a file icon that opens that handoff summary (in the viewer, viewer.js).
// Scrolled up past your last message, a bar at the top shows it; a click scrolls back to it.
// Above the compose box, a tray lists what the session runs in the background (shells, async agents, workflows,
// monitors: the reply's `bg`, see conversation.js), like the task list under a Claude Code terminal. Folded it is
// one line with a count; a click opens a row per task with how long it has run.
// A message you send shows at once ('fv-chat-sent' from compose.js) as a bubble marked "Sending" (or "Queued"
// while Claude is mid-turn, which writes it to the transcript only when it reads it); the transcript's own copy
// replaces it. A queued one has an Interrupt button: Claude stops the step it is on and takes your message now
// (compose.js presses Claude Code's own "send now" keys, which send every queued message at once). Unsend takes
// it back out of Claude Code's queue ('fv-chat-unsend': compose.js pulls the queue into the prompt, clears it,
// and queues the others again; the reply's `queue` says what is queued). Fork and New chat take it out the same way
// and hand it to a new conversation instead ('fv-chat-fork' on window, app.js): a fork of this one (its history) or
// a fresh one in its folder, which gets the message once it is up.
// A long message (yours, sent or shown) folds to a few lines behind "Show more", like Claude Code's pasted text.
// Rewind on one of your messages ('fv-chat-rewind') runs Claude Code's /rewind back to just before it; the
// conversation then drops what came after (the reply's `cut` changes, and the list loads again). Edit opens the
// message in place; its Send is a Rewind that then sends the edited text instead (the event's `edit`).
// File paths open in Fleet View's own viewer (viewer.js) instead of VS Code: the file on a Read, Edit, Write,
// MultiEdit or NotebookEdit row (and in its opened body), the paths a Grep or Glob printed, and inline code in a
// reply that looks like a path (`web/chat.js`, `chat.js:120`, `C:\x\y`: a known extension, an absolute path, or a
// folder with a trailing slash). Those are links at once; whether the file is there is asked only on the click (a
// toast says when it isn't). An edit opens at its new text, a Read at its first line. Ctrl+click (or Cmd+click) on
// any of them opens VS Code instead, as before.
// Expand all (the small toggle at the top right of the feed, or Ctrl+O anywhere in the Chat tab, like the
// terminal's transcript view): every folded line, tool row and thinking row opens; off again, each goes back to how it was.
// A "!" command (bash mode, see compose.js) shows as your message "! <command>"; what it printed as a block under it.
//
// ?fixture=1 reads ./fixtures/conversation-sample.json instead of the server (same JSON); with it,
// ?chatWindow=<n> shrinks the first page (to try "Show earlier") and ?chatRepeat=<n> repeats the sample n times
// (to time a long conversation).
import { esc, spinner, C, clockTime, ago } from './cards.js';
import { icon } from './icons.js';
import { mountCompose } from './compose.js';
import { onRekey } from './term.js';
import { openViewer, openInCode } from './viewer.js';

const params = (() => { try { return new URLSearchParams(location.search); } catch { return new URLSearchParams(); } })();
const FIXTURE = params.has('fixture');
const POLL_MS = 1000;
const STALE_MS = 3000; // no renderChatPane call for this long: the tab is hidden, stop asking
const EARLIER = 200; // items per "Show earlier"
const DIFF_CAP = 400; // diff lines shown per edit
const WRITE_LINES = 60; // lines of a Write shown before "Show all"
const LONG_USER = 400; // characters (or LONG_LINES lines) after which your message folds behind "Show more"
const LONG_LINES = 6;
const isLong = (text) => text.length > LONG_USER || lineCount(text) > LONG_LINES;
const moreBtn = (text) => `<button type="button" class="cu-more" data-more>${moreLabel(text)}</button>`;
const moreLabel = (text) => { const n = lineCount(text); return n > LONG_LINES ? `Show more · ${n} lines` : 'Show more'; };

// ---------- libraries: vendored, loaded the first time the tab shows ----------
const LANGS = ['typescript', 'javascript', 'json', 'bash', 'powershell', 'python', 'css', 'xml', 'diff', 'markdown', 'sql', 'yaml'];
// fence labels highlight.js doesn't know by itself
export const LANG_ALIAS = { shell: 'bash', console: 'bash', sh: 'bash', zsh: 'bash', ps: 'powershell', pwsh: 'powershell', ps1: 'powershell', cmd: 'powershell', jsonc: 'json', json5: 'json', node: 'javascript', mjs: 'javascript', cjs: 'javascript', html: 'xml', svg: 'xml', patch: 'diff', yml: 'yaml', md: 'markdown' };
let libsP = null;
function libs() {
  if (libsP) return libsP;
  libsP = (async () => {
    const [{ Marked }, { default: DOMPurify }, { default: hljs }] = await Promise.all([
      import('./vendor/marked/marked.esm.js'),
      import('./vendor/dompurify/purify.es.mjs'),
      import('./vendor/highlight/core.min.js'),
    ]);
    const grammars = await Promise.all(LANGS.map((l) => import(`./vendor/highlight/languages/${l}.min.js`).then((m) => [l, m.default])));
    for (const [l, g] of grammars) hljs.registerLanguage(l, g);
    const md = new Marked({ gfm: true, breaks: false, async: false });
    md.use({
      renderer: {
        // raw HTML in a reply is text: "<sessionId>" stays visible instead of vanishing as an unknown tag
        html: ({ text }) => esc(text),
        // no remote images in replies (nothing loads from the internet by itself); a link to it instead
        image: ({ href, text }) => (/^https?:\/\//i.test(href || '') ? `<a href="${esc(href)}">${esc(text || href)}</a>` : esc(text || '')),
        code: ({ text, lang, escaped }) => {
          const l = String(lang || '').trim().split(/\s+/)[0].toLowerCase();
          return `<pre><code data-lang="${esc(l)}">${escaped ? text : esc(text)}</code></pre>\n`;
        },
      },
    });
    return { md, DOMPurify, hljs };
  })();
  libsP.catch(() => { libsP = null; }); // a failed load is tried again on the next call
  return libsP;
}
// highlight.js with the grammars above (the file viewer, viewer.js, highlights with it too)
export const highlighter = () => libs().then((L) => L.hljs);

const PURIFY = {
  ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'del', 's', 'code', 'pre',
    'blockquote', 'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input', 'span'],
  ALLOWED_ATTR: ['href', 'title', 'align', 'start', 'type', 'checked', 'disabled', 'data-lang'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  ALLOW_DATA_ATTR: false, // the page acts on [data-act] clicks: no data-* from a reply, ever (data-lang is listed above)
  // DOMPurify checks every other attribute's value against the URI rule too; these are plain words
  ADD_URI_SAFE_ATTR: ['type', 'align', 'start'],
  RETURN_DOM_FRAGMENT: true,
};

// markdown to a safe fragment: marked, DOMPurify, then links open outside, tables scroll, code blocks become cards
function mdFragment(L, text, c) {
  const frag = L.DOMPurify.sanitize(L.md.parse(String(text || '')), PURIFY);
  for (const a of frag.querySelectorAll('a')) {
    if (a.hasAttribute('href')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; if (!a.title) a.title = a.getAttribute('href'); }
  }
  for (const inp of frag.querySelectorAll('input')) {
    if (inp.getAttribute('type') !== 'checkbox') inp.remove(); else { inp.disabled = true; inp.tabIndex = -1; }
  }
  for (const t of frag.querySelectorAll('table')) {
    const w = document.createElement('div');
    w.className = 'cm-table';
    t.replaceWith(w);
    w.appendChild(t);
  }
  // inline code that names a file: a link to the viewer (added after DOMPurify, which keeps no data-* of a reply's)
  for (const code of frag.querySelectorAll('code')) {
    if (code.closest('pre')) continue;
    const ref = pathRef(code.textContent);
    if (!ref) continue;
    code.classList.add('fpath');
    code.dataset.fpath = ref.path;
    if (ref.line) code.dataset.fline = String(ref.line);
    code.tabIndex = 0;
    code.setAttribute('role', 'link');
    code.title = PATH_TIP;
  }
  for (const pre of frag.querySelectorAll('pre')) {
    const code = pre.querySelector('code') || pre;
    const lang = code.getAttribute('data-lang') || '';
    // the card: the language (or "text") and Copy over the code
    const card = document.createElement('div');
    card.className = 'cm-code';
    card.innerHTML = `<div class="cm-code-head"><span class="cm-lang">${esc(lang || 'text')}</span>${copyBtn('code', 'Copy code')}</div>`;
    pre.replaceWith(card);
    card.appendChild(pre);
    lazyHighlight(c, code);
  }
  return frag;
}

// highlight a code block once it scrolls near the view (a long conversation opens without highlighting it all)
function lazyHighlight(c, code) {
  const lang = code.getAttribute('data-lang') || '';
  if (!lang || code.textContent.length > 60000) return;
  if (!c.io) {
    c.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        c.io.unobserve(e.target);
        highlightNow(e.target);
      }
    }, { root: c.feed, rootMargin: '600px 0px' });
  }
  c.io.observe(code);
}
function highlightNow(code) {
  const hljs = libsReady?.hljs;
  if (!hljs || code.dataset.hl) return;
  const raw = (code.getAttribute('data-lang') || '').toLowerCase();
  const lang = hljs.getLanguage(raw) ? raw : LANG_ALIAS[raw];
  if (!lang || !hljs.getLanguage(lang)) return;
  code.dataset.hl = '1';
  try { code.innerHTML = hljs.highlight(code.textContent, { language: lang, ignoreIllegals: true }).value; code.classList.add('hljs'); } catch {}
}
let libsReady = null;

// ---------- copying ----------
// one quiet icon button for every copy (code, messages, tool output, thinking, notes); it turns into a check
// for a moment once copied. what: 'code' (its card's code), 'msg' (the message's own text) or 'box' (the
// block it sits on, or that block's _text when the shown text isn't all of it)
export const copyBtn = (what, title) => `<button type="button" class="cp" data-cp="${what}" title="${title}" aria-label="${title}">${icon('copy', 14)}</button>`;
// a block with a copy button in its top-right corner
const copyBox = (inner) => `<div class="cp-box">${inner}${copyBtn('box', 'Copy')}</div>`;
export function copyText(text, btn) {
  const done = () => {
    if (!btn) return;
    btn.classList.add('done');
    btn.innerHTML = icon('check', 14);
    btn.title = 'Copied';
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.classList.remove('done'); btn.innerHTML = icon('copy', 14); btn.title = btn.getAttribute('aria-label') || 'Copy'; }, 1500);
  };
  // the clipboard API first; where it is refused (no focus, no permission) a hidden textarea and execCommand,
  // with the keyboard handed back to where it was
  const fallback = () => {
    const was = document.activeElement;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    try { was?.focus?.({ preventScroll: true }); } catch {}
    if (ok) done();
  };
  try { navigator.clipboard.writeText(text).then(done, fallback); } catch { fallback(); }
}

// what a copy button copies (see copyBtn)
function copySource(b) {
  const what = b.dataset.cp;
  if (what === 'code') return b.closest('.cm-code')?.querySelector('pre')?.textContent || '';
  if (what === 'msg') return b.closest('.ci')?._text || '';
  const box = b.closest('.cp-box');
  if (!box) return '';
  if (typeof box._text === 'string') return box._text;
  const el = box.firstElementChild;
  // a command: without its "$" / "PS>" prompt
  return (el?.classList.contains('tb-cmd') ? el.lastElementChild?.textContent : el?.textContent) || '';
}

// ---------- a line diff (old_string -> new_string): common ends trimmed, then LCS on the middle ----------
export function lineDiff(a, b) {
  const A = String(a ?? '').split('\n'), B = String(b ?? '').split('\n');
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let e = 0;
  while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
  const a2 = A.slice(s, A.length - e), b2 = B.slice(s, B.length - e);
  const ops = A.slice(0, s).map((t) => [' ', t]);
  const n = a2.length, m = b2.length;
  if (n * m > 250000) {
    // too big to compare line by line: all out, all in
    for (const t of a2) ops.push(['-', t]);
    for (const t of b2) ops.push(['+', t]);
  } else {
    // L[i][j] = longest common run of a2[i..] and b2[j..]
    const W = m + 1, L = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) L[i * W + j] = a2[i] === b2[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a2[i] === b2[j]) { ops.push([' ', a2[i]]); i++; j++; }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) ops.push(['-', a2[i++]]);
      else ops.push(['+', b2[j++]]);
    }
    while (i < n) ops.push(['-', a2[i++]]);
    while (j < m) ops.push(['+', b2[j++]]);
  }
  for (const t of A.slice(A.length - e)) ops.push([' ', t]);
  return ops;
}
const diffCount = (ops) => ops.reduce((o, [k]) => { if (k === '+') o.add++; else if (k === '-') o.del++; return o; }, { add: 0, del: 0 });
function diffHtml(ops) {
  const shown = ops.slice(0, DIFF_CAP);
  const rows = shown.map(([k, t]) => `<div class="dl${k === '+' ? ' dl-add' : k === '-' ? ' dl-del' : ''}"><span class="dl-m">${k === ' ' ? '' : k}</span><span class="dl-t">${esc(t) || ' '}</span></div>`).join('');
  const more = ops.length > DIFF_CAP ? `<div class="dl dl-more">… ${ops.length - DIFF_CAP} more lines</div>` : '';
  return `<div class="tb-diff">${rows}${more}</div>`;
}

// ---------- tool calls ----------
const TOOL_ICON = {
  Bash: 'shell', PowerShell: 'shell', BashOutput: 'shell', KillShell: 'shell', KillBash: 'shell',
  Read: 'read', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Write: 'write',
  Grep: 'search', Glob: 'search', LS: 'folder', WebFetch: 'web', WebSearch: 'web',
  Task: 'agent', Agent: 'agent', TodoWrite: 'plan', ExitPlanMode: 'plan', EnterPlanMode: 'plan', AskUserQuestion: 'ask',
  Skill: 'skill', SlashCommand: 'skill',
};
const toolIcon = (name) => TOOL_ICON[name] || (String(name).startsWith('mcp__') ? 'model' : 'dot');
const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
// mcp__github__get_pull_request reads as "github · get_pull_request"
const toolName = (name) => {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name || ''));
  return m ? `${m[1]} · ${m[2]}` : String(name || 'tool');
};
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
const firstLine = (t) => String(t || '').split('\n').find((l) => l.trim()) || '';
const lineCount = (t) => (t ? String(t).replace(/\n$/, '').split('\n').length : 0);
const str = (v) => (typeof v === 'string' ? v : '');

// ---------- file paths: links to the viewer (viewer.js) ----------
const PATH_TIP = 'Click to view it here · Ctrl+click opens VS Code';
const PATH_EXT = /\.(?:[cm]?[jt]sx?|mts|cts|json[c5l]?|mdx?|markdown|css|scss|sass|less|html?|xml|svg|ya?ml|toml|ini|cfg|conf|env|txt|log|csv|tsv|sql|pyw?|rb|go|rs|java|kts?|swift|[ch]|cc|[ch]pp|cs|php|lua|dart|sh|bash|zsh|ps[dm]?1|cmd|bat|vbs|lock|gradle|plist|png|jpe?g|gif|webp|ico|vue|svelte|astro|prisma|graphql|gql|proto|patch|diff|ipynb|gitignore|editorconfig|npmrc|nvmrc)$/i;
// Does inline code name a file? -> { path, line } or null. `web/chat.js`, `chat.js:120`, `chat.js:120:4`, `a.ts#L12`,
// `C:\x\y`, `/c/x/y`, `~/x`, `web/`: a known extension, an absolute path, or a folder with a trailing slash. Not a
// URL, a command (`/compact`), a branch (`origin/main`) or anything with a space.
export function pathRef(raw) {
  let t = String(raw ?? '').trim().replace(/^@(?=[\w.~\\/])/, '');
  if (!t || t.length > 300 || /\s/.test(t) || /^[a-z][\w+.-]*:\/\//i.test(t) || /[<>|*?"`$]/.test(t)) return null;
  let line = 0;
  const m = /^(.+?)(?::(\d+)(?:[:-]\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(t);
  if (m) { t = m[1]; line = Number(m[2] || m[3]) || 0; }
  const name = t.split(/[\\/]/).filter(Boolean).pop() || '';
  // (a Unix-style one only from a drive or a usual root: `/api/sessions` is a route, not a file)
  const abs = /^[a-z]:[\\/]./i.test(t) || /^~[\\/]./.test(t) || /^\/(?:[a-z]|home|Users|tmp|usr|etc|var|opt|mnt|srv|root)\/[^/]/i.test(t);
  const dir = /^[\w.~-][^:]*[\w.-][\\/]$/.test(t);
  return PATH_EXT.test(name) || abs || dir ? { path: t, line } : null;
}
const pathAttrs = (p, line = 0) => `class="fpath" data-fpath="${esc(p)}"${line > 0 ? ` data-fline="${line}"` : ''} role="link" tabindex="0" title="${esc(p)}${line > 0 ? `:${line}` : ''}\n${PATH_TIP}"`;
// the "file" line of an opened tool row
const fileKv = (p, line = 0) => (p ? `<div class="tb-kv"><span class="tb-k">file</span><span class="tb-v mono"><span ${pathAttrs(p, line)}>${esc(p)}</span></span></div>` : '');
// Grep's and Glob's output with each path a link: a line that starts with one (path, or path:line: in Grep's
// content mode)
const OUT_PATH = /^((?:[A-Za-z]:[\\/]|\/)[^:\n]*[^:\s]|[\w.~@-][^:\s]*\.[A-Za-z0-9]+)(?::(\d+))?(?=:|$)/;
function pathsOut(r, empty) {
  if (!r || !r.text || r.isError) return outPre(r, empty);
  const html = String(r.text).split('\n').map((l, i) => {
    const m = i < 3000 ? OUT_PATH.exec(l) : null;
    if (!m) return esc(l);
    return `<span ${pathAttrs(m[1], Number(m[2]) || 0)}>${esc(m[0])}</span>${esc(l.slice(m[0].length))}`;
  }).join('\n');
  return copyBox(`<pre class="tb-out">${html}</pre>`);
}
// a path as VS Code needs it: a relative one joined to the conversation's folder
const absPath = (p, cwd) => {
  if (!cwd || /^(?:[a-z]:[\\/]|[\\/]|~)/i.test(p)) return p;
  const sep = cwd.includes('\\') ? '\\' : '/';
  return `${cwd.replace(/[\\/]+$/, '')}${sep}${p.replace(/[\\/]/g, sep)}`;
};
// a click on a path: the viewer (an edit opens at its new text), or with Ctrl/Cmd VS Code
function openPath(c, el, inCode) {
  const p = el.dataset.fpath, line = Number(el.dataset.fline) || 0;
  if (!p) return;
  if (inCode) { openInCode(absPath(p, c.cwd), line); return; }
  const it = el.closest('.ci')?._item, i = it?.input || {};
  const find = line || !it ? '' : it.name === 'Edit' ? str(i.new_string) : it.name === 'MultiEdit' && Array.isArray(i.edits) ? str(i.edits[0]?.new_string) : '';
  if (el.classList.contains('opening')) return;
  el.classList.add('opening');
  openViewer({ path: p, cwd: c.cwd, line: line || (it?.name === 'Read' ? Number(i.offset) || 0 : 0), find }).finally(() => el.classList.remove('opening'));
}

// ---------- bash mode (a "!" command, see compose.js): the transcript's <bash-input> and <bash-stdout> messages ----------
// -> { cmd } for the command, { out, err } for what it printed, null for any other message
export function bashOf(text) {
  const t = String(text || '');
  const m = /^\s*<bash-input>([\s\S]*?)<\/bash-input>\s*$/.exec(t);
  if (m) return { cmd: m[1] };
  if (!/^\s*<bash-(?:stdout|stderr)>/.test(t)) return null;
  const part = (k) => {
    const x = new RegExp(`<bash-${k}>([\\s\\S]*?)</bash-${k}>`).exec(t);
    return x ? x[1].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+$/, '') : '';
  };
  return { out: part('stdout'), err: part('stderr') };
}
// your message as the feed and the compose box's ↑ show it: a bash command as "!<command>"
export const userShown = (text) => { const b = bashOf(text); return b && b.cmd != null ? `!${b.cmd}` : String(text || ''); };

// what the row names: [text, full title]
function toolTarget(it) {
  const i = it.input || {};
  switch (it.name) {
    case 'Bash': case 'PowerShell': return [str(i.description) || firstLine(i.command), str(i.command)];
    case 'Read': case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': {
      const p = str(i.file_path) || str(i.notebook_path);
      return [baseName(p), p];
    }
    case 'Grep': return [str(i.pattern) + (i.path ? `  in ${baseName(i.path)}` : ''), `${str(i.pattern)}${i.path ? ` in ${i.path}` : ''}`];
    case 'Glob': return [str(i.pattern), str(i.pattern) + (i.path ? ` in ${i.path}` : '')];
    case 'LS': return [baseName(i.path), str(i.path)];
    case 'WebFetch': return [str(i.url).replace(/^https?:\/\//, ''), str(i.url)];
    case 'WebSearch': return [str(i.query), str(i.query)];
    case 'Task': case 'Agent': return [str(i.description) || firstLine(i.prompt), str(i.subagent_type) ? `${i.subagent_type}: ${str(i.description)}` : str(i.description)];
    case 'TodoWrite': {
      const t = Array.isArray(i.todos) ? i.todos : [];
      const now = t.find((x) => x && x.status === 'in_progress');
      return [now ? str(now.activeForm) || str(now.content) : `${t.length} tasks`, ''];
    }
    case 'AskUserQuestion': { const q = Array.isArray(i.questions) ? i.questions[0] : null; return [str(q?.question), str(q?.question)]; }
    case 'Skill': return [str(i.skill) || str(i.command), ''];
    case 'SlashCommand': return [str(i.command), ''];
    default: {
      const v = Object.values(i).find((x) => typeof x === 'string' && x.trim());
      return [firstLine(v), str(v).slice(0, 300)];
    }
  }
}

function editOps(it) {
  const i = it.input || {};
  if (it._ops) return it._ops;
  const list = it.name === 'MultiEdit' && Array.isArray(i.edits) ? i.edits : [i];
  it._ops = list.map((e) => lineDiff(str(e?.old_string), str(e?.new_string)));
  return it._ops;
}

// the small figures right of the name
function toolBadge(it) {
  const i = it.input || {};
  if (it.name === 'Edit' || it.name === 'MultiEdit') {
    const n = editOps(it).map(diffCount).reduce((o, x) => ({ add: o.add + x.add, del: o.del + x.del }), { add: 0, del: 0 });
    return `<span class="d-add">+${n.add}</span><span class="d-del">-${n.del}</span>`;
  }
  if (it.name === 'Write') return `${lineCount(i.content)} lines`;
  if (it.name === 'Read' && it.result && !it.result.isError) return `${lineCount(it.result.text)} lines`;
  if (it.name === 'TodoWrite' && Array.isArray(i.todos)) return `${i.todos.filter((t) => t?.status === 'completed').length}/${i.todos.length}`;
  return '';
}

const toolStatus = (it) => (!it.result ? spinner(C.cyan)
  : it.result.isError ? `<span class="tl-err" title="failed">${icon('error', 14)}</span>`
    : `<span class="tl-ok" title="done">${icon('check', 14)}</span>`);

// opens by itself: only a todo list. A failed or interrupted command stays shut; its red mark says it failed
function toolOpenByDefault(it) {
  return it.name === 'TodoWrite';
}

const pending = () => `<div class="tb-pending">${spinner(C.cyan)}<span>Running…</span></div>`;
const outPre = (r, empty = 'no output') => (!r ? pending()
  : r.text ? copyBox(`<pre class="tb-out${r.isError ? ' err' : ''}">${esc(r.text)}</pre>`)
    : `<div class="tb-empty">${r.isError ? 'failed' : empty}</div>`);
const label = (k, v, mono = true) => (v ? `<div class="tb-kv"><span class="tb-k">${esc(k)}</span><span class="tb-v${mono ? ' mono' : ''}">${esc(v)}</span></div>` : '');
const jsonPre = (o) => { let t = ''; try { t = JSON.stringify(o, null, 2); } catch {} return t && t !== '{}' ? copyBox(`<pre class="tb-json">${esc(t)}</pre>`) : ''; };

// the opened row (built the first time it opens)
function toolBody(it, c) {
  const i = it.input || {};
  const r = it.result;
  switch (it.name) {
    case 'Bash': case 'PowerShell':
      return `${copyBox(`<div class="tb-cmd"><span class="tb-prompt">${it.name === 'PowerShell' ? 'PS&gt;' : '$'}</span><span>${esc(str(i.command))}</span></div>`)}${outPre(r)}`;
    case 'Read': {
      const range = i.offset || i.limit ? ` (from line ${i.offset || 1}${i.limit ? `, ${i.limit} lines` : ''})` : '';
      return `${fileKv(str(i.file_path), Number(i.offset) || 0)}${!r ? pending() : r.isError ? outPre(r) : `<div class="tb-empty">${lineCount(r.text)} lines read${esc(range)}</div>`}`;
    }
    case 'Edit': case 'MultiEdit': {
      const ops = editOps(it);
      const diffs = ops.map((o, n) => `${ops.length > 1 ? `<div class="tb-sub">edit ${n + 1}</div>` : ''}${diffHtml(o)}`).join('');
      return `${fileKv(str(i.file_path))}${i.replace_all ? '<div class="tb-empty">every occurrence</div>' : ''}${diffs}${r?.isError ? outPre(r) : !r ? pending() : ''}`;
    }
    case 'Write': {
      const lines = str(i.content).split('\n');
      const cut = lines.length > WRITE_LINES;
      const shown = cut ? lines.slice(0, WRITE_LINES).join('\n') : str(i.content);
      return `${fileKv(str(i.file_path))}${copyBox(`<pre class="tb-code" data-full="${cut ? '0' : '1'}">${esc(shown)}</pre>`)}${cut ? `<button type="button" class="tb-more" data-write-all>Show all ${lines.length} lines</button>` : ''}${r?.isError ? outPre(r) : !r ? pending() : ''}`;
    }
    case 'TodoWrite': {
      const todos = Array.isArray(i.todos) ? i.todos : [];
      const li = todos.map((t) => {
        const st = t?.status === 'completed' ? 'done' : t?.status === 'in_progress' ? 'now' : 'todo';
        const mark = st === 'done' ? icon('check', 12) : st === 'now' ? '<span class="td-dot"></span>' : '';
        return `<li class="td td-${st}"><span class="td-box">${mark}</span><span class="td-t">${esc(st === 'now' ? str(t.activeForm) || str(t.content) : str(t.content))}</span></li>`;
      }).join('');
      return `<ul class="tb-todo">${li}</ul>`;
    }
    case 'AskUserQuestion': {
      const qs = Array.isArray(i.questions) ? i.questions : [];
      // the answer comes back as "question"="answer" pairs; the chosen options are marked
      const answers = new Map();
      for (const m of String(r?.text || '').matchAll(/"([^"]*)"="([^"]*)"/g)) answers.set(m[1], m[2]);
      const qh = qs.map((q) => {
        const ans = answers.get(str(q?.question)) || '';
        const opts = (Array.isArray(q?.options) ? q.options : []).map((o) => {
          const picked = ans && ans.split(/,\s*/).includes(str(o?.label));
          return `<li class="aq-opt${picked ? ' picked' : ''}"><span class="aq-l">${picked ? icon('check', 12) : ''}${esc(str(o?.label))}</span>${o?.description ? `<span class="aq-d">${esc(o.description)}</span>` : ''}</li>`;
        }).join('');
        return `<div class="aq">${q?.header ? `<span class="aq-h">${esc(q.header)}</span>` : ''}<div class="aq-q">${esc(str(q?.question))}</div>${opts ? `<ul class="aq-opts">${opts}</ul>` : ''}${ans && !opts.includes('picked') ? `<div class="aq-ans">${esc(ans)}</div>` : ''}</div>`;
      }).join('');
      return qh + (!r ? `<div class="tb-pending">${icon('ask', 13)}<span>Waiting for your answer</span></div>` : r.isError ? outPre(r) : '');
    }
    case 'Task': case 'Agent': {
      const head = `${label('agent', str(i.subagent_type))}${i.prompt ? copyBox(`<div class="tb-prompt-text">${esc(str(i.prompt))}</div>`) : ''}`;
      if (!r) return head + pending();
      if (r.isError) return head + outPre(r);
      return `${head}<div class="tb-sub">result</div>${copyBox('<div class="chat-md tb-md" data-md></div>')}`;
    }
    case 'WebFetch':
      return `${label('url', str(i.url))}${label('prompt', str(i.prompt), false)}${outPre(r)}`;
    case 'WebSearch':
      return `${label('query', str(i.query), false)}${outPre(r)}`;
    case 'Grep': case 'Glob':
      return `${label('pattern', str(i.pattern))}${label('in', str(i.path))}${label('files', str(i.glob))}${pathsOut(r, 'no matches')}`;
    default:
      return `${jsonPre(i)}${outPre(r)}`;
  }
}

function fillToolBody(det, it, c) {
  const body = det.querySelector('.tl-body');
  if (!body || body._built) return;
  body._built = true;
  body.innerHTML = toolBody(it, c);
  const md = body.querySelector('[data-md]');
  if (md && libsReady) md.appendChild(mdFragment(libsReady, it.result?.text || '', c));
  if (md) md.parentElement._text = String(it.result?.text || '');
  const code = body.querySelector('.tb-code');
  if (code && it.name === 'Write') code.parentElement._text = str(it.input?.content);
}

// ---------- items ----------
// a prompt's image: the server's own link to it, or (the fixture) a data: URL of a picture type
const okImage = (src) => typeof src === 'string' && (/^\/conversation\/image\?[\w=&%.-]+$/.test(src) || /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src));
const timeTitle = (t) => (t ? ` title="${esc(clockTime(t, false))}"` : '');
// your message's text: runs of "> " lines (a Reply quote) as a quote block above what you wrote, the rest as typed
function userTextHtml(text) {
  const runs = [];
  for (const line of String(text || '').split('\n')) {
    const q = /^>( |$)/.test(line);
    const last = runs[runs.length - 1];
    const l = q ? line.replace(/^> ?/, '') : line;
    if (last && last.q === q) last.lines.push(l); else runs.push({ q, lines: [l] });
  }
  return runs.map((r) => {
    const s = r.lines.join('\n').replace(/^\n+|\s+$/g, '');
    if (!s) return '';
    return r.q ? `<div class="cu-quote">${esc(s)}</div>` : `<div class="cu-text">${esc(s)}</div>`;
  }).join('');
}

function renderItem(it, c) {
  const L = libsReady;
  const el = document.createElement(it.kind === 'tool' || it.kind === 'thinking' || (it.kind === 'note' && isLongNote(it.text)) ? 'details' : 'div');
  el.dataset.key = it.key;
  switch (it.kind) {
    case 'user': {
      const bash = bashOf(it.text);
      if (bash && bash.cmd != null) {
        // a "!" command: "! <command>", in the shell's colour
        el.className = 'ci ci-user ci-bash';
        el.innerHTML = `<div class="cu-bubble cu-bash"${timeTitle(it.t)}><span class="cu-bang" aria-label="bash">!</span><span class="cu-body cu-cmd">${esc(bash.cmd)}</span></div>`
          + `<div class="ci-acts">${copyBtn('msg', 'Copy command')}</div>`;
        el._text = bash.cmd;
        break;
      }
      if (bash) {
        // what it printed (stdout, then stderr in red)
        el.className = 'ci ci-bashout';
        el.innerHTML = `${bash.out ? copyBox(`<pre class="tb-out">${esc(bash.out)}</pre>`) : ''}${bash.err ? copyBox(`<pre class="tb-out err">${esc(bash.err)}</pre>`) : ''}`
          || '<div class="tb-empty">no output</div>';
        break;
      }
      el.className = 'ci ci-user';
      const text = String(it.text || '');
      const imgs = (it.images || []).map((im, n) => (okImage(im?.src)
        ? `<button type="button" class="cu-img" data-img="${n}" title="Show the image"><img src="${esc(im.src)}" alt="attached image ${n + 1}" loading="lazy" decoding="async"></button>`
        : `<span class="cu-noimg">${icon('image', 13)}<span>image too large to show</span></span>`)).join('');
      const long = isLong(text);
      el.innerHTML = `<div class="cu-bubble${long ? ' clamp' : ''}"${timeTitle(it.t)}>${imgs ? `<div class="cu-imgs">${imgs}</div>` : ''}${text ? `<div class="cu-body">${userTextHtml(text)}</div>` : ''}${long ? moreBtn(text) : ''}</div>`
        + (text ? `<div class="ci-acts">${copyBtn('msg', 'Copy message')}<button type="button" class="cp" data-edit title="Edit: change this message and send it again (goes back to just before it first)" aria-label="edit and resend this message">${icon('edit', 14)}</button><button type="button" class="cp" data-rewind title="Rewind: go back to just before this message (Claude Code's /rewind)" aria-label="rewind to before this message">${icon('rewind', 14)}</button></div>` : '');
      el._text = text;
      el._images = (it.images || []).map((im) => im?.src);
      break;
    }
    case 'assistant': {
      el.className = 'ci ci-asst';
      const md = document.createElement('div');
      md.className = 'chat-md';
      md.appendChild(mdFragment(L, it.text, c));
      el.appendChild(md);
      el.insertAdjacentHTML('beforeend', `<div class="ci-acts">${copyBtn('msg', 'Copy message (markdown)')}</div>`);
      el._text = String(it.text || '');
      break;
    }
    case 'thinking': {
      el.className = 'ci ci-think';
      el.innerHTML = `<summary class="th-row">${icon('think', 13)}<span class="th-k">Thinking</span><span class="th-peek">${esc(firstLine(it.text))}</span>${icon('chevron', 12)}</summary>${copyBox(`<div class="th-body">${esc(it.text)}</div>`)}`;
      break;
    }
    case 'tool': {
      const [target, title] = toolTarget(it);
      const badge = toolBadge(it);
      el.className = `ci ci-tool${!it.result ? ' pending' : it.result.isError ? ' err' : ''}`;
      // a file tool's file: a link to the viewer (only the name; the rest of the row still opens the row)
      const file = FILE_TOOLS.has(it.name) ? title : '';
      el.innerHTML = `<summary class="tl-row"><span class="tl-ic">${icon(toolIcon(it.name), 14)}</span><span class="tl-name">${esc(toolName(it.name))}</span>`
        + (file ? `<span class="tl-target"><span ${pathAttrs(file, it.name === 'Read' ? Number(it.input?.offset) || 0 : 0)}>${esc(target)}</span></span>`
          : `<span class="tl-target"${title ? ` title="${esc(title)}"` : ''}>${esc(target)}</span>`)
        + `${badge ? `<span class="tl-badge">${badge}</span>` : ''}<span class="tl-st">${toolStatus(it)}</span></summary><div class="tl-body"></div>`;
      el._item = it;
      break;
    }
    default: { // note
      const text = String(it.text || '');
      const cls = /^\//.test(text) ? ' cmd' : /^API Error|^Error/i.test(text) ? ' bad' : '';
      el.className = `ci ci-note${cls}`;
      if (el.tagName === 'DETAILS') el.innerHTML = `<summary class="cn-row"><span class="cn-t">${esc(firstLine(text).slice(0, 140))}</span>${icon('chevron', 11)}</summary>${copyBox(`<div class="cn-body">${esc(text)}</div>`)}`;
      else el.innerHTML = `<span class="cn-t">${esc(text)}</span>${pickupOpen(text)}`;
    }
  }
  if (el.tagName === 'DETAILS') {
    const was = c.open.get(it.key);
    const open = c.expandAll && (it.kind === 'tool' || it.kind === 'thinking') ? true : was != null ? was : it.kind === 'tool' && toolOpenByDefault(it);
    if (open) { el.open = true; if (it.kind === 'tool') fillToolBody(el, it, c); }
  }
  return el;
}
// "/pickup <handoff file>": a file icon that opens the summary, in Fleet View's own viewer (Ctrl+click: VS Code)
function pickupOpen(text) {
  const m = /^\/pickup\s+"?([^"\n]+?\.md)"?\s*$/i.exec(text);
  return m ? `<span ${pathAttrs(m[1]).replace('class="fpath"', 'class="fpath cn-open" aria-label="Open the handoff summary"')}>${icon('file', 12)}</span>` : '';
}
const isLongNote = (t) => String(t || '').length > 160 || String(t || '').includes('\n');

// ---------- the folded work between messages ----------
// tool calls that stay out of the fold: what Claude plans or asks is for you to read
const LOOSE_TOOLS = new Set(['TodoWrite', 'ExitPlanMode', 'AskUserQuestion']);
const isStep = (it) => it.kind === 'thinking' || (it.kind === 'tool' && !LOOSE_TOOLS.has(it.name));
const STEP_KIND = {
  Bash: 'cmd', PowerShell: 'cmd', BashOutput: 'cmd', KillShell: 'cmd', KillBash: 'cmd',
  Read: 'read', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Write: 'edit',
  Grep: 'search', Glob: 'search', LS: 'search', WebFetch: 'web', WebSearch: 'web', Task: 'agent', Agent: 'agent',
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// "Thought, ran 3 commands, read 2 files"
function stepsSummary(steps) {
  const n = { think: 0, cmd: 0, read: 0, edit: 0, search: 0, web: 0, agent: 0, other: 0 };
  for (const it of steps) n[it.kind === 'thinking' ? 'think' : STEP_KIND[it.name] || 'other']++;
  const parts = [];
  if (n.think) parts.push('thought');
  if (n.cmd) parts.push(`ran ${plural(n.cmd, 'command', 'commands')}`);
  if (n.read) parts.push(`read ${plural(n.read, 'file', 'files')}`);
  if (n.edit) parts.push(`edited ${plural(n.edit, 'file', 'files')}`);
  if (n.search) parts.push(`searched ${n.search === 1 ? 'once' : `${n.search} times`}`);
  if (n.web) parts.push(`looked up ${plural(n.web, 'page', 'pages')}`);
  if (n.agent) parts.push(`started ${plural(n.agent, 'agent', 'agents')}`);
  if (n.other) parts.push(`used ${plural(n.other, 'tool', 'tools')}`);
  const t = parts.join(', ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
// the group's line: what it did, how many failed, and (while one runs) which step is running
function drawGroup(g, steps) {
  const run = [...steps].reverse().find((it) => it.kind === 'tool' && !it.result);
  const failed = steps.filter((it) => it.kind === 'tool' && it.result?.isError).length;
  const peek = run ? (toolTarget(run)[0] || toolName(run.name)) : '';
  const html = `<span class="sg-ic">${run ? spinner(C.cyan) : icon('chevron', 12)}</span><span class="sg-k">${esc(stepsSummary(steps))}</span>`
    + (failed ? `<span class="sg-bad">${failed} failed</span>` : '')
    + `<span class="sg-peek">${esc(peek)}</span>`;
  if (g._html === html) return;
  g._html = html;
  g.classList.toggle('running', !!run);
  g.firstElementChild.innerHTML = html;
}
function stepGroup(c, key) {
  let g = c.groups.get(key);
  if (g) return g;
  g = document.createElement('details');
  g.className = 'ci ci-steps';
  g.dataset.key = key;
  g.innerHTML = '<summary class="sg-row"></summary><div class="sg-body"></div>';
  g._body = g.lastElementChild;
  if (c.expandAll || c.open.get(key)) g.open = true;
  c.groups.set(key, g);
  return g;
}

// ---------- the feed ----------
function buildPane(pane) {
  pane.classList.add('chat-pane');
  pane.innerHTML = `<div class="chat-main">
  <div class="chat-feed" tabindex="-1">
    <div class="chat-earlier" hidden><button type="button" class="chat-earlier-btn" data-earlier></button></div>
    <div class="chat-list" role="log" aria-live="off"></div>
    <div class="chat-outbox"></div>
    <div class="chat-state" hidden></div>
  </div>
  <button type="button" class="chat-top" data-top hidden title="Scroll to this message">${icon('up', 13)}<span class="ct-k">You</span><span class="ct-t"></span></button>
  <button type="button" class="chat-xall" data-xall aria-pressed="false" title="Open all the work: every step, tool and thinking row (Ctrl+O)">${icon('chevron', 11)}<span>Expand all</span></button>
  <button type="button" class="chat-pill" data-pill hidden>${icon('down', 13)}<span>New messages</span></button>
  <button type="button" class="chat-reply" hidden title="Quote the selection into your message">${icon('reply', 13)}<span>Reply</span></button>
</div>
<div class="chat-bg" hidden></div>
<div class="chat-compose"></div>`;
  const c = {
    pane, id: null, gen: 0, items: [], from: 0, total: 0, els: new Map(), groups: new Map(), open: new Map(),
    loaded: false, missing: false, error: '', busy: false, ctl: null, looping: false, seen: 0, visible: false,
    stick: true, compose: null, io: null,
    main: pane.querySelector('.chat-main'), feed: pane.querySelector('.chat-feed'), list: pane.querySelector('.chat-list'),
    earlier: pane.querySelector('.chat-earlier'), earlierBtn: pane.querySelector('.chat-earlier-btn'),
    state: pane.querySelector('.chat-state'), pill: pane.querySelector('.chat-pill'), reply: pane.querySelector('.chat-reply'),
    top: pane.querySelector('.chat-top'), topEl: null, topRaf: 0,
    composeEl: pane.querySelector('.chat-compose'), outbox: pane.querySelector('.chat-outbox'),
    bgEl: pane.querySelector('.chat-bg'), bg: [], bgOpen: false, bgHtml: '',
    sent: [], // messages sent from here that the transcript doesn't have yet: [{ at, text, images, el }]
    cwd: '', // the conversation's folder: relative paths in it are read against it
    expandAll: false, openBefore: null, xall: pane.querySelector('.chat-xall'), // Expand all, and what was open before it
  };
  pane._chat = c;
  panes.add(c);
  wire(c);
  return c;
}

const atBottom = (f) => f.scrollHeight - f.scrollTop - f.clientHeight < 48;
const toBottom = (c) => { c.feed.scrollTop = c.feed.scrollHeight; c.stick = true; c.pill.hidden = true; };

// ---------- what you sent, until the transcript has it ----------
const SENT_MAX_MS = 10 * 60 * 1000; // a message the transcript never shows (it was dropped) goes after this
const CMD_MAX_MS = 60 * 1000; // a slash command: some log nothing (/clear starts a new transcript), so it goes sooner
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
function addSent(c, d) {
  const el = document.createElement('div');
  el.className = 'ci ci-user sending';
  const imgs = (d.images || []).map((src, n) => `<span class="cu-img"><img src="${esc(src)}" alt="attached image ${n + 1}"></span>`).join('');
  const long = isLong(String(d.text || ''));
  el.innerHTML = `<div class="cu-bubble${long ? ' clamp' : ''}">${imgs ? `<div class="cu-imgs">${imgs}</div>` : ''}${d.text ? `<div class="cu-body">${userTextHtml(d.text)}</div>` : ''}${long ? moreBtn(String(d.text)) : ''}</div>`
    + `<div class="cu-status">${d.busy ? `<span>Queued: Claude reads it after this step</span><button type="button" class="cu-now" data-unsend title="Take it back out of the queue">${icon('close', 11)}<span>Unsend</span></button><button type="button" class="cu-now" data-now title="Stop what Claude is doing and send this now">${icon('stop', 11)}<span>Interrupt</span></button>`
      + (d.text ? `<button type="button" class="cu-now cu-new" data-fork="fork" title="Take it out of the queue and send it to a fork of this conversation: a new one with its history so far">${icon('branch', 11)}<span>Fork</span></button>`
        + `<button type="button" class="cu-now cu-new" data-fork="new" title="Take it out of the queue and send it to a new conversation in this folder">${icon('plus', 11)}<span>New chat</span></button>` : '') : 'Sending…'}</div>`;
  // used: the user messages and notes already in the feed (or matched to another sent one), which can't be this one
  const used = new Set(c.items.filter((it) => it.kind === 'user' || it.kind === 'note').map((it) => String(it.key)));
  const text = norm(d.text), cmd = /^\/[^\s/]+/.exec(text)?.[0] || null;
  c.sent.push({ at: Date.now(), text, raw: String(d.text || ''), cmd, images: d.images || [], el, used });
  c.outbox.appendChild(el);
  drawState(c);
  toBottom(c);
}
// Interrupt on a queued message: compose.js says whether the keys went in; Claude Code sends all the queued ones
function sendNow(c) {
  const ev = new CustomEvent('fv-chat-sendnow', { detail: { id: c.id, ok: false } });
  c.pane.dispatchEvent(ev);
  if (!ev.detail.ok) return;
  for (const s of c.sent) {
    const st = s.el.querySelector('.cu-status');
    if (st && st.querySelector('[data-now]')) st.textContent = 'Interrupting: Claude takes it now';
  }
}
// Unsend on a queued message: compose.js takes it out of Claude Code's queue (the rest stay queued).
// fork: 'fork' | 'new' (its Fork / New chat): out of the queue, then to a new conversation (app.js)
async function unsend(c, el, fork = null) {
  const s = c.sent.find((x) => x.el === el);
  if (!s || s.unsending) return;
  const st = el.querySelector('.cu-status');
  const before = st.innerHTML;
  s.unsending = true;
  st.textContent = fork ? 'Taking it out of the queue…' : 'Unsending…';
  const ev = new CustomEvent('fv-chat-unsend', { detail: { id: c.id, text: s.text, queue: () => c.queue || [], done: null } });
  c.pane.dispatchEvent(ev);
  const ok = await (ev.detail.done || Promise.resolve(false));
  if (ok) {
    dropSent(c, s);
    if (fork) window.dispatchEvent(new CustomEvent('fv-chat-fork', { detail: { id: c.id, text: s.raw || s.text, how: fork, images: s.images.length } }));
    return;
  }
  s.unsending = false;
  if (el.isConnected) st.innerHTML = before;
}
// Rewind on one of your messages: which of the same text it is, counted from the end, so the /rewind list
// (newest at the bottom) picks the right one
// edit: the text to send in its place once the rewind is done (Edit)
function rewind(c, el, edit = null) {
  const text = el._text || '';
  const same = c.items.filter((it) => it.kind === 'user' && norm(it.text) === norm(text));
  const k = same.findIndex((it) => String(it.key) === el.dataset.key);
  c.pane.dispatchEvent(new CustomEvent('fv-chat-rewind', { detail: { id: c.id, text, nth: k < 0 ? 0 : same.length - 1 - k, edit } }));
}
// Edit on one of your messages: its bubble becomes a text box with Cancel and Send. Send rewinds to just before
// the message (Claude Code asks what to restore, in the menu card) and then sends the new text in its place.
// Enter sends, Shift+Enter is a new line, Esc cancels. Images in the message don't go along.
function editMsg(c, el) {
  if (el.querySelector('.cu-edit')) { el.querySelector('.cu-edit textarea')?.focus(); return; }
  const box = document.createElement('div');
  box.className = 'cu-edit';
  box.innerHTML = `<textarea class="cu-edit-ta" spellcheck="true" aria-label="edited message"></textarea>`
    + `<div class="cu-edit-f"><span class="cu-edit-n">Goes back to just before this message, then sends this instead</span>`
    + `<button type="button" class="btn" data-edit-x>Cancel</button><button type="button" class="btn primary" data-edit-go>Send</button></div>`;
  const ta = box.querySelector('textarea');
  ta.value = el._text || '';
  el.classList.add('editing');
  el.appendChild(box);
  const fit = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight + 2, 360)}px`; };
  const shut = () => { box.remove(); el.classList.remove('editing'); };
  const go = () => {
    const t = ta.value.trim();
    if (!t) { ta.focus(); return; }
    shut();
    if (norm(t) === norm(el._text)) return; // nothing changed
    rewind(c, el, t);
  };
  ta.addEventListener('input', fit);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); }
    else if (e.key === 'Escape') { e.preventDefault(); shut(); }
  });
  box.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target.closest('[data-edit-x]')) shut();
    else if (e.target.closest('[data-edit-go]')) go();
  });
  fit();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}
function dropSent(c, s) {
  s.el.remove();
  for (const u of s.images) { try { URL.revokeObjectURL(u); } catch {} }
  c.sent = c.sent.filter((x) => x !== s);
}
// each new user message in the transcript takes the oldest sent one it matches, once; old ones go
function settleSent(c) {
  if (!c.sent.length) return;
  const now = Date.now();
  for (const s of [...c.sent]) if (now - s.at > (s.cmd ? CMD_MAX_MS : SENT_MAX_MS)) dropSent(c, s);
  for (const it of c.items) {
    if (!c.sent.length) continue;
    // a slash command shows as a note ("/model opus"), logged at or after the moment it was sent
    if (it.kind === 'note') {
      const k = String(it.key), text = norm(it.text);
      const s = c.sent.find((x) => x.cmd && !x.used.has(k) && (Number(it.t) || 0) >= x.at - 5000 && (text === x.text || text.startsWith(`${x.cmd} `) || text === x.cmd));
      if (s) { dropSent(c, s); for (const x of c.sent) x.used.add(k); }
      continue;
    }
    if (it.kind !== 'user') continue;
    const b = bashOf(it.text);
    if (b && b.cmd == null) continue; // what a "!" command printed, not a message
    const k = String(it.key), t = Number(it.t) || 0, text = norm(userShown(it.text));
    const open = c.sent.filter((x) => !x.cmd && !x.used.has(k));
    // the same text, else (the log wrote it another way) the oldest sent before this message was logged
    const s = open.find((x) => t >= x.at - 5000 && (!x.text || text.includes(x.text.slice(0, 60))))
      || open.find((x) => t >= x.at - 1000);
    if (!s) continue;
    dropSent(c, s);
    for (const x of c.sent) x.used.add(k);
  }
}

// ---------- the bar at the top: your message, while it is scrolled out of view above ----------
// The message is the last of yours that starts above the bottom of the view (the one whose reply you are
// reading); the bar shows only while all of it is above the top.
function drawTop(c) {
  const { feed, top } = c;
  const view = feed.getBoundingClientRect();
  const mine = [...c.list.children, ...c.outbox.children].filter((el) => el.classList.contains('ci-user'));
  let el = null;
  for (let i = mine.length - 1; i >= 0; i--) if (mine[i].getBoundingClientRect().top < view.bottom) { el = mine[i]; break; }
  const show = !!el && el.getBoundingClientRect().bottom < view.top + 2;
  if (!show) { top.hidden = true; c.topEl = null; return; }
  if (c.topEl !== el) {
    c.topEl = el;
    // what you wrote, not the quote you replied to (unless that is all there is)
    const text = ((el.querySelector('.cu-text') || el.querySelector('.cu-body'))?.textContent || '').replace(/\s+/g, ' ').trim();
    top.querySelector('.ct-t').textContent = text || 'an image';
  }
  top.hidden = false;
}
const drawTopSoon = (c) => { if (!c.topRaf) c.topRaf = requestAnimationFrame(() => { c.topRaf = 0; drawTop(c); }); };
function toTop(c) {
  const el = c.topEl;
  if (!el?.isConnected) return;
  c.feed.scrollTo({ top: Math.max(0, c.feed.scrollTop + el.getBoundingClientRect().top - c.feed.getBoundingClientRect().top - 12), behavior: 'smooth' });
  const b = el.querySelector('.cu-bubble');
  if (b) { b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); }
}

// ---------- Expand all: every tool and thinking row open (Ctrl+O), and back to how they were ----------
function setExpandAll(c, on) {
  if (c.expandAll === on) return;
  c.expandAll = on;
  const rows = c.list.querySelectorAll('details.ci-steps, details.ci-tool, details.ci-think');
  if (on) {
    c.openBefore = new Map(c.open);
    for (const d of rows) { d.open = true; if (d._item) fillToolBody(d, d._item, c); }
  } else {
    const before = c.openBefore || new Map();
    c.openBefore = null;
    for (const d of rows) {
      const was = before.get(d.dataset.key);
      d.open = was != null ? was : !!(d._item && toolOpenByDefault(d._item));
    }
    c.open = new Map(before);
  }
  drawXall(c);
  if (c.stick) c.feed.scrollTop = c.feed.scrollHeight;
}
function drawXall(c) {
  c.xall.classList.toggle('on', c.expandAll);
  c.xall.setAttribute('aria-pressed', String(c.expandAll));
  c.xall.querySelector('span').textContent = c.expandAll ? 'Collapse' : 'Expand all';
  c.xall.title = c.expandAll ? 'Close the rows again, back to how they were (Ctrl+O)' : 'Open all the work: every step, tool and thinking row (Ctrl+O)';
}

function wire(c) {
  const { pane, feed } = c;
  // Ctrl+O anywhere in the Chat tab (the chat box too: this runs before its own keys): Expand all
  pane.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'o') {
      e.preventDefault(); e.stopPropagation();
      setExpandAll(c, !c.expandAll);
    }
  }, true);
  // Enter on a path link (it takes the focus with Tab) opens it, as a click does
  feed.addEventListener('keydown', (e) => {
    const p = e.key === 'Enter' ? e.target.closest?.('[data-fpath]') : null;
    if (p) { e.preventDefault(); e.stopPropagation(); openPath(c, p, e.ctrlKey || e.metaKey); }
  });
  c.bgEl.addEventListener('click', (e) => {
    if (!e.target.closest('[data-bg-toggle]')) return;
    c.bgOpen = !c.bgOpen;
    drawBg(c);
  });
  pane.addEventListener('fv-chat-sent', (e) => { if (e.detail && e.detail.id === c.id) addSent(c, e.detail); });
  // the command's panel came up under the feed (compose.js): it was sent, and what it shows is down there
  pane.addEventListener('fv-chat-panel', (e) => {
    const d = e.detail;
    if (!d || d.id !== c.id || !d.cmd) return;
    const s = [...c.sent].reverse().find((x) => x.cmd === d.cmd);
    const stEl = s?.el.querySelector('.cu-status');
    if (!stEl) return;
    s.el.classList.remove('sending');
    stEl.textContent = 'Shown below';
  });
  feed.addEventListener('scroll', () => {
    c.stick = atBottom(feed);
    if (c.stick) c.pill.hidden = true;
    c.reply.hidden = true;
    drawTopSoon(c);
  }, { passive: true });
  // the pane changes height (the compose box grows, the window resizes): stay at the bottom if you were
  new ResizeObserver(() => { if (c.stick) feed.scrollTop = feed.scrollHeight; }).observe(feed);
  // <details> opening: fill a tool's body the first time, and remember what you opened or closed
  feed.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement) || !d.dataset.key) return;
    c.open.set(d.dataset.key, d.open);
    if (d.open && d._item) fillToolBody(d, d._item, c);
  }, true);
  pane.addEventListener('click', (e) => {
    const t = e.target;
    let b;
    // a file path: the viewer (Ctrl/Cmd: VS Code); on a tool row it doesn't also open the row
    if ((b = t.closest('[data-fpath]')) && window.getSelection()?.isCollapsed !== false) { e.preventDefault(); e.stopPropagation(); openPath(c, b, e.ctrlKey || e.metaKey); }
    else if ((b = t.closest('[data-xall]'))) { e.preventDefault(); setExpandAll(c, !c.expandAll); }
    else if ((b = t.closest('[data-cp]'))) { e.preventDefault(); e.stopPropagation(); copyText(copySource(b), b); }
    else if ((b = t.closest('[data-now]'))) { e.preventDefault(); sendNow(c); }
    else if ((b = t.closest('[data-unsend]'))) { e.preventDefault(); unsend(c, b.closest('.ci')); }
    else if ((b = t.closest('[data-fork]'))) { e.preventDefault(); unsend(c, b.closest('.ci'), b.dataset.fork === 'new' ? 'new' : 'fork'); }
    else if ((b = t.closest('[data-rewind]'))) { e.preventDefault(); const el = b.closest('.ci'); if (el) rewind(c, el); }
    else if ((b = t.closest('[data-edit]'))) { e.preventDefault(); const el = b.closest('.ci'); if (el) editMsg(c, el); }
    else if ((b = t.closest('[data-img]'))) { e.preventDefault(); const src = b.closest('.ci')?._images?.[+b.dataset.img]; if (okImage(src)) showImage(src); }
    else if ((b = t.closest('[data-more]'))) {
      e.preventDefault();
      const bub = b.closest('.cu-bubble');
      const open = bub.classList.toggle('expanded');
      b.textContent = open ? 'Show less' : moreLabel(bub.closest('.ci')?._text || b.closest('.ci')?.querySelector('.cu-body')?.textContent || '');
    } else if ((b = t.closest('.cu-quote')) && window.getSelection()?.isCollapsed !== false) {
      b.classList.toggle('open'); // a long quote shows its first lines; a click shows it all (not when text was selected)
    } else if ((b = t.closest('[data-write-all]'))) {
      e.preventDefault();
      const det = b.closest('.ci');
      const pre = det?.querySelector('.tb-code');
      if (pre && det._item) { pre.textContent = str(det._item.input?.content); pre.dataset.full = '1'; }
      b.remove();
    } else if (t.closest('[data-earlier]')) { e.preventDefault(); loadEarlier(c); }
    else if (t.closest('[data-top]')) { e.preventDefault(); toTop(c); }
    else if (t.closest('[data-pill]')) { e.preventDefault(); feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' }); c.pill.hidden = true; }
    else if (t.closest('[data-retry]')) { e.preventDefault(); c.error = ''; drawState(c); poll(c, true); }
  });
  wireReply(c);
}

// ---------- Reply: select text in the feed, hand it to the compose box ----------
function wireReply(c) {
  const { feed, reply, main, pane } = c;
  const hide = () => { reply.hidden = true; };
  const selected = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
    const r = sel.getRangeAt(0);
    if (!feed.contains(r.commonAncestorContainer)) return '';
    return sel.toString();
  };
  feed.addEventListener('mousedown', (e) => { if (!reply.contains(e.target)) hide(); });
  feed.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    const { clientX, clientY } = e;
    setTimeout(() => {
      if (!selected().trim()) return;
      const r = main.getBoundingClientRect();
      reply.hidden = false;
      const bw = reply.offsetWidth || 72, bh = reply.offsetHeight || 26;
      let left = clientX - r.left + 8, top = clientY - r.top + 14;
      if (top + bh > r.height) top = clientY - r.top - bh - 10;
      reply.style.left = `${Math.max(4, Math.min(r.width - bw - 4, left))}px`;
      reply.style.top = `${Math.max(4, Math.min(r.height - bh - 4, top))}px`;
    }, 0);
  });
  feed.addEventListener('keydown', hide);
  reply.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); }); // keep the selection
  reply.addEventListener('click', (e) => {
    e.preventDefault();
    const text = selected();
    hide();
    if (!text.trim()) return;
    window.getSelection()?.removeAllRanges();
    pane.dispatchEvent(new CustomEvent('fv-chat-quote', { detail: { text }, bubbles: true }));
  });
}

// ---------- the image overlay (one for the page; Esc or a click closes it) ----------
function showImage(src) {
  const ov = document.createElement('div');
  ov.className = 'chat-lightbox';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-label', 'image');
  ov.innerHTML = `<img alt="attached image"><button type="button" class="chat-lightbox-x" aria-label="close" title="close (Esc)">${icon('close', 18)}</button>`;
  ov.querySelector('img').src = src;
  const close = () => { ov.remove(); window.removeEventListener('keydown', onKey, true); };
  // Esc closes the image only, not the panel behind it
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  ov.addEventListener('click', close);
  window.addEventListener('keydown', onKey, true);
  document.body.appendChild(ov);
}

// ---------- loading ----------
let fixtureP = null;
async function fixtureConv(q) {
  if (!fixtureP) {
    fixtureP = fetch('./fixtures/conversation-sample.json', { cache: 'no-store' }).then((r) => r.json()).then((d) => {
      const rep = Math.max(1, Number(params.get('chatRepeat')) || 1);
      const items = [];
      for (let k = 0; k < rep; k++) for (const it of d.items) items.push(k ? { ...it, key: `${it.key}-${k}` } : it);
      return items;
    });
    fixtureP.catch(() => { fixtureP = null; });
  }
  const all = await fixtureP;
  const total = all.length;
  const win = Number(params.get('chatWindow')) || 300;
  let from, to = total;
  if (q.before != null) { to = Math.min(total, q.before); from = Math.max(0, to - q.limit); }
  else if (q.since != null) from = Math.max(0, Math.min(total, q.since) - 12);
  else from = Math.max(0, total - win);
  return { id: 'fixture', total, from, items: all.slice(from, to) };
}

async function fetchConv(c, q) {
  if (FIXTURE) return fixtureConv(q);
  let u = `/conversation?id=${encodeURIComponent(c.id)}`;
  if (q.before != null) u += `&before=${q.before}&limit=${q.limit}`;
  else if (q.since != null) u += `&since=${q.since}`;
  const ctl = new AbortController();
  c.ctl = ctl;
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(u, { cache: 'no-store', signal: ctl.signal });
    if (r.status === 404) return { missing: true };
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); if (c.ctl === ctl) c.ctl = null; }
}

// one poll: the first load, or what changed since the last one. force: run even when one is in flight (Retry)
async function poll(c, force = false) {
  if (c.busy && !force) return;
  const gen = c.gen;
  c.busy = true;
  let again = false;
  try {
    const [L, res] = await Promise.all([libs(), c.id.startsWith('new-') ? { missing: true } : fetchConv(c, c.loaded ? { since: c.total } : {})]);
    libsReady = L;
    if (gen !== c.gen) return;
    c.error = '';
    if (res.missing) { c.missing = true; c.loaded = true; drawState(c); return; }
    c.missing = false;
    c.bg = Array.isArray(res.bg) ? res.bg : [];
    c.queue = Array.isArray(res.queue) ? res.queue : [];
    drawBg(c);
    // a rewind dropped items the list holds: load it again from the end
    const cut = Number(res.cut) || 0;
    if (c.loaded && cut !== c.cut) { c.cut = cut; c.loaded = false; again = true; return; }
    c.cut = cut;
    const how = c.loaded ? 'since' : 'init';
    merge(c, res, how);
    c.loaded = true;
    draw(c, how);
  } catch (e) {
    if (gen !== c.gen) return;
    if (!(e instanceof TypeError && /fetch/i.test(e.message)) && e?.name !== 'AbortError') console.error('chat:', e);
    // later failures keep what is shown and try again on the next tick; only a first load shows the error
    if (!c.loaded) { c.error = String(e?.message || e); drawState(c); }
  } finally {
    if (gen === c.gen) c.busy = false;
  }
  if (again && gen === c.gen) poll(c);
}

async function loadEarlier(c) {
  if (c.busy || c.from <= 0) return;
  const gen = c.gen;
  c.busy = true;
  c.earlierBtn.disabled = true;
  try {
    const res = await fetchConv(c, { before: c.from, limit: EARLIER });
    if (gen !== c.gen || res.missing) return;
    merge(c, res, 'before');
    draw(c, 'before');
  } catch {} finally {
    if (gen === c.gen) { c.busy = false; c.earlierBtn.disabled = false; }
  }
}

// fold a response into the list. init: it is the list. since: it replaces everything from its "from" on.
// before: it goes in front.
function merge(c, res, how) {
  const items = Array.isArray(res.items) ? res.items : [];
  const from = Math.max(0, Number(res.from) || 0);
  if (how === 'before') {
    c.items = items.slice(0, Math.max(0, c.from - from)).concat(c.items);
    c.from = Math.min(c.from, from);
  } else if (how === 'init' || from > c.from + c.items.length) {
    c.items = items;
    c.from = from;
  } else if (from < c.from) {
    // the re-sent tail reaches back past what is shown (a short first page): keep the shown start
    c.items = items.slice(c.from - from);
  } else {
    c.items = c.items.slice(0, from - c.from).concat(items);
  }
  c.total = Math.max(0, Number(res.total) || c.from + c.items.length);
}

// bring the DOM in line with c.items: new and changed items are rendered, the rest are only moved if needed.
// Steps in a row (isStep) go inside one folded group, keyed by its first step.
function draw(c, how) {
  const { feed, list } = c;
  // "Show earlier" keeps what you were looking at in place: the old first item is the anchor
  const anchor = how === 'before' ? list.firstElementChild : null;
  const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
  const keys = new Set();
  const seq = []; // { it } or { steps: [...] }
  for (const it of c.items) {
    const k = String(it.key);
    if (keys.has(k)) continue; // a repeated key would fight over one element
    keys.add(k);
    const last = seq[seq.length - 1];
    if (!isStep(it)) seq.push({ it });
    else if (last && last.steps) last.steps.push(it);
    else seq.push({ steps: [it] });
  }
  let added = false;
  const itemEl = (it) => {
    const k = String(it.key);
    const json = it._j || (it._j = JSON.stringify(it));
    let el = c.els.get(k);
    if (!el || el._json !== json) {
      let nu;
      try { nu = renderItem(it, c); } catch (e) {
        // one odd item must not stop the rest: it shows as a note
        console.error('chat: item', k, e);
        nu = document.createElement('div');
        nu.className = 'ci ci-note bad';
        nu.dataset.key = k;
        nu.innerHTML = `<span class="cn-t">couldn't show this ${esc(it.kind || 'item')}</span>`;
      }
      nu._json = json;
      if (el) el.replaceWith(nu); else added = k; // a new item; the pill only cares whether it is the last one
      el = nu;
      c.els.set(k, el);
    }
    return el;
  };
  const place = (parent, el, prev) => {
    const want = prev ? prev.nextSibling : parent.firstChild;
    if (want !== el) parent.insertBefore(el, want);
    return el;
  };
  const used = new Set();
  let prev = null, lastKey = null;
  for (const e of seq) {
    if (e.it) { prev = place(list, itemEl(e.it), prev); lastKey = String(e.it.key); continue; }
    const g = stepGroup(c, `steps:${e.steps[0].key}`);
    used.add(g.dataset.key);
    let p = null;
    for (const it of e.steps) p = place(g._body, itemEl(it), p);
    drawGroup(g, e.steps);
    prev = place(list, g, prev);
    lastKey = String(e.steps[e.steps.length - 1].key);
  }
  for (const [k, el] of c.els) if (!keys.has(k)) { el.remove(); c.els.delete(k); }
  for (const [k, g] of c.groups) if (!used.has(k)) { g.remove(); c.groups.delete(k); }
  settleSent(c);
  drawState(c);
  drawTopSoon(c);
  if (how === 'init') toBottom(c);
  else if (how === 'before') { if (anchor?.isConnected) feed.scrollTop += anchor.getBoundingClientRect().top - anchorTop; }
  else if (c.stick) feed.scrollTop = feed.scrollHeight;
  else if (added && added === lastKey) c.pill.hidden = false;
}

function drawState(c) {
  const n = c.items.length + c.sent.length;
  c.earlier.hidden = !(c.from > 0 && n);
  if (!c.earlier.hidden) c.earlierBtn.textContent = `Show earlier (${c.from})`;
  let html = '';
  if (c.error && !n) html = `<div class="chat-empty">${icon('error', 16)}<span>Couldn't load the conversation</span><button type="button" class="btn chat-retry" data-retry>Retry</button></div>`;
  else if (!c.loaded) html = '<div class="chat-empty faint"><span>Loading the conversation…</span></div>';
  else if (!n) html = `<div class="chat-empty">${icon('reply', 16)}<span>No messages yet</span></div>`;
  if (c.stateHtml !== html) { c.state.innerHTML = html; c.stateHtml = html; }
  c.state.hidden = !html;
}

// ---------- what runs in the background ----------
const BG_KIND = { shell: ['shell', 'shell'], agent: ['agent', 'agent'], workflow: ['plan', 'workflow'], monitor: ['live', 'monitor'] };
function drawBg(c) {
  const bg = c.bg, now = Date.now();
  let html = '';
  if (bg.length) {
    const n = bg.length;
    html = `<button type="button" class="cbg-head" data-bg-toggle aria-expanded="${c.bgOpen}" title="${c.bgOpen ? 'Hide' : 'Show'} what runs in the background">`
      + `${spinner(C.violet)}<span class="cbg-n">${n} ${n === 1 ? 'task' : 'tasks'} in the background</span>`
      + `<span class="cbg-sum">${c.bgOpen ? '' : esc(bg.map((b) => b.label).join(' · '))}</span>${icon('chevron', 12)}</button>`;
    if (c.bgOpen) {
      html += '<ul class="cbg-list">' + bg.map((b) => {
        const [ic, word] = BG_KIND[b.kind] || ['dot', String(b.kind || 'task')];
        const det = b.detail && b.detail !== b.label ? `<span class="cbg-d">${esc(b.detail)}</span>` : '';
        return `<li class="cbg-row" title="${esc(b.detail || b.label)}">${icon(ic, 13)}<span class="cbg-k">${esc(word)}</span>`
          + `<span class="cbg-l">${esc(b.label)}</span>${det}<span class="cbg-t num">${ago(now - (Number(b.t) || now))}</span></li>`;
      }).join('') + '</ul>';
    }
  }
  if (html === c.bgHtml) return;
  c.bgHtml = html;
  c.bgEl.innerHTML = html;
  c.bgEl.hidden = !html;
  c.bgEl.classList.toggle('open', c.bgOpen);
}

// ask every second while the tab shows; stop when renderChatPane stops calling (the tab is hidden)
async function loop(c) {
  if (c.looping) return;
  c.looping = true;
  try {
    while (c.pane.isConnected && c.visible && Date.now() - c.seen < STALE_MS) {
      await poll(c);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally { c.looping = false; }
}

// a new conversation got its id (after its first message): the same conversation, so the pane keeps its compose
// box (and the focus in it) and the "Sending" bubbles, and only reads the transcript under the new id
const panes = new Set();
onRekey((oldKey, id) => {
  for (const c of panes) {
    if (c.id !== oldKey) continue;
    c.gen++;
    try { c.ctl?.abort(); } catch {}
    c.ctl = null;
    c.busy = false;
    c.id = id;
  }
});

function reset(c, s) {
  c.gen++;
  try { c.ctl?.abort(); } catch {}
  c.ctl = null;
  c.busy = false;
  c.id = s.id;
  c.items = []; c.from = 0; c.total = 0; c.loaded = false; c.missing = false; c.error = ''; c.queue = []; c.cut = 0;
  c.els.clear(); c.groups.clear(); c.open.clear();
  c.expandAll = false; c.openBefore = null; drawXall(c);
  c.io?.disconnect(); c.io = null;
  c.list.textContent = '';
  for (const s of [...c.sent]) dropSent(c, s);
  c.pill.hidden = true; c.reply.hidden = true; c.stick = true; c.top.hidden = true; c.topEl = null;
  c.bg = []; drawBg(c);
  drawState(c);
  try { c.compose?.destroy(); } catch {}
  c.compose = null;
  c.composeEl.textContent = '';
  if (!c.readOnly) try { c.compose = mountCompose(c.composeEl, s); } catch (e) { console.error('chat: compose', e); }
}

export function renderChatPane(pane, s, opts = {}) {
  if (!s || !s.id) return;
  const c = pane._chat || buildPane(pane);
  // readOnly (read.html, a past conversation): no compose box, and no Rewind, Edit or Reply (chat.css .chat-ro)
  if (opts.readOnly && !c.readOnly) { c.readOnly = true; pane.classList.add('chat-ro'); }
  const fresh = c.id !== s.id;
  c.cwd = String(s.cwd || '');
  if (fresh) reset(c, s);
  else { try { c.compose?.update(s); } catch (e) { console.error('chat: compose', e); } }
  c.visible = opts.visible !== false;
  c.seen = Date.now();
  if (!c.visible) return;
  if (fresh && c.looping) poll(c); // another conversation: load it now, not after the running loop's pause
  loop(c);
}
