/* "Junk check": how much of the crawled text is junk by DCLM-Baseline's rules plus two of ours, and how that changes
   with the fastText, FineWeb-Edu and page scores and with priority, for every cycle of every run, in two views:
     Whole page (Nutch)          our parse text of the whole page, menus and all: what the crawler scores and ranks by
     Main content (Resiliparse)  Jerry's main-content text: what pretraining uses
   junkpage.py (run on the cluster) builds, per run and view, data/raw/junk/<run>/<view>/: one file of compact per-page
   arrays per cycle (c<N>.js), the same for a uniform subsample of every cycle (all.js), and index.js with each cycle's
   junk shares for the trend chart, page counts and examples. data/raw/junk/runs.js lists the runs and their views.
   The reader picks which rules count as junk; every rate is recomputed in the browser from the per-page arrays. */
"use strict";

const Junk = (() => {
  const { html, formats: F } = Charts;

  // ---- Data ---------------------------------------------------------------------------------------------------------
  const scripts = new Map();
  function loadScript(src) {
    if (!scripts.has(src)) {
      scripts.set(src, new Promise((resolve) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = () => resolve(true);
        s.onerror = () => resolve(false); // optional: the page works without it
        document.head.append(s);
      }));
    }
    return scripts.get(src);
  }
  const runs = () => window.CRAWL_JUNK_RUNS || {};
  const has = (run) => !!runs()[run];
  const load = () => loadScript("data/raw/junk/runs.js").then(() => !!window.CRAWL_JUNK_RUNS);
  const index = (run, view) => (window.CRAWL_JUNKI || {})[`${run}/${view}`];
  const loadIndex = (run, view) => loadScript(`data/raw/junk/${run}/${view}/index.js`);

  const bytes = (s) => {
    const bin = atob(s);
    const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  };
  const u16 = (b) => {
    const out = new Uint16Array(b.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = b[2 * i] | (b[2 * i + 1] << 8); // little-endian, as junkpage.py writes it
    return out;
  };
  // "<run>/<view>/<cycle or all>" -> decoded arrays, or null when the file couldn't be loaded; missing while it loads
  const pages = new Map();
  function loadPages(run, view, cycle) {
    const key = `${run}/${view}/${cycle}`;
    return loadScript(`data/raw/junk/${run}/${view}/${cycle === "all" ? "all" : `c${cycle}`}.js`).then(() => {
      const raw = (window.CRAWL_JUNKP || {})[key];
      pages.set(key, raw ? {
        n: raw.n, mask: u16(bytes(raw.mask)), flags: bytes(raw.flags), bands: u16(bytes(raw.bands)),
        bands2: raw.bands2 ? u16(bytes(raw.bands2)) : null, qfull: raw.qfull ? bytes(raw.qfull) : null, qprose: raw.qprose ? bytes(raw.qprose) : null,
        // the same bands with the scores ranked within this run (all its cycles) instead of on ClueWeb22's table
        obands: raw.obands ? u16(bytes(raw.obands)) : null, obands2: raw.obands2 ? u16(bytes(raw.obands2)) : null,
        cyc: raw.cyc ? u16(bytes(raw.cyc)) : null, // pooled file only: each page's cycle
      } : null);
    });
  }

  // ---- What the reader picks ----------------------------------------------------------------------------------------
  const VIEWS = {
    nutch: { label: "Whole page (Nutch)", what: "what the crawler scores and ranks by" },
    resil: { label: "Main content (Resiliparse)", what: "what pretraining uses" },
  };
  const PAGE = ["length", "word_length", "symbols", "bullets", "ellipsis", "non_alpha_words", "stop_words", "low_vocab", "repeated_term"];
  // "ngram" = DCLM's repeated n-gram check on the whole text, "ngram6" = the same on lines of 6+ words only (whole page only)
  const PRESETS = {
    page: { label: "Page rules", items: PAGE, text: "DCLM's page rules (length, word length, symbols, bullets, ellipses, letterless words, stop words) and our two (low vocabulary, one repeated term)" },
    prose: { label: "+ repetition in text", items: [...PAGE, "ngram6"], nutch: true, text: "The page rules, plus DCLM's repeated n-gram check run on lines of 6+ words only (menus and buttons left out)" },
    dclm: { label: "DCLM as written", items: [...PAGE, "ngram", "rep_lines", "line_removal"], text: "Every DCLM-Baseline rule as written, plus our two" },
  };
  const SETS = [
    { title: "DCLM page rules", items: ["length", "word_length", "symbols", "bullets", "ellipsis", "non_alpha_words", "stop_words"] },
    { title: "Our rules", items: ["low_vocab", "repeated_term", "under10"] },
    { title: "DCLM repetition and line rules", items: ["ngram", "ngram6", "rep_lines", "line_removal"] },
  ];
  const ITEMS = SETS.flatMap((s) => s.items);
  const LABEL = {
    length: "Under 50 or over 100k words", word_length: "Mean word length outside 3–10", symbols: "Too many # or ellipses",
    bullets: "90%+ of lines are bullets", ellipsis: "30%+ of lines end in an ellipsis", non_alpha_words: "20%+ of words have no letter",
    stop_words: "Fewer than 2 stop words", low_vocab: "Under 30% distinct words", repeated_term: "One term is 5%+ of words", under10: "Under 10 words",
    ngram: "Repeated n-grams, whole text", ngram6: "Repeated n-grams, lines of 6+ words", rep_ngram: "Repeated n-grams", rep_lines: "Repeated lines or paragraphs",
    line_removal: "Line cleanup removes 5%+ of words",
  };
  const RULE_ROWS = ["length", "word_length", "symbols", "bullets", "ellipsis", "non_alpha_words", "stop_words", "rep_ngram", "rep_lines", "line_removal", "low_vocab", "repeated_term", "under10"];
  const THRESHOLDS = [1, 1.25, 1.5, 2, 3];
  const BANDS = ["0–50", "50–70", "70–80", "80–90", "90–95", "95–98", "98–99", "99–100"];
  // the page's own cycle and per-cycle / cumulative choice pick the cycles (ctx.cycle, ctx.cum)
  // bandScale: score bands as percentiles within this run ("own") or on ClueWeb22's table ("cw")
  const sel = { items: new Set(PRESETS.page.items), t: 1, view: "nutch", src: null, trend: null, hiScore: "fasttext", hiCut: "train", bandScale: "own" };
  const HI_SCORES = { fasttext: "fastText", edu: "FineWeb-Edu", combined: "Page score" };
  const SCORE_WORD = { fasttext: "fastText", edu: "FineWeb-Edu", combined: "page score" };
  // "High score" cutoffs: the training cut; this run's own top 1/5/10/50% ("own<n>"); a fixed score at ClueWeb22's top
  // 1/5/10/50% ("cw<n>"; page score: the value itself, 0.99 / 0.95 / 0.90 / 0.50)
  const TOPS = ["1", "5", "10", "50"];
  const HI_CUTS = ["train", ...TOPS.map((n) => "own" + n), ...TOPS.map((n) => "cw" + n)];
  const TOP_BAND = { 1: 7, 5: 5, 10: 4, 50: 1 }; // the score band whose lower edge is that top percent
  const TRAIN_CUT = 0.018112;
  const topWord = (n) => (n === "50" ? "half" : `${n}%`);
  const num = (v) => String(Number(v.toPrecision(3)));
  const srcKey = () => (sel.view === "resil" && sel.src === "main" ? "B" : "A");
  // {kind, n, band, thr}: thr = the score the cutoff starts at (null when this run has no own percentile for it)
  function cutOf(I, c = sel.hiCut, s = sel.hiScore) {
    if (c === "train") return { kind: "train", band: null, thr: TRAIN_CUT };
    const kind = c.startsWith("own") ? "own" : "cw", n = c.slice(kind.length), band = TOP_BAND[n], e = band - 1;
    const thr = kind === "own" ? I.own_cuts?.[srcKey()]?.[s]?.[e] ?? null
      : s === "combined" ? (I.band_edges || [0.5, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99])[e] : I.cw_cuts?.[s]?.[e] ?? null;
    return { kind, n, band, thr };
  }
  function cutLabel(I, c, s) {
    const x = cutOf(I, c, s), S = SCORE_WORD[s];
    if (x.kind === "train") return `The training cut: fastText ≥ ${TRAIN_CUT}`;
    if (x.kind === "own") return `Top ${topWord(x.n)} of this run: ${S} ≥ ${x.thr == null ? "—" : num(x.thr)}`;
    return s === "combined" ? `Page score ≥ ${x.thr.toFixed(2)}` : `${HI_SCORES[s]} ≥ ${x.thr == null ? "—" : num(x.thr)}: ClueWeb22's top ${topWord(x.n)}`;
  }
  // the cutoff in words, and "<score> ≥ / < <value>" for the pie slices
  function hiText(I) {
    const x = cutOf(I), S = SCORE_WORD[sel.hiScore], v = x.thr == null ? "—" : num(x.thr);
    if (x.kind === "train") return `fastText ≥ ${TRAIN_CUT}, the training cut Jerry's pipeline keeps pages by`;
    if (x.kind === "own") return `${S} ≥ ${v}, this run's top ${topWord(x.n)} of English pages`;
    return sel.hiScore === "combined" ? `page score ≥ ${x.thr.toFixed(2)}` : `${S} ≥ ${v}, ClueWeb22's top ${topWord(x.n)}`;
  }
  const hiCmp = (I, sign) => {
    const x = cutOf(I);
    const v = x.thr == null ? "—" : x.kind === "train" ? String(TRAIN_CUT) : sel.hiScore === "combined" && x.kind === "cw" ? x.thr.toFixed(2) : num(x.thr);
    return `${SCORE_WORD[sel.hiScore]} ${sign} ${v}`;
  };
  let urlRead = false;

  const sameSet = (a, b) => a.size === b.length && b.every((x) => a.has(x));
  const presetOf = () => (sel.t === 1 ? Object.keys(PRESETS).find((k) => sameSet(sel.items, PRESETS[k].items)) : undefined);
  function setPreset(k) {
    sel.items = new Set(PRESETS[k].items);
    sel.t = 1;
  }
  // Only the whole-page view has repetition levels: the main-content view has no n-gram threshold or 6+ word lines.
  function fitView() {
    if (sel.view !== "resil") return;
    sel.items.delete("ngram6");
    sel.t = 1;
    if (!sel.items.size) setPreset("page");
  }
  // Kept in the link: the rule choice (a preset by name, or its rules and "t1.5" for a looser n-gram threshold), then
  // "resil" for the main-content view, "crawler" / "main" for its score source and "hi-<score>-<cut>" for the pies'
  // high score. The cycle and per-cycle / cumulative are the page's own (run, cycle, view in the link).
  function param() {
    const extra = [sel.view === "resil" && "resil", sel.src && sel.view === "resil" && sel.src,
      (sel.hiScore !== "fasttext" || sel.hiCut !== "train") && `hi-${sel.hiScore}-${sel.hiCut}`, sel.bandScale === "cw" && "cwbands"].filter(Boolean);
    const p = presetOf();
    const rules = p ? (p === "page" && !extra.length ? [] : [p]) : [...ITEMS.filter((k) => sel.items.has(k)), ...(sel.t !== 1 ? [`t${sel.t}`] : [])];
    if (!p && !rules.length) rules.push("none");
    return [...rules, ...extra].join(",");
  }
  function readUrl() {
    const v = new URLSearchParams(location.search).get("junk");
    if (!v) return;
    const items = new Set();
    let t = 1, preset = null, ruled = false;
    for (const tok of v.split(",")) {
      if (PRESETS[tok]) preset = tok;
      else if (ITEMS.includes(tok)) { items.add(tok); ruled = true; }
      else if (tok === "none") ruled = true;
      else if (/^t[\d.]+$/.test(tok) && THRESHOLDS.includes(+tok.slice(1))) t = +tok.slice(1);
      else if (tok === "resil") sel.view = "resil";
      else if (tok === "crawler" || tok === "main") sel.src = tok;
      else if (/^hi-(fasttext|edu|combined)-(train|(own|cw)?(1|5|10|50))$/.test(tok)) {
        const [, s, c] = tok.split("-");
        sel.hiScore = s;
        sel.hiCut = /^\d/.test(c) ? "cw" + c : c; // a bare number: the ClueWeb22 cutoffs these links first meant
      } else if (tok === "cwbands") sel.bandScale = "cw";
    }
    if (preset) setPreset(preset);
    else if (ruled) { sel.items = items; sel.t = t; }
    fitView();
  }

  // ---- Rates for the chosen rules -----------------------------------------------------------------------------------
  const GROUPS = ["random", "any", "comb", "ft_only", "edu_only", "both", "ft_top1", "edu_top1", "prio_top1"];
  const GROUP_LABEL = {
    random: "Random pages", any: "Any high score", comb: "Page score ≥ 0.95", ft_only: "fastText ≥ 0.5 only", edu_only: "FineWeb-Edu ≥ 0.6 only",
    both: "Both high", ft_top1: "fastText top 1%", edu_top1: "FineWeb-Edu top 1%", prio_top1: "Priority top 1%",
  };
  const REP_GROUPS = ["random", "any", "comb", "ft_top1", "edu_top1"];
  const REPS = [1, 1.5, 2, 3];
  const MIN_PAGES = 30; // fewer sampled pages show no value
  const cache = new Map();

  // Kinds of junk, in DCLM-Baseline's order (Jerry's pie uses the first three and line cleanup): a failing page counts
  // under the first kind with a ticked rule it fails.
  const KINDS = [
    { id: "length", label: "Junk: too short or long", rules: ["length"], slot: 5 },
    { id: "other", label: "Junk: other DCLM page rules", rules: ["word_length", "symbols", "bullets", "ellipsis", "non_alpha_words", "stop_words"], slot: 7 },
    { id: "rep", label: "Junk: repetitive", rules: ["rep_lines"], slot: 4 }, // + the n-gram items, from the levels or the rep_ngram bit
    { id: "line", label: "Junk: line cleanup removed too much", rules: ["line_removal"], slot: 6 },
    { id: "ours", label: "Junk: our rules", rules: ["low_vocab", "repeated_term", "under10"], slot: 3 },
  ];

  // Whole page: every high-score page is in the sample and 1 in 10 of the rest, so in a set that mixes both the others
  // weigh 10; random pages are a plain sample and count once each. Main content: a uniform sample, every page weighs 1.
  // maxCycle: the pooled file's pages of cycles 1 to maxCycle only (the page's cumulative view).
  function compute(key, P, I, maxCycle) {
    const ck = `${key}|${maxCycle}|${sel.src}|${sel.hiScore}|${sel.hiCut}|${sel.bandScale}|${param()}`;
    if (cache.has(ck)) return cache.get(ck);
    const rules = I.rules;
    let M = 0;
    rules.forEach((r, i) => { if (sel.items.has(r)) M |= 1 << i; });
    const levels = I.has_rep && P.qfull;
    const ng = 1 << rules.indexOf("rep_ngram");
    const full = sel.items.has("ngram"), prose = levels && sel.items.has("ngram6"), tq = Math.round(sel.t * 20);
    if (full && !levels) M |= ng; // main content: the n-gram rule as the first failing repetition check
    const kindMask = KINDS.map((k) => k.rules.reduce((m, r) => (sel.items.has(r) ? m | (1 << rules.indexOf(r)) : m), 0));
    const repK = KINDS.findIndex((k) => k.id === "rep");
    if (full && !levels) kindMask[repK] |= ng;
    const cut1 = P.cyc && maxCycle != null ? maxCycle : null;
    // "High score" for the pies: fastText over the training cut, or a band of the chosen score, ranked within this run
    // (obands) or on ClueWeb22's table (bands)
    const main = sel.view === "resil" && sel.src === "main";
    const cwBands = main && P.bands2 ? P.bands2 : P.bands;
    const ownBands = main ? P.obands2 : P.obands;
    const hk = { fasttext: 0, edu: 1, combined: 2 }[sel.hiScore] ?? 0;
    const hc = cutOf(I);
    const hTrain = hc.kind === "train";
    const hBand = hc.band ?? 7;
    const hBands = hc.kind === "own" && ownBands ? ownBands : cwBands;
    const hBit = 1 << (main ? 14 : 13);
    // the score bands of the charts below and the "top 1%" groups
    const bands = scaleOf(I) === "own" && ownBands ? ownBands : cwBands;
    // random pages: all, junk with a high score, junk with a low score, bot-check pages (main content: the crawler's
    // call, mask bit 15; no score, as the crawler gives them none)
    const pieA = { n: 0, hi: 0, lo: 0, bot: 0 };
    const BOT = 1 << 15;
    const pieC = { n: 0, w: 0, jw: 0, kind: new Float64Array(KINDS.length) }; // high-score pages
    const shift = main ? 5 : 2;
    const hasHigh = I.has_high;
    const nr = rules.length;
    const nk = KINDS.length;
    const G = Object.fromEntries(GROUPS.map((g) => [g, { jw: 0, w: 0, n: 0, rule: new Float64Array(nr), rep: new Float64Array(5), kind: new Float64Array(nk) }]));
    const B = new Float64Array(4 * 8 * 3);
    let kind = -1; // the current page's kind of junk, -1 when it isn't junk
    const add = (g, junk, w, mask, qf, qp) => {
      g.jw += junk * w;
      g.w += w;
      g.n += 1;
      if (kind >= 0) g.kind[kind] += w;
      for (let i = 0; i < nr; i++) if (mask & (1 << i)) g.rule[i] += w;
      if (qf != null) {
        for (let k = 0; k < 4; k++) if (qf > REPS[k] * 20) g.rep[k] += w;
        if (qp > 20) g.rep[4] += w;
      }
    };
    for (let i = 0; i < P.n; i++) {
      if (cut1 != null && P.cyc[i] > cut1) continue;
      const f = P.flags[i], mask = P.mask[i];
      const qf = levels ? P.qfull[i] : null, qp = levels ? P.qprose[i] : null;
      const repHit = (levels && full && qf > tq) || (prose && qp > tq);
      const junk = (mask & M) !== 0 || repHit ? 1 : 0;
      kind = -1;
      if (junk) {
        for (let k = 0; k < nk; k++) {
          if ((mask & kindMask[k]) !== 0 || (k === repK && repHit)) { kind = k; break; }
        }
      }
      const cut = (f >> shift) & 7, ft = cut & 1, edu = cut & 2, comb = cut & 4;
      const high = hasHigh ? f & 2 : cut !== 0;
      const w = hasHigh && !(f & 2) ? 10 : 1;
      const hb = (hBands[i] >> (4 * hk)) & 15;
      const pieHigh = hTrain ? (mask & hBit) !== 0 : hb <= 7 && hb >= hBand;
      if (f & 1) {
        add(G.random, junk, 1, mask, qf, qp);
        pieA.n += 1;
        if (mask & BOT) pieA.bot += 1;
        else if (junk) pieHigh ? (pieA.hi += 1) : (pieA.lo += 1);
      }
      if (pieHigh) {
        pieC.n += 1;
        pieC.w += w;
        if (junk) {
          pieC.jw += w;
          if (kind >= 0) pieC.kind[kind] += w;
        }
      }
      if (high) {
        add(G.any, junk, 1, mask, qf, qp);
        if (comb) add(G.comb, junk, 1, mask, qf, qp);
        if (ft && !edu) add(G.ft_only, junk, 1, mask, qf, qp);
        if (edu && !ft) add(G.edu_only, junk, 1, mask, qf, qp);
        if (ft && edu) add(G.both, junk, 1, mask, qf, qp);
      }
      const b4 = bands[i];
      for (let k = 0; k < 4; k++) {
        const b = (b4 >> (4 * k)) & 15;
        if (b > 7) continue;
        if (b === 7) {
          if (k === 0) add(G.ft_top1, junk, w, mask, qf, qp);
          else if (k === 1) add(G.edu_top1, junk, w, mask, qf, qp);
          else if (k === 3) add(G.prio_top1, junk, w, mask, qf, qp);
        }
        const o = (k * 8 + b) * 3;
        B[o] += junk * w;
        B[o + 1] += w;
        B[o + 2] += 1;
      }
    }
    const rate = (x, w, n) => (n < MIN_PAGES || !w ? null : Math.round((1000 * x) / w) / 10);
    const out = { groups: {}, bands: {}, pieA, pieC: { n: pieC.n, junk: rate(pieC.jw, pieC.w, pieC.n), kinds: KINDS.map((_, k) => rate(pieC.kind[k], pieC.w, pieC.n)) } };
    for (const g of GROUPS) {
      const a = G[g];
      out.groups[g] = { v: rate(a.jw, a.w, a.n), n: a.n, kinds: KINDS.map((_, k) => rate(a.kind[k], a.w, a.n)),
        rules: Object.fromEntries(rules.map((r, i) => [r, rate(a.rule[i], a.w, a.n)])),
        rep: { 1: rate(a.rep[0], a.w, a.n), 1.5: rate(a.rep[1], a.w, a.n), 2: rate(a.rep[2], a.w, a.n), 3: rate(a.rep[3], a.w, a.n), prose: rate(a.rep[4], a.w, a.n) } };
    }
    I.scores.forEach((s, k) => {
      out.bands[s] = BANDS.map((_, b) => rate(B[(k * 8 + b) * 3], B[(k * 8 + b) * 3 + 1], B[(k * 8 + b) * 3 + 2]));
      out.bands[s].n = BANDS.map((_, b) => B[(k * 8 + b) * 3 + 2]);
    });
    cache.set(ck, out);
    return out;
  }

  // ---- Page ---------------------------------------------------------------------------------------------------------
  // The score bands, ranked within this run ("own") or on ClueWeb22's table ("cw"); priority is always within the cycle.
  const BAND_CHARTS = [
    { key: "fasttext", title: "Junk share by fastText percentile",
      x: { own: "fastText percentile within this run", cw: "fastText percentile (Jerry's ClueWeb22 table)" },
      foot: { own: "fastText = the DCLM quality classifier's score, ranked among this run's English pages over all its cycles.",
        cw: "fastText = the DCLM quality classifier's score, placed on the percentile table Jerry's crawls use for the page score." } },
    { key: "edu", title: "Junk share by FineWeb-Edu percentile",
      x: { own: "FineWeb-Edu percentile within this run", cw: "FineWeb-Edu percentile (Jerry's ClueWeb22 table)" }, foot: { own: "", cw: "" } },
    { key: "combined", title: "Junk share by page score",
      x: { own: "Page score percentile within this run", cw: "Page score × 100 (½ fastText + ½ FineWeb-Edu percentile)" },
      foot: { own: "The page score (½ fastText + ½ FineWeb-Edu ClueWeb22 percentile, the combined score 233150 ranks by), ranked within this run.",
        cw: "The page score is the average of the two percentiles, the combined score 233150 ranks by." } },
    { key: "priority", title: "Junk share by priority", x: { own: "Priority percentile within the cycle", cw: "Priority percentile within the cycle" }, foot: { own: "", cw: "" } },
  ];
  const groupLabel = (g, scale) => (g === "ft_top1" || g === "edu_top1"
    ? `${g === "ft_top1" ? "fastText" : "FineWeb-Edu"} top 1%${scale === "own" ? " of this run" : " of ClueWeb22"}` : GROUP_LABEL[g]);

  // The training cut is fastText's; a run with no own percentile for a score (too few scored pages) falls back to
  // ClueWeb22's cutoff, and to ClueWeb22's bands when its page files predate the own bands.
  function fitCut(I) {
    if (sel.hiCut === "train" && sel.hiScore !== "fasttext") sel.hiCut = "own10";
    if (sel.hiCut.startsWith("own") && cutOf(I).thr == null) sel.hiCut = "cw" + sel.hiCut.slice(3);
  }
  const scaleOf = (I) => (sel.bandScale === "own" && I.own_cuts?.[srcKey()] ? "own" : "cw");

  function render(ctx) {
    const box = html("div", { class: "junk" });
    const views = runs()[ctx.run];
    if (!views) return box;
    if (!urlRead) {
      readUrl();
      urlRead = true;
    }
    if (!views.includes(sel.view)) sel.view = views[0];
    fitView();
    const I = index(ctx.run, sel.view);
    if (I === undefined) {
      loadIndex(ctx.run, sel.view).then(() => ctx.rerender());
      box.append(html("p", { class: "empty", text: "Loading…" }));
      return box;
    }
    if (sel.view === "resil" && (!sel.src || (sel.src === "crawler" && !I.crawler_scores))) sel.src = I.crawler_scores ? "crawler" : "main";
    fitCut(I);
    // The page's own cycle and per-cycle / cumulative choice pick the pages: one cycle's sample, or cycles 1 to N cut
    // from the pooled sample of every cycle.
    const N = ctx.cycle, cum = !!ctx.cum, last = I.cycles.at(-1);
    const sampled = cum ? I.cycles[0] <= N : I.cycles.includes(N);
    const file = cum ? "all" : N;
    const key = `${ctx.run}/${sel.view}/${file}`;
    const maxCycle = cum && N < last ? N : null;
    const upto = Math.min(N, last);
    const where = cum ? (I.cycles[0] === upto ? `Cycle ${upto}` : `Cycles ${I.cycles[0]}–${upto}`) : `Cycle ${N}`;
    if (sampled && !pages.has(key)) {
      pages.set(key, undefined);
      loadPages(ctx.run, sel.view, file).then(() => ctx.rerender());
    }
    const P = sampled ? pages.get(key) : null;
    const preset = presetOf();
    const pct = (v) => (v == null ? "—" : F.pct(v));
    const changed = (id) => {
      ctx.rerender();
      const el = document.getElementById(id);
      if (el) el.focus();
    };
    const notReady = () => html("p", { class: "empty", text: !sampled ? `No sampled pages for ${where.toLowerCase()} in this view (sampled cycles ${I.cycles[0]}–${last}).`
      : P === undefined ? "Loading the pages…" : "The page sample for this choice couldn't be loaded." });

    // The text switch runs the whole section; the main-content view also picks whose scores
    const viewSeg = html("div", { class: "seg", role: "group", "aria-label": "Which text" });
    for (const v of Object.keys(VIEWS)) {
      if (!views.includes(v)) continue;
      viewSeg.append(ctx.button({ id: `junk-v-${v}`, "aria-pressed": String(v === sel.view), text: VIEWS[v].label }, () => {
        sel.view = v;
        fitView();
        changed(`junk-v-${v}`);
      }));
    }
    const top = html("div", { class: "junk-rules junk-view" }, html("span", { class: "field-label", text: "Text" }), viewSeg);
    if (sel.view === "resil") {
      const src = html("select", { id: "junk-s", "aria-label": "Scores" });
      src.append(html("option", { value: "main", selected: sel.src === "main", text: "Scores on the main content" }));
      const o = html("option", { value: "crawler", selected: sel.src === "crawler", text: "The crawler's scores (whole page)" });
      if (!I.crawler_scores) o.disabled = true;
      src.append(o);
      src.addEventListener("change", () => {
        sel.src = src.value;
        changed("junk-s");
      });
      top.append(html("label", { class: "field", for: "junk-s" }, "Scores", src));
    }
    box.append(top, html("p", { class: "foot", text: (sel.view === "nutch" ? "The whole page as the crawler parses it, menus and all: what it scores and ranks by."
      : "The main content Jerry's pipeline extracts: what pretraining uses.") + " Everything below follows this switch, the ticked rules, and the cycle and per-cycle / cumulative choice at the top of the page." }));

    // Presets, then one box per rule.
    const seg = html("div", { class: "seg", role: "group", "aria-label": "Junk rule presets" });
    for (const k of Object.keys(PRESETS)) {
      if (PRESETS[k].nutch && sel.view !== "nutch") continue;
      seg.append(ctx.button({ id: `junk-p-${k}`, "aria-pressed": String(k === preset), text: PRESETS[k].label }, () => {
        setPreset(k);
        changed(`junk-p-${k}`);
      }));
    }
    const pick = html("div", { class: "junk-pick" }, html("div", { class: "junk-rules" }, html("span", { class: "field-label", text: "Junk = fails any ticked rule." }),
      html("span", { class: "field-label", text: "Presets" }), seg));
    const sets = html("div", { class: "junk-sets" });
    for (const s of SETS) {
      const fs = html("fieldset", { class: "junk-set" }, html("legend", { text: s.title }));
      for (const k of s.items) {
        if (k === "ngram6" && sel.view !== "nutch") continue;
        const cb = html("input", { type: "checkbox", id: `junk-r-${k}` });
        cb.checked = sel.items.has(k);
        cb.addEventListener("change", () => {
          if (cb.checked) sel.items.add(k);
          else sel.items.delete(k);
          changed(cb.id);
        });
        fs.append(html("label", { class: "junk-check", for: cb.id }, cb, html("span", { text: k === "ngram" && sel.view !== "nutch" ? LABEL.rep_ngram : LABEL[k] })));
      }
      if (s.items.includes("ngram") && sel.view === "nutch") {
        const t = html("select", { id: "junk-t", "aria-label": "N-gram threshold" });
        for (const v of THRESHOLDS) t.append(html("option", { value: v, selected: v === sel.t, text: v === 1 ? "×1 (DCLM's own)" : `×${v} looser` }));
        t.disabled = !sel.items.has("ngram") && !sel.items.has("ngram6");
        t.addEventListener("change", () => {
          sel.t = +t.value;
          changed("junk-t");
        });
        fs.append(html("label", { class: "junk-check junk-t", for: "junk-t" }, html("span", { text: "N-gram threshold" }), t));
      }
      sets.append(fs);
    }
    pick.append(sets);
    const n = sel.items.size;
    const lines = [preset ? PRESETS[preset].text + "." : `Your choice: ${n} rule${n === 1 ? "" : "s"}${sel.t !== 1 && (sel.items.has("ngram") || sel.items.has("ngram6")) ? `, n-gram threshold ×${sel.t}` : ""}.`];
    if (!n) lines.push("Tick at least one rule: with none, nothing counts as junk.");
    if (sel.view === "nutch") {
      if (sel.items.has("ngram") || sel.items.has("rep_lines") || sel.items.has("line_removal")) {
        lines.push("On whole-page text, DCLM's repetition checks and line cleanup mostly react to menus and other page furniture, which the main-content text leaves out: they flag a quarter to half of all pages, high-score or not.");
      } else if (sel.items.has("ngram6")) {
        lines.push("Repeated n-grams on lines of 6+ words leave out menus and buttons.");
      }
    } else {
      lines.push("Main-content text has the menus removed, so DCLM's repetition rules work as intended here. DCLM stops at the first repetition check a page fails, so a page with repeated lines isn't checked for n-grams: with both ticked the total is exact, the n-gram rule alone reads a little low.");
    }
    pick.append(html("p", { class: "foot", text: lines.join(" ") }));
    box.append(pick);

    const card = (o) => {
      const fig = html("figure", { class: "card" });
      const chartHost = html("div", { class: "chart", role: "group", "aria-label": o.title });
      chartHost.style.minHeight = o.height + "px";
      const tableHost = html("div", { hidden: true });
      const toggle = ctx.button({ class: "tbtn", "aria-pressed": "false", text: "Table" }, () => {
        const showTable = tableHost.hidden;
        if (showTable && !tableHost.firstChild) Charts.table(tableHost, o.table());
        tableHost.hidden = !showTable;
        chartHost.hidden = showTable;
        if (!showTable) Charts.resize(chartHost);
        toggle.textContent = showTable ? "Chart" : "Table";
        toggle.setAttribute("aria-pressed", String(showTable));
      });
      fig.append(html("div", { class: "card-head" }, html("div", {}, html("h3", { text: o.title }), html("p", { class: "sub", text: o.sub })), o.tool || null, o.table && toggle), chartHost, tableHost);
      if (o.foot) fig.append(html("p", { class: "foot", text: o.foot }));
      ctx.schedule(chartHost, o.draw);
      return fig;
    };

    // ---- Every crawled page: how much is junk, what kind, and how much of the high-scoring pages
    box.append(html("h3", { class: "subhead", text: "Every crawled page" }));
    const hs = html("select", { id: "junk-hs", "aria-label": "High-score score" });
    for (const [k, label] of Object.entries(HI_SCORES)) hs.append(html("option", { value: k, selected: k === sel.hiScore, text: label }));
    hs.addEventListener("change", () => {
      sel.hiScore = hs.value;
      fitCut(I);
      changed("junk-hs");
    });
    // one list: the training cut, then this run's own top pages, then fixed scores at ClueWeb22's percentiles
    const hc = html("select", { id: "junk-hc", "aria-label": "High-score cutoff" });
    const opt = (c) => {
      const o = html("option", { value: c, selected: c === sel.hiCut, text: cutLabel(I, c, sel.hiScore) });
      o.disabled = (c === "train" && sel.hiScore !== "fasttext") || (c !== "train" && cutOf(I, c).thr == null);
      return o;
    };
    hc.append(opt("train"),
      html("optgroup", { label: "Top pages of this run (its English pages, all cycles)" }, ...TOPS.map((n) => opt("own" + n))),
      html("optgroup", { label: sel.hiScore === "combined" ? "Fixed page score" : "Fixed score: ClueWeb22's percentiles" }, ...TOPS.map((n) => opt("cw" + n))));
    hc.addEventListener("change", () => {
      sel.hiCut = hc.value;
      changed("junk-hc");
    });
    box.append(html("div", { class: "junk-rules" }, html("span", { class: "field-label", text: "High score =" }),
      html("label", { class: "field", for: "junk-hs" }, "Score", hs), html("label", { class: "field", for: "junk-hc" }, "Cutoff", hc)));
    if (!sampled || !P) {
      box.append(notReady());
    } else {
      const V = compute(key, P, I, maxCycle);
      const val = (k) => (ctx.valueAt ? ctx.valueAt(k, N) : null);
      const notEn = sel.view === "nutch" ? null : val(cum ? "pipeline/not_english_pct_cumulative" : "pipeline/not_english_pct");
      const E = sel.view === "nutch" ? val(cum ? "text/english_pct_cumulative" : "text/english_pct") : notEn == null ? null : 100 - notEn;
      const total = sel.view === "nutch" ? val(cum ? "text/pages_parsed_cumulative" : "text/pages_parsed") : val(cum ? "pipeline/docs_cumulative" : "pipeline/docs");
      const one = (x) => (x == null ? null : Math.round(x * 10) / 10);
      const pieCard = (title, sub, slices, center, foot) => card({
        title, sub, height: 300,
        draw: (h) => Charts.pie(h, { name: title, slices: slices.filter((s) => s.value != null && s.value > 0), height: 300, center }),
        table: () => ({ columns: ["Slice", "% of pages"], rows: slices.map((s) => [s.label, pct(one(s.value))]) }),
        foot,
      });
      const pies = html("div", { class: "grid" });
      const A = V.pieA;
      if (A.n >= MIN_PAGES) {
        const eng = E == null ? 100 : E;
        const slicesA = [
          { label: "English, not junk", value: (eng * (A.n - A.hi - A.lo - A.bot)) / A.n, slot: 1 },
          { label: `Junk, ${hiCmp(I, "<")}`, value: (eng * A.lo) / A.n, slot: 4 },
          { label: `Junk, ${hiCmp(I, "≥")}`, value: (eng * A.hi) / A.n, slot: 8 },
          ...(A.bot ? [{ label: "Bot-check pages (junk, no score)", value: (eng * A.bot) / A.n, slot: 7 }] : []),
          ...(E == null ? [] : [{ label: sel.view === "nutch" ? "Not English" : "Not English or no main text", value: 100 - E, slot: "muted" }]),
        ];
        pies.append(pieCard("Where every crawled page goes", `${where} · ${E == null ? "English pages only (no English share for this cycle)" : "every page with text"}`, slicesA,
          total != null && E != null ? `<b>${F.count(total)}</b><br>pages` : "",
          `Junk = fails a ticked rule, split at the high-score cutoff picked above: ${hiText(I)}. ` +
            (A.bot ? `Bot-check pages (“Please wait while your request is being verified…”, ${F.count(A.bot)} sampled) are the crawler's call: ` +
              (I.bot_from === "rule" ? "this crawl stored no tags, so its bot-check rule is run on the text" : "its own bot-check tag") +
              "; they are under 50 words, so DCLM's length rule makes them junk, and they get no score, as in the crawl. " : "") +
            (sel.view === "resil" && sel.src === "crawler" ? "Other pages the crawl has no score for count as below the cutoff. " : "") +
            (sel.view === "nutch" ? "The English share counts every parsed page (the text job); "
            : "The English share is Jerry's pipeline count over every page with text; ") +
          `the junk split comes from ${F.count(A.n)} sampled ${sel.view === "nutch" ? "random " : ""}English pages.`));
      } else {
        pies.append(html("p", { class: "empty", text: `Too few sampled pages for ${where.toLowerCase()}.` }));
      }
      const R = V.groups.random;
      const kSum = R.kinds.reduce((t, v) => t + (v || 0), 0);
      if (kSum > 0) {
        pies.append(pieCard("What kind of junk", `${where} · junk pages, each under the first ticked rule it fails, in DCLM's order`,
          KINDS.map((k, i) => ({ label: k.label.replace("Junk: ", ""), value: R.kinds[i] == null ? null : (100 * R.kinds[i]) / kSum, slot: k.slot })),
          `<b>${pct(R.v)}</b><br>of English pages`, "Share of the junk pages, not of all pages. Kinds whose rules aren't ticked stay empty."));
      }
      const C = V.pieC;
      if (C.n >= MIN_PAGES && C.junk != null) {
        pies.append(pieCard("High-scoring pages: how much is junk", `${where} · ${hiText(I)}`,
          [{ label: "Not junk", value: 100 - C.junk, slot: 1 }, ...KINDS.map((k, i) => ({ label: k.label, value: C.kinds[i], slot: k.slot }))],
          `<b>${F.count(C.n)}</b><br>pages sampled`,
          (sel.view === "nutch" && I.has_high ? "Every high-score page is in the sample and 1 in 10 of the rest, so the others weigh 10. " : "") + "Each junk page under the first ticked rule it fails, in DCLM's order."));
      } else {
        pies.append(html("p", { class: "empty", text: `Fewer than ${MIN_PAGES} sampled pages with ${hiText(I)} in ${where.toLowerCase()}.` }));
      }
      box.append(pies);
    }
    // Main content: Jerry's exact counts over every page, with his rules, dedup and fastText cut (from the page)
    if (ctx.exact) {
      const ex = ctx.exact(sel.view);
      if (ex) box.append(ex);
    }

    // ---- Sampled pages, by score and priority
    box.append(html("h3", { class: "subhead", text: "Sampled pages, by score and priority" }));
    const ours = sel.view === "nutch" && !I.crawler_scores;
    const sample = sel.view === "nutch"
      ? (I.has_high ? "every page with a high score (page score ≥ 0.95, fastText ≥ 0.5 or FineWeb-Edu ≥ 0.6) and 1 in 10 of the rest, from every 10th part of each cycle"
        : "1 in 10 pages of every 10th part of each cycle (1 in 100 pages)") +
        (ours && I.crawler_page_score_only ? "; the crawl stored only its fastText page score (from the scorer before Jerry's Nov 4 fix), so the fastText and FineWeb-Edu scores here are ours, the fixed models on the same whole-page text"
          : ours ? "; the crawl stored no page scores, so the scores here are ours, the crawler's fastText models on the same whole-page text" : "")
      : "Jerry's main-content text (Resiliparse), English pages only: every 10th shard of the cycle and 1 in 10 of its pages by URL" +
        (sel.src === "main" ? "; scores are the crawler's fastText models run on this main-content text" : "; scores are the crawler's own, on the whole page");
    const inCycles = I.cycles.map((c, i) => [c, I.pages[i]]).filter(([c]) => (cum ? c <= N : c === N));
    const nPages = inCycles.reduce((t, [, n]) => t + n, 0);
    const pagesIn = !sampled ? `No sampled pages for ${where.toLowerCase()}.`
      : `${where}: ${F.count(nPages)} English pages sampled` + (cum ? `; the charts use a uniform subsample of them (${F.count(I.pooled)} pooled over all ${I.cycles.length} cycles).` : ".");
    box.append(html("p", { class: "blurb", text: `Sampled: ${sample}. ${pagesIn}` + (sel.view === "nutch" ? " Rates are weighted by how pages were sampled, so they stand for the whole cycle." : "") }));

    // Junk over cycles: computed on the cluster for each preset and each rule (custom rule sets need the per-page data)
    const trendKeys = [...Object.keys(PRESETS).filter((k) => !PRESETS[k].nutch || sel.view === "nutch"), ...RULE_ROWS];
    if (!trendKeys.includes(sel.trend)) sel.trend = preset && trendKeys.includes(preset) ? preset : "page";
    const tsel = html("select", { id: "junk-trend", "aria-label": "Rules in the chart over cycles" });
    for (const k of trendKeys) tsel.append(html("option", { value: k, selected: k === sel.trend, text: PRESETS[k] ? `Preset: ${PRESETS[k].label}` : LABEL[k] }));
    tsel.addEventListener("change", () => {
      sel.trend = tsel.value;
      changed("junk-trend");
    });
    const tg = [["random", sel.view === "nutch" ? "Random pages" : "Sampled pages", 1], ...(I.has_high ? [["high", "High-score pages", 2]] : [])];
    const tseries = tg.filter(([g]) => I.trend[g]).map(([g, label, slot]) => ({ label, slot, values: I.trend[g][sel.trend] }));
    box.append(card({
      title: "Junk share over cycles", sub: `% of pages failing ${PRESETS[sel.trend] ? `the “${PRESETS[sel.trend].label}” preset` : `“${LABEL[sel.trend]}”`}, each cycle`, height: 280,
      tool: html("label", { class: "field", for: "junk-trend" }, "Rules", tsel),
      draw: (h) => Charts.line(h, { name: "Junk share per cycle", x: I.cycles, series: tseries, unit: "pct", fmt: F.pct, height: 280, legend: true, xTitle: "Cycle", selectedX: N }),
      table: () => ({ columns: ["Cycle", ...tseries.map((s) => s.label), "Pages"], rows: I.cycles.map((c, i) => [String(c), ...tseries.map((s) => pct(s.values[i])), F.count(I.trend.random.n[i])]) }),
      foot: "Computed on the cluster from every sampled page, for each preset and each rule on its own; custom rule sets show in the charts below." +
        (sel.view === "nutch" && I.has_high ? " Random pages stand for the whole cycle; high-score pages are every page over a score cutoff." : ""),
    }));

    if (!sampled || !P) {
      box.append(notReady());
      return box;
    }
    const V = compute(key, P, I, maxCycle);
    // score bands: ranked within this run, or on ClueWeb22's table
    const scale = scaleOf(I);
    const bs = html("select", { id: "junk-bs", "aria-label": "Score bands" });
    bs.append(html("option", { value: "own", selected: scale === "own", disabled: !I.own_cuts?.[srcKey()], text: "Percentiles within this run (its English pages, all cycles)" }),
      html("option", { value: "cw", selected: scale === "cw", text: "Percentiles of ClueWeb22 (Jerry's table, what the crawler scores on)" }));
    bs.addEventListener("change", () => {
      sel.bandScale = bs.value;
      changed("junk-bs");
    });
    box.append(html("div", { class: "junk-rules" }, html("span", { class: "field-label", text: "Score bands =" }), html("label", { class: "field", for: "junk-bs" }, bs)));
    // the score each band starts at, for the tables
    const bandFrom = (k) => {
      if (k === "priority") return null;
      const cuts = scale === "own" ? I.own_cuts?.[srcKey()]?.[k] : k === "combined" ? I.band_edges : I.cw_cuts?.[k];
      return cuts ? BANDS.map((_, i) => (i === 0 ? "—" : k === "combined" && scale === "cw" ? cuts[i - 1].toFixed(2) : num(cuts[i - 1]))) : null;
    };
    const grid = html("div", { class: "grid" });
    const prioFoot = sel.view === "nutch"
      ? "Priority = the score the URL was put on the fetch list with, ranked among the cycle's parsed pages. In 233150 and prod it is the average page score of the fetched pages linking to it; in the OPIC crawls it is the OPIC cash."
      : "Priority = the score the URL was put on the fetch list with (joined from the crawl by URL), ranked among the cycle's sampled main-content pages.";
    for (const b of BAND_CHARTS) {
      const vals = V.bands[b.key];
      const series = [{ label: where, values: vals, slot: 1 }];
      const from = bandFrom(b.key);
      grid.append(card({
        title: b.title, sub: `% of pages failing any ticked rule, by band; ${where.toLowerCase()}`, height: 270,
        draw: (h) => Charts.line(h, { name: b.title, x: BANDS, series, unit: "pct", fmt: F.pct, height: 270, legend: false, xTitle: b.x[scale] }),
        table: () => ({ columns: ["Band", ...(from ? [`${HI_SCORES[b.key]} from`] : []), "Junk", "Pages sampled"],
          rows: BANDS.map((band, i) => [band, ...(from ? [from[i]] : []), pct(vals[i]), F.count(vals.n[i])]) }),
        foot: [b.key === "priority" ? prioFoot : b.foot[scale], "Bands with fewer than 30 sampled pages show no value."].filter(Boolean).join(" "),
      }));
    }

    // Junk share by score group, against random pages.
    const rows = GROUPS.map((g) => ({ label: g === "random" && sel.view !== "nutch" ? "Sampled pages" : groupLabel(g, scale), value: V.groups[g].v, extras: [F.count(V.groups[g].n)], muted: g === "random" }));
    grid.append(card({
      title: "Junk share by how the page scored", sub: `${where}; the mark is the share among ${sel.view === "nutch" ? "random" : "all sampled"} pages`, height: 300,
      draw: (h) => Charts.bars(h, { rows, fmt: F.pct, labelHead: "Pages", valueHead: "Junk", extras: ["Pages sampled"], ref: { value: V.groups.random.v, label: sel.view === "nutch" ? "Random pages" : "Sampled pages" } }),
      table: () => ({ columns: ["Pages", "Junk", "Pages sampled"], rows: rows.map((r, i) => [r.label, pct(V.groups[GROUPS[i]].v), F.count(V.groups[GROUPS[i]].n)]) }),
      foot: "“Only” = high on one score and under the other's cutoff; both high = fastText ≥ 0.5 and FineWeb-Edu ≥ 0.6. " +
        (scale === "own" ? "fastText and FineWeb-Edu top 1% = this run's top 1% of English pages" : "fastText and FineWeb-Edu top 1% = ClueWeb22's top 1% (about 0.2% of an OPIC crawl's pages)") +
        " (switch with Score bands above); priority top 1% = within the cycle.",
    }));

    // Which rules fire, each on its own: high-score pages, with random pages beside them. Grey = not ticked.
    const ticked = (r) => (r === "rep_ngram" ? sel.items.has("ngram") || sel.items.has("ngram6") : sel.items.has(r));
    const total = { label: "Any ticked rule (junk)", value: V.groups.any.v, extras: [pct(V.groups.random.v)], strong: true };
    const ruleRows = [total, ...RULE_ROWS.map((r) => ({ label: LABEL[r], value: V.groups.any.rules[r], muted: !ticked(r), extras: [pct(V.groups.random.rules[r])] }))];
    grid.append(card({
      title: "Which rules the pages fail", sub: `${where}: % of high-score and of ${sel.view === "nutch" ? "random" : "all sampled"} pages failing any ticked rule (top row), then each rule on its own`, height: 380,
      draw: (h) => Charts.bars(h, { rows: ruleRows, fmt: F.pct, labelHead: "Rule", valueHead: "High-score pages", extras: [sel.view === "nutch" ? "Random" : "All sampled"] }),
      table: () => ({ columns: ["Rule", "Counted", "High-score pages", sel.view === "nutch" ? "Random pages" : "All sampled pages", groupLabel("ft_top1", scale), groupLabel("edu_top1", scale), "Priority top 1%"],
        rows: [["Any ticked rule (junk)", "", pct(V.groups.any.v), pct(V.groups.random.v), pct(V.groups.ft_top1.v), pct(V.groups.edu_top1.v), pct(V.groups.prio_top1.v)],
          ...RULE_ROWS.map((r) => [LABEL[r], ticked(r) ? "yes" : "no", pct(V.groups.any.rules[r]), pct(V.groups.random.rules[r]), pct(V.groups.ft_top1.rules[r]), pct(V.groups.edu_top1.rules[r]), pct(V.groups.prio_top1.rules[r])])] }),
      foot: "The top row is the junk share for the ticked rules; a page can fail several rules, so the rows below add up to more. Each rule is at DCLM's thresholds; grey bars are rules not ticked. Repeated n-grams here are on the whole text at DCLM's threshold.",
    }));

    // Repetition at DCLM's threshold and looser (whole page only: the main-content sample has no repetition levels).
    if (sel.view === "nutch" && P.qfull) {
      const repSeries = REP_GROUPS.map((g, k) => ({ label: groupLabel(g, scale), values: REPS.map((t) => V.groups[g].rep[t]), slot: k + 1 }));
      grid.append(card({
        title: "Repeated n-grams at looser thresholds", sub: `${where}: % of pages over Gopher's n-gram limits, whole text`, height: 270,
        draw: (h) => Charts.line(h, { name: "Repeated n-grams by threshold", x: ["×1", "×1.5", "×2", "×3"], series: repSeries, unit: "pct", fmt: F.pct, height: 270, legend: true, xTitle: "Threshold, as a multiple of DCLM's (×1 = DCLM's own)" }),
        table: () => ({ columns: ["Pages", "×1 (DCLM)", "×1.5", "×2", "×3", "6+ word lines, ×1"],
          rows: REP_GROUPS.map((g) => [groupLabel(g, scale), ...REPS.map((t) => pct(V.groups[g].rep[t])), pct(V.groups[g].rep.prose)]) }),
        foot: `On lines of 6+ words only, at DCLM's threshold: ${REP_GROUPS.map((g) => `${groupLabel(g, scale)} ${pct(V.groups[g].rep.prose)}`).join(", ")}.`,
      }));
    }
    box.append(grid);

    // Example pages, picked across every cycle.
    const ex = I.examples || [];
    if (ex.length) {
      const head = html("tr", {}, ...["Rule failed", "Page", "Cycle", "Words", "fastText", "FineWeb-Edu", "Page score", "Priority pct."].map((c, k) => html("th", { scope: "col", class: k === 1 ? "junk-url" : null, text: c })));
      const body = ex.map((e) => {
        const ok = /^https?:\/\//i.test(e.url);
        const link = ok ? html("a", { href: e.url, target: "_blank", rel: "noopener noreferrer nofollow", text: e.url }) : html("span", { text: e.url });
        const v = (x) => (x == null ? "—" : String(x));
        return html("tr", {}, html("td", { text: LABEL[e.rule] || e.rule }), html("td", { class: "junk-url" }, link, e.title ? html("div", { class: "sub", text: e.title }) : null),
          html("td", { text: String(e.cycle) }), html("td", { text: e.words == null ? "—" : F.count(e.words) }), html("td", { text: v(e.fasttext) }),
          html("td", { text: v(e.edu) }), html("td", { text: v(e.combined) }), html("td", { text: v(e.priority_pct) }));
      });
      box.append(html("figure", { class: "card" },
        html("div", { class: "card-head" }, html("div", {}, html("h3", { text: "Examples: high-score pages that fail a page rule" }),
          html("p", { class: "sub", text: `Picked at random across every cycle, three per rule${sel.view === "resil" ? "; scores on the main content" : ""}. Not every one is a bad page.` }))),
        html("div", { class: "tbl-wrap" }, html("table", { class: "data junk-ex" }, html("thead", {}, head), html("tbody", {}, ...body)))));
    }
    return box;
  }

  return { has, load, render, param };
})();
