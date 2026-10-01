import { DEFS, FACTION_INFO, WEAPONS, buildingDef, defsForFaction, unitDef } from '../sim/defs';
import { TPS, type Category, type Def, type Entity } from '../sim/types';
import type { World } from '../sim/world';
import type { CameoFactory } from '../render/cameo';
import { styleFor, type GameRenderer } from '../render/renderer';

export interface HudActions {
  onCameo(defId: string, cat: Category, shift: boolean): void;
  onCancel(defId: string): void;
  onTool(tool: 'repair' | 'sell' | 'menu' | 'boxselect'): void;
  onCommand(cmd: 'stop' | 'attackMove' | 'deploy' | 'selectArmy' | 'deselect' | 'sellSel' | 'repairSel'): void;
  onMinimap(x: number, y: number, drag: boolean): void;
  onSelectType(defId: string): void;
}

const TABS: { cat: Category; label: string; icon: string }[] = [
  { cat: 'building', label: 'Base', icon: '<path d="M3 21V10l9-6 9 6v11h-6v-6H9v6z"/>' },
  { cat: 'defense', label: 'Defense', icon: '<path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5z"/>' },
  { cat: 'infantry', label: 'Infantry', icon: '<circle cx="12" cy="5" r="3"/><path d="M8 22l1-8-2-1 1-5h8l1 5-2 1 1 8h-3l-1-6-1 6z"/>' },
  { cat: 'vehicle', label: 'Vehicles', icon: '<path d="M2 16h20v3H2zM5 12h11l3 4H4zM9 9h6v3H9zM15 10h7v1h-7z"/>' },
  { cat: 'air', label: 'Air', icon: '<path d="M12 2l2 7 8 4v2l-8-2-1 6 3 2v1l-4-1-4 1v-1l3-2-1-6-8 2v-2l8-4z"/>' },
];

