"""Build the dashboard's "Junk check" file (site/data/raw/junk.js) from the junk-rule results of the page-text samples.

    ~/crawl-data/py/bin/python junkdata.py

Inputs, under ~/crawl-data/analysis/junk/ (made by the scripts in junk/, see README):
    pages.pkl     one row per sampled English page: each rule's pass/fail, scores, strata (junk/junk.py)
    ngram.pkl     the n-gram repetition check for pages junk.py stopped at a duplicate-line check (junk/junk_ngram.py)
    rep.pkl       each page's repetition level, whole text and 6+ word lines (junk/junk_rep.py)
    priority.pkl  each page's priority (fetch-list score) and its percentile among the cycle's parsed pages
plus Jerry's score percentile tables (pipeline/crawl/cdf in webcrawler-progress, cloned to ~/crawl-data/ref/wcp).

The sample covers every 10th part of a cycle's segment: every high-score page there (combined >= 0.95, fastText >= 0.5
or FineWeb-Edu >= 0.6) and 1 in 10 of the rest. Rates over a set of pages that mixes both (a percentile band, a top 1%)
weight each page by how it was sampled (1 for high-score pages, 10 for the others), so they estimate the whole cycle.
"""
import json
import os
from pathlib import Path

import numpy as np
import pandas as pd

HOME = os.path.expanduser("~/crawl-data")
J = HOME + "/analysis/junk"
OUT = Path(__file__).resolve().parent / "site" / "data" / "raw" / "junk.js"
RUN_ID = {"233150": "crawl-233150", "259887": "crawl-259887", "265639": "crawl-265639"}
BASIC = ["length", "word_length", "symbols", "bullets", "ellipsis", "non_alpha_words", "stop_words"]
OURS = ["low_vocab", "repeated_term"]
LINE_CHECKS = {"dup_lines", "dup_paras", "dup_line_chars", "dup_para_chars"}
EXTRA = ["under10"]  # optional rules readers can tick; in no preset, so the presets' numbers don't change
RULES = BASIC + ["rep_ngram", "rep_lines", "line_removal"] + OURS + EXTRA
LABEL = {"length": "Under 50 or over 100k words", "word_length": "Mean word length outside 3–10", "symbols": "Too many # or ellipses",
         "bullets": "90%+ of lines are bullets", "ellipsis": "30%+ of lines end in an ellipsis", "non_alpha_words": "20%+ of words have no letter",
         "stop_words": "Fewer than 2 stop words", "rep_ngram": "Repeated n-grams (whole text)", "rep_lines": "Repeated lines or paragraphs",
         "line_removal": "Line cleanup removes 5%+ of words", "low_vocab": "Under 30% distinct words", "repeated_term": "One term is 5%+ of words",
         "under10": "Under 10 words"}
INDICATORS = {
    "page": "DCLM's page rules (length, word length, symbols, bullets, ellipses, letterless words, stop words) and our two (low vocabulary, one repeated term)",
    "prose": "The page rules, plus DCLM's repeated n-gram check run on lines of 6+ words only (menus and buttons left out)",
    "dclm": "Every DCLM-Baseline rule as written, on the whole page text, plus our two",
}
EDGES = np.array([0, .5, .7, .8, .9, .95, .98, .99, 1.0001])
BANDS = ["0–50", "50–70", "70–80", "80–90", "90–95", "95–98", "98–99", "99–100"]
MIN_PAGES = 30  # a band with fewer sampled pages shows no value


def cdf(name):
    q = np.loadtxt(f"{HOME}/ref/wcp/pipeline/crawl/cdf/cdf_{name}.txt", comments="#")
    return lambda x: np.interp(x, q, np.linspace(0, 1, len(q)))


def wrate(s, col):
    """Weighted share (%) of pages in s with col true, and the number of sampled pages."""
    if len(s) < MIN_PAGES:
        return None, int(len(s))
    return round(float(100 * np.average(s[col], weights=s.w)), 1), int(len(s))


