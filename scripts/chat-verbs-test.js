// Tests for the API's chat verbs (api.js: POST .../now, .../unsend, .../model, .../message with now, GET .../activity)
// and the screen readers they use (screen.js promptBox, spinner, effortShown), against a fake session host on a test
// pipe, with LOCALAPPDATA and USERPROFILE in a temp folder. No live host, no claude, nothing of the real settings:
// node scripts/chat-verbs-test.js
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-chat-verbs-'));
const home = path.join(dir, 'home');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
process.env.LOCALAPPDATA = path.join(dir, 'local');
process.env.USERPROFILE = home;
process.env.FV_HOST_PIPE = process.platform === 'win32' ? `\\\\.\\pipe\\fleet-view-host-chatverbs-${process.pid}` : path.join(dir, `fleet-view-host-chatverbs-${process.pid}.sock`);
process.env.FV_HOST_DIR = path.join(dir, 'host');

const H = require('../desktop/host.js');
const SCREEN = require('../screen.js');
const API = require('../api.js');

let n = 0;
const ok = (name) => { n++; console.log('ok', name); };
const ID = '0000000a-0000-4000-8000-000000000000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the screen readers ----------
const RULE = '─'.repeat(40);
{
  assert.deepEqual(SCREEN.promptBox(['hello', RULE, '❯ ', RULE, '  ? for shortcuts']), { text: '', lines: 1 });
  assert.deepEqual(SCREEN.promptBox(['x', RULE, '❯ first line', '  second', RULE, 'footer']), { text: 'first line\nsecond', lines: 2 });
  assert.deepEqual(SCREEN.promptBox([RULE, '❯ Press up to edit queued messages', RULE]), { text: '', lines: 1 });
  assert.equal(SCREEN.promptBox(['no box here', 'at all']), null);
  assert.deepEqual(SCREEN.spinner(['✻ Brewing… (12s · ↓ 1.2k tokens · esc to interrupt)']), { verb: 'Brewing', detail: '12s · ↓ 1.2k tokens', strong: true });
  assert.deepEqual(SCREEN.spinner(['✶ Thinking… (3m 2s · ↑ 900 tokens', '· esc to interrupt)']), { verb: 'Thinking', detail: '3m 2s · ↑ 900 tokens', strong: true });
  assert.equal(SCREEN.spinner(['* Not a spinner']), null);
  assert.equal(SCREEN.spinner(['✻ Cooking…']).strong, false);
  assert.equal(SCREEN.effortShown([RULE, '❯ ', RULE, '  ◐ xhigh · /effort']), 'xhigh');
  assert.equal(SCREEN.effortShown(['nothing']), null);
  // the effort drawn right-aligned on a row with other text, read glued to it
  assert.equal(SCREEN.effortShown(['  ⎿  Set model to Sonnet 5.5 and saved as your default for new sessions○ low · /effort']), 'low');
  assert.equal(SCREEN.effortShown(['…default for new sessions○xhigh·/effort']), 'xhigh');
  assert.equal(SCREEN.effortShown(['…default for new sessionshigh · /effort', RULE, '❯ ', RULE, '  ? for shortcuts']), 'high');
  ok('screen.js: promptBox, spinner and effortShown read what compose.js reads');
  // the panel edge alone (Claude Code draws it a moment after Enter on "/effort high", 2.1.302) is no panel, even loose
  const EDGE = '▔'.repeat(60);
  assert.equal(SCREEN.panelDetails(['some output', EDGE, '', ''], { loose: true }), null);
  assert.equal(SCREEN.panelDetails(['some output', EDGE, '', '   Esc to cancel'], { loose: true }).keys, 'Esc to cancel');
  assert.equal(SCREEN.panelDetails(['some output', EDGE, '  Usage', '  ███ 40%'], { loose: true }).title, 'Usage');
  ok('screen.js: a panel edge with nothing under it is not a panel');
  // Claude Code's grey suggestion of a next message in an empty prompt (dim, the cursor inverse on its first letter)
  // reads as empty; typed text, and a colour whose numbers include a 2, do not
  const E = '\x1b[', rule = `${E}38;2;2;2;2m${RULE}${E}39m`;
  const boxOf = (row) => SCREEN.promptBox(SCREEN.render(['● hi', '', rule, row, rule, '  footer'].join('\r\n'), 60, 12, 60, false, true));
  assert.deepEqual(boxOf(`❯ ${E}2mare u done${E}22m`), { text: '', lines: 1 });
  assert.deepEqual(boxOf(`❯ ${E}7ma${E}27m${E}2mre u done${E}0m`), { text: '', lines: 1 });
  assert.deepEqual(boxOf(`❯ fi${E}7mx${E}27m it`), { text: 'fix it', lines: 1 });
  assert.deepEqual(boxOf(`❯ ${E}38;5;2mgreen${E}0m`), { text: 'green', lines: 1 });
  assert.deepEqual(SCREEN.render(`a${E}2mb${E}0m`, 20, 4, 4, false), ['ab']);
  ok('screen.js: a dim suggestion in the prompt reads as empty (render marks)');
  // background agents listed under the footer, a row each: the box is still read, however many there are
  const foot = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 3 agents · ↓ to manage';
  const agents = (k) => ['  ', '  ● main', ...Array.from({ length: k }, (_, i) => `  ◯ general-purpose  Task ${i}        6m 56s · ↓ 161.2k tokens`)];
  for (const k of [1, 3, 8]) {
    assert.deepEqual(SCREEN.promptBox(['● done', RULE, '❯ ', RULE, foot, ...agents(k)]), { text: '', lines: 1 }, `${k} agents`);
    assert.deepEqual(SCREEN.promptBox(['● done', RULE, '❯ typed', RULE, foot, ...agents(k)]), { text: 'typed', lines: 1 }, `${k} agents, typed`);
  }
  // reply rows that start with ● at the bottom are not an agent list: no box there
  assert.equal(SCREEN.promptBox([RULE, '❯ ', RULE, foot, '● one', '● two', '● three', '● four', '● five', '● six']), null);
  ok('screen.js: the box is read above a list of background agents');
}

// ---------- typing: a text ending in "\" (Claude Code takes "\" then Enter as a new line, leaving it unsent) ----------
{
  const typed = (s) => API.pasteWrites(s).map((w) => (w.startsWith('\x1b[200~') ? w.slice(6, -6) : w)).join('');
  assert.equal(typed('It\'s a mistake.?\\'), 'It\'s a mistake.?\\ ');
  assert.equal(typed('one\\\ntwo'), 'one\\\ntwo');
  assert.equal(typed('C:\\dir\\ next'), 'C:\\dir\\ next');
  ok('api.js pasteWrites: a trailing backslash gets a space, so Enter sends');
}

// ---------- menus: 2.1.296's unnumbered trust question, the older numbered one ----------
// the raw pty output of Claude Code 2.1.296's folder trust question on the Mac (cols 120): every space drawn as a
// move to a column (CSI n G), "No, exit" first with the ❯ on it, no numbers
const TRUST_RAW = "\u001b7\u001b[r\u001b8\u001b[?25h\u001b[?25l\u001b[?2004h\u001b[?2031h\u001b[?1004h\r\r\n\u001b[38;2;255;193;7m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\u001b[39m\r\r\n\u001b[2G\u001b[38;2;255;193;7m\u001b[1mAccessing\u001b[12Gworkspace:\u001b[22m\u001b[39m\r\r\n\r\r\n\u001b[2G\u001b[1m/Users/henry/code/fleet-view\u001b[22m\r\r\n\r\r\n\u001b[2GQuick\u001b[8Gsafety\u001b[15Gcheck:\u001b[22GIs\u001b[25Gthis\u001b[30Ga\u001b[32Gproject\u001b[40Gyou\u001b[44Gcreated\u001b[52Gor\u001b[55Gone\u001b[59Gyou\u001b[63Gtrust?\u001b[70G(Like\u001b[76Gyour\u001b[81Gown\u001b[85Gcode,\u001b[91Ga\u001b[93Gwell-known\u001b[104Gopen\u001b[109Gsource\r\r\n\u001b[2Gproject,\u001b[11Gor\u001b[14Gwork\u001b[19Gfrom\u001b[24Gyour\u001b[29Gteam).\u001b[36GIf\u001b[39Gnot,\u001b[44Gtake\u001b[49Ga\u001b[51Gmoment\u001b[58Gto\u001b[61Greview\u001b[68Gwhat's\u001b[75Gin\u001b[78Gthis\u001b[83Gfolder\u001b[90Gfirst.\r\r\n\r\r\n\u001b[2GClaude\u001b[9GCode'll\u001b[17Gbe\u001b[20Gable\u001b[25Gto\u001b[28Gread,\u001b[34Gedit,\u001b[40Gand\u001b[44Gexecute\u001b[52Gfiles\u001b[58Ghere.\r\r\n\r\r\n\u001b[2G\u001b[38;2;153;153;153mSecurity\u001b[11Gguide\u001b[39m\r\r\n\r\r\n\u001b[2G\u001b[38;2;177;185;249m❯\u001b[4GNo,\u001b[8Gexit\u001b[39m\r\r\n\u001b[4GYes,\u001b[9GI\u001b[11Gtrust\u001b[17Gthis\u001b[22Gfolder\r\r\n\r\r\n\u001b[2G\u001b[38;2;153;153;153mEnter\u001b[8Gto\u001b[11Gconfirm\u001b[19G·\u001b[21GEsc\u001b[25Gto\u001b[28Gcancel\u001b[39m\r\r\n\u001b[1C\u001b[4A\u001b[>0q\u001b[?u\u001b]7501;?\u0007\u001b[c";
// the same with the ❯ moved down to "Yes, I trust this folder"
const TRUST_RAW_YES = TRUST_RAW.replace('\x1b[2G\x1b[38;2;177;185;249m❯\x1b[4GNo,\x1b[8Gexit\x1b[39m\r\r\n\x1b[4GYes,',
  '\x1b[4GNo,\x1b[8Gexit\r\r\n\x1b[2G\x1b[38;2;177;185;249m❯\x1b[4GYes,');
{
  assert.notEqual(TRUST_RAW_YES, TRUST_RAW);
  const m = SCREEN.menuDetailsShown(TRUST_RAW, 120, 30);
  assert.ok(m, 'the unnumbered trust question reads as a menu');
  assert.equal(m.kind, 'trust');
  assert.equal(m.unnumbered, true);
  assert.equal(m.title, 'Quick safety check: Is this a project you created or one you trust?');
  assert.ok(m.context.includes('/Users/henry/code/fleet-view'));
  assert.deepEqual(m.options.map(({ n, label, on }) => ({ n, label, on })), [{ n: 1, label: 'No, exit', on: true }, { n: 2, label: 'Yes, I trust this folder', on: false }]);
  assert.ok(SCREEN.menuShown(TRUST_RAW, 120, 30));
  const y = SCREEN.menuDetailsShown(TRUST_RAW_YES, 120, 30);
  assert.equal(y.kind, 'trust');
  assert.deepEqual(y.options.map((o) => o.on), [false, true]);
  assert.notEqual(y.sig, m.sig, 'the sig changes when the pointer moves');
  // a narrower panel: the question wraps onto more rows, the menu still reads
  assert.equal(SCREEN.menuDetailsShown(TRUST_RAW, 80, 30)?.kind, 'trust');

  // a reply that merely has a "❯ something" line over another indented line, no keys line: not a menu
  assert.equal(SCREEN.menuDetails(['● Here is the layout:', '', '  ❯ First thing', '    Second thing', '', RULE, '❯ ', RULE, '  ? for shortcuts']), null);
  assert.equal(SCREEN.menuDetails(['● Steps:', '  ❯ No, exit', '    Yes, I trust this folder', '', '  that is all']), null);
  // the keys line too far under them, two pointers, or the options at two indentations: not a menu
  assert.equal(SCREEN.menuDetails([RULE, ' Pick', '', ' ❯ One', '   Two', '', '', '', ' Enter to confirm · Esc to cancel']), null);
  assert.equal(SCREEN.menuDetails([RULE, ' Pick', '', ' ❯ One', ' ❯ Two', '', ' Enter to confirm · Esc to cancel']), null);
  assert.equal(SCREEN.menuDetails([RULE, ' Pick', '', ' ❯ One', '     Two', '', ' Enter to confirm · Esc to cancel']), null);
  // a list in a command's panel (its ▔ edge above): the panel's, not a menu
  assert.equal(SCREEN.menuDetails(['▔'.repeat(40), ' Theme', '', ' ❯ Dark mode', '   Light mode', '', ' ↑/↓ to navigate · Enter to select · Esc to cancel']), null);
  // the prompt box holding a typed "Enter to confirm": not a menu
  assert.equal(SCREEN.menuDetails(['done.', RULE, '❯ No, exit', '  Yes', '  Enter to confirm', RULE, '  ? for shortcuts']), null);
  // an unnumbered menu not about trust is never a question (only a question is answered without allowPermission)
  const other = SCREEN.menuDetails([RULE, ' Pick a colour', '', ' ❯ Type something.', '   Chat about this', '', ' Enter to select · Esc to cancel']);
  assert.equal(other.kind, 'other');
  assert.ok(other.options.every((o) => !o.free));

  // the older numbered trust question still reads as before
  const old = SCREEN.menuDetails([RULE, ' Do you trust the files in this folder?', '', ' /Users/henry/code/fleet-view', '',
    ' Claude Code may read, write, or execute files contained in this directory. This can pose security risks.', '',
    ' ❯ 1. Yes, proceed', '   2. No, exit', '', ' Enter to confirm · Esc to exit']);
  assert.equal(old.kind, 'trust');
  assert.equal(old.title, 'Do you trust the files in this folder?');
  assert.equal(old.unnumbered, undefined);
  assert.deepEqual(old.options.map(({ n, label, on }) => ({ n, label, on })), [{ n: 1, label: 'Yes, proceed', on: true }, { n: 2, label: 'No, exit', on: false }]);

  // tail text: a move to a column on the Mac turned into the spaces it skips
  const plain = API.plainText(TRUST_RAW);
  assert.ok(plain.includes(' Yes, I trust this folder'), plain);
  assert.ok(plain.includes(' Quick safety check: Is this a project you created or one you trust?'));
  assert.ok(plain.includes(' Enter to confirm · Esc to cancel'));
  assert.equal(API.plainText('ab\x1b[5Gc\x1b[2Gd\r\n\x1b[3Ge\x1b[2Cf'), 'ab  cd\n  e  f');
  ok('screen.js: the unnumbered trust question (kind, title, pointer, sig), not a reply, the numbered one as before; plainText\'s CSI G');
}

