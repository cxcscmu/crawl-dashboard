/* Crawl metrics dashboard. Reads the data files written by export.py and renders the sections in SECTIONS.
   To add a chart, add an entry to SECTIONS: every key is a W&B history key (the "Everything logged" table at the
   bottom of the page lists them all). */
"use strict";

const { html, formats: F } = Charts;

// ---- What to show ---------------------------------------------------------------------------------------------------
// Series forms:
//   { label, key }                    one key with no cumulative twin
//   { label, per, cum }               a per-cycle key and its cumulative twin; the View toggle picks one
//   { label, sum: [...], sumCum }     the sum of several keys (e.g. HTTP 404 + 410)
//   { label, per, perFn, cumFn }      a key, plus functions that derive the value for runs that don't log it
// Chart types: line, stack (stacked columns), hist, bars (top-N lists from a per-cycle table), note.

const KPIS = [
  { label: "Pages fetched, total", key: "fetch/pages_cumulative", unit: "count", addedKey: "fetch/pages", added: "this cycle" },
  { label: "fastText quality, mean", key: "text/fasttext_quality_score_mean_per_cycle", unit: "score", good: "up" },
  { label: "Pages ≥ DCLM threshold", key: "text/fasttext_quality_score_ge_0p018112_pct_per_cycle", unit: "pct", good: "up" },
  { label: "FineWeb-Edu, mean", key: "text/fineweb_edu_score_mean_per_cycle", unit: "score", good: "up" },
  { label: "English share", key: "text/english_pct", unit: "pct", good: "up" },
  { label: "Domains seen, total", key: "domains/domains_total", unit: "count", addedKey: "domains/new_domains", added: "new this cycle" },
  { label: "Priority ↔ score Spearman", key: "frontier/priority_vs_page_score_spearman", unit: "corr", good: "up" },
  { label: "Pages per hour", key: "speed/pages_per_hour", unit: "count", good: "up" },
];

