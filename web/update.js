// Fleet View web: the "Update available" pill (updater.js on the server). GET /update every minute; when the
// folder's git upstream has something new, a pill in the header says how much, and a click opens a card with what
// changed (the commit messages), "Update now", "Check again" and the "update automatically" switch.
// The footer's "v1.0.12" (the version, version.js on the server) opens the same card at any time: "Fleet View 1.0.12 ·
// up to date", Check again and the switch. Versions are numbers; the short commit stands in only when there is none.
// Its controls use data-uact, not data-act: app.js takes every click on a [data-act] for itself (preventDefault,
// which un-ticks a checkbox, and stopPropagation, so this card never hears it).
//
//   mountUpdate({ pill, verBtn?, getJson })  -> { refresh() }
//
// After "Update now" the server pulls: fleet-view.js and web/ reload by themselves (the page reloads with them);
// a change in desktop/ restarts the window (fleetDesktop.relaunch); a changed host.js restarts the session host,
// which waits until no session is mid-turn. An automatic update that changed desktop/ is left for the page to
// finish (relaunchWanted), once nothing is working. "Updated to <version>" shows on the pill for a while after.
import { esc } from './cards.js';

const POLL_MS = 60e3;
const DONE_KEY = 'fv.updatedTo';
const post = async (url, body) => {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    return await r.json();
  } catch (e) { return { ok: false, message: e.message }; }
};

// the versions to show: numbers when both ends have one, else the short commits (never "1.0.10 → 5f1a2b3")
const numbered = (st) => !!(st.currentVersion && st.upstreamVersion);
const fromOf = (st) => (st.behind ? (numbered(st) ? st.currentVersion : st.current) : st.currentVersion || st.version || st.current) || '';
const toOf = (st) => (numbered(st) ? st.upstreamVersion : st.upstream) || '';

