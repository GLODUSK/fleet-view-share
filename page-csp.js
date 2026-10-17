// The page's Content-Security-Policy: what the browser lets Fleet View's own pages (web/*.html) load, run and send.
// Markup slipped into a name or a message (an escape missed in web/*.js) can't run anything (scripts only from the
// server's own files: no inline script, no on...= handler, no javascript: link, no plugin), and since it can't, the
// rest closes the ways plain markup could still carry data out or steer the page:
//   connect-src  fetch, WebSocket: this server only (ws/wss to the Host the page was opened on, data: and blob: for
//                copying an image), plus the voice model's hosts (huggingface.co and the CDNs it redirects to) for a
//                browser that gives the voice worker the page's policy (Chromium gives it its own)
//   img-src      this server, data: and blob: (pasted images, chat images, the pairing QR code); never another site,
//                so an <img> can't send anything out in its address
//   form-action  forms post only here (the page's forms are all handled in script anyway)
//   frame-src    the Preview tab's frames: local dev servers (http on localhost, 127.0.0.1, [::1], any port) and, on
//                the page opened from another device, this PC's shared ones on its own tailnet name (preview.js)
//   frame-ancestors  who may frame the page: itself (the pairing page: nobody), so another site open in the same
//                browser can't frame it and steer clicks (the remote access switch, Allow)
// 'wasm-unsafe-eval' (WebAssembly, not script) is for the voice worker in a browser that gives workers the page's
// policy. Styles are left as they are.
//   pageCsp({ framed: bool, host?: string }) -> the header's value
//     framed: may the page frame itself (false for the pairing page); host: the request's Host header (127.0.0.1:4777,
//     <pc>.<tailnet>.ts.net), used only when it is a plain host[:port]
'use strict';

const VOICE_HOSTS = ['https://huggingface.co', 'https://*.huggingface.co', 'https://*.hf.co'];
const LOCAL_FRAMES = ['http://localhost:*', 'http://127.0.0.1:*', 'http://[::1]:*'];

// a Host header as [name, port|null], or null for anything that isn't plainly a host name or address
function splitHost(host) {
  const m = /^([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|\[[0-9a-f:.]{2,45}\])(?::(\d{1,5}))?$/i.exec(String(host || ''));
  return m ? [m[1].toLowerCase(), m[2] || null] : null;
}

function pageCsp({ framed = true, host = '' } = {}) {
  const h = splitHost(host);
  const at = h ? h[0] + (h[1] ? `:${h[1]}` : '') : null;
  const remote = h && !/^(?:127\.0\.0\.1|localhost|\[::1\])$/.test(h[0]);
  return [
    "script-src 'self' 'wasm-unsafe-eval'",
    "object-src 'none'",
    "base-uri 'self'",
    `frame-ancestors ${framed ? "'self'" : "'none'"}`,
    ["connect-src 'self'", ...(at ? [`ws://${at}`, `wss://${at}`] : []), 'data:', 'blob:', ...VOICE_HOSTS].join(' '),
    "img-src 'self' data: blob:",
    "form-action 'self'",
    ["frame-src 'self'", ...LOCAL_FRAMES, ...(remote ? [`https://${h[0]}:*`] : [])].join(' '),
  ].join('; ');
}

module.exports = { pageCsp, splitHost };
