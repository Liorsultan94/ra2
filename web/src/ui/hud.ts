import { DEFS, FACTION_INFO, WEAPONS, buildingDef, defsForFaction, unitDef } from '../sim/defs';
import { standHeight } from '../sim/map';
import { TPS, type Category, type Def, type Entity } from '../sim/types';
import type { World } from '../sim/world';
import type { CameoFactory } from '../render/cameo';
import { styleFor, type GameRenderer } from '../render/renderer';
import { flagDataUrl } from '../render/flags';
import { SupportPower } from './support';
import { SuperweaponPower } from './superweapons';
import { RankPops, drawRankInsignia, rankBadgeSvg, rankLineHtml } from './veterancy';
import { canRank } from '../sim/veterancy';
import { isSortieJet, jetCount, jetsQueued, padCap, rearmProgress } from '../sim/airbase';
import { LivePortrait } from './portrait3d';
import { hasIcon, icon } from './icons';
import './simple.css';
import { HudClock } from './clock';
import { PeaceChip } from './peace';

export interface HudActions {
  onCameo(defId: string, cat: Category, shift: boolean): void;
  onCancel(defId: string): void;
  onTool(tool: 'repair' | 'sell' | 'menu' | 'boxselect'): void;
  onCommand(cmd: HudCommand): void;
  onMinimap(x: number, y: number, drag: boolean): void;
  onSelectType(defId: string): void;
  onRotate(steps: number): void;
  onLayout(): void;
  /** The simple scheme's "More" panel was opened / closed. */
  onMore(): void;
}

export type HudCommand = 'stop' | 'attackMove' | 'deploy' | 'selectArmy' | 'selectScreen' | 'deselect' | 'sellSel' | 'repairSel' | 'evacuate' | 'cancel' | 'repairMode' | 'sellMode';

const TABS: { cat: Category; label: string; icon: string }[] = [
  { cat: 'building', label: 'Base', icon: 'base' },
  { cat: 'defense', label: 'Defense', icon: 'defense' },
  { cat: 'infantry', label: 'Infantry', icon: 'infantry' },
  { cat: 'vehicle', label: 'Vehicles', icon: 'vehicle' },
  { cat: 'air', label: 'Air', icon: 'air' },
];

const svg = (inner: string) => `<svg viewBox="0 0 24 24" fill="currentColor">${inner}</svg>`;

/** Line icons (src/ui/icons.ts), full <svg> markup. */
const ICONS = {
  stop: icon('stop'),
  attackMove: icon('attackMove'),
  deploy: icon('deploy'),
  unload: icon('unload'),
  deselect: icon('deselect'),
  repair: icon('repair'),
  sell: icon('sell'),
  army: icon('army'),
  screen: icon('screen'),
  box: icon('box'),
  cancel: icon('cancel'),
  more: icon('more'),
};

/** Line icons for the view buttons other modules add by title (thermal, photo mode); filled glyph otherwise. */
const VIEW_ICONS: [RegExp, string][] = [
  [/^Thermal/i, 'thermal'],
  [/^Photo/i, 'photo'],
];

/** Short rallying line under the nation name in the sidebar header. */
const FACTION_MOTTO: Record<string, string> = {
  usa: 'Joint Force Command',
  israel: 'Northern Command',
  china: 'Eastern Theater',
  russia: 'Western Military District',
  germany: 'Heer · Panzerdivision',
  korea: 'ROK Army Command',
  ukraine: 'Joint Forces Operation',
  turkey: 'Land Forces Command',
  iran: 'IRGC Aerospace Force',
};

function roleLabel(d: Def): string {
  if (d.kind === 'building') return d.category === 'defense' ? 'Defense' : 'Structure';
  return d.category === 'infantry' ? 'Infantry' : d.category === 'air' ? 'Aircraft' : 'Vehicle';
}

export class Hud {
  readonly root: HTMLElement;
  readonly viewWrap: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  readonly selBox: HTMLElement;
  private sidebar!: HTMLElement;
  private minimap!: HTMLCanvasElement;
  private radarOff!: HTMLElement;
  private creditsEl!: HTMLElement;
  private powerFill!: HTMLElement;
  private powerText!: HTMLElement;
  private grid!: HTMLElement;
  private tabEls = new Map<Category, HTMLElement>();
  private cameoEls = new Map<string, HTMLElement>();
  private messages!: HTMLElement;
  private selPanel!: HTMLElement;
  private cmdBar!: HTMLElement;
  private tooltip!: HTMLElement;
  private hint!: HTMLElement;
  private toolBtns = new Map<string, HTMLElement>();
  private support!: SupportPower;
  /** Superweapon button, countdown list and target markers (superweapons.ts). */
  superweapons!: SuperweaponPower;
  tab: Category = 'building';
  private shownCredits = 0;
  private fogCanvas: HTMLCanvasElement;
  private fogImg: ImageData;
  private lastSelKey = '';
  private hoverCameo: string | null = null;
  private octx: CanvasRenderingContext2D;
  private mmStatic: HTMLCanvasElement;
  private mmM = new DOMMatrix();
  private mmInv = new DOMMatrix();
  private mmYaw = NaN;
  private mmDirty = true;
  private cineEl!: HTMLElement;
  private hpState = new Map<number, { hp: number; ghost: number; flash: number }>();
  private rankPops = new RankPops();
  private orderLines: { ids: number[]; x: number; y: number; target: number; color: string; t0: number }[] = [];
  /** Simple control scheme: compact quick bar + collapsible "More" panel instead of the full command bar. */
  simple = false;
  private quickBar!: HTMLElement;
  private qbMain!: HTMLElement;
  private qbPowers!: HTMLElement;
  private moreBtn!: HTMLButtonElement;
  private morePanel!: HTMLElement;
  private moreView!: HTMLElement;
  private moreTools = new Map<string, HTMLButtonElement>();
  private moreUnitBtns: HTMLButtonElement[] = [];
  /** Where the control-group strip and the order bar dock in the simple scheme. */
  moreSlots!: { groups: HTMLElement; orders: HTMLElement };
  private viewCtrl!: HTMLElement;
  /** Live day clock (top right of the view; clock.ts). */
  readonly clock: HudClock;
  /** Early-game grace countdown under the clock (peace.ts). */
  readonly peace: PeaceChip;
  private toolsRow!: HTMLElement;
  private cmdKey = '';
  private selHtml = '';
  private activeTool: string | null = null;
  private orderMode: string | null = null;
  private flashes: { ids: number[]; color: string; t0: number }[] = [];
  private ripples: { x: number; y: number; t0: number }[] = [];
  private lastOverlayT = 0;
  world!: World;
  renderer!: GameRenderer;
  player = 0;
  /** Live 3D portrait of the selection (portrait3d.ts); static cameos on 'low' quality. */
  private live: LivePortrait | null = null;