const svg = (inner: string) => `<svg viewBox="0 0 24 24" fill="currentColor">${inner}</svg>`;

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
  tab: Category = 'building';
  private shownCredits = 0;
  private fogCanvas: HTMLCanvasElement;
  private fogImg: ImageData;
  private lastSelKey = '';
  private hoverCameo: string | null = null;
  private octx: CanvasRenderingContext2D;
  world!: World;
  renderer!: GameRenderer;
  player = 0;

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
    const bottomLeft = el('div', 'bottom-left', this.viewWrap);
    this.selPanel = el('div', 'selpanel hidden', bottomLeft);
    this.cmdBar = el('div', 'cmdbar', bottomLeft);
    this.tooltip = el('div', 'tooltip hidden', this.root);
    this.buildSidebar();
    this.fogCanvas = document.createElement('canvas');
    this.fogImg = new ImageData(1, 1);
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
    (this.sidebar.querySelector('.sb-faction') as HTMLElement).innerHTML = `${flagHtml(f.flag)}<span>${f.name}</span>`;
    this.buildCameos();
    this.setTab('building');
  }

  // --------------------------------------------------------------- sidebar

  private buildSidebar() {
    const sb = (this.sidebar = el('aside', 'sidebar', this.root));
    const head = el('div', 'sb-head', sb);
    el('div', 'sb-faction', head);
    const menuBtn = el('button', 'icon-btn', head);
    menuBtn.innerHTML = svg('<path d="M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z"/>');
    menuBtn.title = 'Menu (Esc)';
    menuBtn.onclick = () => this.actions.onTool('menu');

    const radar = el('div', 'radar', sb);
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
    const bar = el('div', 'power-bar', power);
    this.powerFill = el('div', 'power-fill', bar);
    this.powerText = el('div', 'power-text', power);

    const tools = el('div', 'sb-tools', sb);
    const mk = (id: 'repair' | 'sell' | 'boxselect', title: string, icon: string, cls = '') => {
      const b = el('button', 'tool-btn ' + cls, tools);
      b.innerHTML = svg(icon);
      b.title = title;
      b.onclick = () => this.actions.onTool(id);
      this.toolBtns.set(id, b);
    };
    mk('repair', 'Repair mode (R)', '<path d="M22 19l-9-9c1-2.6.4-5.6-1.7-7.7A6.9 6.9 0 0 0 4.4 1L9 5.6 5.6 9 1 4.4a6.9 6.9 0 0 0 1.3 6.9c2.1 2.1 5.1 2.7 7.7 1.7l9 9z"/>');
    mk('sell', 'Sell mode (X)', '<path d="M12 1v3m0 16v3M17 6.5c-.8-1.6-2.6-2.5-5-2.5-3 0-5 1.5-5 3.6 0 5 10 2.6 10 7.6 0 2.2-2.2 3.8-5 3.8-2.6 0-4.5-1-5.3-2.8" stroke="currentColor" stroke-width="2.2" fill="none"/>');
    mk('boxselect', 'Box select (touch)', '<path d="M3 3h4v2H5v2H3zm14 0h4v4h-2V5h-2zM3 17h2v2h2v2H3zm16 2v-2h2v4h-4v-2zM9 3h6v2H9zm0 16h6v2H9zM3 9h2v6H3zm16 0h2v6h-2z"/>', 'touch-only');

    const tabs = el('div', 'sb-tabs', sb);
    for (const t of TABS) {
      const b = el('button', 'tab', tabs);
      b.innerHTML = svg(t.icon) + `<span>${t.label}</span><i class="tab-badge"></i>`;
      b.title = t.label;
      b.onclick = () => {
        this.setTab(t.cat);
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
    this.tooltip.innerHTML = lines.join('');
    this.tooltip.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    const tr = this.tooltip.getBoundingClientRect();
    this.tooltip.style.left = `${Math.max(4, r.left - tr.width - 8)}px`;
    this.tooltip.style.top = `${Math.min(window.innerHeight - tr.height - 4, r.top)}px`;
  }

  setToolActive(tool: string | null) {
    for (const [id, b] of this.toolBtns) b.classList.toggle('active', id === tool);
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
    this.powerText.textContent = `⚡ ${use}/${out}`;
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
      (b.querySelector('.c-status') as HTMLElement).textContent = ready ? 'READY' : head && p.credits <= 0 ? 'NO FUNDS' : head && w.isLowPower(p) ? 'LOW POWER' : '';
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
  }

  /** Selection details + context command buttons. */
  private updateSelection() {
    const w = this.world;
    const sel = [...this.renderer.selection].map((id) => w.get(id)).filter((e): e is Entity => !!e);
    const key = sel.map((e) => `${e.id}:${Math.round((e.hp / e.maxHp) * 20)}:${e.passengers.length}`).join(',');
    if (key === this.lastSelKey) return;
    this.lastSelKey = key;
    const own = sel.filter((e) => e.owner === this.player);
    const units = own.filter((e) => e.kind === 'unit');
    const ownBuilding = own.length === 1 && own[0].kind === 'building' ? own[0] : null;
    const style = styleFor(w, this.player);
    if (sel.length === 0) {
      this.selPanel.classList.add('hidden');
    } else {
      this.selPanel.classList.remove('hidden');
      if (sel.length === 1) {
        const e = sel[0];
        const d = DEFS[e.def];
        const owner = e.owner < 0 ? 'Neutral' : w.players[e.owner].name;
        const hp = e.hp / e.maxHp;
        const img = e.owner === this.player ? this.cameos.get(e.def, style) : this.cameos.get(e.def, styleFor(w, e.owner));
        let extra = '';
        if (d.kind === 'unit' && d.harvester) extra = `<div class="sp-extra">Cargo: $${e.cargo}</div>`;
        if (d.kind === 'unit' && d.transport) extra = `<div class="sp-extra">Passengers: ${e.passengers.length} / ${d.transport}</div>`;
        if (d.kind === 'building' && d.power) extra = `<div class="sp-extra">Power ${d.power > 0 ? '+' : ''}${d.power}</div>`;
        this.selPanel.innerHTML = `<img src="${img}"><div class="sp-info"><b>${d.name}</b><div class="sp-owner">${owner}</div><div class="sp-hp"><i style="width:${hp * 100}%;background:${hpColor(hp)}"></i></div><div class="sp-hpt">${Math.ceil(e.hp)} / ${e.maxHp}</div>${extra}</div>`;
      } else {
        const counts = new Map<string, number>();
        for (const e of sel) counts.set(e.def, (counts.get(e.def) ?? 0) + 1);
        this.selPanel.innerHTML = `<div class="sp-multi">${[...counts]
          .map(([id, n]) => `<button class="sp-type" data-def="${id}" title="${DEFS[id].name}"><img src="${this.cameos.get(id, style)}"><span>${n}</span></button>`)
          .join('')}</div>`;
        this.selPanel.querySelectorAll<HTMLElement>('.sp-type').forEach((b) => (b.onclick = () => this.actions.onSelectType(b.dataset.def!)));
      }
    }
    // command buttons
    const cmds: [string, string, Parameters<HudActions['onCommand']>[0]][] = [];
    if (units.length) {
      cmds.push(['Stop', 'S', 'stop'], ['Attack-Move', 'A', 'attackMove']);
      if (units.some((u) => unitDef(u.def).mcv)) cmds.push(['Deploy', 'D', 'deploy']);
      if (units.some((u) => u.passengers.length > 0)) cmds.push(['Unload', 'D', 'deploy']);
      cmds.push(['Deselect', '', 'deselect']);
    } else if (ownBuilding) {
      cmds.push(['Repair', '', 'repairSel'], ['Sell', '', 'sellSel'], ['Deselect', '', 'deselect']);
    } else {
      cmds.push(['Select Army', 'Q', 'selectArmy']);
    }
    this.cmdBar.innerHTML = '';
    for (const [label, key2, id] of cmds) {
      const b = el('button', 'cmd-btn', this.cmdBar);
      b.innerHTML = `${label}${key2 ? `<kbd>${key2}</kbd>` : ''}`;
      b.onclick = () => this.actions.onCommand(id);
    }
  }

  forceSelectionRefresh() {
    this.lastSelKey = '#';
  }

  // --------------------------------------------------------------- minimap

  private mmK() {
    const { w, h } = this.world.map;
    return { kx: this.minimap.width / (w + h), ky: this.minimap.height / (w + h), H: h };
  }

  private fromMinimap(px: number, py: number) {
    const { kx, ky, H } = this.mmK();
    const a = px / kx - H;
    const b = py / ky;
    return { x: (a + b) / 2, y: (b - a) / 2 };
  }

  drawMinimap() {
    const w = this.world;
    const { map } = w;
    const ctx = this.minimap.getContext('2d')!;
    const { kx, ky, H } = this.mmK();
    const p = w.players[this.player];
    const radar = p.radarOnline;
    this.radarOff.classList.toggle('hidden', radar);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#05080a';
    ctx.fillRect(0, 0, this.minimap.width, this.minimap.height);
    ctx.setTransform(kx, ky, -kx, ky, kx * H, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.renderer.terrain.minimapImage, 0, 0);
    // ore
    ctx.fillStyle = '#d8b040';
    for (let i = 0; i < map.ore.length; i++) {
      if (map.ore[i] && p.explored[i]) {
        ctx.fillStyle = map.oreKind[i] === 2 ? '#c060ff' : '#d8b040';
        ctx.fillRect(i % map.w, Math.floor(i / map.w), 1, 1);
      }
    }
    // entities
    for (const e of w.list) {
      if (e.dead) continue;
      const own = e.owner === this.player;
      if (!own && !this.renderer.isShown(e.id)) continue;
      if (!radar && !(own && e.kind === 'building')) continue;
      const col = e.owner < 0 ? '#c8c8c8' : '#' + w.players[e.owner].color.toString(16).padStart(6, '0');
      ctx.fillStyle = col;
      if (e.kind === 'building') {
        const d = buildingDef(e.def);
        ctx.fillRect(e.tx, e.ty, d.w, d.h);
      } else if (!unitDef(e.def).temp) ctx.fillRect(e.x - 0.9, e.y - 0.9, 1.8, 1.8);
    }
    // fog
    const data = this.fogImg.data;
    for (let i = 0; i < map.w * map.h; i++) {
      data[i * 4 + 3] = p.visible[i] ? 0 : p.explored[i] ? 110 : 255;
    }
    const fctx = this.fogCanvas.getContext('2d')!;
    fctx.putImageData(this.fogImg, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.fogCanvas, 0, 0);
    // camera view
    const c = this.renderer.viewCorners();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.2 / kx;
    ctx.beginPath();
    c.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
    ctx.closePath();
    ctx.stroke();
  }

  // --------------------------------------------------------------- overlay

  resizeOverlay(w: number, h: number, dpr: number) {
    this.overlay.width = Math.round(w * dpr);
    this.overlay.height = Math.round(h * dpr);
    this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Health bars, harvester cargo pips, group numbers, rally lines. */
  drawOverlay(alpha: number, hover: number, groups: Map<number, number>, now: number) {
    const ctx = this.octx;
    const w = this.world;
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const sel = this.renderer.selection;
    for (const e of w.list) {
      if (e.dead) continue;
      const selected = sel.has(e.id);
      const recent = w.tick - e.lastHurt < TPS * 2;
      if (!selected && e.id !== hover && !recent) continue;
      if (!this.renderer.isShown(e.id)) continue;
      const pos = this.renderer.entityPos(e, alpha);
      const top = this.renderer.project(pos.x, pos.y + this.renderer.visualHeight(e.id) + 0.12, pos.z);
      const hp = e.hp / e.maxHp;
      const isB = e.kind === 'building';
      const width = isB ? buildingDef(e.def).w * 18 : unitDef(e.def).category === 'infantry' ? 16 : 26;
      const pips = isB ? buildingDef(e.def).w * 6 : unitDef(e.def).category === 'infantry' ? 4 : 8;
      const x0 = Math.round(top.x - width / 2);
      const y0 = Math.round(top.y - 6);
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(x0 - 1, y0 - 1, width + 2, 6);
      const filled = Math.ceil(hp * pips);
      const pw = width / pips;
      ctx.fillStyle = hpColor(hp);
      for (let i = 0; i < filled; i++) ctx.fillRect(x0 + i * pw + 0.5, y0, pw - 1, 4);
      if (e.kind === 'unit' && unitDef(e.def).harvester && selected) {
        const k = e.cargo / 900;
        ctx.fillStyle = '#e8c040';
        for (let i = 0; i < Math.ceil(k * 5); i++) ctx.fillRect(x0 + i * 6, y0 + 6, 4, 3);
      }
      const g = groups.get(e.id);
      if (g !== undefined && selected) {
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.fillStyle = '#fff';
        ctx.fillText(String(g), x0 + width + 3, y0 + 5);
      }
      // rally point of selected factory
      if (selected && isB && e.owner === this.player && e.rallyX >= 0) {
        const a = this.renderer.project(pos.x, pos.y + 0.2, pos.z);
        const b = this.renderer.project(e.rallyX, pos.y, e.rallyY);
        ctx.strokeStyle = 'rgba(120,255,140,0.7)';
        ctx.setLineDash([5, 4]);
        ctx.lineDashOffset = -now * 20;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
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

export function flagHtml(colors: number[]) {
  return `<i class="flag">${colors.map((c) => `<b style="background:#${c.toString(16).padStart(6, '0')}"></b>`).join('')}</i>`;
}

function roleName(r: string) {
  const map: Record<string, string> = {
    conyard: 'Construction Yard',
    power: 'Power Plant',
    refinery: 'Refinery',
    barracks: 'Barracks',
    factory: 'War Factory',
    radar: 'Radar Center',
    airfield: 'Drone Hub',
    tech: 'Battle Lab',
  };
  return map[r] ?? r;
}