def load():
    # A URL can be in a segment's parse_data more than once (it is written again each time another URL redirects to it:
    # 409 URLs in 233150's samples). Each page counts once, and every merge is one row to one row.
    key = ["run", "cycle", "url"]
    one = lambda name: pd.read_pickle(f"{J}/{name}.pkl").drop_duplicates(key)
    df = one("pages")
    df = df.merge(one("ngram")[key + ["ngram_check"]], on=key, how="left", validate="1:1")
    df = df.merge(one("rep"), on=key, how="left", validate="1:1")
    df = df.merge(one("priority")[key + ["priority", "prio_pct"]], on=key, how="left", validate="1:1")
    first = df.repetition_check.fillna("")
    df["rep_lines"] = first.isin(LINE_CHECKS)
    df["rep_ngram"] = first.str.contains("gram") | (df.ngram_check.fillna("") != "")
    df["under10"] = df.words.fillna(0) < 10  # the whole page's words, split on whitespace (not cut at 30,000 characters)
    df["junk_page"] = df[BASIC + OURS].any(axis=1)
    df["junk_prose"] = df.junk_page | (df.rep_prose > 1)
    df["junk_dclm"] = df[BASIC + ["rep_lines", "rep_ngram", "line_removal"] + OURS].any(axis=1)
    df["F_dclm"], df["F_edu"] = cdf("dclm")(df.dclm), cdf("edu")(df.edu)
    df["w"] = np.where(df.high, 1.0, 10.0)
    for k in (1, 1.5, 2, 3):
        df[f"rep_x{k}"] = df.rep_full > k
    df["rep_prose_x1"] = df.rep_prose > 1
    return df


def run_tables(g):
    out = {"cycles": sorted(int(c) for c in g.cycle.unique()), "pages": int(len(g)), "random_pages": int(g.base.sum()),
           "high_pages": int(g.high.sum()), "with_priority": int(g.priority.notna().sum())}
    pool = g  # every sampled page, weighted
    b, h = g[g.base], g[g.high]
    groups = [("random", "Random pages", b.assign(w=1.0)), ("any", "Any high score", h), ("comb", "Combined ≥ 0.95", h[h.combined >= .95]),
              ("ft_only", "fastText ≥ 0.5 only", h[(h.dclm >= .5) & (h.edu < .6)]), ("edu_only", "FineWeb-Edu ≥ 0.6 only", h[(h.edu >= .6) & (h.dclm < .5)]),
              ("both", "Both high", h[(h.dclm >= .5) & (h.edu >= .6)]),
              ("ft_top1", "fastText top 1%", pool[pool.F_dclm >= .99]), ("edu_top1", "FineWeb-Edu top 1%", pool[pool.F_edu >= .99]),
              ("prio_top1", "Priority top 1%", pool[pool.prio_pct >= .99])]
    out["groups"] = {}
    for gid, label, s in groups:
        row = {"label": label}
        for ind in INDICATORS:
            row[ind], row["n"] = wrate(s, "junk_" + ind)
        row["rules"] = {r: wrate(s, r)[0] for r in RULES}
        row["rep"] = {k: wrate(s, f"rep_x{k}")[0] for k in (1, 1.5, 2, 3)}
        row["rep"]["prose"] = wrate(s, "rep_prose_x1")[0]
        out["groups"][gid] = row
    # junk share by band of each score, one series per sampled cycle and one for all of them
    out["bands"] = {}
    for key, col in (("fasttext", "F_dclm"), ("edu", "F_edu"), ("combined", "combined"), ("priority", "prio_pct")):
        sel = pool[pool[col].notna()]
        cut = pd.cut(sel[col], EDGES, right=False, labels=BANDS)
        per = {}
        for c, gc in [("all", sel)] + [(str(c), sel[sel.cycle == c]) for c in out["cycles"]]:
            cc = cut.loc[gc.index]
            per[c] = {ind: [wrate(s, "junk_" + ind)[0] for _, s in gc.groupby(cc, observed=False)] for ind in INDICATORS}
            per[c]["n"] = [int(len(s)) for _, s in gc.groupby(cc, observed=False)]
        out["bands"][key] = per
    return out


def examples(g, per_rule=3):
    """High-score pages that fail a page rule: a few per rule, picked at random, with their scores."""
    rows = []
    h = g[g.high & g.junk_page]
    for r in BASIC + OURS:
        s = h[h[r]]
        for x in s.sample(min(per_rule, len(s)), random_state=11).itertuples():
            rows.append({"rule": LABEL[r], "cycle": int(x.cycle), "url": x.url, "title": x.title, "words": int(x.words) if x.words == x.words else None,
                         "fasttext": round(float(x.dclm), 4), "edu": round(float(x.edu), 3), "combined": round(float(x.combined), 3),
                         "priority_pct": None if x.prio_pct != x.prio_pct else round(100 * float(x.prio_pct), 1),
                         "top_term": x.top_term if r == "repeated_term" else ""})
    return rows


