// The mini view, before anything else loads (a plain script in mini.html's head: the page sends no inline script, see
// fleet-view.js's Content-Security-Policy). The window's kind, as classes on <html>:
//   glass: the desktop mini window (Electron, ?glass=1) has acrylic behind the page, so the page goes see-through
//   mac: on a Mac (or ?mac=1); desktop: in the desktop app (its preload's fleetDesktop)
(function () {
  var h = document.documentElement;
  if (/[?&]glass=1(&|$)/.test(location.search) || navigator.userAgent.indexOf('Electron') >= 0) h.classList.add('glass');
  if (/[?&]mac=1(&|$)/.test(location.search) || (navigator.userAgent.indexOf('Electron') >= 0 && /Mac/.test(navigator.platform || navigator.userAgent))) h.classList.add('mac');
  if (window.fleetDesktop && window.fleetDesktop.isDesktop) h.classList.add('desktop');
})();
