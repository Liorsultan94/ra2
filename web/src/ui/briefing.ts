import { mapInfo } from '../sim/maps';
import { DEFS, FACTION_INFO, buildingDef } from '../sim/defs';
import { SW_BY_FACTION, SW_INFO } from '../sim/specialdefs';
import type { Difficulty } from '../sim/ai';
import type { Faction } from '../sim/types';
import type { World } from '../sim/world';
import { flagDataUrl } from '../render/flags';
import emblemSvg from './emblem.svg?raw';
import './briefing.css';

/*
 * Mission briefing: a classified-dossier loading screen shown while a battle
 * warms up (shader compilation), with the operation codename, a tactical map
 * drawn from the real map data, enemy intel, our forces and the objectives.
 * Everything is derived from the world / options; nothing here touches the sim.
 */

// ------------------------------------------------------------------ data

const ADJ = ['IRON', 'SILENT', 'CRIMSON', 'BROKEN', 'NORTHERN', 'STEEL', 'BLACK', 'BURNING', 'FROZEN', 'GRANITE', 'RED', 'GHOST', 'SAVAGE', 'DISTANT', 'HOLLOW', 'RAPID', 'SCARLET', 'COBALT', 'THUNDER', 'OBSIDIAN', 'WINTER', 'SOVEREIGN', 'VALIANT', 'EMBER'];
const NOUN = ['ANVIL', 'TEMPEST', 'SPEAR', 'LANTERN', 'HAMMER', 'TRIDENT', 'RAVEN', 'FALCON', 'CROSSING', 'BASTION', 'HARVEST', 'SENTINEL', 'VIPER', 'GAUNTLET', 'DAWN', 'HORIZON', 'CITADEL', 'RAPIER', 'TALON', 'WOLF', 'RIVER', 'THRONE', 'STORM', 'ARROW'];

