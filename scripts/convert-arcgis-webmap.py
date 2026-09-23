#!/usr/bin/env python3
"""
Turn an ArcGIS Online webmap into local school attendance zone polygons.

WHY THIS EXISTS
---------------
Some districts publish their attendance zones inside an ArcGIS webmap as an
EMBEDDED feature collection rather than as a hosted feature service. There is
no URL to query - the geometry lives inside the map item itself. That is the
case for Glendale Unified, and it is a good thing: saved locally, the zones
need no network at all and cannot vanish when someone retires a service.

WHAT TO SAVE
------------
Open this in a browser, and save the response as a .json file:

    https://www.arcgis.com/sharing/rest/content/items/<ITEM_ID>/data?f=json

For Glendale Unified that item is 10b36192882842a88610a9b02c9e4c33, so:

    raw-data/glendale-school-zones.json

Then run:

    python scripts/convert-arcgis-webmap.py raw-data/glendale-school-zones.json

Output: js/data/school-zones-local.json

ON VINTAGE
----------
This script does not know how old the polygons are, and neither does the
webmap's "updated" date - that records when the ITEM was last saved, which
includes changing a colour or adding a bookmark. So it reports the signals it
can see (the layer's ArcGIS version, and whether the fields use SABS's own
`schnam`/`ncessch` naming) and leaves the judgement to you. The only test that
settles it is comparing a few addresses against the district's own school
finder.
"""

from __future__ import annotations

import argparse
import datetime
import json
import math
import os
import re
import sys

DEFAULT_OUT = os.path.join("js", "data", "school-zones-local.json")
EARTH_CIRCUMFERENCE_HALF = 20037508.34  # metres, Web Mercator x at 180 degrees

# Which switch a layer belongs under, read from its title. Deliberately loose:
# districts name these "Elementary_School", "ES Boundaries", "High_School".
LEVEL_PATTERNS = [
    ("elementary", re.compile(r"element|\bes\b|primary|k-?5|k-?6", re.I)),
    ("middle", re.compile(r"middle|junior|\bms\b|intermediate|\bjhs\b", re.I)),
    ("high", re.compile(r"high|senior|\bhs\b", re.I)),
]

NAME_FIELDS = ["schnam", "SCHNAM", "School", "SCHOOL", "Name", "NAME", "SchoolName"]
NCES_FIELDS = ["NCES_ID", "ncessch", "NCESSCH", "NCES"]
DISTRICT_FIELDS = ["DistrictId", "LEAID", "leaid", "District", "DISTRICT"]


class ConvertError(Exception):
    pass


def web_mercator_to_wgs84(x, y):
    """EPSG:3857 -> EPSG:4326. Verified against this webmap's own Schools2
    layer, which carries both projected and geographic coordinates for the
    same points: agreement to under two metres."""
    lon = x / EARTH_CIRCUMFERENCE_HALF * 180.0
    lat = y / EARTH_CIRCUMFERENCE_HALF * 180.0
    lat = 180.0 / math.pi * (2.0 * math.atan(math.exp(lat * math.pi / 180.0)) - math.pi / 2.0)
    return [round(lon, 6), round(lat, 6)]


def level_of(title):
    """High before middle before elementary would be wrong - 'Middle School'
    contains neither, but 'Senior High' and 'Junior High' both contain 'high'.
    So middle is tested first and wins the overlap."""
    for level, pattern in [LEVEL_PATTERNS[1], LEVEL_PATTERNS[2], LEVEL_PATTERNS[0]]:
        if pattern.search(title or ""):
            return level
    return None


def pick(attributes, candidates):
    for key in candidates:
        if key in attributes and attributes[key] not in (None, ""):
            return attributes[key]
    # Case-insensitive second pass.
    lowered = {str(k).lower(): v for k, v in attributes.items()}
    for key in candidates:
        value = lowered.get(key.lower())
        if value not in (None, ""):
            return value
    return None


def rings_to_geojson(rings, already_wgs84):
    """ArcGIS rings -> GeoJSON Polygon coordinates.

    ArcGIS does not distinguish outer rings from holes by position; it uses
    winding order - clockwise is an outer ring, anticlockwise is a hole. A
    naive conversion that treats every ring as its own polygon turns a zone
    with a hole in it into two overlapping zones.
    """
    outers = []
    holes = []
    for ring in rings:
        converted = [
            point if already_wgs84 else web_mercator_to_wgs84(point[0], point[1])
            for point in ring
        ]
        if converted and converted[0] != converted[-1]:
            converted.append(converted[0])
        if signed_area(converted) < 0:
            outers.append(converted)
        else:
            holes.append(converted)

    if not outers:
        # Every ring wound the same way - treat them all as separate outers
        # rather than dropping the zone entirely.
        outers = holes
        holes = []

    polygons = [[outer] for outer in outers]
    for hole in holes:
        # Put each hole in the first outer ring that contains its first point.
        target = next(
            (p for p in polygons if point_in_ring(hole[0], p[0])),
            polygons[0] if polygons else None,
        )
        if target:
            target.append(hole)

    if len(polygons) == 1:
        return "Polygon", polygons[0]
    return "MultiPolygon", polygons


def signed_area(ring):
    """Positive means anticlockwise. ArcGIS winds outer rings clockwise."""
    total = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        total += (x2 - x1) * (y2 + y1)
    return -total / 2.0