FKEY = {"233150": "s233150", "259887": "cc", "265639": "flat250"}
FNAME = {"233150": "233150 · score-ordered", "259887": "259887 · OPIC, Common Crawl limits", "265639": "265639 · OPIC, flat 250"}


def findings_csvs(df, out):
    """The tables of the findings page (analysis/findings in ~/crawl-data), from the same pages and weights."""
    groups, pct, rules, rep = [], [], [], []
    order = BASIC + OURS + ["rep_ngram", "rep_lines", "line_removal"] + EXTRA  # counted rules first, then the ones left out
    rows_rules = {r: {"rule": r, "label": LABEL[r], "kind": "ours" if r in OURS + EXTRA else "DCLM", "in_content": r in BASIC + OURS} for r in order}
    for run, g in df.groupby("run"):
        k, name = FKEY[run], FNAME[run]
        b, h = g[g.base].assign(w=1.0), g[g.high]
        sets = [("random", "Random pages", b), ("comb", "Combined ≥ 0.95", h[h.combined >= .95]), ("ft_only", "fastText ≥ 0.5 only", h[(h.dclm >= .5) & (h.edu < .6)]),
                ("edu_only", "FineWeb-Edu ≥ 0.6 only", h[(h.edu >= .6) & (h.dclm < .5)]), ("both", "Both high", h[(h.dclm >= .5) & (h.edu >= .6)]),
                ("any", "Any high score", h), ("ft_top1", "fastText top 1%", g[g.F_dclm >= .99]), ("edu_top1", "FineWeb-Edu top 1%", g[g.F_edu >= .99])]
        for gid, label, s in sets:
            for ind, col in (("content", "junk_page"), ("dclm", "junk_dclm")):
                groups.append({"key": k, "run": name, "indicator": ind, "gid": gid, "group": label, "pages": len(s), "junk_pct": wrate(s, col)[0]})
            if gid in ("random", "any", "comb", "ft_only", "edu_only", "ft_top1", "edu_top1"):
                r = {"key": k, "gid": gid, "group": {"random": "Random", "any": "Any high score", "comb": "Combined ≥ 0.95", "ft_only": "fastText only",
                                                     "edu_only": "FineWeb-Edu only", "ft_top1": "fastText top 1%", "edu_top1": "FineWeb-Edu top 1%"}[gid], "pages": len(s)}
                for x in (1, 1.5, 2, 3):
                    r[f"full_x{x}"] = wrate(s, f"rep_x{x}")[0]
                r["prose_x1"] = wrate(s, "rep_prose_x1")[0]
                r["prose_x1.5"] = wrate(s.assign(_p=s.rep_prose > 1.5), "_p")[0]
                r["page_rules"] = wrate(s, "junk_page")[0]
                r["junk_with_prose_rep"] = wrate(s, "junk_prose")[0]
                rep.append(r)
        for r in RULES:
            rows_rules[r]["random_" + k] = wrate(b, r)[0]
            rows_rules[r]["high_" + k] = wrate(h, r)[0]
        for score, col in (("fastText", "F_dclm"), ("FineWeb-Edu", "F_edu")):
            cut = pd.cut(g[col], EDGES, right=False, labels=BANDS)
            for i, (lab, s) in enumerate(g.groupby(cut, observed=False)):
                for ind, c in (("content", "junk_page"), ("dclm", "junk_dclm")):
                    pct.append({"key": k, "run": name, "indicator": ind, "score": score, "bin": i, "percentile": lab, "pages": len(s), "junk_pct": wrate(s, c)[0]})
    os.makedirs(out, exist_ok=True)
    pd.DataFrame(groups).to_csv(f"{out}/junk_groups.csv", index=False)
    pd.DataFrame(pct).to_csv(f"{out}/junk_by_percentile.csv", index=False)
    pd.DataFrame(list(rows_rules.values())).to_csv(f"{out}/junk_rules.csv", index=False)
    pd.DataFrame(rep).to_csv(f"{out}/junk_repetition.csv", index=False)


# Per-page file for choosing rules on the page: the browser recomputes every rate for any set of rules.
PAGE_RULES = BASIC + OURS + ["rep_lines", "line_removal"] + EXTRA  # bit i of each page's mask = failed PAGE_RULES[i]
SCORE_KEYS = [("fasttext", "F_dclm"), ("edu", "F_edu"), ("combined", "combined"), ("priority", "prio_pct")]