  constructor(
    parent: HTMLElement,
    private cameos: CameoFactory,
    private actions: HudActions,
  ) {
    this.root = el('div', 'game-root');
    parent.appendChild(this.root);
    this.viewWrap = el('div', 'view-wrap', this.root);
    this.canvas = el('canvas', 'view', this.viewWrap) as HTMLCanvasElement;
    this.overlay = el('canvas', 'overlay', this.viewWrap) as HTMLCanvasElement;
    this.octx = this.overlay.getContext('2d')!;
    this.selBox = el('div', 'selbox', this.viewWrap);
    this.messages = el('div', 'messages', this.viewWrap);
    this.hint = el('div', 'hint hidden', this.viewWrap);
    // cinematic letterbox
    this.cineEl = el('div', 'cine', this.viewWrap);
    this.cineEl.innerHTML = '<i class="cine-bar top"></i><i class="cine-bar bottom"></i><span class="cine-skip">TAP TO SKIP</span>';
    // view rotation (Q / E)
    const vc = (this.viewCtrl = el('div', 'view-ctrl', this.viewWrap));
    const rot = (steps: number, title: string, ico: string) => {
      const b = el('button', 'vc-btn', vc);
      b.innerHTML = icon(ico);
      b.title = title;
      b.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      b.onclick = () => this.actions.onRotate(steps);
    };
    rot(-1, 'Rotate view left (Q)', 'rotL');
    rot(1, 'Rotate view right (E)', 'rotR');
    // the live day clock leads the view buttons row (simple HUD: alone in the corner, see setSimple)
    this.clock = new HudClock(vc);
    vc.prepend(this.clock.el);
    this.peace = new PeaceChip(this.viewWrap);
    const bottomLeft = el('div', 'bottom-left', this.viewWrap);
    this.selPanel = el('div', 'selpanel hidden', bottomLeft);
    this.cmdBar = el('div', 'cmdbar', bottomLeft);
    this.buildSimpleBars(bottomLeft);
    this.tooltip = el('div', 'tooltip hidden', this.root);
    this.buildSidebar();
    this.fogCanvas = document.createElement('canvas');
    this.fogImg = new ImageData(1, 1);
    this.mmStatic = document.createElement('canvas');
  }

  /** Simple scheme widgets: the quick bar (ARMY / ON SCREEN / BOX / ✕ + context) and the "More" panel. */
  private buildSimpleBars(bottomLeft: HTMLElement) {
    const btn = (parent: HTMLElement, cls: string, label: string, ico: string, title: string, fn: () => void) => {
      const b = el('button', `qb-btn ${cls}`, parent);
      b.innerHTML = `${ico}<span>${label}</span>`;
      b.title = title;
      b.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      b.onclick = fn;
      return b;
    };
    // "More" panel (opens upwards, above the quick bar; closed by default)
    const mp = (this.morePanel = el('div', 'more-panel hidden', bottomLeft));
    const head = el('div', 'mp-row mp-tools', mp);
    const unitBtn = (label: string, ico: string, title: string, cmd: HudCommand) => {
      const b = btn(head, 'mp-btn', label, ico, title, () => this.actions.onCommand(cmd));
      this.moreUnitBtns.push(b);
    };
    unitBtn('Stop', ICONS.stop, 'Stop the selected units', 'stop');
    unitBtn('Attack-Move', ICONS.attackMove, 'Attack-move: tap the map, units fight everything on the way', 'attackMove');
    this.moreTools.set('repair', btn(head, 'mp-btn', 'Repair', ICONS.repair, 'Repair mode: tap your damaged buildings', () => this.actions.onCommand('repairMode')));
    this.moreTools.set('sell', btn(head, 'mp-btn', 'Sell', ICONS.sell, 'Sell mode: tap one of your buildings', () => this.actions.onCommand('sellMode')));
    const orders = el('div', 'mp-row mp-orders', mp);
    const groups = el('div', 'mp-row mp-groups', mp);
    el('span', 'mp-label', groups).innerHTML = 'Groups<small>tap: select · hold: save</small>';
    const groupSlot = el('div', 'mp-slot', groups);
    const view = el('div', 'mp-row mp-view', mp);
    el('span', 'mp-label', view).innerHTML = 'View';
    this.moreView = el('div', 'mp-slot', view);
    this.moreSlots = { groups: groupSlot, orders };
    // quick bar
    const qb = (this.quickBar = el('div', 'quickbar hidden', bottomLeft));
    this.qbMain = el('div', 'qb-main', qb);
    this.qbPowers = el('div', 'qb-powers', qb);
    this.moreBtn = btn(qb, 'qb-more', 'More', ICONS.more, 'More orders: stances, patrol, groups, view', () => this.setMore(this.morePanel.classList.contains('hidden')));
  }

  /** Open / close the simple scheme's "More" panel. */
  setMore(open: boolean) {
    if (open === !this.morePanel.classList.contains('hidden')) return;
    this.morePanel.classList.toggle('hidden', !open);
    this.root.classList.toggle('more-open', open);
    this.moreBtn.classList.toggle('on', open);
    this.actions.onMore();
  }

  /** Switch between the simple (phone) and the advanced HUD. */
  setSimple(on: boolean) {
    this.simple = on;
    this.root.classList.toggle('simple-ui', on);
    this.quickBar.classList.toggle('hidden', !on);
    this.cmdBar.classList.toggle('hidden', on);
    if (!on) this.setMore(false);
    // rotate / thermal buttons live in the More panel; support powers ride in the quick bar
    if (on) this.moreView.appendChild(this.viewCtrl);
    else this.viewWrap.appendChild(this.viewCtrl);
    if (on) this.viewWrap.appendChild(this.clock.el);
    else this.viewCtrl.prepend(this.clock.el);
    for (const b of [...this.toolsRow.querySelectorAll<HTMLElement>('.support-btn'), ...this.qbPowers.querySelectorAll<HTMLElement>('.support-btn')]) {
      (on ? this.qbPowers : this.toolsRow).appendChild(b);
    }
    this.cmdKey = '';
    this.forceSelectionRefresh();
    this.actions.onLayout();
  }

  /** Fold the build sidebar (simple scheme: down to a slim strip of tabs). */
  setCollapsed(on: boolean) {
    if (this.root.classList.contains('sb-collapsed') === on) return;
    this.root.classList.toggle('sb-collapsed', on);
    this.actions.onLayout();
  }

  /** Current order mode (place / sell / repair / attack-move / patrol / escort), for the quick bar's Cancel. */
  setOrderMode(m: string | null) {
    if (m === this.orderMode) return;
    this.orderMode = m;
    this.forceSelectionRefresh();
  }

  /** Brief ring on units that just took an order / got selected. */
  flashUnits(ids: number[], kind: 'move' | 'attack' | 'select') {
    if (!ids.length) return;
    const color = kind === 'attack' ? '255,90,70' : kind === 'select' ? '255,240,170' : '120,255,170';
    this.flashes.push({ ids: ids.slice(0, 80), color, t0: performance.now() / 1000 });
    if (this.flashes.length > 4) this.flashes.shift();
  }

  /** Small ripple where a tap landed (feedback for taps that had nothing to do). */
  tapRipple(x: number, y: number) {
    this.ripples.push({ x, y, t0: performance.now() / 1000 });
    if (this.ripples.length > 4) this.ripples.shift();
  }

  /** Letterbox bars while a cinematic moment plays. */
  setCinematic(on: boolean) {
    this.viewWrap.classList.toggle('cine-on', on);
  }