const SECTIONS = [
  {
    id: "quality",
    title: "Page quality",
    blurb: "Content scores of the English pages fetched. Higher is better for both scores.",
    charts: [
      {
        type: "line", title: "fastText quality score (DCLM oh_eli5)", sub: "Mean over English pages", unit: "score",
        series: [{ label: "Mean", per: "text/fasttext_quality_score_mean_per_cycle", cum: "text/fasttext_quality_score_mean_cumulative" }],
      },
      {
        type: "line", title: "Pages above the DCLM-Baseline threshold", sub: "% of English pages with fastText ≥ 0.018112", unit: "pct",
        series: [{ label: "fastText ≥ 0.018112", per: "text/fasttext_quality_score_ge_0p018112_pct_per_cycle", cum: "text/fasttext_quality_score_ge_0p018112_pct_cumulative" }],
      },
      {
        type: "line", title: "FineWeb-Edu score", sub: "Mean and median over English pages; the band spans p10 to p90", unit: "score",
        series: [
          { label: "Mean", per: "text/fineweb_edu_score_mean_per_cycle", cum: "text/fineweb_edu_score_mean_cumulative" },
          { label: "Median", per: "text/fineweb_edu_score_p50_per_cycle", cum: "text/fineweb_edu_score_p50_cumulative" },
        ],
        band: {
          label: "p10–p90", loLabel: "p10", hiLabel: "p90",
          lo: { per: "text/fineweb_edu_score_p10_per_cycle", cum: "text/fineweb_edu_score_p10_cumulative" },
          hi: { per: "text/fineweb_edu_score_p90_per_cycle", cum: "text/fineweb_edu_score_p90_cumulative" },
        },
      },
      {
        type: "line", title: "Pages above FineWeb-Edu 0.6", sub: "% of English pages with FineWeb-Edu ≥ 0.6, the cut the run's text_summary reports", unit: "pct",
        series: [{ label: "FineWeb-Edu ≥ 0.6", per: "text/fineweb_edu_score_ge_0p6_pct_per_cycle", cum: "text/fineweb_edu_score_ge_0p6_pct_cumulative" }],
      },
      { type: "hist", title: "FineWeb-Edu score distribution", per: "text/fineweb_edu_score_hist_per_cycle", cum: "text/fineweb_edu_score_hist_cumulative" },
      {
        type: "line", title: "DataMan and Nemotron scores", sub: "Means over the per-cycle page sample", unit: "num", gap: "DataMan / Nemotron scores",
        series: [
          { label: "DataMan overall", key: "quality/dataman_overall_mean" },
          { label: "Nemotron quality", key: "quality/nemotron_quality_mean" },
          { label: "Nemotron educational", key: "quality/nemotron_educational_mean" },
          { label: "Nemotron informational", key: "quality/nemotron_informational_mean" },
        ],
      },
    ],
  },
  {
    id: "language",
    title: "Language",
    blurb: "How much of the crawl is English. Only English pages get quality scores.",
    charts: [
      {
        type: "line", title: "English share", sub: "% of all parsed pages, and of pages whose language is known", unit: "pct",
        series: [
          { label: "Of all pages", per: "text/english_pct", cum: "text/english_pct_cumulative" },
          {
            label: "Of known-language pages", per: "text/english_pct_of_language_known",
            perFn: (d) => englishOfKnown(d, "text/languages"), cumFn: (d) => englishOfKnown(d, "text/languages_cumulative"),
          },
        ],
        foot: "Where a run doesn't log the known-language share, it is computed from the language table: English ÷ (all − unknown), as newer runs log it.",
      },
      {
        type: "bars", title: "Languages", sub: "% of parsed pages; “unknown” and “interstitial” are not languages",
        table: "text/languages", tableCum: "text/languages_cumulative", label: "language", value: "share %", unit: "pct",
        labelHead: "Language", valueHead: "Share of pages", extras: [{ col: "pages", head: "Pages", unit: "count" }],
        muted: ["unknown", "interstitial"],
      },
    ],
  },
  {
    id: "usability",
    title: "Text usability",
    blurb: "Whether fetched pages turn into usable text. Lower is better for the empty, interstitial, failure and duplicate rates.",
    charts: [
      { type: "line", title: "Pages parsed", unit: "count", series: [{ label: "Pages parsed", per: "text/pages_parsed", cum: "text/pages_parsed_cumulative" }] },
      {
        type: "line", title: "Pages with little or no text", sub: "% of pages", unit: "pct",
        series: [
          { label: "Near-empty", key: "text/page_near_empty_pct" },
          { label: "Empty", key: "text/page_empty_pct" },
          { label: "Interstitial (cookie or login wall)", key: "text/interstitial_pct" },
          { label: "Parse failures", key: "text/parse_failed_pct" },
        ],
      },
      {
        type: "line", title: "Characters per page", unit: "count",
        series: [{ label: "Mean", key: "text/page_chars_mean" }, { label: "Median", key: "text/page_chars_p50" }],
      },
      { type: "line", title: "Raw size per page", sub: "Mean KB fetched per page", unit: "kb", series: [{ label: "Raw KB", key: "text/page_raw_KB_mean" }] },
      {
        type: "line", title: "Duplicate content", sub: "% of pages whose text repeats a page from this cycle or an earlier one", unit: "pct",
        series: [{ label: "Duplicates", key: "dup/content_duplicate_pct" }],
      },
    ],
  },
  {
    id: "domains",
    title: "Domain diversity",
    blurb: "How many sites the crawl reaches and how concentrated it is. Click a domain in any list for its numbers across cycles.",
    charts: [
      {
        type: "line", title: "Domains and hosts", sub: "Distinct domains and hosts with fetched pages", unit: "count",
        series: [
          { label: "Domains", per: "domains/domains", cum: "domains/domains_total" },
          { label: "Hosts", per: "domains/hosts", cum: "domains/hosts_total" },
        ],
      },
      { type: "line", title: "Newly discovered domains", sub: "Domains seen for the first time in the cycle", unit: "count", series: [{ label: "New domains", key: "domains/new_domains" }] },
      { type: "line", title: "Pages on newly discovered domains", sub: "% of the cycle's pages", unit: "pct", series: [{ label: "On new domains", key: "domains/pages_on_new_domains_pct" }] },
      {
        type: "line", title: "Concentration on the biggest domains", sub: "% of pages on the top 1, 10 and 20 domains", unit: "pct",
        series: [
          { label: "Top 20", per: "domains/top20_share_pct", cum: "domains/top20_share_pct_cumulative" },
          { label: "Top 10", per: "domains/top10_share_pct", cum: "domains/top10_share_pct_cumulative" },
          { label: "Top 1", per: "domains/top1_share_pct", cum: "domains/top1_share_pct_cumulative" },
        ],
      },
      {
        // No line at TOPN_PER_DOMAIN: that caps the URLs a domain gets selected, while these counts include redirects
        // and error responses, so domains legitimately pass it.
        type: "bars", title: "Top domains by pages fetched", sub: "Fetch responses per domain, redirects and errors included",
        table: "domains/top_domains", tableCum: "domains/top_domains_cumulative",
        value: "pages", unit: "count", valueHead: "Pages fetched", extras: [{ col: "share %", head: "Share", unit: "pct" }], clickable: true,
      },
      {
        type: "bars", title: "Top domains by English pages, with quality", table: "text/top_domains_by_pages", tableCum: "text/top_domains_by_pages_cumulative",
        value: "English scored pages", unit: "count", valueHead: "English pages",
        extras: [{ col: "FineWeb-Edu mean", head: "Edu", unit: "score" }, { col: "fastText quality mean", head: "fastText", unit: "score" }],
        emptyWhy: "It counts the English pages the crawler scored, and this crawl doesn't score pages.", clickable: true,
      },
      { type: "bars", title: "Top newly discovered domains", table: "domains/top_new_domains", value: "pages", unit: "count", valueHead: "Pages fetched", clickable: true },
      {
        type: "bars", title: "Domains with the highest FineWeb-Edu", table: "text/top_domains_by_fineweb_edu",
        value: "FineWeb-Edu mean", unit: "score", valueHead: "FineWeb-Edu mean", max: 1,
        extras: [{ col: "English scored pages", head: "Pages", unit: "count" }, { col: "fastText quality mean", head: "fastText", unit: "score" }],
        emptyWhy: "It ranks the domains of the pages the crawler scored, and this crawl doesn't score pages.", clickable: true,
      },
    ],
  },
  {
    id: "priority",
    title: "Prioritization quality",
    tab: "Prioritization",
    blurb: "Does the crawler pick good pages? Cycle 1 fetches the seed list, so it has no priorities. No random-priority baseline is logged yet, so there is nothing to compare these numbers against.",
    charts: [
      {
        type: "line", title: "Priority vs. fetched page score: correlation", sub: "Between a URL's priority and the score of the page it returned; higher is better", unit: "corr",
        series: [
          { label: "Spearman", key: "frontier/priority_vs_page_score_spearman" },
          { label: "Pearson", key: "frontier/priority_vs_page_score_pearson" },
          { label: "Spearman, per domain", key: "frontier/priority_vs_page_score_domain_spearman" },
          { label: "Pearson, per domain", key: "frontier/priority_vs_page_score_domain_pearson" },
        ],
      },
      { type: "line", title: "Priority vs. fetched page score: MSE", sub: "Lower is better", unit: "num", series: [{ label: "MSE", key: "frontier/priority_vs_page_score_mse" }] },
      {
        type: "line", title: "Priority of selected, fetched and frontier URLs", sub: "Selected URLs only log percentiles, so their median is shown", unit: "score",
        series: [
          { label: "Selected (median)", key: "frontier/selected_priority_p50", zeroIsMissing: true },
          { label: "Fetched (mean)", key: "frontier/fetched_priority_mean", zeroIsMissing: true },
          { label: "Whole frontier (mean)", key: "frontier/crawldb_mean_priority" },
        ],
        foot: "Priorities logged as 0 (the seed cycle) are left out.",
      },
      {
        // The prod baseline was logged by a different script (monitoring/dash.py), which kept its stats file's names.
        type: "line", title: "Outlinks found", unit: "count",
        series: [
          { label: "Outlinks", key: ["frontier/outlinks", "frontier/outlinks_total"] },
          { label: "Distinct outlinks", key: ["frontier/outlinks_distinct", "frontier/distinct_urls"] },
          { label: "Outlink votes", key: "frontier/outlink_votes" },
        ],
      },
      { type: "line", title: "Mean in-degree", unit: "num", series: [{ label: "Mean in-degree", key: "frontier/indegree_mean" }] },
    ],
  },
  {
    id: "fetch",
    title: "Fetch outcomes",
    blurb: "What happened to each fetch attempt. Deferred URLs weren't fetched in the cycle; failed ones returned an error.",
    charts: [
      {
        type: "line", title: "Fetch attempts and pages fetched", unit: "count",
        series: [
          { label: "Attempts", per: "fetch/attempts", cum: "fetch/attempts_cumulative" },
          { label: "Pages fetched", per: "fetch/pages", cum: "fetch/pages_cumulative" },
        ],
      },
      {
        type: "line", title: "Failure and deferral rates", sub: "% of fetch attempts", unit: "pct",
        series: [
          { label: "Failed", per: "fetch/failure_rate_pct", cum: "fetch/failure_rate_pct_cumulative" },
          { label: "Deferred", per: "fetch/deferred_rate_pct", cum: "fetch/deferred_rate_pct_cumulative" },
        ],
      },
      {
        type: "stack", title: "Why fetches were deferred", sub: "% of fetch attempts", unit: "pct",
        series: [
          { label: "Host exceptions", key: "fetch/deferred_host_exceptions_pct" },
          { label: "Fetch time limit", key: "fetch/deferred_time_limit_pct" },
          { label: "Low throughput", key: "fetch/deferred_low_throughput_pct" },
          { label: "robots.txt queue", key: "fetch/deferred_robots_queue_pct" },
          { label: "Redirect limit", key: "fetch/deferred_redirect_limit_pct" },
          { label: "Stalled", key: "fetch/deferred_stalled_pct" },
        ],
      },
      {
        type: "stack", title: "Why fetches failed", sub: "% of fetch attempts", unit: "pct",
        series: [
          { label: "HTTP 404 or 410", sum: ["fetch/failed_http_404_pct", "fetch/failed_http_410_pct"] },
          { label: "robots.txt denied", key: "fetch/failed_robots_denied_pct" },
          { label: "Network error", key: "fetch/failed_network_pct" },
          { label: "HTTP 403", key: "fetch/failed_http_403_pct" },
          { label: "HTTP 429", key: "fetch/failed_http_429_pct" },
          { label: "Other 4xx or 5xx", sum: ["fetch/failed_http_other_4xx_pct", "fetch/failed_http_5xx_pct"] },
        ],
      },
      {
        type: "stack", title: "HTTP status mix", sub: "% of responses", unit: "pct",
        series: [
          { label: "2xx", sum: ["fetch/http_200_pct", "fetch/http_2xx_pct"], sumCum: ["fetch/http_200_pct_cumulative", "fetch/http_2xx_pct_cumulative"] },
          {
            label: "3xx", sum: ["fetch/http_301_pct", "fetch/http_302_pct", "fetch/http_3xx_pct"],
            sumCum: ["fetch/http_301_pct_cumulative", "fetch/http_302_pct_cumulative", "fetch/http_3xx_pct_cumulative"],
          },
          {
            label: "4xx", sum: ["fetch/http_403_pct", "fetch/http_404_pct", "fetch/http_410_pct", "fetch/http_429_pct", "fetch/http_4xx_pct"],
            sumCum: ["fetch/http_403_pct_cumulative", "fetch/http_404_pct_cumulative", "fetch/http_410_pct_cumulative", "fetch/http_429_pct_cumulative", "fetch/http_4xx_pct_cumulative"],
          },
          { label: "5xx", sum: ["fetch/http_5xx_pct"], sumCum: ["fetch/http_5xx_pct_cumulative"] },
          { label: "Other", sum: ["fetch/http_other_pct"], sumCum: ["fetch/http_other_pct_cumulative"] },
        ],
      },
      { type: "line", title: "HTTP 429 (Too Many Requests)", sub: "% of responses", unit: "pct", series: [{ label: "429", per: "fetch/http_429_pct", cum: "fetch/http_429_pct_cumulative" }] },
      {
        type: "line", title: "Domains returning error statuses", sub: "Distinct domains with at least one such response", unit: "count",
        series: [
          { label: "403", key: "fetch/domains_with_http_403" },
          { label: "404", key: "fetch/domains_with_http_404" },
          { label: "429", key: "fetch/domains_with_http_429" },
          { label: "5xx", key: "fetch/domains_with_http_5xx" },
        ],
      },
      {
        type: "bars", title: "Domains with the most error responses", table: "fetch/top_failing_domains",
        value: "4xx/5xx responses", unit: "count", valueHead: "4xx/5xx responses",
        extras: [
          { col: "403", head: "403", unit: "count" },
          { col: "404", head: "404", unit: "count" },
          { col: "429", head: "429", unit: "count" },
          { cols: ["410", "other 4xx", "5xx"], head: "Other", unit: "count" },
        ],
        clickable: true,
      },
      { type: "stack", title: "Hung threads at the fetch time limit", unit: "count", height: 140, series: [{ label: "Hung threads", key: "fetch/hung_threads" }] },
    ],
  },
  {
    id: "cache",
    title: "Fetch cache",
    blurb: "Pages replayed from the fetch cache instead of being fetched again.",
    charts: [
      {
        type: "line", title: "Cache hit rate and replayed pages", sub: "Hit rate, and replayed pages as % of all pages", unit: "pct", gap: "Fetch cache",
        series: [
          { label: "Hit rate", key: "cache/hit_rate_pct" },
          { label: "Replayed", key: "cache/replayed_pct_of_pages" },
        ],
      },
      { type: "line", title: "Replay errors", unit: "count", gap: "Fetch cache", series: [{ label: "Replay errors", key: "cache/replay_errors" }] },
    ],
  },
  {
    id: "speed",
    title: "Speed",
    blurb: "Crawl throughput per cycle.",
    charts: [
      {
        type: "line", title: "Pages per hour", sub: "Fetch stage alone vs. the whole pipeline", unit: "count",
        series: [
          { label: "Fetch stage", key: "speed/pages_per_hour" },
          { label: "Whole pipeline", key: "speed/pipeline_pages_per_hour" },
        ],
      },
      { type: "line", title: "Pages per second per fetch task", sub: "Mean over fetch tasks", unit: "num", series: [{ label: "Pages/s per task", key: "speed/pages_per_s_per_fetch_task_mean" }] },
      { type: "line", title: "Download rate", sub: "MB/s", unit: "mbps", series: [{ label: "Downloaded", key: "speed/downloaded_MBps" }] },
      { type: "line", title: "Bandwidth per fetcher thread", sub: "Mean kbps", unit: "kbps", series: [{ label: "Per thread", key: "speed/bandwidth_per_thread_kbps_mean" }] },
      {
        type: "line", title: "Request latency", sub: "Milliseconds", unit: "ms",
        series: [
          { label: "p99", key: "speed/request_latency_p99_ms" },
          { label: "p95", key: "speed/request_latency_p95_ms" },
          { label: "Mean", key: "speed/request_latency_mean_ms" },
          { label: "Median", key: "speed/request_latency_p50_ms" },
        ],
      },
    ],
  },
  {
    id: "storage",
    title: "Storage",
    blurb: "Disk written per cycle.",
    charts: [
      {
        type: "stack", title: "Data written per cycle", sub: "GB", unit: "gb",
        series: [
          { label: "WARC", key: "storage/warc_GB" },
          { label: "Segments", key: "storage/segments_GB" },
          { label: "Checkpoint", key: "storage/checkpoint_GB" },
        ],
      },
      {
        type: "line", title: "Storage per million pages", sub: "GB", unit: "gb",
        series: [
          { label: "All data", per: "storage/GB_per_million_pages", cum: "storage/GB_per_million_pages_cumulative" },
          { label: "WARC only", key: "storage/warc_GB_per_million_pages" },
        ],
      },
      { type: "line", title: "NAS drain rate", sub: "MB/s", unit: "mbps", series: [{ label: "Drain", key: "storage/drain_MBps" }] },
    ],
  },
  {
    id: "downstream",
    title: "Downstream results",
    tab: "Downstream",
    blurb: "The final measure of crawl quality.",
    charts: [
      {
        type: "note", title: "Pretraining results aren't in W&B yet", gap: "Downstream pretraining results",
        text:
          "This section should show tokens after the English filter per cycle (from the 53B runs), and DCLM Core with its 5 category " +
          "scores for the 1B-1x pretrain next to the prod rows in the sheet. Once they're logged to this W&B project, add a chart here.",
      },
    ],
  },
];

