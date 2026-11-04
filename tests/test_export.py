"""Export-boundary checks without W&B credentials or a network call."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("dashboard_export", Path(__file__).resolve().parents[1] / "export.py")
export = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {"wandb": types.ModuleType("wandb")}):
    spec.loader.exec_module(export)


class ExportTests(unittest.TestCase):
    def test_optional_tables_survive_cycle_merge_and_export(self):
        optional = ["domains/diagnostics", "domains/page_examples", "frontier/links_by_domain", "frontier/priority_score_by_domain"]
        history = [dict(cycle=1, _step=1, **{key: {"_type": "table-file", "path": key} for key in optional}),
                   {"cycle": 1, "_step": 2, "fetch/pages": 10},
                   {"cycle": 1, "_step": 3, "domains/page_examples": None}]
        run = types.SimpleNamespace(id="test-run", name="test", state="finished", url="https://example.test", created_at="now", config={}, scan_history=lambda **kwargs: history)
        api = types.SimpleNamespace(run=lambda _: run)
        table = {"columns": ["domain", "url"], "data": [["example.test", "https://example.test/article"]]}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(export, "ROOT", root), patch.object(export, "DATA_DIR", root), patch.object(export, "load_table", return_value=table):
                export.export_run(api, "test/project", "test-run")
            text = (root / "test-run.js").read_text()
            payload = json.loads(text.split(" = ", 2)[2].rstrip(";\n"))
            self.assertEqual(payload["cycles"], [1])
            self.assertEqual(payload["metrics"]["fetch/pages"], [10])
            for key in optional:
                self.assertEqual(payload["tables"][key]["1"], table)


if __name__ == "__main__":
    unittest.main()
