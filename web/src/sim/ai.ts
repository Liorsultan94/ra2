import { buildingDef, defsForFaction, factionDefByRole, unitDef } from './defs';
import { Rng } from './rng';
import { TPS, type Entity, type Player } from './types';
import type { Controller, World } from './world';

export type Difficulty = 'easy' | 'normal' | 'hard';

interface DiffCfg {
  think: number;
  firstWave: number;
  waveGrowth: number;
  maxWave: number;
  defenses: number;
  tech: boolean;
  queueDepth: number;
  harvesters: number;
}

const CFG: Record<Difficulty, DiffCfg> = {
  easy: { think: 40, firstWave: 6, waveGrowth: 1, maxWave: 10, defenses: 1, tech: false, queueDepth: 1, harvesters: 1 },
  normal: { think: 20, firstWave: 8, waveGrowth: 2, maxWave: 16, defenses: 3, tech: true, queueDepth: 2, harvesters: 2 },
  hard: { think: 10, firstWave: 9, waveGrowth: 3, maxWave: 24, defenses: 5, tech: true, queueDepth: 3, harvesters: 2 },
};

const BUILD_ORDER: [string, number][] = [
  ['power', 1],
  ['refinery', 1],
  ['barracks', 1],
  ['factory', 1],
  ['power', 2],
  ['refinery', 2],
  ['radar', 1],
  ['power', 3],
  ['airfield', 1],
  ['power', 4],
  ['tech', 1],
  ['factory', 2],
  ['power', 5],
  ['power', 6],
];

export class AIController implements Controller {
  private cfg: DiffCfg;
  private rng: Rng;
  private waveSize: number;
  private lastWave = 0;
  private engineerSent = new Set<number>();

  constructor(
    private world: World,
    private pid: number,
    difficulty: Difficulty,
  ) {
    this.cfg = CFG[difficulty];
    this.rng = new Rng(9001 + pid * 77);
    this.waveSize = this.cfg.firstWave;
  }

  private get p(): Player {
    return this.world.players[this.pid];
  }

  update() {
    const w = this.world;
    if (this.p.defeated || w.over) return;
    if ((w.tick + this.pid * 3) % this.cfg.think !== 0) return;
    const mine = w.list.filter((e) => !e.dead && e.owner === this.pid);
    const buildings = mine.filter((e) => e.kind === 'building');
    const units = mine.filter((e) => e.kind === 'unit');

    const conyard = buildings.find((b) => buildingDef(b.def).role === 'conyard');
    if (!conyard) {
      const mcv = units.find((u) => unitDef(u.def).mcv);
      if (mcv) {
        w.issue(this.pid, { type: 'deploy', ids: [mcv.id] });
        if (mcv.order.type === 'idle' && !mcv.path) {
          // shuffle to a nearby spot if deployment was blocked
          const dx = this.rng.int(5) - 2;
          const dy = this.rng.int(5) - 2;
          w.issue(this.pid, { type: 'move', ids: [mcv.id], x: mcv.x + dx, y: mcv.y + dy });
        }
      }
    } else {
      this.manageBuildings(buildings, conyard);
    }
    this.manageProduction(buildings, units);
    this.manageArmy(buildings, units);
    this.manageRepairs(buildings);
  }

  private count(buildings: Entity[], role: string) {
    return buildings.filter((b) => buildingDef(b.def).role === role).length;
  }

