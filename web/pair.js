// The pairing page (pair.html, remote.js on the server). A browser on another device that the PC has not approved
// yet lands here: it asks for a code (POST /remote/pair { label }), shows "Approve this device on the PC: code
// 123456", and asks every 2 s whether the PC allowed it (GET /remote/pair/status). Allowed: the server sets the
// device cookie with that answer and this goes to the page itself. Denied or run out (10 minutes): "Ask again".
// The label is a short guess from the user agent ("Mac · Safari"), so the PC can tell which device is asking.
'use strict';
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var timer = null;

  function guessLabel() {
    var ua = navigator.userAgent || '';
    var touch = (navigator.maxTouchPoints || 0) > 1;
    var os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && touch) ? 'iPad' : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
      : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'Device';
    var browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
      : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    return os + ' · ' + browser;
  }
  function show(title, msg, opts) {
    opts = opts || {};
    $('title').textContent = title;
    $('code').hidden = !opts.code;
    if (opts.code) $('code').textContent = opts.code;
    $('msg').textContent = msg || '';
    $('msg').className = 'msg' + (opts.bad ? ' bad' : '');
    $('again').hidden = !opts.again;
  }
  function stop() { clearTimeout(timer); timer = null; }
  function json(r) { return r.json().catch(function () { return {}; }).then(function (j) { j.status = r.status; return j; }); }

  function ask() {
    stop();
    show('Asking the PC…', '');
    fetch('/remote/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: guessLabel() }), credentials: 'same-origin' })
      .then(json)
      .then(function (j) {
        if (!j.ok) return show('Not now', j.message || 'The PC did not take the request.', { bad: true, again: true });
        waiting(j.code);
        timer = setTimeout(check, 2000);
      })
      .catch(function () { show('Can’t reach the PC', 'Is it on, with Fleet View running?', { bad: true, again: true }); });
  }
  function waiting(code) {
    show('Approve this device on the PC', 'Fleet View on the PC shows “' + guessLabel() + ' wants to use Fleet View” with this code. Allow it there, and this page goes on by itself.', { code: code });
    document.title = 'Fleet View · code ' + code;
  }
  function check() {
    fetch('/remote/pair/status', { cache: 'no-store', credentials: 'same-origin' })
      .then(json)
      .then(function (j) {
        if (j.approved) { show('Approved', 'Opening Fleet View…'); location.replace('/'); return; }
        if (j.denied) return show('Not allowed', 'The PC said no to this device.', { bad: true, again: true });
        if (!j.ok || !j.waiting) return show('The request ran out', j.message || 'Nobody answered it on the PC within 10 minutes.', { bad: !j.ok, again: true });
        timer = setTimeout(check, 2000);
      })
      .catch(function () { timer = setTimeout(check, 4000); });
  }

  $('again').addEventListener('click', ask);
  fetch('/remote/me', { cache: 'no-store', credentials: 'same-origin' }).then(json).then(function (j) {
    if (j.name) $('pc').textContent = j.name.split('.')[0];
    if (j.approved) location.replace('/');
  }).catch(function () {});
  ask();
})();
