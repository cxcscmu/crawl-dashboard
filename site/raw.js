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
  // A build with --packs K keeps each cycle's per-domain example pages in K files: the domain's is 32-bit FNV-1a of its
  // UTF-8 bytes, mod K (rawdata.py: pack_of).
  const packOf = (domain, packs) => {
    let h = 0x811c9dc5;
    for (const b of new TextEncoder().encode(domain)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
    return h % packs;
  };
  // The full build (every domain, example pages) is on Hugging Face (cx-cmu/crawl-pretrain, dashboard-raw-data/); the
  // site keeps a trimmed copy (3,000 domains per cycle, no example pages), which loads first. Example pages and "every
  // domain" come from the full copy when it's there; when it isn't (before the pull request is merged, or offline),
  // those requests fail quietly and the tab shows the trimmed copy alone. ?hfrev=refs/pr/3 tries an unmerged revision.
  const HF = `https://huggingface.co/datasets/cx-cmu/crawl-pretrain/resolve/${encodeURIComponent(new URLSearchParams(location.search).get("hfrev") || "main")}/dashboard-raw-data/`;
  const FULL = new Map(); // run -> Promise(full index or null); full.value once settled
  // The full index sets the same global as the site's, so keep the site's in place and file the full one apart.
  function loadFull(run) {
    if (!FULL.has(run)) {
      const entry = { value: undefined };
      entry.promise = new Promise((resolve) => {
        // the load event fires right after the script runs, so the site's index is back before anything renders
        const keep = (window.CRAWL_RAW || {})[run];
        const s = document.createElement("script");
        s.src = `${HF}${run}.js`;
        const done = (ok) => {
          const g = window.CRAWL_RAW || (window.CRAWL_RAW = {});
          entry.value = ok && g[run] && g[run] !== keep && g[run].example_packs ? g[run] : null;
          if (keep !== undefined) g[run] = keep;
          resolve(entry.value);
        };
        s.onload = () => done(true);
        s.onerror = () => done(false);
        document.head.append(s);
      });
      FULL.set(run, entry);
    }
    return FULL.get(run);
  }
  const fullOf = (run) => (FULL.get(run) || {}).value || null;
  const fullDom = new Map(); // "<run>/<cycle>" -> Promise(full domain table): replaces the trimmed table in the global
  const loadFullDomains = (run, cycle) => {
    const key = `${run}/${cycle}`;
    if (!fullDom.has(key)) {
      // one full table in memory at a time (CC's biggest is ~600k domains, ~120 MB in the browser): drop the others;
      // their cycles go back to the site's trimmed table and can load every domain again
      for (const k of [...fullDom.keys()]) {
        if (window.CRAWL_RAW_DOM) delete window.CRAWL_RAW_DOM[k];
        fullDom.delete(k);
      }
      fullDom.set(key, new Promise((resolve) => {
        const s = document.createElement("script");
        s.src = `${HF}${run}/domains-c${cycle}.js`;
        s.onload = () => resolve((window.CRAWL_RAW_DOM || {})[key] || null);
        s.onerror = () => resolve(null);
        document.head.append(s);
      }));
      fullDom.get(key).done = false;
      fullDom.get(key).then(() => { fullDom.get(key).done = true; });
    }
    return fullDom.get(key);
  };
  const exFile = (packs, domain) => (!domain ? "_cycle" : packs ? `p${String(packOf(domain, packs)).padStart(2, "0")}` : fileName(domain));
  // Example packs hold many domains (up to ~18 MB of text): keep the last PACKS_KEPT in memory, drop older ones (they
  // load again if their domains are opened again).
  const PACKS_KEPT = 6;
  const packOrder = []; // [{ src, keys }]
  function loadPack(src, key) {
    const ex = () => (window.CRAWL_RAW_EX || {})[key];
    if (ex() !== undefined) return Promise.resolve(ex());
    if (!loads.has(src)) {
      loads.set(src, new Promise((resolve) => {
        const before = new Set(Object.keys(window.CRAWL_RAW_EX || {}));
        const s = document.createElement("script");
        s.src = src;
        s.onload = () => {
          packOrder.push({ src, keys: Object.keys(window.CRAWL_RAW_EX || {}).filter((k) => !before.has(k)) });
          while (packOrder.length > PACKS_KEPT) {
            const old = packOrder.shift();
            for (const k of old.keys) delete window.CRAWL_RAW_EX[k];
            loads.delete(old.src);
          }
          resolve();
        };
        s.onerror = () => resolve();
        document.head.append(s);
      }));
    }
    return loads.get(src).then(ex);
  }
  // A domain's numbers across every cycle (hist_packs.py on the cluster): one file of about 12 MB per group of domains,
  // the domain's file is packOf(domain, meta.packs). The last HIST_KEPT files stay in memory.
  const HIST_KEPT = 2;
  const histOrder = []; // [{ src, key }]
  async function loadHistory(run, domain) {
    await loadFull(run).promise;
    if (!fullOf(run)) return null;
    const meta = await load(`${HF}${run}/hist/meta.js`, () => (window.CRAWL_RAW_HIST || {})[`${run}/meta`]);
    if (!meta) return null;
    const k = packOf(domain, meta.packs);
    const key = `${run}/${k}`;
    const src = `${HF}${run}/hist/h${String(k).padStart(3, "0")}.js`;
    const pack = await load(src, () => (window.CRAWL_RAW_HIST || {})[key]);
    if (!pack) return null;
    if (!histOrder.some((h) => h.src === src)) {
      histOrder.push({ src, key });
      while (histOrder.length > HIST_KEPT) {
        const old = histOrder.shift();
        delete window.CRAWL_RAW_HIST[old.key];
        loads.delete(old.src);
      }
    }
    return { cols: meta.cols, rows: pack[domain] || [] };
  }
  const loadExamples = (run, cycle, domain) => {
    const full = fullOf(run);
    const base = full ? `${HF}${run}` : `data/raw/${run}`;
    const packs = (full || index(run) || {}).example_packs;
    const src = `${base}/ex-c${cycle}/${exFile(packs, domain)}.js`;
    const ready = () => (window.CRAWL_RAW_EX || {})[`${run}/${cycle}/${domain}`];
    return domain && packs ? loadPack(src, `${run}/${cycle}/${domain}`) : load(src, ready);
  };

  const fmt = { int: F.int, pct: F.pct, corr: F.corr, score: F.score, num: F.num };
  const show = (v, kind) => (v == null || v === "" ? "—" : kind === "text" ? v : fmt[kind](v));

  // Domain table columns: [label, format, derive?]. Columns a cycle's file doesn't hold are left out.
  const COLS = {
    cdx200: ["HTTP 200 in WARC index", "int"],
    records: ["Parse records", "int"],
    urls: ["Distinct URLs", "int"],
    extra: ["Repeat records", "int", (T, i) => (T.records && T.records[i] != null ? T.records[i] - T.urls[i] : null)],
    lang_en: ["English pages", "int"],
    enOver: ["English minus 200s", "int", (T, i) => (T.lang_en ? T.lang_en[i] - T.cdx200[i] : undefined)], // no lang_en: crawl tags no languages
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
      note: "Within one domain: the priority a URL was selected with against the page score it got once fetched. Ranking by a correlation keeps domains with 30+ scored pairs.",
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
        // The link is the page's address; the title is plain text above it (titles can be long or spam).
        const title = (p.title || "").trim();
        const item = html("li", {}, title && html("div", { class: "example-title", text: title.length > 140 ? title.slice(0, 140) + "…" : title }),
          href ? html("a", { href, target: "_blank", rel: "noopener noreferrer", text: p.url }) : html("span", { text: p.url }),
          html("p", { class: "foot", text: facts.join(" · ") }));
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
    // the full copy on Hugging Face, once it has answered (example pages and every domain)
    if (!FULL.has(ctx.run)) loadFull(ctx.run).promise.then((full) => full && ctx.rerender());
    const RF = fullOf(ctx.run);
    const exOk = !R.examples_left_out || !!RF;
    const exDomains = new Set(((RF || R).summary[cycle] || {}).example_domains || []);
    const hasEx = (T, i) => (RF ? exDomains.has(T.domain[i]) : !!T.has_ex[i]);
    const domKey = `${ctx.run}/${cycle}`;
    const everyDomain = !!(fullDom.get(domKey) || {}).done;

    box.append(html("p", { class: "blurb", text: `Cycle ${cycle} of ${ctx.label || R.label}, cycles ${R.cycles[0]}–${R.cycles.at(-1)} read. ` + (cycle !== ctx.cycle ? `(Cycle ${ctx.cycle} hasn't been read from the raw data.) ` : "") +
      (everyDomain ? "Domain rows cover every domain with 3 or more pages in the cycle (the full copy on Hugging Face)." : R.domain_rows || "Domain rows cover domains with 3 or more pages in the cycle.") +
      (RF ? " Example pages with their text, and every domain on request, come from the full copy on Hugging Face (cx-cmu/crawl-pretrain, dashboard-raw-data/)."
        : R.examples_left_out ? " Example pages with their text are left out of this version, to keep the site within GitHub's size limit; every number here still counts every page."
        : R.example_cycles ? ` Example pages for single domains are kept for cycle${R.example_cycles.length > 1 ? "s" : ""} ${R.example_cycles.join(", ")}; the whole-cycle examples are there for every cycle${R.text_chars ? `, all with their first ${F.int(R.text_chars)} characters of text` : ""}.` : "") }));

    const tile = (label, v, note) => html("div", { class: "tile" }, html("div", { class: "label", text: label }), html("div", { class: "value", text: v }), html("div", { class: "delta", text: note || "" }));
    const tiles = html("section", { class: "kpis raw-tiles", "aria-label": `Cycle ${cycle} raw-data summary` },
      tile("URLs on the fetch list", F.count(S.counts.list_urls), `${F.count(S.counts.f_success)} fetched OK`),
      tile("HTTP 200 in WARC index", F.count(S.counts.cdx200), `${F.count(S.counts.parse_pages)} parse records`));
    if (U) {
      tiles.append(
        tile("Repeat parse records", F.count(U.records - U.urls), U.repeat_urls ? `${F.pct((100 * U.repeat_urls_redirect_targets) / U.repeat_urls)} of repeated URLs are redirect targets` : ""),
        tile("Fetched, not on the fetch list", F.count(U.unlisted_urls), U.unlisted_urls ? `${F.pct((100 * U.unlisted_redirect_targets) / U.unlisted_urls)} are redirect targets` : ""),
        S.lang_na ? tile("Bot-check pages", "n/a", S.lang_na) : tile("Bot-check pages", F.count(U.bot_pages), `on ${F.count(U.bot_domains)} domains, all scored 0`));
    }
    tiles.append(tile("Priority vs page score", hasPriority ? F.corr(S.spearman_pages) : "n/a", hasPriority ? `Spearman, all pages; ${F.corr(S.spearman_within_median)} within a domain` : S.priority_na || "seed cycle: every priority is 0"));
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
      foot: `Page score = the page's own quality score once fetched: ${R.score_def || "its fastText quality and FineWeb-Edu scores, each turned into a percentile, averaged"}. Priority = what the URL was selected with: ${R.priority_def || "the average page score of the already-fetched pages that link to it"}. Domain averages compare each domain's mean priority with its mean score (10+ scored pages); within one domain uses domains with 30+ scored pairs` +
        (hasPriority ? `, ${F.pct(S.spearman_within_negative_pct)} of which are negative in cycle ${cycle}.` : ".") + (R.seed_note ?? " The first cycle is the seed list, where every priority is 0."),
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
    // Cycles whose crawl tags page languages: the only ones where "no English page" means anything
    const withLang = withUrl.filter((c) => !R.summary[c].lang_na);
    if (withUrl.length) {
      if (withLang.length) {
        const noEn = kinds.map(([k, label, slot]) => ({ label, slot, values: withLang.map((c) => R.summary[c].url_level.no_en_kinds[k]) }));
        grid.append(card({
          title: "Pages on domains with no English page", sub: "Parse records per cycle, by what the page is", height: 260,
          draw: (h) => Charts.stack(h, { name: "Pages on domains with no English page, by kind, per cycle", x: withLang, series: noEn, unit: "count", fmt: F.count, height: 260, legend: true, selectedX: cycle }),
          table: seriesTable(withLang, "Cycle", noEn, "int"),
          foot: U && !S.lang_na ? `Cycle ${cycle}: ${F.int(U.no_en_domains)} domains with ${F.int(U.no_en_pages)} pages. Bot-check pages are 200 responses holding a challenge page; JS/CSS files come from CDN hosts.` : "",
        }));
      }
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
    const modeNote = (R.list_limit ? mode.note.replace("250 at most", R.list_limit) : mode.note) +
      (S.lang_na && ui.mode === "mismatch" ? ` This crawl doesn't tag page languages (it loads no language or score model), so there are no English or bot-check counts here; its English share comes from the text job, in the Language section.` : "");
    // The trimmed table loads first; "every domain" swaps in the cycle's full table from Hugging Face (large for big cycles)
    const every = RF && R.domain_rows && !everyDomain && ctx.button({ class: "tbtn", text: "Every domain (from Hugging Face)" }, () => {
      every.disabled = true;
      every.textContent = "Loading every domain…";
      loadFullDomains(ctx.run, cycle).then((t) => {
        if (t) ctx.rerender();
        else every.textContent = "Couldn't load every domain";
      });
    });
    // A trimmed table ranks only the domains the site kept (the cycle's biggest by HTTP 200s): say so wherever the
    // ranking isn't that one, so a "top 100" isn't read as the whole cycle's
    const warn = html("p", { class: "foot raw-warn", hidden: true });
    box.append(modes, html("p", { class: "explorer-note", text: modeNote }), html("div", { class: "search-row" }, search, html("label", { class: "field" }, "Rank by", sort), order, every || null, status), warn, output);

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
        // ties in plain character order, as the cluster's site_tables.py ranks them to choose the rows the site keeps
        const byName = (x, y) => (T.domain[x] < T.domain[y] ? -1 : T.domain[x] > T.domain[y] ? 1 : 0);
        rows.sort((a, b) => (ui.ascending ? a[1] - b[1] : b[1] - a[1]) || byName(a[0], b[0]));
        const total = rows.length;
        rows = rows.slice(0, 100);
        const trimmed = R.domain_rows && !everyDomain;
        const inCycle = S.counts.domains_written;
        // rank_exact: the site keeps each column's top and bottom 100 over every domain (site_tables.py), so an
        // unfiltered ranking is the cycle's true one; a search still covers only the kept rows
        const rankExact = trimmed && R.rank_exact && !q;
        status.textContent = rankExact
          ? `Top 100, ranked over all ${F.int(inCycle)} domains in the cycle`
          : trimmed
          ? (total > 100 ? `Top 100 of the ${F.int(total)} kept on the site` : `${F.int(total)} of those kept on the site`) + (inCycle ? `, of ${F.int(inCycle)} domains in the cycle` : "")
          : total > 100 ? `Top 100 of ${F.int(total)} domains` : `${F.int(total)} domain${total === 1 ? "" : "s"}`;
        const exact = rankExact || (ui.sort === "cdx200" && !ui.ascending && !q);
        warn.hidden = !trimmed || exact || !total;
        warn.textContent = (q && R.rank_exact
          ? `The search covers the ${F.int(T.domain.length)} domains the site keeps for this cycle (each column's top and bottom 100, the biggest and the listed ones)${inCycle ? `, not all ${F.int(inCycle)}` : ""}. `
          : `This ranks only the ${F.int(T.domain.length)} domains the site keeps for this cycle (its biggest by HTTP 200s)` +
            (inCycle ? `, not all ${F.int(inCycle)}` : "") + `, so it isn't the cycle's true ${ui.ascending ? "bottom" : "top"} 100. `) +
          (RF ? "“Every domain” above ranks all of them." : "The full data, with every domain, is on Hugging Face; an “Every domain” button appears here when it's available.");
        output.textContent = "";
        if (!total) {
          const trimmed = R.domain_rows && !everyDomain;
          output.append(html("p", { class: "empty", text: !q ? "Nothing to rank for this cycle."
            : !trimmed ? "No domain with 3+ pages in this cycle matches."
            : `No match among the domains the site keeps for this cycle (${R.rank_exact ? "each column's top and bottom 100, the biggest and the listed ones" : "its 3,000 biggest"}). ${RF ? "“Every domain” above searches all of them." : "The full data, with every domain, is on Hugging Face; an “Every domain” button appears here when it's available."}` }));
          return;
        }
        const body = html("tbody");
        for (const [i] of rows) {
          body.append(html("tr", {}, html("th", { scope: "row" }, ctx.button({ class: "domain-link", text: T.domain[i] + (hasEx(T, i) ? " ▸" : "") }, (e) => openDomain(ctx, R, cycle, T, i, e.currentTarget))),
            ...cols.map((k) => html("td", { class: k === ui.sort ? "ranked-value" : k === "cause" ? "raw-cause" : "", text: show(value(T, k, i), COLS[k][1]) }))));
        }
        output.append(html("div", { class: "tbl-wrap", tabindex: "0", role: "region", "aria-label": "Domains, scroll horizontally for more columns" }, html("table", { class: "data explorer-table" },
          html("thead", {}, html("tr", {}, html("th", { scope: "col", text: "Domain" }), ...cols.map((k) => html("th", { scope: "col", text: COLS[k][0] })))), body)),
          html("p", { class: "foot", text: exOk ? "▸ marks domains with example pages. Select a domain for its numbers and pages." : "Select a domain for its numbers." }));
      };
      search.addEventListener("input", update);
      sort.addEventListener("change", update);
      update();
    });

    // ---- Whole-cycle examples (none in a build made with --no-examples unless the full copy answers; the blurb says so)
    if (!exOk) return box;
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
    // example pages: the site's own, or the full copy's on Hugging Face (the trimmed build marks none)
    const RF = fullOf(run);
    const exOk = !R.examples_left_out || !!RF;
    const exList = ((RF || R).summary[cycle] || {}).example_domains || [];
    const has = RF ? exList.includes(domain) : !!T.has_ex[i];
    panel.append(html("p", { text: `Cycle ${cycle}, read from the segment and the WARC index.` + (cause ? ` What stands out: ${cause}.` : "") }));
    if (!exOk) {
      panel.append(html("p", { class: "foot", text: "Example pages are left out of this version (the site's size limit)." }));
    } else {
      panel.append(html("h3", { text: "Example pages with crawled text" }));
    }
    const exHost = html("div", {}, !exOk ? null : html("p", { class: "empty", text: has ? "Loading example pages…" : `No example pages were extracted for this domain in this cycle. ${exList.length} of the largest domains have them.` }));
    panel.append(exHost);
    if (has && exOk) {
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
    history.addEventListener("toggle", async () => {
      if (!history.open || histBox.firstChild) return;
      histBox.append(html("p", { class: "empty", text: "Loading…" }));
      // every cycle from the per-domain history on Hugging Face when it's there; else the site's per-cycle copy
      const H = R.domain_rows ? await loadHistory(run, domain) : null;
      if (H) {
        histBox.textContent = "";
        const byCycle = new Map(H.rows.map((r) => [r[0], r]));
        Charts.table(histBox, {
          columns: ["Cycle", ...H.cols.map((k) => COLS[k][0])],
          rows: R.cycles.map((c) => {
            const r = byCycle.get(c);
            return [String(c), ...H.cols.map((k, j) => (r ? show(r[j + 1], COLS[k][1]) : "—"))];
          }),
        });
        histBox.append(html("p", { class: "foot", text: "Every cycle, from the full data on Hugging Face: a dash means the domain had fewer than 3 pages in that cycle." }));
        return;
      }
      Promise.all(R.cycles.map((c) => loadDomains(run, c))).then((tables) => {
        histBox.textContent = "";
        const keys = ["listed", "f_success", "cdx200", "records", "urls", "lang_en", "bot", "spearman"];
        Charts.table(histBox, {
          columns: ["Cycle", ...keys.map((k) => COLS[k][0])],
          rows: R.cycles.map((c, n) => {
            const t = tables[n];
            const j = t ? t.domain.indexOf(domain) : -1;
            return [String(c), ...keys.map((k) => (j < 0 || !available(t, k) ? "—" : show(value(t, k, j), COLS[k][1])))];
          }),
        });
        histBox.append(html("p", { class: "foot", text: !R.domain_rows ? "A dash means the domain had fewer than 3 pages in that cycle."
          : R.rank_exact ? "From the site's copy, which keeps each cycle's 1,000 biggest domains, each column's top and bottom 100 and the domains listed on the page: a dash means the domain wasn't among them in that cycle, or had fewer than 3 pages."
          : "From the site's copy, which keeps each cycle's 3,000 biggest domains: a dash means the domain had fewer than 3 pages in that cycle or wasn't among them." }));
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
    const d = domain.toLowerCase();
    loadDomains(run, cycle).then(async (T) => {
      let i = T ? T.domain.indexOf(d) : -1;
      let checkedAll = !R.domain_rows; // the site's table has every domain unless the build was trimmed
      // The site keeps each cycle's 3,000 biggest domains (in the flat-250 crawls an arbitrary cut among thousands tied
      // at 250 pages): look in every domain on Hugging Face when it's there.
      if (i < 0 && R.domain_rows) {
        await loadFull(run).promise;
        if (fullOf(run)) {
          wait.textContent = "Not in the site's copy of this cycle; looking in every domain on Hugging Face…";
          const all = await loadFullDomains(run, cycle);
          if (all) {
            T = all;
            i = all.domain.indexOf(d);
            checkedAll = true;
          }
        }
      }
      wait.remove();
      if (i >= 0) fillDomain(host, run, R, cycle, T, i);
      else if (checkedAll) host.append(html("p", { class: "empty", text: `No raw-data row for this domain in cycle ${cycle}: it had fewer than 3 pages in the cycle.` }));
      else host.append(html("p", { class: "empty", text: `Not in the site's copy of cycle ${cycle}, which keeps the cycle's 3,000 biggest domains. The full data, with every domain, is on Hugging Face; this panel looks there when it's available.` }));
    });
  }

  return { has, loadIndex, render, appendDomain };
})();
