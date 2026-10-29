#!/usr/bin/env python3
"""Export crawl runs from W&B into data files for the static dashboard in site/.

    python export.py                          # export the runs in runs.txt; the page shows only those
    python export.py crawl-233150 crawl-237653  # export these runs and add them to the page's list
    python export.py --tag dashboard          # export every run tagged "dashboard" in W&B; the page shows only those
    python export.py --list                   # show the runs in the project

Needs a W&B login that can see the cxcscmu team: run `wandb login` once, or set WANDB_API_KEY.
Writes site/data/<run>.js for each run and site/data/runs.js, the list the page's run picker offers.
"""

import argparse
import json
import math
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import wandb

PROJECT = "cxcscmu/crawl4llm-dashboard"

ROOT = Path(__file__).resolve().parent
RUNS_FILE = ROOT / "runs.txt"  # the runs the published page shows
DATA_DIR = ROOT / "site" / "data"
CACHE_DIR = ROOT / ".wandb_cache"  # table file names include a content hash, so cached copies never go stale

# Per-cycle tables the dashboard reads. Other tables are skipped to keep the data files small.
TABLES = {
    "domains/top_domains",
    "domains/top_domains_cumulative",
    "domains/top_new_domains",
    "text/top_domains_by_pages",
    "text/top_domains_by_pages_cumulative",
    "text/top_domains_by_fineweb_edu",
    "text/languages",
    "text/languages_cumulative",
    "fetch/top_failing_domains",
}


# The published page is public, so only the run settings it shows leave W&B (not, e.g., crawl_dir, a path on the cluster).
PAGE_CONFIG = {"crawl_job"}
PAGE_DRIVER_CONFIG = {"TOPN", "TOPN_RAMP", "TOPN_PER_DOMAIN", "TOPN_PER_HOST", "NODE_COUNT"}


def page_config(config):
    out = {k: config[k] for k in PAGE_CONFIG if k in config}
    driver = config.get("driver")
    if isinstance(driver, dict):
        out["driver"] = {k: driver[k] for k in PAGE_DRIVER_CONFIG if k in driver}
    return out


def merge_by_cycle(rows):
    """Runs log each cycle in several passes (a main row, then backfills), so fold them into one record per cycle.

    Later steps win, which also picks up corrections when a cycle was re-logged after a restart.
    """
    cycles = defaultdict(dict)
    for row in sorted(rows, key=lambda r: r.get("_step", 0)):
        cycle = row.get("cycle")
        if cycle is None:
            continue
        for key, value in row.items():
            if value is not None and not key.startswith("_") and key != "cycle":
                cycles[int(cycle)][key] = value
    return dict(sorted(cycles.items()))


def as_number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def histogram(value):
    packed = value.get("packedBins")
    if packed:
        return {"min": packed["min"], "size": packed["size"], "values": value["values"]}
    return {"bins": value.get("bins"), "values": value["values"]}


def load_table(run, path):
    local = CACHE_DIR / run.id / path
    if not local.exists():
        run.file(path).download(root=str(CACHE_DIR / run.id), replace=True)
    table = json.loads(local.read_text())
    return {"columns": table["columns"], "data": table["data"]}


