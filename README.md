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

## View it

The data files aren't in the repo, so export at least one run first. Then open `site/index.html` in a browser. Double-clicking works: the data loads as script files, so no local server is needed. To serve it instead, run `python3 -m http.server -d site 8000`. The charts use Plotly, which the page loads from cdn.jsdelivr.net, so the browser needs an internet connection.

In each chart, hovering lists every series at that cycle. Click a legend entry to hide that series, or double-click it to show only that series. The menu in a chart's top-right corner has zoom, pan, reset and PNG download.

The sections are tabs in the bar at the top. Arrow keys move between them, and the buttons at the bottom of each section go to the previous or next one. Sections a run has no data for are greyed out.

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
- The two top-domain tables come from different files.
  - `domains/top_domains` counts HTTP 200 records in the cycle's WARC index (CDX).
  - `text/top_domains_by_pages` counts pages in the segment's `parse_data` that the scorer rated as English.
  - In crawl 233150 the two cycle totals agree to within 0.5%, but per domain they don't. Some domains have far more English pages than 200 records. For example, `igenea.com` has 2,060 English pages vs. 446 200 records in cycle 6, and `knowunity.com` has 2,164 English pages in cycle 9 with too few 200 records to make the top 50. So a few pages are assigned to one domain in the WARC and to another in the parse output. Both of those sites have country domains, which points at redirects, but this hasn't been confirmed.
- Pages past the per-domain cap: until 2026-10-22 the fetcher followed redirects to other domains inline, skipping the target domain's per-cycle limit. This is why domains such as `hugedomains.com` pass 250 in crawl 233150.
- In crawls that use the fetch cache (crawl 239994), replayed pages have no WARC record. So everything counted from the CDX (domains, hosts, fetched-page lists, HTTP status shares) covers only the pages actually requested, 63-78% of each cycle's pages in its first cycles.

## Not in W&B for crawl-233150

- **Fetch cache.** This run predates the cache; `crawl-237653` logs it.
- **DataMan and Nemotron scores.** Only `quality-237653` has them: a 20k-page sample per cycle of the Common Crawl-style run.
- **A random-priority baseline** for the priority-vs-score correlation.
- **Downstream results.** These are tokens after the English filter per cycle (from the 53B runs), and DCLM Core with its 5 category scores for the 1B-1x pretrain (the prod rows in the sheet).

The page shows each of these as an empty card that lists the W&B keys it expects. A run that logs those keys fills the card in automatically.
