"""Build the dashboard's "Raw data check" files from the per-cycle extracts in ~/crawl-data.

    .venv/bin/python rawdata.py crawl-233150 233150 1-9            # run id on the page, folder prefix, cycles
    .venv/bin/python rawdata.py crawl-233150 233150 1-9 --src DIR --out site/data/raw

Input: <src>/<prefix>-c<N>/ as written by the cluster extract (domains.tsv.gz, counts.tsv, hist2d.tsv, examples.jsonl.gz,
urls/*.tsv.gz, fetch_not_ok/*.tsv.gz). Output, all as script files so the page also works when opened from disk:
    <out>/<run>.js                 cycle summaries and the cross-cycle series
    <out>/<run>/domains-c<N>.js    one row per domain with 3+ pages
    <out>/<run>/ex-c<N>/<name>.js  example pages with their text: one file per domain, plus _cycle.js for the whole cycle
The data is not committed; see README (Publishing).
"""
import argparse
import glob
import gzip
import json
import os
import re
import sys

import numpy as np
import pandas as pd

BUCKETS = [(0, 5, "1-5"), (5, 25, "6-25"), (25, 100, "26-100"), (100, 249, "101-249"), (249, 10**9, "250+")]
KINDS = ["bot", "other_lang", "jscss", "unknown", "untagged"]


