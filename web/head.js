// Fleet View's page, before anything else loads (a plain script, first in index.html's head: the page sends no inline
// script, see fleet-view.js's Content-Security-Policy).
// A stylesheet that fails to load is taken out again, so it can't hold up the page (what each link's
// onerror="this.remove()" used to do): error events don't bubble, but a listener on window in the capture phase sees them.
// The window's kind, as classes on <html>, before the stylesheets apply:
//   glass: the desktop window (Electron, ?glass=1) has acrylic behind the page, so the page goes see-through.
//   titlebar: that window has no title bar of its own (titlebar=overlay from desktop/main.js); the header is
//     the drag region and leaves room on the right for the native min / max / close buttons.
//   solo: the Bots pop-out window (?solo=chats): only the Bots view, under its own small header (chats.css).
//   mac: the desktop window on a Mac (or ?mac=1): its vibrancy is darker than Windows acrylic, so the glass tints are lighter.
// Page errors (review 2026-10-17: a map that froze on an error left no trace anywhere): window.fvPageError(err, where)
// sends the first error a minute to the server (POST /page-errors, page-errors.js: <data>/page-errors.log), with how
// many more came since the last one sent; the rest only reach the console. Uncaught errors and unhandled promise
// rejections go there too; the map's frame and rebuild call it for the errors they catch. Only the error's message
// and stack go, never what a conversation says.
(function () {
  window.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t.tagName === 'LINK' && /(^|\s)stylesheet(\s|$)/i.test(t.rel || '')) t.remove();
  }, true);
  var errAt = 0, errMore = 0;
  window.fvPageError = function (err, where) {
    try {
      var now = Date.now();
      if (now - errAt < 60000) { errMore++; return; }
      errAt = now;
      var o = err && typeof err === 'object' ? err : { message: String(err) };
      var body = { where: String(where || 'page').slice(0, 40), message: String(o.message || o.name || 'error').slice(0, 300),
        stack: String(o.stack || '').slice(0, 2000), more: errMore };
      errMore = 0;
      fetch('/page-errors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true })
        .catch(function () {});
    } catch (x) { /* no server, no fetch */ }
  };
  // uncaught errors (a script or stylesheet that failed to load has no message and doesn't bubble: not these)
  window.addEventListener('error', function (e) {
    if (!e || (!e.error && !e.message)) return;
    window.fvPageError(e.error || { message: e.message, stack: (e.filename || '') + ':' + (e.lineno || 0) + ':' + (e.colno || 0) }, 'window');
  });
  window.addEventListener('unhandledrejection', function (e) { window.fvPageError(e && e.reason, 'promise'); });
  var q = location.search, h = document.documentElement, electron = navigator.userAgent.indexOf('Electron') >= 0;
  if (/[?&]glass=1(&|$)/.test(q) || electron) h.classList.add('glass');
  var wco = navigator.windowControlsOverlay;
  if (electron && (/[?&]titlebar=overlay(&|$)/.test(q) || (wco && wco.visible))) h.classList.add('titlebar');
  if (/[?&]solo=chats(&|$)/.test(q)) h.classList.add('solo');
  if (/[?&]mac=1(&|$)/.test(q) || (electron && /Mac/.test(navigator.platform || navigator.userAgent))) h.classList.add('mac');
})();
