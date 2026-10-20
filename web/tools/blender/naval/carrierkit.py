# Blender 5.2.2 (LTS) - NV2 carrier kit: the aircraft carriers of USA, Russia and China and their deck jets (render only;
# sim/airbase.ts DECK is the flight deck layout these are built to).
#   nice -n 15 /opt/blender/blender -b --factory-startup -P web/tools/blender/naval/carrierkit.py -- <out_dir> [kit|sheet|cameos|all]
#   (or web/tools/blender/naval/make.sh carrier)
#
# Uses the NV1 naval kit's primitives, AO bake and LODs (navalkit.py) and writes next to its output:
#   naval-cv<nation>-raw.glb (the carrier and its deck jet; pack.mjs -> public/models/naval/naval-cv<nation>.glb) and the
#   carriers' entries in naval.json (run after the naval kit: it adds to that file).
# Pieces (one root empty per model key; "<mesh>_l1" the far level of detail):
#   cv_<nation>       the carrier (bow = +X, waterline at z = 0, flight deck at z = DECK_Z): hull, flight deck with its
#                     painted lines (fine on a ship's deck), island, close-in guns and SAM launchers, deck-edge lights,
#                     a few deck crew; "_spin" the island's radar, "_jbd" the jet blast deflector behind the launch
#                     position (hinged at its fore edge: it rises for a launch).
#                     USA: angled deck, island aft to starboard, four catapult tracks, elevators. Russia: ski-jump bow,
#                     a big island with a funnel. China: ski-jump bow, its own squarer deck and a tall tapered mast-island.
#   cv_<nation>_jet   the deck jet (nose +X, ~0.6 tiles long): "_foldL" / "_foldR" the outer wing panels (hinged along X:
#                     they fold up when parked), "_gear" the undercarriage.
# Materials as the naval kit (paint, team, glass, lamp). No logos, real names or hull numbers (a fictional number).
# Units: one game tile = 1; Blender X forward, Y to port, Z up (the game's starboard is -Y).
import json
import math
import os
import sys
import time

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import navalkit as nk  # noqa: E402

OUT = nk.OUT
STEP = nk.STEP
box, cyl, bar, prism, loft, lamp = nk.box, nk.cyl, nk.bar, nk.prism, nk.loft, nk.lamp
srgb = nk.srgb

# the sim's deck layout (sim/airbase.ts DECK), in the game's ship frame: x to the bow, y to starboard
DECK_Z = 0.28
BOW, STERN = 2.6, -2.6
PADS = [(1.75, 0.42), (1.05, 0.44), (-1.45, 0.44), (-2.12, 0.42)]
PARK = -1.25
LAUNCH = (-0.15, -0.22)
RAMP_LEN, RAMP_Z = 0.75, 0.12
TD = (-2.05, -0.12)
ANGLE = -0.16
STOP = 1.15


def B(x, y):
    """The game's ship frame (y to starboard) -> Blender (y to port)."""
    return (x, -y)


WHITE, YELLOW, RED, DARK, GLASS = 0xe6e6de, 0xd8b83c, 0xb83226, 0x26282a, 0x5a7890

NATIONS = {
    'usa': dict(hull=0x8a9298, deck=0x3b3e41, isl=0x949ca2, side=0x7c848a, ski=False, number='77'),
    'russia': dict(hull=0x6c757d, deck=0x4a4741, isl=0x7a838b, side=0x626a71, ski=True, number='63'),
    'china': dict(hull=0x929ea8, deck=0x4d5257, isl=0x9ea9b2, side=0x86919a, ski=True, number='19'),
}

# flight deck outlines (Blender XY, counter-clockwise: the starboard edge (-Y) first, stern to bow)
OUTLINE = {
    'usa': [(-2.6, -0.40), (-2.2, -0.56), (-1.05, -0.58), (-1.05, -0.72), (-0.40, -0.72), (-0.40, -0.62), (0.9, -0.60), (1.9, -0.52), (2.45, -0.30), (2.62, -0.14), (2.62, 0.30), (2.3, 0.40), (1.4, 0.46), (0.9, 0.64), (-0.2, 0.72), (-1.6, 0.58), (-2.45, 0.44), (-2.62, 0.22)],
    'russia': [(-2.6, -0.42), (-1.9, -0.55), (-0.95, -0.55), (-0.95, -0.72), (0.45, -0.72), (0.45, -0.55), (1.2, -0.55), (1.85, -0.40), (2.62, -0.20), (2.62, 0.30), (1.85, 0.42), (0.8, 0.62), (-0.6, 0.68), (-1.8, 0.54), (-2.5, 0.40), (-2.62, 0.20)],
    'china': [(-2.6, -0.46), (-2.3, -0.58), (-0.30, -0.58), (-0.30, -0.72), (0.40, -0.72), (0.40, -0.58), (1.5, -0.52), (1.85, -0.42), (2.62, -0.22), (2.62, 0.30), (1.85, 0.44), (1.2, 0.50), (0.6, 0.68), (-1.0, 0.68), (-2.2, 0.52), (-2.62, 0.30)],
}