def js(path, name, key, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(f"window.{name}=window.{name}||{{}};window.{name}[{json.dumps(key)}]=")
        json.dump(obj, f, separators=(",", ":"), allow_nan=False)
        f.write(";\n")


def clean(v, nd=4):
    if v is None or (isinstance(v, float) and not np.isfinite(v)):
        return None
    return round(float(v), nd) if isinstance(v, (float, np.floating)) else int(v)


def col(series, nd=None):
    return [clean(v, nd) if nd else (None if pd.isna(v) else int(v)) for v in series]


def safe_name(domain):
    return re.sub(r"[^a-z0-9.-]", "_", domain.lower())[:120]


def read_urls(folder):
    files = sorted(glob.glob(f"{folder}/urls/*.tsv.gz"))
    if not files:
        return None
    use = ["url", "domain", "priority", "lang"]
    return pd.concat([pd.read_csv(f, sep="\t", quoting=3, usecols=use, dtype={"url": str, "domain": str, "lang": str},
                                  keep_default_na=False, na_values=[""], on_bad_lines="skip") for f in files], ignore_index=True)


def read_redirect_targets(folder):
    targets = set()
    linked = 0
    for f in sorted(glob.glob(f"{folder}/fetch_not_ok/*.tsv.gz")):
        t = pd.read_csv(f, sep="\t", quoting=3, dtype=str, keep_default_na=False, on_bad_lines="skip")
        linked += int((t.status == "linked").sum())
        r = t[t.status.str.startswith("fetch_redir")]
        targets.update(r.reason.str.extract(r"lastModified=\d+: (\S+)")[0].dropna())
    return targets, linked


def url_stats(folder):
    """Per domain, from the per-URL files: parse records, distinct URLs, pages that are redirect targets, language tags."""
    u = read_urls(folder)
    if u is None:
        return None, {}
    targets, linked = read_redirect_targets(folder)
    u["domain"] = u.domain.fillna("")
    lang = u.lang.fillna("")
    ext = u.url.str.replace(r"[?#].*", "", regex=True).str.lower().str.extract(r"\.([a-z0-9]{1,5})$")[0]
    u["en"] = lang == "en"
    u["bot"] = lang == "interstitial"
    u["unknown"] = lang == "unknown"
    u["jscss"] = (lang == "") & ext.isin(["js", "css", "mjs"])
    u["untagged"] = (lang == "") & ~u.jscss
    u["other_lang"] = ~(u.en | u.bot | u.unknown | (lang == ""))
    first = ~u.url.duplicated()
    u["is_target"] = u.url.isin(targets)
    u["via_redirect"] = first & u.is_target
    u["unlisted"] = first & u.priority.isna()
    g = u.groupby("domain")
    s = g[["en", "bot", "unknown", "jscss", "untagged", "other_lang", "via_redirect", "unlisted"]].sum().astype(int)
    s["records"] = g.size()
    s["urls"] = g.url.nunique()
    n = u.groupby("url").size()
    rep = n[n > 1]
    no_en = u[u.domain.isin(s.index[s.en == 0])]
    totals = {
        "records": len(u), "urls": int(first.sum()), "repeat_urls": int(len(rep)),
        "repeat_urls_redirect_targets": int(rep.index.isin(targets).sum()),
        "unlisted_urls": int(u.unlisted.sum()), "unlisted_redirect_targets": int((u.unlisted & u.is_target).sum()),
        "linked": linked, "bot_pages": int(u.bot.sum()), "bot_domains": int(u[u.bot].domain.nunique()),
        "no_en_domains": int((s.en == 0).sum()), "no_en_pages": len(no_en),
        "no_en_kinds": {k: int(no_en[k].sum()) for k in KINDS},
    }
    return s, totals


def cause(r):
    """Why a domain's counts disagree, from its own numbers. Empty when nothing stands out."""
    out = []
    rec = r.get("records") or 0
    if rec and r["records"] - r["urls"] >= max(5, 0.1 * r["urls"]):
        out.append("repeated by redirects")
    for k, label in [("bot", "bot-check pages"), ("jscss", "JS/CSS files"), ("other_lang", "other language"), ("unknown", "language not detected")]:
        if rec and r[k] >= 0.5 * rec:
            out.append(label)
    return ", ".join(out)


def build_cycle(run, folder, cycle, out):
    d = pd.read_csv(f"{folder}/domains.tsv.gz", sep="\t", keep_default_na=False, na_values=[""])
    d["domain"] = d.domain.fillna("").astype(str)
    counts = pd.read_csv(f"{folder}/counts.tsv", sep="\t", header=None, index_col=0)[1]
    us, totals = url_stats(folder)
    if us is not None:
        d = d.merge(us, left_on="domain", right_index=True, how="left")
    examples = {}
    whole = []
    with gzip.open(f"{folder}/examples.jsonl.gz", "rt") as f:
        for line in f:
            e = json.loads(line)
            groups = e.pop("buckets").split(",")
            e["groups"] = groups
            own = [g for g in groups if not g.startswith("global_")]
            if own:
                examples.setdefault(e["target"], []).append(e)
            if len(own) < len(groups):
                whole.append(e)
    for dom, rows in examples.items():
        js(f"{out}/{run}/ex-c{cycle}/{safe_name(dom)}.js", "CRAWL_RAW_EX", f"{run}/{cycle}/{dom}", rows)
    js(f"{out}/{run}/ex-c{cycle}/_cycle.js", "CRAWL_RAW_EX", f"{run}/{cycle}/", whole)

    d["has_ex"] = d.domain.isin(examples.keys()).astype(int)
    d["failed"] = d.f_gone + d.f_retry
    d["fetches"] = d.f_success + d.f_redir + d.f_gone + d.f_retry + d.f_notmod
    table = {"domain": d.domain.tolist()}
    ints = ["listed", "fetches", "f_success", "f_redir", "f_gone", "f_retry", "cdx200", "parsed", "lang_en", "scored", "outlinks", "outlinks_cross", "pairs", "has_ex"]
    if us is not None:
        ints += ["records", "urls", "via_redirect", "unlisted", "bot", "jscss", "other_lang", "unknown"]
        table["cause"] = [cause(r) for r in d[["records", "urls", "bot", "jscss", "other_lang", "unknown"]].to_dict("records")]
    for c in ints:
        table[c] = col(d[c])
    for c in ["priority_mean", "score_mean", "spearman", "pearson"]:
        table[c] = col(d[c], 3)
    js(f"{out}/{run}/domains-c{cycle}.js", "CRAWL_RAW_DOM", f"{run}/{cycle}", table)

    # cycle summary
    rank = lambda a, b: float(a.rank().corr(b.rank()))
    sc = d[d.scored >= 10]
    within = d[(d.pairs >= 30) & d.spearman.notna()].spearman
    listed = d[d.listed > 0]
    buckets = []
    for lo, hi, label in BUCKETS:
        b = listed[(listed.listed > lo) & (listed.listed <= hi)]
        buckets.append({"label": label, "domains": len(b), **{k: int(b[k].sum()) for k in ["f_success", "f_redir", "f_gone", "f_retry"]}})
    has_prio = counts.get("x_spearman_prio_score_e6", 0) != 0 or cycle > 1
    hist = pd.read_csv(f"{folder}/hist2d.tsv", sep="\t", comment="#", header=None).values.tolist()
    p20 = d[d.parsed >= 20]
    summary = {
        "counts": {k: int(counts[k]) for k in ["list_urls", "f_success", "f_redir", "f_gone", "f_retry", "cdx200", "cdx_other", "parse_pages", "parse_scored", "pairs", "domains_written", "domains_small"] if k in counts},
        "spearman_pages": clean(counts.get("x_spearman_prio_score_e6", np.nan) / 1e6) if has_prio and cycle > 1 else None,
        "spearman_domain_means": clean(rank(sc.priority_mean, sc.score_mean)) if cycle > 1 and len(sc) > 2 else None,
        "spearman_within_median": clean(within.median()) if cycle > 1 and len(within) else None,
        "spearman_within_negative_pct": clean(100 * (within < 0).mean(), 1) if cycle > 1 and len(within) else None,
        "spearman_within_domains": int(len(within)) if cycle > 1 else 0,
        "buckets": buckets,
        "hist": hist if cycle > 1 else None,
        "outlinks": int(d.outlinks.sum()), "outlinks_cross": int(d.outlinks_cross.sum()),
        "outlinks_per_page_median": clean((p20.outlinks / p20.parsed).median(), 1) if len(p20) else None,
        "url_level": totals or None,
        "example_domains": sorted(examples.keys()),
    }
    print(f"cycle {cycle}: {len(d):,} domains, {len(examples)} example domains, {len(whole)} whole-cycle examples", flush=True)
    return summary


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("run")
    ap.add_argument("prefix")
    ap.add_argument("cycles", help="e.g. 1-9 or 20-72")
    ap.add_argument("--src", default=os.path.expanduser("~/crawl-data"))
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "site", "data", "raw"))
    ap.add_argument("--label", default=None)
    a = ap.parse_args()
    lo, _, hi = a.cycles.partition("-")
    cycles = [c for c in range(int(lo), int(hi or lo) + 1) if os.path.exists(f"{a.src}/{a.prefix}-c{c}/DONE")]
    if not cycles:
        sys.exit(f"No finished cycles for {a.prefix} in {a.src}")
    summaries = {c: build_cycle(a.run, f"{a.src}/{a.prefix}-c{c}", c, a.out) for c in cycles}
    js(f"{a.out}/{a.run}.js", "CRAWL_RAW", a.run, {"label": a.label or f"crawl {a.prefix}", "cycles": cycles, "summary": summaries})
    print("wrote", a.out)


if __name__ == "__main__":
    main()
