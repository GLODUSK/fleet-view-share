// Small line icons, drawn by hand in the lucide style: 24x24 box, stroke currentColor, 1.6 wide, round caps.
// icon(name, size) returns an inline SVG string (no fetch, nothing external); an unknown name returns ''.
// verbIcon(verb) maps a tool call's verb (shell, read, edit, ...) to its icon.

const P = {
  read: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  edit: '<path d="M17 3.5a2.4 2.4 0 0 1 3.5 3.5L8 19.5 3 21l1.5-5Z"/><path d="m15 5.5 3.5 3.5"/>',
  write: '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8Z"/><path d="M14 3v5h5"/><path d="M12 11.5v6"/><path d="M9 14.5h6"/>',
  shell: '<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="m7 9.5 3 2.5-3 2.5"/><path d="M12.5 15h4.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20.5 20.5-4.8-4.8"/>',
  web: '<circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19"/><path d="M12 2.5a14.5 14.5 0 0 1 0 19 14.5 14.5 0 0 1 0-19Z"/>',
  push: '<path d="m17.5 9-5.5-5.5L6.5 9"/><path d="M12 3.5V16"/><path d="M5 20.5h14"/>',
  pr: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v13"/><path d="M13 6h3a2 2 0 0 1 2 2v7.5"/><path d="m15.5 3.5-2.5 2.5 2.5 2.5"/>',
  merge: '<circle cx="6" cy="5.5" r="2.5"/><circle cx="18" cy="17" r="2.5"/><path d="M6 8v13.5"/><path d="M6 8.5a8.5 8.5 0 0 0 9.5 8.5"/>',
  checks: '<circle cx="12" cy="12" r="9.5"/><path d="m8 12.3 2.7 2.7L16.2 9.5"/>',
  live: '<circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4"/><path d="M7.8 16.2a6 6 0 0 1 0-8.4"/><path d="M19.1 4.9a10 10 0 0 1 0 14.2"/><path d="M4.9 19.1a10 10 0 0 1 0-14.2"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
  agent: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4.5"/><circle cx="12" cy="3.5" r="1"/><path d="M9 13v2"/><path d="M15 13v2"/><path d="M2 13.5v2"/><path d="M22 13.5v2"/>',
  plan: '<path d="m3.5 6.5 1.8 1.8L8.5 5"/><path d="m3.5 13.5 1.8 1.8L8.5 12"/><path d="M12 6.5h8.5"/><path d="M12 13.5h8.5"/><path d="M12 20h8.5"/><path d="M4.5 20h3"/>',
  waiting: '<path d="M6 2.5h12"/><path d="M6 21.5h12"/><path d="M7.5 2.5v3.2a3 3 0 0 0 .9 2.1L12 12l3.6-4.2a3 3 0 0 0 .9-2.1V2.5"/><path d="M7.5 21.5v-3.2a3 3 0 0 1 .9-2.1L12 12l3.6 4.2a3 3 0 0 1 .9 2.1v3.2"/>',
  ask: '<path d="M20.5 12a8.5 8.5 0 0 1-12.4 7.6L3.5 21l1.4-4.4A8.5 8.5 0 1 1 20.5 12Z"/><path d="M9.6 9.6a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.5"/><path d="M12 16.8h.01"/>',
  error: '<circle cx="12" cy="12" r="9.5"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  cost: '<circle cx="12" cy="12" r="9.5"/><path d="M15.5 8.5h-5a2 2 0 0 0 0 4h3a2 2 0 0 1 0 4h-5"/><path d="M12 6.5v11"/>',
  tokens: '<path d="M12 3 3 7.5l9 4.5 9-4.5Z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>',
  clock: '<circle cx="12" cy="12" r="9.5"/><path d="M12 7v5l3.2 2"/>',
  branch: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M6 3v12.5"/><path d="M18 8.5A9 9 0 0 1 8.5 18"/>',
  repo: '<path d="M4.5 19V5a2.5 2.5 0 0 1 2.5-2.5h12.5v15.5H7a2.5 2.5 0 0 0 0 5h12.5"/><path d="M9 7h6"/>',
  file: '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8Z"/><path d="M14 3v5h5"/><path d="M8.5 13h7"/><path d="M8.5 16.5h5"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.5h8.8A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z"/>',
  alert: '<path d="M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9.5v4"/><path d="M12 17h.01"/>',
  chevron: '<path d="m9.5 6 6 6-6 6"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2v.8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  floatWin: '<rect x="3" y="3.5" width="18" height="17" rx="2.5"/><rect x="10" y="8.5" width="8" height="8" rx="1.5"/>',
  panelLeft: '<rect x="3" y="3.5" width="18" height="17" rx="2.5"/><path d="M9 3.5v17"/>',
  panelRight: '<rect x="3" y="3.5" width="18" height="17" rx="2.5"/><path d="M15 3.5v17"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  stop: '<circle cx="12" cy="12" r="9.5"/><rect x="8.5" y="8.5" width="7" height="7" rx="1"/>',
  hide: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-2.6 3.4"/><path d="M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  info: '<circle cx="12" cy="12" r="9.5"/><path d="M12 11v6"/><path d="M12 7.5h.01"/>',
  external: '<path d="M14.5 3.5h6v6"/><path d="M10 14 20.5 3.5"/><path d="M18 13.5v5.5a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 3 19V7a1.5 1.5 0 0 1 1.5-1.5H10"/>',
  open: '<path d="M14.5 3.5h4A1.5 1.5 0 0 1 20 5v14a1.5 1.5 0 0 1-1.5 1.5h-4"/><path d="m9.5 16.5 4.5-4.5-4.5-4.5"/><path d="M14 12H3.5"/>',
  // extras used by the views
  model: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9.5 2.5V6"/><path d="M14.5 2.5V6"/><path d="M9.5 18v3.5"/><path d="M14.5 18v3.5"/><path d="M2.5 9.5H6"/><path d="M2.5 14.5H6"/><path d="M18 9.5h3.5"/><path d="M18 14.5h3.5"/>',
  worktree: '<path d="M4 3v13a2 2 0 0 0 2 2h4"/><path d="M4 8h6"/><rect x="12" y="5" width="9" height="6" rx="1.5"/><rect x="12" y="15" width="9" height="6" rx="1.5"/>',
  skill: '<path d="M12 3.5 13.9 9a1 1 0 0 0 .6.6L20 11.5l-5.5 1.9a1 1 0 0 0-.6.6L12 19.5 10.1 14a1 1 0 0 0-.6-.6L4 11.5l5.5-1.9a1 1 0 0 0 .6-.6Z"/>',
  reply: '<path d="M20.5 15a2 2 0 0 1-2 2H8l-4.5 3.5V5.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2Z"/><path d="M8 8.5h8"/><path d="M8 12h5"/>',
  dot: '<circle cx="12" cy="12" r="3.5"/>',
  // the Chat tab (chat.js, compose.js)
  send: '<path d="M21.5 2.5 14.6 21.2a.6.6 0 0 1-1.1 0l-3.2-7.5-7.5-3.2a.6.6 0 0 1 0-1.1Z"/><path d="M21.5 2.5 10.3 13.7"/>',
  attach: '<path d="m20.5 11.3-8.6 8.6a5.6 5.6 0 0 1-8-8l8.4-8.4a3.8 3.8 0 0 1 5.3 5.3l-8.4 8.4a1.9 1.9 0 0 1-2.7-2.7l7.9-7.9"/>',
  image: '<rect x="3" y="3.5" width="18" height="17" rx="2.5"/><circle cx="9" cy="9.5" r="1.8"/><path d="m21 15.5-3.6-3.6a1.6 1.6 0 0 0-2.3 0L5.5 20.5"/>',
  check: '<path d="M20 6.5 9.2 17.3 4 12.1"/>',
  // a team's lead
  star: '<path d="M12 3.2l2.7 5.5 6.1.9-4.4 4.3 1 6-5.4-2.9-5.4 2.9 1-6-4.4-4.3 6.1-.9Z"/>',
  copy: '<rect x="8.5" y="8.5" width="12.5" height="12.5" rx="2"/><path d="M15.5 8.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8.5a2 2 0 0 0 2 2h3.5"/>',
  shield: '<path d="M12 21.5s7.5-3.4 7.5-9.4V5.6L12 2.8 4.5 5.6v6.5c0 6 7.5 9.4 7.5 9.4Z"/><path d="m9 12 2.1 2.1L15.2 10"/>',
  mode: '<path d="M3.5 6h9"/><path d="M17.5 6h3"/><circle cx="15" cy="6" r="2.5"/><path d="M3.5 12h3"/><path d="M11.5 12h9"/><circle cx="9" cy="12" r="2.5"/><path d="M3.5 18h11"/><path d="M19.5 18h1"/><circle cx="17" cy="18" r="2.5"/>',
  think: '<path d="M9 18.5h6"/><path d="M10 21.5h4"/><path d="M12 2.5a6.5 6.5 0 0 0-4 11.6c.6.5 1 1.3 1 2.1v.3h6v-.3c0-.8.4-1.6 1-2.1a6.5 6.5 0 0 0-4-11.6Z"/>',
  down: '<path d="M12 4.5v15"/><path d="m5.5 13 6.5 6.5 6.5-6.5"/>',
  fast: '<path d="M13.5 2.5 5 13.5h6.5l-1 8 8.5-11h-6.5z"/>',
  up: '<path d="M12 19.5v-15"/><path d="m5.5 11 6.5-6.5 6.5 6.5"/>',
  rewind: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 3.5V8H8"/><path d="M12 8v4.5l3 2"/>',
  mic: '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5v4"/><path d="M8.5 21.5h7"/>',
};

export function icon(name, size = 14) {
  const p = P[name];
  if (!p) return '';
  return `<svg class="ic ic-${name}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${p}</svg>`;
}

// tool verbs from the server (describeTool in fleet-view.js) to icon names
const VERB = {
  read: 'read', edit: 'edit', notebookedit: 'edit', write: 'write', shell: 'shell', pwsh: 'shell', bash: 'shell',
  search: 'search', grep: 'search', glob: 'search', web: 'web', plan: 'plan', agent: 'agent', ask: 'ask', skill: 'skill',
  push: 'push', merge: 'merge', pr: 'pr',
};
export const verbIcon = (verb, size = 14) => icon(VERB[String(verb || '').toLowerCase()] || 'chevron', size);
