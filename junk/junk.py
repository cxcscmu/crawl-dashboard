"""Junk rules on the 9 sampled cycles: how much of the high-score pages is junk, and which score lets it in.

Input: ~/crawl-data/v2sample/<run>-c<N>.jsonl.gz (TextSample on every 10th part of the cycle's segment):
  strata "high"  every scored page with combined >= 0.95 or fastText >= 0.5 or FineWeb-Edu >= 0.6
  strata "base"  a 1-in-10 random sample of all pages (URL hash), the reference
  text           the parse text, cut at 30,000 characters (the word count "words" is of the whole page)

Rules, each checked on the page's own text:
  DCLM-Baseline (dclm_baseline_refinedweb_post_lang.yaml, ported line by line from mlfoundations/dclm
  baselines/mappers): page length 50-100k words, mean word length 3-10, # and ellipsis per word <= 0.1, lines
  starting with a bullet <= 90%, lines ending in an ellipsis <= 30%, words without a letter <= 20%, at least 2 stop
  words, Gopher repetition (duplicate lines/paragraphs, top 2-4-gram, repeated 5-10-grams), and the line modifiers
  (uppercase, numeric, counter, one-word lines, "items in cart" / "Read more..." / "Sign-in") removing <= 5% of words.
  Differences from DCLM: fastText's tokenizer is a whitespace split (what it does apart from "</s>" at newlines,
  which ignore_punctuation drops); uniseg's word split is the regex module's Unicode word boundaries (same standard,
  UAX #29); the text is the first 30,000 characters.
  Ours (thresholds are our choice): low_vocab = fewer than 30% distinct words in the first 500 words (pages of 100+
  words); repeated_term = one content word (3+ letters, not a stop word) is over 5% of the words and appears 10+
  times; interstitial = the crawl tagged the page as a bot check / consent wall.
Junk = fails any rule. Junk score = number of rules failed.
Writes analysis/junk/pages.pkl (one row per page, no text) and prints the summary tables.
"""
import glob
import gzip
import json
import os
import re
import sys
from collections import Counter
from multiprocessing import Pool

import regex   # pandas is imported where it's used, so the cluster jobs can import rules() without it

HOME = os.path.expanduser("~/crawl-data")
OUT = HOME + "/analysis/junk"
STOP = {"the", "be", "to", "of", "and", "that", "have", "with"}
WB = regex.compile(r"(?wV1)\b")
COUNTER = re.compile(r"^\W*\d(?:,|\.|\d)*(?:K|k|M|m|B|b)?\s+(?:likes|shares|comments|retweets|reposts|quotes|bookmarks|upvotes|downvotes|downloads|views|followers)\W*$")
SUBS = [(re.compile(r"\s?(?:items in cart)", re.I)), (re.compile(r"\s?(?:read more...)$", re.I)), (re.compile(r"^(?:sign-in)\s?", re.I))]
# common English function words, for the repeated-term rule only
FUNC = set("""a an the and or but if of to in on at by for with from as is are was were be been being it its this that these
those he she they we you i me my your our their his her them us not no yes do does did have has had will would can could
should may might must shall so than then there here what which who whom whose when where why how all any each more most
other some such only own same too very just also into over under about after before between out up down off again
further once both few nor s t don now""".split())
DCLM_RULES = ["length", "word_length", "symbols", "bullets", "ellipsis", "non_alpha_words", "stop_words", "repetition", "line_removal"]
OUR_RULES = ["low_vocab", "repeated_term", "interstitial"]


def ft_words(t):
    return [w for w in t.split() if w[0].isalnum()]


def uni_words(t):
    return [w for w in WB.split(t) if w and w[0].isalnum()]


def segs(t, sep):
    return [p for x in t.split(sep) if (p := x.strip())]


def repetition_ok(text):
    """massive_web_repetition_filters (Gopher), as DCLM's repetition_filter computes it. Returns "" if the page
    passes, else the first check it fails (dup_lines, dup_paras, dup_line_chars, dup_para_chars, top_<n>gram, rep_<n>gram)."""
    if text == "":
        return "empty"
    for name, sep, thr, chars in (("dup_lines", "\n", 0.3, False), ("dup_paras", "\n\n", 0.3, False),
                                  ("dup_line_chars", "\n", 0.2, True), ("dup_para_chars", "\n\n", 0.2, True)):
        s = segs(text, sep)
        if len(s) == 1:
            continue
        if not s:
            return "empty"
        cnt = Counter(s)
        frac = (sum(len(x) * c for x, c in cnt.items() if c > 1) / sum(len(x) for x in s)) if chars else \
            sum(c for c in cnt.values() if c > 1) / len(s)
        if frac > thr:
            return name
    words = uni_words(text)
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