  attach(world: World, renderer: GameRenderer, player: number) {
    this.world = world;
    this.renderer = renderer;
    this.player = player;
    this.fogCanvas.width = world.map.w;
    this.fogCanvas.height = world.map.h;
    this.fogImg = new ImageData(world.map.w, world.map.h);
    this.shownCredits = world.players[player].credits;
    const f = FACTION_INFO[world.players[player].faction];
    this.root.style.setProperty('--faction', '#' + f.accent.toString(16).padStart(6, '0'));
    this.root.dataset.faction = f.id;
    (this.sidebar.querySelector('.sb-faction') as HTMLElement).innerHTML = `${flagHtml(f.id)}<span><small>${FACTION_MOTTO[f.id] ?? 'Command'}</small>${f.name}</span>`;
    this.mmStatic.width = this.minimap.width;
    this.mmStatic.height = this.minimap.height;
    this.buildCameos();
    this.setTab('building');
    this.live?.dispose();
    this.live = new LivePortrait(this.cameos, renderer.quality !== 'low' && player >= 0);
  }

  // --------------------------------------------------------------- sidebar

  private buildSidebar() {
    const sb = (this.sidebar = el('aside', 'sidebar', this.root));
    const toggle = el('button', 'sb-toggle', this.root);
    toggle.title = 'Hide / show the command sidebar';
    toggle.innerHTML = icon('chevron');
    toggle.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    toggle.onclick = () => this.setCollapsed(!this.root.classList.contains('sb-collapsed'));
    const head = el('div', 'sb-head', sb);
    el('div', 'sb-faction', head);
    const menuBtn = el('button', 'icon-btn', head);
    menuBtn.innerHTML = icon('menu');
    menuBtn.title = 'Menu (Esc)';
    menuBtn.onclick = () => this.actions.onTool('menu');

    const radarFrame = el('div', 'radar-frame', sb);
    const radar = el('div', 'radar', radarFrame);
    this.minimap = el('canvas', 'minimap', radar) as HTMLCanvasElement;
    this.minimap.width = 400;
    this.minimap.height = 300;
    this.radarOff = el('div', 'radar-off', radar);
    this.radarOff.textContent = 'RADAR OFFLINE';
    let dragging = false;
    const mm = (ev: PointerEvent, drag: boolean) => {
      const r = this.minimap.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * this.minimap.width;
      const py = ((ev.clientY - r.top) / r.height) * this.minimap.height;
      const p = this.fromMinimap(px, py);
      this.actions.onMinimap(p.x, p.y, drag);
    };
    this.minimap.addEventListener('pointerdown', (ev) => {
      dragging = true;
      this.minimap.setPointerCapture(ev.pointerId);
      mm(ev, false);
    });
    this.minimap.addEventListener('pointermove', (ev) => dragging && mm(ev, true));
    this.minimap.addEventListener('pointerup', () => (dragging = false));
    this.minimap.addEventListener('contextmenu', (e) => e.preventDefault());

    const stats = el('div', 'sb-stats', sb);
    this.creditsEl = el('div', 'credits', stats);
    const power = el('div', 'power', stats);
    power.innerHTML = icon('bolt', 'power-ico');
    const bar = el('div', 'power-bar', power);
    this.powerFill = el('div', 'power-fill', bar);
    this.powerText = el('div', 'power-text', power);

    const tools = (this.toolsRow = el('div', 'sb-tools', sb));
    const mk = (id: 'repair' | 'sell' | 'boxselect', title: string, ico: string, cls = '') => {
      const b = el('button', 'tool-btn ' + cls, tools);
      b.innerHTML = ico;
      b.title = title;
      b.onclick = () => this.actions.onTool(id);
      this.toolBtns.set(id, b);
    };
    mk('repair', 'Repair mode (R)', ICONS.repair);
    mk('sell', 'Sell mode (X)', ICONS.sell);
    mk('boxselect', 'Box select (touch)', ICONS.box, 'touch-only');
    this.support = new SupportPower(this, tools); // airborne-drop support power
    this.superweapons = new SuperweaponPower(this, tools); // superweapon (superweapons.ts)

    const tabs = el('div', 'sb-tabs', sb);
    for (const t of TABS) {
      const b = el('button', 'tab', tabs);
      b.innerHTML = icon(t.icon) + `<span>${t.label}</span><i class="tab-badge"></i>`;
      b.title = t.label;
      b.onclick = () => {
        this.setTab(t.cat);
        // simple scheme: a tab in the folded strip opens the build menu on that tab
        if (this.simple) this.setCollapsed(false);
      };
      this.tabEls.set(t.cat, b);
    }
    this.grid = el('div', 'sb-grid', sb);
  }

  setTab(cat: Category) {
    this.tab = cat;
    for (const [c, b] of this.tabEls) b.classList.toggle('active', c === cat);
    for (const [id, b] of this.cameoEls) b.style.display = DEFS[id].category === cat ? '' : 'none';
  }

  private buildCameos() {
    this.grid.innerHTML = '';
    this.cameoEls.clear();
    const p = this.world.players[this.player];
    const style = styleFor(this.world, this.player);
    for (const d of defsForFaction(p.faction)) {
      const b = el('button', 'cameo', this.grid);
      b.dataset.def = d.id;
      const img = el('img', '', b) as HTMLImageElement;
      img.src = this.cameos.get(d.id, style);
      img.alt = d.name;
      img.draggable = false;
      el('span', 'c-name', b).textContent = d.name;
      el('span', 'c-cost', b).textContent = `$${d.cost}`;
      el('div', 'c-prog', b);
      el('span', 'c-count', b);
      el('span', 'c-status', b);
      b.onclick = (ev) => this.actions.onCameo(d.id, d.category, ev.shiftKey);
      b.oncontextmenu = (ev) => {
        ev.preventDefault();
        this.actions.onCancel(d.id);
      };
      // long-press cancels on touch
      let timer = 0;
      b.addEventListener('touchstart', () => {
        timer = window.setTimeout(() => {
          timer = -1;
          this.actions.onCancel(d.id);
        }, 550);
      }, { passive: true });
      b.addEventListener('touchend', (ev) => {
        if (timer === -1) ev.preventDefault();
        clearTimeout(timer);
      });
      b.onpointerenter = (ev) => {
        if (ev.pointerType !== 'mouse') return;
        this.hoverCameo = d.id;
        this.showTooltip(d, b);
      };
      b.onpointerleave = () => {
        this.hoverCameo = null;
        this.tooltip.classList.add('hidden');
      };
      this.cameoEls.set(d.id, b);
    }
  }