# the island (Blender x0, x1, y0, y1) and its height
ISLAND = {'usa': (-1.0, -0.45, -0.70, -0.50), 'russia': (-0.9, 0.42, -0.70, -0.50), 'china': (-0.26, 0.36, -0.70, -0.50)}


def deck_y_at(outline, x, port=True):
    """The deck edge's y at x (the outline's port or starboard side)."""
    pts = outline
    best = None
    for i in range(len(pts)):
        (x0, y0), (x1, y1) = pts[i], pts[(i + 1) % len(pts)]
        if (y0 > 0) != port and (y1 > 0) != port:
            continue
        if min(x0, x1) - 1e-6 <= x <= max(x0, x1) + 1e-6 and abs(x1 - x0) > 1e-6:
            y = y0 + (y1 - y0) * (x - x0) / (x1 - x0)
            if best is None or (port and y > best) or (not port and y < best):
                best = y
    return best if best is not None else (0.4 if port else -0.4)


def stripe(a, b, w, col, z=DECK_Z + 0.002, dash=0.0, gap=0.0):
    """A painted line from a to b (Blender xy) w wide; dashed when dash > 0."""
    out = []
    ax, ay = a
    bx, by = b
    L = math.hypot(bx - ax, by - ay)
    ang = math.atan2(by - ay, bx - ax)
    segs = [(0.0, L)] if dash <= 0 else [(s, min(L, s + dash)) for s in [i * (dash + gap) for i in range(int(L / (dash + gap)) + 1)] if s < L]
    for s0, s1 in segs:
        o = box(s0, s1, -w / 2, w / 2, z - 0.001, z, col, cell=0.0)
        o.data.transform(Matrix.Translation((ax, ay, 0)) @ Matrix.Rotation(ang, 4, 'Z'))
        out.append(o)
    return out


def digit(ch, x, y, z, h, col, face='side'):
    """A seven-segment numeral painted on the island's side (a fictional number)."""
    seg = {'0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcfgd'}[ch]
    w = h * 0.55
    t = h * 0.12
    S = {'a': (0, w, h - t, h), 'b': (w - t, w, h / 2, h), 'c': (w - t, w, 0, h / 2), 'd': (0, w, 0, t), 'e': (0, t, 0, h / 2), 'f': (0, t, h / 2, h), 'g': (0, w, h / 2 - t / 2, h / 2 + t / 2)}
    out = []
    for s in seg:
        u0, u1, v0, v1 = S[s]
        # on the starboard face of the island (normal -Y): u runs towards -X (read from outside)
        out.append(box(x - u1, x - u0, y - 0.004, y, z + v0, z + v1, col, cell=0.0))
    return out


# ------------------------------------------------------------------ the carrier

def ski_ramp(outline, col, side_col):
    """The ski-jump: the deck rises over the last RAMP_LEN of the bow (z = DECK_Z + RAMP_Z (t^2))."""
    x0 = BOW - RAMP_LEN
    secs = []
    n = 8
    for i in range(n + 1):
        t = i / n
        x = x0 + RAMP_LEN * t
        yp = deck_y_at(outline, min(x, BOW - 1e-3), True)
        ys = deck_y_at(outline, min(x, BOW - 1e-3), False)
        z = DECK_Z + RAMP_Z * t * t
        secs.append([(x, ys, DECK_Z - 0.03), (x, ys, z), (x, (ys + yp) / 2, z + 0.001), (x, yp, z), (x, yp, DECK_Z - 0.03)])
    r = loft(secs, col, name='ramp')
    return [r]