// ---- State and data access ------------------------------------------------------------------------------------------

const RUNS = window.CRAWL_RUNS || [];
const state = { run: null, view: "per", cycle: null, tab: SECTIONS[0].id };
let DATA = null;
let LATEST = null; // the newest cycle with full metrics; see latestCompleteCycle
let DOMAINS = new Map();
let allQuery = "";
let closeDrawer = null;

const has = (v) => Array.isArray(v) && v.some((x) => x != null);
// A key can be a list of names for the same metric, when runs logged it under different names; the first one wins.
const metric = (key) => (Array.isArray(key) ? key.map(metric).find(Boolean) : key && DATA.metrics[key]) || null;
const cycleIndex = () => DATA.cycles.indexOf(state.cycle);
const cell = (v, fmt) => (v == null || v === "" ? "—" : fmt(v));
const tableFmt = (unit) => (unit === "count" ? F.int : F[unit]);

function sumOf(keys) {
  const arrays = (keys || []).map(metric).filter(Boolean);
  if (!arrays.length) return null;
  return DATA.cycles.map((_, i) => arrays.reduce((t, a) => (a[i] == null ? t : (t || 0) + a[i]), null));
}

// Values for a series in the given view; falls back to per-cycle values when there is no cumulative twin.
function pick(s, view) {
  if (view === "cum") {
    const v = metric(s.cum) || sumOf(s.sumCum) || (s.cumFn ? s.cumFn(DATA) : null);
    if (has(v)) return { values: v, cum: true };
  }
  const v = metric(s.key) || metric(s.per) || sumOf(s.sum) || (s.perFn ? s.perFn(DATA) : null);
  return has(v) ? { values: v, cum: false } : null;
}