  private showTooltip(d: Def, anchor: HTMLElement) {
    const lines: string[] = [`<b>${d.name}</b> <span class="tt-cost">$${d.cost}</span>`, `<div class="tt-desc">${d.desc}</div>`];
    const extra: string[] = [];
    if (d.kind === 'building' && d.power) extra.push(`Power ${d.power > 0 ? '+' : ''}${d.power}`);
    if (d.kind === 'unit') {
      extra.push(`HP ${d.hp}`);
      if (d.weapon) {
        const w = WEAPONS[d.weapon];
        extra.push(`Range ${w.range}`);
        extra.push(w.air === 'only' ? 'Anti-air only' : w.air === 'yes' ? 'Hits ground + air' : 'Ground targets');
      }
      if (d.aps) extra.push(`APS ${Math.round(d.aps * 100)}%`);
    }
    if (extra.length) lines.push(`<div class="tt-stats">${extra.join(' · ')}</div>`);
    const missing = d.prereq.filter((r) => !this.world.hasRole(this.player, r));
    if (missing.length) lines.push(`<div class="tt-req">Requires: ${missing.map(roleName).join(', ')}</div>`);
    else if (d.kind === 'unit' && isSortieJet(d)) {
      // jet cap: one parking pad per jet (airbase.ts)
      const used = jetCount(this.world, this.player) + jetsQueued(this.world, this.player);
      const cap = padCap(this.world, this.player);
      lines.push(`<div class="${used >= cap ? 'tt-req' : 'tt-stats'}">Airbase pads ${used}/${cap}${used >= cap ? ' - build another Airbase for more jets' : ''}</div>`);
    }
    this.tooltip.innerHTML = lines.join('');
    this.tooltip.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    const tr = this.tooltip.getBoundingClientRect();
    this.tooltip.style.left = `${Math.max(4, r.left - tr.width - 8)}px`;
    this.tooltip.style.top = `${Math.min(window.innerHeight - tr.height - 4, r.top)}px`;
  }

  setToolActive(tool: string | null) {
    for (const [id, b] of this.toolBtns) b.classList.toggle('active', id === tool);
    for (const [id, b] of this.moreTools) b.classList.toggle('on', id === tool);
    if (tool !== this.activeTool) {
      this.activeTool = tool;
      this.forceSelectionRefresh();
    }
  }

  // --------------------------------------------------------------- updates

  update(dt: number) {
    const w = this.world;
    const p = w.players[this.player];
    // credits ticker
    const diff = p.credits - this.shownCredits;
    this.shownCredits += Math.abs(diff) < 2 ? diff : diff * Math.min(1, dt * 8);
    this.creditsEl.textContent = `$ ${Math.floor(this.shownCredits).toLocaleString('en-US')}`;
    // power
    const out = p.powerOut;
    const use = p.powerUse;
    const k = out > 0 ? Math.min(1, use / out) : use > 0 ? 1 : 0;
    this.powerFill.style.width = `${Math.round(k * 100)}%`;
    this.powerFill.className = 'power-fill ' + (use > out ? 'low' : k > 0.85 ? 'warn' : 'ok');
    this.powerText.textContent = `${use}/${out}`;
    // cameos
    const tabState = new Map<Category, { ready: boolean; busy: boolean; avail: boolean }>();
    for (const [id, b] of this.cameoEls) {
      const d = DEFS[id];
      const cat = d.category;
      const can = w.canBuild(this.player, id);
      const q = p.queues[cat];
      const count = q.filter((i) => i.def === id).length;
      const head = q[0]?.def === id ? q[0] : null;
      const ready = p.ready[cat] === id;
      b.classList.toggle('disabled', !can && !count && !ready);
      b.classList.toggle('ready', ready);
      b.classList.toggle('building', !!head);
      b.classList.toggle('blocked', can && d.kind === 'building' && ((q.length > 0 && q[0].def !== id) || (!!p.ready[cat] && !ready)));
      (b.querySelector('.c-prog') as HTMLElement).style.setProperty('--p', head ? String(head.progress) : count ? '0' : '1');
      (b.querySelector('.c-count') as HTMLElement).textContent = count > 1 ? String(count) : '';
      const padsFull = !can && !head && d.kind === 'unit' && isSortieJet(d) && d.prereq.every((r) => w.hasRole(this.player, r));
      (b.querySelector('.c-status') as HTMLElement).textContent = ready ? 'READY' : head && p.credits <= 0 ? 'NO FUNDS' : head && w.isLowPower(p) ? 'LOW POWER' : padsFull ? 'PADS FULL' : '';
      const st = tabState.get(cat) ?? { ready: false, busy: false, avail: false };
      st.ready ||= ready;
      st.busy ||= !!head;
      st.avail ||= can;
      tabState.set(cat, st);
    }
    if (this.hoverCameo) this.showTooltip(DEFS[this.hoverCameo], this.cameoEls.get(this.hoverCameo)!);
    for (const [cat, b] of this.tabEls) {
      const st = tabState.get(cat);
      b.classList.toggle('t-ready', !!st?.ready);
      b.classList.toggle('t-busy', !!st?.busy);
      b.classList.toggle('t-empty', !st?.avail);
    }
    this.updateSelection();
    this.support.update();
    this.clock.update(dt, this.renderer?.atmos);
    this.peace.update(w.tick);
    this.superweapons.update();
  }