// ---------- menus: the Claude in Chrome offer ----------
// RECONSTRUCTED, not captured: Claude Code 2.1.x's ChromeAutoEnableDialog (its strings and layout from the binary:
// title "Claude in Chrome extension detected", two notes, a Select with hideIndexes, cancelFirst and the focus on
// cancel, so "❯ No, keep browser tools off" over "  Yes, use my browser", no numbers, then "Enter to confirm · Esc to
// keep browser tools off"), drawn the way the Mac draws TRUST_RAW above (every space a CSI n G, cols 120)
const CHROME_RAW = "\u001b7\u001b[r\u001b8\u001b[?25h\u001b[?25l\u001b[?2004h\u001b[?2031h\u001b[?1004h\r\r\n\u001b[38;2;255;193;7m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\u001b[39m\r\r\n\u001b[2G\u001b[38;2;255;193;7m\u001b[1mClaude\u001b[9Gin\u001b[12GChrome\u001b[19Gextension\u001b[29Gdetected\u001b[22m\u001b[39m\r\r\n\r\r\n\u001b[2GClaude\u001b[9Gwill\u001b[14Guse\u001b[18Gyour\u001b[23GChrome\u001b[30Gbrowser\u001b[38Gby\u001b[41Gdefault\u001b[49G—\u001b[51Gnavigating\u001b[62Gsites,\u001b[69Gfilling\u001b[77Gforms,\u001b[84Gand\u001b[88Gcapturing\u001b[98Gscreenshots\u001b[110Gin\u001b[113Gyour\r\r\n\u001b[2Gexisting\u001b[11Gsession.\r\r\n\r\r\n\u001b[2G\u001b[2mBrowser\u001b[10Gactions\u001b[18Gstill\u001b[24Ggo\u001b[27Gthrough\u001b[35GClaude's\u001b[44Gregular\u001b[52Gpermission\u001b[63Gprompts\u001b[71Gbefore\u001b[78Gthey\u001b[83Grun.\u001b[88GTurn\u001b[93Gbrowser\u001b[101Gtools\u001b[107Goff\u001b[111Gfor\r\r\n\u001b[2G\u001b[2mfuture\u001b[9Gsessions\u001b[18Gwith\u001b[23G/chrome.\u001b[22m\r\r\n\r\r\n\u001b[2G\u001b[38;2;177;185;249m❯\u001b[4GNo,\u001b[8Gkeep\u001b[13Gbrowser\u001b[21Gtools\u001b[27Goff\u001b[39m\r\r\n\u001b[4GYes,\u001b[9Guse\u001b[13Gmy\u001b[16Gbrowser\r\r\n\r\r\n\u001b[2G\u001b[38;2;153;153;153mEnter\u001b[8Gto\u001b[11Gconfirm\u001b[19G·\u001b[21GEsc\u001b[25Gto\u001b[28Gkeep\u001b[33Gbrowser\u001b[41Gtools\u001b[47Goff\u001b[39m\r\r\n\u001b[1C\u001b[4A";
// the same with the ❯ moved down to "Yes, use my browser"
const CHROME_RAW_YES = CHROME_RAW.replace('\x1b[2G\x1b[38;2;177;185;249m❯\x1b[4GNo,\x1b[8Gkeep\x1b[13Gbrowser\x1b[21Gtools\x1b[27Goff\x1b[39m\r\r\n\x1b[4GYes,',
  '\x1b[4GNo,\x1b[8Gkeep\x1b[13Gbrowser\x1b[21Gtools\x1b[27Goff\r\r\n\x1b[2G\x1b[38;2;177;185;249m❯\x1b[4GYes,');
{
  assert.notEqual(CHROME_RAW_YES, CHROME_RAW);
  const m = SCREEN.menuDetailsShown(CHROME_RAW, 120, 30);
  assert.equal(m.kind, 'chrome');
  assert.equal(m.unnumbered, true);
  assert.deepEqual(m.options.map(({ n, label, on }) => ({ n, label, on })), [{ n: 1, label: 'No, keep browser tools off', on: true }, { n: 2, label: 'Yes, use my browser', on: false }]);
  assert.ok(m.context.includes('Claude in Chrome extension detected'));
  assert.deepEqual(SCREEN.menuDetailsShown(CHROME_RAW_YES, 120, 30).options.map((o) => o.on), [false, true]);
  assert.equal(SCREEN.menuDetailsShown(CHROME_RAW, 80, 30)?.kind, 'chrome');
  // numbered (should a later build show its indexes), with or without the title
  assert.equal(SCREEN.menuDetails([RULE, ' Claude in Chrome extension detected', '', ' Browser actions still go through Claude\'s regular permission prompts before they run.', '',
    ' ❯ 1. No, keep browser tools off', '   2. Yes, use my browser', '', ' Enter to confirm · Esc to keep browser tools off']).kind, 'chrome');
  assert.equal(SCREEN.menuDetails([RULE, ' Pick one', '', ' ❯ 1. Yes, use my browser', '   2. No, keep browser tools off', '', ' Enter to confirm']).kind, 'chrome');
  // only "Yes, use my browser", without the title or the other option: not the offer
  assert.equal(SCREEN.menuDetails([RULE, ' Pick one', '', ' ❯ 1. Yes, use my browser', '   2. Something else', '', ' Enter to confirm']).kind, 'other');
  // the other kinds keep theirs
  assert.equal(SCREEN.menuDetailsShown(TRUST_RAW, 120, 30).kind, 'trust');
  assert.equal(SCREEN.menuDetails([RULE, ' Which layout?', '', ' ❯ 1. Grid', '   2. List', '   3. Type something.', '', ' Enter to select · Esc to cancel']).kind, 'question');
  assert.equal(SCREEN.menuDetails([RULE, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel']).kind, 'permission');
  ok('screen.js: the Claude in Chrome offer reads as kind chrome (unnumbered or numbered); trust, question and permission keep theirs');
}

// ---------- menus: a question far above the bottom (Claude Code 2.1.300 on a 103-row panel) ----------
// the prompt is pinned to the bottom, so between the question and the last line (the rule with the chat's name) sit
// 30+ blank rows: reading only the last 40 rows saw "3." and "4." without the ❯ and no menu
{
  const rows = ['● Ran 1 shell command', '', '─'.repeat(94), ' ☐ Tools home', '', ' │ Where should the Tools folder go?', '',
    ' ❯ 1. J:\\Tools (Recommended)', '      Keep J:\\Tools as the one tools folder.', '   2. Z:\\Tools', '      Rename Z:\\Misc to Z:\\Tools.',
    '   3. Type something.', '─'.repeat(94), '   4. Chat about this', '', ' Enter to select · ↑/↓ to navigate · Esc to cancel',
    ...Array(36).fill(''), `${'─'.repeat(72)} docker-disk-cleanup ─`];
  const raw = rows.join('\r\n');
  for (const m of [SCREEN.menuDetailsShown(raw, 94, 103), SCREEN.menuDetails(SCREEN.render(raw, 94, 103, SCREEN.MENU_ROWS, false))]) {
    assert.equal(m?.kind, 'question');
    assert.deepEqual(m.options.map((o) => [o.n, o.on]), [[1, true], [2, false], [3, false], [4, false]]);
  }
  assert.ok(SCREEN.menuShown(raw, 94, 103));
  ok('screen.js: a question 36 blank rows above the bottom name rule still reads as the menu');
}

// ---------- menus: an MCP server's elicitation, its options on one line ----------
// Claude Code 2.1.296 on a Supabase execute_sql with destructive SQL (issue #431); the first lines' indent is a guess
// (pad), so 0-2 spaces are read alike. on: the ❯ before "Decline" instead, as after ↓
const MCP_ROWS = (on = 0, pad = '  ') => ['● Running the cleanup.', '', '─'.repeat(94),
  `${pad}MCP server “claude.ai Supabase” requests your input`,
  `${pad}This SQL includes destructive operations (DROP, DELETE, TRUNCATE or UPDATE without WHER…`,
  `${pad}It may permanently remove data, tables, schemas or other objects.`,
  `${pad}Run it on project abcdefghijklmnopqrst?`,
  on ? '  Accept  ❯ Decline' : '❯ Accept    Decline', '', '  Esc to cancel · ↑/↓ to navigate'];
{
  for (const pad of ['', ' ', '  ']) {
    const m = SCREEN.menuDetails(MCP_ROWS(0, pad));
    assert.ok(m, `the one-line elicitation reads as a menu (pad ${pad.length})`);
    assert.equal(m.kind, 'permission');
    assert.equal(m.unnumbered, true);
    assert.equal(m.title, 'Run it on project abcdefghijklmnopqrst?');
    assert.deepEqual(m.context, ['MCP server “claude.ai Supabase” requests your input',
      'This SQL includes destructive operations (DROP, DELETE, TRUNCATE or UPDATE without WHER…',
      'It may permanently remove data, tables, schemas or other objects.']);
    assert.deepEqual(m.options.map(({ n, label, on }) => ({ n, label, on })), [{ n: 1, label: 'Accept', on: true }, { n: 2, label: 'Decline', on: false }]);
    assert.ok(m.options.every((o) => !o.desc && !o.free));
  }
  const d = SCREEN.menuDetails(MCP_ROWS(1));
  assert.deepEqual(d.options.map((o) => o.on), [false, true]);
  assert.notEqual(d.sig, SCREEN.menuDetails(MCP_ROWS(0)).sig, 'the sig changes when the pointer moves');
  // "←/→ to navigate" as its keys line reads the same; three labels too
  assert.ok(SCREEN.menuDetails([RULE, ' Pick one?', '❯ Accept    Decline', '', ' ←/→ to navigate']));
  assert.equal(SCREEN.menuDetails([RULE, ' Pick one?', '❯ Accept   Decline   Cancel', '', ' Esc to cancel']).options.length, 3);
  // a reply line with no keys line under it: not a menu
  assert.equal(SCREEN.menuDetails(['● The dialog said:', '', '❯ Accept    Decline', '', '  and I picked Accept.', '', RULE, '❯ ', RULE, '  ? for shortcuts']), null);
  // typed into the prompt box: not a menu (a rule right above it), with or without a keys-like footer
  assert.equal(SCREEN.menuDetails(['● done.', RULE, '❯ Accept    Decline', RULE, '  ? for shortcuts']), null);
  assert.equal(SCREEN.menuDetails(['● done.', RULE, '❯ Accept    Decline', '', '  Esc to cancel · ↑/↓ to navigate']), null);
  // one label, two pointers, a long sentence, a numbered line, a panel's list (its ▔ edge above): not one either
  assert.equal(SCREEN.menuDetails([RULE, ' Pick one?', '❯ Accept', '', ' Esc to cancel']), null);
  assert.equal(SCREEN.menuDetails([RULE, ' Pick one?', '❯ Accept  ❯ Decline', '', ' Esc to cancel']), null);
  assert.equal(SCREEN.menuDetails([RULE, ' Pick one?', '❯ this is a whole sentence someone wrote in a reply here  ok', '', ' Esc to cancel']), null);
  assert.equal(SCREEN.menuDetails(['▔'.repeat(40), ' Servers', '', '❯ claude.ai Supabase    connected', '', ' Esc to cancel']), null);
  // a question drawn this way is never kind question (fail closed); without the MCP line it is other
  assert.equal(SCREEN.menuDetails([RULE, ' Ready to submit your answers?', '❯ Submit    Cancel', '', ' Esc to cancel']).kind, 'other');
  ok('screen.js: an MCP server\'s one-line elicitation (kind permission, title, context, pointer, sig); not a reply, the prompt box or a panel');
}

// ---------- the fake session host ----------
const fake = { list: [], screen: '', writes: [], onWrite: null };
const screenOf = (rows) => rows.join('\r\n');
const box = (text = '', footer = '  ? for shortcuts') => [RULE, ...(text ? text.split('\n').map((l, i) => (i ? `  ${l}` : `❯ ${l}`)) : ['❯ ']), RULE, footer];
fs.mkdirSync(process.env.FV_HOST_DIR, { recursive: true });
fs.writeFileSync(H.hostFile(), JSON.stringify({ token: 'tok' }));
const server = net.createServer((sock) => {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('error', () => {});
  sock.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.t === 'hello') { sock.write(JSON.stringify({ t: 'hello', ok: true, pid: 4242 }) + '\n'); continue; }
      let v = null;
      if (msg.op === 'list') v = fake.list;
      else if (msg.op === 'snapshot') v = fake.screen;
      else if (msg.op === 'write') { fake.writes.push(msg.a[1]); if (fake.onWrite) fake.onWrite(msg.a[1]); v = true; }
      else if (msg.op === 'create' || msg.op === 'open') { fake.opened = msg.a[0]; v = fake.onOpen ? fake.onOpen(msg.a[0]) : { ok: false }; }
      sock.write(JSON.stringify({ t: 'res', n: msg.n, v }) + '\n');
    }
  });
});

API.ensureToken();
const tok = fs.readFileSync(API.TOKEN_FILE, 'utf8').trim();
const ctx = {
  log: () => {}, sendJson: (res, code, out) => res.done([code, out]), readBody: (req, res, cb) => cb(req.body),
  successorOf: () => null, nameOf: () => 'web', turnInfo: () => ({ promptAt: Date.now() + 1000, turnOpen: true }),
  doing: () => 'Bash npm test', queue: [], transcript: async () => ({ total: 0, from: 0, items: [], queue: ctx.queue.slice() }),
};
function call(method, pathname, body, extra = {}) {
  return new Promise((resolve) => {
    const req = { method, url: pathname, body, headers: { authorization: `Bearer ${tok}`, ...extra } };
    const res = Object.assign(new EventEmitter(), { destroyed: false, writableFinished: true, done: resolve });
    API.handle(req, res, pathname, ctx);
  });
}
const S = `/api/sessions/${ID}`;
const live = (o = {}) => { fake.list = [{ id: ID, alive: true, status: 'busy', account: 'B', cols: 80, rows: 24, ...o }]; };
const reset = () => { fake.writes = []; fake.onWrite = null; ctx.queue = []; };
// the text pasted since the last reset, without the bracketed-paste marks, and the keys pressed
const pasted = () => fake.writes.filter((w) => w.startsWith('\x1b[200~')).map((w) => w.slice(6, -6)).join('');

