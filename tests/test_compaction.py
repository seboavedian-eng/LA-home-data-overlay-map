#!/usr/bin/env python3
"""
Run the whole census fetch end to end, with the network stubbed out.

This exists because nothing did. Every other test here checks a helper in
isolation, so main() - which is where the tables are actually stitched into
records - was never executed, and two bugs shipped straight through:

  * the detailed-origin fields were computed and never written, because the
    table had silently failed to fetch;
  * `total` was used as a local variable inside main(), which makes Python
    treat the module-level total() helper as local for the whole function, so
    an earlier call to it raised UnboundLocalError. The run died at
    "Compacting..." - after ten minutes of downloading.

Both are invisible to a unit test of any single function and obvious the
moment main() is run. So it is run.

Run: python3 tests/test_compaction.py
"""

import importlib.util
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "scripts", "fetch-blockgroup-data.py")
spec = importlib.util.spec_from_file_location("fetch_bg", os.path.normpath(SCRIPT))
fetch_bg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch_bg)

failures = []


def check(name, ok, detail=""):
    print(("PASS - " if ok else "FAIL - ") + name + (f" :: {detail}" if detail else ""))
    if not ok:
        failures.append(name)


BG = "060372011001"
TRACT = BG[:11]
# The three that are only published at tract level.
TRACT_ONLY = {"B03001", "B02015", "B04006"}


def fake_value(code):
    # A table's own total is bigger than its parts, so shares come out sane.
    return "4000" if code.endswith("_001E") else "400"


def fake_fetch_table(base, variables, key, label, prefer="block group", require_values=False):
    geo = "tract" if label in TRACT_ONLY else "block group"
    geoid = TRACT if geo == "tract" else BG
    return {geoid: {code: fake_value(code) for code in variables}}, geo


def fake_group_variables(base, table):
    # Distinct names per table, so the merge is actually exercised rather than
    # collapsing three identical labels into one.
    stem = {"B03001": "Hisp", "B02015": "Asian", "B04006": "Anc"}.get(table, table)
    return {f"{table}_002E": f"{stem}One", f"{table}_003E": f"{stem}Two"}


fetch_bg.fetch_table = fake_fetch_table
fetch_bg.fetch_group_variables = fake_group_variables

out_path = os.path.join(tempfile.mkdtemp(), "bg.json")
argv = sys.argv
sys.argv = ["fetch-blockgroup-data.py", "--key", "test-key", "--out", out_path]
try:
    fetch_bg.main()
    ran = True
    error = ""
except BaseException as err:  # noqa: BLE001 - the point is to catch anything
    ran = False
    error = f"{type(err).__name__}: {err}"
finally:
    sys.argv = argv

check("the fetch script runs end to end without raising", ran, error)
if not ran:
    print(f"\nFAILURES: {', '.join(failures)}")
    sys.exit(1)

with open(out_path, encoding="utf-8") as fh:
    payload = json.load(fh)

rec = payload["blockGroups"].get(BG, {})
check("it writes a record for the block group", bool(rec), f"{len(payload['blockGroups'])} block groups")
check(
    "the age brackets survive - this is the call that died on the shadowed helper",
    isinstance(rec.get("ageBrackets"), dict) and len(rec["ageBrackets"]) == 23,
    f"{len(rec.get('ageBrackets') or {})} brackets",
)
check(
    "the schema version the page expects is written",
    payload["meta"].get("schemaVersion") == 9,
    str(payload["meta"].get("schemaVersion")),
)

# --- Detailed origin: ONE ranking across all three tables --------------------
top = rec.get("originTop") or {}
check("the merged ranking reaches the record", bool(top), str(sorted(k for k in rec if k.startswith("origin"))))
check(
    "it comes from the block group's TRACT, and says so",
    rec.get("originTopGeo") == "tract",
    str(rec.get("originTopGeo")),
)
check(
    "it holds percentages, not head counts",
    bool(top) and all(0 < v <= 100 for v in top.values()),
    str(top),
)
check(
    "every group is divided by the SAME denominator - the tract's population",
    rec.get("originTopTotal") == 4000,
    f"{rec.get('originTopTotal')} (B02015's own total must not be used)",
)
check(
    "groups from all three tables can appear in one list",
    set((rec.get("originTopSource") or {}).values()) <= {"B03001", "B02015", "B04006"}
    and bool(rec.get("originTopSource")),
    str(rec.get("originTopSource")),
)
check(
    "no more than five are kept",
    len(top) <= 5,
    f"{len(top)} groups",
)
check(
    "the per-table lists are gone - the question was one top five, not three",
    not any(k in rec for k in ("originHispanic", "originAsian", "originAncestry")),
    str(sorted(k for k in rec if k.startswith("origin"))),
)

check(
    "which tables landed is recorded, so the page can explain an empty section",
    payload["meta"].get("originTables") == {"B03001": "tract", "B02015": "tract", "B04006": "tract"},
    str(payload["meta"].get("originTables")),
)

print()
if failures:
    print(f"{len(failures)} FAILURE(S): " + ", ".join(failures))
    sys.exit(1)
print("All checks passed.")
