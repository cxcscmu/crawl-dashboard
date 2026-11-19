"""Per-cycle metrics for crawls whose W&B runs log only wall/ (259887, 265639, 269821), from our own read of the crawl.

    ~/crawl-data/py/bin/python extra.py crawl-259887 259887 crawl-265639 265639 crawl-269821 269821

Inputs under ~/crawl-data (written on the cluster by run_cdx.sbatch, run_text.sbatch and run_crawl.sbatch):
    v2cdx/<prefix>-c<N>.json, .domains.tsv.gz   every CDX record: HTTP status counts, HTTP 200s per registered domain
    v2text/<prefix>-c<N>.json                   SegmentScoreStats on every 10th parse_data/parse_text part: languages,
                                                parse failures, page length, fastText / FineWeb-Edu / combined scores
    v2/<prefix>-c<N>/counts.tsv                 Extract: priority vs page score correlation over the fetched pages
The keys and their meaning are Jerry's (crawl_logger.py at the commit in extract-src): the same functions turn these
inputs into the same W&B keys, so the page's charts read them unchanged. Counts from the text sample are scaled by
parts_total / parts; means, shares and quantiles are the sample's own.

Output: site/data/raw/extra-<run id>.js. The page loads it after the W&B data and fills in only keys W&B lacks.
"""
import collections
import glob
import gzip
import json
import os
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HOME = os.path.expanduser("~/crawl-data")
sys.path.insert(0, HOME + "/extract-src")
import crawl_logger as cl  # noqa: E402

OUT = Path(__file__).resolve().parent / "site" / "data" / "raw"
TABLE_KEYS = {"domains/top_domains", "domains/top_domains_cumulative", "domains/top_new_domains", "text/languages",
              "text/languages_cumulative", "fetch/top_failing_domains", "text/top_domains_by_pages", "text/top_domains_by_fineweb_edu"}


def cycles(pattern):
    return sorted(int(re.search(r"-c(\d+)", f).group(1)) for f in glob.glob(pattern))


def counts(path):
    out = {}
    if os.path.exists(path):
        for line in open(path):
            k, v = line.split("\t")
            out[k] = int(v)
    return out


def scaled(s):
    """SegmentScoreStats read every 10th part: scale its page counts to the whole cycle."""
    f = s["parts_total"] / s["parts"]
    s = json.loads(json.dumps(s))
    for k in ("pages", "scored_english_pages", "interstitial_pages", "parse_failed_pages"):
        if s.get(k) is not None:
            s[k] = round(s[k] * f)
    for k in ("languages", "languages_sampled"):
        s[k] = {lang: round(v * f) for lang, v in (s.get(k) or {}).items()}
    for x in (s.get("scores") or {}).values():
        x["n"] = round(x["n"] * f)
        x["hist1000"] = [round(v * f) for v in x["hist1000"]]
    for x in (s.get("exact") or {}).values():
        for k in ("n", "keep"):
            if x.get(k) is not None:
                x[k] = round(x[k] * f)
    t = s.get("text")
    if t:
        for k in ("pages", "near_empty", "empty"):
            t[k] = round(t[k] * f)
    return s


def domain_metrics(doms, hosts, st, cycle):
    """cl.cdx_metrics' domains/ keys, from the HTTP 200s per registered domain (hosts_total needs host lists: left out)."""
    cum = st["domains"]
    new = {d: c for d, c in doms.items() if d not in cum}
    for d, c in doms.items():
        cum[d] = cum.get(d, 0) + c
    tot = sum(doms.values())
    cumc = collections.Counter(cum)
    m = {"domains/hosts": hosts, "domains/domains": len(doms), "domains/new_domains": len(new),
         "domains/pages_on_new_domains_pct": cl.pct(sum(new.values()), tot), "domains/domains_total": len(cum)}
    m.update(cl.concentration(doms, "domains/"))
    m.update(cl.concentration(cumc, "domains/", "_cumulative"))
    cols = ("domain", "pages", "share %")
    m["domains/top_domains"] = cl.table(cols, [(d, c, round(cl.pct(c, tot), 3)) for d, c in doms.most_common(50)])
    m["domains/top_new_domains"] = cl.table(cols, [(d, c, round(cl.pct(c, tot), 3)) for d, c in collections.Counter(new).most_common(50)])
    ctot = sum(cumc.values())
    m["domains/top_domains_cumulative"] = cl.table(cols, [(d, c, round(cl.pct(c, ctot), 3)) for d, c in cumc.most_common(50)])
    return m


def domain_tables(path):
    """text/top_domains_by_pages and _by_fineweb_edu, as crawl_logger.text_metrics makes them, from the extract's per-domain
    table (every parsed page of the cycle, domains with 3+ pages): English scored pages and their mean scores. Exact counts,
    not the text sample's: a ranking by an estimated count would just pick the domains whose sample came out high."""
    if not os.path.exists(path):
        return {}
    d = pd.read_csv(path, sep="\t", keep_default_na=False, na_values=[""], usecols=["domain", "scored", "edu_mean", "dclm_mean", "score_mean"], dtype={"domain": str})
    d = d[d.scored > 0]
    if not len(d):
        return {}
    cols = ("domain", "English scored pages", "FineWeb-Edu mean", "fastText quality mean", "combined mean")
    row = lambda x: (x.domain, int(x.scored), round(float(x.edu_mean), 4), round(float(x.dclm_mean), 4), round(float(x.score_mean), 4))
    by_pages = d.sort_values("scored", ascending=False).head(50)
    by_edu = d[d.scored >= 20].sort_values("edu_mean", ascending=False).head(50)  # Jerry's cut: 20+ English pages
    return {"text/top_domains_by_pages": cl.table(cols, [row(x) for x in by_pages.itertuples()]),
            "text/top_domains_by_fineweb_edu": cl.table(cols, [row(x) for x in by_edu.itertuples()])}