function mix(n: number): number {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Deterministic operation codename for a match seed ("IRON ANVIL"). */
export function operationName(seed: number): string {
  const h = mix(seed);
  return `${ADJ[h % ADJ.length]} ${NOUN[(h >>> 8) % NOUN.length]}`;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Fixed times of day (the hour the HUD clock shows for each: render/atmos.ts FIXED_HOUR). */
const TOD_LINE: Record<string, string> = {
  day: '1500 HRS · DAYLIGHT',
  dusk: '1915 HRS · DUSK',
  night: '2300 HRS · NIGHT',
  mist: '0715 HRS · MORNING MIST',
  cycle: '0530 HRS · DAWN · LIVE DAY',
};
/** Briefing names of the dynamic weather fronts (render/weathercycle.ts WxEventKind). */
const FRONT: Record<string, string> = { showers: 'SHOWERS', rain: 'RAIN', storm: 'THUNDERSTORMS', dust: 'DUST STORM', flurries: 'SNOW FLURRIES', snowfall: 'HEAVY SNOW', overcast: 'OVERCAST' };
const hhmm = (h: number) => {
  const m = Math.floor((((h % 24) + 24) % 24) * 60) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
};
const lightName = (h: number) => {
  const x = ((h % 24) + 24) % 24;
  return x >= 5 && x < 7 ? 'DAWN' : x >= 7 && x < 17.5 ? 'DAYLIGHT' : x >= 17.5 && x < 19.75 ? 'DUSK' : 'NIGHT';
};

/** The live day's start ("0530 HRS · DAWN · LIVE DAY") and the dynamic weather's forecast for the day. */
export function timeLine(tod: string | undefined, start?: number): string {
  if (tod === 'cycle' && start !== undefined) return `${hhmm(start)} HRS · ${lightName(start)} · LIVE DAY`;
  return TOD_LINE[tod ?? 'day'] ?? `${(tod ?? 'day').toUpperCase()}`;
}

export function forecastLine(weather: string | undefined, fronts?: { kind: string; hour: number; storm: boolean }[] | null): string {
  if (!fronts) return WEATHER_LINE[weather ?? 'clear'] ?? (weather ?? 'clear').toUpperCase();
  if (!fronts.length) return 'FORECAST · CLEAR ALL DAY';
  const [f, ...rest] = fronts;
  let line = `FORECAST · ${FRONT[f.kind] ?? f.kind.toUpperCase()} ~${hhmm(f.hour)}`;
  if (rest.some((e) => e.storm) && !f.storm) line += ' · STORMS LATER';
  else if (rest.length) line += ` · ${FRONT[rest[0].kind] ?? 'MORE'} LATER`;
  return line;
}
const WEATHER_LINE: Record<string, string> = {
  clear: 'CLEAR SKIES · GOOD VISIBILITY',
  rain: 'RAIN · WET GROUND',
  snow: 'SNOW · COLD FRONT',
  sandstorm: 'SANDSTORM · POOR VISIBILITY',
  fog: 'FOG BANKS · LIMITED VISIBILITY',
  storm: 'THUNDERSTORM · HIGH WINDS',
  dynamic: 'CHANGEABLE WEATHER',
};

const DIFF: Record<Difficulty, { label: string; note: string }> = {
  easy: { label: 'LOW THREAT', note: 'The enemy commander is inexperienced: expect a slow build-up and light probing attacks.' },
  normal: { label: 'MODERATE THREAT', note: 'A competent enemy commander: expect probing attacks within minutes and a combined-arms push later.' },
  hard: { label: 'HIGH THREAT', note: 'Elite enemy command: expect an early, aggressive push and constant pressure on your economy.' },
};

/** Doctrine-specific threat notes for each enemy nation. */
const FACTION_THREAT: Record<Faction, string> = {
  usa: 'Sensor-to-shooter network: their weapons outrange yours while a radar is online. Kill the Radar Center early.',
  israel: 'Every enemy vehicle carries active protection that swats rockets and ATGMs. Use tank cannons and artillery against their armour.',
  china: 'Drones and aircraft come cheap and in swarms. Keep AA vehicles with every attack group.',
  russia: 'Massed artillery (+25% damage) and EW jamming of your drones. Keep moving, never bunch up, hunt their guns with air units.',
  germany: 'Fast heavy armour that repairs in the field. Prepare AT teams and ATGM towers at the bridges.',
  korea: 'A fortress: structures are 30% tougher and defences outrange you. Bring artillery for the siege.',
  ukraine: 'Cheap infantry and FPV drone teams everywhere. MG bunkers and AA shred them before they reach your armour.',
  turkey: 'Persistent armed UAV patrols overhead. SAM batteries and AA vehicles are mandatory.',
  iran: 'Cheap rocket and missile saturation, loitering munitions launched from trucks. Build layered air defence early.',
};

function swThreat(kind: string): string {
  switch (kind) {
    case 'darkEagle':
    case 'hyunmoo5':
    case 'kheibar':
      return 'Expect ballistic / hypersonic missile salvos on your base. Build layered air defence and spread out key structures.';
    case 'ironBeam':
      return 'Their Iron Beam laser dome burns missiles, shells and drones out of the sky. Mass ground armour rather than long-range fires.';
    case 'droneSwarm':
    case 'kizilelma':
    case 'neptuneFpv':
      return 'Drone saturation strikes expected. Field AA vehicles and MG bunkers to thin the swarm.';
    case 'tos2':
      return 'Thermobaric rocket barrages will flatten anything clustered. Disperse your base and keep SAMs up to intercept rockets.';
    case 'taurusSalvo':
      return 'Stealth cruise missiles will hunt your high-value structures. Put SAM cover around the Battle Lab and refineries.';
  }
  return 'Expect a superweapon strike once their Battle Lab is up. Destroy it before it charges.';
}

export interface ForceBrief {
  faction: Faction;
  name: string;
  doctrine: string;
  bonuses: string[];
  signature: string[];
  roster: string[];
  sw: { name: string; building: string; desc: string };
}

export interface BriefingInfo {
  codename: string;
  date: string;
  time: string;
  weather: string;
  mapName: string;
  region: string;
  situation: string;
  you: ForceBrief;
  enemy: ForceBrief & { threats: string[]; difficulty: { label: string; note: string } };
  primary: string[];
  secondary: string[];
}

function force(f: Faction): ForceBrief {
  const fi = FACTION_INFO[f];
  const sw = SW_INFO[SW_BY_FACTION[f]];
  const nm = (k: string) => DEFS[`${f}_${k}`]?.name;
  return {
    faction: f,
    name: fi.name,
    doctrine: fi.doctrine,
    bonuses: fi.bonuses,
    signature: fi.signature.map((id) => DEFS[id]?.name ?? id),
    roster: ['mbt', 'apc', 'heli', 'uav', 'arty'].map(nm).filter((n): n is string => !!n),
    sw: { name: sw.name, building: sw.building, desc: sw.desc },
  };
}

/** Tactical map transform (matches the default camera / minimap at yaw 0): tile -> 0..1. */
export function mapUV(w: number, h: number, x: number, y: number) {
  return { u: (x - y + h) / (w + h), v: (x + y) / (w + h) };
}

const GRID = 8;
function gridRef(w: number, h: number, x: number, y: number) {
  const { u, v } = mapUV(w, h, x, y);
  const c = Math.max(0, Math.min(GRID - 1, Math.floor(u * GRID)));
  const r = Math.max(0, Math.min(GRID - 1, Math.floor(v * GRID)));
  return `${'ABCDEFGH'[c]}${r + 1}`;
}

export function buildBriefing(
  world: World,
  local: number,
  o: { seed: number; difficulty: Difficulty; tod?: string; weather?: string; credits?: number; start?: number; forecast?: { kind: string; hour: number; storm: boolean }[] | null },
): BriefingInfo {
  const m = world.map;
  const me = world.players[local];
  const foe = world.players[1 - local];
  const you = force(me.faction);
  const en = force(foe.faction);
  const home = m.starts[local] ?? { x: me.startX, y: me.startY };
  const dist = (x: number, y: number) => Math.hypot(x - home.x, y - home.y);
  const ref = (x: number, y: number) => gridRef(m.w, m.h, x, y);
  const now = new Date();
  const neutral = world.list.filter((e) => !e.dead && e.owner < 0 && e.kind === 'building');
  const techs = neutral.filter((e) => buildingDef(e.def).techKind);
  const oils = neutral.filter((e) => e.def === 'oil');
  const gems = m.oreMines.filter((p) => m.oreKind[p.y * m.w + p.x] === 2);

  const biome = m.biome;
  const civ = neutral.filter((e) => buildingDef(e.def).garrison);
  const feats = m.bridges.length ? [`${m.bridges.length} contested bridges`] : [];
  if (biome === 'desert') feats.push('mesas and oases');
  if (biome === 'winter') feats.push('an ice ford');
  if (m.structures.length) feats.push(biome === 'urban' ? `${civ.length} buildings to garrison` : biome === 'desert' ? 'oasis villages' : biome === 'winter' ? 'log villages' : 'farming villages');
  feats.push(`${m.oreMines.length} ore fields`);
  if (oils.length) feats.push(`${oils.length} oil derricks`);
  if (techs.length) feats.push(`${techs.length} tech sites`);
  const region = `${m.id === 'frontline' ? 'Temperate river valley' : (mapInfo(m.id).region ?? 'Contested border region')} · ${feats.join(' · ')}`;

  // secondary objectives from the map features
  const secondary: string[] = [];
  const lane = (m.lanes ?? []).slice().sort((a, b) => dist(a.x, a.y) - dist(b.x, b.y))[0];
  if (m.bridges.length) {
    const refs = [...m.bridges].sort((a, b) => dist(a.x, a.y) - dist(b.x, b.y)).map((b) => ref(b.x, b.y));
    if (biome === 'urban') secondary.push(`Hold the ${m.bridges.length} canal bridges (grids ${refs.join(', ')}): the only way across for armour. Bridges can be blown.`);
    else if (biome === 'winter' && lane) secondary.push(`Secure the ${m.bridges.length} bridges (grids ${refs.join(', ')}) and the ice ford at grid ${ref(lane.x, lane.y)}, the only crossings of the frozen river. Bridges can be blown.`);
    else secondary.push(`Secure the ${m.bridges.length} river bridges (grids ${refs.join(', ')}), the only crossings for ground forces. Bridges can be blown.`);
  } else if (biome === 'desert') {
    secondary.push(`Control the oasis town at grid ${ref(m.w / 2, m.h / 2)}: its ring road links every pass between the mesas. The wadi can be crossed anywhere.`);
  }
  const TECH_GAIN: Record<string, string> = { comms: 'free radar coverage of the valley', hospital: 'heals your infantry nearby', airport: 'airborne drops recharge 50% faster' };
  for (const kind of ['comms', 'hospital', 'airport']) {
    const site = techs.filter((e) => buildingDef(e.def).techKind === kind).sort((a, b) => dist(a.x, a.y) - dist(b.x, b.y))[0];
    if (site) secondary.push(`Capture the ${buildingDef(site.def).name} at grid ${ref(site.x, site.y)} with an Engineer: ${TECH_GAIN[kind]}.`);
  }
  const oil = [...oils].sort((a, b) => dist(a.x, a.y) - dist(b.x, b.y))[0];
  if (oil) secondary.push(`Take the oil derricks near grid ${ref(oil.x, oil.y)} for a steady extra income.`);
  const gem = [...gems].sort((a, b) => dist(a.x, a.y) - dist(b.x, b.y))[0];
  secondary.push(gem ? `Protect your harvesters. The gem field at grid ${ref(gem.x, gem.y)} pays double.` : 'Protect your harvesters: no ore, no army.');
  const side = (x: number, y: number) => Math.sign(x - y) === Math.sign(home.x - home.y);
  const village = m.structures.filter((s) => side(s.x + s.w / 2, s.y + s.h / 2));
  if (biome === 'urban') secondary.push('Fill the apartment blocks and office towers along the avenues with infantry: every street is a killing ground. Flamethrowers burn garrisons out.');
  else if (village.length >= 3) {
    const vx = village.reduce((a, s) => a + s.x + s.w / 2, 0) / village.length;
    const vy = village.reduce((a, s) => a + s.y + s.h / 2, 0) / village.length;
    secondary.push(`Garrison the village houses at grid ${ref(vx, vy)} with infantry to hold the approach.`);
  }

  const bank = home.x - home.y < 0 ? 'western' : 'eastern';
  const funds = `$${(o.credits ?? me.credits).toLocaleString('en-US')}`;
  const SITUATION: Record<string, string> = {
    temperate: `${en.name} has massed its forces on the far bank of the river at ${m.name}. Our MCV has reached the ${bank} bank with ${funds} in war funds. `,
    desert: `${en.name} holds the far side of the wadi at ${m.name}, behind a wall of sandstone mesas. Our MCV has reached the ${bank} dunes with ${funds} in war funds; water and ore are scarce. `,
    winter: `${en.name} is dug in across the frozen river at ${m.name}. Our MCV has reached the ${bank} bank through the snow with ${funds} in war funds. `,
    urban: `${en.name} has taken the far half of ${m.name}, across the canal. Our MCV has reached a plaza on the ${bank} side with ${funds} in war funds; expect a fight for every block. `,
  };
  const situation = (SITUATION[biome] ?? SITUATION.temperate) + `Deploy, build up and break through before their ${en.sw.name} comes online.`;

  return {
    codename: operationName(o.seed),
    date: `${String(now.getDate()).padStart(2, '0')} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`,
    time: timeLine(o.tod, o.start),
    weather: forecastLine(o.weather, o.forecast),
    mapName: m.name,
    region,
    situation,
    you,
    enemy: { ...en, threats: [swThreat(SW_BY_FACTION[foe.faction]), FACTION_THREAT[foe.faction]], difficulty: DIFF[o.difficulty] ?? DIFF.normal },
    primary: ['Destroy all enemy structures.', 'Keep at least one of your structures standing.'],
    secondary: secondary.slice(0, 5),
  };
}

// ------------------------------------------------------------- tactical map

/** Draw the tactical map: terrain, river, bridges, roads, villages, ore, tech sites, start positions. */
export function drawTacticalMap(cv: HTMLCanvasElement, world: World, local: number, base: CanvasImageSource | null) {
  const m = world.map;
  const S = cv.width;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const k = S / (m.w + m.h);
  const P = (x: number, y: number) => ({ x: k * (x - y + m.h), y: k * (x + y) });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#06090b';
  ctx.fillRect(0, 0, S, S);
  // terrain (the renderer's baked minimap colours), desaturated into a map-print look
  ctx.save();
  ctx.setTransform(k, k, -k, k, k * m.h, 0);
  ctx.beginPath();
  ctx.rect(0, 0, m.w, m.h);
  ctx.clip();
  if (base) {
    ctx.filter = 'saturate(0.55) brightness(0.78) contrast(1.15) sepia(0.18)';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(base, 0, 0, m.w, m.h);
    ctx.filter = 'none';
  } else {
    // fallback: tiles
    const col = ['#3f5233', '#5b4f38', '#8a7d58', '#1f4a66', '#5d5d58', '#7a6845'];
    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < m.w; x++) {
        ctx.fillStyle = col[m.tiles[y * m.w + x]] ?? '#333';
        ctx.fillRect(x, y, 1.02, 1.02);
      }
  }
  // forests as darker patches, ore / gems as dots
  for (let y = 0; y < m.h; y++)
    for (let x = 0; x < m.w; x++) {
      const i = y * m.w + x;
      if (m.trees[i]) {
        ctx.fillStyle = 'rgba(10, 30, 14, 0.35)';
        ctx.fillRect(x, y, 1, 1);
      }
      if (m.ore[i]) {
        ctx.fillStyle = m.oreKind[i] === 2 ? 'rgba(200, 110, 255, 0.85)' : 'rgba(240, 196, 70, 0.85)';
        ctx.fillRect(x + 0.2, y + 0.2, 0.6, 0.6);
      }
    }
  // roads
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(226, 208, 160, 0.55)';
  ctx.lineWidth = 0.7;
  for (const r of m.roads) {
    ctx.beginPath();
    r.forEach((p, i) => (i ? ctx.lineTo(p.x + 0.5, p.y + 0.5) : ctx.moveTo(p.x + 0.5, p.y + 0.5)));
    ctx.stroke();
  }
  // villages
  ctx.fillStyle = 'rgba(232, 222, 196, 0.9)';
  for (const s of m.structures) ctx.fillRect(s.x + 0.15, s.y + 0.15, s.w - 0.3, s.h - 0.3);
  ctx.restore();

  // map grid (screen space, matches the grid references in the objectives)
  ctx.strokeStyle = 'rgba(160, 200, 190, 0.13)';
  ctx.lineWidth = 1;
  for (let i = 1; i < GRID; i++) {
    const t = Math.round((i * S) / GRID) + 0.5;
    ctx.beginPath();
    ctx.moveTo(t, 0);
    ctx.lineTo(t, S);
    ctx.moveTo(0, t);
    ctx.lineTo(S, t);
    ctx.stroke();
  }
  const fs = Math.round(S / 40);
  ctx.font = `600 ${fs}px 'Barlow Condensed', Inter, system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(190, 220, 210, 0.55)';
  ctx.textBaseline = 'top';
  for (let i = 0; i < GRID; i++) {
    ctx.textAlign = 'center';
    ctx.fillText('ABCDEFGH'[i], ((i + 0.5) * S) / GRID, 4);
    ctx.textAlign = 'left';
    ctx.fillText(String(i + 1), 5, ((i + 0.5) * S) / GRID - fs / 2);
  }
  // map border
  ctx.strokeStyle = 'rgba(200, 220, 210, 0.35)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const [x, y] of [[0, 0], [m.w, 0], [m.w, m.h], [0, m.h]]) {
    const p = P(x, y);
    ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  ctx.stroke();

  const label = (text: string, x: number, y: number, color: string, size = fs, align: CanvasTextAlign = 'center') => {
    ctx.font = `600 ${size}px 'Barlow Condensed', Inter, system-ui, sans-serif`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, size / 4);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  };

  const home = m.starts[local];
  const foe = m.starts[1 - local];
  const H = P(home.x + 0.5, home.y + 0.5);
  const F = P(foe.x + 0.5, foe.y + 0.5);
  // axes of advance: dashed arrows from our base to each bridge, enemy thrust towards the centre
  const arrow = (a: { x: number; y: number }, b: { x: number; y: number }, color: string, width: number, dash: number[]) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    const ux = dx / L;
    const uy = dy / L;
    const s = { x: a.x + ux * S * 0.05, y: a.y + uy * S * 0.05 };
    const e = { x: b.x - ux * S * 0.03, y: b.y - uy * S * 0.03 };
    const c = { x: (s.x + e.x) / 2 - uy * L * 0.12, y: (s.y + e.y) / 2 + ux * L * 0.12 };
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.quadraticCurveTo(c.x, c.y, e.x, e.y);
    ctx.stroke();
    ctx.setLineDash([]);
    // head along the curve's end tangent
    const tx = e.x - c.x;
    const ty = e.y - c.y;
    const tl = Math.hypot(tx, ty) || 1;
    const hx = tx / tl;
    const hy = ty / tl;
    const hs = width * 3.2;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(e.x + hx * hs * 0.6, e.y + hy * hs * 0.6);
    ctx.lineTo(e.x - hx * hs - hy * hs * 0.7, e.y - hy * hs + hx * hs * 0.7);
    ctx.lineTo(e.x - hx * hs + hy * hs * 0.7, e.y - hy * hs - hx * hs * 0.7);
    ctx.closePath();
    ctx.fill();
  };
  const lw = Math.max(2, S / 220);
  for (const b of m.bridges) arrow(H, P(b.x, b.y), 'rgba(90, 170, 255, 0.85)', lw, [lw * 3, lw * 2]);
  const mid = m.bridges.length ? m.bridges[0] : { x: m.w / 2, y: m.h / 2 };
  arrow(F, P(mid.x, mid.y), 'rgba(255, 80, 64, 0.85)', lw * 1.3, [lw * 3, lw * 2]);

  // bridges
  m.bridges.forEach((b, i) => {
    const a = P(b.x - Math.cos(b.angle) * b.length * 0.5, b.y - Math.sin(b.angle) * b.length * 0.5);
    const c = P(b.x + Math.cos(b.angle) * b.length * 0.5, b.y + Math.sin(b.angle) * b.length * 0.5);
    ctx.strokeStyle = '#120f0a';
    ctx.lineWidth = lw * 3.4;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(c.x, c.y);
    ctx.stroke();
    ctx.strokeStyle = '#f2c14e';
    ctx.lineWidth = lw * 2;
    ctx.stroke();
    const p = P(b.x, b.y);
    label(`BR-${i + 1}`, p.x + S * 0.045, p.y - S * 0.02, '#f2c14e', fs * 0.95, 'left');
  });

  // tech sites and oil
  for (const e of world.list) {
    if (e.dead || e.owner >= 0 || e.kind !== 'building') continue;
    const d = buildingDef(e.def);
    const tk = d.techKind;
    if (!tk && e.def !== 'oil') continue;
    const p = P(e.x, e.y);
    const r = S * (tk ? 0.016 : 0.011);
    ctx.fillStyle = tk ? '#57e0c8' : '#e89a3c';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - r);
    ctx.lineTo(p.x + r, p.y);
    ctx.lineTo(p.x, p.y + r);
    ctx.lineTo(p.x - r, p.y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    const txt = tk === 'comms' ? 'COMMS' : tk === 'hospital' ? 'HOSP' : tk === 'airport' ? 'AIRFIELD' : 'OIL';
    label(txt, p.x, p.y + r + fs * 0.7, tk ? '#8ff0dc' : '#f0b878', fs * (tk ? 0.9 : 0.8));
  }

  // start positions
  const marker = (p: { x: number; y: number }, color: string, friendly: boolean) => {
    const r = S * 0.04;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw * 1.4;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 1.55, 0, Math.PI * 2);
    ctx.setLineDash([lw * 2, lw * 2]);
    ctx.lineWidth = lw * 0.8;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    if (friendly) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 0.38, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const q = r * 0.45;
      ctx.lineWidth = lw * 1.6;
      ctx.beginPath();
      ctx.moveTo(p.x - q, p.y - q);
      ctx.lineTo(p.x + q, p.y + q);
      ctx.moveTo(p.x + q, p.y - q);
      ctx.lineTo(p.x - q, p.y + q);
      ctx.stroke();
    }
  };
  marker(H, '#4aa8ff', true);
  marker(F, '#ff4a3a', false);
  label('YOU · HQ', H.x, H.y + S * 0.085, '#9fd0ff', fs * 1.15);
  label('HOSTILE', F.x, F.y + S * 0.085, '#ff8a7a', fs * 1.15);
}

// ------------------------------------------------------------------ screen

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const flag = (f: string) => `<img class="flag" src="${flagDataUrl(f)}" alt="">`;

export interface BriefingOptions {
  /** Seconds after loading before the briefing deploys on its own (if untouched). */
  autoDeploy: number;
  say?: (text: string) => void;
}

/** The briefing overlay; covers the battle while it loads, then waits for "Deploy". */
export class Briefing {
  readonly el: HTMLElement;
  private bar: HTMLElement;
  private label: HTMLElement;
  private btn: HTMLButtonElement;
  private timers: number[] = [];
  private typing: { el: HTMLElement; text: string; i: number }[] = [];
  private typeTimer = 0;
  private auto = 0;
  private autoLeft = 0;
  private touched = false;
  private onDeploy: (() => void) | null = null;
  private keyHandler = (e: KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ' ') && this.onDeploy) {
      e.preventDefault();
      this.deploy();
    }
  };

  constructor(
    parent: HTMLElement,
    readonly info: BriefingInfo,
    world: World,
    local: number,
    terrain: CanvasImageSource | null,
    private opts: BriefingOptions,
  ) {
    const i = info;
    const en = i.enemy;
    const li = (a: string[]) => a.map((x) => `<li>${esc(x)}</li>`).join('');
    const chips = (a: string[]) => a.map((x) => `<span>${esc(x)}</span>`).join('');
    const t = document.createElement('template');
    t.innerHTML = `
      <div class="brief" role="dialog" aria-label="Mission briefing">
        <div class="brief-scan"></div>
        <header class="brief-head">
          <div class="bh-emblem">${emblemSvg}</div>
          <div class="bh-title">
            <small>TOP SECRET // EYES ONLY · MISSION BRIEFING</small>
            <h1>OPERATION <b class="bh-code" data-type="${esc(i.codename)}"></b></h1>
          </div>
          <div class="bh-meta"><span>${esc(i.date)}</span><span>${esc(i.time)}</span><span>${esc(i.weather)}</span></div>
        </header>
        <div class="brief-body">
          <section class="brief-map">
            <div class="bm-frame">
              <canvas width="640" height="640"></canvas>
              <div class="bm-stamp">CLASSIFIED</div>
            </div>
            <div class="bm-cap"><b>${esc(i.mapName.toUpperCase())}</b><span>${esc(i.region)}</span></div>
            <div class="bm-legend"><i class="lg-you"></i>You <i class="lg-foe"></i>Hostile <i class="lg-br"></i>Bridge <i class="lg-tech"></i>Tech site <i class="lg-ore"></i>Ore <i class="lg-gem"></i>Gems</div>
          </section>
          <section class="brief-dossier">
            <div class="bd-block bd-sit">
              <h3>Situation</h3>
              <p data-type="${esc(i.situation)}"></p>
            </div>
            <div class="bd-block bd-enemy">
              <h3>Enemy intel <em class="threat">${esc(en.difficulty.label)}</em></h3>
              <div class="bd-nation">${flag(en.faction)}<div><b>${esc(en.name)}</b><small>${esc(en.doctrine)}</small></div></div>
              <div class="bd-sub">Known capabilities</div>
              <ul>${li(en.bonuses)}</ul>
              <div class="bd-chips">${chips([...en.signature, ...en.roster.slice(0, 3)])}</div>
              <div class="bd-sw"><b>Superweapon</b> ${esc(en.sw.name)} <small>(${esc(en.sw.building)})</small></div>
              <div class="bd-sub warn">Threat assessment</div>
              <ul class="bd-threats">${li([...en.threats, en.difficulty.note])}</ul>
            </div>
            <div class="bd-block bd-ours">
              <h3>Our forces</h3>
              <div class="bd-nation">${flag(i.you.faction)}<div><b>${esc(i.you.name)}</b><small>${esc(i.you.doctrine)}</small></div></div>
              <ul>${li(i.you.bonuses)}</ul>
              <div class="bd-chips own">${chips(i.you.signature)}</div>
              <div class="bd-sw"><b>Superweapon</b> ${esc(i.you.sw.name)} <small>${esc(i.you.sw.desc)}</small></div>
            </div>
            <div class="bd-block bd-obj">
              <h3>Mission objectives</h3>
              <div class="bd-sub">Primary</div>
              <ul class="obj-primary">${li(i.primary)}</ul>
              <div class="bd-sub">Secondary</div>
              <ul class="obj-secondary">${li(i.secondary)}</ul>
            </div>
          </section>
        </div>
        <footer class="brief-foot">
          <div class="bf-prog"><div class="bf-label">Preparing battlefield… 0%</div><div class="bf-bar"><i></i></div></div>
          <button class="bf-go" disabled>Loading…</button>
        </footer>
      </div>`;
    this.el = t.content.firstElementChild as HTMLElement;
    parent.appendChild(this.el);
    this.bar = this.el.querySelector('.bf-bar i') as HTMLElement;
    this.label = this.el.querySelector('.bf-label') as HTMLElement;
    this.btn = this.el.querySelector('.bf-go') as HTMLButtonElement;
    this.btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.deploy();
    });
    // reading the dossier (scroll / tap) cancels the automatic deploy
    const touch = (e: Event) => {
      if ((e.target as HTMLElement).closest?.('.bf-go')) return;
      this.touched = true;
      this.finishTyping();
      if (this.onDeploy) this.btn.innerHTML = 'Tap to deploy';
    };
    this.el.addEventListener('pointerdown', touch);
    this.el.addEventListener('wheel', touch, { passive: true });
    window.addEventListener('keydown', this.keyHandler);
    try {
      drawTacticalMap(this.el.querySelector('canvas')!, world, local, terrain);
    } catch (e) {
      console.warn('[briefing] map', e);
    }
    // typewriter: codename, then the situation report
    this.el.querySelectorAll<HTMLElement>('[data-type]').forEach((x) => this.typing.push({ el: x, text: x.dataset.type ?? '', i: 0 }));
    this.typeTimer = window.setInterval(() => this.typeStep(), 26);
    this.timers.push(window.setTimeout(() => opts.say?.(`Commander. Operation ${i.codename.toLowerCase()}. Enemy forces: ${en.name}.`), 700));
  }

  private typeStep() {
    const t = this.typing[0];
    if (!t) {
      window.clearInterval(this.typeTimer);
      return;
    }
    t.i = Math.min(t.text.length, t.i + 2);
    t.el.textContent = t.text.slice(0, t.i);
    t.el.classList.toggle('typing', t.i < t.text.length);
    if (t.i >= t.text.length) this.typing.shift();
  }

  private finishTyping() {
    for (const t of this.typing) {
      t.el.textContent = t.text;
      t.el.classList.remove('typing');
    }
    this.typing.length = 0;
  }

  /** Loading progress 0..1. */
  setProgress(k: number) {
    const p = Math.round(Math.max(0, Math.min(1, k)) * 100);
    this.bar.style.width = `${p}%`;
    this.label.textContent = `Preparing battlefield… ${p}%`;
  }

  /** Loading finished: enable "Deploy" and start the auto-deploy countdown. */
  setReady(onDeploy: () => void) {
    this.onDeploy = onDeploy;
    this.setProgress(1);
    this.label.textContent = 'Battlefield ready · all units standing by';
    this.el.classList.add('ready');
    this.btn.disabled = false;
    this.btn.innerHTML = 'Tap to deploy';
    this.autoLeft = this.opts.autoDeploy;
    const tick = () => {
      if (!this.onDeploy) return;
      if (this.touched) return;
      if (this.autoLeft <= 0) {
        this.deploy();
        return;
      }
      if (this.autoLeft <= 8) this.btn.innerHTML = `Tap to deploy <small>auto in ${Math.ceil(this.autoLeft)}</small>`;
      const step = Math.min(1, this.autoLeft);
      this.autoLeft -= step;
      this.auto = window.setTimeout(tick, step * 1000);
    };
    tick();
  }

  private deploy() {
    const fn = this.onDeploy;
    if (!fn) return;
    this.onDeploy = null;
    this.finishTyping();
    this.el.classList.add('leaving');
    this.timers.push(window.setTimeout(() => this.destroy(), 450));
    fn();
  }

  destroy() {
    window.clearInterval(this.typeTimer);
    window.clearTimeout(this.auto);
    for (const t of this.timers) window.clearTimeout(t);
    window.removeEventListener('keydown', this.keyHandler);
    this.onDeploy = null;
    this.el.remove();
  }
}
