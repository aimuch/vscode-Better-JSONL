// Inline stroke icons. They use currentColor (plus optional --ic-2 dual-tone accent), so they follow the theme.
const P: Record<string, string> = {
  formatted: '<path d="M3 3.5h10M5 6.5h8M5 9.5h6M3 12.5h10"/>',
  grid: '<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M2 6.5h12M2 9.8h12M6.5 3v10"/>',
  graph:
    '<rect x="1.5" y="6" width="4" height="4" rx="1"/><rect x="10.5" y="2" width="4" height="4" rx="1"/><rect x="10.5" y="10" width="4" height="4" rx="1"/><path d="M5.5 8h2.5M8 4v8M8 4h2.5M8 12h2.5"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4 14 14"/>',
  'chev-up': '<path d="M4 10l4-4 4 4"/>',
  'chev-down': '<path d="M4 6l4 4 4-4"/>',
  'chev-left': '<path d="M10 4 6 8l4 4"/>',
  'chev-right': '<path d="M6 4l4 4-4 4"/>',
  filter: '<path d="M2 3h12l-4.6 5.4V13l-2.8 1.2V8.4z"/>',
  warning: '<path d="M8 2 15 14H1z"/><path d="M8 6.5v3.2M8 11.6v.4"/>',
  edit: '<path d="M11 2.5 13.5 5 6 12.5H3.5V10z"/>',
  copy: '<rect x="5" y="5" width="8.5" height="8.5" rx="1"/><path d="M3 10.5V3h7.5"/>',
  goto: '<path d="M9 3h4v4M13 3 7 9M11 9.5V13H3V5h3.5"/>',
  download: '<path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 13.5h11"/>',
  'file-code':
    '<path d="M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5z"/><path d="M9.5 1.5V5H13"/><path class="ic-2" d="M6.5 8.5 5 10l1.5 1.5M9.5 8.5 11 10l-1.5 1.5"/>',
  plus: '<path d="M3 8h10M8 3v10"/>',
  follow: '<path d="M2 4h7M2 8h7M2 12h5"/><path class="ic-2" d="M12.5 3v9M10 9.5l2.5 2.5 2.5-2.5"/>',
  compare:
    '<rect x="1.5" y="2.5" width="5" height="11" rx="1"/><path d="M3 6h2M3 9h2"/><rect class="ic-2" x="9.5" y="2.5" width="5" height="11" rx="1"/><path class="ic-2" d="M11 6h2M11 9h2"/>',
  minus: '<path d="M3 8h10"/>',
  fit: '<path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  wrap: '<path d="M2 3.5h12M2 12.5h3"/><path class="ic-2" d="M2 7.5h9.5a2.5 2.5 0 0 1 0 5H8M9.5 10.5 7.5 12.5l2 2"/>',
  gear:
    '<path d="M6.76 3.21 6.92 1.54h2.16l.16 1.67a4.95 4.95 0 0 1 2.29 1.32l1.52-.7 1.09 1.88-1.37.97a4.95 4.95 0 0 1 0 2.64l1.37.97-1.09 1.88-1.52-.7a4.95 4.95 0 0 1-2.29 1.32l-.16 1.67H6.92l-.16-1.67a4.95 4.95 0 0 1-2.29-1.32l-1.52.7-1.09-1.88 1.37-.97a4.95 4.95 0 0 1 0-2.64l-1.37-.97 1.09-1.88 1.52.7a4.95 4.95 0 0 1 2.29-1.32z"/><circle class="ic-2" cx="8" cy="8" r="1.95"/>',
  bookmark: '<path d="M4 2.2h8a.8.8 0 0 1 .8.8v10.8L8 10.6l-4.8 3.2V3a.8.8 0 0 1 .8-.8z"/>',
  columns: '<rect x="1.8" y="2.5" width="12.4" height="11" rx="1"/><path class="ic-2" d="M6 2.5v11M10 2.5v11"/>',
  schema: '<path d="M5 3.2C3.8 3.2 3.2 3.8 3.2 5v1.6c0 .8-.5 1.4-1.4 1.4.9 0 1.4.6 1.4 1.4V11c0 1.2.6 1.8 1.8 1.8"/><path class="ic-2" d="M11 3.2c1.2 0 1.8.6 1.8 1.8v1.6c0 .8.5 1.4 1.4 1.4-.9 0-1.4.6-1.4 1.4V11c0 1.2-.6 1.8-1.8 1.8"/>',
  timeline: '<path d="M2 13.5h12"/><path class="ic-2" d="M3.5 13.5V9M6.5 13.5V5M9.5 13.5V7.5M12.5 13.5V3.5"/>',
  transform: '<path d="M2.5 5h6.5M2.5 11h4"/><path class="ic-2" d="M9.5 3.5 13.5 8l-4 4.5M6.5 8h7"/>',
  history: '<circle cx="8" cy="8.5" r="5.2"/><path d="M8 5.6v3.2l2.2 1.3M3.2 4.5v2.4h2.4"/>',
  star: '<path d="M8 2l1.8 3.7 4.1.6-3 2.9.7 4.1L8 11.4l-3.6 1.9.7-4.1-3-2.9 4.1-.6z"/>',
  pin: '<path d="M5.5 2.5h5l-.6 4 2.1 2v1H4v-1l2.1-2z"/><path class="ic-2" d="M8 9.5v4.2"/>',
  trash: '<path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.6 9h5.8l.6-9"/>',
  wand: '<path d="M2.5 13.5 10.5 5.5"/><path class="ic-2" d="M12 2v2.5M10.75 3.25h2.5M13.5 7v2M12.5 8h2M7.5 2.5v2M6.5 3.5h2"/>',
  inspect: '<rect x="2" y="2.5" width="12" height="11" rx="1.2"/><path class="ic-2" d="M4.5 6h7M4.5 8.8h5M4.5 11.2h3.5"/>',
  pivot: '<rect x="2" y="2.5" width="3.2" height="11" rx=".6"/><path class="ic-2" d="M7.2 3h6.8v2.4H7.2zM7.2 6.8h5.2v2.4H7.2zM7.2 10.6h3.6V13H7.2z"/>',
  shield: '<path d="M8 1.8 13.2 3.8v4c0 3.2-2.3 5.4-5.2 6.5-2.9-1.1-5.2-3.3-5.2-6.5v-4z"/><path class="ic-2" d="M5.6 8.1 7.3 9.8l3.3-3.4"/>',
  chat: '<path d="M2.2 3.5a1 1 0 0 1 1-1h9.6a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H6.5L3.2 13.6v-2.7a1 1 0 0 1-1-1z"/><path class="ic-2" d="M5.2 5.8h5.6M5.2 8.2h3.6"/>',
  waterfall: '<path d="M2 4h4.5M5 8h6M9 12h5"/><circle class="ic-2" cx="2" cy="4" r=".9"/><circle class="ic-2" cx="5" cy="8" r=".9"/><circle class="ic-2" cx="9" cy="12" r=".9"/>',
  'diff-files': '<rect x="2" y="2.5" width="6.5" height="9.5" rx="1"/><rect class="ic-2" x="7.5" y="4" width="6.5" height="9.5" rx="1"/><path class="ic-2" d="M9.5 7.5h2.5M9.5 10h2.5"/>',
  charts: '<path d="M2 13.5h12M2 2.5v11"/><path class="ic-2" d="M4 10.5 7 6.5l3 2.5 3.5-5"/>',
  'check-doc': '<path d="M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5z"/><path d="M9.5 1.5V5H13"/><path class="ic-2" d="M5.5 9.5 7.2 11.2 10.6 7.6"/>',
  more: '<circle cx="3.5" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12.5" cy="8" r="1.1"/>',
  command: '<rect x="2.2" y="2.5" width="11.6" height="11" rx="1.6"/><path class="ic-2" d="M5.2 6.5 7.5 8.5 5.2 10.5M8.5 10.5h2.5"/>',
};

export function icon(name: string, size = 14): string {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ''}</svg>`;
}