// A chart goes cumulative only when every series it has data for has a cumulative version, so no chart mixes the two.
function chartView(spec) {
  if (state.view !== "cum") return "per";
  const allCum = spec.series.every((s) => {
    const r = pick(s, "cum");
    return !r || r.cum;
  });
  return allCum ? "cum" : "per";
}

function specKeys(spec) {
  return (spec.series || []).flatMap((s) => [s.key, s.per, ...(s.sum || [])].flat().filter(Boolean));
}

// Matches how newer runs compute text/english_pct_of_language_known: English share of pages whose language isn't "unknown".
function englishOfKnown(d, tableKey) {
  const perCycle = d.tables[tableKey];
  if (!perCycle) return null;
  return d.cycles.map((c) => {
    const t = perCycle[c];
    if (!t) return null;
    const li = t.columns.indexOf("language");
    const si = t.columns.indexOf("share %");
    let en = null;
    let unknown = 0;
    for (const row of t.data) {
      if (row[li] === "en") en = row[si];
      else if (row[li] === "unknown") unknown = row[si];
    }
    return en == null || unknown >= 100 ? null : (100 * en) / (100 - unknown);
  });
}

// Every per-cycle domain table, folded into domain -> cycle -> fields, for the details panel.
function buildDomainIndex(d) {
  const index = new Map();
  const visit = (key, fn) => {
    for (const [c, t] of Object.entries(d.tables[key] || {})) {
      const col = (name) => t.columns.indexOf(name);
      const di = col("domain");
      for (const row of t.data) {
        if (!index.has(row[di])) index.set(row[di], new Map());
        const byCycle = index.get(row[di]);
        if (!byCycle.has(+c)) byCycle.set(+c, {});
        fn(byCycle.get(+c), (name) => (col(name) < 0 ? null : row[col(name)]));
      }
    }
  };
  visit("domains/top_domains", (r, get) => (r.pages = get("pages")));
  visit("domains/top_new_domains", (r) => (r.isNew = true));
  for (const key of ["text/top_domains_by_pages", "text/top_domains_by_fineweb_edu"]) {
    visit(key, (r, get) => {
      r.en = get("English scored pages");
      r.edu = get("FineWeb-Edu mean");
      r.ft = get("fastText quality mean");
    });
  }
  visit("fetch/top_failing_domains", (r, get) => (r.errors = get("4xx/5xx responses")));
  return index;
}

// ---- Chart builders: each returns { draw, table, height, sub, badge, foot } or { empty, gap } -------------------------

function emptyCard(spec, reason) {
  return { empty: reason || "Not logged in this run.", keys: specKeys(spec), gap: true };
}

function buildLine(spec) {
  const view = chartView(spec);
  const series = [];
  const missing = [];
  spec.series.forEach((s, k) => {
    const r = pick(s, view);
    if (!r) return missing.push(s.label);
    const values = s.zeroIsMissing ? r.values.map((v) => (v === 0 ? null : v)) : r.values;
    series.push({ label: s.label, values, slot: k + 1 }); // color follows the series, not its rank
  });
  if (!series.length) return emptyCard(spec);
  let band = null;
  if (spec.band) {
    const lo = pick(spec.band.lo, view);
    const hi = pick(spec.band.hi, view);
    if (lo && hi) band = { ...spec.band, lo: lo.values, hi: hi.values, slot: 1 };
  }
  const fmt = F[spec.unit];
  const tf = tableFmt(spec.unit);
  const legend = series.length + (band ? 1 : 0) > 1;
  const height = (spec.height || 210) + (legend ? 24 : 0);
  return {
    badge: state.view !== view ? "per cycle only" : null,
    height,
    foot: [missing.length ? `Not logged in this run: ${missing.join(", ")}.` : "", spec.foot || ""].filter(Boolean).join(" "),
    draw: (host) =>
      Charts.line(host, { name: spec.title, x: DATA.cycles, series, band, unit: spec.unit, fmt, zero: spec.zero, height, legend, selectedX: state.cycle }),
    table: {
      columns: ["Cycle", ...series.map((s) => s.label), ...(band ? [band.loLabel, band.hiLabel] : [])],
      rows: DATA.cycles.map((c, i) => [
        String(c),
        ...series.map((s) => cell(s.values[i], tf)),
        ...(band ? [cell(band.lo[i], tf), cell(band.hi[i], tf)] : []),
      ]),
    },
  };
}

function buildStack(spec) {
  const view = chartView(spec);
  const series = [];
  spec.series.forEach((s, k) => {
    const r = pick(s, view);
    if (r) series.push({ label: s.label, values: r.values, slot: k + 1 });
  });
  if (!series.length) return emptyCard(spec);
  const fmt = F[spec.unit];
  const tf = tableFmt(spec.unit);
  const multi = series.length > 1;
  const height = (spec.height || 210) + (multi ? 24 : 0);
  return {
    badge: state.view !== view ? "per cycle only" : null,
    height,
    draw: (host) => Charts.stack(host, { name: spec.title, x: DATA.cycles, series, unit: spec.unit, fmt, height, legend: multi, selectedX: state.cycle }),
    table: {
      columns: ["Cycle", ...series.map((s) => s.label), ...(multi ? ["Total"] : [])],
      rows: DATA.cycles.map((c, i) => {
        const vals = series.map((s) => s.values[i]);
        const total = vals.reduce((t, v) => (v == null ? t : (t || 0) + v), null);
        return [String(c), ...vals.map((v) => cell(v, tf)), ...(multi ? [cell(total, tf)] : [])];
      }),
    },
  };
}

