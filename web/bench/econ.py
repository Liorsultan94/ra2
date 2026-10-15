import sys, re, glob
# paired economy: same AI personality in slot 0 vs slot 1 (FULL-swap rows A/B); usage: econ.py <tag> [minute]
import os
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results') + '/'
tag = sys.argv[1]
mn = sys.argv[2] if len(sys.argv) > 2 else '12'
for f in sorted(glob.glob(D + tag + '-*.txt')):
    rows = {}
    for line in open(f):
        t = line.split()
        m = re.search(mn + r'm:h(\d+)/(\d+)', line)
        if not m: continue
        rows[(t[1], t[3], t[4], t[2])] = (int(m.group(1)), int(m.group(2)))
    d0 = []; s0 = s1 = 0
    for (o, seed, pair, g), (h0, h1) in rows.items():
        if o != 'A': continue
        a, b = pair.split('-')
        bk = ('B', seed, f'{b}-{a}', g)
        if bk not in rows: continue
        H0, H1 = rows[bk]
        # personality P (slot0 in A) earned h0 in slot0 and H1 in slot1 (B); Q earned h1 in slot1 and H0 in slot0
        d0 += [h0 - H1, H0 - h1]
        s0 += h0 + H0; s1 += H1 + h1
    if d0:
        print(f"{f.split('/')[-1]:28} pairs={len(d0)} slot0-slot1 mean={sum(d0)/len(d0):+.0f} ({(s0-s1)/s1*100:+.1f}%)  slot0 better in {sum(1 for x in d0 if x>0)}/{len(d0)}")
