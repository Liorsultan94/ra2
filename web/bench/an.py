import sys, re, glob, collections
# usage: an.py <tag> [-v]
import os
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results') + '/'
tag = sys.argv[1]
verbose = '-v' in sys.argv
rows = []
for f in sorted(glob.glob(D + tag + '-*.txt')):
    for line in open(f):
        t = line.split()
        if t[1] in ('A', 'B'):
            ori = t.pop(1)
        else:
            ori = '-'
        mp, grace, seed, pair, end, ln = t[0], t[1], t[2], t[3], t[4], float(t[5][:-3])
        win = re.search(r'win=(\S+)', line).group(1)
        lead = int(re.search(r'lead=(-?\d)', line).group(1))
        plans = line.split('s ', 1)[1].strip() if 'wall=' in line else ''
        plans = re.sub(r'.*wall=\d+s ', '', line).strip()
        p = [x.split('/')[0] for x in plans.split(' | ')]
        rows.append(dict(map=mp, grace=grace, seed=seed, pair=pair, end=end, len=ln, win=win, lead=lead, plans=p, ori=ori))
for mp in ['frontline', 'desert', 'winter', 'urban']:
    for grace in ['graceON', 'graceOFF']:
        R = [r for r in rows if r['map'] == mp and r['grace'] == grace]
        if not R: continue
        w0 = sum(1 for r in R if r['win'].startswith('slot0'))
        w1 = sum(1 for r in R if r['win'].startswith('slot1'))
        cap = [r for r in R if r['end'] == 'CAP']
        l0 = sum(1 for r in cap if r['lead'] == 0); l1 = sum(1 for r in cap if r['lead'] == 1)
        ln = sum(r['len'] for r in R if r['end'] == 'END') / max(1, w0 + w1)
        print(f"{mp:9} {grace:8} n={len(R):2} slot0={w0:2} slot1={w1:2} capped={len(cap)} (lead {l0}/{l1})  slot0 share incl. leads={(w0+l0)/max(1,w0+w1+l0+l1):.0%}  avg len {ln:.1f}min")
        if verbose:
            for r in R:
                print(f"    {r['ori']} {r['seed']} {r['pair']:14} {r['end']} {r['len']:5.1f} {r['win']:16} lead={r['lead']} {' vs '.join(r['plans'])}")
# by nation: for swapped pairs, does nation win in both orientations?
