// Inline stroke icons. They use currentColor, so they follow the theme.
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
  'file-code': '<path d="M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5z"/><path d="M9.5 1.5V5H13M6.5 8.5 5 10l1.5 1.5M9.5 8.5 11 10l-1.5 1.5"/>',
  plus: '<path d="M3 8h10M8 3v10"/>',
  minus: '<path d="M3 8h10"/>',
  fit: '<path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  wrap: '<path d="M2 3.5h12M2 7.5h9.5a2.5 2.5 0 0 1 0 5H8"/><path d="M9.5 10.5 7.5 12.5l2 2M2 12.5h3"/>',
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
};

export function icon(name: string, size = 14): string {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ''}</svg>`;
}