  private manageBuildings(buildings: Entity[], conyard: Entity) {
    const w = this.world;
    const p = this.p;
    for (const cat of ['building', 'defense'] as const) {
      const ready = p.ready[cat];
      if (ready) {
        const spot = this.findSpot(ready, conyard);
        if (spot) w.issue(this.pid, { type: 'place', def: ready, tx: spot[0], ty: spot[1] });
        else w.issue(this.pid, { type: 'cancel', def: ready });
      }
    }
    if (p.queues.building.length === 0 && !p.ready.building) {
      const next = this.nextBuilding(buildings);
      if (next) w.issue(this.pid, { type: 'produce', def: next });
    }
    if (p.queues.defense.length === 0 && !p.ready.defense && this.count(buildings, 'factory') > 0 && p.credits > 1200) {
      const defenses = buildings.filter((b) => buildingDef(b.def).category === 'defense').length;
      if (defenses < this.cfg.defenses) {
        const order = ['def_gun', 'def_aa', 'def_at', 'def_gun', 'def_at', 'def_aa'];
        const role = order[defenses % order.length];
        const pick = factionDefByRole(p.faction, role);
        const alt = factionDefByRole(p.faction, 'def_gun');
        if (w.canBuild(this.pid, pick.id)) w.issue(this.pid, { type: 'produce', def: pick.id });
        else if (w.canBuild(this.pid, alt.id)) w.issue(this.pid, { type: 'produce', def: alt.id });
      }
    }
  }

  private nextBuilding(buildings: Entity[]): string | null {
    const w = this.world;
    const p = this.p;
    const f = p.faction;
    const powerDef = factionDefByRole(f, 'power');
    for (const [role, n] of BUILD_ORDER) {
      if (role === 'tech' && !this.cfg.tech) continue;
      if (this.count(buildings, role) >= n) continue;
      const d = factionDefByRole(f, role);
      if (!w.canBuild(this.pid, d.id)) continue;
      if (role !== 'power' && p.powerOut - p.powerUse + d.power < 0 && w.canBuild(this.pid, powerDef.id)) return powerDef.id;
      return d.id;
    }
    if (p.powerOut - p.powerUse < 40 && w.canBuild(this.pid, powerDef.id)) return powerDef.id;
    return null;
  }

  private findSpot(defId: string, conyard: Entity): [number, number] | null {
    const w = this.world;
    const d = buildingDef(defId);
    const { map } = w;
    const enemy = this.enemyBase();
    let bx = conyard.x;
    let by = conyard.y;
    if (d.category === 'defense' && enemy) {
      const dx = enemy[0] - bx;
      const dy = enemy[1] - by;
      const len = Math.hypot(dx, dy) || 1;
      const off = 6 + this.rng.int(3);
      const side = (this.rng.next() - 0.5) * 8;
      bx += (dx / len) * off - (dy / len) * side;
      by += (dy / len) * off + (dx / len) * side;
    }
    let oreX = -1;
    let oreY = -1;
    if (d.role === 'refinery') {
      let best = Infinity;
      for (const m of map.oreMines) {
        const dist = Math.hypot(m.x - conyard.x, m.y - conyard.y);
        const taken = w.list.some((b) => !b.dead && b.kind === 'building' && buildingDef(b.def).role === 'refinery' && Math.hypot(b.x - m.x, b.y - m.y) < 8);
        if (!taken && dist < best && dist < 26) {
          best = dist;
          oreX = m.x;
          oreY = m.y;
        }
      }
    }
    let best: [number, number] | null = null;
    let bestScore = Infinity;
    for (let r = 0; r <= 14; r++) {
      for (let oy = -r; oy <= r; oy++) {
        for (let ox = -r; ox <= r; ox++) {
          if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
          const tx = Math.round(bx + ox - d.w / 2);
          const ty = Math.round(by + oy - d.h / 2);
          if (!w.canPlace(this.pid, defId, tx, ty)) continue;
          if (d.category !== 'defense' && !this.hasClearance(tx, ty, d.w, d.h)) continue;
          let score = Math.hypot(tx + d.w / 2 - bx, ty + d.h / 2 - by);
          if (oreX >= 0) score = Math.hypot(tx + d.w / 2 - oreX, ty + d.h / 2 - oreY) * 1.5 + score * 0.3;
          if (score < bestScore) {
            bestScore = score;
            best = [tx, ty];
          }
        }
      }
      if (best && (oreX < 0 || r > 10)) break;
    }
    return best;
  }