function buildHist(spec) {
  const key = state.view === "cum" && DATA.histograms[spec.cum] ? spec.cum : spec.per;
  const all = DATA.histograms[key];
  const i = cycleIndex();
  if (!all) return { empty: "Not logged in this run.", keys: [spec.per], gap: true };
  if (!all[i]) return { empty: `Not logged for cycle ${state.cycle}.`, keys: [spec.per] };
  const toPct = (h) => {
    const total = h.values.reduce((a, b) => a + b, 0);
    return h.values.map((v) => (total ? (100 * v) / total : 0));
  };
  const edgesOf = (h) => (h.bins ? h.bins : h.values.map((_, j) => h.min + j * h.size).concat(h.min + h.values.length * h.size));
  const edges = edgesOf(all[i]);
  const bins = all[i].values.map((_, j) => ({ lo: edges[j], hi: edges[j + 1] }));
  const cum = key === spec.cum;
  const name = (c) => (cum ? `Cycles ${DATA.cycles[0]}–${c}` : `Cycle ${c}`);
  const series = { label: name(state.cycle), values: toPct(all[i]), slot: 1 };
  const ref = i > 0 && all[0] ? { label: name(DATA.cycles[0]), values: toPct(all[0]), slot: "muted" } : null;
  const width = +(bins[0].hi - bins[0].lo).toFixed(4);
  const height = 210 + (ref ? 24 : 0);
  return {
    sub: `% of English pages per ${width} bin` + (ref ? `, ${series.label.toLowerCase()} against ${ref.label.toLowerCase()}` : ""),
    badge: state.view === "cum" && !cum ? "per cycle only" : null,
    height,
    draw: (host) => Charts.hist(host, { name: spec.title, bins, series, ref, fmt: F.pct, height, legend: !!ref }),
    table: {
      columns: ["Score", series.label, ...(ref ? [ref.label] : [])],
      rows: bins.map((b, j) => [`${b.lo.toFixed(2)}–${b.hi.toFixed(2)}`, F.pct(series.values[j]), ...(ref ? [F.pct(ref.values[j])] : [])]),
    },
  };
}

function buildBars(spec) {
  const useCum = state.view === "cum" && spec.tableCum && DATA.tables[spec.tableCum];
  const key = useCum ? spec.tableCum : spec.table;
  if (!DATA.tables[key]) return { empty: "Not logged in this run.", keys: [spec.table], gap: true };
  const t = DATA.tables[key][state.cycle];
  if (!t) return { empty: `Not logged for cycle ${state.cycle}.`, keys: [spec.table] };
  if (!t.data.length) {
    const never = Object.values(DATA.tables[key]).every((x) => !x.data.length);
    if (!never) return { empty: `Logged, but empty for cycle ${state.cycle}.` };
    return { empty: ["Logged every cycle, but always empty in this run.", spec.emptyWhy].filter(Boolean).join(" "), gap: true };
  }
  const col = (name) => t.columns.indexOf(name);
  const li = col(spec.label || "domain");
  const vi = col(spec.value);
  // An extra column shows one table column, or the sum of several ({ cols: [...] }).
  const extras = (spec.extras || []).map((e) => ({ ...e, idx: (e.cols || [e.col]).map(col).filter((i) => i >= 0) }));
  const extraValue = (r, e) => {
    const vals = e.idx.map((i) => r[i]).filter((v) => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const rows = t.data.map((r) => ({
    label: String(r[li]),
    value: r[vi],
    muted: (spec.muted || []).includes(r[li]),
    extras: extras.map((e) => cell(extraValue(r, e), F[e.unit])),
  }));
  const limit = spec.limit || 12;
  const fmt = F[spec.unit];
  const scope = useCum ? `Cycles ${DATA.cycles[0]}–${state.cycle}` : `Cycle ${state.cycle}`;
  return {
    sub: [spec.sub, `${scope}, top ${Math.min(limit, rows.length)} of ${rows.length}`].filter(Boolean).join(". "),
    badge: state.view === "cum" && !useCum ? "per cycle only" : null,
    html: true,
    draw: (host) =>
      Charts.bars(host, {
        rows: rows.slice(0, limit), fmt, max: spec.max,
        labelHead: spec.labelHead || "Domain", valueHead: spec.valueHead, extras: extras.map((e) => e.head),
        onSelect: spec.clickable ? safely(openDomain) : null,
      }),
    table: {
      columns: [spec.labelHead || "Domain", spec.valueHead, ...extras.map((e) => e.head)],
      rows: t.data.map((r, k) => [rows[k].label, cell(r[vi], tableFmt(spec.unit)), ...extras.map((e) => cell(extraValue(r, e), tableFmt(e.unit)))]),
    },
  };
}

const BUILDERS = { line: buildLine, stack: buildStack, hist: buildHist, bars: buildBars, note: (spec) => ({ note: spec.text, gap: true }) };

// ---- Rendering ------------------------------------------------------------------------------------------------------

const drawFns = new WeakMap();

// Plotly charts are drawn when they come near the viewport, so re-rendering after a filter change stays quick.
const lazy = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      lazy.unobserve(e.target);
      drawInto(e.target);
    }
  },
  { rootMargin: "800px 0px" }
);

// The HTML bar lists redraw when their width changes, to fit as many extra columns as there is room for.
const resizer = new ResizeObserver((entries) => {
  for (const e of entries) {
    const w = Math.round(e.contentRect.width);
    if (!w) {
      e.target._w = 0;
      continue;
    }
    if (w !== e.target._w) {
      e.target._w = w;
      drawInto(e.target);
    }
  }
});

function schedule(host, draw, observer) {
  drawFns.set(host, draw);
  observer.observe(host);
}

// A chart that fails to draw says so in its own card, with the browser's message, instead of breaking the page.
function drawInto(host) {
  if (!host.isConnected) return; // the page re-rendered after this chart was queued
  try {
    drawFns.get(host)(host);
  } catch (err) {
    Charts.failed(host, err);
  }
}