def export_run(api, project, run_id):
    run = api.run(f"{project}/{run_id}")
    by_cycle = merge_by_cycle(run.scan_history(page_size=1000))
    cycles = list(by_cycle)
    metrics, histograms, tables = {}, {}, defaultdict(dict)

    for key in sorted({k for record in by_cycle.values() for k in record}):
        values = [by_cycle[c].get(key) for c in cycles]
        sample = next(v for v in values if v is not None)
        if isinstance(sample, dict):
            kind = sample.get("_type")
            if kind == "histogram":
                histograms[key] = [histogram(v) if isinstance(v, dict) else None for v in values]
            elif kind == "table-file" and key in TABLES:
                for cycle, value in zip(cycles, values):
                    if isinstance(value, dict) and value.get("path"):
                        tables[key][str(cycle)] = load_table(run, value["path"])
            continue
        numbers = [as_number(v) for v in values]
        if any(n is not None for n in numbers):
            metrics[key] = numbers

    exported_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    payload = {
        "id": run.id,
        "name": run.name,
        "state": run.state,
        "url": run.url,
        "created_at": run.created_at,
        "exported_at": exported_at,
        "config": page_config(dict(run.config)),
        "cycles": cycles,
        "metrics": metrics,
        "histograms": histograms,
        "tables": tables,
    }
    out = DATA_DIR / f"{run.id}.js"
    body = json.dumps(payload, separators=(",", ":"))
    out.write_text(
        f"// Generated by export.py from W&B run {project}/{run.id} at {exported_at}. Re-run export.py to refresh.\n"
        f"(window.CRAWL_DATA = window.CRAWL_DATA || {{}})[{json.dumps(run.id)}] = {body};\n"
    )
    print(
        f"{run.id}: {len(cycles)} cycles, {len(metrics)} metrics, {len(histograms)} histograms, "
        f"{sum(len(t) for t in tables.values())} tables -> {out.relative_to(ROOT)} ({out.stat().st_size / 1e6:.1f} MB)"
    )
    return {
        "id": run.id,
        "name": run.name,
        "state": run.state,
        "cycles": len(cycles),
        "exported_at": exported_at,
        "file": f"data/{run.id}.js",
    }


def listed_runs():
    ids = [line.split("#")[0].strip() for line in RUNS_FILE.read_text().splitlines()]
    return [i for i in ids if i]


def tagged_runs(api, project, tag):
    return [run.id for run in api.runs(project, filters={"tags": {"$in": [tag]}}, order="+created_at")]


def update_run_list(entries, replace=False):
    """Keep runs exported earlier in the picker; replace re-exported ones in place and append new ones.

    With replace, the picker lists exactly these runs, so a run taken out of runs.txt (or untagged) drops off the page.
    """
    path = DATA_DIR / "runs.js"
    existing = []
    if path.exists() and not replace:
        text = path.read_text()
        existing = json.loads(text[text.index("=") + 1 :].strip().rstrip(";"))
    fresh = {e["id"]: e for e in entries}
    merged = [fresh.pop(e["id"], e) for e in existing] + list(fresh.values())
    path.write_text(f"window.CRAWL_RUNS = {json.dumps(merged, indent=1)};\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("runs", nargs="*", help="run ids (default: the ones in runs.txt)")
    parser.add_argument("--project", default=PROJECT, help=f"W&B entity/project (default: {PROJECT})")
    parser.add_argument("--tag", help="export every run with this W&B tag instead of naming run ids")
    parser.add_argument("--list", action="store_true", help="list the project's runs and exit")
    args = parser.parse_args()
    if args.tag and args.runs:
        parser.error("pass run ids or --tag, not both")

    api = wandb.Api(timeout=120)
    if args.list:
        for run in api.runs(args.project, order="+created_at"):
            tags = f"  [{', '.join(run.tags)}]" if run.tags else ""
            print(f"{run.id:<20} {run.state:<9} {run.name}{tags}")
        return

    # runs.txt and --tag each define the page's whole list; run ids on the command line add to it.
    if args.runs:
        run_ids = args.runs
    elif args.tag:
        run_ids = tagged_runs(api, args.project, args.tag)
        print(f"Runs tagged {args.tag!r}: {' '.join(run_ids)}")
    else:
        run_ids = listed_runs()
    # Fail rather than publish an empty page, e.g. if the tag was mistyped or runs.txt was emptied.
    if not run_ids:
        raise SystemExit("No runs to export: runs.txt lists none, or no run has that tag.")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    update_run_list([export_run(api, args.project, run_id) for run_id in run_ids], replace=not args.runs)


if __name__ == "__main__":
    main()