  /** Keep a one-tile walkable ring around new buildings so the base doesn't seal itself in. */
  private hasClearance(tx: number, ty: number, bw: number, bh: number) {
    const w = this.world;
    const { map } = w;
    for (let y = ty - 1; y <= ty + bh; y++) {
      for (let x = tx - 1; x <= tx + bw; x++) {
        if (x >= tx && x < tx + bw && y >= ty && y < ty + bh) continue;
        if (x < 0 || y < 0 || x >= map.w || y >= map.h) return false;
        if (w.occ[y * map.w + x] !== 0) return false;
      }
    }
    return true;
  }

  private enemyBase(): [number, number] | null {
    for (const p of this.world.players) if (p.id !== this.pid && !p.defeated) return [p.startX, p.startY];
    return null;
  }

  private manageProduction(buildings: Entity[], units: Entity[]) {
    const w = this.world;
    const p = this.p;
    const f = p.faction;
    const refineries = this.count(buildings, 'refinery');
    const harvesters = units.filter((u) => unitDef(u.def).harvester).length;
    const harvDef = `${f}_harvester`;
    const vq = p.queues.vehicle;
    const iq = p.queues.infantry;
    const aq = p.queues.air;
    if (refineries > 0 && harvesters < Math.min(4, refineries * this.cfg.harvesters) && !vq.some((q) => q.def === harvDef) && w.canBuild(this.pid, harvDef)) {
      w.issue(this.pid, { type: 'produce', def: harvDef });
      return;
    }
    const savingForBuilding = p.queues.building.length === 0 && p.credits < 800;
    if (savingForBuilding && buildings.length < 6) return;

    // capture an oil derrick early with an engineer
    const eng = `${f}_engineer`;
    const engineers = units.filter((u) => u.def === eng);
    for (const e of engineers) {
      if (this.engineerSent.has(e.id)) continue;
      const oil = this.nearestOil(e);
      if (oil) {
        w.issue(this.pid, { type: 'capture', ids: [e.id], target: oil.id });
        this.engineerSent.add(e.id);
      }
    }
    if (this.cfg.tech && engineers.length === 0 && this.engineerSent.size < 2 && w.tick > TPS * 60 && w.canBuild(this.pid, eng) && !iq.some((q) => q.def === eng) && this.nearestOil(null)) {
      w.issue(this.pid, { type: 'produce', def: eng });
    }

    // react to enemy air power with more anti-air
    let enemyAir = 0;
    for (const e of w.list) if (!e.dead && e.kind === 'unit' && w.isEnemy(this.pid, e.owner) && unitDef(e.def).air && !unitDef(e.def).temp) enemyAir++;
    const myAA = units.filter((u) => unitDef(u.def).aiTag === 'aa').length;
    const wantAA = enemyAir > 0 && myAA < Math.ceil(enemyAir * 0.7) + 1;

    const queues: [typeof iq, 'infantry' | 'vehicle' | 'air', number][] = [
      [iq, 'infantry', 300],
      [vq, 'vehicle', 700],
      [aq, 'air', 900],
    ];
    for (const [q, cat, min] of queues) {
      if (q.length >= this.cfg.queueDepth || p.credits < min) continue;
      const opts: [string, number][] = [];
      for (const d of defsForFaction(f)) {
        if (d.kind !== 'unit' || d.category !== cat || !d.aiWeight) continue;
        let wgt = d.aiWeight;
        if (d.aiTag === 'aa') wgt = wantAA ? 10 : enemyAir > 0 ? 2 : 0.3;
        opts.push([d.id, wgt]);
      }
      const pick = this.weighted(opts);
      if (pick) w.issue(this.pid, { type: 'produce', def: pick });
    }
  }