def page_file(run_id, g):
    """window.CRAWL_JUNK_PAGES[run]: base64 little-endian arrays, one entry per sampled page.
    mask   uint16  failed rules, bit i = PAGE_RULES[i]
    flags  uint8   bit0 random sample, bit1 high-score, bit2 fastText >= 0.5, bit3 FineWeb-Edu >= 0.6, bit4 combined >= 0.95,
                   bits 5-6 index of the sampled cycle
    bands  uint16  4 bits per score band (fastText, FineWeb-Edu, page score, priority; 15 = none), lowest bits first
    qfull  uint8   repeated n-gram level on the whole text: ceil(level * 20), capped at 255; fails a threshold t when > 20 t
    qprose uint8   the same on lines of 6+ words"""
    import base64
    n = len(g)
    mask = np.zeros(n, dtype="<u2")
    for i, r in enumerate(PAGE_RULES):
        mask |= (g[r].to_numpy(bool).astype("<u2") << i)
    cyc = {c: i for i, c in enumerate(sorted(g.cycle.unique()))}
    flags = (g.base.to_numpy(bool).astype(np.uint8) | (g.high.to_numpy(bool).astype(np.uint8) << 1)
             | ((g.dclm >= .5).to_numpy().astype(np.uint8) << 2) | ((g.edu >= .6).to_numpy().astype(np.uint8) << 3)
             | ((g.combined >= .95).to_numpy().astype(np.uint8) << 4) | (g.cycle.map(cyc).to_numpy().astype(np.uint8) << 5))
    bands = np.zeros(n, dtype="<u2")
    for k, (_, col) in enumerate(SCORE_KEYS):
        x = g[col].to_numpy(float)
        b = np.searchsorted(EDGES, x, side="right") - 1  # [EDGES[i], EDGES[i+1]) as pd.cut(right=False)
        b = np.where(np.isnan(x) | (b < 0) | (b > 7), 15, b).astype("<u2")
        bands |= b << (4 * k)
    q = lambda v: np.minimum(255, np.ceil(v.to_numpy(float) * 20)).astype(np.uint8)
    enc = lambda a: base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()
    payload = {"n": n, "cycles": sorted(int(c) for c in cyc), "rules": PAGE_RULES, "scores": [k for k, _ in SCORE_KEYS],
               "mask": enc(mask), "flags": enc(flags), "bands": enc(bands), "qfull": enc(q(g.rep_full)), "qprose": enc(q(g.rep_prose))}
    out = OUT.parent / "junk" / f"{run_id}.js"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("window.CRAWL_JUNK_PAGES=window.CRAWL_JUNK_PAGES||{};window.CRAWL_JUNK_PAGES[" + json.dumps(run_id) + "]="
                   + json.dumps(payload, separators=(",", ":")) + ";\n")
    return out


def main():
    df = load()
    findings_csvs(df, HOME + "/analysis/findings")
    for run, g in df.groupby("run"):
        f = page_file(RUN_ID[run], g.reset_index(drop=True))
        print(f"{f}: {f.stat().st_size / 1e6:.2f} MB")
    data = {"indicators": INDICATORS, "bands": BANDS, "rules": {r: LABEL[r] for r in RULES},
            "counted": {"page": BASIC + OURS, "prose": BASIC + OURS + ["rep_ngram (6+ word lines)"], "dclm": RULES}, "runs": {}}
    for run, g in df.groupby("run"):
        t = run_tables(g)
        t["examples"] = examples(g)
        data["runs"][RUN_ID[run]] = t
        G = t["groups"]
        print(f"{run}: cycles {t['cycles']}, {t['pages']} pages; junk (page rules) random {G['random']['page']}%, any high {G['any']['page']}%, "
              f"combined {G['comb']['page']}%, fastText top 1% {G['ft_top1']['page']}% (n={G['ft_top1']['n']}), "
              f"FineWeb-Edu top 1% {G['edu_top1']['page']}% (n={G['edu_top1']['n']}), priority top 1% {G['prio_top1']['page']}% (n={G['prio_top1']['n']})")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("window.CRAWL_JUNK=" + json.dumps(data, separators=(",", ":"), allow_nan=False) + ";\n")
    print(OUT, f"{OUT.stat().st_size / 1e3:.0f} kB")


if __name__ == "__main__":
    main()
