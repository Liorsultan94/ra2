import sys, re, glob, collections
# win rate per opening plan (first plan of the log) over bench rows; usage: plans.py <tag>...
import os
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results') + '/'
W = collections.Counter(); G = collections.Counter(); M = collections.Counter()
for tag in sys.argv[1:]:
    for f in glob.glob(D + tag + '-*.txt'):
        for line in open(f):
            m = re.search(r'win=slot(\d)', line)
            ps = re.sub(r'.*wall=\d+s ', '', line).strip().split(' | ')
            p = [x.split('/')[0].split('>')[0] for x in ps]
            if len(p) != 2: continue
            for k in (0, 1):
                G[p[k]] += 1
                if m and int(m.group(1)) == k: W[p[k]] += 1
            if m and p[0] != p[1]:
                win = p[int(m.group(1))]; lose = p[1 - int(m.group(1))]
                M[(win, lose)] += 1
for k in sorted(G, key=lambda k: -W[k] / G[k]):
    print(f'{k:9} games={G[k]:3} wins={W[k]:3} ({W[k]/G[k]:.0%})')
print('boom vs others:', {o: f"{M[('boom', o)]}-{M[(o, 'boom')]}" for o in G if o != 'boom'})
