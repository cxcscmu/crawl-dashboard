"""The n-gram half of the Gopher repetition rule, for the pages junk.py stopped at a duplicate-line check (it records
only the first check a page fails). Writes analysis/junk/ngram.pkl: url, run, cycle, ngram_check ("" = passes)."""
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

HOME = junk.HOME
SHARDS = 4


def ngram_check(text):
    words = junk.uni_words(text)
    total = sum(len(w) for w in words)
    for n, thr in ((2, 0.2), (3, 0.18), (4, 0.16), (5, 0.15), (6, 0.14), (7, 0.13), (8, 0.12), (9, 0.11), (10, 0.10)):
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
        if frac > thr:
            return ("top_%dgram" if n <= 4 else "rep_%dgram") % n
    return ""


def task(args):
    path, shard, todo = args
    run, c = re.search(r"(\d+)-c(\d+)\.jsonl", path).groups()
    out = []
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        for line in fh:
            p = json.loads(line)
            u = p["url"]
            if zlib.crc32(u.encode()) % SHARDS != shard or u not in todo:
                continue
            out.append((u, run, int(c), ngram_check(p.get("text") or "")))
    return out


def main():
    df = pd.read_pickle(junk.OUT + "/pages.pkl")
    need = df[df.repetition_check.str.startswith("dup_")]
    tasks = []
    for path in sorted(glob.glob(HOME + "/v2sample/*.jsonl.gz")):
        run, c = re.search(r"(\d+)-c(\d+)\.jsonl", path).groups()
        todo = set(need[(need.run == run) & (need.cycle == int(c))].url)
        tasks += [(path, s, todo) for s in range(SHARDS)]
    with Pool(os.cpu_count() or 4) as pool:
        rows = [r for part in pool.imap_unordered(task, tasks) for r in part]
    out = pd.DataFrame(rows, columns=["url", "run", "cycle", "ngram_check"])
    out.to_pickle(junk.OUT + "/ngram.pkl")
    print(len(need), "pages needed,", len(out), "checked,", (out.ngram_check != "").mean() * 100, "% fail the n-gram checks")


if __name__ == "__main__":
    main()