  /** Selection details (portrait panel) + context command buttons. */
  private updateSelection() {
    const w = this.world;
    const sel = [...this.renderer.selection].map((id) => w.get(id)).filter((e): e is Entity => !!e);
    const key = sel.map((e) => `${e.id}:${Math.round((e.hp / e.maxHp) * 20)}:${e.passengers.length}:${e.kind === 'unit' && unitDef(e.def).harvester ? Math.round(e.cargo / 90) : 0}:${e.rank}:${Math.floor(e.xp / 25)}:${e.sortie ? `${e.sortie.phase}${Math.round(rearmProgress(e) * 20)}` : ''}`).join(',');
    if (key === this.lastSelKey) return;
    this.lastSelKey = key;
    const own = sel.filter((e) => e.owner === this.player);
    const units = own.filter((e) => e.kind === 'unit');
    const ownBuilding = own.length === 1 && own[0].kind === 'building' ? own[0] : null;
    const style = styleFor(w, this.player);
    if (sel.length === 0) {
      this.selPanel.classList.add('hidden');
      this.live?.detach();
    } else {
      this.selPanel.classList.remove('hidden');
      if (sel.length === 1) {
        const e = sel[0];
        const d = DEFS[e.def];
        const owner = e.owner < 0 ? 'Neutral' : w.players[e.owner].name;
        const hp = e.hp / e.maxHp;
        const img = e.owner === this.player ? this.cameos.get(e.def, style) : this.cameos.get(e.def, styleFor(w, e.owner));
        const stats: string[] = [];
        if (d.kind === 'unit' && d.harvester) stats.push(`Cargo $${e.cargo}`);
        if (d.kind === 'unit' && d.transport) stats.push(`Passengers ${e.passengers.length}/${d.transport}`);
        if (d.kind === 'building' && d.garrison) stats.push(`Garrison ${e.owner >= 0 ? e.passengers.length : 0}/${d.garrison}`);
        if (d.kind === 'building' && d.power) stats.push(`Power ${d.power > 0 ? '+' : ''}${d.power}`);
        if (e.sortie) stats.push('1 heavy bomb per sortie', 'Ground');
        else if (d.weapon && WEAPONS[d.weapon]) {
          const wp = WEAPONS[d.weapon];
          stats.push(`Range ${wp.range}`, wp.air === 'only' ? 'Anti-air' : wp.air === 'yes' ? 'Ground + air' : 'Ground');
        }
        if (d.kind === 'unit' && d.aps) stats.push(`APS ${Math.round(d.aps * 100)}%`);
        // jets: sortie status and rearm progress, shown in the simple (phone) UI too
        const jet = e.sortie && e.owner === this.player ? `<div class="sp-jet${e.sortie.rearm > 0 ? ' rearm' : ''}"><span>${sortieLabel(e)}</span>${e.sortie.phase === 'parked' ? `<i style="--k:${rearmProgress(e).toFixed(3)}"></i>` : ''}</div>` : '';
        const segs = 12;
        const on = Math.ceil(hp * segs);
        const bar = Array.from({ length: segs }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('');
        const rel = e.owner === this.player ? 'own' : e.owner < 0 ? 'neutral' : 'enemy';
        const vet = rankLineHtml(e, e.owner === this.player, canRank(d));
        this.setSelHtml(`<div class="portrait ${rel}${e.rank >= 2 ? ' vet-elite' : ''}"><img src="${img}" alt=""><span class="pt-scan"></span>${rankBadgeSvg(e.rank)}</div><div class="sp-info"><b>${d.name}</b><div class="sp-owner">${owner} · ${roleLabel(d)}</div><div class="sp-hp" style="--hpc:${hpColor(hp)}">${bar}</div><div class="sp-hpt">${Math.ceil(e.hp)} / ${e.maxHp}</div>${jet}${vet}${stats.length ? `<div class="sp-extra">${stats.join(' · ')}</div>` : ''}</div>`);
        const id = e.id;
        this.live?.attach(this.selPanel.querySelector<HTMLElement>('.portrait'), () => w.get(id), styleFor(w, e.owner));
      } else {
        const counts = new Map<string, number>();
        for (const e of sel) counts.set(e.def, (counts.get(e.def) ?? 0) + 1);
        const html = `<div class="sp-multi">${[...counts]
          .map(([id, n]) => `<button class="sp-type" data-def="${id}" title="${DEFS[id].name}"><img src="${this.cameos.get(id, style)}"><span>${n}</span></button>`)
          .join('')}</div>`;
        // only rebuild when it changed (a rebuild under the finger would eat the tap)
        if (this.setSelHtml(html)) this.selPanel.querySelectorAll<HTMLElement>('.sp-type').forEach((b) => (b.onclick = () => this.actions.onSelectType(b.dataset.def!)));
        // the primary (most numerous) type turns live in its button
        let prim = '';
        for (const [id, n] of counts) if (!prim || n > counts.get(prim)!) prim = id;
        const lead = sel.find((x) => x.def === prim)!;
        const leadId = lead.id;
        this.live?.attach(this.selPanel.querySelector<HTMLElement>(`.sp-type[data-def="${prim}"]`), () => w.get(leadId), styleFor(w, lead.owner));
      }
    }
    if (this.simple) {
      this.updateQuickBar(sel, units, ownBuilding);
      return;
    }
    // command buttons
    const cmds: [string, string, Parameters<HudActions['onCommand']>[0], string][] = [];
    if (units.length) {
      cmds.push(['Stop', 'S', 'stop', ICONS.stop], ['Attack-Move', 'A', 'attackMove', ICONS.attackMove]);
      if (units.some((u) => unitDef(u.def).mcv)) cmds.push(['Deploy', 'D', 'deploy', ICONS.deploy]);
      if (units.some((u) => u.passengers.length > 0)) cmds.push(['Unload', 'D', 'deploy', ICONS.unload]);
      cmds.push(['Deselect', '', 'deselect', ICONS.deselect]);
    } else if (ownBuilding) {
      if (DEFS[ownBuilding.def].faction === 'neutral') {
        // captured tech structure / garrisoned house: no selling
        if (ownBuilding.passengers.length) cmds.push(['Evacuate', 'D', 'evacuate', ICONS.unload]);
        cmds.push(['Repair', '', 'repairSel', ICONS.repair], ['Deselect', '', 'deselect', ICONS.deselect]);
      } else cmds.push(['Repair', '', 'repairSel', ICONS.repair], ['Sell', '', 'sellSel', ICONS.sell], ['Deselect', '', 'deselect', ICONS.deselect]);
    } else {
      cmds.push(['Select Army', 'W', 'selectArmy', ICONS.army]);
    }
    // rebuild only when the set of buttons changes (a rebuild between press and release loses the click)
    const ck = cmds.map((c) => c[2] + c[0]).join(',');
    if (ck === this.cmdKey) return;
    this.cmdKey = ck;
    this.cmdBar.innerHTML = '';
    for (const [label, key2, id, ico] of cmds) {
      const b = el('button', 'cmd-btn', this.cmdBar);
      b.title = label + (key2 ? ` (${key2})` : '');
      b.innerHTML = `${ico}<span>${label}</span>${key2 ? `<kbd>${key2}</kbd>` : ''}`;
      b.onclick = () => this.actions.onCommand(id);
    }
  }

  private setSelHtml(html: string): boolean {
    if (html === this.selHtml) return false;
    this.selHtml = html;
    this.selPanel.innerHTML = html;
    return true;
  }

  /** Simple scheme: [ARMY] [ON SCREEN] [BOX] [✕] + context buttons only when they apply. */
  private updateQuickBar(sel: Entity[], units: Entity[], ownBuilding: Entity | null) {
    const b: [string, string, string, () => void, string][] = [];
    const cmd = (c: HudCommand) => () => this.actions.onCommand(c);
    const mode = this.orderMode;
    const boxOn = this.activeTool === 'boxselect';
    b.push(['army', 'Army', ICONS.army, cmd('selectArmy'), 'Select your whole army']);
    b.push(['screen', 'On screen', ICONS.screen, cmd('selectScreen'), 'Select all combat units on screen']);
    b.push([`box${boxOn ? ' on' : ''}`, 'Box', ICONS.box, () => this.actions.onTool('boxselect'), 'Box select: drag a box on the map']);
    if (sel.length) b.push(['deselect', 'Clear', ICONS.deselect, cmd('deselect'), 'Deselect']);
    if (units.some((u) => unitDef(u.def).mcv)) b.push(['ctx deploy', 'Deploy', ICONS.deploy, cmd('deploy'), 'Deploy the MCV into a Construction Yard']);
    if (units.some((u) => u.passengers.length > 0)) b.push(['ctx', 'Unload', ICONS.unload, cmd('deploy'), 'Unload the passengers']);
    if (ownBuilding) {
      if (ownBuilding.passengers.length) b.push(['ctx', 'Evacuate', ICONS.unload, cmd('evacuate'), 'Send the garrison out']);
      if (ownBuilding.hp < ownBuilding.maxHp) b.push(['ctx', 'Repair', ICONS.repair, cmd('repairSel'), 'Repair this building']);
      if (DEFS[ownBuilding.def].faction !== 'neutral') b.push(['ctx', 'Sell', ICONS.sell, cmd('sellSel'), 'Sell this building']);
    }
    if (mode || boxOn) b.push(['ctx cancel', 'Cancel', ICONS.cancel, cmd('cancel'), 'Cancel']);
    // More panel: unit orders only with units selected
    for (const x of this.moreUnitBtns) x.disabled = !units.length;
    const key = b.map((x) => x[0] + x[1]).join(',');
    if (key === this.cmdKey) return;
    this.cmdKey = key;
    this.qbMain.innerHTML = '';
    for (const [cls, label, ico, fn, title] of b) {
      const x = el('button', `qb-btn ${cls}`, this.qbMain);
      x.innerHTML = `${ico}<span>${label}</span>`;
      x.title = title;
      x.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      x.onclick = fn;
    }
  }

  forceSelectionRefresh() {
    this.lastSelKey = '#';
  }

  // --------------------------------------------------------------- minimap

  /**
   * World (tile) -> minimap pixel transform: an isometric diamond turned with
   * the camera so "up" on the minimap is always "up" on screen.
   */
  private mmTransform() {
    const { w, h } = this.world.map;
    const yaw = this.renderer.yaw;
    if (yaw === this.mmYaw) return;
    this.mmYaw = yaw;
    this.mmDirty = true;
    const kx = this.minimap.width / (w + h);
    const ky = this.minimap.height / (w + h);
    const odd = Math.abs(Math.round(yaw / (Math.PI / 2))) % 2 === 1;
    const W2 = odd ? h : w;
    const H2 = odd ? w : h;
    const a = -yaw;
    const A00 = Math.cos(a);
    const A01 = -Math.sin(a);
    const A10 = Math.sin(a);
    const A11 = Math.cos(a);
    const b0 = W2 / 2 - (A00 * w) / 2 - (A01 * h) / 2;
    const b1 = H2 / 2 - (A10 * w) / 2 - (A11 * h) / 2;
    this.mmM = new DOMMatrix([kx * (A00 - A10), ky * (A00 + A10), kx * (A01 - A11), ky * (A01 + A11), kx * (b0 - b1 + H2), ky * (b0 + b1)]);
    this.mmInv = this.mmM.inverse();
  }

  private fromMinimap(px: number, py: number) {
    this.mmTransform();
    const p = this.mmInv.transformPoint(new DOMPoint(px, py));
    return { x: p.x, y: p.y };
  }

  /** Static radar layer: terrain, ore, units and fog (redrawn a few times per second). */
  drawMinimap() {
    const w = this.world;
    const { map } = w;
    this.mmTransform();
    this.mmDirty = false;
    const ctx = this.mmStatic.getContext('2d')!;
    const p = w.players[this.player];
    const radar = p.radarOnline;
    this.radarOff.classList.toggle('hidden', radar);
    this.minimap.parentElement!.classList.toggle('online', radar);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#05080a';
    ctx.fillRect(0, 0, this.mmStatic.width, this.mmStatic.height);
    const M = this.mmM;
    ctx.setTransform(M.a, M.b, M.c, M.d, M.e, M.f);
    ctx.imageSmoothingEnabled = true;
    // real terrain colours (grass, fields, roads, water, rock) baked by the terrain
    ctx.drawImage(this.renderer.terrain.minimapImage, 0, 0, map.w, map.h);
    // ore
    for (let i = 0; i < map.ore.length; i++) {
      if (map.ore[i] && p.explored[i]) {
        ctx.fillStyle = map.oreKind[i] === 2 ? '#c060ff' : '#e0b840';
        ctx.fillRect(i % map.w, Math.floor(i / map.w), 1, 1);
      }
    }
    // fog
    const data = this.fogImg.data;
    for (let i = 0; i < map.w * map.h; i++) {
      data[i * 4 + 3] = p.visible[i] ? 0 : p.explored[i] ? 120 : 255;
    }
    this.fogCanvas.getContext('2d')!.putImageData(this.fogImg, 0, 0);
    ctx.drawImage(this.fogCanvas, 0, 0);
    // entities (only what the player can see; units need the radar). Classic fog (RA2): structures on
    // explored ground are map knowledge and stay on the map even without a radar.
    const classic = w.fog === 'classic';
    for (const e of w.list) {
      if (e.dead || e.inside >= 0) continue;
      const own = e.owner === this.player;
      if (!own && !this.renderer.isShown(e.id)) continue;
      if (!radar && !(e.kind === 'building' && (own || classic))) continue;
      const col = e.owner < 0 ? '#d8d8c8' : '#' + w.players[e.owner].color.toString(16).padStart(6, '0');
      if (e.kind === 'building') {
        const d = buildingDef(e.def);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(e.tx - 0.3, e.ty - 0.3, d.w + 0.6, d.h + 0.6);
        ctx.fillStyle = col;
        ctx.fillRect(e.tx, e.ty, d.w, d.h);
      } else if (!unitDef(e.def).temp) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(e.x - 1.2, e.y - 1.2, 2.4, 2.4);
        ctx.fillStyle = col;
        ctx.fillRect(e.x - 0.85, e.y - 0.85, 1.7, 1.7);
      }
    }
  }