def build(run_id, prefix):
    cs = sorted(set(cycles(f"{HOME}/v2cdx/{prefix}-c*.json")) | set(cycles(f"{HOME}/v2text/{prefix}-c*.json")))
    if cs != list(range(1, len(cs) + 1)):
        raise SystemExit(f"{prefix}: cycles {cs} are not 1..N; cumulative keys need every cycle")
    st = {"json": {}, "domains": {}}
    rows = {}
    for c in cs:
        m = {}
        p = f"{HOME}/v2cdx/{prefix}-c{c}.json"
        if os.path.exists(p):
            d = json.load(open(p))
            # every registered domain's HTTP 200s and error responses (403, 429, 404, 410, other 4xx, 5xx) in the WARC index
            doms, fail = collections.Counter(), collections.Counter()
            with gzip.open(f"{HOME}/v2cdx/{prefix}-c{c}.domains.tsv.gz", "rt") as fh:
                head = next(fh).rstrip("\n").split("\t")
                cls = {i: h.removeprefix("http_") for i, h in enumerate(head) if h.startswith("http_")}
                for line in fh:
                    f = line.rstrip("\n").split("\t")
                    if int(f[1]) > 0:
                        doms[f[0]] += int(f[1])
                    for i, k in cls.items():
                        if int(f[i]):
                            fail[f[0], k] += int(f[i])
            fm = cl.fetch_metrics({}, collections.Counter(d["status"]), fail, st)
            for k, v in d["metrics"].items():  # the HTTP job counted the same domains itself: they must agree
                if k.startswith("fetch/domains_with_http_") and fm.get(k) != v:
                    raise SystemExit(f"{prefix} c{c}: {k} is {fm.get(k)} from the domain file but {v} from the HTTP job")
            m.update(fm)
            m.update(domain_metrics(doms, d["hosts_with_200"], st, c))
        p = f"{HOME}/v2text/{prefix}-c{c}.json"
        if os.path.exists(p):
            s = json.load(open(p))
            m.update(cl.text_metrics(scaled(s), Path("/nonexistent"), st, None))
            m.update(domain_tables(f"{HOME}/v2/{prefix}-c{c}/domains.tsv.gz"))
        k = counts(f"{HOME}/v2/{prefix}-c{c}/counts.tsv")
        if k.get("pairs") and k.get("parse_scored"):
            m["frontier/priority_vs_page_score_spearman"] = k["x_spearman_prio_score_e6"] / 1e6
            m["frontier/priority_vs_page_score_pearson"] = k["x_pearson_prio_score_e6"] / 1e6
        rows[c] = m

    # a 1-in-10 sample sees fewer rare languages, so the count of languages detected would read low
    keys = sorted({k for m in rows.values() for k in m} - {"text/languages_detected"})
    metrics, histograms, tables = {}, {}, collections.defaultdict(dict)
    for key in keys:
        vals = [rows[c].get(key) for c in cs]
        sample = next((v for v in vals if v is not None), None)
        if sample is None:
            continue
        if isinstance(sample, dict):
            if key in TABLE_KEYS:
                for c, v in zip(cs, vals):
                    if v:
                        tables[key][str(c)] = v
        elif isinstance(sample, list):
            histograms[key] = [{"min": 0, "size": 1 / len(v), "values": v} if v else None for v in vals]
        else:
            nums = [None if v is None or (isinstance(v, float) and not np.isfinite(v)) else
                    (round(float(v), 6) if isinstance(v, (float, np.floating)) else int(v)) for v in vals]
            if any(n is not None for n in nums):
                metrics[key] = nums
    sample = {(json.load(open(f))["parts"], json.load(open(f))["parts_total"]) for f in glob.glob(f"{HOME}/v2text/{prefix}-c*.json")}
    payload = {"cycles": cs, "metrics": metrics, "histograms": histograms, "tables": tables,
               "text_sample": {"parts": min(sample)[0], "parts_total": min(sample)[1], "same_every_cycle": len(sample) == 1} if sample else None,
               "source": "Read from the crawl's WARC index and segments (every 10th part for the text keys), not logged by the run"}
    OUT.mkdir(parents=True, exist_ok=True)
    out = OUT / f"extra-{run_id}.js"
    out.write_text(f"window.CRAWL_EXTRA=window.CRAWL_EXTRA||{{}};window.CRAWL_EXTRA[{json.dumps(run_id)}]="
                   + json.dumps(payload, separators=(",", ":"), allow_nan=False) + ";\n")
    print(f"{run_id}: cycles {cs[0]}-{cs[-1]}, {len(metrics)} metrics, {len(histograms)} histograms, "
          f"{sum(len(t) for t in tables.values())} tables -> {out} ({out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a or len(a) % 2:
        raise SystemExit(__doc__)
    for i in range(0, len(a), 2):
        build(a[i], a[i + 1])