(async () => {
  await new Promise((r) => server.listen(process.env.FV_HOST_PIPE, r));

  // ---------- activity ----------
  {
    reset(); live();
    ctx.queue = ['and then this'];
    fake.screen = screenOf(['some output', '✻ Brewing… (12s · ↓ 1.2k tokens · esc to interrupt)', '', ...box('', '  ◐ high · /effort')]);
    const [code, out] = await call('GET', `${S}/activity`);
    assert.equal(code, 200);
    assert.equal(out.busy, true);
    assert.equal(out.line, 'Brewing… (12s · ↓ 1.2k tokens)');
    assert.equal(out.verb, 'Brewing');
    assert.equal(out.doing, 'Bash npm test');
    assert.equal(out.effort, 'high');
    assert.deepEqual(out.queue, ['and then this']);
    assert.equal(out.waiting, null);
    live({ status: 'idle' });
    fake.screen = screenOf(['done.', '', ...box()]);
    const [, idle] = await call('GET', `${S}/activity`);
    assert.equal(idle.busy, false);
    assert.equal(idle.line, null);
    fake.screen = screenOf(['Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel']);
    live({ status: 'waiting', waitingFor: 'approve Bash(npm test)' });
    const [, menu] = await call('GET', `${S}/activity`);
    assert.equal(menu.busy, false);
    assert.equal(menu.waiting, 'menu');
    assert.equal(menu.menu.kind, 'permission');
    fake.list = [{ id: ID, alive: false, exitCode: 0 }];
    const [, dead] = await call('GET', `${S}/activity`);
    assert.equal(dead.alive, false);
    assert.equal(dead.busy, false);
    assert.equal((await call('POST', `${S}/activity`, {}))[0], 405);
    ok('activity: the spinner line, doing, effort and queue; not busy idle, on a menu or ended');
  }

  // ---------- send now ----------
  {
    reset(); live();
    fake.screen = screenOf(['✻ Brewing… (2s · esc to interrupt)', '', ...box()]);
    ctx.queue = ['do this next'];
    const [code, out] = await call('POST', `${S}/now`, {});
    assert.equal(code, 200);
    assert.deepEqual(out.sent, ['do this next']);
    assert.deepEqual(fake.writes, ['\x18', '\x13']);
    reset(); live({ status: 'idle' });
    assert.equal((await call('POST', `${S}/now`, {}))[0], 409);
    reset(); live(); // busy, nothing queued
    const [c2, o2] = await call('POST', `${S}/now`, {});
    assert.equal(c2, 409);
    assert.match(o2.message, /nothing is queued/);
    assert.deepEqual(fake.writes, []);
    reset(); live({ status: 'waiting', waitingFor: 'dialog open' });
    assert.equal((await call('POST', `${S}/now`, {}))[0], 409);
    ok('now: Ctrl+X then Ctrl+S only while busy with something queued');
  }

  // ---------- message with now ----------
  {
    reset(); live();
    fake.screen = screenOf(['✻ Brewing… (2s · esc to interrupt)', '', ...box()]);
    const [code, out] = await call('POST', `${S}/message`, { text: 'stop and look at this', now: true });
    assert.equal(code, 200, out.message);
    assert.equal(out.sentNow, true);
    assert.equal(pasted(), 'stop and look at this');
    assert.deepEqual(fake.writes.slice(-3), ['\r', '\x18', '\x13']);
    reset(); live({ status: 'idle' });
    const [, o2] = await call('POST', `${S}/message`, { text: 'hello', now: true });
    assert.equal(o2.sentNow, undefined);
    assert.ok(!fake.writes.includes('\x18'));
    assert.equal((await call('POST', `${S}/message`, { text: 'x', now: 'yes' }))[0], 400);
    ok('message now: sent while busy, then the send-now chord; idle: just sent');
  }

  // ---------- unsend ----------
  {
    // out of Claude Code's queue: Up pulls both, Ctrl+U clears, the other one goes back
    reset(); live();
    ctx.queue = ['take this back', 'keep this one'];
    let boxText = '';
    const draw = () => { fake.screen = screenOf(['✻ Brewing… (2s · esc to interrupt)', '', ...box(boxText)]); };
    draw();
    fake.onWrite = (w) => {
      if (w === '\x1b[A') boxText = ctx.queue.join('\n');
      else if (w.startsWith('\x15')) boxText = '';
      else if (w === '\r') { boxText = ''; }
      draw();
    };
    const [code, out] = await call('POST', `${S}/unsend`, { text: 'take this back' });
    assert.equal(code, 200, out.message);
    assert.equal(out.where, 'claude');
    assert.equal(out.requeued, 1);
    assert.equal(fake.writes[0], '\x1b[A');
    assert.equal(pasted(), 'keep this one');
    assert.equal(fake.writes[fake.writes.length - 1], '\r');
    // Claude took it meanwhile: Up brings back only the other, which goes back; 409 taken
    reset(); live();
    ctx.queue = ['gone already', 'still here'];
    boxText = ''; draw();
    fake.onWrite = (w) => {
      if (w === '\x1b[A') boxText = 'still here';
      else if (w.startsWith('\x15') || w === '\r') boxText = '';
      draw();
    };
    const [c2, o2] = await call('POST', `${S}/unsend`, { text: 'gone already' });
    assert.equal(c2, 409);
    assert.equal(o2.taken, true);
    assert.equal(o2.requeued, 1);
    assert.equal(pasted(), 'still here');
    // not queued at all
    reset(); live();
    const [c3, o3] = await call('POST', `${S}/unsend`, { text: 'never sent' });
    assert.equal(c3, 409);
    assert.equal(o3.taken, true);
    assert.deepEqual(fake.writes, []);
    // something typed in the prompt: nothing pressed
    reset(); live();
    ctx.queue = ['take this back'];
    boxText = 'a draft'; draw();
    const [c4] = await call('POST', `${S}/unsend`, { text: 'take this back' });
    assert.equal(c4, 409);
    assert.deepEqual(fake.writes, []);
    assert.equal((await call('POST', `${S}/unsend`, {}))[0], 400);
    ok('unsend: out of Claude Code\'s queue, the others queued again; taken, not queued, a draft in the box');
  }

  // ---------- model and effort ----------
  {
    const file = path.join(home, '.claude', 'settings.json');
    const start = { model: 'claude-opus-5-5', theme: 'dark', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } };
    fs.writeFileSync(file, JSON.stringify(start, null, 2) + '\n');
    reset(); live({ status: 'idle' });
    let footer = '  ◐ high · /effort', said = [];
    const draw = () => { fake.screen = screenOf(['earlier output', ...said, '', ...box('', footer)]); };
    draw();
    let typed = '';
    // Claude Code: on Enter, saves the pick as the default (and another key changes meanwhile), then says so
    fake.onWrite = (w) => {
      if (w.startsWith('\x1b[200~')) { typed += w.slice(6, -6); return; }
      if (w !== '\r') return;
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      let m;
      if ((m = /^\/model (\S+)$/.exec(typed))) { j.model = m[1]; j.other = 1; said.push(`  ⎿  Set model to ${m[1]} and saved as your default for new sessions`); }
      if ((m = /^\/effort (\S+)$/.exec(typed))) { (j.modelSettings[j.model] = j.modelSettings[j.model] || {}).effortLevel = m[1]; footer = `  ◐ ${m[1]} · /effort`; said.push(`  ⎿  Set effort level to ${m[1]}: thinks longer`); }
      typed = '';
      fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
      draw();
    };
    const [code, out] = await call('POST', `${S}/model`, { model: 'claude-haiku-5-5', effort: 'xhigh' });
    assert.equal(code, 200, out.message);
    assert.equal(out.ok, true, out.message);
    assert.equal(out.defaultKept, true);
    assert.equal(out.restored, true);
    assert.equal(out.effortNow, 'xhigh');
    assert.match(out.said[0], /^Set model to claude-haiku-5-5/);
    assert.match(out.said[1], /^Set effort level to xhigh/);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(after, { ...start, other: 1 }); // the default back, the other change kept
    assert.ok(pasted() === '/model claude-haiku-5-5/effort xhigh');
    // busy, an overseer without the phone, bad input: nothing typed
    reset(); live({ status: 'busy' });
    assert.equal((await call('POST', `${S}/model`, { effort: 'low' }))[0], 409);
    reset(); live({ status: 'idle', role: 'bot:a1b2c3d4e5f6' });
    assert.equal((await call('POST', `${S}/model`, { effort: 'low' }))[0], 403);
    assert.equal((await call('POST', `${S}/model`, { effort: 'low', via: 'phone' }))[0], 403); // no relay key
    assert.equal((await call('POST', `${S}/model`, { effort: 'nope' }))[0], 400);
    assert.equal((await call('POST', `${S}/model`, { model: 'x y' }))[0], 400);
    assert.equal((await call('POST', `${S}/model`, {}))[0], 400);
    assert.deepEqual(fake.writes, []);
    // a draft in the prompt box: refused before anything is typed
    reset(); live({ status: 'idle' });
    fake.screen = screenOf(['x', '', ...box('half a thought')]);
    assert.equal((await call('POST', `${S}/model`, { effort: 'low' }))[0], 409);
    assert.deepEqual(fake.writes, []);
    // settings.json not JSON: refused, the file untouched
    fs.writeFileSync(file, '{ not json');
    draw();
    assert.equal((await call('POST', `${S}/model`, { effort: 'low' }))[0], 409);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
    ok('model: /model and /effort typed, the default put back with other changes kept; busy, overseer, draft, bad file refused');
  }

  // ---------- model: "Switch model?", another menu, a save written late ----------
  {
    const file = path.join(home, '.claude', 'settings.json');
    const start = { model: 'claude-opus-5-5', theme: 'dark', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } };
    const EDGE = '▔'.repeat(60);
    // Claude Code 2.1's question before a switch mid-conversation, as the session host's screen showed it
    const confirm = [EDGE, '   Switch model?', '   Your next response will be slower and use more tokens', '',
      '   This conversation is cached for the current model. Switching to Sonnet 5.5 means the full history gets re-read on',
      '   your next message.', '', '   ❯ 1. Yes, switch to Sonnet 5.5', '     2. No, go back', EDGE];
    let footer, said, menu, typed;
    const draw = () => { fake.screen = screenOf(['earlier output', ...said, '', ...(menu || box('', footer))]); };
    const save = (f) => { const j = JSON.parse(fs.readFileSync(file, 'utf8')); f(j); fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n'); };
    const switched = () => { menu = null; save((j) => { j.model = 'sonnet'; j.other = 1; }); said.push('  ⎿  Set model to Sonnet 5.5 and saved as your default for new sessions'); };
    // a fake Claude Code: onEnter(typed) on Enter, onKey(key) on any other key; /effort always saves and says so
    const begin = (onEnter, onKey = () => {}) => {
      fs.writeFileSync(file, JSON.stringify(start, null, 2) + '\n');
      reset(); live({ status: 'idle' });
      footer = '  ◐ high · /effort'; said = []; menu = null; typed = '';
      draw();
      fake.onWrite = (w) => {
        if (w.startsWith('\x1b[200~')) { typed += w.slice(6, -6); return; }
        if (w === '\r') {
          const t = typed, m = /^\/effort (\S+)$/.exec(t);
          typed = '';
          if (m) { save((j) => { (j.modelSettings[j.model] = j.modelSettings[j.model] || {}).effortLevel = m[1]; }); footer = `  ◐ ${m[1]} · /effort`; said.push(`  ⎿  Set effort level to ${m[1]}`); } else onEnter(t);
        } else onKey(w);
        draw();
      };
    };

    // "Switch model?": its Yes picked, then /effort, then the default put back
    begin((t) => { if (/^\/model /.test(t)) menu = confirm; }, (k) => { if (menu && k === '1') switched(); });
    const [c1, o1] = await call('POST', `${S}/model`, { model: 'sonnet', effort: 'medium' });
    assert.equal(c1, 200, o1.message);
    assert.equal(o1.ok, true, o1.message);
    assert.equal(o1.confirmed, 'Yes, switch to Sonnet 5.5');
    assert.match(o1.said[0], /^Set model to Sonnet 5\.5/);
    assert.match(o1.said[1], /^Set effort level to medium/);
    assert.equal(o1.effortNow, 'medium');
    assert.equal(o1.defaultKept, true);
    assert.ok(fake.writes.includes('1'));
    assert.ok(!fake.writes.includes('\x1b'));
    assert.equal(pasted(), '/model sonnet/effort medium');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...start, other: 1 });

    // another menu after /model: closed with Esc, nothing more typed, 409; Claude Code's save after it closed is put back
    begin((t) => { if (/^\/model /.test(t)) menu = [RULE, '  Pick a model family', '  ❯ 1. Opus', '    2. Sonnet', '', '  Enter to select · Esc to cancel']; },
      (k) => { if (menu && k === '\x1b') { menu = null; said.push('  ⎿  Kept model as Opus'); setTimeout(() => save((j) => { j.model = 'sonnet'; }), 2000); } });
    const [c2, o2] = await call('POST', `${S}/model`, { model: 'sonnet', effort: 'low' });
    assert.equal(c2, 409, o2.message);
    assert.equal(o2.ok, false);
    assert.equal(o2.closed, true);
    assert.equal(o2.menu.title, 'Pick a model family');
    assert.equal(menu, null);
    assert.ok(fake.writes.includes('\x1b'));
    assert.equal(pasted(), '/model sonnet');
    assert.equal(o2.defaultKept, true);
    assert.equal(o2.restored, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), start);

    // Claude Code writes the default again a moment after the menu closed: put back as well
    begin((t) => { if (/^\/model /.test(t)) menu = confirm; },
      (k) => { if (menu && k === '1') { switched(); setTimeout(() => save((j) => { j.model = 'sonnet'; j.modelSettings.sonnet = { effortLevel: 'low' }; }), 800); } });
    const [c3, o3] = await call('POST', `${S}/model`, { model: 'sonnet' });
    assert.equal(c3, 200, o3.message);
    assert.equal(o3.ok, true, o3.message);
    assert.equal(o3.defaultKept, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...start, other: 1 });
    ok('model: "Switch model?" answered Yes; another menu closed (409); the default put back after a late save');
  }

  // ---------- the switch question's wording (Claude Code 2.1.299's binary) ----------
  const EDGE = '▔'.repeat(60);
  // its effort question as the session host's screen shows it (RECONSTRUCTED from the binary's strings and layout, not
  // captured): numbered, the ❯ on Yes, no keys line (hideInputGuide). Its unnumbered form (hideIndexes, for an
  // over-draft model pick, the ❯ on "No, go back") has no keys line either, so screen.js does not read it as a menu
  const effortQ = (lvl = 'medium') => [EDGE, '   Change effort level?', '   Your next response will be slower and use more tokens', '',
    `   This conversation is cached for the current effort level. Switching to ${lvl} means the full history gets`, '   re-read on your next message.', '',
    `   ❯ 1. Yes, switch to ${lvl}`, '     2. No, go back', ''];
  {
    const q = SCREEN.menuDetails(effortQ());
    assert.equal(q.title, 'Change effort level?');
    assert.equal(API.isSwitchConfirm(q), true);
    assert.equal(API.isSwitchConfirm(SCREEN.menuDetails(effortQ('xhigh').map((l) => l.replace('❯ 1.', '  1.').replace('  2.', '❯ 2.')))), true);
    // unnumbered, as a menu reader may give it
    assert.equal(API.isSwitchConfirm({ title: 'Switch model?', unnumbered: true, options: [{ n: 1, label: 'Yes, switch to Opus 5.5' }, { n: 2, label: 'No, go back', on: true }] }), true);
    assert.equal(API.isSwitchConfirm(SCREEN.menuDetails([EDGE, '   Switch model?', '   A PreModelSwitch hook asked you to confirm', '', '   ❯ 1. Yes, switch to Opus 5.5', '     2. No, go back'])), true);
    // the screen-reader mode's labels
    assert.equal(API.isSwitchConfirm({ title: 'Change effort level?', options: [{ n: 1, label: 'y. Yes, switch to low' }, { n: 2, label: 'n. No, go back' }] }), true);
    // not it: another title, a third option, no "No, go back", a permission prompt with a Yes, nothing
    assert.equal(API.isSwitchConfirm({ title: 'Do you want to proceed?', options: [{ n: 1, label: 'Yes, switch to medium' }, { n: 2, label: 'No, go back' }] }), false);
    assert.equal(API.isSwitchConfirm({ title: 'Switch model?', options: [{ n: 1, label: 'Yes, switch to Opus' }, { n: 2, label: 'No, go back' }, { n: 3, label: 'Yes, and always' }] }), false);
    assert.equal(API.isSwitchConfirm({ title: 'Switch model?', options: [{ n: 1, label: 'Yes, switch to Opus' }, { n: 2, label: 'No' }] }), false);
    assert.equal(API.isSwitchConfirm({ title: 'Change effort level?', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No, go back' }] }), false);
    assert.equal(API.isSwitchConfirm(null), false);
    ok('isSwitchConfirm: Claude Code\'s "Change effort level?" / "Switch model?" (numbered, unnumbered, a hook\'s, screen-reader), nothing else');
  }

  // ---------- model with queue: while Claude works it waits, then applies once idle ----------
  {
    const file = path.join(home, '.claude', 'settings.json');
    const start = { model: 'claude-opus-5-5', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } };
    fs.writeFileSync(file, JSON.stringify(start, null, 2) + '\n');
    const logs = [];
    ctx.log = (s) => logs.push(s);
    let footer = '  ◐ high · /effort', said = [], typed = '';
    const draw = () => { fake.screen = screenOf(['earlier output', ...said, '', ...box('', footer)]); };
    reset(); live({ status: 'busy' }); draw();
    fake.onWrite = (w) => {
      if (w.startsWith('\x1b[200~')) { typed += w.slice(6, -6); return; }
      if (w !== '\r') return;
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      let m;
      if ((m = /^\/model (\S+)$/.exec(typed))) { j.model = m[1]; said.push(`  ⎿  Set model to ${m[1]}`); }
      if ((m = /^\/effort (\S+)$/.exec(typed))) { (j.modelSettings[j.model] = j.modelSettings[j.model] || {}).effortLevel = m[1]; footer = `  ◐ ${m[1]} · /effort`; said.push(`  ⎿  Set effort level to ${m[1]}`); }
      typed = '';
      fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
      draw();
    };
    // without queue: refused as before, now saying notReady, and logged once (handle's own line left out)
    API.switchParts.refusals.clear();
    const [c0, o0] = await call('POST', `${S}/model`, { effort: 'low' });
    assert.equal(c0, 409);
    assert.equal(o0.notReady, true);
    await call('POST', `${S}/model`, { effort: 'low' });
    assert.equal(logs.filter((l) => l.includes(`model switch for ${ID}: refused`)).length, 1, logs.join('\n'));
    assert.ok(!logs.some((l) => /POST .*\/model -> 409/.test(l)), logs.join('\n'));
    assert.equal((await call('POST', `${S}/model`, { effort: 'low', queue: 'yes' }))[0], 400);
    // with queue: 202, nothing typed, kept; a second one adds the model and keeps the effort
    const [c1, o1] = await call('POST', `${S}/model`, { effort: 'low', queue: true });
    assert.equal(c1, 202, o1.message);
    assert.deepEqual({ ok: o1.ok, queued: o1.queued, id: o1.id, effort: o1.effort, message: o1.message }, { ok: true, queued: true, id: ID, effort: 'low', message: 'applies when Claude finishes this step' });
    const [c2, o2] = await call('POST', `${S}/model`, { model: 'sonnet', queue: true });
    assert.equal(c2, 202, o2.message);
    assert.equal(o2.model, 'sonnet');
    assert.equal(o2.effort, 'low');
    const sp = API.switchPending(ID);
    assert.equal(sp.model, 'sonnet');
    assert.equal(sp.effort, 'low');
    assert.ok(Number.isFinite(sp.at));
    assert.equal(sp.error, undefined);
    assert.deepEqual(fake.writes, []);
    // still busy a while: nothing typed
    await sleep(2000);
    assert.deepEqual(fake.writes, []);
    // idle: applied after the settle, the default put back, gone from the pending list
    live({ status: 'idle' });
    for (const end = Date.now() + 12000; Date.now() < end && API.switchPending(ID);) await sleep(250);
    assert.equal(API.switchPending(ID), null, logs.join('\n'));
    assert.equal(pasted(), '/model sonnet/effort low');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), start);
    assert.ok(logs.some((l) => l.includes(`queued model switch for ${ID} applied`)), logs.join('\n'));
    // idle already: queue changes nothing, it switches now (200)
    reset(); live({ status: 'idle' }); said = []; draw();
    const [c3, o3] = await call('POST', `${S}/model`, { effort: 'max', queue: true });
    assert.equal(c3, 200, o3.message);
    assert.equal(API.switchPending(ID), null);
    // an overseer's from a session: 403, never queued
    reset(); live({ status: 'busy', role: 'bot:a1b2c3d4e5f6' });
    assert.equal((await call('POST', `${S}/model`, { effort: 'low', queue: true }))[0], 403);
    assert.equal(API.switchPending(ID), null);
    // too old: dropped after 30 minutes, logged
    reset(); live({ status: 'busy' });
    assert.equal((await call('POST', `${S}/model`, { effort: 'low', queue: true }))[0], 202);
    API.switchParts.pending.get(ID).at -= 31 * 60e3;
    // (a tick of its own timer may be running: tick returns at once then)
    const ticked = async () => { for (const end = Date.now() + 5000; Date.now() < end && API.switchPending(ID);) { await API.switchParts.tick(); await sleep(50); } };
    await ticked();
    assert.equal(API.switchPending(ID), null);
    assert.ok(logs.some((l) => /dropped: not applied within 30 minutes/.test(l)), logs.join('\n'));
    // the session ended: dropped
    assert.equal((await call('POST', `${S}/model`, { effort: 'low', queue: true }))[0], 202);
    fake.list = [{ id: ID, alive: false, exitCode: 0 }];
    await ticked();
    assert.equal(API.switchPending(ID), null);
    assert.ok(logs.some((l) => /dropped: its session ended/.test(l)), logs.join('\n'));
    // applying fails (settings.json not JSON): the reason kept for /state, not tried again
    reset(); live({ status: 'busy' });
    assert.equal((await call('POST', `${S}/model`, { effort: 'low', queue: true }))[0], 202);
    fs.writeFileSync(file, '{ not json');
    live({ status: 'idle' });
    for (const end = Date.now() + 8000; Date.now() < end && !(API.switchPending(ID) || {}).error;) await sleep(250);
    const failed = API.switchPending(ID);
    assert.ok(failed && /not JSON/.test(failed.error), JSON.stringify(failed));
    assert.equal(failed.effort, 'low');
    assert.ok(logs.some((l) => /queued model switch .* failed: 409/.test(l)), logs.join('\n'));
    assert.deepEqual(fake.writes, []);
    // a new one starts afresh
    fs.writeFileSync(file, JSON.stringify(start, null, 2) + '\n');
    live({ status: 'busy' });
    const [c4, o4] = await call('POST', `${S}/model`, { model: 'haiku', queue: true });
    assert.equal(c4, 202, o4.message);
    assert.deepEqual(API.switchPending(ID), { model: 'haiku', at: API.switchPending(ID).at });
    API.switchParts.pending.clear();
    ctx.log = () => {};
    ok('model with queue: 202 while busy, parts merged, applied once idle; dropped when old or ended; a failure kept as error; refusals logged once');
  }

  // ---------- a message from another conversation: its leading /effort and /model lines switch the receiver ----------
  {
    const FROM = '0000000b-0000-4000-8000-000000000000';
    ctx.whereIs = (id) => ({ known: id === FROM });
    reset(); live({ status: 'busy' }); fake.screen = screenOf(['earlier output', '', ...box()]);
    // just the command: queued as a switch, nothing typed (under the header line Claude would read it as text)
    const [c1, o1] = await call('POST', `${S}/message`, { text: '/effort high', from: FROM });
    assert.equal(c1, 202, o1.message);
    assert.deepEqual(o1.switch, { ok: true, queued: true, effort: 'high', message: 'applies when Claude finishes this step' });
    assert.equal(o1.message, 'effort high: applies when Claude finishes this step');
    assert.equal(API.switchPending(ID).effort, 'high');
    assert.deepEqual(fake.writes, []);
    API.switchParts.pending.clear();
    // commands, a blank line, then the message: switched, and only the rest sent under the header
    reset();
    const [c2, o2] = await call('POST', `${S}/message`, { text: '/model sonnet\n/effort xhigh\n\nGo with these:\n1. a', from: FROM });
    assert.ok(c2 === 200 || c2 === 202, o2.message);
    assert.deepEqual(API.switchPending(ID), { model: 'sonnet', effort: 'xhigh', at: API.switchPending(ID).at });
    assert.equal(o2.switch.queued, true);
    // (each line is its own paste)
    assert.match(pasted(), /^\[Message from .*\]Go with these:1\. a$/);
    API.switchParts.pending.clear();
    // a value switchModel refuses, or a command further down: sent as text, nothing switched
    reset();
    await call('POST', `${S}/message`, { text: '/effort huge', from: FROM });
    assert.match(pasted(), /\]\/effort huge$/);
    reset();
    await call('POST', `${S}/message`, { text: 'please\n/effort high', from: FROM });
    assert.match(pasted(), /\]please\/effort high$/);
    assert.equal(API.switchPending(ID), null);
    // an overseer's: only Henry switches it; the rest still goes in
    reset(); live({ status: 'busy', role: 'bot:a1b2c3d4e5f6' });
    const [c3, o3] = await call('POST', `${S}/message`, { text: '/effort high\nhello', from: FROM });
    assert.ok(c3 === 200 || c3 === 202, o3.message);
    assert.equal(o3.switch.ok, false);
    assert.match(o3.message, /^effort high: not switched \(only Henry/);
    assert.match(pasted(), /hello$/);
    assert.equal(API.switchPending(ID), null);
    // without from (Henry's own, the phone's): typed as it is, as before
    reset(); live({ status: 'busy' });
    await call('POST', `${S}/message`, { text: '/effort high' });
    assert.equal(pasted(), '/effort high');
    assert.equal(API.switchPending(ID), null);
    delete ctx.whereIs;
    ok('message from another conversation: leading /effort and /model switch the receiver (queued while busy), the rest sent; bad values, later lines and Henry\'s own typed');
  }

  // ---------- model: the question answered elsewhere (an open page) before its Yes went in ----------
  {
    const file = path.join(home, '.claude', 'settings.json');
    const start = { model: 'claude-opus-5-5', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } };
    fs.writeFileSync(file, JSON.stringify(start, null, 2) + '\n');
    reset(); live({ status: 'idle' });
    const idle = (said = []) => screenOf(['earlier output', ...said, '', ...box('', '  ◐ high · /effort')]);
    let shown = idle(), reads = 0, typed = '';
    // the question is read once (by the switch), then the page has answered it: gone, the effort saved
    Object.defineProperty(fake, 'screen', { configurable: true, get: () => {
      if (shown === 'question' && ++reads > 1) {
        shown = idle(['  ⎿  Set effort level to medium']);
        const j = JSON.parse(fs.readFileSync(file, 'utf8')); j.modelSettings['claude-opus-5-5'].effortLevel = 'medium'; fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
      }
      return shown === 'question' ? screenOf(['earlier output', '', ...effortQ()]) : shown;
    }, set: (v) => { shown = v; } });
    fake.onWrite = (w) => { if (w.startsWith('\x1b[200~')) typed += w.slice(6, -6); else if (w === '\r' && /^\/effort /.test(typed)) { typed = ''; shown = 'question'; } };
    const [c, o] = await call('POST', `${S}/model`, { effort: 'medium' });
    delete fake.screen; fake.screen = idle();
    assert.equal(c, 200, o.message);
    assert.equal(o.confirmed, 'Yes, switch to medium (answered elsewhere)');
    assert.ok(!fake.writes.includes('1'), 'nothing pressed into the prompt');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), start);
    ok('model: the switch question answered elsewhere first: the save waited for, 200, nothing pressed');
  }

  // ---------- a typed /effort or /model: its switch question answered Yes, no other menu ----------
  {
    const logs = [];
    ctx.log = (s) => logs.push(s);
    let typed = '';
    const idleBox = () => screenOf(['earlier output', '', ...box()]);
    // a fake Claude Code: Enter on a /effort brings up its question (or menu()), "1" on it switches
    const begin = (menu) => {
      reset(); logs.length = 0; live({ status: 'idle' }); fake.screen = idleBox(); typed = '';
      fake.onWrite = (w) => {
        if (w.startsWith('\x1b[200~')) { typed += w.slice(6, -6); return; }
        if (w === '\r') { const t = typed; typed = ''; if (/^\/(effort|model) /.test(t) || menu.always) { fake.screen = screenOf(menu.rows); live({ status: 'waiting' }); } return; }
        if (w === '1' && menu.yes) { fake.screen = screenOf(['earlier output', '  ⎿  Set effort level to medium', '', ...box()]); live({ status: 'idle' }); }
      };
    };
    // idle: the question comes up and "1" picks its Yes
    begin({ rows: ['earlier output', '', ...effortQ()], yes: true });
    const [c1, o1] = await call('POST', `${S}/message`, { text: '/effort medium' });
    assert.equal(c1, 200, o1.message);
    for (const end = Date.now() + 4000; Date.now() < end && !fake.writes.includes('1');) await sleep(100);
    assert.ok(fake.writes.includes('1'), 'its Yes was picked');
    await sleep(800);
    assert.ok(logs.some((l) => /answered "Change effort level\?" with "Yes, switch to medium" after a typed \/effort medium/.test(l)), logs.join('\n'));
    // another menu after the command: never answered
    begin({ rows: ['Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel'] });
    await call('POST', `${S}/message`, { text: '/model sonnet' });
    await sleep(2500);
    assert.ok(!fake.writes.includes('1'), 'another menu is never answered');
    // a plain message that brings up the question: not ours to answer
    begin({ rows: ['earlier output', '', ...effortQ()], yes: true, always: true });
    await call('POST', `${S}/message`, { text: 'please set effort medium' });
    await sleep(2500);
    assert.ok(!fake.writes.includes('1'), 'only after a typed /effort or /model');
    // sent while busy: answered once the question comes up after the step
    begin({ rows: ['earlier output', '', ...effortQ()], yes: true });
    live({ status: 'busy' });
    fake.onWrite = (w) => { if (w === '1') { fake.screen = idleBox(); live({ status: 'idle' }); } };
    await call('POST', `${S}/message`, { text: '/effort medium' });
    await sleep(2000);
    assert.ok(!fake.writes.includes('1'));
    fake.screen = screenOf(['earlier output', '', ...effortQ()]); live({ status: 'waiting' });
    for (const end = Date.now() + 5000; Date.now() < end && !fake.writes.includes('1');) await sleep(100);
    assert.ok(fake.writes.includes('1'), 'answered after the step');
    await sleep(500);
    ctx.log = () => {};
    ok('message: a typed /effort or /model has its switch question answered Yes (idle, or after the step); no other menu, no plain message');
  }

  // ---------- answer: the unnumbered trust question ----------
  {
    // compose.js's parseMenu reads it the same (everything but kind)
    const { parseMenu } = await import('../web/compose.js');
    for (const raw of [TRUST_RAW, TRUST_RAW_YES]) {
      const rows = SCREEN.render(raw, 120, 30, 40, false);
      const { kind, ...rest } = SCREEN.menuDetails(rows);
      assert.equal(kind, 'trust');
      assert.deepEqual(parseMenu(rows), rest);
    }
    assert.equal(parseMenu(['● Steps:', '  ❯ No, exit', '    Yes, I trust this folder', '', '  that is all']), null);
    // the question card shows AskUserQuestion's tab strip as tags: each header, ticked once answered, no Submit
    const { questionTabs } = await import('../web/compose.js');
    assert.deepEqual(questionTabs('←  ☐ Glow  ✔ Submit  →'), [{ label: 'Glow', done: false }]);
    assert.deepEqual(questionTabs('☐ Theme'), [{ label: 'Theme', done: false }]);
    assert.deepEqual(questionTabs('←  ☒ Two words  ☐ Size  ✔ Submit  →'), [{ label: 'Two words', done: true }, { label: 'Size', done: false }]);
    assert.equal(questionTabs('Claude wants to edit app.js'), null);

    reset(); live({ status: 'waiting', waitingFor: 'trust', cols: 120, rows: 30 });
    fake.screen = TRUST_RAW;
    const [c0, o0] = await call('GET', `${S}/menu`);
    assert.equal(c0, 200, o0.message);
    assert.equal(o0.menu.kind, 'trust');
    assert.equal(o0.menu.unnumbered, true);
    // trust still needs allowPermission
    const [c1, o1] = await call('POST', `${S}/answer`, { option: 2 });
    assert.equal(c1, 403, o1.message);
    assert.deepEqual(fake.writes, []);
    // picked with ↓ and Enter, never a digit
    fake.onWrite = (w) => {
      if (w === '\x1b[B') fake.screen = TRUST_RAW_YES;
      else if (w === '\r' && fake.screen === TRUST_RAW_YES) { fake.screen = screenOf(['', ...box()]); live({ status: 'idle', cols: 120, rows: 30 }); }
    };
    const [c2, o2] = await call('POST', `${S}/answer`, { option: 2, sig: o0.menu.sig, allowPermission: true });
    assert.equal(c2, 200, o2.message);
    assert.deepEqual(fake.writes, ['\x1b[B', '\r']);
    assert.deepEqual(o2.answered, { n: 2, label: 'Yes, I trust this folder' });
    assert.equal(o2.changed, true);
    // the ❯ on it already: Enter alone
    reset(); fake.screen = TRUST_RAW_YES;
    fake.onWrite = (w) => { if (w === '\r') { fake.screen = screenOf(['', ...box()]); live({ status: 'idle', cols: 120, rows: 30 }); } };
    const [c3, o3] = await call('POST', `${S}/answer`, { option: 2, allowPermission: true });
    assert.equal(c3, 200, o3.message);
    assert.deepEqual(fake.writes, ['\r']);
    // Enter that does nothing after the pointer moved: not reported as a change
    reset(); fake.screen = TRUST_RAW;
    fake.onWrite = (w) => { if (w === '\x1b[B') fake.screen = TRUST_RAW_YES; };
    const [c4, o4] = await call('POST', `${S}/answer`, { option: 2, allowPermission: true });
    assert.equal(c4, 200, o4.message);
    assert.equal(o4.changed, false);
    ok('answer: the unnumbered trust question picked with ↓ and Enter (no digit), only with allowPermission; parseMenu agrees');
  }

  // ---------- answer: an MCP server's one-line elicitation ----------
  {
    const { parseMenu } = await import('../web/compose.js');
    for (const rows of [MCP_ROWS(0), MCP_ROWS(1), MCP_ROWS(0, '')]) {
      const { kind, ...rest } = SCREEN.menuDetails(rows);
      assert.equal(kind, 'permission');
      assert.deepEqual(parseMenu(rows), rest);
    }
    assert.equal(parseMenu(['● The dialog said:', '', '❯ Accept    Decline', '', '  and I picked Accept.']), null);
    assert.equal(parseMenu(['● done.', RULE, '❯ Accept    Decline', RULE, '  ? for shortcuts']), null);

    const UP = screenOf(MCP_ROWS(0)), DOWN = screenOf(MCP_ROWS(1));
    reset(); live({ status: 'waiting', waitingFor: 'input needed', cols: 120, rows: 30 });
    fake.screen = UP;
    const [c0, o0] = await call('GET', `${S}/menu`);
    assert.equal(c0, 200, o0.message);
    assert.equal(o0.menu.kind, 'permission');
    assert.equal(o0.menu.unnumbered, true);
    assert.equal(o0.menu.title, 'Run it on project abcdefghijklmnopqrst?');
    // an MCP server asking to run something needs allowPermission
    const [c1, o1] = await call('POST', `${S}/answer`, { option: 2 });
    assert.equal(c1, 403, o1.message);
    assert.deepEqual(fake.writes, []);
    // Decline: ↓ then Enter, never a digit
    fake.onWrite = (w) => {
      if (w === '\x1b[B') fake.screen = DOWN;
      else if (w === '\r' && fake.screen === DOWN) { fake.screen = screenOf(['', ...box()]); live({ status: 'idle', cols: 120, rows: 30 }); }
    };
    const [c2, o2] = await call('POST', `${S}/answer`, { option: 2, sig: o0.menu.sig, allowPermission: true });
    assert.equal(c2, 200, o2.message);
    assert.deepEqual(fake.writes, ['\x1b[B', '\r']);
    assert.deepEqual(o2.answered, { n: 2, label: 'Decline' });
    assert.equal(o2.changed, true);
    // Accept with the ❯ on it already: Enter alone
    reset(); fake.screen = UP;
    fake.onWrite = (w) => { if (w === '\r') { fake.screen = screenOf(['', ...box()]); live({ status: 'idle', cols: 120, rows: 30 }); } };
    const [c3, o3] = await call('POST', `${S}/answer`, { option: 1, allowPermission: true });
    assert.equal(c3, 200, o3.message);
    assert.deepEqual(fake.writes, ['\r']);
    ok('answer: an MCP server\'s one-line elicitation, Decline as ↓ and Enter (no digit), only with allowPermission; parseMenu agrees');
  }

  // ---------- start and open: the Claude in Chrome offer answered Yes, nothing else ----------
  {
    // compose.js's parseMenu reads it the same (everything but kind)
    const { parseMenu } = await import('../web/compose.js');
    for (const raw of [CHROME_RAW, CHROME_RAW_YES]) {
      const rows = SCREEN.render(raw, 120, 30, 40, false);
      const { kind, ...rest } = SCREEN.menuDetails(rows);
      assert.equal(kind, 'chrome');
      assert.deepEqual(parseMenu(rows), rest);
    }
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const logs = [];
    Object.assign(ctx, { log: (s) => logs.push(s), UNSAFE_PATH: /["%^&|<>\x00-\x1f]/, allowedFolders: () => [repo],
      whereIs: () => ({ known: true, cwd: repo, account: 'A' }), rename: () => [200], markTemp: () => {} });
    const entry = (o) => { fake.list = [{ id: ID, pid: 777, alive: true, pending: false, account: 'A', cols: 120, rows: 30, ...o }]; };
    // the screen and status its claude opens on; onWrite: what the keys do
    const opening = (screen, status, onWrite = null) => {
      reset(); logs.length = 0; fake.list = []; fake.opened = null; fake.onWrite = onWrite;
      fake.onOpen = (o) => { fake.screen = screen; entry({ status }); return { ok: true, key: 'new-1', pid: 777, ...('chrome' in o ? { chrome: o.chrome } : {}) }; };
    };
    const start = (b) => call('POST', '/api/sessions', { repo, account: 'A', prompt: 'hello there', ...b });
    // ↓ onto Yes, Enter: the dialog goes and its claude idles; the prompt's Enter makes it busy
    const keys = (w) => {
      if (w === '\x1b[B' && fake.screen === CHROME_RAW) fake.screen = CHROME_RAW_YES;
      else if (w === '\r' && fake.screen === CHROME_RAW_YES) { fake.screen = screenOf(['', ...box()]); entry({ status: 'idle' }); }
      else if (w === '\r') entry({ status: 'busy' });
    };

    // a startup dialog: its claude says waiting while it is up
    opening(CHROME_RAW, 'waiting', keys);
    const [c1, o1] = await start({});
    assert.equal(c1, 200, o1.message);
    assert.equal(o1.ok, true, o1.message);
    assert.equal(o1.promptSent, true);
    assert.equal(o1.chromeOffer, 'accepted');
    assert.match(o1.message, /Claude in Chrome offer answered Yes/);
    assert.deepEqual(fake.writes.slice(0, 2), ['\x1b[B', '\r']);
    assert.ok(!fake.writes.some((w) => /^[0-9]$/.test(w)), 'no digit in a menu drawn without numbers');
    assert.equal(pasted(), 'hello there');
    assert.equal(fake.writes[fake.writes.length - 1], '\r');
    assert.ok(logs.some((l) => /Claude in Chrome offer/.test(l)), logs.join('\n'));
    // up while it says idle: answered at the last look before typing
    opening(CHROME_RAW, 'idle', keys);
    const [c2, o2] = await start({ chrome: true });
    assert.equal(c2, 200, o2.message);
    assert.equal(o2.promptSent, true, o2.message);
    assert.equal(o2.chromeOffer, 'accepted');
    assert.equal(fake.opened.chrome, true);
    assert.equal(pasted(), 'hello there');
    // chrome: false asked for: left alone, the prompt not sent, the menu given back
    opening(CHROME_RAW, 'idle', keys);
    const [c3, o3] = await start({ chrome: false });
    assert.equal(c3, 200, o3.message);
    assert.equal(o3.ok, false);
    assert.equal(o3.promptSent, false);
    assert.equal(o3.menu.kind, 'chrome');
    assert.equal(o3.chromeOffer, undefined);
    assert.deepEqual(fake.writes, []);
    // the folder trust question at start: never answered
    opening(TRUST_RAW, 'idle', keys);
    const [c4, o4] = await start({});
    assert.equal(c4, 200, o4.message);
    assert.equal(o4.promptSent, false);
    assert.equal(o4.menu.kind, 'trust');
    assert.deepEqual(fake.writes, []);
    // a conversation resumed (open) onto the offer: answered, then ready
    opening(CHROME_RAW, 'waiting', keys);
    const [c5, o5] = await call('POST', `${S}/open`, {});
    assert.equal(c5, 200, o5.message);
    assert.equal(o5.ready, true, o5.message);
    assert.equal(o5.chromeOffer, 'accepted');
    assert.deepEqual(fake.writes, ['\x1b[B', '\r']);
    for (const k of ['UNSAFE_PATH', 'allowedFolders', 'whereIs', 'rename', 'markTemp']) delete ctx[k];
    ctx.log = () => {};
    fake.onOpen = null;
    ok('start and open: the Claude in Chrome offer answered Yes (↓, Enter) and the prompt sent; not with chrome: false; trust never');
  }

  // ---------- answer: the Claude in Chrome offer after the folder trust question answered Yes ----------
  {
    const logs = [];
    ctx.log = (s) => logs.push(s);
    const at = (screen, o) => { fake.screen = screen; live({ cols: 120, rows: 30, ...o }); };
    const idle = () => at(screenOf(['', ...box()]), { status: 'idle' });
    const trust = (after) => {
      reset(); logs.length = 0; at(TRUST_RAW, { status: 'waiting', waitingFor: 'trust' });
      // ↓ onto Yes and Enter (the trust question, then the offer); after: what the trust answer brings up
      fake.onWrite = (w) => {
        if (w === '\x1b[B' && fake.screen === TRUST_RAW) fake.screen = TRUST_RAW_YES;
        else if (w === '\r' && (fake.screen === TRUST_RAW_YES || fake.screen === TRUST_RAW)) after(); // Yes, or No (the pointer on it)
        else if (w === '\x1b[B' && fake.screen === CHROME_RAW) fake.screen = CHROME_RAW_YES;
        else if (w === '\r' && fake.screen === CHROME_RAW_YES) idle();
        else if (w === '\x1b') after();
      };
    };
    const offer = () => at(CHROME_RAW, { status: 'waiting' });
    // the offer next: answered with ↓ and Enter (no digit), chromeOffer in the reply
    trust(offer);
    const [c1, o1] = await call('POST', `${S}/answer`, { option: 2, allowPermission: true });
    assert.equal(c1, 200, o1.message);
    assert.deepEqual(o1.answered, { n: 2, label: 'Yes, I trust this folder' });
    assert.equal(o1.chromeOffer, 'accepted');
    assert.deepEqual(fake.writes, ['\x1b[B', '\r', '\x1b[B', '\r']);
    assert.equal(o1.next, null);
    assert.ok(logs.some((l) => /Claude in Chrome offer/.test(l)), logs.join('\n'));
    // idle with no menu after it: nothing more
    trust(idle);
    const [c2, o2] = await call('POST', `${S}/answer`, { option: 2, allowPermission: true });
    assert.equal(c2, 200, o2.message);
    assert.equal(o2.chromeOffer, undefined);
    assert.deepEqual(fake.writes, ['\x1b[B', '\r']);
    // another menu after it: left alone
    trust(() => at(screenOf(['Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel']), { status: 'waiting', waitingFor: 'approve Bash(x)' }));
    const [c3, o3] = await call('POST', `${S}/answer`, { option: 2, allowPermission: true });
    assert.equal(c3, 200, o3.message);
    assert.equal(o3.chromeOffer, undefined);
    assert.equal(o3.next.kind, 'permission');
    assert.deepEqual(fake.writes, ['\x1b[B', '\r']);
    // Esc, or "No, exit": the offer after it is left alone
    trust(offer);
    const [c4, o4] = await call('POST', `${S}/answer`, { option: 'esc' });
    assert.equal(c4, 200, o4.message);
    assert.equal(o4.chromeOffer, undefined);
    assert.equal(o4.next.kind, 'chrome');
    assert.deepEqual(fake.writes, ['\x1b']);
    trust(offer);
    const [c5, o5] = await call('POST', `${S}/answer`, { option: 1, allowPermission: true });
    assert.equal(c5, 200, o5.message);
    assert.deepEqual(o5.answered, { n: 1, label: 'No, exit' });
    assert.equal(o5.chromeOffer, undefined);
    assert.deepEqual(fake.writes, ['\r']);
    ctx.log = () => {};
    ok('answer: trust answered Yes has the Claude in Chrome offer after it answered Yes (↓, Enter); not after idle, another menu, Esc or No');
  }

  // ---------- Fleet View's own queue ----------
  {
    reset(); live({ status: 'waiting', waitingFor: 'approve Bash(x)' });
    fake.screen = screenOf(['Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel']);
    const [c1, o1] = await call('POST', `${S}/message`, { text: 'after the menu', queue: true });
    assert.equal(c1, 202, o1.message);
    assert.ok(API.queuedIds().includes(ID));
    const [c2, o2] = await call('POST', `${S}/unsend`, { text: 'after the menu' });
    assert.equal(c2, 200, o2.message);
    assert.equal(o2.where, 'fleetView');
    assert.ok(!API.queuedIds().includes(ID));
    ok('unsend: text waiting in Fleet View for a menu is dropped there');
  }

  // ---------- the transcript's queue ----------
  {
    reset(); live();
    ctx.queue = ['queued one'];
    const [, a] = await call('GET', `${S}/transcript`);
    assert.deepEqual(a.queue, ['queued one']);
    fake.list = [{ id: ID, alive: false }];
    const [, b] = await call('GET', `${S}/transcript`);
    assert.deepEqual(b.queue, []);
    ok('transcript: queue while it runs, none once it ended');
  }

  // ---------- the screen readers for Send it, bash mode, run in background and the mode ----------
  {
    const bashRows = (t = '') => ['done.', RULE, `! ${t}`, RULE, '  ! for bash mode'];
    assert.deepEqual(SCREEN.bashBox(bashRows()), { text: '', lines: 1 });
    assert.deepEqual(SCREEN.bashBox(bashRows('git status')), { text: 'git status', lines: 1 });
    assert.equal(SCREEN.promptBox(bashRows('git status')), null, 'nothing types a message into bash mode');
    assert.equal(SCREEN.bashBox(['done.', ...box('!not bash')]), null);
    assert.equal(SCREEN.modeShown([...box('', '  ⏵⏵ accept edits on (shift+tab to cycle)')]), 'acceptEdits');
    assert.equal(SCREEN.modeShown([...box('', '  ⏸ plan mode on (shift+tab to cycle)')]), 'plan');
    assert.equal(SCREEN.modeShown([...box('', '  ⏵⏵ bypass permissions on (shift+tab to cycle)')]), 'bypass');
    assert.equal(SCREEN.modeShown([...box('', '  ⏵⏵ auto mode on (shift+tab to cycle)')]), 'auto');
    assert.equal(SCREEN.modeShown([...box()]), 'default');
    assert.equal(SCREEN.modeShown(['Do you want to proceed?', '❯ 1. Yes', '  2. No']), null);
    assert.equal(SCREEN.bgOffered(['● Bash(npm test)', '  ⎿  Running… (ctrl+b to run in background)']), true);
    assert.equal(SCREEN.bgOffered(['● Bash(npm test)', '  ⎿  Running…']), false);
    ok('screen.js: bashBox, modeShown and bgOffered read what compose.js reads');
  }

  // ---------- activity: mode, bg and prompt ----------
  {
    reset(); live();
    fake.screen = screenOf(['● Bash(npm test)', '  ⎿  Running… (ctrl+b to run in background)', '✻ Brewing… (12s · esc to interrupt)', '', ...box('', '  ⏵⏵ accept edits on (shift+tab to cycle)')]);
    const [, a] = await call('GET', `${S}/activity`);
    assert.equal(a.mode, 'acceptEdits');
    assert.equal(a.bg, true);
    assert.equal(a.prompt, '');
    reset(); live({ status: 'idle' });
    fake.screen = screenOf(['done.', '', ...box('still here')]);
    const [, b] = await call('GET', `${S}/activity`);
    assert.equal(b.mode, 'default');
    assert.equal(b.bg, false, 'only while Claude works');
    assert.equal(b.prompt, 'still here');
    fake.screen = screenOf(['done.', RULE, '! ls -la', RULE, '  ! for bash mode']);
    assert.equal((await call('GET', `${S}/activity`))[1].prompt, '!ls -la');
    fake.screen = screenOf(['Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel']);
    const [, c] = await call('GET', `${S}/activity`);
    assert.equal(c.prompt, null);
    assert.equal(c.mode, null);
    fake.list = [{ id: ID, alive: false, exitCode: 0 }];
    const [, d] = await call('GET', `${S}/activity`);
    assert.deepEqual([d.mode, d.bg, d.prompt], [null, false, null]);
    ok('activity: the mode, a shell command for the background, the prompt box\'s text');
  }

  // ---------- Send it (enter) ----------
  {
    reset(); live({ status: 'idle' });
    let boxText = 'fix the  build\nplease';
    const draw = () => { fake.screen = screenOf(['done.', '', ...box(boxText)]); };
    draw();
    fake.onWrite = (w) => { if (w === '\r') { boxText = ''; draw(); } };
    const [code, out] = await call('POST', `${S}/enter`, { text: 'fix the build please' });
    assert.equal(code, 200, out.message);
    assert.deepEqual(fake.writes, ['\r']);
    // gone meanwhile: nothing pressed
    reset(); boxText = ''; draw();
    const [c2, o2] = await call('POST', `${S}/enter`, { text: 'fix the build please' });
    assert.equal(c2, 409);
    assert.equal(o2.gone, true);
    assert.deepEqual(fake.writes, []);
    // something else typed there, or only the start of it: nothing pressed
    reset(); boxText = 'fix the build please and more'; draw();
    assert.equal((await call('POST', `${S}/enter`, { text: 'fix the build please' }))[0], 409);
    assert.deepEqual(fake.writes, []);
    // a bash command left in a bash-mode box
    reset(); fake.screen = screenOf(['done.', RULE, '! git status', RULE, '  ! for bash mode']);
    assert.equal((await call('POST', `${S}/enter`, { text: '!git status' }))[0], 200);
    assert.deepEqual(fake.writes, ['\r']);
    // a menu up, or no box: nothing pressed
    reset(); fake.screen = screenOf(['Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel']);
    assert.equal((await call('POST', `${S}/enter`, { text: 'fix the build please' }))[0], 409);
    reset(); fake.screen = screenOf(['no box']);
    assert.equal((await call('POST', `${S}/enter`, { text: 'x' }))[0], 409);
    assert.deepEqual(fake.writes, []);
    reset(); live({ status: 'waiting', waitingFor: 'dialog open' });
    assert.equal((await call('POST', `${S}/enter`, { text: 'x' }))[0], 409);
    assert.equal((await call('POST', `${S}/enter`, {}))[0], 400);
    assert.equal((await call('POST', `${S}/enter`, { text: '   ' }))[0], 400);
    assert.deepEqual(fake.writes, []);
    ok('enter: Enter again only while the box holds exactly that text; not gone, other text, a menu, a panel');
  }

  // ---------- run in background ----------
  {
    reset(); live();
    const running = ['● Bash(npm test)', '  ⎿  Running… (ctrl+b to run in background)', '✻ Brewing… (12s · esc to interrupt)', '', ...box()];
    fake.screen = screenOf(running);
    const [code, out] = await call('POST', `${S}/background`, {});
    assert.equal(code, 200, out.message);
    assert.deepEqual(fake.writes, ['\x02']);
    reset(); live({ status: 'idle' }); fake.screen = screenOf(['done.', '', ...box()]);
    assert.equal((await call('POST', `${S}/background`, {}))[0], 409);
    reset(); live(); fake.screen = screenOf(['✻ Brewing… (12s · esc to interrupt)', '', ...box()]);
    assert.equal((await call('POST', `${S}/background`, {}))[0], 409, 'busy, but not on a shell command');
    reset(); live({ status: 'waiting' }); fake.screen = screenOf([...running.slice(0, 2), 'Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel']);
    assert.equal((await call('POST', `${S}/background`, {}))[0], 409);
    assert.deepEqual(fake.writes, []);
    ok('background: Ctrl+B only while a shell command runs that offers it; not idle, another step, a menu');
  }

  // ---------- the permission mode ----------
  {
    // a fake Claude Code: Shift+Tab cycles default -> acceptEdits -> plan -> default (no bypass in this session)
    const CYCLE = ['default', 'acceptEdits', 'plan'];
    const FOOT = { default: '  ? for shortcuts', acceptEdits: '  ⏵⏵ accept edits on (shift+tab to cycle)', plan: '  ⏸ plan mode on (shift+tab to cycle)' };
    let at = 0;
    const draw = () => { fake.screen = screenOf(['done.', '', ...box('', FOOT[CYCLE[at]])]); };
    const start = (mode, o = {}) => {
      reset(); live({ status: 'idle', ...o }); at = CYCLE.indexOf(mode); draw();
      fake.onWrite = (w) => { if (w === '\x1b[Z') { at = (at + 1) % CYCLE.length; draw(); } };
    };
    start('default');
    const [code, out] = await call('POST', `${S}/mode`, { mode: 'plan' });
    assert.equal(code, 200, out.message);
    assert.deepEqual([out.mode, out.from, out.changed], ['plan', 'default', true]);
    assert.deepEqual(fake.writes, ['\x1b[Z', '\x1b[Z']);
    // on it already: nothing pressed
    start('acceptEdits');
    const [c2, o2] = await call('POST', `${S}/mode`, { mode: 'acceptEdits' });
    assert.equal(c2, 200);
    assert.equal(o2.changed, false);
    assert.deepEqual(fake.writes, []);
    // a mode this session does not have: round the cycle once, back where it began, 409
    start('plan');
    const [c3, o3] = await call('POST', `${S}/mode`, { mode: 'bypass' });
    assert.equal(c3, 409);
    assert.equal(o3.mode, 'plan');
    assert.match(o3.message, /only a session started with it/);
    assert.equal(fake.writes.length, 3);
    // the footer never changes (it does not read keys): one press, then it stops
    start('default'); fake.onWrite = null;
    assert.equal((await call('POST', `${S}/mode`, { mode: 'plan' }))[0], 409);
    assert.equal(fake.writes.length, 1);
    // busy, a menu up, a mode it can't read: nothing pressed
    start('default', { status: 'busy' });
    assert.equal((await call('POST', `${S}/mode`, { mode: 'plan' }))[0], 409);
    start('default'); fake.screen = screenOf(['Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel']);
    assert.equal((await call('POST', `${S}/mode`, { mode: 'plan' }))[0], 409);
    start('default'); fake.screen = screenOf(['no footer here']);
    assert.equal((await call('POST', `${S}/mode`, { mode: 'plan' }))[0], 409);
    assert.deepEqual(fake.writes, []);
    // bad input; an overseer's is Henry's (the relay's key)
    assert.equal((await call('POST', `${S}/mode`, { mode: 'yolo' }))[0], 400);
    assert.equal((await call('POST', `${S}/mode`, {}))[0], 400);
    start('default', { role: 'bot:0123456789ab' });
    assert.equal((await call('POST', `${S}/mode`, { mode: 'plan' }))[0], 403);
    assert.equal((await call('POST', `${S}/mode`, { mode: 'plan', via: 'phone' }))[0], 403, 'no relay key');
    assert.deepEqual(fake.writes, []);
    const [c4] = await call('POST', `${S}/mode`, { mode: 'plan', via: 'phone' }, { 'x-fleet-view-relay': API.relayKey() });
    assert.equal(c4, 200);
    ok('mode: Shift+Tab until the footer shows it; on it already, a mode it lacks, no redraw; not busy, a menu, unread; an overseer\'s is Henry\'s');
  }

  // ---------- a command's panel (activity's panel, POST .../panel) ----------
  {
    // a fake Claude Code's Settings panel, as /usage draws it (web/term.js's fake): a ▔ edge, its tabs with the one on in
    // a background colour, its keys at the bottom. Tab and → go to the next tab, ← back, Esc closes it (the prompt again)
    const E = '\x1b[', TABS = ['Status', 'Config', 'Usage', 'Stats'];
    const BODY = { Status: ['Version:           2.1.294'], Config: ['❯ Auto-compact      true', '  Show tips         true'],
      Usage: ['Current session', `${E}38;2;177;185;249m${'█'.repeat(6)}${E}0m                   12% used`], Stats: ['Sessions: 412'] };
    let at = 2, open = true;
    const draw = () => {
      const tabs = TABS.map((t, i) => (i === at ? `${E}38;2;0;0;0m${E}48;2;177;185;249m ${t} ${E}0m` : ` ${t} `)).join(' ');
      fake.screen = open
        ? ['done.', '', RULE, '❯ /usage', '▔'.repeat(60), `   ${E}1mSettings${E}0m ${tabs}`, '', ...BODY[TABS[at]].map((l) => `   ${l}`), '', `   ${E}2mEsc to cancel${E}0m`].join('\r\n')
        : screenOf(['done.', '', ...box()]);
    };
    const start = (o = {}) => {
      reset(); at = 2; open = true; draw();
      live({ status: 'waiting', waitingFor: 'dialog open', slashPanel: '/usage', ...o });
      fake.onWrite = (w) => {
        if (!open) return;
        if (w === '\t' || w === '\x1b[C') at = (at + 1) % TABS.length;
        else if (w === '\x1b[D') at = (at + TABS.length - 1) % TABS.length;
        else if (w === '\x1b') open = false;
        draw();
      };
    };
    start();
    const [c0, a0] = await call('GET', `${S}/activity`);
    assert.equal(c0, 200);
    assert.equal(a0.waiting, 'panel');
    assert.equal(a0.busy, false);
    assert.equal(a0.menu, null);
    assert.equal(a0.panel.title, 'Settings');
    assert.deepEqual(a0.panel.tabs, TABS.map((label, i) => ({ label, on: i === 2 })));
    assert.deepEqual(a0.panel.body, ['Current session', '██████                   12% used']);
    assert.equal(a0.panel.keys, 'Esc to cancel');
    assert.equal(a0.panel.cmd, '/usage');
    assert.match(a0.panel.sig, /^[0-9a-f]{12}$/);
    // a key: pressed once, and the panel as it reads after
    const [c1, o1] = await call('POST', `${S}/panel`, { key: 'right' });
    assert.equal(c1, 200, o1.message);
    assert.deepEqual(fake.writes, ['\x1b[C']);
    assert.equal(o1.panel.tabs.findIndex((t) => t.on), 3);
    assert.notEqual(o1.panel.sig, a0.panel.sig);
    // a tab: Tab until it is on (from Stats round to Config: two presses)
    fake.writes = [];
    const [c2, o2] = await call('POST', `${S}/panel`, { tab: 1 });
    assert.equal(c2, 200, o2.message);
    assert.deepEqual(fake.writes, ['\t', '\t']);
    assert.equal(o2.panel.tabs.findIndex((t) => t.on), 1);
    assert.deepEqual(o2.panel.body, ['❯ Auto-compact      true', '  Show tips         true']);
    // the one on already: nothing pressed; past its tabs: 409
    fake.writes = [];
    assert.equal((await call('POST', `${S}/panel`, { tab: 1 }))[0], 200);
    assert.deepEqual(fake.writes, []);
    assert.equal((await call('POST', `${S}/panel`, { tab: 7 }))[0], 409);
    // Esc closes it: panel null
    const [c3, o3] = await call('POST', `${S}/panel`, { key: 'esc' });
    assert.equal(c3, 200, o3.message);
    assert.equal(o3.panel, null);
    assert.match(o3.message, /closed/);
    ok('panel: activity shows it (title, tabs with the one on, body, keys, the command); a key, a tab, Esc closes it');

    // no panel up: nothing pressed (an Esc would interrupt Claude mid-turn); a question up instead: 409 with it
    reset(); live({ status: 'busy' }); fake.screen = screenOf(['✻ Brewing… (2s · esc to interrupt)', '', ...box()]);
    const [c4, o4] = await call('POST', `${S}/panel`, { key: 'esc' });
    assert.equal(c4, 409); assert.equal(o4.panel, null);
    assert.equal((await call('GET', `${S}/activity`))[1].panel, null);
    live({ status: 'waiting' }); fake.screen = screenOf(['Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel']);
    const [c5, o5] = await call('POST', `${S}/panel`, { key: 'enter' });
    assert.equal(c5, 409); assert.equal(o5.menu.kind, 'permission');
    assert.deepEqual(fake.writes, []);
    // an old panel above the prompt (it closed): none
    open = false; fake.screen = ['▔'.repeat(60), '   Settings  Status  Config  Usage', '', '   Esc to cancel', '', ...box()].join('\r\n');
    live({ status: 'idle' });
    assert.equal((await call('GET', `${S}/activity`))[1].panel, null);
    // bad input; an overseer's is Henry's (the relay's key)
    start();
    for (const bad of [{}, { key: 'space' }, { key: 'esc', tab: 1 }, { tab: -1 }, { tab: 20 }, { tab: '1' }, { key: '\x1b' }]) assert.equal((await call('POST', `${S}/panel`, bad))[0], 400, JSON.stringify(bad));
    start({ role: 'bot:0123456789ab' });
    assert.equal((await call('POST', `${S}/panel`, { key: 'esc' }))[0], 403);
    assert.equal((await call('POST', `${S}/panel`, { key: 'esc', via: 'phone' }))[0], 403, 'no relay key');
    assert.deepEqual(fake.writes, []);
    const [c6] = await call('POST', `${S}/panel`, { key: 'down', via: 'phone' }, { 'x-fleet-view-relay': API.relayKey() });
    assert.equal(c6, 200);
    ok('panel: nothing pressed with no panel up, a question up (409 with it) or an old frame; bad input; an overseer\'s is Henry\'s');
  }

  // ---------- bash mode (message with shell) ----------
  {
    // a fake Claude Code: "!" into an empty box switches to bash mode (its prefix "!"), the paste goes after it, Enter runs it
    let bash = false, typed = '', asText = false;
    const draw = () => { fake.screen = screenOf(['done.', '', ...(bash ? [RULE, `! ${typed}`, RULE, '  ! for bash mode'] : box(typed))]); };
    const start = (o = {}) => {
      reset(); live({ status: 'idle', ...o }); bash = false; typed = o.typed || ''; asText = !!o.asText; draw();
      fake.onWrite = (w) => {
        if (w === '!' && !typed && !bash && !asText) bash = true;
        else if (w === '!') typed += '!';
        else if (w === '\x7f') typed = typed.slice(0, -1);
        else if (w.startsWith('\x1b[200~')) typed += w.slice(6, -6);
        else if (w === '\r') { bash = false; typed = ''; }
        draw();
      };
    };
    start();
    const [code, out] = await call('POST', `${S}/message`, { text: 'git status', shell: true });
    assert.equal(code, 200, out.message);
    assert.equal(out.shell, true);
    assert.equal(fake.writes[0], '!');
    assert.equal(pasted(), 'git status');
    assert.equal(fake.writes[fake.writes.length - 1], '\r');
    // its own "!" is the mode's
    start();
    assert.equal((await call('POST', `${S}/message`, { text: '!ls -la', shell: true }))[0], 200);
    assert.equal(pasted(), 'ls -la');
    // something typed in the box, or a menu up: nothing pressed, never queued
    start({ typed: 'a draft' });
    const [c2, o2] = await call('POST', `${S}/message`, { text: 'git status', shell: true, queue: true });
    assert.equal(c2, 409);
    assert.match(o2.message, /typed in its prompt/);
    assert.deepEqual(fake.writes, []);
    start(); fake.screen = screenOf(['Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel']);
    assert.equal((await call('POST', `${S}/message`, { text: 'git status', shell: true, queue: true }))[0], 409);
    assert.deepEqual(fake.writes, []);
    assert.ok(!API.queuedIds().includes(ID), 'a shell command is never queued');
    // the "!" taken as text: taken back with a Backspace, nothing pasted
    start({ asText: true });
    const [c3, o3] = await call('POST', `${S}/message`, { text: 'git status', shell: true });
    assert.equal(c3, 409);
    assert.match(o3.message, /as text/);
    assert.deepEqual(fake.writes, ['!', '\x7f']);
    // bad input
    assert.equal((await call('POST', `${S}/message`, { text: 'x', shell: 'yes' }))[0], 400);
    assert.equal((await call('POST', `${S}/message`, { text: 'x', shell: true, now: true }))[0], 400);
    assert.equal((await call('POST', `${S}/message`, { text: '!', shell: true }))[0], 400);
    assert.equal((await call('POST', `${S}/message`, { text: 'x', shell: true, from: ID }))[0], 400);
    // an overseer's: Henry's only
    start({ role: 'bot:0123456789ab' });
    assert.equal((await call('POST', `${S}/message`, { text: 'git status', shell: true }))[0], 403);
    assert.deepEqual(fake.writes, []);
    // a plain message starting with "!" is still pasted as text
    start();
    assert.equal((await call('POST', `${S}/message`, { text: '!important: read this' }))[0], 200);
    assert.ok(!fake.writes.includes('!'));
    assert.equal(pasted(), '!important: read this');
    ok('message shell: "!" as a key into an empty box, then the command and Enter; refused over a draft or a menu, never queued; "!" taken as text taken back');
  }

  // ---------- rewind and edit ----------
  {
    // the screen readers: the list's ❯ entry and where it is; an entry matches by the first line, cut with "…"
    const LIST_HEAD = ' Restore the code and/or conversation to the point before…';
    assert.deepEqual(SCREEN.rewindList(['', ' Rewind', '', LIST_HEAD, '', '   ↑ 3 more', '   fix it', ' ❯ Reply ALPHA.', '   (current)']), { sel: 'Reply ALPHA.', sig: '4|3|Reply ALPHA.' });
    assert.equal(SCREEN.rewindList(['some output', RULE, '❯ Reply ALPHA.', RULE]), null);
    // a typed "/rewind" whose Enter didn't take: its suggestion above the prompt is no list (2.1.301)
    const SUGGEST = ['● ALPHA', '  ❯ /rewind                     Restore the code and/or conversation', '                                to a previous point', RULE, '❯ /rewind', RULE];
    assert.equal(SCREEN.rewindList(SUGGEST), null);
    assert.ok(SCREEN.rewindMatches('Reply ALPHA.', 'Reply ALPHA.\nand more'));
    assert.ok(SCREEN.rewindMatches('Look at the long th…', 'Look at the long thing  here'));
    assert.ok(!SCREEN.rewindMatches('Look at the long th', 'Look at the long thing'));
    assert.ok(!SCREEN.rewindMatches('(current)', '(current)'));
    assert.ok(SCREEN.rewindMatches('see this', '[Image #1] see this'));
    ok('screen.js: /rewind\'s list (the ❯ entry, its sig) and an entry matching a message');

    // a fake Claude Code: the prompt, /rewind's list (newest at the bottom, (current) last) and its restore question
    let entries = [], ptr = 0, at = 'prompt', boxNow = '', picked = null;
    const draw = () => {
      if (at === 'list') {
        fake.screen = screenOf(['', ' Rewind', '', LIST_HEAD, '', ...entries.map((e, i) => (i === ptr ? ` ❯ ${e}` : `   ${e}`)), '', ' Enter to continue · Esc to exit']);
      } else if (at === 'confirm') {
        fake.screen = screenOf(['', ' Rewind', '', ' Confirm you want to restore to the point before you sent this message:', '', `   ${picked}`, '',
          ' ❯ 1. Restore code and conversation', '   2. Restore conversation', '   3. Restore code', '   4. Never mind', '', ' Enter to select · Esc to cancel']);
      } else fake.screen = screenOf(['● done.', '', ...box(boxNow)]);
    };
    const claude = (list) => {
      reset(); live({ status: 'idle' });
      entries = [...list, '(current)']; ptr = entries.length - 1; at = 'prompt'; boxNow = ''; picked = null; draw();
      fake.onWrite = (w) => {
        if (w.startsWith('\x1b[200~')) { if (at === 'prompt') boxNow += w.slice(6, -6); }
        else if (w === '\r' && at === 'prompt') { if (boxNow === '/rewind') { at = 'list'; ptr = entries.length - 1; } boxNow = ''; }
        else if (w === '\x1b[A' && at === 'list') ptr = Math.max(0, ptr - 1);
        else if (w === '\r' && at === 'list') { picked = entries[ptr]; at = 'confirm'; }
        else if (w === '\x1b') at = 'prompt';
        else if (at === 'confirm' && /^[1-4]$/.test(w)) { at = 'prompt'; if (w === '1' || w === '2') boxNow = picked; }
        else if (w.startsWith('\x15')) boxNow = '';
        draw();
      };
    };
    const rewindState = async (want, ms = 8000) => {
      let r = null;
      for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
        r = (await call('GET', `${S}/activity`))[1].rewind;
        if (r && want.includes(r.state)) return r;
      }
      return r;
    };
    const ups = () => fake.writes.filter((w) => w === '\x1b[A').length;

    // refused, nothing pressed: busy, waiting on an answer, a panel up, a menu up, something typed, an overseer's
    claude(['fix the bug']); live({ status: 'busy' });
    let [c, o] = await call('POST', `${S}/rewind`, { text: 'fix the bug' });
    assert.equal(c, 409); assert.match(o.message, /working/);
    live({ status: 'waiting', waitingFor: 'approve Bash(ls)' });
    [c, o] = await call('POST', `${S}/rewind`, { text: 'fix the bug' });
    assert.equal(c, 409); assert.match(o.message, /waiting on an answer/);
    live({ status: 'waiting', waitingFor: 'dialog open' });
    [c, o] = await call('POST', `${S}/rewind`, { text: 'fix the bug' });
    assert.equal(c, 409); assert.equal(o.panel, true);
    live({ status: 'idle' });
    fake.screen = screenOf(['Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel']);
    [c, o] = await call('POST', `${S}/rewind`, { text: 'fix the bug' });
    assert.equal(c, 409); assert.match(o.message, /asking something/); assert.equal(o.menu.kind, 'permission');
    boxNow = 'a draft'; draw();
    [c, o] = await call('POST', `${S}/rewind`, { text: 'fix the bug' });
    assert.equal(c, 409); assert.match(o.message, /something is typed in its prompt \("a draft"\)/);
    boxNow = ''; draw();
    live({ status: 'idle', role: 'bot:a1b2c3d4e5f6' });
    assert.equal((await call('POST', `${S}/rewind`, { text: 'fix the bug' }))[0], 403);
    assert.equal((await call('POST', `${S}/rewind`, { text: 'fix the bug', via: 'phone' }))[0], 403); // no relay key
    assert.deepEqual(fake.writes, []);
    // bad input
    live({ status: 'idle' });
    for (const bad of [{}, { text: '' }, { text: 'x', nth: -1 }, { text: 'x', nth: 1.5 }, { text: 'x', nth: '1' }, { text: 'x', edit: '' }, { text: 'x', edit: 5 }, { text: 'a\u0001b' }]) {
      assert.equal((await call('POST', `${S}/rewind`, bad))[0], 400, JSON.stringify(bad));
    }
    assert.deepEqual(fake.writes, []);
    ok('rewind: refused while busy, waiting, a panel or a menu is up, something is typed, an overseer\'s from a session, or bad input; nothing pressed');

    // Rewind: "/rewind", Enter, ↑ to the older of two "fix the bug" (nth 1), Enter; the restore question is the caller's
    claude(['fix the bug', 'Reply ALPHA.', 'fix the bug', 'thanks']);
    [c, o] = await call('POST', `${S}/rewind`, { text: 'fix the bug', nth: 1 });
    assert.equal(c, 200, o.message);
    assert.equal(picked, 'fix the bug');
    assert.equal(ptr, 0);
    assert.equal(pasted(), '/rewind');
    assert.deepEqual(fake.writes.slice(0, 2), ['\x1b[200~/rewind\x1b[201~', '\r']);
    assert.equal(ups(), 4);
    assert.equal(fake.writes[fake.writes.length - 1], '\r');
    assert.ok(o.menu && o.menu.options.some((x) => x.label === 'Restore conversation'), JSON.stringify(o.menu));
    const asking = await rewindState(['asking']);
    assert.equal(asking.state, 'asking');
    assert.equal(asking.at, o.at); // the caller tells this one from an older one by it
    assert.deepEqual([asking.text, asking.edit], ['fix the bug', null]);
    // answered "Restore conversation" (the phone's menu card): the message comes back into its prompt, and is cleared there
    const [ca, oa] = await call('POST', `${S}/answer`, { option: 2, sig: o.menu.sig, allowPermission: true });
    assert.equal(ca, 200, oa.message);
    const done = await rewindState(['restored', 'kept', 'failed']);
    assert.equal(done.state, 'restored', JSON.stringify(done));
    assert.equal(done.text, 'fix the bug');
    assert.equal(boxNow, '');
    assert.ok(fake.writes.some((w) => w.startsWith('\x15')));
    assert.equal(pasted(), '/rewind'); // nothing else typed
    ok('rewind: /rewind, ↑ to the nth message with that text from the newest, Enter; the restore question left to the caller; the restored message cleared from its prompt');

    // Edit: the newest "fix the bug" (nth 0); once restored, the edit goes in its place
    claude(['fix the bug', 'Reply ALPHA.', 'fix the bug', 'thanks']);
    [c, o] = await call('POST', `${S}/rewind`, { text: 'fix the bug', edit: 'fix the other bug' });
    assert.equal(c, 200, o.message);
    assert.equal(ptr, 2);
    assert.equal(ups(), 2);
    assert.match(o.message, /your edit goes in/);
    await call('POST', `${S}/answer`, { option: 1, sig: o.menu.sig, allowPermission: true });
    const sent = await rewindState(['sent', 'restored', 'kept', 'failed']);
    assert.equal(sent.state, 'sent', JSON.stringify(sent));
    assert.equal(sent.edit, 'fix the other bug');
    assert.equal(pasted(), '/rewindfix the other bug');
    assert.equal(fake.writes[fake.writes.length - 1], '\r');
    ok('rewind with edit: once the restore put the message back, it is cleared and the edit sent in its place');

    // Edit answered "Never mind": the conversation stays as it was, the edit is not sent ("kept")
    claude(['fix the bug']);
    [c, o] = await call('POST', `${S}/rewind`, { text: 'fix the bug', edit: 'something else' });
    assert.equal(c, 200, o.message);
    await call('POST', `${S}/answer`, { option: 4, sig: o.menu.sig, allowPermission: true });
    const kept = await rewindState(['sent', 'restored', 'kept', 'failed']);
    assert.equal(kept.state, 'kept', JSON.stringify(kept));
    assert.equal(kept.edit, 'something else');
    assert.equal(pasted(), '/rewind');
    ok('rewind with edit, Never mind: nothing restored, the edit not sent (kept)');

    // not in the list: up to the top, then Esc; a second one with that text that isn't there: says how many there are
    claude(['fix the bug', 'thanks']);
    [c, o] = await call('POST', `${S}/rewind`, { text: 'never said this' });
    assert.equal(c, 409); assert.equal(o.notFound, true); assert.match(o.message, /isn't in \/rewind's list/);
    assert.equal(fake.writes[fake.writes.length - 1], '\x1b');
    assert.equal(at, 'prompt');
    claude(['fix the bug', 'thanks']);
    [c, o] = await call('POST', `${S}/rewind`, { text: 'fix the bug', nth: 1 });
    assert.equal(c, 409); assert.match(o.message, /one message with that text, not 2/);
    assert.equal(at, 'prompt');
    // the list never opens (Claude Code took "/rewind" as text): it is cleared from its prompt again
    claude(['fix the bug']);
    fake.onWrite = (w) => {
      if (w.startsWith('\x1b[200~')) boxNow += w.slice(6, -6);
      else if (w.startsWith('\x15')) boxNow = '';
      draw();
    };
    [c, o] = await call('POST', `${S}/rewind`, { text: 'fix the bug' });
    assert.equal(c, 409); assert.match(o.message, /did not open.*cleared/);
    assert.equal(boxNow, '');
    assert.ok(!fake.writes.includes('\x1b'));
    ok('rewind: a message not in the list, or not that many times, gets Esc and 409; a list that never opened leaves nothing in the prompt');

    // ---------- fork from a message ----------
    // the original in its folder on disk; the host's create starts the fork as new-91 (pid 777; a key no test above used), whose screen is the
    // fake Claude Code above (the original's is never read or typed into)
    Object.assign(ctx, { UNSAFE_PATH: /["%^&|<>\x00-\x1f]/, allowedFolders: () => [dir], whereIs: (id) => (id === ID ? { known: true, cwd: dir, account: 'A' } : { known: false }), accounts: () => ['A', 'B'] });
    const FORK = { id: 'new-91', pid: 777, alive: true, status: null, pending: true, account: 'A', cols: 80, rows: 24 };
    const forkOf = (o = {}) => { fake.onOpen = (a) => { fake.list = [...fake.list.filter((x) => x.id !== FORK.id), { ...FORK }]; return { ok: true, key: FORK.id, pid: FORK.pid, forkFrom: a.forkFrom, ...o }; }; };
    const forkState = async (want, ms = 15000) => {
      let f = null;
      for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
        f = (await call('GET', `/api/sessions/${FORK.id}/activity`))[1].fork;
        if (f && want.includes(f.state)) return f;
      }
      return f;
    };
    const F = `${S}/fork`;

    // refused, nothing started: bad input, an overseer's from a session, a conversation not on disk, an older host
    claude(['fix the bug']); fake.opened = null; forkOf();
    for (const bad of [{}, { text: '' }, { text: 'x', nth: -1 }, { text: 'x', nth: 1.5 }, { text: 'x', nth: '1' }, { text: 'a\u0001b' }]) {
      assert.equal((await call('POST', F, bad))[0], 400, JSON.stringify(bad));
    }
    live({ status: 'idle', role: 'bot:a1b2c3d4e5f6' });
    assert.equal((await call('POST', F, { text: 'fix the bug' }))[0], 403);
    assert.equal((await call('POST', F, { text: 'fix the bug', via: 'phone' }))[0], 403); // no relay key
    fake.list = [];
    assert.equal((await call('POST', '/api/sessions/0000000b-0000-4000-8000-000000000000/fork', { text: 'fix the bug' }))[0], 404);
    assert.equal(fake.opened, null);
    forkOf({ forkFrom: undefined });
    [c, o] = await call('POST', F, { text: 'fix the bug' });
    assert.equal(c, 502); assert.match(o.message, /too old to fork/);
    assert.deepEqual(fake.writes, []);
    ok('fork: refused on bad input, an overseer\'s from a session, a conversation not on disk; an older host\'s plain start is stopped');

    // the older of two "fix the bug" (nth 1): answered at once with the fork's key; once the fork is up, /rewind, ↑ to
    // it, Enter, "Restore conversation" (2, never 1: code and conversation), and the message cleared from its prompt.
    // The original is not running: the fork starts in its folder under its account
    claude(['fix the bug', 'Reply ALPHA.', 'fix the bug', 'thanks']); fake.list = []; forkOf();
    [c, o] = await call('POST', F, { text: 'fix the bug', nth: 1 });
    assert.equal(c, 200, o.message);
    assert.equal(o.key, 'new-91'); assert.equal(o.forkFrom, ID); assert.equal(typeof o.at, 'number');
    assert.deepEqual(fake.opened, { cwd: dir, account: 'A', forkFrom: ID });
    assert.deepEqual(fake.writes, []); // nothing typed before it is up
    const going = (await call('GET', '/api/sessions/new-91/activity'))[1].fork;
    assert.equal(going.state, 'working'); assert.equal(going.at, o.at); assert.equal(going.from, ID);
    const forked = await forkState(['done', 'failed']);
    assert.equal(forked.state, 'done', JSON.stringify(forked));
    assert.equal(forked.text, 'fix the bug');
    assert.equal(picked, 'fix the bug'); assert.equal(ptr, 0);
    assert.equal(pasted(), '/rewind');
    assert.ok(fake.writes.includes('2') && !fake.writes.includes('1'), JSON.stringify(fake.writes));
    assert.equal(boxNow, '');
    assert.ok(fake.writes.some((w) => w.startsWith('\x15')));
    ok('fork: answered once the fork started; once up, /rewind to the nth message, "Restore conversation" only, the message cleared from its prompt');

    // followed by its pid through the host's re-key (new-91 to its id): the key still reads it once it looked again
    const FID = '0000000c-0000-4000-8000-000000000000';
    fake.list = [{ ...FORK, id: FID, pending: false }];
    await sleep(2500); // (it looks every 2 s)
    const fa = (await call('GET', '/api/sessions/new-91/activity'))[1];
    assert.equal(fa.id, FID); assert.equal(fa.fork.state, 'done');
    // a session that is not that fork has none
    live({ status: 'idle', pid: 900 });
    assert.equal((await call('GET', `${S}/activity`))[1].fork, null);
    ok('fork: its activity follows it by its pid through a re-key; another session\'s says none');

    // a message not in the fork's list: Esc, and it keeps the whole conversation
    claude(['fix the bug', 'thanks']); fake.list = []; Object.assign(FORK, { id: 'new-92', pid: 778 }); forkOf();
    [c, o] = await call('POST', F, { text: 'never said this' });
    assert.equal(c, 200, o.message);
    const failed = await forkState(['done', 'failed']);
    assert.equal(failed.state, 'failed'); assert.match(failed.message, /isn't in \/rewind's list.*whole conversation/);
    assert.equal(at, 'prompt');
    ok('fork: a message not in its /rewind list gets Esc, and the fork keeps the whole conversation (failed)');
  }

  const paths = API.ENDPOINTS.map((e) => `${e.method} ${e.path}`);
  for (const p of ['POST /api/sessions/:id/now', 'POST /api/sessions/:id/unsend', 'POST /api/sessions/:id/model', 'GET /api/sessions/:id/activity',
    'POST /api/sessions/:id/enter', 'POST /api/sessions/:id/background', 'POST /api/sessions/:id/mode', 'POST /api/sessions/:id/rewind', 'POST /api/sessions/:id/fork', 'POST /api/sessions/:id/panel']) assert.ok(paths.includes(p), p);
  ok('GET /api lists the new verbs');
})().then(() => { console.log(`${n} tests passed`); }, (e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { server.close(); setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(); }, 100); });
