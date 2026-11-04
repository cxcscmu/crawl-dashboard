/* Optional domain diagnostics use explicit columns; never infer attempts from CDX page counts. */
"use strict";
const DomainMetrics = (() => {
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  const count = (v) => finite(v) && v >= 0 ? v : null;
  function rows(data, key, cycle) {
    const t = data.tables?.[key]?.[cycle];
    if (!t || !Array.isArray(t.columns) || !Array.isArray(t.data)) return [];
    return t.data.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i]])));
  }
  function domains(data, cycle) {
    const index = new Map();
    const visit = (key, fields) => {
      for (const row of rows(data, key, cycle)) {
        if (typeof row.domain !== "string" || !row.domain.trim()) continue;
        const r = index.get(row.domain) || { domain: row.domain };
        for (const [field, column] of Object.entries(fields)) {
          if (finite(row[column])) r[field] = row[column];
        }
        index.set(row.domain, r);
      }
    };
    visit("domains/top_domains", { pages: "pages" });
    for (const key of ["text/top_domains_by_fineweb_edu", "text/top_domains_by_pages"]) {
      visit(key, { en: "English scored pages", edu: "FineWeb-Edu mean", ft: "fastText quality mean" });
    }
    visit("fetch/top_failing_domains", { httpErrors: "4xx/5xx responses" });
    visit("domains/diagnostics", { budget: "allocated budget", attempts: "attempts", failures: "failures", pages: "pages fetched" });
    visit("frontier/links_by_domain", { outlinks: "outlinks", distinctOutlinks: "distinct outlinks" });
    visit("frontier/priority_score_by_domain", { spearman: "spearman", pearson: "pearson", pairs: "scored pairs" });
    return [...index.values()].map((r) => ({
      ...r,
      failureRate: count(r.failures) != null && r.attempts > 0 && r.failures <= r.attempts ? 100 * r.failures / r.attempts : null,
      budgetUse: count(r.attempts) != null && r.budget > 0 ? 100 * r.attempts / r.budget : null,
    }));
  }
  function rank(records, key, ascending = false) {
    return records.filter((r) => finite(r[key]) &&
      (!["spearman", "pearson"].includes(key) || (r.pairs >= 3 && Math.abs(r[key]) <= 1)))
      .sort((a, b) => (ascending ? a[key] - b[key] : b[key] - a[key]) || a.domain.localeCompare(b.domain));
  }
  function weightedMean(records, valueKey, weightKey) {
    const valid = records.filter((r) => finite(r[valueKey]) && finite(r[weightKey]) && r[weightKey] > 0);
    const weight = valid.reduce((sum, r) => sum + r[weightKey], 0);
    return weight ? valid.reduce((sum, r) => sum + r[valueKey] * r[weightKey], 0) / weight : null;
  }
  function pageUrl(value, domain) {
    try {
      const u = new URL(value);
      const host = u.hostname.toLowerCase();
      const d = domain.toLowerCase();
      return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password &&
        (host === d || host.endsWith("." + d)) ? u.href : null;
    } catch { return null; }
  }
  function examples(data, domain, cycle) {
    return rows(data, "domains/page_examples", cycle).filter((r) => r.domain === domain)
      .map((r) => ({ ...r, url: pageUrl(r.url, domain) })).filter((r) => r.url);
  }
  return { rows, domains, rank, examples, finite, weightedMean };
})();
if (typeof module !== "undefined") module.exports = DomainMetrics;
