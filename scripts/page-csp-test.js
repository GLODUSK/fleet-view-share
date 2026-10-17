// The page's Content-Security-Policy (page-csp.js): a test, run with the system node:   node scripts/page-csp-test.js
// Checks each directive for the page opened on this PC, from another device over Tailscale and as the pairing page,
// and that a Host header that isn't a plain host name never reaches the policy.
// Exit 0 = all passed.
'use strict';
const path = require('path');
const { pageCsp, splitHost } = require(path.join(__dirname, '..', 'page-csp.js'));

let failures = 0;
const ok = (cond, what) => { if (!cond) { failures++; console.log(`FAIL ${what}`); } };
// the policy as directive -> its sources
const parse = (csp) => new Map(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));

// ---------- on this PC ----------
{
  const csp = pageCsp({ framed: true, host: '127.0.0.1:4777' });
  const d = parse(csp);
  ok(d.get('script-src').join(' ') === "'self' 'wasm-unsafe-eval'", 'scripts only from the server (and WebAssembly for the voice worker)');
  ok(d.get('object-src').join(' ') === "'none'", 'no plugins');
  ok(d.get('base-uri').join(' ') === "'self'", 'no <base> elsewhere');
  ok(d.get('frame-ancestors').join(' ') === "'self'", 'the page frames itself only');
  const c = d.get('connect-src');
  ok(c[0] === "'self'" && c.includes('ws://127.0.0.1:4777') && c.includes('wss://127.0.0.1:4777'), 'connections: this server, its WebSocket included');
  ok(c.includes('https://huggingface.co') && c.includes('https://*.hf.co'), 'connections: the voice model hosts');
  ok(!c.includes('ws:') && !c.includes('wss:') && !c.includes('https:') && !c.includes('*'), 'connections: never any host at all');
  ok(d.get('img-src').join(' ') === "'self' data: blob:", 'images: this server, data: and blob: only');
  ok(d.get('form-action').join(' ') === "'self'", 'forms post here only');
  const f = d.get('frame-src');
  ok(f.includes("'self'") && f.includes('http://localhost:*') && f.includes('http://127.0.0.1:*') && f.includes('http://[::1]:*'), 'frames: the local dev servers');
  ok(!f.some((s) => s.startsWith('https:')), 'frames: no https host on this PC');
  ok(!/default-src|style-src/.test(csp), 'styles (and everything not named) left as they are');
}

// ---------- from another device (Tailscale) ----------
{
  const d = parse(pageCsp({ framed: true, host: 'blackbox.tail1234.ts.net' }));
  ok(d.get('connect-src').includes('wss://blackbox.tail1234.ts.net'), 'remote: the WebSocket on the tailnet name');
  ok(d.get('frame-src').includes('https://blackbox.tail1234.ts.net:*'), "remote: the Preview tab's shared dev servers on the tailnet name");
  ok(parse(pageCsp({ host: 'BlackBox.Tail1234.ts.net:443' })).get('connect-src').includes('wss://blackbox.tail1234.ts.net:443'), 'remote: a port kept, the name lower-cased');
}

// ---------- the pairing page ----------
ok(parse(pageCsp({ framed: false, host: 'localhost:4777' })).get('frame-ancestors').join(' ') === "'none'", 'the pairing page is framed by nobody');

// ---------- a Host header that isn't a plain host ----------
for (const bad of ['', undefined, 'evil.com; script-src *', "a b", 'x.com/path', 'x.com:99999999', 'x.com:80 https:']) {
  const csp = pageCsp({ host: bad });
  ok(splitHost(bad) === null, `not a host: ${JSON.stringify(bad)}`);
  ok(!/evil|path|https: |99999999/.test(csp) && parse(csp).get('script-src').join(' ') === "'self' 'wasm-unsafe-eval'", `a bad Host stays out of the policy: ${JSON.stringify(bad)}`);
  ok(!parse(csp).get('connect-src').some((s) => /^wss?:/.test(s)), `no WebSocket source without a good Host: ${JSON.stringify(bad)}`);
}
ok(JSON.stringify(splitHost('[::1]:4777')) === '["[::1]","4777"]', 'an IPv6 literal with its port');
ok(JSON.stringify(splitHost('localhost')) === '["localhost",null]', 'a name without a port');

console.log(failures ? `${failures} failed` : 'ok: page-csp');
process.exit(failures ? 1 : 0);