def build_carrier(nation, info, objs):
    P = NATIONS[nation]
    key = f'cv_{nation}'
    out = OUTLINE[nation]
    body = []
    # the hull: a big displacement hull flared out to the hangar deck, the flight deck overhanging it
    h, hd = nk.hull(4.9, 1.0, DECK_Z - 0.035, 0.16, P['hull'], P['side'], bow=0.3, transom=0.9, deadrise=0.05, sheer=0.0, flare=0.14, n=22)
    body += [h, hd]
    # boot topping at the waterline
    body.append(box(-2.42, 2.2, -0.46, 0.46, -0.012, 0.012, 0x2a2c2e, cell=0.0))
    # the gallery deck under the flight deck's overhang (a dark band round the edge)
    deck0 = prism(out, DECK_Z - 0.055, DECK_Z - 0.02, P['isl'], cell=0.0, name='gallery', top_scale=1.0)
    body.append(deck0)
    flight = prism(out, DECK_Z - 0.02, DECK_Z, P['deck'], cell=0.25, name='deck')
    body.append(flight)
    if P['ski']:
        body += ski_ramp(out, P['deck'], P['side'])
    # sponsons for the island and the guns
    xi0, xi1, yi0, yi1 = ISLAND[nation]
    # ---- painted lines (white / yellow / red): the angled deck's centreline and edges, the landing area, the foul line
    ax, ay = B(*TD)
    ang = -ANGLE  # (Blender: to port is +Y)
    ux, uy = math.cos(ang), math.sin(ang)
    a0 = (ax - ux * 0.5, ay - uy * 0.5)
    a1 = (ax + ux * 3.0, ay + uy * 3.0)
    body += stripe(a0, a1, 0.012, WHITE, dash=0.08, gap=0.06)
    for side in (-1, 1):
        off = (-uy * 0.2 * side, ux * 0.2 * side)
        body += stripe((a0[0] + off[0], a0[1] + off[1]), (a1[0] + off[0], a1[1] + off[1]), 0.008, WHITE)
    # the foul line along the landing area's starboard edge (red / white)
    fl0 = (a0[0] - uy * -0.27, a0[1] + ux * -0.27)
    body += stripe(fl0, (fl0[0] + ux * 3.2, fl0[1] + uy * 3.2), 0.008, RED, dash=0.05, gap=0.05)
    # arresting wires across the touchdown zone
    for k in range(4):
        cx, cy = ax + ux * (0.15 + k * 0.17), ay + uy * (0.15 + k * 0.17)
        body += stripe((cx + uy * 0.17, cy - ux * 0.17), (cx - uy * 0.17, cy + ux * 0.17), 0.006, 0x1a1a1a, z=DECK_Z + 0.004)
    # the launch: catapult tracks (USA) or the run-up line to the ski-jump
    lx, ly = B(*LAUNCH)
    cats = [ly] + ([-0.05] if nation == 'usa' else [ly - 0.22])
    for k, cyy in enumerate(cats):
        x0 = lx if k == 0 else lx + 0.6
        body += stripe((x0, cyy), (BOW - (RAMP_LEN if P['ski'] else 0.05), cyy), 0.014 if nation == 'usa' else 0.01, 0x2b2d2f if nation == 'usa' else YELLOW, z=DECK_Z + 0.003)
    if nation == 'usa':
        # the two waist catapults on the angled deck
        for k in range(2):
            o = (B(-0.65, -0.30 - 0.14 * k))
            body += stripe(o, (o[0] + ux * 1.5, o[1] + uy * 1.5), 0.014, 0x2b2d2f, z=DECK_Z + 0.003)
        # bow / launch lines (yellow) and the deck's edge line
        body += stripe((lx - 0.1, ly), (BOW - 0.05, ly), 0.004, YELLOW, z=DECK_Z + 0.004, dash=0.1, gap=0.06)
    # parking marks at the deck pads (yellow T)
    for (px, py) in PADS:
        bx_, by_ = B(px, py)
        body += stripe((bx_ - 0.18, by_), (bx_ + 0.18, by_), 0.008, YELLOW)
    # elevators (lighter panels at the deck edge)
    elev = {'usa': [(0.35, 0.75, False), (1.25, 1.65, False), (-1.75, -1.35, False), (-1.55, -1.15, True)], 'russia': [(0.65, 1.05, False), (-1.6, -1.2, False)], 'china': [(0.7, 1.1, False), (-1.65, -1.25, False)]}[nation]
    for x0, x1, port in elev:
        ye = deck_y_at(out, (x0 + x1) / 2, port)
        y0, y1 = (ye - 0.2, ye) if port else (ye, ye + 0.2)
        body.append(box(x0, x1, y0, y1, DECK_Z - 0.003, DECK_Z + 0.001, 0x5a5e62, cell=0.0))
        body += stripe((x0, y0), (x1, y0), 0.005, YELLOW) + stripe((x0, y1), (x1, y1), 0.005, YELLOW)
    # ---- the island
    isl = []
    base = box(xi0, xi1, yi0, yi1, DECK_Z, DECK_Z + 0.24, P['isl'], cell=0.08)
    isl.append(base)
    if nation == 'usa':
        top = box(xi0 + 0.05, xi1 - 0.12, yi0 + 0.02, yi1 - 0.02, DECK_Z + 0.24, DECK_Z + 0.42, P['isl'], cell=0.08)
        nk.taper_top(top, 0.92, 0.9)
        isl.append(top)
        isl.append(box(xi0 + 0.06, xi1 - 0.13, yi1 - 0.019, yi1 - 0.018, DECK_Z + 0.33, DECK_Z + 0.38, GLASS, 'glass', cell=0.0))
        isl.append(box(xi1 - 0.13, xi1 - 0.12, yi0 + 0.03, yi1 - 0.03, DECK_Z + 0.33, DECK_Z + 0.38, GLASS, 'glass', cell=0.0))
        # the mast and its radar
        mx = (xi0 + xi1) / 2 - 0.05
        isl += [bar((mx, (yi0 + yi1) / 2, DECK_Z + 0.42), (mx, (yi0 + yi1) / 2, DECK_Z + 0.72), 0.018, P['isl'])]
        isl.append(box(mx - 0.06, mx + 0.06, yi0 + 0.04, yi1 - 0.04, DECK_Z + 0.58, DECK_Z + 0.6, P['isl'], cell=0.0))
        spin_z = DECK_Z + 0.74
        isl += digit(P['number'][0], xi1 - 0.08, yi0, DECK_Z + 0.08, 0.12, WHITE) + digit(P['number'][1], xi1 - 0.18, yi0, DECK_Z + 0.08, 0.12, WHITE)
    elif nation == 'russia':
        top = box(xi0 + 0.15, xi1 - 0.25, yi0 + 0.015, yi1 - 0.015, DECK_Z + 0.24, DECK_Z + 0.52, P['isl'], cell=0.08)
        nk.taper_top(top, 0.9, 0.85)
        isl.append(top)
        # the funnel aft and the big block mast forward with its flat radar faces
        isl.append(nk.taper_top(box(xi0 + 0.02, xi0 + 0.28, yi0 + 0.03, yi1 - 0.03, DECK_Z + 0.24, DECK_Z + 0.58, P['isl'], cell=0.08), 0.85, 0.85))
        isl.append(box(xi0 + 0.04, xi0 + 0.26, yi0 + 0.05, yi1 - 0.05, DECK_Z + 0.58, DECK_Z + 0.6, 0x1c1c1c, cell=0.0))
        blk = nk.taper_top(box(xi1 - 0.5, xi1 - 0.2, yi0 + 0.03, yi1 - 0.03, DECK_Z + 0.52, DECK_Z + 0.82, P['isl'], cell=0.08), 0.75, 0.75)
        isl.append(blk)
        for zz in (0.6, 0.72):
            isl.append(box(xi1 - 0.47, xi1 - 0.23, yi0 + 0.025, yi0 + 0.03, DECK_Z + zz, DECK_Z + zz + 0.08, 0x2c3134, cell=0.0))
        isl.append(box(xi1 - 0.3, xi1 - 0.29, yi0 + 0.04, yi1 - 0.04, DECK_Z + 0.4, DECK_Z + 0.46, GLASS, 'glass', cell=0.0))
        mx = xi1 - 0.35
        isl += [bar((mx, (yi0 + yi1) / 2, DECK_Z + 0.82), (mx, (yi0 + yi1) / 2, DECK_Z + 1.02), 0.014, P['isl'])]
        spin_z = DECK_Z + 1.04
        isl += digit(P['number'][0], xi1 - 0.55, yi0, DECK_Z + 0.08, 0.12, WHITE) + digit(P['number'][1], xi1 - 0.65, yi0, DECK_Z + 0.08, 0.12, WHITE)
    else:
        # one tall tapered tower: the mast and island in one, faceted, with its flat array faces
        twr = prism([(xi0 + 0.02, yi0 + 0.02), (xi1 - 0.02, yi0 + 0.02), (xi1 - 0.02, yi1 - 0.02), (xi0 + 0.02, yi1 - 0.02)], DECK_Z + 0.24, DECK_Z + 0.78, P['isl'], cell=0.0, name='tower', top_scale=0.55)
        isl.append(twr)
        isl.append(box(xi0 + 0.1, xi1 - 0.1, yi0 + 0.06, yi1 - 0.06, DECK_Z + 0.78, DECK_Z + 0.84, 0x2c3134, cell=0.0))
        for zz in (0.36, 0.5):
            isl.append(box(xi0 + 0.06, xi1 - 0.06, yi0 + 0.012, yi0 + 0.016, DECK_Z + zz, DECK_Z + zz + 0.1, 0x2c3134, cell=0.0))
        isl.append(box(xi1 - 0.025, xi1 - 0.02, yi0 + 0.04, yi1 - 0.04, DECK_Z + 0.28, DECK_Z + 0.33, GLASS, 'glass', cell=0.0))
        spin_z = DECK_Z + 0.86
        isl += digit(P['number'][0], xi1 - 0.06, yi0, DECK_Z + 0.06, 0.12, WHITE) + digit(P['number'][1], xi1 - 0.16, yi0, DECK_Z + 0.06, 0.12, WHITE)
    body += isl
    # flood lamps on the island, the deck-edge lights, the landing centreline lights (gentle at night)
    lamps = []
    lamps.append(lamp((xi0 + xi1) / 2, yi1 + 0.002, DECK_Z + 0.2, 0xfff0d8, 0.012))
    lamps.append(lamp(xi0 + 0.05, yi1 + 0.002, DECK_Z + 0.2, 0xfff0d8, 0.012))
    for i in range(14):
        x = STERN + 0.2 + i * 0.36
        for port in (True, False):
            y = deck_y_at(out, x, port)
            lamps.append(lamp(x, y * 0.985, DECK_Z + 0.004, 0xc8d8ff, 0.006))
    for i in range(6):
        cx, cy = ax + ux * (i * 0.42), ay + uy * (i * 0.42)
        lamps.append(lamp(cx, cy, DECK_Z + 0.004, 0xfff4e0, 0.007))
    lamps += nk.running_lights(4.8, 1.0, DECK_Z - 0.06, spin_z + 0.04)
    info[key + '_lamps'] = [[(xi0 + xi1) / 2, yi1, DECK_Z + 0.2], [xi0 + 0.05, yi1, DECK_Z + 0.2]]
    # close-in guns and SAM launchers on the sponsons at the four corners
    guns = []
    for gx, port in ((-2.3, True), (-2.3, False), (2.0, True), (1.6, False)):
        gy = deck_y_at(out, gx, port)
        gy += 0.03 if port else -0.03
        guns.append(box(gx - 0.08, gx + 0.08, gy - 0.06, gy + 0.06, DECK_Z - 0.09, DECK_Z - 0.04, P['side'], cell=0.0))
        guns += nk.gun_turret(gx, gy, DECK_Z - 0.04, P['isl'], s=0.9, barrel=0.08, dome=True)
    for gx, port in ((-1.9, False), (1.35, True)):
        gy = deck_y_at(out, gx, port) + (0.04 if port else -0.04)
        guns.append(box(gx - 0.07, gx + 0.07, gy - 0.05, gy + 0.05, DECK_Z - 0.08, DECK_Z - 0.01, 0x7a8288, cell=0.0))
        guns.append(box(gx - 0.05, gx + 0.05, gy - 0.035, gy + 0.035, DECK_Z - 0.01, DECK_Z + 0.03, 0x6a7278, cell=0.0))
    body += guns
    # a few deck crew (shirt colours by job), standing by the pads and the island
    crew = []
    shirts = [0xd8c030, 0x3050b0, 0x30a040, 0xc03020, 0xe8e8e8, 0x8a5a30, 0x8040a0, 0xd8c030]
    spots = [(1.4, 0.20), (0.7, 0.30), (-1.15, 0.22), (-1.8, 0.24), (0.15, 0.05), (-0.35, -0.05), (2.05, 0.25), (-0.6, 0.32)]
    for (sx, sy), sh in zip(spots, shirts):
        bx_, by_ = B(sx, sy)
        crew.append(box(bx_ - 0.008, bx_ + 0.008, by_ - 0.01, by_ + 0.01, DECK_Z, DECK_Z + 0.028, sh, cell=0.0))
        crew.append(box(bx_ - 0.006, bx_ + 0.006, by_ - 0.006, by_ + 0.006, DECK_Z + 0.028, DECK_Z + 0.04, 0xc89878, cell=0.0))
    body += crew + lamps
    # the jet blast deflector (its own object: hinged at its fore edge, it rises behind the jet at launch)
    jx = lx - 0.42
    jbd = [box(jx - 0.16, jx, ly - 0.15, ly + 0.15, DECK_Z, DECK_Z + 0.012, 0x6e7276, cell=0.05)]
    # the radar (spins)
    spin = [box(-0.008 + (xi0 + xi1) / 2 - 0.05, 0.008 + (xi0 + xi1) / 2 - 0.05, (yi0 + yi1) / 2 - 0.09, (yi0 + yi1) / 2 + 0.09, spin_z, spin_z + 0.025, 0x3a3e42, cell=0.0)]
    if nation == 'russia':
        spin = [box(xi1 - 0.36, xi1 - 0.34, (yi0 + yi1) / 2 - 0.1, (yi0 + yi1) / 2 + 0.1, spin_z, spin_z + 0.03, 0x3a3e42, cell=0.0)]
    elif nation == 'china':
        spin = [box((xi0 + xi1) / 2 - 0.01, (xi0 + xi1) / 2 + 0.01, (yi0 + yi1) / 2 - 0.08, (yi0 + yi1) / 2 + 0.08, spin_z, spin_z + 0.025, 0x3a3e42, cell=0.0)]
    root = bpy.data.objects.new(key, None)
    bpy.context.scene.collection.objects.link(root)
    groups = [('_body', body, (0, 0, 0), 9000, 2400), ('_spin', spin, None, 40, 16), ('_jbd', jbd, (jx, ly, DECK_Z), 60, 24)]
    nk.PARTS.clear()
    src = nk.assemble(key + '_src', [o for g in groups for o in g[1]])
    nk.bake_ao(src, ground=-0.05, samples=20)
    tris = 0
    for name, ob, pivot, g0, g1 in nk.split_parts(src, groups):
        lo = nk.decimated(ob, g0, f'{key}{name}_lo')
        lo1 = nk.decimated(ob, g1, f'{key}{name}_l1')
        bpy.data.objects.remove(ob)
        lo.name = f'{key}{name}'
        lo.data.name = lo.name
        for o in (lo, lo1):
            o.data.transform(Matrix.Translation(-Vector(pivot)))
            o.location = pivot
            o.parent = root
            nk.smooth(o)
        tris += nk.ntris(lo)
        objs += [lo, lo1]
    objs.append(root)
    info[key] = {'tris': tris, 'len': 5.2, 'beam': 1.4, 'h': spin_z + 0.05, 'deck': DECK_Z, 'ski': P['ski'], 'jbd': [jx, ly, DECK_Z]}
    return root


