/* "Junk check": how much of the crawled text is junk by DCLM-Baseline's rules plus two of ours, and how that changes
   with the fastText, FineWeb-Edu and combined scores and with priority. Read from page text sampled on the cluster
   (junkdata.py builds data/raw/junk.js and, per run, data/raw/junk/<run>.js); runs without a sample don't get the section.

   The reader picks which rules count as junk. The per-run file holds one entry per sampled page (the rules it fails,
   how it was sampled, its score and priority bands, its repetition level), so every rate is recomputed in the browser
   for any set of rules. If that file can't load, the three preset definitions still work from data/raw/junk.js. */
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
  const data = () => window.CRAWL_JUNK;
  const has = (run) => !!(data() && data().runs[run]);
  const load = () => loadScript("data/raw/junk.js").then(() => !!data());

  // run -> decoded page arrays, or null when the file couldn't be loaded; missing while it loads
  const pages = new Map();
  const bytes = (s) => {
    const bin = atob(s);
    const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  };
  const u16 = (b) => {
    const out = new Uint16Array(b.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = b[2 * i] | (b[2 * i + 1] << 8); // little-endian, as junkdata.py writes it
    return out;
  };
  function loadPages(run) {
    return loadScript(`data/raw/junk/${run}.js`).then(() => {
      const raw = (window.CRAWL_JUNK_PAGES || {})[run];
      if (!raw) {
        pages.set(run, null);
        return;
      }
      pages.set(run, {
        n: raw.n, cycles: raw.cycles, rules: raw.rules, scores: raw.scores,
        mask: u16(bytes(raw.mask)), flags: bytes(raw.flags), bands: u16(bytes(raw.bands)), qfull: bytes(raw.qfull), qprose: bytes(raw.qprose),
      });
    });
  }

  // ---- Which rules count as junk -------------------------------------------------------------------------------------
  const PAGE = ["length", "word_length", "symbols", "bullets", "ellipsis", "non_alpha_words", "stop_words", "low_vocab", "repeated_term"];
  // "ngram" = DCLM's repeated n-gram check on the whole text, "ngram6" = the same on lines of 6+ words only
  const PRESETS = {
    page: { label: "Page rules", items: PAGE },
    prose: { label: "+ repetition in text", items: [...PAGE, "ngram6"] },
    dclm: { label: "DCLM as written", items: [...PAGE, "ngram", "rep_lines", "line_removal"] },
  };
  const SETS = [
    { title: "DCLM page rules", items: ["length", "word_length", "symbols", "bullets", "ellipsis", "non_alpha_words", "stop_words"] },
    { title: "Our rules", items: ["low_vocab", "repeated_term", "under10"] },
    { title: "DCLM repetition and line rules", items: ["ngram", "ngram6", "rep_lines", "line_removal"] },
  ];
  const ITEMS = SETS.flatMap((s) => s.items);
  const THRESHOLDS = [1, 1.25, 1.5, 2, 3];
  const sel = { items: new Set(PRESETS.page.items), t: 1 };
  let urlRead = false;

  const itemLabel = (D, k) => (k === "ngram" ? "Repeated n-grams, whole text" : k === "ngram6" ? "Repeated n-grams, lines of 6+ words" : D.rules[k]);
  const sameSet = (a, b) => a.size === b.length && b.every((x) => a.has(x));
  const presetOf = () => (sel.t === 1 ? Object.keys(PRESETS).find((k) => sameSet(sel.items, PRESETS[k].items)) : undefined);
  function setPreset(k) {
    sel.items = new Set(PRESETS[k].items);
    sel.t = 1;
  }
  // The choice is kept in the link: a preset by name, anything else as its rules (+ "t1.5" for a looser n-gram threshold).
  function param() {
    const p = presetOf();
    if (p) return p === "page" ? "" : p;
    return [...ITEMS.filter((k) => sel.items.has(k)), ...(sel.t !== 1 ? [`t${sel.t}`] : [])].join(",") || "none";
  }
  function readUrl() {
    const v = new URLSearchParams(location.search).get("junk");
    if (!v) return;
    if (PRESETS[v]) return setPreset(v);
    const items = new Set();
    let t = 1;
    for (const tok of v.split(",")) {
      if (ITEMS.includes(tok)) items.add(tok);
      else if (/^t[\d.]+$/.test(tok) && THRESHOLDS.includes(+tok.slice(1))) t = +tok.slice(1);
    }
    sel.items = items;
    sel.t = t;
  }

  // ---- Rates for the chosen rules -----------------------------------------------------------------------------------
  const GROUPS = ["random", "any", "comb", "ft_only", "edu_only", "both", "ft_top1", "edu_top1", "prio_top1"];
  const MIN_PAGES = 30; // as junkdata.py: fewer sampled pages show no value
  const cache = new Map();

  // Every sampled page counts by how it was sampled: high-score pages are all in the sample, the rest 1 in 10, so in any
  // set that mixes both the others weigh 10. Random pages are a plain 1-in-10 sample and count once each.
  function compute(run, P) {
    const key = `${run}|${param() || "page"}`;
    if (cache.has(key)) return cache.get(key);
    let M = 0;
    P.rules.forEach((r, i) => {
      if (sel.items.has(r)) M |= 1 << i;
    });
    const full = sel.items.has("ngram"), prose = sel.items.has("ngram6"), tq = Math.round(sel.t * 20);
    const nc = P.cycles.length, ns = P.scores.length;
    const G = Object.fromEntries(GROUPS.map((g) => [g, [0, 0, 0]])); // junk weight, weight, pages
    const B = new Float64Array(ns * (nc + 1) * 8 * 3);
    const add = (a, junk, w) => {
      a[0] += junk * w;
      a[1] += w;
      a[2] += 1;
    };
    for (let i = 0; i < P.n; i++) {
      const f = P.flags[i];
      const junk = (P.mask[i] & M) !== 0 || (full && P.qfull[i] > tq) || (prose && P.qprose[i] > tq) ? 1 : 0;
      const high = f & 2, ft = f & 4, edu = f & 8, cyc = (f >> 5) & 3;
      const w = high ? 1 : 10;
      if (f & 1) add(G.random, junk, 1);
      if (high) {
        add(G.any, junk, 1);
        if (f & 16) add(G.comb, junk, 1);
        if (ft && !edu) add(G.ft_only, junk, 1);
        if (edu && !ft) add(G.edu_only, junk, 1);
        if (ft && edu) add(G.both, junk, 1);
      }
      const bands = P.bands[i];
      for (let k = 0; k < ns; k++) {
        const b = (bands >> (4 * k)) & 15;
        if (b > 7) continue;
        if (b === 7) {
          if (k === 0) add(G.ft_top1, junk, w);
          else if (k === 1) add(G.edu_top1, junk, w);
          else if (k === 3) add(G.prio_top1, junk, w);
        }
        for (const c of [0, cyc + 1]) {
          const o = ((k * (nc + 1) + c) * 8 + b) * 3;
          B[o] += junk * w;
          B[o + 1] += w;
          B[o + 2] += 1;
        }
      }
    }
    const rate = (jw, w, n) => (n < MIN_PAGES ? null : Math.round((1000 * jw) / w) / 10);
    const out = { groups: {}, bands: {} };
    for (const g of GROUPS) out.groups[g] = { v: rate(...G[g]), n: G[g][2] };
    P.scores.forEach((s, k) => {
      const per = {};
      ["all", ...P.cycles.map(String)].forEach((c, ci) => {
        per[c] = [...Array(8).keys()].map((b) => {
          const o = ((k * (nc + 1) + ci) * 8 + b) * 3;
          return rate(B[o], B[o + 1], B[o + 2]);
        });
      });
      per.n = [...Array(8).keys()].map((b) => B[((k * (nc + 1)) * 8 + b) * 3 + 2]);
      out.bands[s] = per;
    });
    cache.set(key, out);
    return out;
  }
  // The same numbers for a preset, from the summary file (when the per-page file isn't there).
  function fromSummary(R, preset) {
    const out = { groups: {}, bands: {} };
    for (const g of GROUPS) out.groups[g] = { v: R.groups[g][preset], n: R.groups[g].n };
    for (const [s, per] of Object.entries(R.bands)) {
      out.bands[s] = { n: per.all.n };
      for (const c of ["all", ...R.cycles.map(String)]) out.bands[s][c] = per[c][preset];
    }
    return out;
  }

  // ---- Page ---------------------------------------------------------------------------------------------------------
  const SHORT = {
    length: "Under 50 / over 100k words", word_length: "Word length outside 3–10", symbols: "Too many # or ellipses",
    bullets: "90%+ of lines are bullets", ellipsis: "30%+ lines end in ellipsis", non_alpha_words: "20%+ words without a letter",
    stop_words: "Under 2 stop words", rep_ngram: "Repeated n-grams", rep_lines: "Repeated lines", line_removal: "Line cleanup takes 5%+",
    low_vocab: "Under 30% distinct words", repeated_term: "One term is 5%+ of words", under10: "Under 10 words",
  };
  const BAND_CHARTS = [
    { key: "fasttext", title: "Junk share by fastText percentile", x: "fastText percentile (Jerry's ClueWeb22 table)",
      foot: "fastText = the DCLM quality classifier's raw score, placed on the percentile table Jerry's crawls use for the page score." },
    { key: "edu", title: "Junk share by FineWeb-Edu percentile", x: "FineWeb-Edu percentile (Jerry's ClueWeb22 table)", foot: "" },
    { key: "combined", title: "Junk share by page score", x: "Page score × 100 (½ fastText + ½ FineWeb-Edu percentile)",
      foot: "The page score is the combined score the crawls rank by: the average of the two percentiles." },
    { key: "priority", title: "Junk share by priority", x: "Priority percentile within the cycle's fetched pages",
      foot: "Priority = the score the URL was put on the fetch list with. In 233150 it is the average page score of the fetched pages linking to it; in the OPIC crawls it is the OPIC cash. Ranked within each cycle, so the crawls can be compared." },
  ];

  function render(ctx) {
    const D = data();
    const R = D && D.runs[ctx.run];
    const box = html("div", { class: "junk" });
    if (!R) return box;
    if (!urlRead) {
      readUrl();
      urlRead = true;
    }
    if (!pages.has(ctx.run)) {
      pages.set(ctx.run, undefined);
      loadPages(ctx.run).then(() => ctx.rerender());
    }
    const P = pages.get(ctx.run);
    if (P === null && !presetOf()) setPreset("page"); // without the per-page file only the presets can be shown
    const preset = presetOf();
    const V = P ? compute(ctx.run, P) : preset ? fromSummary(R, preset) : null;
    const G = R.groups;
    const pct = (v) => (v == null ? "—" : F.pct(v));
    const changed = (id) => {
      ctx.rerender();
      const el = document.getElementById(id);
      if (el) el.focus();
    };

    box.append(html("p", { class: "blurb", text: `Sampled cycles ${R.cycles.join(", ")}: every page with a high score (combined ≥ 0.95, fastText ≥ 0.5 or FineWeb-Edu ≥ 0.6) and 1 in 10 of the rest, from every 10th part of each cycle; ${F.count(R.pages)} English pages. Rates are weighted by how pages were sampled, so they stand for the whole cycle.` }));

    // Presets, then one box per rule.
    const seg = html("div", { class: "seg", role: "group", "aria-label": "Junk rule presets" });
    for (const k of Object.keys(PRESETS)) {
      seg.append(ctx.button({ id: `junk-p-${k}`, "aria-pressed": String(k === preset), text: PRESETS[k].label }, () => {
        setPreset(k);
        changed(`junk-p-${k}`);
      }));
    }
    const pick = html("div", { class: "junk-pick" }, html("div", { class: "junk-rules" }, html("span", { class: "field-label", text: "Junk = fails any ticked rule." }),
      html("span", { class: "field-label", text: "Presets" }), seg));
    if (P) {
      const sets = html("div", { class: "junk-sets" });
      for (const s of SETS) {
        const fs = html("fieldset", { class: "junk-set" }, html("legend", { text: s.title }));
        for (const k of s.items) {
          const box_ = html("input", { type: "checkbox", id: `junk-r-${k}` });
          box_.checked = sel.items.has(k);
          box_.addEventListener("change", () => {
            if (box_.checked) sel.items.add(k);
            else sel.items.delete(k);
            changed(box_.id);
          });
          fs.append(html("label", { class: "junk-check", for: box_.id }, box_, html("span", { text: itemLabel(D, k) })));
        }
        if (s.items.includes("ngram")) {
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
    } else if (P === undefined) {
      pick.append(html("p", { class: "foot", text: "Loading the page sample, so rules can be picked one by one…" }));
    }
    const n = sel.items.size;
    const lines = [preset ? D.indicators[preset] + "." : `Your choice: ${n} rule${n === 1 ? "" : "s"}${sel.t !== 1 && (sel.items.has("ngram") || sel.items.has("ngram6")) ? `, n-gram threshold ×${sel.t}` : ""}.`];
    if (!n) lines.push("Tick at least one rule: with none, nothing counts as junk.");
    if (sel.items.has("ngram") || sel.items.has("rep_lines") || sel.items.has("line_removal")) {
      lines.push("On our text, DCLM's whole-page repetition checks and line cleanup mostly react to menus and other page furniture, which our parse text keeps and DCLM's main-content text would not: they flag a quarter to half of all pages, high-score or not.");
    } else if (sel.items.has("ngram6")) {
      lines.push("Repeated n-grams on lines of 6+ words leave out menus and buttons.");
    }
    pick.append(html("p", { class: "foot", text: lines.join(" ") }));
    box.append(pick);
    if (!V) {
      box.append(html("p", { class: "empty", text: "Loading…" }));
      return box;
    }

    const tile = (label, g) => html("div", { class: "tile" }, html("div", { class: "label", text: label }), html("div", { class: "value", text: pct(V.groups[g].v) }),
      html("div", { class: "delta", text: `${F.count(V.groups[g].n)} pages` }));
    box.append(html("section", { class: "kpis raw-tiles", "aria-label": "Junk share, sampled cycles together" },
      tile("Random pages", "random"), tile("Any high score", "any"), tile("Combined ≥ 0.95", "comb"),
      tile("fastText top 1%", "ft_top1"), tile("FineWeb-Edu top 1%", "edu_top1"), tile("Priority top 1%", "prio_top1")));

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
      fig.append(html("div", { class: "card-head" }, html("div", {}, html("h3", { text: o.title }), html("p", { class: "sub", text: o.sub })), o.table && toggle), chartHost, tableHost);
      if (o.foot) fig.append(html("p", { class: "foot", text: o.foot }));
      ctx.schedule(chartHost, o.draw);
      return fig;
    };
    const grid = html("div", { class: "grid" });

    // Junk share by score band: all sampled cycles together, and each cycle on its own (dotted).
    for (const b of BAND_CHARTS) {
      const per = V.bands[b.key];
      const x = D.bands;
      const series = [{ label: "Sampled cycles together", values: per.all, slot: 1 },
        ...R.cycles.map((c, k) => ({ label: `Cycle ${c}`, values: per[String(c)], slot: k + 2, dash: "dot" }))];
      grid.append(card({
        title: b.title, sub: b.key === "priority" ? `% of pages failing any ticked rule, by band; ${F.count(R.with_priority)} pages with a priority` : "% of pages failing any ticked rule, by band", height: 270,
        draw: (h) => Charts.line(h, { name: b.title, x, series, unit: "pct", fmt: F.pct, height: 270, legend: true, xTitle: b.x }),
        table: () => ({ columns: ["Band", ...series.map((s) => s.label), "Pages sampled (all cycles)"],
          rows: x.map((band, i) => [band, ...series.map((s) => pct(s.values[i])), F.count(per.n[i])]) }),
        foot: (b.foot ? b.foot + " " : "") + "Bands with fewer than 30 sampled pages show no value.",
      }));
    }

    // Junk share by score group, against random pages.
    const rows = GROUPS.map((g) => ({ label: G[g].label, value: V.groups[g].v, extras: [F.count(V.groups[g].n)], muted: g === "random" }));
    grid.append(card({
      title: "Junk share by how the page scored", sub: "Sampled cycles together; the mark is the share among random pages", height: 300,
      draw: (h) => Charts.bars(h, { rows, fmt: F.pct, labelHead: "Pages", valueHead: "Junk", extras: ["Pages sampled"], ref: { value: V.groups.random.v, label: "Random pages" } }),
      table: () => ({ columns: ["Pages", "Junk", "Pages sampled"], rows: GROUPS.map((g) => [G[g].label, pct(V.groups[g].v), F.count(V.groups[g].n)]) }),
      foot: "“Only” = high on one score and under the other's cutoff; both high = fastText ≥ 0.5 and FineWeb-Edu ≥ 0.6. Top 1% = the top percent of the fastText or FineWeb-Edu percentile table, or of priority within the cycle.",
    }));

    // Which rules fire, each on its own: high-score pages, with random pages beside them. Grey = not ticked.
    const ticked = (r) => (r === "rep_ngram" ? sel.items.has("ngram") || sel.items.has("ngram6") : sel.items.has(r));
    const how = (r) => {
      if (r !== "rep_ngram") return sel.items.has(r) ? "yes" : "no";
      const where = [sel.items.has("ngram") && "whole text", sel.items.has("ngram6") && "6+ word lines"].filter(Boolean);
      return where.length ? `yes (${where.join(", ")}${sel.t !== 1 ? `, ×${sel.t}` : ""})` : "no";
    };
    const ruleKeys = Object.keys(D.rules);
    const ruleRows = ruleKeys.map((r) => ({ label: SHORT[r] || D.rules[r], value: G.any.rules[r], muted: !ticked(r), extras: [pct(G.random.rules[r])] }));
    grid.append(card({
      title: "Which rules the pages fail", sub: "% of high-score pages failing each rule, and of random pages", height: 360,
      draw: (h) => Charts.bars(h, { rows: ruleRows, fmt: F.pct, labelHead: "Rule", valueHead: "High-score pages", extras: ["Random"] }),
      table: () => ({ columns: ["Rule", "Counted", "High-score pages", "Random pages", "fastText top 1%", "FineWeb-Edu top 1%", "Priority top 1%"],
        rows: ruleKeys.map((r) => [D.rules[r], how(r), pct(G.any.rules[r]), pct(G.random.rules[r]), pct(G.ft_top1.rules[r]), pct(G.edu_top1.rules[r]), pct(G.prio_top1.rules[r])]) }),
      foot: "Each rule on its own, at DCLM's thresholds; grey bars are rules not ticked. Repeated n-grams here are on the whole text. The table view adds the top-1% groups.",
    }));

    // Repetition at DCLM's threshold and looser.
    const reps = ["1", "1.5", "2", "3"];
    const repGroups = ["random", "any", "comb", "ft_top1", "edu_top1"];
    const repSeries = repGroups.map((g, k) => ({ label: G[g].label, values: reps.map((t) => G[g].rep[t]), slot: k + 1 }));
    grid.append(card({
      title: "Repeated n-grams at looser thresholds", sub: "% of pages over Gopher's n-gram limits, whole text", height: 270,
      draw: (h) => Charts.line(h, { name: "Repeated n-grams by threshold", x: ["×1", "×1.5", "×2", "×3"], series: repSeries, unit: "pct", fmt: F.pct, height: 270, legend: true, xTitle: "Threshold, as a multiple of DCLM's (×1 = DCLM's own)" }),
      table: () => ({ columns: ["Pages", "×1 (DCLM)", "×1.5", "×2", "×3", "6+ word lines, ×1"],
        rows: repGroups.map((g) => [G[g].label, ...reps.map((t) => pct(G[g].rep[t])), pct(G[g].rep.prose)]) }),
      foot: `On lines of 6+ words only, at DCLM's threshold: ${repGroups.map((g) => `${G[g].label} ${pct(G[g].rep.prose)}`).join(", ")}.`,
    }));
    box.append(grid);

    // Example pages.
    const ex = R.examples || [];
    if (ex.length) {
      const head = html("tr", {}, ...["Rule failed", "Page", "Cycle", "Words", "fastText", "FineWeb-Edu", "Page score", "Priority pct."].map((c, k) => html("th", { scope: "col", class: k === 1 ? "junk-url" : null, text: c })));
      const body = ex.map((e) => {
        const ok = /^https?:\/\//i.test(e.url);
        const link = ok ? html("a", { href: e.url, target: "_blank", rel: "noopener noreferrer nofollow", text: e.url }) : html("span", { text: e.url });
        return html("tr", {}, html("td", { text: e.rule }), html("td", { class: "junk-url" }, link, e.title ? html("div", { class: "sub", text: e.title }) : null),
          html("td", { text: String(e.cycle) }), html("td", { text: e.words == null ? "—" : F.count(e.words) }), html("td", { text: String(e.fasttext) }),
          html("td", { text: String(e.edu) }), html("td", { text: String(e.combined) }), html("td", { text: e.priority_pct == null ? "—" : `${e.priority_pct}` }));
      });
      box.append(html("figure", { class: "card" },
        html("div", { class: "card-head" }, html("div", {}, html("h3", { text: "Examples: high-score pages that fail a page rule" }),
          html("p", { class: "sub", text: "Picked at random, three per rule. Not every one is a bad page." }))),
        html("div", { class: "tbl-wrap" }, html("table", { class: "data junk-ex" }, html("thead", {}, head), html("tbody", {}, ...body)))));
    }
    return box;
  }

  return { has, load, render, param };
})();