  private nearestOil(from: Entity | null): Entity | null {
    let best: Entity | null = null;
    let bd = Infinity;
    const ox = from ? from.x : this.p.startX;
    const oy = from ? from.y : this.p.startY;
    for (const e of this.world.list) {
      if (e.dead || e.def !== 'oil' || e.owner === this.pid) continue;
      if (e.owner >= 0) continue;
      const d = Math.hypot(e.x - ox, e.y - oy);
      if (d < bd && d < 40) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  private weighted(opts: [string, number][]): string | null {
    const ok = opts.filter(([id]) => this.world.canBuild(this.pid, id));
    const total = ok.reduce((s, [, n]) => s + n, 0);
    if (total === 0) return null;
    let r = this.rng.next() * total;
    for (const [id, n] of ok) {
      r -= n;
      if (r <= 0) return id;
    }
    return ok[ok.length - 1][0];
  }

  private manageArmy(buildings: Entity[], units: Entity[]) {
    const w = this.world;
    const army = units.filter((u) => {
      const d = unitDef(u.def);
      return !!d.weapon && !d.harvester && !d.temp;
    });
    if (army.length === 0) return;

    // defend the base: respond to buildings or harvesters under attack
    const threatened = [...buildings, ...units.filter((u) => unitDef(u.def).harvester)].find((b) => w.tick - b.lastHurt < TPS * 3);
    if (threatened) {
      let threat: Entity | null = null;
      w.queryRadius(threatened.x, threatened.y, 10, (o) => {
        if (!threat && o.kind === 'unit' && w.isEnemy(this.pid, o.owner)) threat = o;
      });
      if (threat) {
        const t = threat as Entity;
        const home = army.filter((u) => Math.hypot(u.x - this.p.startX, u.y - this.p.startY) < 28 && u.order.type !== 'attack');
        if (home.length) w.issue(this.pid, { type: 'move', ids: home.map((u) => u.id), x: t.x, y: t.y, attackMove: true });
        return;
      }
    }

    const idle = army.filter((u) => u.order.type === 'idle');
    const enemy = this.enemyBase();
    if (!enemy) return;
    // gather idle units at a rally point between base and enemy
    const dx = enemy[0] - this.p.startX;
    const dy = enemy[1] - this.p.startY;
    const len = Math.hypot(dx, dy) || 1;
    const rx = this.p.startX + (dx / len) * 10;
    const ry = this.p.startY + (dy / len) * 10;
    const atRally = idle.filter((u) => Math.hypot(u.x - rx, u.y - ry) < 7);
    const strays = idle.filter((u) => Math.hypot(u.x - rx, u.y - ry) >= 7 && Math.hypot(u.x - this.p.startX, u.y - this.p.startY) < 22);
    if (strays.length) w.issue(this.pid, { type: 'move', ids: strays.map((u) => u.id), x: rx, y: ry });

    const sinceWave = w.tick - this.lastWave;
    if (atRally.length >= this.waveSize || (atRally.length >= 4 && sinceWave > TPS * 240)) {
      const target = this.pickTarget();
      if (target) {
        w.issue(this.pid, { type: 'move', ids: atRally.map((u) => u.id), x: target.x, y: target.y, attackMove: true });
        this.lastWave = w.tick;
        this.waveSize = Math.min(this.cfg.maxWave, this.waveSize + this.cfg.waveGrowth);
      }
    }
    // units that finished an attack-move far from home keep pushing toward the next target
    const deep = idle.filter((u) => Math.hypot(u.x - this.p.startX, u.y - this.p.startY) >= 22);
    if (deep.length) {
      const target = this.pickTarget(deep[0]);
      if (target) w.issue(this.pid, { type: 'move', ids: deep.map((u) => u.id), x: target.x, y: target.y, attackMove: true });
    }
  }

  private pickTarget(from?: Entity): Entity | null {
    const w = this.world;
    const ox = from ? from.x : this.p.startX;
    const oy = from ? from.y : this.p.startY;
    let best: Entity | null = null;
    let bd = Infinity;
    for (const e of w.list) {
      if (e.dead || !w.isEnemy(this.pid, e.owner)) continue;
      const d = Math.hypot(e.x - ox, e.y - oy) + (e.kind === 'unit' ? 15 : 0);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  private manageRepairs(buildings: Entity[]) {
    if (this.p.credits < 600) return;
    for (const b of buildings) {
      if (!b.repairing && b.hp < b.maxHp * 0.6 && this.world.tick - b.lastHurt > TPS * 2) {
        this.world.issue(this.pid, { type: 'repair', id: b.id });
      }
    }
  }
}