# ------------------------------------------------------------------ the deck jets

JETS = {
    # (length, span, folded span share, colour, dark, twin tails, canards, stealthy faceted nose)
    'usa': dict(L=0.6, S=0.42, fold=0.62, col=0x9aa3ab, dark=0x5f666c, canard=False, stealth=False, tails=0.36),
    'russia': dict(L=0.66, S=0.46, fold=0.55, col=0x8b9aaa, dark=0x56616c, canard=True, stealth=False, tails=0.3),
    'china': dict(L=0.62, S=0.42, fold=0.6, col=0x8f979e, dark=0x5a6168, canard=False, stealth=True, tails=0.42),
}


def build_jet(nation, info, objs):
    J = JETS[nation]
    key = f'cv_{nation}_jet'
    L, S = J['L'], J['S']
    zc = 0.06  # fuselage centreline above the deck (on its gear)
    # fuselage: sections along x (nose +X), ellipse-ish, flatter and wider aft (twin engines)
    secs = []
    n = 12
    for i in range(n + 1):
        t = i / n
        x = -L / 2 + L * t
        nose = max(0.0, (t - 0.72) / 0.28)
        w = 0.055 * (1 - nose ** 1.6 * 0.92) * (0.85 + 0.15 * min(1, t * 4))
        hgt = 0.04 * (1 - nose ** 1.8 * 0.85)
        if J['stealth']:
            # faceted, chined
            sec = [(x, 0, zc - hgt * 0.7), (x, w * 0.9, zc - hgt * 0.2), (x, w, zc + 0.002), (x, w * 0.55, zc + hgt * 0.8), (x, 0, zc + hgt)]
        else:
            sec = [(x, 0, zc - hgt * 0.8), (x, w * 0.8, zc - hgt * 0.5), (x, w, zc), (x, w * 0.7, zc + hgt * 0.7), (x, 0, zc + hgt)]
        secs.append(nk.mirror_y(sec))
    fus = loft(secs, J['col'], name='fus')
    parts = [fus]
    # canopy
    parts.append(cyl((L * 0.18, 0, zc + 0.035), 0.022, 0.12, GLASS, 'X', 10, 'glass', r2=0.012, cell=1.0))
    # radome
    parts.append(cyl((L / 2 - 0.02, 0, zc), 0.014, 0.05, J['dark'], 'X', 8, r2=0.002, cell=1.0))
    # inner wings (trapezoid), fold hinge at the inner panels' tips
    hy = S / 2 * J['fold']
    wing_in = prism([(-0.16, 0.04), (-0.02, 0.04), (0.06, 0.06), (-0.04, hy), (-0.17, hy)], zc - 0.004, zc + 0.006, J['col'], cell=0.0, name='win')
    wing_in2 = prism([(-0.16, -0.04), (-0.17, -hy), (-0.04, -hy), (0.06, -0.06), (-0.02, -0.04)], zc - 0.004, zc + 0.006, J['col'], cell=0.0, name='win2')
    parts += [wing_in, wing_in2]
    # tails: twin canted fins with a team band, and the stabilators
    for sy in (1, -1):
        f = prism([(-L / 2 + 0.02, 0.0), (-L / 2 + 0.13, 0.0), (-L / 2 + 0.09, 0.012), (-L / 2 + 0.03, 0.012)], 0, 0.1, J['col'], cell=0.0, name='fin')
        f.data.transform(Matrix.Translation((0, sy * 0.04, zc + 0.02)) @ Matrix.Rotation(-sy * J['tails'], 4, 'X'))
        parts.append(f)
        band = box(-L / 2 + 0.035, -L / 2 + 0.1, -0.002, 0.014, 0.05, 0.075, 0xffffff, 'team', cell=0.0)
        band.data.transform(Matrix.Translation((0, sy * 0.04, zc + 0.02)) @ Matrix.Rotation(-sy * J['tails'], 4, 'X'))
        parts.append(band)
        parts.append(prism([(-L / 2 + 0.01, sy * 0.04), (-L / 2 + 0.09, sy * 0.04), (-L / 2 + 0.03, sy * 0.13), (-L / 2 - 0.01, sy * 0.13)][:: (1 if sy > 0 else -1)], zc - 0.003, zc + 0.003, J['col'], cell=0.0, name='stab'))
        # intakes and nozzles
        parts.append(box(-0.02, 0.1, sy * 0.045 - 0.018, sy * 0.045 + 0.018, zc - 0.03, zc + 0.005, J['dark'], cell=0.0))
        parts.append(cyl((-L / 2 - 0.005, sy * 0.022, zc - 0.002), 0.017, 0.04, 0x3a3a3a, 'X', 10, r2=0.014, cell=1.0))
        if J['canard']:
            parts.append(prism([(0.1, sy * 0.05), (0.15, sy * 0.05), (0.11, sy * 0.11), (0.08, sy * 0.11)][:: (1 if sy > 0 else -1)], zc + 0.002, zc + 0.007, J['col'], cell=0.0, name='can'))
    # outer wing panels (fold up about the hinge line at y = +-hy)
    fold_l = [prism([(-0.17, hy), (-0.04, hy), (-0.1, S / 2), (-0.16, S / 2)], zc - 0.003, zc + 0.004, J['col'], cell=0.0, name='fl')]
    fold_r = [prism([(-0.17, -hy), (-0.16, -S / 2), (-0.1, -S / 2), (-0.04, -hy)], zc - 0.003, zc + 0.004, J['col'], cell=0.0, name='fr')]
    # gear: nose wheel and the two mains
    gear = [cyl((0.18, 0, 0.012), 0.012, 0.01, 0x1a1a1a, 'Y', 8, cell=1.0), bar((0.18, 0, 0.012), (0.18, 0, zc - 0.03), 0.004, 0x9a9a9a)]
    for sy in (1, -1):
        gear += [cyl((-0.06, sy * 0.06, 0.014), 0.014, 0.012, 0x1a1a1a, 'Y', 8, cell=1.0), bar((-0.06, sy * 0.06, 0.014), (-0.06, sy * 0.05, zc - 0.03), 0.004, 0x9a9a9a)]
    root = bpy.data.objects.new(key, None)
    bpy.context.scene.collection.objects.link(root)
    groups = [('_body', parts, (0, 0, 0), 1100, 320), ('_foldL', fold_l, (-0.1, hy, zc), 40, 16), ('_foldR', fold_r, (-0.1, -hy, zc), 40, 16), ('_gear', gear, (0, 0, 0), 120, 30)]
    nk.PARTS.clear()
    src = nk.assemble(key + '_src', [o for g in groups for o in g[1]])
    nk.bake_ao(src, ground=0.0, samples=16)
    tris = 0
    for name, ob, pivot, g0, g1 in nk.split_parts(src, groups):
        lo = nk.decimated(ob, g0, f'{key}{name}_lo')
        lo1 = nk.decimated(ob, g1, f'{key}{name}_l1')
        bpy.data.objects.remove(ob)
        lo.name = f'{key}{name}'
        lo.data.name = lo.name
        for o in (lo, lo1):
            o.data.transform(Matrix.Translation(-Vector(pivot)))
            o.location = pivot
            o.parent = root
            nk.smooth(o)
        tris += nk.ntris(lo)
        objs += [lo, lo1]
    objs.append(root)
    info[key] = {'tris': tris, 'len': L, 'span': S, 'fold': J['fold'], 'h': zc + 0.12}
    return root