function renderCard(spec, gaps) {
  const built = BUILDERS[spec.type](spec);
  if (built.gap) gaps.add(spec.gap || spec.title);
  const fig = html("figure", { class: "card" + (built.empty || built.note ? " quiet" : "") });
  const h3 = html("h3", { text: spec.title }, built.badge && html("span", { class: "badge", text: built.badge }));
  const titles = html("div", {}, h3, (built.sub || spec.sub) && html("p", { class: "sub", text: built.sub || spec.sub }));
  const head = html("div", { class: "card-head" }, titles);
  fig.append(head);
  if (built.note) {
    fig.append(html("p", { class: "empty", text: built.note }));
    return fig;
  }
  if (built.empty) {
    fig.append(html("p", { class: "empty", text: built.empty }));
    if (built.keys && built.keys.length) fig.append(html("p", { class: "foot" }, "Expected W&B keys: ", html("code", { text: built.keys.join(", ") })));
    return fig;
  }
  const chartHost = html("div", { class: "chart", role: "group", "aria-label": `${spec.title}. The Table button lists every value.` });
  if (built.height) chartHost.style.minHeight = built.height + "px"; // hold the space until the chart is drawn
  const tableHost = html("div", { hidden: true });
  const toggle = html("button", { type: "button", class: "tbtn", "aria-pressed": "false", text: "Table" });
  toggle.addEventListener("click", safely(() => {
    const showTable = tableHost.hidden;
    if (showTable && !tableHost.firstChild) Charts.table(tableHost, built.table);
    tableHost.hidden = !showTable;
    chartHost.hidden = showTable;
    if (!showTable) Charts.resize(chartHost); // in case the window changed size while the chart was hidden
    toggle.textContent = showTable ? "Chart" : "Table";
    toggle.setAttribute("aria-pressed", String(showTable));
  }));
  head.append(toggle);
  fig.append(chartHost, tableHost);
  if (built.foot) fig.append(html("p", { class: "foot", text: built.foot }));
  schedule(chartHost, built.draw, built.html ? resizer : lazy);
  return fig;
}

function renderHeader() {
  document.getElementById("run-name").textContent = DATA.name;
  const meta = document.getElementById("run-meta");
  meta.textContent = "";
  const cfg = DATA.config || {};
  const drv = cfg.driver || {};
  const items = [
    cfg.crawl_job && `Crawl job ${cfg.crawl_job}`,
    `${DATA.cycles.length} cycles`,
    DATA.state,
    drv.TOPN && `TOPN ${F.count(+drv.TOPN)}`,
    drv.TOPN_RAMP && drv.TOPN_RAMP !== "<off>" && `TOPN ramp ${drv.TOPN_RAMP}`,
    drv.TOPN_PER_DOMAIN && `${drv.TOPN_PER_DOMAIN} per domain`,
    drv.TOPN_PER_HOST && `${drv.TOPN_PER_HOST} per host`,
    drv.NODE_COUNT && `${drv.NODE_COUNT} nodes`,
    `exported ${new Date(DATA.exported_at).toLocaleString()}`,
  ].filter(Boolean);
  for (const t of items) meta.append(html("li", { text: t }));
  if (/^https:\/\//.test(DATA.url || "")) {
    meta.append(html("li", {}, html("a", { href: DATA.url, target: "_blank", rel: "noopener noreferrer", text: "Open in W&B ↗" })));
  }
}

function renderFilters() {
  const runSel = document.getElementById("f-run");
  runSel.textContent = "";
  // Run names end in the crawl job number the team goes by; the W&B id is only added to tell same-named runs apart.
  const sameName = (r) => RUNS.filter((o) => o.name === r.name).length > 1;
  for (const r of RUNS) {
    runSel.append(html("option", { value: r.id, selected: r.id === state.run, text: sameName(r) ? `${r.name} (${r.id})` : r.name }));
  }
  const cycleSel = document.getElementById("f-cycle");
  cycleSel.textContent = "";
  const tag = (c) => (c === LATEST ? " (latest)" : c > LATEST ? " (partial)" : "");
  for (const c of DATA.cycles.slice().reverse()) {
    cycleSel.append(html("option", { value: c, selected: c === state.cycle, text: `${c}${tag(c)}` }));
  }
  for (const b of document.querySelectorAll("[data-view]")) b.setAttribute("aria-pressed", String(b.dataset.view === state.view));
}

function renderKpis() {
  const i = cycleIndex();
  document.getElementById("kpi-title").textContent =
    `Cycle ${state.cycle} at a glance` + (state.cycle === LATEST ? "" : ` (latest complete cycle is ${LATEST})`);
  const box = document.getElementById("kpis");
  box.textContent = "";
  for (const k of KPIS) {
    const values = metric(k.key);
    if (!has(values)) continue;
    const v = values[i];
    const delta = html("div", { class: "delta" });
    if (k.addedKey) {
      const added = metric(k.addedKey);
      if (added && added[i] != null) delta.append(`+${F[k.unit](added[i])} ${k.added}`);
    } else if (i > 0 && v != null && values[i - 1] != null) {
      const d = v - values[i - 1];
      const better = d === 0 ? null : (d > 0) === (k.good === "up");
      if (better != null) {
        delta.append(html("span", { class: "arrow " + (better ? "good" : "bad"), "aria-label": better ? "better" : "worse", text: d > 0 ? "▲" : "▼" }));
      }
      delta.append(`${Charts.signed(d, k.unit)} vs. cycle ${DATA.cycles[i - 1]}`);
    }
    const sparkHost = html("div", { class: "spark-host" });
    box.append(html("div", { class: "tile" }, html("div", { class: "label", text: k.label }), html("div", { class: "value", text: cell(v, F[k.unit]) }), delta, sparkHost));
    Charts.spark(sparkHost, values, i);
  }
}

const button = (attrs, onClick) => {
  const b = html("button", { type: "button", ...attrs });
  b.addEventListener("click", safely(onClick));
  return b;
};

// One tab per section, plus every logged metric; the page shows one tab at a time.
const TABS = [...SECTIONS.map((sec, n) => ({ id: sec.id, label: sec.tab || sec.title, sec, n })), { id: "all", label: "All metrics" }];

// Which charts a run can't fill and whether a section has anything to show, without drawing the other tabs.
function sectionStatus() {
  const gaps = new Map(); // gap name -> section id
  const hasData = new Set();
  for (const sec of SECTIONS) {
    for (const spec of sec.charts) {
      const built = BUILDERS[spec.type](spec);
      if (built.gap) gaps.set(spec.gap || spec.title, sec.id);
      if (!built.empty && !built.note) hasData.add(sec.id);
    }
  }
  return { gaps, hasData };
}

function renderSections() {
  const { gaps, hasData } = sectionStatus();
  const main = document.getElementById("sections");
  main.textContent = "";
  main.setAttribute("aria-labelledby", "tab-" + state.tab);
  const i = TABS.findIndex((t) => t.id === state.tab);
  const tab = TABS[i];
  if (tab.sec) {
    const sec = tab.sec;
    main.append(
      html(
        "section",
        { class: "sec", id: sec.id, "aria-labelledby": sec.id + "-h" },
        html("h2", { id: sec.id + "-h", text: `${tab.n + 1}. ${sec.title}` }),
        sec.blurb && html("p", { class: "blurb", text: sec.blurb }),
        html("div", { class: "grid" }, ...sec.charts.map((spec) => renderCard(spec, new Set())))
      )
    );
  } else {
    main.append(renderAllMetrics());
  }
  // Previous / next, so a reader can go through the sections in order without going back up to the tabs.
  const step = (t, text) => t && button({ class: "tbtn step", text }, () => selectTab(t.id));
  const prev = TABS[i - 1];
  const next = TABS[i + 1];
  main.append(html("div", { class: "pager" }, step(prev, prev && `← ${prev.label}`) || html("span"), step(next, next && `${next.label} →`)));

  renderGaps(gaps);
  renderTabs(hasData);
}

