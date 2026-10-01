import { AudioSystem, panFor, type Sfx } from '../audio/audio';
import { AIController, type Difficulty } from '../sim/ai';
import { DEFS, FACTIONS, WEAPONS, buildingDef, unitDef } from '../sim/defs';
import { standHeight, terrainPassable } from '../sim/map';
import { TICK_MS, type Category, type Command, type Entity, type Faction, type SimEvent } from '../sim/types';
import { World } from '../sim/world';
import { CameoFactory } from '../render/cameo';
import { GameRenderer, type Quality } from '../render/renderer';
import { Hud } from '../ui/hud';

export interface GameOptions {
  faction: Faction;
  enemy: Faction;
  difficulty: Difficulty;
  credits: number;
  quality: Quality;
  attract?: boolean; // AI vs AI demo behind the main menu
  seed?: number;
}

export interface GameCallbacks {
  onMenu(): void;
  onEnd(win: boolean, stats: { you: World['players'][0]; enemy: World['players'][0]; time: number }): void;
}

type Mode = 'normal' | 'place' | 'sell' | 'repair' | 'attackMove';

const PLAYER_COLOR = 0x2f8fff;
const ENEMY_COLOR = 0xe8352b;

export class Game {
  readonly world: World;
  readonly renderer: GameRenderer;
  readonly hud: Hud;
  private cameos = new CameoFactory();
  private local: number;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private hudTimer = 0;
  private mmTimer = 0;
  paused = false;
  speed = 1;
  private mode: Mode = 'normal';
  private placing: string | null = null;
  private groups = new Map<number, number[]>();
  private groupOf = new Map<number, number>();
  private hover = -1;
  private mouse = { x: 0, y: 0, inside: false, type: 'mouse' };
  private keys = new Set<string>();
  private boxSelectMode = false;
  private ended = false;
  private startTime = performance.now();
  private hintShown = true;
  private lastGroupTap = { g: -1, t: 0 };
  private destroyed = false;
  private disposers: (() => void)[] = [];

