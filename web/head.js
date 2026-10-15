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
(function () {
  window.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t.tagName === 'LINK' && /(^|\s)stylesheet(\s|$)/i.test(t.rel || '')) t.remove();
  }, true);
  var q = location.search, h = document.documentElement, electron = navigator.userAgent.indexOf('Electron') >= 0;
  if (/[?&]glass=1(&|$)/.test(q) || electron) h.classList.add('glass');
  var wco = navigator.windowControlsOverlay;
  if (electron && (/[?&]titlebar=overlay(&|$)/.test(q) || (wco && wco.visible))) h.classList.add('titlebar');
  if (/[?&]solo=chats(&|$)/.test(q)) h.classList.add('solo');
  if (/[?&]mac=1(&|$)/.test(q) || (electron && /Mac/.test(navigator.platform || navigator.userAgent))) h.classList.add('mac');
})();
