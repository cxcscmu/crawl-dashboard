/* "Junk check": how much of the crawled text is junk by DCLM-Baseline's rules plus two of ours, and how that changes
   with the fastText, FineWeb-Edu and combined scores and with priority. Read from page text sampled on the cluster
   (junkdata.py builds data/raw/junk.js); runs without a sample don't get the section. */
"use strict";

const Junk = (() => {
  const { html, formats: F } = Charts;
  let loading = null;
  const data = () => window.CRAWL_JUNK;
  const has = (run) => !!(data() && data().runs[run]);
  function load() {
    if (data()) return Promise.resolve(true);
    if (!loading) {
      loading = new Promise((resolve) => {
        const s = document.createElement("script");
        s.src = "data/raw/junk.js";
        s.onload = () => resolve(!!data());
        s.onerror = () => resolve(false); // optional: the page works without it
        document.head.append(s);
      });
    }
    return loading;
  }

  const ui = { indicator: "page" };
  const IND_LABEL = { page: "Page rules", prose: "+ repetition in text", dclm: "DCLM as written" };
  // Short rule names for the bar list, which has room for about 26 characters; the table view gives the full names.
  const SHORT = {
    length: "Under 50 / over 100k words", word_length: "Word length outside 3–10", symbols: "Too many # or ellipses",
    bullets: "90%+ of lines are bullets", ellipsis: "30%+ lines end in ellipsis", non_alpha_words: "20%+ words without a letter",
    stop_words: "Under 2 stop words", rep_ngram: "Repeated n-grams", rep_lines: "Repeated lines", line_removal: "Line cleanup takes 5%+",
    low_vocab: "Under 30% distinct words", repeated_term: "One term is 5%+ of words",
  };
  const GROUPS = ["random", "any", "comb", "ft_only", "edu_only", "both", "ft_top1", "edu_top1", "prio_top1"];
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
    const ind = ui.indicator;
    const G = R.groups;
    const pct = (v) => (v == null ? "—" : F.pct(v));
    const cycleList = R.cycles.join(", ");

    box.append(html("p", { class: "blurb", text: `Sampled cycles ${cycleList}: every page with a high score (combined ≥ 0.95, fastText ≥ 0.5 or FineWeb-Edu ≥ 0.6) and 1 in 10 of the rest, from every 10th part of each cycle; ${F.count(R.pages)} English pages. Rates are weighted by how pages were sampled, so they stand for the whole cycle.` }));

    // Which rules count as junk.
    const seg = html("div", { class: "seg", role: "group", "aria-label": "Junk rules" });
    for (const k of Object.keys(IND_LABEL)) {
      seg.append(ctx.button({ "aria-pressed": String(k === ind), text: IND_LABEL[k] }, () => {
        ui.indicator = k;
        ctx.rerender();
      }));
    }
    box.append(html("div", { class: "junk-rules" }, html("span", { class: "field-label", text: "Junk = fails any of" }), seg),
      html("p", { class: "foot", text: D.indicators[ind] + "." }));
    if (ind !== "page") {
      box.append(html("p", { class: "foot", text: ind === "dclm"
        ? "On our text DCLM's repetition checks and line cleanup mostly react to menus and other page furniture, which our parse text keeps and DCLM's main-content text would not: they flag a quarter to half of all pages, high-score or not."
        : "Repetition here is DCLM's repeated n-gram check on lines of 6+ words only, which leaves out menus and buttons." }));
    }

    const tile = (label, g, note) => html("div", { class: "tile" }, html("div", { class: "label", text: label }), html("div", { class: "value", text: pct(G[g][ind]) }),
      html("div", { class: "delta", text: note || `${F.count(G[g].n)} pages` }));
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
      const per = R.bands[b.key];
      const x = D.bands;
      const series = [{ label: "Sampled cycles together", values: per.all[ind], slot: 1 },
        ...R.cycles.map((c, k) => ({ label: `Cycle ${c}`, values: per[String(c)][ind], slot: k + 2, dash: "dot" }))];
      grid.append(card({
        title: b.title, sub: b.key === "priority" ? `% of pages failing any rule, by band; ${F.count(R.with_priority)} pages with a priority` : "% of pages failing any rule, by band", height: 270,
        draw: (h) => Charts.line(h, { name: b.title, x, series, unit: "pct", fmt: F.pct, height: 270, legend: true, xTitle: b.x }),
        table: () => ({ columns: ["Band", ...series.map((s) => s.label), "Pages sampled (all cycles)"],
          rows: x.map((band, i) => [band, ...series.map((s) => pct(s.values[i])), F.count(per.all.n[i])]) }),
        foot: (b.foot ? b.foot + " " : "") + "Bands with fewer than 30 sampled pages show no value.",
      }));
    }

    // Junk share by score group, against random pages.
    const rows = GROUPS.map((g) => ({ label: G[g].label, value: G[g][ind], extras: [F.count(G[g].n)], muted: g === "random" }));
    grid.append(card({
      title: "Junk share by how the page scored", sub: "Sampled cycles together; the mark is the share among random pages", height: 300,
      draw: (h) => Charts.bars(h, { rows, fmt: F.pct, labelHead: "Pages", valueHead: "Junk", extras: ["Pages sampled"], ref: { value: G.random[ind], label: "Random pages" } }),
      table: () => ({ columns: ["Pages", "Junk", "Pages sampled"], rows: GROUPS.map((g) => [G[g].label, pct(G[g][ind]), F.count(G[g].n)]) }),
      foot: "“Only” = high on one score and under the other's cutoff; both high = fastText ≥ 0.5 and FineWeb-Edu ≥ 0.6. Top 1% = the top percent of the fastText or FineWeb-Edu percentile table, or of priority within the cycle.",
    }));

    // Which rules fire: high-score pages, with the other groups as extra columns.
    // Rules the chosen junk definition counts; under "+ repetition in text" the n-gram check counts on 6+ word lines only.
    const counted = new Set(ind === "dclm" ? D.counted.dclm : D.counted.page);
    const note = (r) => (counted.has(r) ? "" : ind === "prose" && r === "rep_ngram" ? " (counted on 6+ word lines)" : " (not counted)");
    const ruleKeys = Object.keys(D.rules);
    const counts = (r) => counted.has(r) || (ind === "prose" && r === "rep_ngram");
    const ruleRows = ruleKeys.map((r) => ({ label: SHORT[r] || D.rules[r], value: G.any.rules[r], muted: !counts(r), extras: [pct(G.random.rules[r])] }));
    grid.append(card({
      title: "Which rules the pages fail", sub: "% of high-score pages failing each rule, and of random pages", height: 360,
      draw: (h) => Charts.bars(h, { rows: ruleRows, fmt: F.pct, labelHead: "Rule", valueHead: "High-score pages", extras: ["Random"] }),
      table: () => ({ columns: ["Rule", "Counted", "High-score pages", "Random pages", "fastText top 1%", "FineWeb-Edu top 1%", "Priority top 1%"],
        rows: ruleKeys.map((r) => [D.rules[r], note(r) ? note(r).replace(/[()]/g, "").trim() : "yes", pct(G.any.rules[r]), pct(G.random.rules[r]), pct(G.ft_top1.rules[r]), pct(G.edu_top1.rules[r]), pct(G.prio_top1.rules[r])]) }),
      foot: "Grey bars are rules the chosen junk definition doesn't count. Repeated n-grams here are on the whole text; “+ repetition in text” counts the same check on lines of 6+ words only. The table view adds the top-1% groups.",
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

  return { has, load, render };
})();