// What this run doesn't log, grouped by section; each section name opens its tab. Long lists start collapsed.
let gapsOpen = null; // the reader's own choice, once they've opened or closed the list
function renderGaps(gaps) {
  const note = document.getElementById("gaps");
  note.textContent = "";
  note.hidden = !gaps.size;
  if (!gaps.size) return;
  const bySection = new Map();
  for (const [name, id] of gaps) bySection.set(id, [...(bySection.get(id) || []), name]);
  const summary = html("summary", {}, html("strong", { text: "Not logged in this run: " }), `${gaps.size} chart${gaps.size > 1 ? "s" : ""} in ${bySection.size} section${bySection.size > 1 ? "s" : ""}`);
  summary.addEventListener("click", () => (gapsOpen = !note.open));
  const list = html("ul", {});
  for (const [id, names] of bySection) {
    const tab = TABS.find((t) => t.id === id);
    list.append(html("li", {}, button({ class: "linkish", text: `${tab.n + 1}. ${tab.sec.title}` }, () => selectTab(id)), ": " + names.join(" · ")));
  }
  note.append(summary, list, html("p", { text: "Their cards list the W&B keys they expect." }));
  note.open = gapsOpen ?? gaps.size <= 8;
}

function renderTabs(hasData) {
  const bar = document.getElementById("tabs");
  bar.textContent = "";
  for (const t of TABS) {
    const selected = t.id === state.tab;
    const empty = t.sec && !hasData.has(t.id);
    const attrs = {
      role: "tab", id: "tab-" + t.id, class: "tab" + (empty ? " nodata" : ""), "aria-selected": String(selected), "aria-controls": "sections",
      tabindex: selected ? "0" : "-1", title: empty ? "Nothing logged for this section in this run" : null, text: t.label,
    };
    bar.append(button(attrs, () => selectTab(t.id)));
  }
  const current = document.getElementById("tab-" + state.tab);
  // Keep the selected tab in view when the tab row scrolls sideways (narrow screens).
  if (current) bar.scrollLeft = Math.max(0, current.offsetLeft - bar.clientWidth / 2 + current.offsetWidth / 2);
}

function selectTab(id, focus) {
  if (!TABS.some((t) => t.id === id)) return;
  state.tab = id;
  render();
  if (focus) document.getElementById("tab-" + id).focus();
  // If the reader had scrolled down into the previous tab, bring the top of the new one into view under the sticky bar.
  const top = document.getElementById("sections").getBoundingClientRect().top;
  const bar = document.querySelector(".filters").offsetHeight;
  if (top < bar) window.scrollTo(0, window.scrollY + top - bar - 12);
}

function renderAllMetrics() {
  const keys = Object.keys(DATA.metrics).sort();
  const shown = DATA.cycles.slice(-12);
  const offset = DATA.cycles.length - shown.length;
  const input = html("input", { type: "search", class: "search", value: allQuery, placeholder: "Filter keys, e.g. robots/ or latency", "aria-label": "Filter metrics by W&B key" });
  const count = html("span", { class: "count", "aria-live": "polite" });
  const rows = keys.map((k) =>
    html("tr", {}, html("th", { scope: "row", text: k }), ...shown.map((_, j) => html("td", { text: cell(DATA.metrics[k][offset + j], F.auto) })))
  );
  const header = html("tr", {}, html("th", { scope: "col", text: "W&B key" }), ...shown.map((c) => html("th", { scope: "col", text: `Cycle ${c}` })));
  const update = () => {
    allQuery = input.value;
    const q = allQuery.trim().toLowerCase();
    let n = 0;
    rows.forEach((tr, k) => {
      tr.hidden = q !== "" && !keys[k].toLowerCase().includes(q);
      if (!tr.hidden) n++;
    });
    count.textContent = `${n} of ${keys.length} metrics` + (offset ? `, last ${shown.length} cycles` : "");
  };
  input.addEventListener("input", update);
  update();
  return html(
    "section",
    { class: "sec", id: "all", "aria-labelledby": "all-h" },
    html("h2", { id: "all-h", text: "Everything logged" }),
    html("p", { class: "blurb", text: "Every numeric metric in this run, by W&B key, exactly as logged. Use it to find a metric that isn't charted above." }),
    html("div", { class: "search-row" }, input, count),
    html("div", { class: "card" }, html("div", { class: "tbl-wrap" }, html("table", { class: "data all" }, html("thead", {}, header), html("tbody", {}, ...rows))))
  );
}

// ---- Domain details panel -------------------------------------------------------------------------------------------

function openDomain(domain, opener) {
  if (closeDrawer) closeDrawer(false);
  const rec = DOMAINS.get(domain) || new Map();
  const drawer = document.getElementById("drawer");
  drawer.textContent = "";
  const close = html("button", { type: "button", class: "tbtn", text: "Close" });
  drawer.append(html("div", { class: "drawer-head" }, html("h2", { id: "drawer-title", text: domain }), close));
  if (/^[a-z0-9.-]+$/i.test(domain)) {
    drawer.append(html("p", {}, html("a", { href: "https://" + domain, target: "_blank", rel: "noopener noreferrer", text: `Open ${domain} ↗` })));
  }

  const listed = DATA.cycles.filter((c) => rec.has(c));
  const lines = [`Appears in this run's top-50 domain tables in ${listed.length} of ${DATA.cycles.length} cycles.`];
  const scored = listed.filter((c) => rec.get(c).edu != null && rec.get(c).en);
  const crawlMean = metric("text/fineweb_edu_score_mean_per_cycle");
  const crawlFt = metric("text/fasttext_quality_score_mean_per_cycle");
  const crawlEn = metric("text/english_scored_pages");
  if (scored.length) {
    const own = (f) => scored.reduce((t, c) => t + rec.get(c)[f] * rec.get(c).en, 0) / scored.reduce((t, c) => t + rec.get(c).en, 0);
    const crawl = (m) => {
      const idx = scored.map((c) => DATA.cycles.indexOf(c));
      return idx.reduce((t, i) => t + m[i] * crawlEn[i], 0) / idx.reduce((t, i) => t + crawlEn[i], 0);
    };
    let line = `FineWeb-Edu mean on its English pages: ${F.score(own("edu"))}`;
    if (crawlMean && crawlEn) line += ` (whole crawl, same cycles: ${F.score(crawl(crawlMean))})`;
    line += `. fastText mean: ${F.score(own("ft"))}`;
    if (crawlFt && crawlEn) line += ` (whole crawl: ${F.score(crawl(crawlFt))})`;
    lines.push(line + ".");
  }
  const firstNew = listed.find((c) => rec.get(c).isNew);
  if (firstNew != null) lines.push(`Listed among newly discovered domains in cycle ${firstNew}.`);
  for (const t of lines) drawer.append(html("p", { text: t }));

  const tableBox = html("div");
  drawer.append(tableBox);
  Charts.table(tableBox, {
    columns: ["Cycle", "Pages fetched", "English pages", "FineWeb-Edu", "fastText", "New", "4xx/5xx"],
    rows: DATA.cycles.map((c) => {
      const r = rec.get(c) || {};
      return [String(c), cell(r.pages, F.int), cell(r.en, F.int), cell(r.edu, F.score), cell(r.ft, F.score), r.isNew ? "yes" : "—", cell(r.errors, F.int)];
    }),
  });
  drawer.append(html("p", { class: "foot", text: "A dash means the domain wasn't in that cycle's top-50 table for that column, not that the value was zero." }));

  drawer.hidden = false;
  close.focus();
  const onKey = (e) => e.key === "Escape" && closeDrawer();
  closeDrawer = (restoreFocus = true) => {
    drawer.hidden = true;
    document.removeEventListener("keydown", onKey);
    closeDrawer = null;
    if (restoreFocus && opener && opener.isConnected) opener.focus();
  };
  close.addEventListener("click", () => closeDrawer());
  document.addEventListener("keydown", onKey);
}