# ------------------------------------------------------------------ main

def build_kit():
    nk.reset()
    w = bpy.data.worlds.new('w')
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (1, 1, 1, 1)
    bpy.context.scene.world = w
    info = {}
    jpath = os.path.join(OUT, 'naval.json')
    base = json.load(open(jpath)) if os.path.exists(jpath) else {}
    for nation in NATIONS:
        objs = []
        t = time.time()
        build_carrier(nation, info, objs)
        build_jet(nation, info, objs)
        print(f'[carrier] cv_{nation} {info[f"cv_{nation}"]["tris"]} tris, jet {info[f"cv_{nation}_jet"]["tris"]} tris ({time.time() - t:.0f} s)', flush=True)
        for o in objs:
            if o.type == 'MESH' and 'Col' in o.data.color_attributes:
                ca = o.data.color_attributes
                ca.active_color = ca['Col']
                ca.render_color_index = ca.active_color_index
        bpy.ops.object.select_all(action='DESELECT')
        for o in objs:
            o.select_set(True)
        bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, f'naval-cv{nation}-raw.glb'), export_format='GLB', use_selection=True, export_apply=True, export_yup=True, export_normals=True, export_texcoords=False, export_materials='EXPORT', export_vertex_color='ACTIVE', export_all_vertex_colors=False, export_image_format='NONE')
    base.update(info)
    with open(jpath, 'w') as f:
        json.dump(base, f, indent=1)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'carrier.blend'))
    print('[carrier] OK_DONE', flush=True)


