# Domain investigations: data contract

The Domain explorer joins exported **per-cycle** tables by exact `domain`. It does not compute domain attempts from CDX counts or infer budget from `TOPN_PER_DOMAIN`. Cumulative mode does not aggregate these diagnostics: its cycle context is always displayed. Existing top-50 tables continue to populate overview and HTTP error rankings.

The crawler/logger is outside this repository. To populate the new views, log these W&B `Table` history keys alongside `cycle`. `export.py` now allowlists them. Re-exporting existing runs will only populate fields that have actually been logged. All values below are per cycle, not running totals.

| Table key | Columns | Meaning |
| --- | --- | --- |
| `domains/diagnostics` | `domain`, `allocated budget`, `attempts`, `failures`, `pages fetched` | Actual allocation; attempted downloads; failed attempts including network failures; successful pages. Use the same attempt population for attempts and failures. |
| `frontier/links_by_domain` | `domain`, `outlinks`, `distinct outlinks` | Links extracted **from** pages on this source domain; count distinct target URLs separately. These are contribution/diversity signals, not quality scores. |
| `frontier/priority_score_by_domain` | `domain`, `spearman`, `pearson`, `scored pairs` | Within-domain correlation between selection priority and eventual fetched-page score, using paired observations from that cycle. Log null for constant inputs/undefined correlation. Keep the score definition consistent with the run's existing priority-vs-score metric. |
| `domains/page_examples` | `domain`, `url`, optionally `title`, `status`, `FineWeb-Edu`, `fastText quality` | Representative actual crawled URLs. A sample is not a full domain inventory. Status can include failed HTTP responses. |

Use numeric values for counts/scores, null for unknown values and strings for domain/URL/title. Prefer normalized lowercase domains without schemes or paths and consistent domain assignment across tables. Zero is valid and distinct from missing. Correlation rankings exclude undefined/out-of-range coefficients and records with fewer than 3 scored pairs; this threshold does not establish statistical significance. Lowest means most negative, not closest to zero.

Derived metrics:

- Failure rate = `100 × failures / attempts`, only for positive attempts and `0 ≤ failures ≤ attempts`.
- Budget attempted = `100 × attempts / allocated budget`, only for positive allocation. It can exceed 100%; retries or allocation overruns need investigation.
- Existing `fetch/top_failing_domains` is labeled **HTTP 4xx/5xx**. It does not include all network/download failures and must not be divided by CDX successful-page counts.

Example URLs must use HTTP(S), have no embedded credentials, and belong to the domain or a subdomain. Other URLs are omitted. The drawer shows up to 20 exported examples for the selected cycle. Links open today's web content, not a stored crawl artifact. Do not log private URLs or credentials: exported data is public.

Missing records do not imply zero. Existing tables are top-50 samples; diagnostics and link rankings are limited to the rows exported by the logger. Correlations are logged measurements, not correlations between aggregate quality means across cycles. Sample sizes and population differences should guide interpretation.