  /** Per-frame radar: composite the static layer, the sweep and the camera frustum footprint. */
  tickMinimap(now: number) {
    if (!this.world) return;
    this.mmTransform();
    if (this.mmDirty) this.drawMinimap();
    const ctx = this.minimap.getContext('2d')!;
    const { map } = this.world;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.mmStatic, 0, 0);
    const M = this.mmM;
    const radar = this.world.players[this.player].radarOnline;
    if (radar) {
      // rotating sweep, clipped to the map diamond
      const c = M.transformPoint(new DOMPoint(map.w / 2, map.h / 2));
      const R = Math.hypot(this.minimap.width, this.minimap.height) * 0.6;
      const ang = (now * 1.3) % (Math.PI * 2);
      ctx.save();
      ctx.beginPath();
      for (const [x, y] of [[0, 0], [map.w, 0], [map.w, map.h], [0, map.h]]) {
        const q = M.transformPoint(new DOMPoint(x, y));
        ctx.lineTo(q.x, q.y);
      }
      ctx.closePath();
      ctx.clip();
      const g = (ctx as CanvasRenderingContext2D & { createConicGradient?: (a: number, x: number, y: number) => CanvasGradient }).createConicGradient?.(ang - 1.1, c.x, c.y);
      if (g) {
        g.addColorStop(0, 'rgba(90,255,160,0)');
        g.addColorStop(0.175, 'rgba(90,255,160,0.26)');
        g.addColorStop(0.176, 'rgba(90,255,160,0)');
        g.addColorStop(1, 'rgba(90,255,160,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(c.x, c.y);
        ctx.arc(c.x, c.y, R, ang - 1.1, ang);
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(150,255,190,0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(c.x + Math.cos(ang) * R, c.y + Math.sin(ang) * R);
      ctx.stroke();
      ctx.restore();
    }
    // camera view: the frustum footprint (a trapezoid with the perspective camera)
    const corners = this.renderer.viewCorners();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 1.6;
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 3;
    ctx.beginPath();
    corners.forEach((pt, i) => {
      const q = M.transformPoint(new DOMPoint(pt.x, pt.y));
      if (i) ctx.lineTo(q.x, q.y);
      else ctx.moveTo(q.x, q.y);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // --------------------------------------------------------------- overlay

  resizeOverlay(w: number, h: number, dpr: number) {
    this.overlay.width = Math.round(w * dpr);
    this.overlay.height = Math.round(h * dpr);
    this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Show a fading waypoint line from each ordered unit to its destination / target. */
  orderLine(ids: number[], x: number, y: number, target: number, kind: 'move' | 'attackMove' | 'attack' | 'other') {
    const color = kind === 'attack' ? '255,70,60' : kind === 'attackMove' ? '255,150,70' : '110,255,170';
    this.orderLines.push({ ids, x, y, target, color, t0: performance.now() / 1000 });
    if (this.orderLines.length > 4) this.orderLines.shift();
  }

  /** Can the local player currently see this entity (fog of war)? Own entities always. */
  private seen(e: Entity) {
    if (e.owner === this.player) return true;
    if (!this.renderer.isShown(e.id)) return false;
    if (e.kind === 'building') {
      const d = buildingDef(e.def);
      return this.world.visibleTo(this.player, e.tx + d.w / 2, e.ty + d.h / 2) || this.world.visibleTo(this.player, e.tx + 0.5, e.ty + 0.5);
    }
    return true;
  }

  private coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

  /** Health bars, harvester cargo pips, group numbers, rally and waypoint lines. */
  drawOverlay(alpha: number, hover: number, groups: Map<number, number>, now: number) {
    const ctx = this.octx;
    const w = this.world;
    const r = this.renderer;
    const dt = Math.min(0.1, Math.max(0, now - this.lastOverlayT));
    this.lastOverlayT = now;
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const sel = r.selection;
    const attract = this.root.classList.contains('attract');
    // health bars: a touch larger on phones and when zoomed out (src/render/readability.ts)
    const bk = (this.coarse ? 1.15 : 1) * (1 + 0.3 * Math.max(0, Math.min(1, (1.6 - r.zoom) / 1.1)));
    const bh = Math.round(4 * bk);
    // waypoint lines (fade out after the order)
    for (let i = this.orderLines.length - 1; i >= 0; i--) {
      const L = this.orderLines[i];
      const k = (now - L.t0) / 1.5;
      if (k >= 1) {
        this.orderLines.splice(i, 1);
        continue;
      }
      let dest = { x: L.x, y: L.y, h: standHeight(w.map, L.x, L.y) };
      if (L.target >= 0) {
        const t = w.get(L.target);
        if (!t || !this.seen(t)) continue;
        const tp = r.entityPos(t, alpha);
        dest = { x: tp.x, y: tp.z, h: tp.y };
      }
      const b = r.project(dest.x, dest.h + 0.05, dest.y);
      const a0 = (1 - k) * (1 - k);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 5]);
      ctx.lineDashOffset = -now * 26;
      for (const id of L.ids) {
        const u = w.get(id);
        if (!u || u.dead || !r.isShown(id)) continue;
        const up = r.entityPos(u, alpha);
        const a = r.project(up.x, up.y + 0.05, up.z);
        const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        grad.addColorStop(0, `rgba(${L.color},${0.15 * a0})`);
        grad.addColorStop(1, `rgba(${L.color},${0.85 * a0})`);
        ctx.strokeStyle = grad;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    // order / selection flashes: a ring that opens around each unit, and tap ripples
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const F = this.flashes[i];
      const k = (now - F.t0) / 0.55;
      if (k >= 1 || k < 0) {
        if (k >= 1) this.flashes.splice(i, 1);
        continue;
      }
      ctx.lineWidth = 2;
      ctx.strokeStyle = `rgba(${F.color},${(1 - k) * 0.95})`;
      for (const id of F.ids) {
        const u = w.get(id);
        if (!u || u.dead || !r.isShown(id)) continue;
        const up = r.entityPos(u, alpha);
        const c = r.project(up.x, up.y + 0.05, up.z);
        const rad = 8 + 16 * k;
        ctx.beginPath();
        ctx.ellipse(c.x, c.y, rad, rad * 0.55, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const R = this.ripples[i];
      const k = (now - R.t0) / 0.45;
      if (k >= 1 || k < 0) {
        if (k >= 1) this.ripples.splice(i, 1);
        continue;
      }
      ctx.lineWidth = 2;
      ctx.strokeStyle = `rgba(255,255,255,${(1 - k) * 0.6})`;
      ctx.beginPath();
      ctx.arc(R.x, R.y, 6 + 18 * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const e of w.list) {
      if (e.dead) continue;
      const selected = sel.has(e.id);
      const recent = w.tick - e.lastHurt < TPS * 2.5;
      let st = this.hpState.get(e.id);
      const hp = e.hp / e.maxHp;
      if (st) {
        if (hp < st.hp - 1e-4) {
          st.flash = 1;
          st.ghost = Math.max(st.ghost, st.hp);
        }
        st.hp = hp;
        st.flash = Math.max(0, st.flash - dt * 3.5);
        st.ghost = st.ghost > hp ? Math.max(hp, st.ghost - dt * 0.45) : hp;
      }
      // own jets rearming on their pads always show the rearm bar (airbase.ts)
      const rearming = !!e.sortie && e.sortie.rearm > 0 && e.owner === this.player;
      const bar = selected || e.id === hover || recent || rearming;
      const pop = e.kind === 'unit' ? this.rankPops.pop(e, now) : 0;
      if (!bar && !e.rank) continue;
      if (e.kind === 'unit' && unitDef(e.def).temp) continue;
      if (attract && !selected) continue;
      if (!this.seen(e)) continue;
      if (!bar) {
        // ranked units always wear their chevrons (RA2 style), even without a health bar
        const p = r.entityPos(e, alpha);
        const tp = r.project(p.x, p.y + r.visualHeight(e.id) + 0.14, p.z);
        drawRankInsignia(ctx, Math.round(tp.x), Math.round(tp.y - 3), e.rank, pop, now);
        continue;
      }
      if (!st) {
        st = { hp, ghost: hp, flash: 0 };
        this.hpState.set(e.id, st);
      }
      const pos = r.entityPos(e, alpha);
      const top = r.project(pos.x, pos.y + r.visualHeight(e.id) + 0.14, pos.z);
      const isB = e.kind === 'building';
      const inf = !isB && unitDef(e.def).category === 'infantry';
      const width = Math.round((isB ? Math.min(90, buildingDef(e.def).w * 20) : inf ? 20 : 32) * bk);
      const pips = isB ? buildingDef(e.def).w * 5 : inf ? 4 : 8;
      const x0 = Math.round(top.x - width / 2);
      // strategic icons sit above zoomed-out units: lift the bar over them
      const lift = isB ? 0 : r.readability.fadeAtPoint(pos.x, pos.y + r.visualHeight(e.id), pos.z) * 25;
      // zoomed out: the highlighted icon already marks selected units, keep only bars that say something
      if (lift > 15 && hp > 0.999 && !recent && e.id !== hover) continue;
      const y0 = Math.round(top.y - 3 - bh - lift);
      const team = e.owner < 0 ? '#d8d0a0' : '#' + w.players[e.owner].color.toString(16).padStart(6, '0');
      // frame + team accent cap
      ctx.fillStyle = 'rgba(4,8,10,0.78)';
      ctx.fillRect(x0 - 4, y0 - 2, width + 6, bh + 4);
      ctx.fillStyle = team;
      ctx.fillRect(x0 - 4, y0 - 2, 3, bh + 4);
      // lagging damage ghost
      const pw = width / pips;
      if (st.ghost > hp + 0.002) {
        ctx.fillStyle = 'rgba(255,220,180,0.55)';
        ctx.fillRect(x0, y0, width * st.ghost, bh);
      }
      const filled = Math.ceil(hp * pips);
      const col = hpColor(hp);
      for (let i = 0; i < filled; i++) {
        const sx = x0 + i * pw;
        const last = i === filled - 1;
        const fw = last ? Math.max(1, Math.min(pw - 1, width * hp - i * pw)) : pw - 1;
        ctx.fillStyle = col;
        ctx.fillRect(sx, y0, fw, bh);
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        ctx.fillRect(sx, y0, fw, 1);
      }
      if (st.flash > 0) {
        ctx.strokeStyle = `rgba(255,255,255,${st.flash})`;
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 - 3.5, y0 - 1.5, width + 5, bh + 3);
      }
      if (e.rank) drawRankInsignia(ctx, x0 - 11, y0 + 1, e.rank, pop, now);
      if (e.kind === 'unit' && unitDef(e.def).harvester && selected && e.owner === this.player) {
        const k = e.cargo / 900;
        ctx.fillStyle = '#e8c040';
        for (let i = 0; i < Math.ceil(k * 5); i++) ctx.fillRect(x0 + i * 6, y0 + bh + 3, 4, 3);
      }
      if (e.sortie && e.owner === this.player && (rearming || (selected && e.sortie.phase === 'parked'))) {
        // jet rearm bar under the health bar: amber while rearming, green when armed and ready
        const k = Math.max(0, rearmProgress(e));
        const ry = y0 + bh + 3;
        ctx.fillStyle = 'rgba(4,8,10,0.78)';
        ctx.fillRect(x0 - 1, ry - 1, width + 2, 5);
        ctx.fillStyle = k >= 1 ? '#56e06a' : '#ffb020';
        ctx.fillRect(x0, ry, Math.max(1, width * k), 3);
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillRect(x0, ry, Math.max(1, width * k), 1);
      }
      const g = groups.get(e.id);
      if (g !== undefined && selected) {
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.fillStyle = '#fff';
        ctx.fillText(String(g), x0 + width + 4, y0 + 5);
      }
      // rally point of the selected factory
      if (selected && isB && e.owner === this.player && e.rallyX >= 0) {
        const a = r.project(pos.x, pos.y + 0.2, pos.z);
        const rh = standHeight(w.map, e.rallyX, e.rallyY);
        const b = r.project(e.rallyX, rh, e.rallyY);
        ctx.strokeStyle = 'rgba(230,255,120,0.75)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.lineDashOffset = -now * 20;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
        // beacon
        const pulse = 0.5 + 0.5 * Math.sin(now * 5);
        ctx.fillStyle = `rgba(230,255,120,${0.6 + 0.4 * pulse})`;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y - 18);
        ctx.lineTo(b.x + 9, b.y - 14);
        ctx.lineTo(b.x, b.y - 10);
        ctx.closePath();
        ctx.fill();
        ctx.fillRect(b.x - 1, b.y - 18, 2, 18);
      }
    }
    if (this.hpState.size > 600) for (const id of this.hpState.keys()) if (!w.get(id)) this.hpState.delete(id);
    this.rankPops.prune((id) => !!w.get(id));
    // keep the drone camera feed clear of bars and markers
    const keep = this.keepClear?.();
    if (keep) ctx.clearRect(keep.x, keep.y, keep.w, keep.h);
  }

  /** Screen rectangle the 2D overlay must leave clear (the drone camera picture-in-picture). */
  keepClear: (() => { x: number; y: number; w: number; h: number } | null) | null = null;

  /** Extra round button in the top-right view controls (thermal view...). */
  addViewButton(title: string, glyph: string, onClick: () => void): HTMLButtonElement {
    const vc = this.viewWrap.querySelector('.view-ctrl') as HTMLElement;
    const b = el('button', 'vc-btn', vc);
    const line = VIEW_ICONS.find(([re]) => re.test(title))?.[1];
    b.innerHTML = line && hasIcon(line) ? icon(line) : svg(glyph);
    b.title = title;
    b.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    b.onclick = onClick;
    return b;
  }

  /** Loading overlay while shaders warm up (k = 0..1, null removes it). */
  setLoading(k: number | null, text = 'Preparing battlefield') {
    let L = this.viewWrap.querySelector('.warmup') as HTMLElement | null;
    if (k === null) {
      L?.classList.add('done');
      setTimeout(() => L?.remove(), 350);
      return;
    }
    if (!L) {
      L = el('div', 'warmup', this.viewWrap);
      L.innerHTML = `<div class="wu-box"><div class="wu-title"></div><div class="wu-bar"><i></i></div><div class="wu-sub">Compiling shaders and materials</div></div>`;
    }
    (L.querySelector('.wu-title') as HTMLElement).textContent = `${text}… ${Math.round(k * 100)}%`;
    (L.querySelector('.wu-bar i') as HTMLElement).style.width = `${Math.round(k * 100)}%`;
  }

  // --------------------------------------------------------------- messages

  message(text: string, kind: 'info' | 'warn' | 'good' = 'info') {
    const m = el('div', `msg ${kind}`, this.messages);
    m.textContent = text;
    while (this.messages.children.length > 5) this.messages.firstChild!.remove();
    setTimeout(() => m.classList.add('fade'), 4500);
    setTimeout(() => m.remove(), 5200);
  }

  showHint(html: string | null) {
    if (!html) {
      this.hint.classList.add('hidden');
      return;
    }
    this.hint.innerHTML = html;
    this.hint.classList.remove('hidden');
  }

  setCursor(c: string) {
    this.viewWrap.dataset.cursor = c;
  }

  destroy() {
    this.live?.dispose();
    this.live = null;
    this.support.destroy();
    this.superweapons.destroy();
    this.root.remove();
    this.tooltip.remove();
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.appendChild(e);
  return e;
}

export function hpColor(k: number) {
  return k > 0.5 ? '#3ee05a' : k > 0.25 ? '#f2d02e' : '#f0452e';
}

export function flagHtml(faction: string) {
  return `<img class="flag" src="${flagDataUrl(faction)}" alt="">`;
}

/** Jet status line for the selection panel (airbase.ts sortie cycle). */
function sortieLabel(e: Entity): string {
  const s = e.sortie!;
  const pct = Math.round(rearmProgress(e) * 100);
  switch (s.phase) {
    case 'parked':
      return s.rearm > 0 ? `Rearming ${pct}%` : s.ammo > 0 ? 'Armed - tap a target' : 'Rearming';
    case 'taxiOut':
    case 'hold':
    case 'lineup':
      return 'Taxiing out';
    case 'takeoff':
      return 'Taking off';
    case 'sortie':
      return s.ammo > 0 ? 'Strike run' : 'In flight';
    case 'return':
      return 'Returning to base';
    case 'final':
      return 'Landing';
    case 'rollout':
    case 'taxiIn':
      return 'Taxiing in';
    case 'orbit':
      return 'No free pad - circling';
  }
}

function roleName(r: string) {
  const map: Record<string, string> = {
    conyard: 'Construction Yard',
    power: 'Power Plant',
    refinery: 'Refinery',
    barracks: 'Barracks',
    factory: 'War Factory',
    radar: 'Radar Center',
    airfield: 'Airbase',
    tech: 'Battle Lab',
  };
  return map[r] ?? r;
}