  constructor(
    container: HTMLElement,
    readonly opts: GameOptions,
    readonly audio: AudioSystem,
    private cb: GameCallbacks,
  ) {
    const attract = !!opts.attract;
    this.world = new World({
      seed: opts.seed ?? Math.floor(Math.random() * 1e9),
      credits: opts.credits,
      players: [
        { name: attract ? FACTIONS.find((f) => f.id === opts.faction)!.name : 'You', faction: opts.faction, color: PLAYER_COLOR, isAI: attract },
        { name: FACTIONS.find((f) => f.id === opts.enemy)!.name, faction: opts.enemy, color: ENEMY_COLOR, isAI: true },
      ],
    });
    this.local = attract ? -1 : 0;
    if (attract) this.world.controllers.push(new AIController(this.world, 0, 'hard'));
    this.world.controllers.push(new AIController(this.world, 1, attract ? 'hard' : opts.difficulty));

    this.hud = new Hud(container, this.cameos, {
      onCameo: (id, cat, shift) => this.onCameo(id, cat, shift),
      onCancel: (id) => {
        this.issue({ type: 'cancel', def: id });
        this.sfx('click');
      },
      onTool: (t) => this.onTool(t),
      onCommand: (c) => this.onCommand(c),
      onMinimap: (x, y) => this.renderer.centerOn(x, y),
      onSelectType: (id) => this.select([...this.renderer.selection].filter((s) => this.world.get(s)?.def === id)),
    });
    if (attract) this.hud.root.classList.add('attract');
    this.renderer = new GameRenderer(this.hud.canvas, this.world, this.local, opts.quality);
    this.hud.attach(this.world, this.renderer, Math.max(0, this.local));
    if (attract) {
      this.renderer.setZoom(0.8);
      this.renderer.centerOn(this.world.map.w / 2, this.world.map.h / 2);
    } else {
      this.renderer.setZoom(1.15);
      const mcv = this.world.list.find((e) => e.owner === 0 && e.kind === 'unit' && unitDef(e.def).mcv);
      if (mcv) this.select([mcv.id], false);
      this.hud.showHint('Your MCV is selected. Press <b>Deploy</b> (or <kbd>D</kbd>, or click the MCV again) to build your Construction Yard.');
      this.audio.say('Battle control online');
    }
    this.bindInput();
    const onResize = () => this.resize();
    window.addEventListener('resize', onResize);
    this.disposers.push(() => window.removeEventListener('resize', onResize));
    this.resize();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private resize() {
    const r = this.hud.viewWrap.getBoundingClientRect();
    const dpr = this.renderer.renderer.getPixelRatio();
    this.renderer.resize(Math.max(1, r.width), Math.max(1, r.height));
    this.hud.resizeOverlay(r.width, r.height, Math.min(2, window.devicePixelRatio));
    void dpr;
  }

  // ------------------------------------------------------------------- loop

  private frame = (now: number) => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (!this.paused) {
      this.acc += dt * 1000 * this.speed;
      let steps = 0;
      while (this.acc >= TICK_MS && steps < 6) {
        this.world.step();
        this.acc -= TICK_MS;
        steps++;
        for (const ev of this.world.drainEvents()) this.onEvent(ev);
      }
      if (steps >= 6) this.acc = 0;
    }
    const alpha = this.paused ? 1 : Math.min(1, this.acc / TICK_MS);
    this.updateCamera(dt);
    if (this.local >= 0) this.updateHover();
    this.renderer.render(alpha, this.paused ? 0 : dt);
    this.hud.drawOverlay(alpha, this.hover, this.groupOf, now / 1000);
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      if (this.local >= 0) this.hud.update(0.1);
      this.pruneSelection();
    }
    this.mmTimer -= dt;
    if (this.mmTimer <= 0 && this.local >= 0) {
      this.mmTimer = 0.25;
      this.hud.drawMinimap();
    }
  };

  private attractT = 0;

  private updateCamera(dt: number) {
    const r = this.renderer;
    if (this.opts.attract) {
      // slow cinematic drift towards the action
      this.attractT += dt;
      const fights = this.world.list.filter((e) => !e.dead && e.kind === 'unit' && e.firedAt > this.world.tick - 40);
      const tx = fights.length ? fights.reduce((s, e) => s + e.x, 0) / fights.length : this.world.map.w / 2 + Math.sin(this.attractT * 0.05) * 20;
      const ty = fights.length ? fights.reduce((s, e) => s + e.y, 0) / fights.length : this.world.map.h / 2 + Math.cos(this.attractT * 0.05) * 20;
      r.target.x += (tx - r.target.x) * Math.min(1, dt * 0.25);
      r.target.z += (ty - r.target.z) * Math.min(1, dt * 0.25);
      return;
    }
    const speed = 900 * dt;
    let dx = 0;
    let dy = 0;
    if (this.keys.has('ArrowLeft')) dx -= speed;
    if (this.keys.has('ArrowRight')) dx += speed;
    if (this.keys.has('ArrowUp')) dy -= speed;
    if (this.keys.has('ArrowDown')) dy += speed;
    if (this.mouse.inside && this.mouse.type === 'mouse' && !this.drag && document.hasFocus()) {
      const rect = this.hud.viewWrap.getBoundingClientRect();
      const m = 8;
      if (this.mouse.x < m) dx -= speed;
      if (this.mouse.x > rect.width - m) dx += speed;
      if (this.mouse.y < m) dy -= speed;
      if (this.mouse.y > rect.height - m) dy += speed;
    }
    if (dx || dy) r.panPixels(dx, dy);
  }

  // ----------------------------------------------------------------- events

  private sfx(name: Sfx, x?: number, y?: number, vol = 1) {
    if (x === undefined || y === undefined) {
      this.audio.play(name, vol);
      return;
    }
    const s = this.renderer.project(x, 0, y);
    const r = this.hud.viewWrap.getBoundingClientRect();
    const out = Math.max(0, -s.x, s.x - r.width, -s.y, s.y - r.height);
    const fall = Math.max(0, 1 - out / (r.width * 0.6));
    if (fall <= 0.02) return;
    this.audio.play(name, vol * fall * (0.5 + 0.5 * Math.min(1, this.renderer.zoom)), panFor(s.x, r.width));
  }

  private visibleToLocal(x: number, y: number) {
    return this.local < 0 || this.world.visibleTo(this.local, x, y);
  }

  private onEvent(ev: SimEvent) {
    this.renderer.handleEvent(ev);
    const mine = 'owner' in ev && ev.owner === this.local;
    switch (ev.t) {
      case 'launch': {
        if (!this.visibleToLocal(ev.x, ev.y)) break;
        const f = ev.flight;
        const snd: Sfx = f === 'sam' || f === 'interceptor' || f === 'ballistic' || f === 'hypersonic' ? 'missileLaunch' : f === 'rocketSalvo' ? 'thermo' : 'rocket';
        this.sfx(snd, ev.x, ev.y, f === 'ballistic' || f === 'hypersonic' ? 1 : 0.75);
        break;
      }
      case 'airburst':
        if (this.visibleToLocal(ev.x, ev.y)) this.sfx(ev.kind === 'kill' ? (ev.victim === 'ballistic' || ev.victim === 'hypersonic' ? 'explosionLarge' : 'explosionMedium') : 'explosionSmall', ev.x, ev.y, 0.8);
        break;
      case 'fire': {
        if (!this.visibleToLocal(ev.x, ev.y) && !this.visibleToLocal(ev.tx, ev.ty)) break;
        const w = WEAPONS[ev.weapon];
        if (w.flight && w.flight !== 'shell' && w.flight !== 'artillery' && w.flight !== 'mortar') break; // launch event plays it
        if (ev.targetId < 0 && w.projectile !== 'beam') break;
        const snd: Sfx =
          w.projectile === 'beam' ? 'laser'
          : w.projectile === 'spawn' ? 'droneLaunch'
          : w.warhead === 'flak' ? 'flak'
          : w.warhead === 'thermo' ? 'thermo'
          : w.projectile === 'missile' ? 'missileLaunch'
          : w.projectile === 'rocket' ? 'rocket'
          : w.projectile === 'artillery' ? 'artillery'
          : w.projectile === 'shell' ? (w.damage > 70 ? 'cannonHeavy' : 'cannon')
          : w.rof < 10 ? 'mg' : 'rifle';
        this.sfx(snd, ev.x, ev.y, snd === 'mg' || snd === 'rifle' ? 0.5 : 0.8);
        break;
      }
      case 'impact': {
        if (!this.visibleToLocal(ev.x, ev.y)) break;
        const w = WEAPONS[ev.weapon];
        if (w.projectile === 'instant' && w.damage < 30) break;
        if (w.projectile === 'beam') break;
        const big = w.damage >= 200 || w.warhead === 'thermo';
        this.sfx(big ? 'explosionLarge' : w.damage >= 70 || w.splash ? 'explosionMedium' : 'explosionSmall', ev.x, ev.y, big ? 1 : 0.8);
        break;
      }
      case 'intercept':
        if (this.visibleToLocal(ev.x, ev.y)) this.sfx('intercept', ev.x, ev.y);
        break;
      case 'death': {
        if (!this.visibleToLocal(ev.x, ev.y)) break;
        const d = DEFS[ev.def];
        if (d.kind === 'building') this.sfx('buildingCollapse', ev.x, ev.y);
        else if (d.category === 'vehicle') this.sfx('explosionLarge', ev.x, ev.y);
        else if (d.category === 'air' && !unitDef(d.id).temp) this.sfx('explosionMedium', ev.x, ev.y);
        if (ev.owner === this.local && d.kind === 'unit' && !unitDef(d.id).temp) {
          if (unitDef(d.id).harvester) this.say('Ore harvester lost', 'warn');
        }
        if (ev.owner === this.local && d.kind === 'building') this.say('Structure lost', 'warn');
        break;
      }
      case 'placed':
        if (mine) this.sfx('place');
        break;
      case 'deployed':
        if (mine) {
          this.sfx('deploy');
          this.hintShown = true;
          this.hud.showHint('Construction Yard deployed! Build a <b>Power Plant</b> from the Base tab on the right, then place it next to your base.');
          this.hud.setTab('building');
        }
        break;
      case 'buildingReady':
        if (mine) {
          this.say('Construction complete', 'good');
          this.sfx('build');
          if (this.hintShown && this.world.players[this.local].stats.built === 0) this.hud.showHint('Click the flashing <b>READY</b> icon, then click on the map near your base to place the building.');
        }
        break;
      case 'unitReady':
        if (mine) {
          const d = unitDef(ev.def);
          this.say(d.category === 'infantry' ? 'Unit ready' : d.category === 'air' ? 'Aircraft ready' : 'Unit ready', 'good');
        }
        break;
      case 'noFunds':
        if (mine) this.say('Insufficient funds', 'warn');
        break;
      case 'lowPower':
        if (mine) this.say('Low power', 'warn');
        break;
      case 'underAttack':
        if (mine) {
          const base = this.world.list.some((e) => !e.dead && e.owner === this.local && e.kind === 'building' && Math.hypot(e.x - ev.x, e.y - ev.y) < 0.01);
          this.say(base ? 'Our base is under attack' : 'Unit under attack', 'warn');
          this.sfx('alarm', undefined, undefined, 0.5);
        }
        break;
      case 'captured':
        if (mine) this.say('Building captured', 'good');
        break;
      case 'sold':
        if (mine) this.sfx('sell');
        break;
      case 'gameOver':
        this.finish(ev.winner === this.local);
        break;
    }
  }

  private lastSay = new Map<string, number>();
  private say(text: string, kind: 'info' | 'warn' | 'good') {
    if (this.local < 0) return;
    const now = performance.now();
    if (now - (this.lastSay.get(text) ?? -1e9) < 3500) return;
    this.lastSay.set(text, now);
    this.hud.message(text, kind);
    this.audio.say(text);
  }

  private finish(win: boolean) {
    if (this.ended) return;
    this.ended = true;
    if (this.local < 0) {
      // restart the attract demo
      setTimeout(() => this.cb.onMenu(), 4000);
      return;
    }
    this.audio.say(win ? 'Mission accomplished' : 'Mission failed');
    setTimeout(() => {
      this.paused = true;
      this.cb.onEnd(win, { you: this.world.players[0], enemy: this.world.players[1], time: (performance.now() - this.startTime) / 1000 });
    }, 2500);
  }

  // --------------------------------------------------------------- commands

  private issue(cmd: Command) {
    if (this.local >= 0) this.world.issue(this.local, cmd);
  }

  private selectedOwnUnits(): Entity[] {
    return [...this.renderer.selection].map((id) => this.world.get(id)).filter((e): e is Entity => !!e && e.owner === this.local && e.kind === 'unit');
  }

  private select(ids: number[], add = false, sound = true) {
    const sel = this.renderer.selection;
    if (!add) sel.clear();
    for (const id of ids) sel.add(id);
    this.hud.forceSelectionRefresh();
    if (sound && ids.length) this.sfx('select');
  }

  private pruneSelection() {
    for (const id of this.renderer.selection) {
      const e = this.world.get(id);
      if (!e || e.inside >= 0) this.renderer.selection.delete(id);
    }
  }

  private setMode(m: Mode) {
    this.mode = m;
    this.touchPlace = null;
    if (m !== 'place') {
      this.placing = null;
      this.renderer.setGhost(null, 0, 0, false, 0);
    }
    this.hud.setToolActive(m === 'sell' ? 'sell' : m === 'repair' ? 'repair' : this.boxSelectMode ? 'boxselect' : null);
  }

  private onCameo(id: string, cat: Category, shift: boolean) {
    this.audio.unlock();
    const p = this.world.players[this.local];
    if (p.ready[cat] === id) {
      this.setMode('place');
      this.placing = id;
      this.sfx('click');
      return;
    }
    if (!this.world.canBuild(this.local, id)) {
      this.sfx('error');
      return;
    }
    const d = DEFS[id];
    if (d.kind === 'building' && (p.queues[cat].length || p.ready[cat])) {
      this.sfx('error');
      this.say('Unable to comply. Building in progress', 'warn');
      return;
    }
    this.issue({ type: 'produce', def: id, count: shift ? 5 : 1 });
    this.sfx('click');
    if (d.kind === 'building') this.audio.say('Building');
    else this.audio.say('Training');
    if (this.hintShown && d.kind === 'building') this.hud.showHint(null);
  }

  private onTool(t: 'repair' | 'sell' | 'menu' | 'boxselect') {
    this.audio.unlock();
    this.sfx('click');
    if (t === 'menu') {
      this.cb.onMenu();
      return;
    }
    if (t === 'boxselect') {
      this.boxSelectMode = !this.boxSelectMode;
      this.setMode(this.mode === 'place' ? 'place' : 'normal');
      return;
    }
    this.setMode(this.mode === t ? 'normal' : t);
  }

  private onCommand(c: 'stop' | 'attackMove' | 'deploy' | 'selectArmy' | 'deselect' | 'sellSel' | 'repairSel') {
    this.audio.unlock();
    const units = this.selectedOwnUnits();
    switch (c) {
      case 'stop':
        if (units.length) this.issue({ type: 'stop', ids: units.map((u) => u.id) });
        this.sfx('ack');
        break;
      case 'attackMove':
        this.setMode('attackMove');
        this.sfx('click');
        break;
      case 'deploy':
        this.issue({ type: 'deploy', ids: units.map((u) => u.id) });
        break;
      case 'selectArmy':
        this.select(this.world.list.filter((e) => !e.dead && e.owner === this.local && e.kind === 'unit' && !!unitDef(e.def).weapon && !unitDef(e.def).temp && !unitDef(e.def).harvester).map((e) => e.id));
        break;
      case 'deselect':
        this.select([]);
        break;
      case 'sellSel':
      case 'repairSel': {
        const b = [...this.renderer.selection].map((id) => this.world.get(id)).find((e) => e && e.kind === 'building' && e.owner === this.local);
        if (b) this.issue(c === 'sellSel' ? { type: 'sell', id: b.id } : { type: 'repair', id: b.id });
        this.sfx(c === 'sellSel' ? 'sell' : 'repair');
        break;
      }
    }
  }

  // ------------------------------------------------------------------ picking

  private pick(sx: number, sy: number): Entity | null {
    const w = this.world;
    const r = this.renderer;
    let best: Entity | null = null;
    let bd = Infinity;
    const scale = this.hud.viewWrap.getBoundingClientRect().height / (22 / r.zoom);
    for (const e of w.list) {
      if (e.dead || e.kind !== 'unit' || !r.isShown(e.id)) continue;
      const d = unitDef(e.def);
      if (d.temp) continue;
      const p = r.entityPos(e, 1);
      const s = r.project(p.x, p.y + r.visualHeight(e.id) * 0.45, p.z);
      const rad = Math.max(13, d.radius * scale * 1.5);
      const dist = Math.hypot(s.x - sx, s.y - sy);
      if (dist < rad && dist - (d.air ? 6 : 0) < bd) {
        bd = dist - (d.air ? 6 : 0);
        best = e;
      }
    }
    if (best) return best;
    const g = r.screenToGround(sx, sy);
    const tx = Math.floor(g.x);
    const ty = Math.floor(g.y);
    if (tx >= 0 && ty >= 0 && tx < w.map.w && ty < w.map.h) {
      const id = w.occ[ty * w.map.w + tx];
      const b = id ? w.get(id) : undefined;
      if (b && r.isShown(b.id)) return b;
    }
    // tall buildings: test their projected box too
    for (const e of w.list) {
      if (e.dead || e.kind !== 'building' || !r.isShown(e.id)) continue;
      const d = buildingDef(e.def);
      const p = r.entityPos(e, 1);
      const c = r.project(p.x, p.y + r.visualHeight(e.id) * 0.5, p.z);
      if (Math.abs(c.x - sx) < d.w * scale * 0.55 && Math.abs(c.y - sy) < d.h * scale * 0.45) return e;
    }
    return null;
  }

  /** Decide the context action for the cursor position. */
  private contextAction(sx: number, sy: number, ctrl: boolean): { cursor: string; run: () => void } {
    const w = this.world;
    const units = this.selectedOwnUnits();
    const target = this.pick(sx, sy);
    const g = this.renderer.screenToGround(sx, sy);
    const none = { cursor: 'default', run: () => {} };
    if (this.mode === 'place' && this.placing) {
      const d = buildingDef(this.placing);
      const tx = Math.round(g.x - d.w / 2);
      const ty = Math.round(g.y - d.h / 2);
      const ok = w.canPlace(this.local, this.placing, tx, ty);
      this.renderer.setGhost(this.placing, tx, ty, ok, this.local);
      return {
        cursor: ok ? 'place' : 'nope',
        run: () => {
          if (!ok) {
            this.sfx('error');
            return;
          }
          this.issue({ type: 'place', def: this.placing!, tx, ty });
          this.setMode('normal');
          if (this.hintShown) {
            this.hintShown = false;
            this.hud.showHint(null);
          }
        },
      };
    }
    if (this.mode === 'sell' || this.mode === 'repair') {
      const ok = target && target.kind === 'building' && target.owner === this.local;
      return {
        cursor: ok ? this.mode : 'nope',
        run: () => {
          if (!ok) return;
          this.issue(this.mode === 'sell' ? { type: 'sell', id: target!.id } : { type: 'repair', id: target!.id });
          this.sfx(this.mode === 'sell' ? 'sell' : 'repair');
          if (this.mode === 'sell') this.setMode('normal');
        },
      };
    }
    const ownSel = units.length > 0;
    if (target && target.owner === this.local && !(ctrl && ownSel)) {
      // own unit/building: select, deploy MCV, or engineer repair
      const eng = units.filter((u) => unitDef(u.def).engineer);
      if (target.kind === 'building' && eng.length && target.hp < target.maxHp) {
        return { cursor: 'enter', run: () => this.order({ type: 'capture', ids: eng.map((u) => u.id), target: target.id }, target, false) };
      }
      if (units.length === 1 && units[0].id === target.id && unitDef(target.def).mcv) {
        return { cursor: 'deploy', run: () => this.issue({ type: 'deploy', ids: [target.id] }) };
      }
      const cap = target.kind === 'unit' ? (unitDef(target.def).transport ?? 0) : 0;
      const riders = units.filter((u) => unitDef(u.def).category === 'infantry');
      if (cap && riders.length && target.passengers.length < cap) {
        return { cursor: 'enter', run: () => this.order({ type: 'enter', ids: riders.map((u) => u.id), target: target.id }, target, false) };
      }
      return { cursor: 'select', run: () => this.select([target.id], this.keys.has('Shift')) };
    }
    if (ownSel) {
      if (target && target.owner !== this.local) {
        const eng = units.filter((u) => unitDef(u.def).engineer);
        if (target.kind === 'building' && eng.length && (target.owner >= 0 || buildingDef(target.def).capturable)) {
          return { cursor: 'enter', run: () => this.order({ type: 'capture', ids: eng.map((u) => u.id), target: target.id }, target, false) };
        }
        const attackers = units.filter((u) => {
          const d = unitDef(u.def);
          return d.weapon && !d.temp && WEAPONS[d.weapon] && w.canHit(WEAPONS[d.weapon], target);
        });
        if (target.owner >= 0 && attackers.length) {
          return { cursor: 'attack', run: () => this.order({ type: 'attack', ids: attackers.map((u) => u.id), target: target.id }, target, true) };
        }
        if (target.owner < 0) return { cursor: 'select', run: () => this.select([target.id]) };
      }
      if (ctrl && target && target.owner === this.local) {
        const attackers = units.filter((u) => unitDef(u.def).weapon);
        return { cursor: 'attack', run: () => this.order({ type: 'attack', ids: attackers.map((u) => u.id), target: target.id }, target, true) };
      }
      const tile = Math.floor(g.y) * w.map.w + Math.floor(g.x);
      const harvesters = units.filter((u) => unitDef(u.def).harvester);
      if (harvesters.length === units.length && w.map.ore[tile] > 0) {
        return { cursor: 'harvest', run: () => this.order({ type: 'harvest', ids: harvesters.map((u) => u.id), x: g.x, y: g.y }, null, false, g) };
      }
      const allAir = units.every((u) => unitDef(u.def).air);
      const passable = allAir || terrainPassable(w.map, Math.floor(g.x), Math.floor(g.y));
      const attackMove = this.mode === 'attackMove' || ctrl;
      if (!passable && this.local >= 0 && w.players[this.local].explored[tile]) return { cursor: 'nomove', run: () => this.sfx('error') };
      return {
        cursor: attackMove ? 'attack' : 'move',
        run: () => {
          this.order({ type: 'move', ids: units.map((u) => u.id), x: g.x, y: g.y, attackMove }, null, attackMove, g);
          if (this.mode === 'attackMove') this.setMode('normal');
        },
      };
    }
    // own production building selected: set rally point
    const sel = [...this.renderer.selection].map((id) => w.get(id)).find((e) => e && e.kind === 'building' && e.owner === this.local && buildingDef(e.def).produces);
    if (sel && !target) {
      return {
        cursor: 'move',
        run: () => {
          this.issue({ type: 'rally', id: sel.id, x: g.x, y: g.y });
          this.renderer.effects.marker(g.x, standHeight(this.world.map, g.x, g.y), g.y, false);
          this.sfx('ack');
        },
      };
    }
    if (target) return { cursor: 'select', run: () => this.select([target.id]) };
    return { ...none, run: () => this.select([]) };
  }

  private order(cmd: Command, target: Entity | null, attack: boolean, g?: { x: number; y: number }) {
    this.issue(cmd);
    this.sfx('ack');
    const r = this.renderer;
    if (target) {
      const p = r.entityPos(target, 1);
      r.effects.marker(p.x, p.y, p.z, attack);
    } else if (g) {
      r.effects.marker(g.x, standHeight(this.world.map, g.x, g.y), g.y, attack);
    }
  }

  private updateHover() {
    if (!this.mouse.inside || this.drag?.panning) return;
    if (this.mouse.type === 'touch' && this.mode === 'place') return;
    const t = this.pick(this.mouse.x, this.mouse.y);
    this.hover = t ? t.id : -1;
    if (this.drag?.box) return;
    const a = this.contextAction(this.mouse.x, this.mouse.y, this.keys.has('Control') || this.keys.has('Meta'));
    this.hud.setCursor(a.cursor);
  }

  // ------------------------------------------------------------------- input

  private drag: { id: number; sx: number; sy: number; button: number; box: boolean; panning: boolean; moved: boolean; longTimer: number; time: number } | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; zoom: number; cx: number; cy: number } | null = null;
  private lastClick = { t: 0, id: -1 };

  private bindInput() {
    const view = this.hud.viewWrap;
    const on = <K extends keyof HTMLElementEventMap>(t: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => t.removeEventListener(type, fn as EventListener, opts));
    };
    const local = (e: PointerEvent | WheelEvent | MouseEvent) => {
      const r = view.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    on(view, 'contextmenu', (e) => e.preventDefault());
    on(view, 'pointerdown', (e) => {
      this.audio.unlock();
      if (this.local < 0) return;
      const p = local(e);
      this.mouse = { x: p.x, y: p.y, inside: true, type: e.pointerType };
      view.setPointerCapture(e.pointerId);
      if (e.pointerType === 'touch') {
        this.touches.set(e.pointerId, p);
        if (this.touches.size === 2) {
          if (this.drag) clearTimeout(this.drag.longTimer);
          this.drag = null;
          this.hud.selBox.style.display = 'none';
          const [a, b] = [...this.touches.values()];
          this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.renderer.zoom, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
          return;
        }
      }
      const d = { id: e.pointerId, sx: p.x, sy: p.y, button: e.button, box: false, panning: false, moved: false, longTimer: 0, time: performance.now() };
      if (e.pointerType === 'touch') {
        if (this.boxSelectMode) d.box = true;
        else
          d.longTimer = window.setTimeout(() => {
            if (this.drag === d && !d.moved) {
              d.box = true;
              navigator.vibrate?.(15);
              this.updateBox(d.sx, d.sy, d.sx, d.sy);
            }
          }, 380);
      }
      this.drag = d;
    });
    on(view, 'pointermove', (e) => {
      const p = local(e);
      this.mouse = { x: p.x, y: p.y, inside: true, type: e.pointerType };
      if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
        this.touches.set(e.pointerId, p);
        if (this.pinch && this.touches.size >= 2) {
          const [a, b] = [...this.touches.values()];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          this.renderer.setZoom((this.pinch.zoom * dist) / Math.max(1, this.pinch.dist));
          const cx = (a.x + b.x) / 2;
          const cy = (a.y + b.y) / 2;
          this.renderer.panPixels(this.pinch.cx - cx, this.pinch.cy - cy);
          this.pinch.cx = cx;
          this.pinch.cy = cy;
          return;
        }
      }
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      const dist = Math.hypot(p.x - d.sx, p.y - d.sy);
      if (dist > 7) d.moved = true;
      if (!d.moved) return;
      const touch = e.pointerType === 'touch';
      if ((touch && !d.box) || d.button === 2 || d.button === 1) {
        if (!d.panning) {
          d.panning = true;
          clearTimeout(d.longTimer);
          this.hud.setCursor('pan');
        }
        this.renderer.panPixels(-(p.x - d.sx), -(p.y - d.sy));
        d.sx = p.x;
        d.sy = p.y;
        return;
      }
      if (d.button === 0 && this.mode !== 'place') {
        d.box = true;
        this.updateBox(d.sx, d.sy, p.x, p.y);
      }
    });
    const end = (e: PointerEvent) => {
      const p = local(e);
      if (e.pointerType === 'touch') {
        this.touches.delete(e.pointerId);
        if (this.pinch) {
          if (this.touches.size < 2) this.pinch = null;
          this.drag = null;
          return;
        }
      }
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      clearTimeout(d.longTimer);
      this.drag = null;
      this.hud.selBox.style.display = 'none';
      if (d.panning) return;
      if (d.box && d.moved) {
        this.boxSelect(d.sx, d.sy, p.x, p.y, e.shiftKey);
        return;
      }
      if (d.box && !d.moved && e.pointerType === 'touch') return;
      if (d.button === 2) {
        // right click: cancel mode, else deselect
        if (this.mode !== 'normal') this.setMode('normal');
        else this.select([]);
        return;
      }
      if (d.button !== 0) return;
      this.click(p.x, p.y, e.ctrlKey || e.metaKey, e.shiftKey);
    };
    on(view, 'pointerup', end);
    on(view, 'pointercancel', (e) => {
      this.touches.delete(e.pointerId);
      this.pinch = null;
      if (this.drag) clearTimeout(this.drag.longTimer);
      this.drag = null;
      this.hud.selBox.style.display = 'none';
    });
    on(view, 'pointerleave', () => (this.mouse.inside = false));
    on(
      view,
      'wheel',
      (e) => {
        e.preventDefault();
        this.renderer.setZoom(this.renderer.zoom * (e.deltaY > 0 ? 0.9 : 1.1));
      },
      { passive: false },
    );
    on(window, 'keydown', (e) => this.onKey(e as KeyboardEvent, true));
    on(window, 'keyup', (e) => this.onKey(e as KeyboardEvent, false));
    on(window, 'blur', () => this.keys.clear());
  }

  private updateBox(x0: number, y0: number, x1: number, y1: number) {
    const s = this.hud.selBox.style;
    s.display = 'block';
    s.left = `${Math.min(x0, x1)}px`;
    s.top = `${Math.min(y0, y1)}px`;
    s.width = `${Math.abs(x1 - x0)}px`;
    s.height = `${Math.abs(y1 - y0)}px`;
  }

  private boxSelect(x0: number, y0: number, x1: number, y1: number, add: boolean) {
    const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
    const ids: number[] = [];
    for (const e of this.world.list) {
      if (e.dead || e.owner !== this.local || e.kind !== 'unit' || unitDef(e.def).temp) continue;
      const p = this.renderer.entityPos(e, 1);
      const s = this.renderer.project(p.x, p.y + 0.15, p.z);
      if (s.x >= ax && s.x <= bx && s.y >= ay && s.y <= by) ids.push(e.id);
    }
    // prefer combat units over harvesters when both are boxed
    const combat = ids.filter((id) => !unitDef(this.world.get(id)!.def).harvester);
    this.select(combat.length ? combat : ids, add);
  }

  private touchPlace: { tx: number; ty: number } | null = null;

  private click(x: number, y: number, ctrl: boolean, shift: boolean) {
    const now = performance.now();
    // touch placement: first tap previews the building, a tap on the preview confirms
    if (this.mode === 'place' && this.placing && this.mouse.type === 'touch') {
      const d = buildingDef(this.placing);
      const g = this.renderer.screenToGround(x, y);
      const tp = this.touchPlace;
      if (tp && g.x >= tp.tx - 0.3 && g.x < tp.tx + d.w + 0.3 && g.y >= tp.ty - 0.3 && g.y < tp.ty + d.h + 0.3) {
        if (this.world.canPlace(this.local, this.placing, tp.tx, tp.ty)) {
          this.issue({ type: 'place', def: this.placing, tx: tp.tx, ty: tp.ty });
          this.setMode('normal');
          this.hintShown = false;
          this.hud.showHint(null);
        } else this.sfx('error');
        return;
      }
      const tx = Math.round(g.x - d.w / 2);
      const ty = Math.round(g.y - d.h / 2);
      this.touchPlace = { tx, ty };
      this.renderer.setGhost(this.placing, tx, ty, this.world.canPlace(this.local, this.placing, tx, ty), this.local);
      this.hud.showHint('Tap the highlighted building again to place it, or tap elsewhere to move it.');
      return;
    }
    const target = this.pick(x, y);
    // double click selects all of that type on screen
    if (target && target.owner === this.local && target.kind === 'unit' && now - this.lastClick.t < 350 && this.lastClick.id === target.id && this.mode === 'normal') {
      const rect = this.hud.viewWrap.getBoundingClientRect();
      const ids = this.world.list
        .filter((e) => {
          if (e.dead || e.owner !== this.local || e.def !== target.def) return false;
          const p = this.renderer.entityPos(e, 1);
          const s = this.renderer.project(p.x, p.y, p.z);
          return s.x >= 0 && s.y >= 0 && s.x <= rect.width && s.y <= rect.height;
        })
        .map((e) => e.id);
      this.select(ids, shift);
      this.lastClick = { t: 0, id: -1 };
      return;
    }
    this.lastClick = { t: now, id: target?.id ?? -1 };
    if (shift && target && target.owner === this.local && this.mode === 'normal') {
      const sel = this.renderer.selection;
      if (sel.has(target.id)) sel.delete(target.id);
      else sel.add(target.id);
      this.hud.forceSelectionRefresh();
      this.sfx('select');
      return;
    }
    this.contextAction(x, y, ctrl).run();
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    if (this.local < 0 || (this.paused && down)) return;
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    const k = e.key;
    if (down) this.keys.add(k);
    else {
      this.keys.delete(k);
      return;
    }
    if (k.startsWith('Arrow')) {
      e.preventDefault();
      return;
    }
    const units = this.selectedOwnUnits();
    const digit = /^[0-9]$/.test(k) ? Number(k) : -1;
    if (digit >= 0 && !e.altKey) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const ids = units.map((u) => u.id);
        for (const id of this.groups.get(digit) ?? []) this.groupOf.delete(id);
        this.groups.set(digit, ids);
        for (const id of ids) this.groupOf.set(id, digit);
        this.sfx('ack');
      } else {
        const ids = (this.groups.get(digit) ?? []).filter((id) => this.world.get(id));
        if (ids.length) {
          this.select(ids, e.shiftKey);
          const now = performance.now();
          if (this.lastGroupTap.g === digit && now - this.lastGroupTap.t < 400) {
            const u = this.world.get(ids[0])!;
            this.renderer.centerOn(u.x, u.y);
          }
          this.lastGroupTap = { g: digit, t: now };
        }
      }
      return;
    }
    switch (k.toLowerCase()) {
      case 'escape':
        if (this.mode !== 'normal') this.setMode('normal');
        else this.cb.onMenu();
        break;
      case 's':
        if (units.length) {
          this.issue({ type: 'stop', ids: units.map((u) => u.id) });
          this.sfx('ack');
        }
        break;
      case 'a':
        if (units.length) this.setMode('attackMove');
        break;
      case 'd':
        if (units.length) this.issue({ type: 'deploy', ids: units.map((u) => u.id) });
        break;
      case 'q':
        this.onCommand('selectArmy');
        break;
      case 'h': {
        const cy = this.world.list.find((b) => !b.dead && b.owner === this.local && b.kind === 'building');
        if (cy) this.renderer.centerOn(cy.x, cy.y);
        break;
      }
      case 'r':
        this.setMode(this.mode === 'repair' ? 'normal' : 'repair');
        break;
      case 'x':
        this.setMode(this.mode === 'sell' ? 'normal' : 'sell');
        break;
      case '+':
      case '=':
        this.renderer.setZoom(this.renderer.zoom * 1.15);
        break;
      case '-':
        this.renderer.setZoom(this.renderer.zoom / 1.15);
        break;
      case 'tab': {
        e.preventDefault();
        const order: Category[] = ['building', 'defense', 'infantry', 'vehicle', 'air'];
        this.hud.setTab(order[(order.indexOf(this.hud.tab) + 1) % order.length]);
        break;
      }
    }
  }

  /** Debug: advance the simulation instantly (events are dropped). */
  fastForward(seconds: number) {
    const n = Math.round((seconds * 1000) / TICK_MS);
    for (let i = 0; i < n && !this.world.over; i++) {
      this.world.step();
      this.world.drainEvents();
    }
  }

  // --------------------------------------------------------------- lifecycle

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    for (const d of this.disposers) d();
    this.renderer.dispose();
    this.cameos.dispose();
    this.hud.destroy();
  }
}
