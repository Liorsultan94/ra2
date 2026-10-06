/*
 * Line icon set for the HUD and menus: 24 × 24 grid, 1.75 px round stroke,
 * no fills (except tiny dots), so every icon reads the same at 18–24 px.
 * `icon(name)` returns the <svg> markup; the stroke follows `currentColor`.
 */

const P: Record<string, string> = {
  // build tabs
  base: '<path d="M3 20.5h18"/><path d="M4.5 20.5V10l5-3.5v4l5-3.5v4l5-3v12.5"/><path d="M8 16h2M13 16h2"/>',
  defense: '<path d="M12 3l7.5 2.8v5.5c0 4.6-3.1 8.4-7.5 9.9-4.4-1.5-7.5-5.3-7.5-9.9V5.8z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
  infantry: '<circle cx="12" cy="6" r="2.6"/><path d="M7 21v-5.5a5 5 0 0 1 10 0V21"/><path d="M10 21v-4M14 21v-4"/>',
  vehicle: '<path d="M2.5 16.5h19"/><path d="M4 16.5l1.5-4h13l1.5 4"/><path d="M8.5 12.5V10h6.5v2.5"/><path d="M15 11h6.5"/><circle cx="6.5" cy="19" r="1.2"/><circle cx="12" cy="19" r="1.2"/><circle cx="17.5" cy="19" r="1.2"/>',
  air: '<path d="M12 2.5c1 0 1.6 1.2 1.6 3v4.2l7.4 4.3v2l-7.4-2.2v4l2.4 2v1.7L12 20.4l-4 1.1v-1.7l2.4-2v-4L3 16v-2l7.4-4.3V5.5c0-1.8.6-3 1.6-3z"/>',
  // orders
  stop: '<rect x="5.5" y="5.5" width="13" height="13" rx="2.5"/>',
  // illumination round: a flare under its little parachute, shining
  flare: '<path d="M6 8.5a6 4.5 0 0 1 12 0z"/><path d="M6 8.5l6 6.5 6-6.5M12 8.5V15"/><circle cx="12" cy="17.2" r="1.6" fill="currentColor" stroke="none"/><path d="M12 20.5v1.5M8.6 18.6l-1.3 1M15.4 18.6l1.3 1"/>',
  attackMove: '<circle cx="12" cy="12" r="7.5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>',
  deploy: '<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/><path d="M4 4l5.5 5.5M20 4l-5.5 5.5M4 20l5.5-5.5M20 20l-5.5-5.5"/>',
  unload: '<path d="M3.5 8.5h11v9h-11z"/><path d="M14.5 11h3.5l2.5 3v3.5h-6"/><circle cx="7" cy="18.5" r="1.5"/><circle cx="17" cy="18.5" r="1.5"/><path d="M9 2.5v4M7 4.5l2 2 2-2"/>',
  deselect: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  repair: '<path d="M14.7 6.3a4 4 0 0 0 5 5L21 12.6 12.6 21a2.1 2.1 0 0 1-3-3L18 9.7"/><path d="M14.7 6.3L17.4 3.6a4 4 0 0 0-5.3 5.3L3 18a2.1 2.1 0 0 0 3 3l9.1-9.1"/>',
  sell: '<path d="M12 3v18"/><path d="M16.5 7.5c-.6-1.4-2.2-2.3-4.5-2.3-2.7 0-4.3 1.3-4.3 3.1 0 4.4 9 2.3 9 6.8 0 1.9-1.9 3.4-4.7 3.4-2.4 0-4.1-1-4.8-2.6"/>',
  army: '<circle cx="12" cy="7" r="2.6"/><circle cx="5.5" cy="9.5" r="2"/><circle cx="18.5" cy="9.5" r="2"/><path d="M7.5 19.5v-2.2a4.5 4.5 0 0 1 9 0v2.2"/><path d="M2.5 19v-1.5A3 3 0 0 1 6 14.6M21.5 19v-1.5a3 3 0 0 0-3.5-2.9"/>',
  screen: '<rect x="3" y="4.5" width="18" height="12.5" rx="2"/><path d="M9 20.5h6"/><circle cx="9" cy="10" r="1.3"/><circle cx="15" cy="9" r="1.3"/><circle cx="12" cy="13" r="1.3"/>',
  box: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M11 4h2M11 20h2M4 11v2M20 11v2"/>',
  cancel: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor"/>',
  // chrome
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  chevron: '<path d="M9.5 6l6 6-6 6"/>',
  rotL: '<path d="M3.5 4.5v5h5"/><path d="M4 9.5a8.5 8.5 0 1 1-.5 5"/>',
  rotR: '<path d="M20.5 4.5v5h-5"/><path d="M20 9.5a8.5 8.5 0 1 0 .5 5"/>',
  thermal: '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 9v7"/>',
  photo: '<path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.7l1.6-2.5h6.4L16.8 7h2.7A1.5 1.5 0 0 1 21 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/><circle cx="12" cy="13.2" r="3.6"/>',
  bolt: '<path d="M13 2.5L5 13.5h6l-1 8 8-11h-6z"/>',
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12l6-6"/>',
  // HUD clock (src/ui/clock.ts): sky through the day + weather
  sunrise: '<path d="M2.5 18.5h19"/><path d="M6.5 18.5a5.5 5.5 0 0 1 11 0"/><path d="M12 2.5v6M9.5 5L12 2.5 14.5 5"/><path d="M3.8 12.8l1.6 1M20.2 12.8l-1.6 1"/><path d="M7 21.5h10"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.55 1.55M17.15 17.15l1.55 1.55M5.3 18.7l1.55-1.55M17.15 6.85l1.55-1.55"/>',
  sunset: '<path d="M2.5 18.5h19"/><path d="M6.5 18.5a5.5 5.5 0 0 1 11 0"/><path d="M12 2.5v6M9.5 6L12 8.5 14.5 6"/><path d="M3.8 12.8l1.6 1M20.2 12.8l-1.6 1"/><path d="M7 21.5h10"/>',
  moon: '<path d="M20 14.6A8.2 8.2 0 0 1 9.4 4a8.2 8.2 0 1 0 10.6 10.6z"/>',
  cloud: '<path d="M7.2 18.5h10.1a3.7 3.7 0 0 0 .3-7.4 5.3 5.3 0 0 0-10.2-1.2 4.3 4.3 0 0 0-.2 8.6z"/>',
  rain: '<path d="M7.2 14.5h10.1a3.7 3.7 0 0 0 .3-7.4 5.3 5.3 0 0 0-10.2-1.2 4.3 4.3 0 0 0-.2 8.6z"/><path d="M8.5 17.5l-1.2 3M12.5 17.5l-1.2 3M16.5 17.5l-1.2 3"/>',
  storm: '<path d="M7.2 14.5h10.1a3.7 3.7 0 0 0 .3-7.4 5.3 5.3 0 0 0-10.2-1.2 4.3 4.3 0 0 0-.2 8.6z"/><path d="M13 15.5l-2.5 3.5h3.2l-2.2 3.5"/>',
  snow: '<path d="M7.2 14.5h10.1a3.7 3.7 0 0 0 .3-7.4 5.3 5.3 0 0 0-10.2-1.2 4.3 4.3 0 0 0-.2 8.6z"/><path d="M8 17.8v.1M12 18.6v.1M16 17.8v.1M10 21.2v.1M14 21.2v.1" stroke-width="2.6"/>',
  dust: '<path d="M3 8.5h10.5a2.6 2.6 0 1 0-2.6-2.6"/><path d="M3 13h15.5a2.6 2.6 0 1 1-2.6 2.6"/><path d="M3 17.5h7"/><path d="M19.5 7.5v.1M21 11v.1M13.5 20v.1" stroke-width="2.4"/>',
};

export type IconName = keyof typeof P;

/** Line icon markup (`stroke` follows currentColor). */
export function icon(name: IconName | string, cls = ''): string {
  const inner = P[name] ?? '';
  return `<svg class="ico${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

export function hasIcon(name: string): boolean {
  return name in P;
}
