// Tests for web/compose.js messageText: every image path in a message must reach Claude Code as one it turns into
// [Image #N]. typeInto pastes each line on its own (term.js pasteWrites); within a paste Claude Code (2.1.x, read
// from its bundle) splits at a space before "/" or a drive letter and at new lines, takes outer quotes off a piece,
// and reads a piece ending in .png/.jpg/.jpeg/.gif/.webp as an image file. Run: node scripts/compose-message-test.mjs
import assert from 'node:assert/strict';
import { messageText, parseRewind } from '../web/compose.js';
import { pasteWrites } from '../web/term.js';

const IMG = /\.(png|jpe?g|gif|webp)$/i;
const unquote = (e) => ((e.startsWith('"') && e.endsWith('"')) || (e.startsWith("'") && e.endsWith("'")) ? e.slice(1, -1) : e);
// the image paths Claude Code takes from one paste
const imagesIn = (paste) => paste.split(/ (?=\/|[A-Za-z]:\\)/).flatMap((x) => x.split('\n')).filter((x) => x.trim())
  .map((x) => unquote(x.trim())).filter((x) => IMG.test(x));
// what Claude Code makes images of, typing msg the way the compose box does
const images = (msg) => pasteWrites(msg).filter((w) => w.startsWith('\x1b[200~'))
  .flatMap((w) => imagesIn(w.slice(6, -6)));

const MAC = '/Users/henry/Library/Application Support/fleet-view/chat-images/4b83053f48407e54.png';
const WIN = 'C:\\Users\\henry\\AppData\\Local\\fleet-view\\chat-images\\0a1b2c3d4e5f6a7b.png';
const WIN_SPACE = 'C:\\Users\\John Smith\\AppData\\Local\\fleet-view\\chat-images\\0a1b2c3d4e5f6a7b.jpg';
const DOC = 'C:\\my docs\\notes.pdf';

// the Mac: its chat-images folder has a space in it
assert.deepEqual(images(messageText('look at this', [MAC])), [MAC]);
assert.deepEqual(images(messageText('', [MAC])), [MAC]);
assert.deepEqual(images(messageText('two', [MAC, MAC.replace('4b83', 'ffff')])), [MAC, MAC.replace('4b83', 'ffff')]);
// Windows, with and without a space
assert.deepEqual(images(messageText('look', [WIN])), [WIN]);
assert.deepEqual(images(messageText('look', [WIN_SPACE, WIN])), [WIN_SPACE, WIN]);
// another file's path (quoted) next to images: the images still go in, the file stays text
assert.deepEqual(images(messageText('see', [WIN, DOC, MAC])), [WIN, MAC]);
assert.equal(messageText('see', [WIN, DOC]), `see "${DOC}"\n${WIN}`);
// a long line: the image is still a paste of its own
assert.deepEqual(images(messageText('x'.repeat(900), [MAC])), [MAC]);
// a message over several lines keeps them
assert.equal(messageText('a\nb', [MAC]), `a\nb\n"${MAC}"`);
// no paths, no images: the text as it was
assert.equal(messageText('  just text  ', []), 'just text');
assert.equal(messageText('', []), '');

// pasteWrites: a text ending in "\" gets a space after it (Claude Code takes "\" then Enter as a new line, so the
// message would stay unsent in its prompt); a "\" anywhere else stays as it is
const typed = (msg) => pasteWrites(msg).map((w) => (w.startsWith('\x1b[200~') ? w.slice(6, -6) : w)).join('');
assert.equal(typed('It\'s a mistake.?\\'), 'It\'s a mistake.?\\ ');
assert.equal(typed('one\\\ntwo'), 'one\\\ntwo');
assert.equal(typed('C:\\dir\\ next'), 'C:\\dir\\ next');

// parseRewind: /rewind's list, never the suggestion a typed "/rewind" shows above the prompt (2.1.301): read as the
// list, Esc closed only the suggestion and "/rewind" stayed in the prompt, each Edit adding one more
const RULE = '─'.repeat(40);
assert.equal(parseRewind(['● ALPHA', '  ❯ /rewind                     Restore the code and/or conversation', '                                to a previous point', RULE, '❯ /rewind', RULE]), null);
assert.deepEqual(parseRewind(['', ' Rewind', '', ' Restore the code and/or conversation to the point before…', '', '   ↑ 3 more', '   fix it', ' ❯ Reply ALPHA.', '   (current)']), { sel: 'Reply ALPHA.', sig: '4|3|Reply ALPHA.' });

console.log('compose-message-test: ok');
