#!/usr/bin/env python3
"""
Turn Redfin CSV downloads into the listings layer the map draws.

WHERE THE CSV COMES FROM
------------------------
On redfin.com, search with your filters, switch to the table view, scroll to
the bottom of the table and click "Download All". You get a file named
redfin_YYYYMMDDHHMMSS.csv - keep that name, because the download time in it is
the only record of when the data was true. Redfin caps a download at 350 homes
and hides the button under 20, so pull one file per neighbourhood and drop
them all in raw-data/.

WHAT THIS ADDS THAT THE CSV DOES NOT HAVE
-----------------------------------------
  * The block group each home sits in, so the map can show a block group's
    listings when you select it.
  * firstSeen / lastSeen per home, carried across runs. A listing's "days on
    market" in the file is only true on the day it was downloaded, so the
    listing date is reconstructed as download date minus days on market, and
    the map counts forward from there. That also makes "new since last
    download" a fact rather than a guess.

Run: python scripts/import-listings.py
Output: js/data/listings.json
"""

import argparse
import csv
import datetime
import glob
import importlib.util
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("bg_geo", os.path.join(HERE, "bg_geo.py"))
bg_geo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bg_geo)

DEFAULT_PATTERN = os.path.join("raw-data", "redfin_*.csv")
DEFAULT_OUT = os.path.join("js", "data", "listings.json")

# Redfin's column names, as the download writes them.
COLUMNS = {
    "status": ["STATUS"],
    "type": ["PROPERTY TYPE"],
    "address": ["ADDRESS"],
    "city": ["CITY"],
    "zip": ["ZIP OR POSTAL CODE"],
    "price": ["PRICE"],
    "beds": ["BEDS"],
    "baths": ["BATHS"],
    "sqft": ["SQUARE FEET"],
    "lot": ["LOT SIZE"],
    "built": ["YEAR BUILT"],
    "dom": ["DAYS ON MARKET"],
    "ppsf": ["$/SQUARE FEET"],
    "hoa": ["HOA/MONTH"],
    "url": ["URL"],
    "source": ["SOURCE"],
    "mls": ["MLS#"],
    "lat": ["LATITUDE"],
    "lon": ["LONGITUDE"],
    "open_start": ["NEXT OPEN HOUSE START TIME"],
}

# A lot under this many units is being reported in acres, not square feet -
# Redfin switches units on larger parcels without changing the column name.
ACRE_THRESHOLD = 100
SQFT_PER_ACRE = 43560


class ListingsError(Exception):
    """A problem the user needs to act on, reported without a traceback."""


def find_column(header, candidates):
    lowered = {h.lower().strip(): h for h in header if h}
    for candidate in candidates:
        if candidate.lower() in lowered:
            return lowered[candidate.lower()]
    for candidate in candidates:
        for key, original in lowered.items():
            if key.startswith(candidate.lower()):
                return original
    return None


def to_number(value):
    try:
        return float(str(value).replace(",", "").replace("$", "").strip())
    except (TypeError, ValueError):
        return None


def download_time(path):
    """
    The download time, taken from the file name. Redfin names its exports
    redfin_YYYYMMDDHHMMSS.csv, and that timestamp is the only record of when
    the snapshot was true - the rows themselves carry no date.
    """
    name = os.path.basename(path)
    match = re.search(r"(20\d{2})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?", name)
    if not match:
        # Fall back to the file's own modification time rather than refusing:
        # a renamed file is still usable, just less precisely dated.
        stamp = datetime.datetime.fromtimestamp(os.path.getmtime(path))
        return stamp, False
    year, month, day = int(match.group(1)), int(match.group(2)), int(match.group(3))
    hour = int(match.group(4) or 0)
    minute = int(match.group(5) or 0)
    second = int(match.group(6) or 0)
    return datetime.datetime(year, month, day, hour, minute, second), True