// ---- Wiring ---------------------------------------------------------------------------------------------------------

function showError(message) {
  const el = document.getElementById("error");
  el.hidden = false;
  el.textContent = message;
}

// The dashboard catches its own errors where they happen, so the banner can show the real message: for a page opened
// from disk, the browser hides the details of anything that escapes to window.onerror ("Script error.").
function reportError(err) {
  console.error(err);
  showError(`Something broke while drawing the page: ${(err && err.message) || err}`);
}

const safely = (fn) => (...args) => {
  try {
    return fn(...args);
  } catch (err) {
    reportError(err);
  }
};

function loadRun(entry) {
  const ready = () => window.CRAWL_DATA && window.CRAWL_DATA[entry.id];
  if (ready()) return Promise.resolve(ready());
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = entry.file;
    s.onload = () => (ready() ? resolve(ready()) : reject(new Error(`${entry.file} loaded but held no data for ${entry.id}.`)));
    s.onerror = () => reject(new Error(`Couldn't load ${entry.file}. Run "python export.py ${entry.id}" to create it.`));
    document.head.append(s);
  });
}

function syncUrl() {
  const p = new URLSearchParams();
  p.set("run", state.run);
  if (state.view === "cum") p.set("view", "cum");
  if (state.cycle !== LATEST) p.set("cycle", state.cycle);
  if (state.tab !== TABS[0].id) p.set("tab", state.tab);
  try {
    history.replaceState(null, "", "?" + p);
  } catch {
    // Some browsers refuse URL updates for pages opened from disk; the page works the same without it.
  }
}

const render = safely(() => {
  Charts.destroyAll();
  lazy.disconnect();
  resizer.disconnect();
  renderHeader();
  renderFilters();
  renderKpis();
  renderSections();
  syncUrl();
});

async function switchRun() {
  const entry = RUNS.find((r) => r.id === state.run);
  document.body.classList.add("loading"); // keep the old render, dimmed, until the new run is in
  try {
    DATA = await loadRun(entry);
  } catch (err) {
    showError(err.message);
    return;
  } finally {
    document.body.classList.remove("loading");
  }
  try {
    if (closeDrawer) closeDrawer(false);
    DOMAINS = buildDomainIndex(DATA);
  } catch (err) {
    reportError(err);
  }
  LATEST = latestCompleteCycle(DATA);
  if (!DATA.cycles.includes(state.cycle)) state.cycle = LATEST;
  render();
}

// A running crawl logs a few wall-clock keys for its newest cycles before the rest (crawl 239994 had 15 of ~290 keys
// for cycles 73-88), so the page opens on the last cycle with at least half of the run's usual number of metrics.
function latestCompleteCycle(data) {
  const counts = data.cycles.map((_, i) => Object.values(data.metrics).filter((v) => v[i] != null).length);
  const full = Math.max(...counts);
  for (let i = counts.length - 1; i >= 0; i--) if (counts[i] >= full / 2) return data.cycles[i];
  return data.cycles.at(-1);
}

function initTheme() {
  const root = document.documentElement;
  const button = document.getElementById("theme");
  const current = () => root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const label = () => (button.textContent = current() === "dark" ? "Light mode" : "Dark mode");
  try {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") root.dataset.theme = saved;
  } catch {
    // Storage can be blocked (private windows, pages opened from disk); fall back to the system theme.
  }
  label();
  // Plotly takes its colors from the CSS variables when a chart is drawn, so a theme change redraws the page.
  button.addEventListener("click", () => {
    root.dataset.theme = current() === "dark" ? "light" : "dark";
    try {
      localStorage.setItem("theme", root.dataset.theme);
    } catch {
      // Not remembered across visits, but the switch still applies.
    }
    label();
    if (DATA) render();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    label();
    if (!root.dataset.theme && DATA) render();
  });
}

function main() {
  initTheme();
  window.addEventListener("error", (e) => {
    // Two reports are noise. The ResizeObserver notice is harmless: the resize lands a frame later. A bare "Script
    // error." has no details to show and usually comes from a browser extension; the dashboard reports its own errors.
    if (/ResizeObserver loop/.test(e.message || "") || (e.message === "Script error." && !e.filename)) {
      console.warn("Ignored:", e.message);
      return;
    }
    showError(`Something broke while drawing the page: ${e.message}`);
  });
  if (!window.Plotly) {
    showError("Couldn't load the chart library (Plotly) from cdn.jsdelivr.net, so the charts are blank. The headline numbers, domain lists and Table buttons still work; check the internet connection and reload.");
  }
  if (!RUNS.length) {
    showError('No exported runs yet. Run "python export.py" in the project folder, then reload.');
    return;
  }
  const p = new URLSearchParams(location.search);
  state.run = RUNS.some((r) => r.id === p.get("run")) ? p.get("run") : RUNS[0].id;
  state.view = p.get("view") === "cum" ? "cum" : "per";
  state.cycle = parseInt(p.get("cycle"), 10);
  const wanted = p.get("tab") || location.hash.slice(1); // links from before the tabs pointed at #<section>
  if (TABS.some((t) => t.id === wanted)) state.tab = wanted;

  // Arrow keys, Home and End move between tabs, as in any tab list.
  document.getElementById("tabs").addEventListener("keydown", (e) => {
    const i = TABS.findIndex((t) => t.id === state.tab);
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (to == null || !TABS[to]) return;
    e.preventDefault();
    selectTab(TABS[to].id, true);
  });

  document.getElementById("f-run").addEventListener("change", (e) => {
    state.run = e.target.value;
    switchRun();
  });
  document.getElementById("f-cycle").addEventListener("change", (e) => {
    state.cycle = +e.target.value;
    render();
  });
  for (const b of document.querySelectorAll("[data-view]")) {
    b.addEventListener("click", () => {
      state.view = b.dataset.view;
      render();
    });
  }
  switchRun();
}

main();
