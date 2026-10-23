import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createMap } from '../src/sim/maps';
import { seaDist } from '../src/sim/map';
import { buildLayout } from '../src/render/layout';
import { roadNetFor } from '../src/render/ambient/clearance';
import { buildRoadNet, netInputFrom, bridgeEnds } from '../src/render/ambient/roadnet';
it('stats', () => {
  const m = createMap('desert', 1);
  const l = buildLayout(m);
  const n = roadNetFor(m, l);
  const sea: any = (m.deco as any).sea;
  const isNew = (r: any) => r.width === 0.85 || r.width === 0.8;
  const out: any = {
    w: m.w,
    tiles: Array.from(m.tiles),
    blocked: Array.from(m.blocked),
    ore: Array.from(m.ore),
    roads: l.roads.filter((r) => !isNew(r)).map((r) => r.pts.filter((_, i) => i % 4 === 0)),
    newRoads: l.roads.filter(isNew).map((r) => r.pts.filter((_, i) => i % 4 === 0)),
    tracks: l.tracks.map((r) => r.pts.filter((_, i) => i % 4 === 0)),
    structs: m.structures.map((s) => [s.x, s.y, s.w, s.h, s.kind, (s as any).look ?? '']),
    starts: m.starts,
    oils: m.oils,
    loops: n.loops.map((x) => [x.x, x.y, x.R, x.dead]),
    boards: n.signs.map((q) => ({ x: q.x, y: q.y })),
    lots: n.lots.map((x) => [x.x, x.y]),
    props: n.props.map((p) => [p.kind, p.x, p.y]),
    sites: sea?.sites ?? [],
    lanes: m.lanes,
  };
  writeFileSync('/tmp/claude-0/RD1/dump.json', JSON.stringify(out));
  console.log('RD1STATS ' + JSON.stringify({ roads: l.roads.length, loops: n.loops.filter((x) => !x.dead).length, boards: n.signs.length, ads: n.signs.filter((q) => q.kind <= 6).length, kinds: JSON.stringify(Array.from({ length: 10 }, (_, k) => n.signs.filter((q) => q.kind === k).length)), dead: n.loops.filter((x) => x.dead).length, lots: n.lots.length, props: n.props.length }));
  console.log('NODES ' + JSON.stringify(n.nodes.filter((x) => x.arms.length > 2).map((x) => [x.x.toFixed(1), x.y.toFixed(1), x.arms.length, x.ctl, x.village])));
  console.log('TURN ' + JSON.stringify(n.nodes.filter((x) => x.ctl === 4).map((x) => [x.x.toFixed(1), x.y.toFixed(1), n.lines[x.arms[0].line].half, n.lines[x.arms[0].line].paved])));
  console.log('SIGNS ' + JSON.stringify(n.signs.map((q) => [q.kind, +q.x.toFixed(0), +q.y.toFixed(0), q.line, +q.arc.toFixed(0)])));
  console.log('LOOPS ' + JSON.stringify(n.loops.map((x, i) => [i, +x.x.toFixed(1), +x.y.toFixed(1), x.R, +x.ri.toFixed(2), x.dead, x.town])));
  console.log('SEAD ' + JSON.stringify([[84,134],[101,136],[105,132],[54,123]].map(([x,y]) => [x, y, +seaDist(sea, x, y).toFixed(1)])) + JSON.stringify((sea.sites as any[]).map((q) => [+q.x.toFixed(0), +q.y.toFixed(0), q.look])) + ' hole ' + JSON.stringify(sea.hole) + ' isle ' + JSON.stringify(sea.isle));
  console.log('CNT ' + JSON.stringify({ roadsAll: l.roads.length, ring: l.roads.filter((r) => r.ring).length, lotLanes: l.roads.filter((r) => r.lot !== undefined).length, paved: l.roads.filter((r) => !r.ring && r.lot === undefined).length, tracks: l.tracks.length, trackRings: l.tracks.filter((t) => t.ring).length, round: n.loops.filter((x) => !x.dead).length, dead: n.loops.filter((x) => x.dead).length, props: n.props.length, lots: n.lots.length, ads: n.signs.filter((q) => q.kind <= 6).length, roadSigns: n.signs.filter((q) => q.kind > 6).length, lines: n.lines.length, giveway: n.props.filter((q) => q.kind === 1).length, stop: n.props.filter((q) => q.kind === 2).length, light: n.props.filter((q) => q.kind === 0).length }));
  console.log('LEN ' + JSON.stringify({ paved: +n.lines.filter((q) => q.paved && q.lot < 0).reduce((a, q) => a + q.len, 0).toFixed(0), extra: l.roads.filter((r) => !r.ring && r.lot === undefined && (r.width === 0.85 || r.width === 0.8)).map((r) => +(r.pts.length * 0.25).toFixed(0)) }));
  const dbg: string[] = [];
  buildRoadNet({ ...netInputFrom(m, l.roads, l.tracks, bridgeEnds(m)), debug: dbg });
  console.log('DBG ' + dbg.join(' | '));
});