def read_csv(path, index, shapes, stats):
    """One Redfin export -> a list of listing dicts."""
    downloaded, from_name = download_time(path)
    stats["files"].append(
        {"file": os.path.basename(path), "downloaded": downloaded.isoformat(timespec="seconds"), "datedFromName": from_name}
    )

    listings = []
    with open(path, newline="", encoding="utf-8-sig", errors="replace") as fh:
        reader = csv.reader(fh)
        header = next(reader, None)
        if not header:
            raise ListingsError(f"{path} is empty.")
        cols = {key: find_column(header, names) for key, names in COLUMNS.items()}
        missing = [k for k in ("address", "price", "lat", "lon", "url") if not cols[k]]
        if missing:
            raise ListingsError(
                f"{os.path.basename(path)} is missing {', '.join(missing)}.\n"
                f"  Columns found: {', '.join(h for h in header if h)}\n"
                "  Is this a Redfin 'Download All' export?"
            )
        idx = {key: header.index(col) for key, col in cols.items() if col}

        for row in reader:
            # Redfin puts a legal notice on its own line under the header:
            # "In accordance with local MLS rules, some MLS listings are not
            # included in the download". Any row too short to hold the columns
            # is a note, not a listing.
            if len(row) < len(header) - 2:
                stats["skipped_notes"] += 1
                continue

            def cell(key):
                i = idx.get(key)
                return row[i].strip() if i is not None and i < len(row) else ""

            lat, lon = to_number(cell("lat")), to_number(cell("lon"))
            price = to_number(cell("price"))
            if lat is None or lon is None or price is None:
                stats["skipped_incomplete"] += 1
                continue

            geoid = bg_geo.locate(lon, lat, index, shapes)
            if geoid is None:
                stats["outside_county"] += 1

            lot = to_number(cell("lot"))
            lot_sqft = None
            if lot is not None:
                lot_sqft = round(lot * SQFT_PER_ACRE) if lot < ACRE_THRESHOLD else round(lot)

            dom = to_number(cell("dom"))
            listed = None
            if dom is not None:
                listed = (downloaded.date() - datetime.timedelta(days=int(dom))).isoformat()

            listings.append(
                {
                    "id": cell("url") or f"{cell('mls')}:{cell('source')}",
                    "address": cell("address"),
                    "city": cell("city"),
                    "zip": cell("zip"),
                    "price": round(price),
                    "beds": to_number(cell("beds")),
                    "baths": to_number(cell("baths")),
                    "sqft": to_number(cell("sqft")),
                    "lotSqft": lot_sqft,
                    "yearBuilt": to_number(cell("built")),
                    "listedOn": listed,
                    "status": cell("status"),
                    "type": cell("type"),
                    "hoa": to_number(cell("hoa")),
                    "url": cell("url"),
                    "mls": cell("mls"),
                    "source": cell("source"),
                    "openHouse": cell("open_start"),
                    "lat": lat,
                    "lon": lon,
                    "geoid": geoid,
                    "seen": downloaded.isoformat(timespec="seconds"),
                }
            )
    return listings


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pattern", default=DEFAULT_PATTERN, help="Where the Redfin exports are")
    parser.add_argument("--out", default=DEFAULT_OUT, help="Output JSON path")
    args = parser.parse_args()

    paths = sorted(glob.glob(args.pattern))
    if not paths:
        raise ListingsError(
            f"no Redfin exports matched {args.pattern}.\n"
            "  On redfin.com: search, switch to the table view, scroll to the bottom of the table,\n"
            "  click 'Download All', and save the file into raw-data/ keeping its redfin_... name."
        )
    print(f"Found {len(paths)} export(s): {', '.join(os.path.basename(p) for p in paths)}")

    block_groups = bg_geo.fetch_block_groups()
    index, shapes = bg_geo.build_index(block_groups)

    # Carry firstSeen forward from the last run, so "new" means new to you and
    # not merely new to this file.
    previous = {}
    if os.path.exists(args.out):
        try:
            with open(args.out, encoding="utf-8") as fh:
                old = json.load(fh)
            for rows in (old.get("byBlockGroup") or {}).values():
                for row in rows:
                    if row.get("id"):
                        previous[row["id"]] = row
        except Exception as err:  # noqa: BLE001 - a corrupt old file must not stop a new one
            print(f"  (could not read the previous {args.out}: {err})")

    stats = {"files": [], "skipped_notes": 0, "skipped_incomplete": 0, "outside_county": 0}
    merged = {}
    for path in paths:
        for listing in read_csv(path, index, shapes, stats):
            existing = merged.get(listing["id"])
            # The same home can appear in two neighbourhood exports. Keep the
            # newest row, but keep the EARLIEST sighting.
            if existing is None or listing["seen"] > existing["seen"]:
                first = (existing or {}).get("firstSeen") or listing["seen"]
                listing["firstSeen"] = first
                listing["lastSeen"] = listing["seen"]
                merged[listing["id"]] = listing
            else:
                existing["firstSeen"] = min(existing["firstSeen"], listing["seen"])

    new_count = 0
    for listing in merged.values():
        was = previous.get(listing["id"])
        if was and was.get("firstSeen"):
            listing["firstSeen"] = min(listing["firstSeen"], was["firstSeen"])
        elif not was:
            new_count += 1
        listing.pop("seen", None)

    by_bg = {}
    for listing in merged.values():
        by_bg.setdefault(listing["geoid"] or "unplaced", []).append(listing)
    for rows in by_bg.values():
        rows.sort(key=lambda r: -r["price"])

    latest = max((f["downloaded"] for f in stats["files"]), default=None)
    payload = {
        "meta": {
            "schemaVersion": 1,
            "source": "Redfin 'Download All' export",
            "generated": datetime.datetime.now().isoformat(timespec="seconds"),
            "latestDownload": latest,
            "files": stats["files"],
            "note": (
                "Active listings from Redfin CSV downloads. Days on market is stored as the date "
                "the home was listed - download date minus the days-on-market in the file - so the "
                "map can count forward from it instead of showing a number that was only true on "
                "the day of the download."
            ),
        },
        "byBlockGroup": by_bg,
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))

    placed = sum(len(v) for k, v in by_bg.items() if k != "unplaced")
    print(f"\nWrote {args.out} ({os.path.getsize(args.out) / 1024:.0f} KB)")
    for f in stats["files"]:
        note = "" if f["datedFromName"] else "  <-- dated from the file's timestamp, not its name"
        print(f"  {f['file']}: downloaded {f['downloaded']}{note}")
    print(f"  {len(merged)} distinct listings, {placed} placed in {len(by_bg) - (1 if 'unplaced' in by_bg else 0)} block groups")
    if previous:
        print(f"  {new_count} of them are new since the last run")
    else:
        print("  (first run, so every listing counts as new)")
    if stats["outside_county"]:
        print(f"  {stats['outside_county']} fell outside every LA County block group")
    if stats["skipped_notes"]:
        print(f"  {stats['skipped_notes']} MLS notice row(s) skipped")
    if stats["skipped_incomplete"]:
        print(f"  {stats['skipped_incomplete']} row(s) had no price or coordinates")
    print("\nReload blockgroups.html and select a block group to see its listings.")


if __name__ == "__main__":
    try:
        main()
    except ListingsError as err:
        print(f"\nCould not import the listings: {err}\n", file=sys.stderr)
        sys.exit(1)
