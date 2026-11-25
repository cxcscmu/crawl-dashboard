# Crawl metrics dashboard

A static page of the crawler metrics logged to the W&B project `cxcscmu/crawl4llm-dashboard`, one section per metric group: page quality, language, text usability, domain diversity, prioritization, fetch outcomes, fetch cache, speed, storage and downstream results. `export.py` pulls runs from W&B into `site/data/`, and `site/index.html` reads those files. There is no server or build step.

**Live page:** https://cxcscmu.github.io/crawl-dashboard/, refreshed every hour. It shows the runs listed in `runs.txt`; see [Publishing](#publishing).

## Setup (once)

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/wandb login    # paste the API key from https://forge.coreweave.com/wandb/authorize
```

Your W&B account needs to be in the `cxcscmu` team. `wandb login` saves the key to `~/.netrc`, outside this folder; never commit it. On a server or in CI, set `WANDB_API_KEY` instead.

## Refresh the data

```bash
.venv/bin/python export.py                                # the runs in runs.txt (what the live page shows)
.venv/bin/python export.py crawl-237099                   # any other run in the project, added to the list
.venv/bin/python export.py --tag dashboard                # every run with this tag in W&B
.venv/bin/python export.py --list                         # what runs exist, with their tags
```

Each run becomes `site/data/<run>.js`, and `site/data/runs.js` lists them for the page's run picker. Exporting a run again replaces it in place. Exporting `runs.txt` or a tag makes the picker list exactly those runs. Run ids on the command line are added to the list instead. If there's nothing to export, the script stops with an error and writes nothing. Downloaded W&B tables are cached in `.wandb_cache/`, so a refresh only fetches what's new.

## Raw data check (optional)

The **Raw data check** section doesn't come from W&B. It shows numbers read straight from a crawl's segments and WARC index on the cluster: per-domain count mismatches and their cause, priority vs page score, fetch outcomes, links, and example pages with their text. `rawdata.py` builds its files from the per-cycle extracts (`<src>/<prefix>-c<N>/`, written on the cluster):

```bash
.venv/bin/pip install pandas
.venv/bin/python rawdata.py crawl-233150 233150 1-9 --src ~/crawl-data/v2    # run id on the page, folder prefix, cycles
```

This writes `site/data/raw/<run>.js` plus a folder of per-cycle domain tables and example pages. A run without these files simply has an empty Raw data check tab.

Every crawl and cycle at full size would not fit the site's 1 GB (every domain alone is about 15–16 GB), so the published build keeps each cycle's 3,000 domains with the most pages and no example pages; each cycle's own numbers still count every domain, and the page says what is left out. It runs on Boston, which has the extracts' `urls/` files, for every crawl and cycle, with each crawl's notes on priority, the per-domain fetch-list limit and the page score (`rawdata_run_all.sh` and `rawdata_run_fix.sh`, kept with the cluster jobs in `~/crawl-data/extract-src`). For example:

```bash
OPIC="its OPIC cash, which the pages linking to it pass on, weighted by their page score"
SEED=" The seeds already hold different amounts of cash in the first cycle."
python rawdata.py crawl-265639 265639 1-47 --src $B/v2 --out $P/rawdata/out --max-domains 3000 --no-examples --label "crawl 265639" --priority-def "$OPIC" --seed-note "$SEED" --procs 8
```

`--procs` builds that many cycles at once, and `--score-def` says what the page score is in a crawl (prod: "its fastText quality score"). Crawls whose crawler tags no page languages (the CC-style crawl, TrustRank, plain OPIC) leave out the English and bot-check columns and say so. Without `--max-domains` and `--no-examples` you get the full version, which goes to Hugging Face rather than this site.

To put a new build on the live page, replace the release file the publish job downloads. It holds all of `site/data/raw` (the Raw data check, `extra-*.js` and the junk files); the next hourly run, or a push, picks it up:

```bash
tar czf raw-data.tar.gz -C site/data raw
gh release upload raw-data raw-data.tar.gz --clobber      # first time: gh release create raw-data raw-data.tar.gz
```

A published GitHub Pages site can be at most 1 GB, so keep `site/data/raw` well under that.

## Keys a run doesn't log (optional)

Crawls 259887, 265639, 269821 and 271533 log only the wall-clock keys (`wall/*`) to W&B. `extra.py` fills in their HTTP, domain, language, page-length and score keys from our own read of the crawl (the cluster jobs `run_cdx.sbatch` and `run_text.sbatch`, kept with the extracts in `~/crawl-data`). It calls the same functions of Jerry's `crawl_logger.py` that make the W&B keys, so the charts read them unchanged:

```bash
~/crawl-data/py/bin/python extra.py crawl-259887 259887 crawl-265639 265639 crawl-269821 269821 crawl-271533 271533
```

Each run gets `site/data/raw/extra-<run>.js`, which ships in the same raw-data release as above. The top-domain tables (English pages, FineWeb-Edu) come from the extract's per-domain counts of every parsed page, and the domains with the most error responses from the WARC index; on 233150 the top-domain tables match W&B exactly. The page adds only keys W&B doesn't have, so a backfilled W&B run takes over by itself. Checked against crawl 233150, which logs everything: domains and HTTP shares match exactly, and score means are within about 1%.

The text keys come from every 10th part of each cycle's segment, scaled up, unless `--text-from <prefix>all` points at the same job run on every part (exact counts, nothing scaled); the page's note says which. `--override <key prefixes>` uses our keys in every cycle (the CC-style crawl's domain keys, which W&B counts from the WARC index alone), `--fill <key prefixes>` only in cycles W&B has no value for, and `CRAWL_DATA=<dir>` reads the inputs from somewhere other than `~/crawl-data` (on Boston).

## Junk check (optional)

The **Junk check** section shows how much of every crawl is junk, every cycle, by DCLM-Baseline's rules (`dclm_baseline_refinedweb_post_lang.yaml`, ported from mlfoundations/dclm) plus two of ours (`junk/`), and how that changes with the fastText, FineWeb-Edu and page scores and with priority. One switch picks the text:

- **Whole page (Nutch):** the crawler's parse text, what it scores and ranks by. Sampled from every 10th part of each cycle's segment: every page with a high crawler score (page score ≥ 0.95, fastText ≥ 0.5 or FineWeb-Edu ≥ 0.6) and 1 in 10 of the rest, weighted by how they were sampled. English means the crawler's own English tag, so its bot-check pages aren't in it. Crawls that stored no scores are scored with the crawler's own models and rules (`score_sample.py`).
- **Main content (Resiliparse):** the main-content text of Jerry's pretraining pipeline, what training uses: every 10th shard of each cycle and 1 in 10 of its pages. Scores are the crawler's models on this text under the crawler's rules: bot-check pages get no score (the crawler's own tag where it ran the scorer, else its rule run on the text).

It is built on Boston by cluster jobs kept in `~/crawl-data/extract-src` (with copies of `junk/`):

```bash
junk_sample.py <out> <scored sample files>          # whole page: every rule for every sampled page
junk_main.py <out> <crawl id>                       # main content: rules and scores for every sampled page
junk_botcheck.py <out> <crawl id>                   # main content: the crawler's bot-check rule on the same pages
junkpage.py <out> nutch|resil <crawl id> <prefix>   # the page's files for one run and text
```

`junkpage.py` writes `site/data/raw/junk/<run>/<nutch|resil>/`:
- `c<N>.js`: one cycle's sampled pages as compact arrays, so the browser recomputes every rate for whatever rules are ticked;
- `all.js`: a uniform subsample of up to 400k pages from every cycle, for the cumulative view;
- `index.js`: the junk share per preset and rule over cycles, example pages, and each run's own score percentile cuts.

`site/data/raw/junk/runs.js` lists the runs and texts that have files:

```bash
python3 -c 'import json,os; d="site/data/raw/junk"; r={x: sorted(v for v in ("nutch","resil") if os.path.exists(f"{d}/{x}/{v}/index.js")) for x in sorted(os.listdir(d)) if os.path.isdir(f"{d}/{x}")}; open(f"{d}/runs.js","w").write("window.CRAWL_JUNK_RUNS="+json.dumps(r,separators=(",",":"))+";\n")'
```

Readers tick which rules count as junk (three presets: the page rules, plus repeated n-grams on lines of 6+ words, every DCLM rule as written) and pick what a high score is: the training cut (fastText ≥ 0.018112), the run's own top 1/5/10%/half, or a fixed score at ClueWeb22's percentiles. The pies take each cycle's English share from every page (the text job, or Jerry's pipeline counts) and the junk split from the sample. On whole-page text DCLM's repetition and line rules mostly react to menus. `junkdata.py` and `junk.py`'s `pages.pkl` steps are the earlier three-cycle build, replaced by the jobs above.

## View it

The data files aren't in the repo, so export at least one run first. Then open `site/index.html` in a browser. Double-clicking works: the data loads as script files, so no local server is needed. To serve it instead, run `python3 -m http.server -d site 8000`. The charts use Plotly, which the page loads from cdn.jsdelivr.net, so the browser needs an internet connection.

**Compare** in the filter bar overlays other runs on the line charts, one color per run (the chart's own series, such as mean and median, are told apart by dash). Other chart types stay on the open run and say so. The selection is kept in the URL (`?compare=crawl-259887,crawl-265639`).

In each chart, hovering lists every series at that cycle. Click a legend entry to hide that series, or double-click it to show only that series. The menu in a chart's top-right corner has zoom, pan, reset and PNG download.

Sections are grouped in the left navigation on desktop and in the Section picker on mobile. Arrow keys, Home and End move between desktop sections; the buttons at the bottom go to the previous or next section. Cycle summary at the top holds the eight KPI tiles and can be collapsed; Run details opens the configuration. Unavailable figures and the run-wide missing-data list stay collapsed until requested. Figure search reveals a matching figure even when its group is collapsed.

The URL keeps the current view (`index.html?run=crawl-233150&view=cum&cycle=7&tab=domains`), so a copied link reopens the same view.

## Publishing

The GitHub Action in `.github/workflows/publish.yml` runs every hour (at :17), on every push to `main`, and from the **Run workflow** button on the Actions tab. It runs `export.py`, which exports the runs in `runs.txt`, and publishes `site/` with that data to GitHub Pages. The data files only exist in the published page, never in the repo.

- **Adding or removing a run.** Edit `runs.txt` and push. The push itself republishes the page. Use the W&B run id (`export.py --list` shows them), which can differ from the crawl number in the run's name. For example, crawl 239994 is the run `crawl-237653`. Tags would let people pick runs from W&B instead, but tagging needs edit rights on the run, so only the run's owner or a team admin can do it. If the runs get tagged, change the workflow to `export.py --tag dashboard`.
- **W&B key.** The Action reads it from the repository secret `WANDB_API_KEY` (Settings → Secrets and variables → Actions). It's currently Shlok's personal key. Replace that secret if the key changes or someone else takes over.
- **When something fails.** If the export fails (W&B down, an expired key, no tagged runs), the job stops and the last published page stays up. GitHub emails the person who last changed the workflow.
- **Pauses.** GitHub pauses scheduled jobs in a public repo after 60 days with no commits. To resume, open the Actions tab and click **Enable workflow**.
- **Caching.** Downloaded W&B tables are cached between runs (`actions/cache`), so a refresh only fetches new cycles.

The page and this repo are public.

## Changing what's shown

Charts are defined in the `SECTIONS` list at the top of `site/dashboard.js`. Each chart names the W&B keys it plots, so to add one, copy a similar entry and change the keys. The "Everything logged" table at the bottom of the page lists every key a run logged. Per-cycle tables (top domains, languages, failing domains) also have to be listed in `TABLES` in `export.py`.

The charts are drawn with [Plotly.js](https://plotly.com/javascript/) through the helpers in `site/charts.js` (line, stacked column, histogram and sparkline). The version is pinned to 3.7.0 in `site/index.html`, with an integrity hash. The domain lists and table views are plain HTML. Colors come from the CSS variables in `site/style.css`, and switching the theme redraws the charts in the other color set.

## How the data is read

- Runs log each cycle in several passes (a main row, then backfills), so `export.py` merges history rows by their `cycle` value. When a key was logged twice for the same cycle, the later step wins.
- English share of known-language pages: newer runs log `text/english_pct_of_language_known`. For runs that don't, the page computes it from the language table as English ÷ (all − unknown), which gives the same numbers on `crawl-237653`.
- HTTP status classes are sums of the per-code shares (for example, 4xx = 403 + 404 + 410 + 429 + other 4xx).
- Priorities logged as 0 in the seed cycle are left out of the priority chart.
- Quality sample: when the project has a run `quality-<job>` next to `crawl-<job>` (the 20,000-page per-cycle sample from `results/studies/cycle-quality-scores` in webcrawler-progress), `export.py` folds its `quality/*` keys into the crawl's cycles. That fills the DataMan and Nemotron charts in Page quality; today only `crawl-237653` has one, covering its cycles 1-69.
- The summary tiles follow the Per cycle / Cumulative toggle where the run logs both values; each tile says whether it's "this cycle" or "so far".
- A running crawl logs its `wall/` timing keys for each cycle before the rest of its metrics. The cycle picker lists only cycles with the full metrics; the wall-clock charts in Speed run to the newest cycle.
- The two top-domain tables come from different files.
  - `domains/top_domains` counts HTTP 200 records in the cycle's WARC index (CDX).
  - `text/top_domains_by_pages` counts pages in the segment's `parse_data` that the scorer rated as English.
  - In crawl 233150 the two cycle totals agree to within 0.5%, but per domain they don't. Some domains have far more English pages than 200 records. For example, `igenea.com` has 2,060 English pages vs. 446 200 records in cycle 6, and `knowunity.com` has 2,164 English pages in cycle 9 with too few 200 records to make the top 50. So a few pages are assigned to one domain in the WARC and to another in the parse output. Both of those sites have country domains, which points at redirects, but this hasn't been confirmed.
- Pages past the per-domain cap: until 2026-10-22 the fetcher followed redirects to other domains inline, skipping the target domain's per-cycle limit. This is why domains such as `hugedomains.com` pass 250 in crawl 233150.
- In crawls that use the fetch cache (crawl 239994), replayed pages have no WARC record. So everything counted from the CDX (domains, hosts, fetched-page lists, HTTP status shares) covers only the pages actually requested, 63-78% of each cycle's pages in its first cycles.

## Not in W&B for crawl-233150

- **Fetch cache.** This run predates the cache; `crawl-237653` logs it.
- **DataMan and Nemotron scores.** Only the Common Crawl-style run has a quality sample (`quality-237653`), which the page shows with that run.
- **A random-priority baseline** for the priority-vs-score correlation.
- **Downstream results.** These are tokens after the English filter per cycle (from the 53B runs), and DCLM Core with its 5 category scores for the 1B-1x pretrain (the prod rows in the sheet).

The page shows each of these as an empty card that lists the W&B keys it expects. A run that logs those keys fills the card in automatically.

## Domain explorer and figure search

**Find a figure** searches titles, descriptions and W&B metric keys across all sections. Select a result to open its section and focus the figure, including figures the current run has not logged.

**Domain explorer** filters sites and ranks them highest or lowest by fetched pages, quality, HTTP errors, actual failed attempts, failure rate, budget, outgoing links or within-domain priority/score correlation. Click any site for its cycle history, selected-cycle diagnostics and example crawled URLs. These diagnostic views always show the selected cycle, even with Cumulative selected.

The existing public snapshots supply domain quality and HTTP-error counts. Page examples, allocated budgets, attempt-based failure rates, links by source domain and per-domain correlations need additional W&B tables from the external crawler/logger. Modes, columns and the examples list appear only for runs that log the data behind them. See [the domain table contract](docs/domain-data.md) for exact keys, columns and definitions; the exporter is ready to include them when logged.

Run the calculation/validation tests with `node --test tests/domain-metrics.test.cjs`. Browser checks use Playwright from an existing installation: start `python3 -m http.server -d site 8000`, then run `node tests/dashboard.browser.cjs` (set `PLAYWRIGHT_MODULE` to its module path if necessary). Browser fixtures are illustrative and are intercepted in the test only, never written to public data files.
