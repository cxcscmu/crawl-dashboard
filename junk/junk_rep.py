"""How much n-gram repetition each sampled page has, on its whole text and on its prose lines only.

For each scored English page: rep_full / rep_prose = the largest (repeated fraction / DCLM threshold) over Gopher's
2- to 10-gram checks, so a page fails DCLM's check when the value is over 1, fails a 1.5x looser threshold when it is
over 1.5, and so on. "Prose" keeps only lines with 6+ words, which drops menus, buttons and other short page furniture.
Writes analysis/junk/rep.pkl: url, run, cycle, rep_full, rep_prose, prose_words."""
import glob
import gzip
import json
import os
import re
import zlib
from collections import Counter
from multiprocessing import Pool

import pandas as pd

import junk

SHARDS = 4
CHECKS = ((2, 0.2), (3, 0.18), (4, 0.16), (5, 0.15), (6, 0.14), (7, 0.13), (8, 0.12), (9, 0.11), (10, 0.10))


def rep_ratio(text):
    """max over n of (repeated fraction / threshold), as DCLM's repetition_filter computes each fraction."""
    words = junk.uni_words(text)
    total = sum(len(w) for w in words)
    if not total:
        return 0.0
    best = 0.0
    for n, thr in CHECKS:
        grams = list(zip(*[words[i:] for i in range(n)]))
        if not grams:
            continue
        cnt = Counter(grams)
        ordered = cnt.most_common()
        top, topc = ordered[0]
        if topc == 1:
            continue
        if n <= 4:
            L = sum(len(w) for w in top)
            for g, c in ordered:
                if c != topc:
                    break
                L = max(L, sum(len(w) for w in g))
            frac = L * topc / total
        else:
            idx = set()
            for i, g in enumerate(grams):
                if cnt[g] > 1:
                    idx.update(range(i, i + n))
            frac = sum(len(words[i]) for i in idx) / total
        best = max(best, frac / thr)
    return best


def task(args):
    path, shard = args
    run, c = re.search(r"(\d+)-c(\d+)\.jsonl", path).groups()
    out = []
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        for line in fh:
            p = json.loads(line)
            if zlib.crc32(p["url"].encode()) % SHARDS != shard or not p.get("scored") or p.get("lang") != "en":
                continue
            t = p.get("text") or ""
            prose = "\n".join(l for l in t.split("\n") if len(l.split()) >= 6)
            out.append((p["url"], run, int(c), rep_ratio(t), rep_ratio(prose), len(junk.ft_words(prose))))
    return out


def main():
    tasks = [(p, s) for p in sorted(glob.glob(junk.HOME + "/v2sample/*.jsonl.gz")) for s in range(SHARDS)]
    tasks.sort(key=lambda t: -os.path.getsize(t[0]))  # biggest files first, so no core is left with one at the end
    with Pool(os.cpu_count() or 4) as pool:
        rows = [r for part in pool.imap_unordered(task, tasks) for r in part]
    df = pd.DataFrame(rows, columns=["url", "run", "cycle", "rep_full", "rep_prose", "prose_words"])
    df.to_pickle(junk.OUT + "/rep.pkl")
    print(len(df), "pages; fail DCLM n-gram check on full text %.1f%%, on prose %.1f%%" % (100 * (df.rep_full > 1).mean(), 100 * (df.rep_prose > 1).mean()))


if __name__ == "__main__":
    main()
