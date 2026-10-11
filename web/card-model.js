// Card model: the small pure pieces the cards and the other views read a session's state and numbers with (cards.js
// re-exports them, so the page's modules import them from there as before).
//
// CONTRACT (keep these names and shapes):
//   C                 the page's colours by name ({ bg, panel, line, text, dim, faint, ember, gold, ... }), hex strings
//   isBusy(state)     a conversation's state (s.state) is a working one: 'WORKING' or 'AGENTS'
//   needsYou(state)   it waits on the user: 'ASKING', 'QUESTION', 'ERROR' or 'STALLED'
//   ago(ms)           a duration, short: '42s', '7m', '1.5h'
//   fmtCost(usd)      dollars: '$3.20', '$1,234' from $100 up
//   Nothing here touches the DOM or window, and it imports nothing, so the phone app (phone/) imports it as it is.

export const C = {
  bg: '#0a0c13', panel: '#11141e', line: '#262c42', text: '#eef0fa', dim: '#8a92b2', faint: '#4c5372',
  ember: '#ff6a2b', gold: '#ffc24a', rose: '#ff4d8d', violet: '#a47bff', cyan: '#3fd8ff', mint: '#3dffa8', red: '#ff4d5e',
  agent: '#71a9ff', acctA: '#3fb950', acctB: '#d97757', acctC: '#58a6ff',
};

export const isBusy = (st) => st === 'WORKING' || st === 'AGENTS';
export const needsYou = (st) => st === 'ASKING' || st === 'QUESTION' || st === 'ERROR' || st === 'STALLED';
export const ago = (ms) => (ms < 60e3 ? `${Math.max(0, Math.round(ms / 1e3))}s` : ms < 3600e3 ? `${Math.round(ms / 60e3)}m` : `${(ms / 3600e3).toFixed(1)}h`);
export const fmtCost = (c) => '$' + (c >= 100 ? Math.round(c).toLocaleString('en-US') : (c || 0).toFixed(2));