export function mountUpdate({ pill, verBtn, getJson }) {
  if (!pill) return { refresh() {} };
  let st = null, card = null, note = '', working = false; // working: false, 'check' or 'apply'
  const desk = () => window.fleetDesktop && typeof window.fleetDesktop.relaunch === 'function' ? window.fleetDesktop : null;
  const remember = (to) => { try { localStorage.setItem(DONE_KEY, JSON.stringify({ to, at: Date.now() })); } catch {} };
  const justDone = (() => { try { const j = JSON.parse(localStorage.getItem(DONE_KEY) || 'null'); return j && Date.now() - j.at < 10 * 60e3 ? j : null; } catch { return null; } })();
  let doneUntil = justDone ? Date.now() + 20e3 : 0;
  if (justDone) { try { localStorage.removeItem(DONE_KEY); } catch {} }

  function drawPill() {
    if (st && st.behind > 0) {
      pill.hidden = false;
      pill.classList.add('update-pill');
      pill.classList.remove('updated');
      pill.innerHTML = `<span class="count-k">Update available</span><b>${st.behind}</b>`;
      pill.title = `${st.behind} change${st.behind === 1 ? '' : 's'} to Fleet View: click to see what changed and update`;
    } else if (Date.now() < doneUntil) {
      pill.hidden = false;
      pill.classList.add('update-pill', 'updated');
      pill.innerHTML = `<span class="count-k">Updated to</span><b>${esc(justDone.to)}</b>`;
      pill.title = 'Fleet View was updated';
    } else {
      pill.hidden = true;
    }
    drawVer();
  }

  // the footer's "v1.0.12": hidden until the server says a version (or at least a commit)
  function drawVer() {
    if (!verBtn || !st) return;
    const v = st.currentVersion || st.version || st.current || '';
    verBtn.hidden = !v;
    const text = v ? (/^\d/.test(v) && /\./.test(v) ? `v${v}` : v) : '';
    if (verBtn.textContent !== text) verBtn.textContent = text;
    verBtn.classList.toggle('behind', st.behind > 0);
    verBtn.title = st.behind > 0 ? `Fleet View ${v}: an update is available` : `Fleet View ${v}: check for updates`;
  }

  function drawCard() {
    if (!card || !st) return;
    const warn = [];
    if (st.error) warn.push(st.error);
    if (st.dirtyLock) warn.push('desktop\\package-lock.json was changed on this computer (npm install does that), and this update changes it too. Put it back with: git checkout -- desktop/package-lock.json, in the Fleet View folder.');
    else if (st.dirty) warn.push('Files in the Fleet View folder were changed on this computer, so it can\'t update itself. Undo those changes, or update by hand.');
    if (st.needsInstall) warn.push(`This update changes the desktop window's packages, so it goes in with install.ps1: it quits Fleet View (it asks first), updates it and starts it again, and the sessions open again. In PowerShell or Command Prompt: ${st.install || 'install.ps1 in the Fleet View folder'}`);
    const blocked = st.dirty || st.needsInstall || !st.behind;
    // "1.0.10 → 1.0.12" when behind, else "Fleet View 1.0.12 · up to date"; the commits in the tooltip
    const from = fromOf(st), to = toOf(st);
    const commits = st.current ? `commit ${st.current}${st.behind && st.upstream ? ` → ${st.upstream}` : ''}` : '';
    const since = !st.checkedAt ? 'not checked yet' : !st.enabled || st.error ? '' : 'up to date';
    card.innerHTML = `
      <div class="update-head">${st.behind
    ? `<b>Update available</b><span class="update-ver" title="${esc(commits)}">${esc(from)}${to ? ` → ${esc(to)}` : ''}</span>`
    : `<b>Fleet View${from ? ` ${esc(from)}` : ''}</b><span class="update-ver" title="${esc(commits)}">${since ? `· ${since}` : ''}</span>`}
        <button type="button" class="update-x" data-uact="close" aria-label="Close">×</button></div>
      ${st.notes && st.notes.length ? `<div class="update-k">What changed</div><ul class="update-notes">${st.notes.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      ${warn.map((w) => `<div class="update-warn">${esc(w)}</div>`).join('')}
      ${note ? `<div class="update-note">${esc(note)}</div>` : ''}
      <label class="update-auto"><input type="checkbox" data-uact="auto"${st.auto ? ' checked' : ''}> Update automatically when no conversation is working</label>
      <div class="update-acts">
        <button type="button" class="update-btn" data-uact="check"${working ? ' disabled' : ''}>${working === 'check' ? 'Checking…' : 'Check again'}</button>
        ${st.behind || working === 'apply' ? `<button type="button" class="update-btn primary" data-uact="apply"${working || blocked ? ' disabled' : ''}>${working === 'apply' ? 'Updating…' : 'Update now'}</button>` : ''}
      </div>`;
  }

  // from: the button that opened it (the footer's version puts the card above the footer)
  function open(from) {
    if (card) return;
    const atFoot = !!verBtn && from === verBtn;
    card = document.createElement('div');
    card.className = `update-card${atFoot ? ' at-foot' : ''}`;
    if (atFoot) card.style.bottom = `${Math.max(8, window.innerHeight - verBtn.getBoundingClientRect().top + 8)}px`;
    card.addEventListener('click', onClick);
    card.addEventListener('change', onChange);
    document.body.appendChild(card);
    drawCard();
    setTimeout(() => document.addEventListener('mousedown', outside), 0);
    document.addEventListener('keydown', onKey, true);
  }
  function close() {
    if (!card) return;
    card.remove(); card = null; note = '';
    document.removeEventListener('mousedown', outside);
    document.removeEventListener('keydown', onKey, true);
  }
  const outside = (e) => { if (card && !card.contains(e.target) && !pill.contains(e.target) && !(verBtn && verBtn.contains(e.target))) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };

  async function onChange(e) {
    if (e.target?.dataset?.uact !== 'auto') return;
    const r = await post('/update/auto', { on: e.target.checked });
    if (r && r.ok) { st = r; drawCard(); }
  }
  async function onClick(e) {
    const act = e.target?.closest?.('[data-uact]')?.dataset.uact;
    if (act === 'close') return close();
    if (act === 'check') {
      working = 'check'; note = ''; drawCard();
      const r = await post('/update/check');
      working = false;
      if (r && r.ok) st = r; else note = r?.message || 'could not check';
      drawPill(); drawCard();
      return;
    }
    if (act === 'apply') {
      working = 'apply'; note = ''; drawCard();
      const r = await post('/update/apply');
      working = false;
      if (!r || !r.ok) { note = r?.message || 'the update failed'; drawCard(); return; }
      remember(r.toVersion || r.to);
      note = r.relaunch && !desk() ? `${r.message}. Restart Fleet View to finish.` : `${r.message}. Reloading…`;
      st = { ...st, behind: 0, current: r.to, currentVersion: r.toVersion || '', version: r.toVersion || st.version, notes: [] };
      drawPill(); drawCard();
      if (r.relaunch && desk()) setTimeout(() => desk().relaunch(), 1200);
      // a web/ or server change reloads the page by itself; this makes sure of it
      else if (!r.relaunch) setTimeout(() => location.reload(), 6000);
    }
  }

  async function refresh() {
    const j = await getJson('/update');
    if (!j || !j.ok) return;
    st = j;
    // an automatic update changed desktop/: restart the window once nothing is working
    if (j.relaunchWanted && desk() && !j.busy) {
      remember(j.relaunchWanted);
      await post('/update/relaunched');
      desk().relaunch();
      return;
    }
    drawPill(); drawCard();
  }

  pill.addEventListener('click', (e) => { e.stopPropagation(); if (card) close(); else if (st && st.behind > 0) open(pill); });
  if (verBtn) verBtn.addEventListener('click', (e) => { e.stopPropagation(); if (card) close(); else if (st) open(verBtn); });
  drawPill();
  refresh();
  setInterval(refresh, POLL_MS);
  if (doneUntil) setTimeout(drawPill, 20500);
  return { refresh };
}
