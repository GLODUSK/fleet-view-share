// Tests for web/compose.js messageText: every image path in a message must reach Claude Code as one it turns into
// [Image #N]. typeInto pastes each line on its own (term.js pasteWrites); within a paste Claude Code (2.1.x, read
// from its bundle) splits at a space before "/" or a drive letter and at new lines, takes outer quotes off a piece,
// and reads a piece ending in .png/.jpg/.jpeg/.gif/.webp as an image file. Run: node scripts/compose-message-test.mjs
import assert from 'node:assert/strict';
import { messageText } from '../web/compose.js';
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

console.log('compose-message-test: ok');