def point_in_ring(point, ring):
    x, y = point
    inside = False
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        if (y1 > y) != (y2 > y):
            crosses = x1 + (y - y1) / (y2 - y1) * (x2 - x1)
            if crosses > x:
                inside = not inside
    return inside


def convert(webmap):
    layers = webmap.get("operationalLayers") or []
    if not layers:
        raise ConvertError(
            "no operationalLayers in that file. Make sure you saved the "
            "/data?f=json response and not the item page."
        )

    zones = []
    reports = []
    vintage_signals = set()
    skipped = []

    for layer in layers:
        title = layer.get("title") or layer.get("id") or ""
        collection = layer.get("featureCollection") or {}
        sublayers = collection.get("layers") or []
        if not sublayers:
            # A hosted service layer: it has a url instead of embedded data,
            # and this script has nothing to convert.
            if layer.get("url"):
                skipped.append(f"{title} (hosted service: {layer['url']})")
            continue

        for sub in sublayers:
            definition = sub.get("layerDefinition") or {}
            feature_set = sub.get("featureSet") or {}
            if definition.get("geometryType") != "esriGeometryPolygon":
                continue

            level = level_of(title) or level_of(definition.get("name"))
            if not level:
                skipped.append(f"{title} (could not tell which level)")
                continue

            version = definition.get("currentVersion")
            if version and float(version) < 10.6:
                vintage_signals.add(f"layer built on ArcGIS {version} (that is roughly 2015)")
            field_names = {f.get("name") for f in definition.get("fields") or []}
            if {"schnam", "NCES_ID"} & field_names or {"ncessch"} & field_names:
                vintage_signals.add(
                    "fields are named the way NCES SABS names them (schnam / NCES_ID), "
                    "so this is very likely SABS data republished"
                )

            spatial = feature_set.get("spatialReference") or definition.get("spatialReference") or {}
            wkid = spatial.get("latestWkid") or spatial.get("wkid")
            already_wgs84 = wkid in (4326, 4269)
            if wkid not in (4326, 4269, 3857, 102100):
                raise ConvertError(
                    f"{title}: coordinates are in an unexpected projection (wkid {wkid}). "
                    "This script handles Web Mercator and WGS84."
                )

            names = []
            for feature in feature_set.get("features") or []:
                geometry = feature.get("geometry") or {}
                rings = geometry.get("rings")
                if not rings:
                    continue
                attributes = feature.get("attributes") or {}
                name = pick(attributes, NAME_FIELDS)
                if not name:
                    continue
                geom_type, coordinates = rings_to_geojson(rings, already_wgs84)
                zones.append({
                    "type": "Feature",
                    "geometry": {"type": geom_type, "coordinates": coordinates},
                    "properties": {
                        "schnam": str(name).strip(),
                        "level": level,
                        "ncessch": (str(pick(attributes, NCES_FIELDS) or "").strip() or None),
                        "district": (str(pick(attributes, DISTRICT_FIELDS) or "").strip() or None),
                    },
                })
                names.append(str(name).strip())
            if names:
                reports.append((level, title, names))

    if not zones:
        raise ConvertError(
            "found no polygon zones. The webmap may hold its layers as hosted "
            "services rather than embedded data, in which case give the app the "
            "service URL instead of running this script."
        )
    return zones, reports, sorted(vintage_signals), skipped


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("webmap", help="The saved /data?f=json file")
    parser.add_argument("--out", default=DEFAULT_OUT, help="Output GeoJSON path")
    parser.add_argument("--label", default=None, help="What to call this source on the card")
    args = parser.parse_args(argv)

    try:
        with open(args.webmap, encoding="utf-8-sig") as handle:
            webmap = json.load(handle)
    except OSError as err:
        print(f"Could not read {args.webmap}: {err}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as err:
        print(f"{args.webmap} is not valid JSON: {err}", file=sys.stderr)
        return 1

    try:
        zones, reports, vintage, skipped = convert(webmap)
    except ConvertError as err:
        print(f"Could not convert it: {err}", file=sys.stderr)
        return 1

    counts = {}
    for zone in zones:
        level = zone["properties"]["level"]
        counts[level] = counts.get(level, 0) + 1

    label = args.label or os.path.splitext(os.path.basename(args.webmap))[0].replace("-", " ")
    payload = {
        "meta": {
            "generated": datetime.date.today().isoformat(),
            "schemaVersion": 1,
            "label": label,
            "source": os.path.basename(args.webmap),
            "counts": counts,
            "vintageSignals": vintage,
        },
        "type": "FeatureCollection",
        "features": zones,
    }

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"))

    print(f"Wrote {args.out} ({os.path.getsize(args.out) / 1024:.0f} KB)\n")
    for level, title, names in reports:
        print(f"  {level:11s} from {title!r}: {len(names)} zones")
        for name in sorted(names):
            print(f"      {name}")
        print()
    if skipped:
        print("Skipped:")
        for entry in skipped:
            print(f"  {entry}")
        print()
    if vintage:
        print("HOW OLD IS THIS? The file itself suggests:")
        for signal in vintage:
            print(f"  - {signal}")
        print(
            "  A webmap's 'updated' date is when the ITEM was last saved, which\n"
            "  includes changing a colour. It does not date the geometry. Check a\n"
            "  few addresses against the district's own school finder to settle it.\n"
        )
    print("Reload the page. These zones are used ahead of the county-wide SABS layer.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
