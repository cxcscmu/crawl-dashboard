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

Output: site/data/raw/extra-<run id>.js. The page loads it after the W&B data and adds the keys W&B lacks. Keys W&B
has stay W&B's, except under --override prefixes (ours in every cycle, e.g. the CC-style crawl's domain keys, which W&B
counts from the WARC index alone) and --fill prefixes (ours only in the cycles W&B has no value for).
    replay/<prefix>-c<N>.json, .tsv.gz          replay_counts.py: pages per domain replayed from the fetch cache
--text-from P takes the text keys from v2text/<P>-c<N>.json instead of <prefix>'s, e.g. P = 259887all, the same job run
on every part (PARTS_EVERY=1): exact counts, nothing scaled. The page's note says which parts were read.
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

HOME = os.environ.get("CRAWL_DATA") or os.path.expanduser("~/crawl-data")   # CRAWL_DATA: run elsewhere (Boston)
sys.path.insert(0, HOME + "/extract-src")
import crawl_logger as cl  # noqa: E402

OUT = Path(__file__).resolve().parent / "site" / "data" / "raw"
TABLE_KEYS = {"domains/score_by_rank", "domains/top_domains", "domains/top_domains_cumulative", "domains/top_new_domains", "text/languages",
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
    d = pd.read_csv(path, sep="\t", keep_default_na=False, na_values=[""], usecols=["domain", "scored", "edu_mean", "dclm_mean", "score_mean"], dtype={"domain": str}, quoting=3)  # quoting=3: a domain field can hold a " (Extract writes it as is)
    d = d[d.scored > 0]
    if not len(d):
        return {}
    cols = ("domain", "English scored pages", "FineWeb-Edu mean", "fastText quality mean", "combined mean")
    row = lambda x: (x.domain, int(x.scored), round(float(x.edu_mean), 4), round(float(x.dclm_mean), 4), round(float(x.score_mean), 4))
    by_pages = d.sort_values("scored", ascending=False).head(50)
    by_edu = d[d.scored >= 20].sort_values("edu_mean", ascending=False).head(50)  # Jerry's cut: 20+ English pages
    return {"text/top_domains_by_pages": cl.table(cols, [row(x) for x in by_pages.itertuples()]),
            "text/top_domains_by_fineweb_edu": cl.table(cols, [row(x) for x in by_edu.itertuples()])}


RANKS = [("top10", "Top 10", 1, 10), ("11_100", "11–100", 11, 100), ("101_1k", "101–1,000", 101, 1000),
         ("1k_10k", "1,001–10,000", 1001, 10000), ("rest", "10,001 and below", 10001, 10**12)]


def rank_buckets(doms, ext_path):
    """Domains grouped by rank (most pages first; doms = the cycle's pages per registered domain, as the domain keys
    count them): each group's share of the cycle's pages, and the mean page score / FineWeb-Edu / fastText of its
    English pages, weighted by scored pages. Scores come from the extract's per-domain table (every parsed page, domains
    with 3+ pages), so domains with 1-2 pages add pages but no score. Ties in pages are ranked by domain name."""
    if not doms or not os.path.exists(ext_path):
        return {}
    c = pd.DataFrame({"domain": [d if d else np.nan for d in doms], "pages_200": list(doms.values())})
    c = c[c.pages_200 > 0].sort_values(["pages_200", "domain"], ascending=[False, True], kind="mergesort").reset_index(drop=True)
    c["rank"] = np.arange(1, len(c) + 1)
    e = pd.read_csv(ext_path, sep="\t", keep_default_na=False, na_values=[""], usecols=["domain", "scored", "score_mean", "dclm_mean", "edu_mean"], dtype={"domain": str}, quoting=3)
    c = c.merge(e, on="domain", how="left")
    tot = c.pages_200.sum()
    m, rows = {}, []
    for key, label, lo, hi in RANKS:
        b = c[(c["rank"] >= lo) & (c["rank"] <= hi)]
        sc = b[b.scored.fillna(0) > 0]
        w = sc.scored
        mean = lambda col: round(float((sc[col] * w).sum() / w.sum()), 4) if len(sc) else None
        share = round(100 * float(b.pages_200.sum()) / tot, 3) if tot else None
        m[f"domains/rank_{key}_pages_pct"] = share
        m[f"domains/rank_{key}_score_mean"] = mean("score_mean")
        rows.append((label, int(len(b)), share, mean("score_mean"), mean("edu_mean"), mean("dclm_mean"), int(w.sum()) if len(sc) else 0))
    m["domains/score_by_rank"] = cl.table(("domains ranked by pages", "domains", "% of pages", "page score mean", "FineWeb-Edu mean",
                                           "fastText quality mean", "English scored pages"), rows)
    return m


def replays(prefix, c):
    """Pages of the cycle that the crawl got from the fetch cache (parse records without a WARC record), per registered
    domain, from replay_counts.py: (Counter, totals) or (None, None) when the cycle wasn't counted."""
    p = f"{HOME}/replay/{prefix}-c{c}"
    if not os.path.exists(p + ".json"):
        return None, None
    rep = collections.Counter()
    with gzip.open(p + ".tsv.gz", "rt") as fh:
        next(fh)
        for line in fh:
            f = line.rstrip("\n").split("\t")
            if int(f[1]):
                rep[f[0]] = int(f[1])
    return rep, json.load(open(p + ".json"))


# Jerry's pretraining pipeline, per cycle (pie_counts.py): every page with text -> English -> DCLM rules (a page counts
# under the first rule it fails) -> BFF dedup -> fastText >= 0.018112. Slices are % of the cycle's pages with text.
PIPELINE_GROUPS = ["not_english", "junk_length", "junk_repetition", "junk_line_cleanup", "junk_other", "duplicate",
                   "below_fasttext", "kept"]
JUNK_GROUPS = ["junk_length", "junk_repetition", "junk_line_cleanup", "junk_other"]


def wandb_export(run_id):
    """The run's W&B export (site/data/<run>.js) as a dict, or None."""
    p = OUT.parent / f"{run_id}.js"
    if not p.exists():
        return None
    s = p.read_text()
    return json.loads(s[s.index("= {") + 2:s.rindex("}") + 1])


def wandb_cycles(run_id):
    """Cycles the run's W&B export has, or None."""
    w = wandb_export(run_id)
    return w.get("cycles") if w else None


def wandb_pages(run_id):
    """{cycle: pages the crawl logged for it (wall/pages)} from the W&B export, empty when it has none."""
    w = wandb_export(run_id) or {}
    vals = (w.get("metrics") or {}).get("wall/pages") or []
    return {c: v for c, v in zip(w.get("cycles") or [], vals) if v}


def pipeline_rows(run_id, max_cycle=None):
    path = f"{HOME}/pie/{run_id}.json"
    if not os.path.exists(path):
        return {}
    r = json.load(open(path))
    rows, cum, cum_docs, cum_en = {}, collections.Counter(), 0, 0
    need = ("docs", "english", "rules_in", "after_rules", "after_dedup", "kept")
    # A cycle Jerry's runs hold only a sliver of (CC-style 95 and 122: the last cycle of a text run, a few dozen of
    # ~350 shards, mostly English) would read as a spike: its per-cycle keys stay empty, its pages still count in
    # the cumulative ones. Partial = under a quarter of the pages the crawl logged for the cycle (wall/pages); without
    # that, under a quarter of the run's median (a crawl's small first cycles are real, so the logged count is better).
    logged = wandb_pages(run_id)
    sizes = sorted(v["docs"] for v in r["cycles"].values() if "docs" in v)
    median = sizes[len(sizes) // 2] if sizes else 0
    partial = []
    for c in sorted(int(x) for x in r["cycles"]):
        v = r["cycles"][str(c)]
        if (max_cycle and c > max_cycle) or not all(k in v for k in need):
            continue
        rem = v.get("removed", {})
        g = {"not_english": v["docs"] - v["english"],
             "junk_length": rem.get("page_length_filter", 0),
             "junk_repetition": rem.get("massive_web_repetition_filters", 0),
             "junk_line_cleanup": rem.get("word_removal_ratio_filter", 0) + sum(x for k, x in rem.items() if k.endswith("_modifier")),
             "duplicate": v["after_rules"] - v["after_dedup"], "below_fasttext": v["after_dedup"] - v["kept"], "kept": v["kept"]}
        g["junk_other"] = (v["rules_in"] - v["after_rules"]) - g["junk_length"] - g["junk_repetition"] - g["junk_line_cleanup"]
        g["not_english"] += v["english"] - v["rules_in"]   # English pages the rules step never saw (0 when complete)
        cum.update(g)
        cum_docs += v["docs"]
        cum_en += v["rules_in"]
        m = {"pipeline/docs": v["docs"], "pipeline/docs_cumulative": cum_docs}
        for k in PIPELINE_GROUPS:
            m[f"pipeline/{k}_pct"] = cl.pct(g[k], v["docs"])
            m[f"pipeline/{k}_pct_cumulative"] = cl.pct(cum[k], cum_docs)
        junk, cjunk = sum(g[k] for k in JUNK_GROUPS), sum(cum[k] for k in JUNK_GROUPS)
        m.update({"pipeline/junk_pct": cl.pct(junk, v["docs"]), "pipeline/junk_pct_cumulative": cl.pct(cjunk, cum_docs),
                  "pipeline/junk_pct_of_english": cl.pct(junk, v["rules_in"]),
                  "pipeline/junk_pct_of_english_cumulative": cl.pct(cjunk, cum_en)})
        if v["docs"] < (logged.get(c) or median) / 4:
            partial.append(c)
            m = {k: x for k, x in m.items() if k.endswith("_cumulative")}
        rows[c] = m
    return rows, partial


TEXT_SCORE_KEYS = ("text/fasttext_quality", "text/fineweb_edu")   # from a page sample, only the score keys are valid

# Keys that carry state from the cycles before (running totals, "new" = not seen before): once a cycle of their family
# has no input, they are wrong for every later cycle, so they are left out from there on.
FAMILIES = ("fetch/", "domains/", "text/")
STATEFUL = {"domains/domains_total", "domains/new_domains", "domains/pages_on_new_domains_pct", "domains/top_new_domains"}


def stateful(k):
    return k.endswith("_cumulative") or k in STATEFUL


def build(run_id, prefix, only=None, text_prefix=None, text_note=None, override=None, fill=None, override_note=None,
          text_from=None):
    tp = text_from or prefix   # whose v2text files hold the text keys (<prefix>all: the same job on every part)
    cs = []
    if prefix != "-":
        cs = sorted(set(cycles(f"{HOME}/v2cdx/{prefix}-c*.json")) | set(cycles(f"{HOME}/v2text/{tp}-c*.json")))
        if cs != list(range(1, len(cs) + 1)):
            raise SystemExit(f"{prefix}: cycles {cs} are not 1..N; cumulative keys need every cycle")
    st = {"json": {}, "domains": {}}
    rows = {}
    replayed_any = False
    have = {f: set() for f in FAMILIES}   # cycles with input, per key family
    for c in cs:
        m = {}
        p = f"{HOME}/v2cdx/{prefix}-c{c}.json"
        rep, rtot = replays(prefix, c)
        doms = None
        if rtot is not None and not rtot.get("has_cdx", True) and os.path.exists(p):
            raise SystemExit(f"{prefix} c{c}: the extract ran without a WARC index but v2cdx has one; rerun replay_counts")
        if os.path.exists(p):
            have["fetch/"].add(c)
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
            # pages replayed from the fetch cache have no WARC record: add them, so the domain keys count every page
            # the crawl got (the HTTP status keys above stay what the web answered to the requests actually sent)
            hosts = d["hosts_with_200"]
            if rep is not None:
                replayed_any = True
                doms.update(rep)
                hosts = rtot.get("hosts_with_pages") or hosts
                m["cache/replayed"] = rtot["replayed"]
                m["cache/replayed_pct_of_pages"] = cl.pct(rtot["replayed"], rtot["replayed"] + rtot["in_warc_200"])
        elif rep is not None:
            # no WARC index for the cycle (CC-style chain 30-62, 65, 68): the extract had none to check against, so
            # every parsed page counts as "replayed", and that per-domain count is every page the crawl got. The domain
            # keys hold; the HTTP status and replayed-share keys stay empty.
            replayed_any = True
            doms, hosts = rep, rtot["hosts_with_pages"]
        if doms is not None:
            have["domains/"].add(c)
            m.update(domain_metrics(doms, hosts, st, c))
        p = f"{HOME}/v2text/{tp}-c{c}.json"
        if os.path.exists(p):
            have["text/"].add(c)
            s = json.load(open(p))
            m.update(cl.text_metrics(scaled(s), Path("/nonexistent"), st, None))
            m.update(domain_tables(f"{HOME}/v2/{prefix}-c{c}/domains.tsv.gz"))
        m.update(rank_buckets(doms, f"{HOME}/v2/{prefix}-c{c}/domains.tsv.gz"))
        k = counts(f"{HOME}/v2/{prefix}-c{c}/counts.tsv")
        if k.get("pairs") and k.get("parse_scored"):
            m["frontier/priority_vs_page_score_spearman"] = k["x_spearman_prio_score_e6"] / 1e6
            m["frontier/priority_vs_page_score_pearson"] = k["x_pearson_prio_score_e6"] / 1e6
        if only:  # a run that logs the rest to W&B: keep just these keys
            m = {k: v for k, v in m.items() if any(k.startswith(o) for o in only)}
        rows[c] = m

    # after the first cycle a family has no input for, its running totals are wrong: leave them out from there
    gaps = {}
    for fam, got in have.items():
        missing = [c for c in cs if c not in got]
        if got and missing:
            gaps[fam] = missing
            for c in cs:
                if c > missing[0]:
                    rows[c] = {k: v for k, v in rows[c].items() if not (k.startswith(fam) and stateful(k))}
            print(f"{prefix}: no {fam} input for cycles {missing}; running totals of {fam} keys stop at cycle {missing[0] - 1}")

    # a second text source (e.g. the CC-style crawl's rescored 20k-page sample): its score keys only
    if text_prefix:
        ts = sorted(cycles(f"{HOME}/v2text/{text_prefix}-c*.json"))
        if ts != list(range(1, len(ts) + 1)):
            raise SystemExit(f"{text_prefix}: cycles {ts} are not 1..N; cumulative keys need every cycle")
        tst = {"json": {}, "domains": {}}
        for c in ts:
            s = json.load(open(f"{HOME}/v2text/{text_prefix}-c{c}.json"))
            m = cl.text_metrics(s, Path("/nonexistent"), tst, None)
            rows.setdefault(c, {}).update({k: v for k, v in m.items() if k.startswith(TEXT_SCORE_KEYS)})

    # Jerry's pipeline counts, for the cycles the run's W&B export has
    wc = wandb_cycles(run_id)
    prows, partial = pipeline_rows(run_id, max(wc) if wc else None) or ({}, [])
    for c, m in prows.items():
        rows.setdefault(c, {}).update(m)
    cs = sorted(rows)

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
    sample = {(json.load(open(f))["parts"], json.load(open(f))["parts_total"]) for f in glob.glob(f"{HOME}/v2text/{tp}-c*.json")}
    every_part = bool(sample) and all(p >= t for p, t in sample)
    text_parts = "every part" if every_part else "every 10th part"
    payload = {"cycles": cs, "metrics": metrics, "histograms": histograms, "tables": tables, "only": only,
               "text_sample": {"parts": min(sample)[0], "parts_total": min(sample)[1], "same_every_cycle": len(sample) == 1} if sample else None,
               # how the page words where a chart's keys come from (dashboard.js sourceNote)
               "text_note": text_note,
               "replays": replayed_any,
               "pipeline_partial": partial,
               # key prefixes whose values replace the run's W&B values in every cycle (override), or fill only the
               # cycles W&B has no value for (fill); every other key W&B has stays W&B's (dashboard.js mergeExtra)
               "override": override or [], "fill": fill or [],
               "override_note": override_note,   # why the overridden keys other than domains/ replace W&B's
               "gaps": gaps,
               "source": "Domain-rank charts: read from the crawl's WARC index and parse data, not logged by the run" if only
               else f"Read from the crawl's WARC index and segments ({text_parts} for the text keys), not logged by the run"}
    OUT.mkdir(parents=True, exist_ok=True)
    out = OUT / f"extra-{run_id}.js"
    out.write_text(f"window.CRAWL_EXTRA=window.CRAWL_EXTRA||{{}};window.CRAWL_EXTRA[{json.dumps(run_id)}]="
                   + json.dumps(payload, separators=(",", ":"), allow_nan=False) + ";\n")
    print(f"{run_id}: cycles {cs[0]}-{cs[-1]}, {len(metrics)} metrics, {len(histograms)} histograms, "
          f"{sum(len(t) for t in tables.values())} tables -> {out} ({out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    # extra.py [--only k1,k2] [--text-from Pall] [--text-prefix P --text-note "..."] [--override domains/,... --override-note "..."]
    #          [--fill fetch/,text/,...] <run id> <prefix or -> [<run id> <prefix> ...]
    a = sys.argv[1:]
    opts = {"only": None, "text_prefix": None, "text_note": None, "override": None, "fill": None, "override_note": None,
            "text_from": None}
    while a[:1] and a[0].startswith("--"):
        k = a[0][2:].replace("-", "_")
        if k not in opts or len(a) < 2:
            raise SystemExit(__doc__)
        opts[k], a = (a[1].split(",") if k in ("only", "override", "fill") else a[1]), a[2:]
    if not a or len(a) % 2:
        raise SystemExit(__doc__)
    for i in range(0, len(a), 2):
        build(a[i], a[i + 1], **opts)
