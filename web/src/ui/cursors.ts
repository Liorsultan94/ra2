// Custom RTS cursors drawn as inline SVG, injected as CSS rules keyed on data-cursor.
const S = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${body}</svg>`;
const outline = 'stroke="#000" stroke-width="1.2" stroke-linejoin="round"';

const CURSORS: Record<string, [string, number, number, string]> = {
  default: [S(`<path d="M3 2l18 11-8 1.5L9 22z" fill="#f4f0e0" ${outline}/>`), 3, 2, 'default'],
  select: [S(`<g fill="none" stroke="#000" stroke-width="4"><path d="M4 11V4h7M21 4h7v7M28 21v7h-7M11 28H4v-7"/></g><g fill="none" stroke="#7dff8a" stroke-width="2"><path d="M4 11V4h7M21 4h7v7M28 21v7h-7M11 28H4v-7"/></g>`), 16, 16, 'pointer'],
  move: [S(`<g ${outline} fill="#52ff6e"><path d="M16 2l5 6h-3.5v5h-3V8H11zM16 30l-5-6h3.5v-5h3v5H21zM2 16l6-5v3.5h5v3H8V21zM30 16l-6 5v-3.5h-5v-3h5V11z"/></g>`), 16, 16, 'crosshair'],
  attack: [S(`<g fill="none" stroke="#000" stroke-width="4"><circle cx="16" cy="16" r="9"/><path d="M16 2v8M16 22v8M2 16h8M22 16h8"/></g><g fill="none" stroke="#ff3b30" stroke-width="2"><circle cx="16" cy="16" r="9"/><path d="M16 2v8M16 22v8M2 16h8M22 16h8"/></g><circle cx="16" cy="16" r="2" fill="#ff3b30"/>`), 16, 16, 'crosshair'],
  enter: [S(`<rect x="11" y="11" width="18" height="18" fill="#3b8cff" ${outline}/><path d="M2 2l12 7-5 1-1 5z" fill="#fff" ${outline}/>`), 2, 2, 'pointer'],
  deploy: [S(`<g ${outline} fill="#ffd23a"><path d="M16 4l6 7h-4v6h-4v-6h-4z"/><rect x="5" y="20" width="22" height="7" rx="1"/></g>`), 16, 16, 'pointer'],
  harvest: [S(`<g ${outline}><path d="M16 3l6 9-6 17-6-17z" fill="#ffcf3a"/><path d="M10 12h12" stroke="#a07a10"/></g>`), 16, 16, 'pointer'],
  sell: [S(`<circle cx="16" cy="16" r="13" fill="#2fbf4a" ${outline}/><text x="16" y="22.5" font-size="18" font-family="Arial" font-weight="bold" text-anchor="middle" fill="#fff">$</text>`), 16, 16, 'pointer'],
  repair: [S(`<path d="M27 8a6 6 0 0 1-8 6L9 24a2.8 2.8 0 0 1-4-4l10-10a6 6 0 0 1 6-8l-3 4 1 3 3 1z" fill="#ffd23a" ${outline}/>`), 6, 26, 'pointer'],
  nope: [S(`<circle cx="16" cy="16" r="11" fill="none" stroke="#000" stroke-width="5"/><circle cx="16" cy="16" r="11" fill="none" stroke="#ff3b30" stroke-width="3"/><path d="M8 8l16 16" stroke="#000" stroke-width="5"/><path d="M8 8l16 16" stroke="#ff3b30" stroke-width="3"/>`), 16, 16, 'not-allowed'],
  nomove: [S(`<path d="M7 7l18 18M25 7L7 25" stroke="#000" stroke-width="6"/><path d="M7 7l18 18M25 7L7 25" stroke="#b8b8b8" stroke-width="3"/>`), 16, 16, 'not-allowed'],
  place: [S(`<rect x="6" y="6" width="20" height="20" fill="none" stroke="#000" stroke-width="4"/><rect x="6" y="6" width="20" height="20" fill="none" stroke="#7dff8a" stroke-width="2"/>`), 16, 16, 'crosshair'],
  pan: [S(`<g ${outline} fill="#f4f0e0"><path d="M16 1l5 6H11zM16 31l-5-6h10zM1 16l6-5v10zM31 16l-6 5V11z"/><circle cx="16" cy="16" r="3"/></g>`), 16, 16, 'move'],
};

export function installCursors() {
  const rules = Object.entries(CURSORS).map(
    ([k, [svg, x, y, fb]]) => `.view-wrap[data-cursor="${k}"]{cursor:url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, ${fb};}`,
  );
  const style = document.createElement('style');
  style.textContent = rules.join('\n');
  document.head.appendChild(style);
}