def place_air_wing(nation, at, launch=False):
    """Copies of the nation's jet parked on the carrier's deck pads (wings folded), one on the launch position."""
    src = bpy.data.objects[f'cv_{nation}_jet']
    out = []
    spots = [(px, py, PARK, True) for (px, py) in PADS]
    if launch:
        spots[1] = (LAUNCH[0], LAUNCH[1], 0.0, False)
    for (px, py, hd, folded) in spots:
        r = src.copy()
        bpy.context.scene.collection.objects.link(r)
        for c in src.children:
            cc = c.copy()
            bpy.context.scene.collection.objects.link(cc)
            cc.parent = r
            if folded and c.name.startswith(f'cv_{nation}_jet_fold'):
                cc.rotation_euler = (1.7 if c.name.endswith(('L', 'L_l1')) else -1.7, 0, 0)
        bx_, by_ = B(px, py)
        r.location = (at[0] + bx_, at[1] + by_, at[2] + DECK_Z)
        r.rotation_euler = (0, 0, -hd)
        out.append(r)
    if launch:
        j = bpy.data.objects.get(f'cv_{nation}_jbd')
        if j is not None:
            # (raised: its aft edge up, about the hinge at its fore edge)
            j.rotation_euler = (0, 0.9, 0)
    return out


def sheet():
    bpy.ops.wm.open_mainfile(filepath=os.path.join(OUT, 'carrier.blend'))
    nk.preview_setup()
    keep = set()
    for i, nation in enumerate(NATIONS):
        root = bpy.data.objects[f'cv_{nation}']
        root.location = (0, (1 - i) * 2.4, 0)
        keep.add(root.name)
        for r in place_air_wing(nation, root.location, launch=True):
            keep.add(r.name)
        bpy.data.objects[f'cv_{nation}_jet'].location = (4.0, (1 - i) * 2.4, 0.0)
        keep.add(f'cv_{nation}_jet')
    for o in bpy.data.objects:
        if o.type in ('MESH', 'EMPTY'):
            top = o
            while top.parent is not None:
                top = top.parent
            o.hide_render = top.name not in keep or o.name.endswith('_l1')
    nk.sea_and_shore(80, shore=None)
    nk.camera_sun((8.5, -8.0, 7.0), (0.8, 0.0, 0.2), 34, (2000, 1200), 48, os.path.join(OUT, 'carrier-sheet.png'))
    print('[carrier] sheet', flush=True)


