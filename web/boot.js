// Fleet View boot watchdog (a plain script, loaded before app.js): if the page's code never starts, load the page again.
// app.js is a module; when it or one of its imports fails to load or parse (a server restart in the middle of the
// load, a bad merge), the browser runs none of it and the page stays blank with nothing to fix it. app.js calls
// window.fvBootOk() once it ran; without that within 15 s (sooner when app.js itself fails to load) this reloads the
// page, waiting longer each time (0 s, 5 s, 15 s, 30 s, then every 60 s). The count of tries lives in sessionStorage
// for this tab and clears once the page starts. From the third try on, a small note says what is going on.
(function () {
  var KEY = 'fv.bootTries', WAIT_MS = 15000, BACKOFF = [0, 5, 15, 30, 60];
  var done = false, failed = false, timer = null, reloading = null;
  function tries() {
    try { return parseInt(sessionStorage.getItem(KEY), 10) || 0; } catch (e) { return 0; }
  }
  function setTries(n) {
    try { if (n) sessionStorage.setItem(KEY, String(n)); else sessionStorage.removeItem(KEY); } catch (e) {}
  }
  function note(text) {
    var el = document.getElementById('fv-boot-note');
    if (!el) {
      if (!document.body) return;
      el = document.createElement('div');
      el.id = 'fv-boot-note';
      el.setAttribute('role', 'status');
      el.title = 'Click to try again now';
      el.style.cssText = 'position:fixed;left:50%;top:40%;transform:translateX(-50%);z-index:2147483647;max-width:90vw;'
        + 'padding:12px 18px;border-radius:10px;background:#1a1d2b;color:#e6e8f2;border:1px solid #3a3f58;'
        + 'font:14px/1.4 system-ui,sans-serif;text-align:center;cursor:pointer';
      el.onclick = function () { location.reload(); };
      document.body.appendChild(el);
    }
    el.textContent = text;
  }
  function fail() {
    if (done || failed) return;
    failed = true;
    clearTimeout(timer);
    var n = tries() + 1;
    setTries(n);
    var wait = BACKOFF[Math.min(n - 1, BACKOFF.length - 1)];
    if (n >= 3) note("Fleet View didn't load, retrying" + (wait ? ' in ' + wait + ' s' : '') + '…');
    reloading = setTimeout(function () { location.reload(); }, wait * 1000);
  }
  window.fvBootOk = function () {
    if (done) return;
    done = true;
    clearTimeout(timer);
    clearTimeout(reloading);
    setTries(0);
    var el = document.getElementById('fv-boot-note');
    if (el) el.remove();
  };
  // app.js (or a module it imports) could not be fetched: no need to wait the whole 15 s. A parse error in an import
  // only shows as a window error, so that one waits for the timer.
  window.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t.tagName === 'SCRIPT' && /\/app\.js(\?|$)/.test(t.src || '')) fail();
  }, true);
  timer = setTimeout(fail, WAIT_MS);
})();