def modified(text):
    """The line modifiers in config order; None if one empties the page."""
    def keep(t, pred, strip=True):
        out = "\n".join(l for l in t.split("\n") if pred(l))
        return out.strip() if strip else out
    t = keep(text, lambda l: not l or sum(c.isupper() for c in l) / len(l) <= 0.5)
    if not t:
        return None
    t = keep(t, lambda l: not l or sum(c.isdigit() for c in l) / len(l) <= 0.999999)
    if not t:
        return None
    t = keep(t, lambda l: not COUNTER.search(l.lower()))
    if not t:
        return None
    t = keep(t, lambda l: not l or 2 <= len(l.split()), strip=False)
    if t == "":
        return None
    for pat in SUBS:
        out = []
        for l in t.split("\n"):
            if len(l.split()) <= 10:
                m = pat.sub("", l)
                if l and (not m or m.isspace()):
                    continue
                l = m
            out.append(l)
        t = "\n".join(out).strip()
        if not t:
            return None
    return t


def rules(text, interstitial):
    r = {}
    fw = ft_words(text)
    n = len(fw)
    ws = text.split()
    r["length"] = not (50 <= n <= 100000)
    r["word_length"] = (not ws) or not (3 <= sum(map(len, ws)) / len(ws) <= 10)
    r["symbols"] = (not ws) or sum(text.count(s) for s in ("#", "...", ". . .", "…")) / len(ws) > 0.1
    L = segs(text, "\n")
    r["bullets"] = sum(l.startswith(("●", "•", "*", "-")) for l in L) > 0.9 * len(L)
    r["ellipsis"] = sum(l.endswith(("...", ". . .", "…")) for l in L) > 0.3 * len(L)
    r["non_alpha_words"] = (not ws) or sum(1 for w in ws if not any(c.isalpha() for c in w)) / len(ws) > 0.2
    r["stop_words"] = sum(1 for w in ws if w.lower() in STOP) < 2
    r["repetition_check"] = repetition_ok(text)
    r["repetition"] = r["repetition_check"] != ""
    t = modified(text)
    r["line_removal"] = t is None or n == 0 or (n - len(ft_words(t))) / n > 0.05
    low = [w.lower() for w in uni_words(text)]
    head = low[:500]
    r["low_vocab"] = len(low) >= 100 and len(set(head)) / len(head) < 0.3
    content = Counter(w for w in low if len(w) >= 3 and w.isalpha() and w not in FUNC)
    top = content.most_common(1)
    r["repeated_term"] = bool(top) and top[0][1] >= 10 and top[0][1] / max(len(low), 1) > 0.05
    r["top_term"] = top[0][0] if top else ""
    r["interstitial"] = bool(interstitial)
    return r


def one_file(path):
    import pandas as pd
    run, c = re.search(r"(\d+)-c(\d+)\.jsonl", path).groups()
    rows = []
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        for line in fh:
            p = json.loads(line)
            if not p.get("scored") or p.get("lang") != "en":
                continue
            r = rules(p.get("text") or "", p.get("interstitial"))
            r.update(run=run, cycle=int(c), url=p["url"], high="high" in p["strata"], base="base" in p["strata"],
                     combined=p.get("combined"), dclm=p.get("dclm"), edu=p.get("edu"), words=p.get("words"), chars=p.get("chars"),
                     title=(p.get("title") or "")[:120])
            rows.append(r)
    df = pd.DataFrame(rows)
    print(f"{run} c{c}: {len(df)} scored English pages", flush=True)
    return df


def main():
    import pandas as pd
    os.makedirs(OUT, exist_ok=True)
    files = sorted(glob.glob(HOME + "/v2sample/*.jsonl.gz"))
    if len(sys.argv) > 1:
        files = [f for f in files if any(a in f for a in sys.argv[1:])]
    with Pool(min(len(files), os.cpu_count() or 4)) as pool:
        df = pd.concat(pool.map(one_file, files), ignore_index=True)
    df["dclm_fail"] = df[DCLM_RULES].any(axis=1)
    df["ours_fail"] = df[OUR_RULES].any(axis=1)
    df["junk"] = df.dclm_fail | df.ours_fail
    df["junk_score"] = df[DCLM_RULES + OUR_RULES].sum(axis=1)
    df.to_pickle(OUT + "/pages.pkl")
    print("rows", len(df), "->", OUT + "/pages.pkl")


if __name__ == "__main__":
    main()