def cameos():
    bpy.ops.wm.open_mainfile(filepath=os.path.join(OUT, 'carrier.blend'))
    nk.preview_setup()
    nk.sea_and_shore(80, shore=None)
    roots = [o for o in bpy.data.objects if o.type == 'EMPTY' and o.parent is None and o.name.startswith('cv_')]
    for r in roots:
        for o in bpy.data.objects:
            if o.type in ('MESH', 'EMPTY') and not o.name.startswith(('sea', 'Plane')):
                top = o
                while top.parent is not None:
                    top = top.parent
                o.hide_render = top.name != r.name or o.name.endswith('_l1')
        r.location = (0, 0, 0)
        nation = r.name.split('_')[1]
        if r.name.endswith('_jet'):
            key = f'{nation}_cvjet'
            r.location = (0, 0, 0.06)
            nk.camera_sun((0.75, -0.62, 0.42), (0.0, 0.0, 0.08), 40, (576, 432), 40, os.path.join(OUT, f'cameo-{key}.png'))
        else:
            key = f'{nation}_carrier'
            nk.camera_sun((5.2, -4.4, 3.0), (0.2, 0.0, 0.2), 40, (576, 432), 40, os.path.join(OUT, f'cameo-{key}.png'))
        print(f'[carrier] cameo {key}', flush=True)


if __name__ == '__main__':
    if STEP in ('kit', 'all'):
        build_kit()
    if STEP in ('sheet', 'all'):
        sheet()
    if STEP in ('cameos', 'all'):
        cameos()
