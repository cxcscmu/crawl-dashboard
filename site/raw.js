/* "Raw data check": numbers read straight from a crawl's segments and WARC index on the cluster (rawdata.py builds the
   files in data/raw/). It answers what the W&B metrics can't: why a domain's counts disagree, what its pages look like,
   and how priority relates to the page score inside one domain. Runs without these files don't get the section. */
"use strict";

const Raw = (() => {
  const { html, formats: F } = Charts;
  const loads = new Map();

  // Data files are scripts that fill a global, so the page also works when opened from disk.
  function load(src, ready) {
    if (ready() !== undefined) return Promise.resolve(ready());
    if (!loads.has(src)) {
      loads.set(src, new Promise((resolve) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = () => resolve(ready());
        s.onerror = () => resolve(undefined);
        document.head.append(s);
      }));
    }
    return loads.get(src);
  }
  const index = (run) => (window.CRAWL_RAW || {})[run];
  const has = (run) => !!index(run);
  const loadIndex = (run) => load(`data/raw/${run}.js`, () => index(run)).then(Boolean);
  const loadDomains = (run, cycle) => load(`data/raw/${run}/domains-c${cycle}.js`, () => (window.CRAWL_RAW_DOM || {})[`${run}/${cycle}`]);
  const fileName = (domain) => domain.toLowerCase().replace(/[^a-z0-9.-]/g, "_").slice(0, 120);
  const loadExamples = (run, cycle, domain) =>
    load(`data/raw/${run}/ex-c${cycle}/${domain ? fileName(domain) : "_cycle"}.js`, () => (window.CRAWL_RAW_EX || {})[`${run}/${cycle}/${domain}`]);

  const fmt = { int: F.int, pct: F.pct, corr: F.corr, score: F.score, num: F.num };
  const show = (v, kind) => (v == null || v === "" ? "—" : kind === "text" ? v : fmt[kind](v));

  // Domain table columns: [label, format, derive?]. Columns a cycle's file doesn't hold are left out.
  const COLS = {
    cdx200: ["HTTP 200 in WARC index", "int"],
    records: ["Parse records", "int"],
    urls: ["Distinct URLs", "int"],
    extra: ["Repeat records", "int", (T, i) => (T.records && T.records[i] != null ? T.records[i] - T.urls[i] : null)],
    lang_en: ["English pages", "int"],
    enOver: ["English minus 200s", "int", (T, i) => T.lang_en[i] - T.cdx200[i]],
    bot: ["Bot-check pages", "int"],
    jscss: ["JS/CSS files", "int"],
    other_lang: ["Other-language pages", "int"],
    via_redirect: ["Reached by redirect", "int"],
    cause: ["What stands out", "text"],
    listed: ["URLs on fetch list", "int"],
    fetches: ["Fetches", "int"],
    f_success: ["Success", "int"],
    f_redir: ["Redirect", "int"],
    f_gone: ["Gone", "int"],
    f_retry: ["Retry", "int"],
    failRate: ["Failed", "pct", (T, i) => (T.fetches[i] > 0 ? (100 * (T.f_gone[i] + T.f_retry[i])) / T.fetches[i] : null)],
    pairs: ["Scored pairs", "int"],
    spearman: ["Spearman ρ", "corr"],
    pearson: ["Pearson r", "corr"],
    priority_mean: ["Mean priority", "score"],
    score_mean: ["Mean page score", "score"],
    parsed: ["Parsed pages", "int"],
    outlinks: ["Outlinks", "int"],
    perPage: ["Outlinks per page", "num", (T, i) => (T.parsed[i] > 0 ? T.outlinks[i] / T.parsed[i] : null)],
    crossPct: ["Leave the domain", "pct", (T, i) => (T.outlinks[i] > 0 ? (100 * T.outlinks_cross[i]) / T.outlinks[i] : null)],
  };
  const MODES = {
    mismatch: {
      label: "Count mismatches", sort: "extra",
      cols: ["cdx200", "records", "urls", "extra", "lang_en", "enOver", "bot", "jscss", "other_lang", "via_redirect", "cause"],
      note: "HTTP 200s come from the WARC index, which holds each URL once. Parse records and English pages come from parse_data, where a page is written again every time another URL redirects to it. Bot-check pages are 200 responses the scorer tagged as a challenge page (“Just a moment…”); they score 0 and count as not English.",
    },
    fetch: {
      label: "Fetch outcomes", sort: "fetches", cols: ["listed", "fetches", "f_success", "f_redir", "f_gone", "f_retry", "failRate"],
      note: "Listed = URLs the generator put on this cycle's fetch list for the domain (250 at most). Fetches can exceed it: redirect targets are fetched in the same cycle. Failed = gone + retry, as a share of fetches. Redirect targets saved for a later cycle (“linked”) are not fetches and are not counted.",
    },
    priority: {
      label: "Priority vs score", sort: "pairs", cols: ["pairs", "spearman", "pearson", "priority_mean", "score_mean"],
      note: "Within one domain: the priority a URL was selected with against the fastText page score it got once fetched. Ranking by a correlation keeps domains with 30+ scored pairs.",
    },
    links: {
      label: "Links", sort: "outlinks", cols: ["parsed", "outlinks", "perPage", "crossPct"],
      note: "Links found on the domain's own pages. parse_data keeps at most 100 per page.",
    },
  };
  const GROUPS = [
    ["top_score", "Highest page score"], ["bottom_score", "Lowest page score"], ["top_priority", "Highest priority on the fetch list"],
    ["bottom_priority", "Lowest priority on the fetch list"], ["random_parsed", "Random parsed pages"], ["random_listed", "Random from the fetch list"],
  ];
  const STATUS = {
    fetch_success: "fetched OK", fetch_redir_perm: "permanent redirect", fetch_redir_temp: "temporary redirect",
    fetch_gone: "gone", fetch_retry: "temporary error", fetch_notmodified: "not modified",
  };
  const GROUP_OF = {
    listed_top_priority: "top_priority", listed_bottom_priority: "bottom_priority", listed_random: "random_listed",
    parsed_top_score: "top_score", parsed_bottom_score: "bottom_score", parsed_random: "random_parsed",
  };
  const groupOf = (g) => GROUP_OF[g] || g.replace(/^global_/, "");
  const ui = { mode: "mismatch", sort: "extra", ascending: false, query: "" };

  const value = (T, key, i) => (COLS[key][2] ? COLS[key][2](T, i) : T[key] ? T[key][i] : null);
  const available = (T, key) => (COLS[key][2] ? COLS[key][2](T, 0) !== undefined && (key !== "extra" || !!T.records) : !!T[key]);

  function safeUrl(u) {
    try {
      const x = new URL(u);
      return ["http:", "https:"].includes(x.protocol) && !x.username && !x.password ? x.href : null;
    } catch { return null; }
  }

  // ---- Example pages ----------------------------------------------------------------------------------------------
  function exampleList(rows, hasPriority, repeats) {
    const box = html("div", { class: "raw-examples" });
    for (const [id, label] of GROUPS) {
      if (!hasPriority && id.includes("priority")) continue;
      const pages = rows.filter((r) => r.groups.some((g) => groupOf(g) === id));
      if (!pages.length) continue;
      const list = html("ul", { class: "page-examples" });
      for (const p of pages) {
        const facts = [];
        // Four decimals: the top of a fetch list sits at 0.9999, which three would show as 1.000.
        if (hasPriority && p.priority != null) facts.push(`priority ${p.priority.toFixed(4)}`);
        if (p.parsed && p.score != null) facts.push(`page score ${p.score.toFixed(4)}`);
        if (p.lang) facts.push(p.lang === "interstitial" ? "bot-check page" : `language ${p.lang}`);
        if (p.status) facts.push(STATUS[p.status] || p.status);
        else if (p.listed && !p.parsed) facts.push("on the fetch list, no fetch record under this URL");
        if (p.parsed) facts.push(p.in_cdx200 ? "in WARC index as 200" : "not in WARC index as 200");
        if (p.parsed && p.outlinks >= 0) facts.push(`${p.outlinks} outlinks`);
        const href = safeUrl(p.url);
        const item = html("li", {}, href ? html("a", { href, target: "_blank", rel: "noopener noreferrer", text: p.title || p.url }) : html("span", { text: p.title || p.url }),
          p.title && html("div", { class: "example-url", text: p.url }), html("p", { class: "foot", text: facts.join(" · ") }));
        if (!p.text) {
          const to = /lastModified=\d+: (\S+)/.exec(p.pst || "");
          const why = (p.status || "").startsWith("fetch_redir") ? `No text under this URL: it redirects${to ? " to " + to[1] : ""}, and the text is stored under the page it leads to.`
            : p.status === "fetch_gone" ? "No text: the server answered that the page is gone or access is denied."
            : p.status === "fetch_retry" ? "No text: the fetch hit a temporary error."
            : !p.status ? "No text: the URL was on the fetch list, but the segment has no fetch record for it."
            : p.parsed ? "No text was stored for this page." : "No text: the page was fetched but not parsed.";
          item.append(html("p", { class: "foot", text: why }));
        }
        if (p.text) {
          const pre = html("pre", { class: "page-text" });
          const d = html("details", {}, html("summary", { text: `Crawled text (${F.int(p.chars)} characters${p.chars > p.text.length ? `, first ${F.int(p.text.length)} shown` : ""})` }), pre);
          d.addEventListener("toggle", () => { if (d.open && !pre.textContent) pre.textContent = p.text; });
          item.append(d);
        }
        list.append(item);
      }
      const few = repeats && id.endsWith("_score") && pages.length < 10 &&
        html("p", { class: "foot", text: "Fewer than 10: this domain's pages are written several times in parse_data (once per redirect), and the 10 picks were copies of these URLs." });
      box.append(html("details", { class: "raw-group", open: id === "top_score" }, html("summary", { text: `${label} (${pages.length})` }), few, list));
    }
    if (!box.childElementCount) box.append(html("p", { class: "empty", text: "No example pages." }));
    return box;
  }

  // ---- Section ----------------------------------------------------------------------------------------------------
  // ctx: { run, cycle, button, schedule(host, draw), openPanel(title, fill, opener), rerender() }
  function render(ctx) {
    const R = index(ctx.run);
    const box = html("div", { class: "raw" });
    if (!R) return box;
    const cycle = R.cycles.includes(ctx.cycle) ? ctx.cycle : R.cycles.at(-1);
    const S = R.summary[cycle];
    const U = S.url_level;
    const hasPriority = S.spearman_pages != null;
    const series = (f) => R.cycles.map((c) => f(R.summary[c], c) ?? null);

    box.append(html("p", { class: "blurb", text: `Cycle ${cycle} of ${R.label}, cycles ${R.cycles[0]}–${R.cycles.at(-1)} read. ` + (cycle !== ctx.cycle ? `(Cycle ${ctx.cycle} hasn't been read from the raw data.) ` : "") + "Domain rows cover domains with 3 or more pages in the cycle." }));

    const tile = (label, v, note) => html("div", { class: "tile" }, html("div", { class: "label", text: label }), html("div", { class: "value", text: v }), html("div", { class: "delta", text: note || "" }));
    const tiles = html("section", { class: "kpis raw-tiles", "aria-label": `Cycle ${cycle} raw-data summary` },
      tile("URLs on the fetch list", F.count(S.counts.list_urls), `${F.count(S.counts.f_success)} fetched OK`),
      tile("HTTP 200 in WARC index", F.count(S.counts.cdx200), `${F.count(S.counts.parse_pages)} parse records`));
    if (U) {
      tiles.append(
        tile("Repeat parse records", F.count(U.records - U.urls), U.repeat_urls ? `${F.pct((100 * U.repeat_urls_redirect_targets) / U.repeat_urls)} of repeated URLs are redirect targets` : ""),
        tile("Fetched, not on the fetch list", F.count(U.unlisted_urls), U.unlisted_urls ? `${F.pct((100 * U.unlisted_redirect_targets) / U.unlisted_urls)} are redirect targets` : ""),
        tile("Bot-check pages", F.count(U.bot_pages), `on ${F.count(U.bot_domains)} domains, all scored 0`));
    }
    tiles.append(tile("Priority vs page score", hasPriority ? F.corr(S.spearman_pages) : "n/a", hasPriority ? `Spearman, all pages; ${F.corr(S.spearman_within_median)} within a domain` : "seed cycle: every priority is 0"));
    box.append(tiles);

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
    const seriesTable = (x, xLabel, list, f) => () => ({ columns: [xLabel, ...list.map((s) => s.label)], rows: x.map((c, i) => [String(c), ...list.map((s) => show(s.values[i], f))]) });
    const grid = html("div", { class: "grid" });

    const corr = [
      { label: "All pages", slot: 1, values: series((s) => s.spearman_pages) },
      { label: "Domain averages", slot: 2, values: series((s) => s.spearman_domain_means) },
      { label: "Within one domain (median)", slot: 3, values: series((s) => s.spearman_within_median) },
    ];
    grid.append(card({
      title: "Priority vs page score", sub: "Spearman correlation per cycle", height: 260,
      draw: (h) => Charts.line(h, { name: "Priority vs page score per cycle", x: R.cycles, series: corr, unit: "corr", fmt: F.corr, height: 260, legend: true, selectedX: cycle }),
      table: seriesTable(R.cycles, "Cycle", corr, "corr"),
      foot: "Priority = the score a URL was selected with; page score = the run's combined quality score for the page once fetched. Domain averages compare each domain's mean priority with its mean score (10+ scored pages); within one domain uses domains with 30+ scored pairs" +
        (hasPriority ? `, ${F.pct(S.spearman_within_negative_pct)} of which are negative in cycle ${cycle}.` : ".") + " The first cycle is the seed list, where every priority is 0.",
    }));
    if (S.hist) {
      // The extract keeps a 40 x 40 grid of page counts (priority band x score band); the quartiles of the page score
      // in each priority band are read off that grid. Bands with under 1,000 pages are left out.
      const n = S.hist.length;
      const quantile = (row, total, q) => {
        let seen = 0;
        for (let j = 0; j < n; j++) {
          if (seen + row[j] >= q * total) return (j + (row[j] ? (q * total - seen) / row[j] : 0)) / n;
          seen += row[j];
        }
        return 1;
      };
      const bands = S.hist.map((row, k) => ({ k, row, total: row.reduce((t, v) => t + v, 0) })).filter((r) => r.total >= 1000);
      const bandLabel = (k) => F.num(k / n);
      const px = bands.map((r) => bandLabel(r.k));
      const q = (f) => bands.map((r) => quantile(r.row, r.total, f));
      const median = [{ label: "Median page score", slot: 1, values: q(0.5) }];
      grid.append(card({
        title: `Page score by priority, cycle ${cycle}`, sub: "Do higher-priority pages score higher once fetched?", height: 280,
        draw: (h) => Charts.line(h, {
          name: `Median page score for each priority band in cycle ${cycle}`, x: px, series: median, unit: "score", fmt: F.score, height: 280, legend: true, xHoverFormat: ".3f", xTitle: `Priority the URL was selected with (start of each ${F.num(1 / n)}-wide band)`,
          band: { lo: q(0.25), hi: q(0.75), label: "Middle half of pages", loLabel: "25th percentile", hiLabel: "75th percentile", slot: 1 },
        }),
        table: () => ({ columns: ["Priority", "Pages", "25th percentile", "Median", "75th percentile"], rows: bands.map((r, i) => [px[i], F.int(r.total), F.score(q(0.25)[i]), F.score(q(0.5)[i]), F.score(q(0.75)[i])]) }),
        foot: `${F.count(S.counts.pairs)} scored pages that were on the fetch list, grouped into priority bands ${F.num(1 / n)} wide. Hover a point for that band's median and middle half. A flat line would mean priority tells nothing about the score.`,
      }));
    }
    const bx = S.buckets.map((b) => b.label);
    const share = (k) => S.buckets.map((b) => { const t = b.f_success + b.f_redir + b.f_gone + b.f_retry; return t ? (100 * b[k]) / t : null; });
    const outcome = [{ label: "Gone", slot: 8, values: share("f_gone") }, { label: "Retry", slot: 4, values: share("f_retry") }, { label: "Redirect", slot: "muted", values: share("f_redir") }];
    grid.append(card({
      title: `Fetch outcome by fetch-list size, cycle ${cycle}`, sub: "% of fetches that did not return a page", height: 260,
      draw: (h) => Charts.stack(h, { name: "Share of fetches that were gone, retried or redirected, by the number of URLs listed for the domain", x: bx, series: outcome, unit: "pct", fmt: F.pct, height: 260, legend: true, xTitle: "URLs on the fetch list for the domain" }),
      table: seriesTable(bx, "URLs listed", [...outcome, { label: "Domains", values: S.buckets.map((b) => b.domains) }], "num"),
      foot: "Gone = the server says the page doesn't exist or access is denied; retry = a temporary error. The rest of each column, up to 100%, is successful fetches.",
    }));
    const kinds = [["bot", "Bot-check page", 8], ["other_lang", "Another language", 1], ["jscss", "JS/CSS file", 4], ["unknown", "Language not detected", 7], ["untagged", "Other file, no tag", "muted"]];
    const withUrl = R.cycles.filter((c) => R.summary[c].url_level);
    if (withUrl.length) {
      const noEn = kinds.map(([k, label, slot]) => ({ label, slot, values: withUrl.map((c) => R.summary[c].url_level.no_en_kinds[k]) }));
      grid.append(card({
        title: "Pages on domains with no English page", sub: "Parse records per cycle, by what the page is", height: 260,
        draw: (h) => Charts.stack(h, { name: "Pages on domains with no English page, by kind, per cycle", x: withUrl, series: noEn, unit: "count", fmt: F.count, height: 260, legend: true, selectedX: cycle }),
        table: seriesTable(withUrl, "Cycle", noEn, "int"),
        foot: U ? `Cycle ${cycle}: ${F.int(U.no_en_domains)} domains with ${F.int(U.no_en_pages)} pages. Bot-check pages are 200 responses holding a challenge page; JS/CSS files come from CDN hosts.` : "",
      }));
      const unl = [
        { label: "Redirect target", slot: 1, values: withUrl.map((c) => R.summary[c].url_level.unlisted_redirect_targets) },
        { label: "Other", slot: "muted", values: withUrl.map((c) => R.summary[c].url_level.unlisted_urls - R.summary[c].url_level.unlisted_redirect_targets) },
      ];
      grid.append(card({
        title: "Pages fetched without being on the fetch list", sub: "Distinct URLs per cycle", height: 260,
        draw: (h) => Charts.stack(h, { name: "Fetched pages that were not on the fetch list, per cycle", x: withUrl, series: unl, unit: "count", fmt: F.count, height: 260, legend: true, selectedX: cycle }),
        table: seriesTable(withUrl, "Cycle", unl, "int"),
        foot: "The fetcher follows a redirect in the same cycle, so the target is fetched without passing the generator's per-domain limit. A target is written once for every URL that redirects to it.",
      }));
    }
    box.append(grid);

    // ---- Domains
    box.append(html("h3", { class: "raw-h", text: `Domains, cycle ${cycle}` }));
    const modes = html("div", { class: "explorer-modes", role: "group", "aria-label": "Domain view" });
    for (const [id, m] of Object.entries(MODES)) {
      modes.append(ctx.button({ class: "tab", "data-rawmode": id, "aria-pressed": String(id === ui.mode), text: m.label }, () => {
        Object.assign(ui, { mode: id, sort: m.sort, ascending: false });
        ctx.rerender();
      }));
    }
    const mode = MODES[ui.mode];
    const search = html("input", { type: "search", class: "search", placeholder: "Search a domain…", "aria-label": "Search a domain", value: ui.query });
    const sort = html("select", { "aria-label": "Rank domains by" });
    const order = ctx.button({ class: "tbtn", text: ui.ascending ? "Lowest first" : "Highest first" }, () => { ui.ascending = !ui.ascending; order.textContent = ui.ascending ? "Lowest first" : "Highest first"; update(); });
    const status = html("span", { class: "count", role: "status", text: "Loading domains…" });
    const output = html("div");
    let T = null;
    let update = () => {};
    box.append(modes, html("p", { class: "explorer-note", text: mode.note }), html("div", { class: "search-row" }, search, html("label", { class: "field" }, "Rank by", sort), order, status), output);

    loadDomains(ctx.run, cycle).then((table) => {
      if (!table) { status.textContent = "The domain table for this cycle couldn't be loaded."; return; }
      T = table;
      const cols = mode.cols.filter((k) => available(T, k));
      const sortable = cols.filter((k) => COLS[k][1] !== "text");
      if (!sortable.includes(ui.sort)) ui.sort = sortable[0];
      for (const k of sortable) sort.append(html("option", { value: k, selected: k === ui.sort, text: COLS[k][0] }));
      const n = T.domain.length;
      update = () => {
        ui.query = search.value;
        ui.sort = sort.value;
        const q = search.value.trim().toLowerCase();
        const isCorr = ["spearman", "pearson"].includes(ui.sort);
        let rows = [];
        for (let i = 0; i < n; i++) {
          if (q && !T.domain[i].includes(q)) continue;
          const v = value(T, ui.sort, i);
          if (v == null || (isCorr && !(T.pairs[i] >= 30) && !q)) continue;
          rows.push([i, v]);
        }
        rows.sort((a, b) => (ui.ascending ? a[1] - b[1] : b[1] - a[1]) || T.domain[a[0]].localeCompare(T.domain[b[0]]));
        const total = rows.length;
        rows = rows.slice(0, 100);
        status.textContent = total > 100 ? `Top 100 of ${F.int(total)} domains` : `${F.int(total)} domain${total === 1 ? "" : "s"}`;
        output.textContent = "";
        if (!total) { output.append(html("p", { class: "empty", text: q ? "No domain with 3+ pages in this cycle matches." : "Nothing to rank for this cycle." })); return; }
        const body = html("tbody");
        for (const [i] of rows) {
          body.append(html("tr", {}, html("th", { scope: "row" }, ctx.button({ class: "domain-link", text: T.domain[i] + (T.has_ex[i] ? " ▸" : "") }, (e) => openDomain(ctx, R, cycle, T, i, e.currentTarget))),
            ...cols.map((k) => html("td", { class: k === ui.sort ? "ranked-value" : k === "cause" ? "raw-cause" : "", text: show(value(T, k, i), COLS[k][1]) }))));
        }
        output.append(html("div", { class: "tbl-wrap", tabindex: "0", role: "region", "aria-label": "Domains, scroll horizontally for more columns" }, html("table", { class: "data explorer-table" },
          html("thead", {}, html("tr", {}, html("th", { scope: "col", text: "Domain" }), ...cols.map((k) => html("th", { scope: "col", text: COLS[k][0] })))), body)),
          html("p", { class: "foot", text: "▸ marks domains with example pages. Select a domain for its numbers and pages." }));
      };
      search.addEventListener("input", update);
      sort.addEventListener("change", update);
      update();
    });

    // ---- Whole-cycle examples
    box.append(html("h3", { class: "raw-h", text: `Example pages from the whole cycle ${cycle}` }));
    const exHost = html("div", {}, html("p", { class: "empty", text: "Loading example pages…" }));
    box.append(html("p", { class: "explorer-note", text: "Ten pages per group, picked over every domain in the cycle, with the text the crawler extracted." }), exHost);
    loadExamples(ctx.run, cycle, "").then((rows) => {
      exHost.textContent = "";
      exHost.append(rows ? exampleList(rows, hasPriority) : html("p", { class: "empty", text: "No example pages for this cycle." }));
    });
    return box;
  }

  // ---- Domain panel -----------------------------------------------------------------------------------------------
  // What the raw data holds for one domain in one cycle: example pages with their text first, then the numbers.
  function fillDomain(panel, run, R, cycle, T, i) {
    const domain = T.domain[i];
    const cause = T.cause && T.cause[i];
    panel.append(html("p", { text: `Cycle ${cycle}, read from the segment and the WARC index.` + (cause ? ` What stands out: ${cause}.` : "") }));
    panel.append(html("h3", { text: "Example pages with crawled text" }));
    const exHost = html("div", {}, html("p", { class: "empty", text: T.has_ex[i] ? "Loading example pages…" : `No example pages were extracted for this domain in this cycle. ${R.summary[cycle].example_domains.length} of the largest domains have them.` }));
    panel.append(exHost);
    if (T.has_ex[i]) {
      loadExamples(run, cycle, domain).then((rows) => {
        exHost.textContent = "";
        exHost.append(rows ? exampleList(rows, R.summary[cycle].spearman_pages != null, !!T.records && T.records[i] > T.urls[i]) : html("p", { class: "empty", text: "The example pages couldn't be loaded." }));
      });
    }
    for (const m of Object.values(MODES)) {
      const dl = html("dl", { class: "domain-facts" });
      for (const k of m.cols) {
        if (k === "cause" || !available(T, k)) continue;
        const v = show(value(T, k, i), COLS[k][1]);
        if (v !== "—") dl.append(html("dt", { text: COLS[k][0] }), html("dd", { text: v }));
      }
      if (dl.childElementCount) panel.append(html("h3", { text: m.label }), dl);
    }
    const histBox = html("div");
    const history = html("details", { class: "domain-history" }, html("summary", { text: "Raw-data numbers across cycles" }), histBox);
    history.addEventListener("toggle", () => {
      if (!history.open || histBox.firstChild) return;
      histBox.append(html("p", { class: "empty", text: "Loading…" }));
      Promise.all(R.cycles.map((c) => loadDomains(run, c))).then((tables) => {
        const keys = ["listed", "f_success", "cdx200", "records", "urls", "lang_en", "bot", "spearman"];
        Charts.table(histBox, {
          columns: ["Cycle", ...keys.map((k) => COLS[k][0])],
          rows: R.cycles.map((c, n) => {
            const t = tables[n];
            const j = t ? t.domain.indexOf(domain) : -1;
            return [String(c), ...keys.map((k) => (j < 0 || !available(t, k) ? "—" : show(value(t, k, j), COLS[k][1])))];
          }),
        });
        histBox.append(html("p", { class: "foot", text: "A dash means the domain had fewer than 3 pages in that cycle." }));
      });
    });
    panel.append(history);
  }

  function openDomain(ctx, R, cycle, T, i, opener) {
    ctx.openPanel(T.domain[i], (panel) => fillDomain(panel, ctx.run, R, cycle, T, i), opener);
  }

  // The same content for any other domain panel on the page (the Domain explorer's, the domain lists').
  function appendDomain(panel, run, cycle, domain) {
    const R = index(run);
    if (!R) return;
    const host = html("div", { class: "raw-in-panel" }, html("h3", { text: "From the raw crawl data" }));
    panel.append(host);
    if (!R.cycles.includes(cycle)) {
      host.append(html("p", { class: "empty", text: `Cycle ${cycle} hasn't been read from the raw data (cycles ${R.cycles[0]}–${R.cycles.at(-1)} have).` }));
      return;
    }
    const wait = html("p", { class: "empty", text: "Loading…" });
    host.append(wait);
    loadDomains(run, cycle).then((T) => {
      wait.remove();
      const i = T ? T.domain.indexOf(domain.toLowerCase()) : -1;
      if (i < 0) host.append(html("p", { class: "empty", text: `No raw-data row for this domain in cycle ${cycle} (it needs 3 or more pages in the cycle).` }));
      else fillDomain(host, run, R, cycle, T, i);
    });
  }

  return { has, loadIndex, render, appendDomain };
})();
