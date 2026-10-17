// Fleet View web: the share repo's health (share-health.js on the server; Henry's own checkouts only, where
// GET /share-health says enabled). Every 5 minutes: when the share repo's CI (every test on macOS and Windows) is red
// on main, or the last publish failed, a red "Share CI" pill shows in the header. Its tooltip says what failed, since
// when and how many runs in a row; a click opens the failing run on GitHub (the publish log's line when it was the
// publish). One desktop notification per red run (or failed publish), while the window is not focused, when
// notifications are on: the last one told is kept in localStorage (fv.shareRed), so a reload never repeats it.
//
//   mountShareHealth({ pill, getJson, notifyOn?, focusWindow? })  -> { refresh() }
const POLL_MS = 5 * 60e3;
const TOLD_KEY = 'fv.shareRed';

const when = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''; };

export function mountShareHealth({ pill, getJson, notifyOn = () => true, focusWindow = () => {} }) {
  if (!pill) return { refresh() {} };
  let timer = null;
  function told(key) {
    try { if (localStorage.getItem(TOLD_KEY) === key) return true; localStorage.setItem(TOLD_KEY, key); } catch {}
    return false;
  }
  function notify(key, title, body, url) {
    if (told(key) || !notifyOn() || document.hasFocus() || !('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(title, { body, tag: 'fv-share-health', silent: true });
      n.onclick = () => { focusWindow(); if (url) window.open(url, '_blank', 'noopener'); n.close(); };
    } catch {}
  }
  function draw(st) {
    const ci = st && st.ci, pub = st && st.publish;
    const ciRed = !!(ci && ci.state === 'red'), pubRed = !!(pub && pub.state === 'failed');
    if (!st || !st.enabled || !(ciRed || pubRed)) { pill.hidden = true; return; }
    const lines = [];
    if (ciRed) lines.push(`The share repo's tests failed on the last ${ci.reds}${ci.more ? '+' : ''} run${ci.reds === 1 ? '' : 's'} on main${ci.since ? `, since ${ci.more ? 'at least ' : ''}${when(ci.since)}` : ''} (${ci.title}).`);
    if (pubRed) lines.push(`The last publish to the share repo failed: ${pub.line}`);
    lines.push(ciRed ? 'Click to open the run on GitHub.' : 'See share-publish.log in Fleet View\'s data folder.');
    pill.hidden = false;
    pill.classList.add('share-health-pill');
    pill.innerHTML = `<span class="count-k">${ciRed ? 'Share CI' : 'Share publish'}</span><b>${ciRed ? '✕' : '!'}</b>`;
    pill.title = lines.join('\n');
    if (ciRed && /^https:\/\/github\.com\//.test(ci.url || '')) { pill.href = ci.url; pill.target = '_blank'; pill.rel = 'noopener'; } else pill.removeAttribute('href');
    if (ciRed) notify(`ci:${ci.id}`, 'Share repo CI is red', lines[0], ci.url);
    else notify(`publish:${pub.at}`, 'Share repo publish failed', lines[0], null);
  }
  async function refresh() {
    clearTimeout(timer);
    try { draw(await getJson('/share-health')); } catch {} finally { timer = setTimeout(refresh, POLL_MS); }
  }
  refresh();
  return { refresh };
}
