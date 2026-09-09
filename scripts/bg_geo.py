#!/usr/bin/env python3
"""
Block group outlines, and putting a coordinate inside one.

Shared by the scripts that need to attach a block group to something with a
latitude and longitude - assessor parcels, and Redfin listings. Kept in one
place so both use the same outlines and the same point-in-polygon rules.
"""

import json
import urllib.error
import urllib.parse
import urllib.request

TIGERWEB = (
    "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer"
)
BLOCK_GROUP_LAYER = 10
STATE = "06"
COUNTY = "037"


class GeoError(Exception):
    """A problem the user needs to act on, reported without a traceback."""


# --- Block group outlines ---------------------------------------------------


def fetch_json(url, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": "la-home-data-overlay-map/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_block_groups():
    """
    All LA County block group polygons from TIGERweb, paged around the
    server's record cap. Returns [(geoid, [rings])].
    """
    print("Fetching block group outlines from TIGERweb...")
    collected = {}
    offset = 0
    while True:
        params = urllib.parse.urlencode(
            {
                "where": f"STATE='{STATE}' AND COUNTY='{COUNTY}'",
                "outFields": "GEOID",
                "returnGeometry": "true",
                "outSR": "4326",
                "f": "json",
                "resultOffset": str(offset),
                "resultRecordCount": "1000",
            },
            quote_via=urllib.parse.quote,
        )
        url = f"{TIGERWEB}/{BLOCK_GROUP_LAYER}/query?{params}"
        try:
            data = fetch_json(url)
        except urllib.error.HTTPError as err:
            raise GeoError(f"TIGERweb refused the block group query (HTTP {err.code}): {url}") from err
        except Exception as err:  # noqa: BLE001 - network, DNS, timeouts
            raise GeoError(f"could not reach TIGERweb ({type(err).__name__}: {err})") from err

        if "error" in data:
            raise GeoError(f"TIGERweb error: {data['error'].get('message')}")

        features = data.get("features", [])
        for f in features:
            geoid = (f.get("attributes") or {}).get("GEOID")
            rings = (f.get("geometry") or {}).get("rings")
            if geoid and rings:
                collected[geoid] = rings

        print(f"  {len(collected)} block groups so far...")
        if not data.get("exceededTransferLimit") or not features:
            break
        offset += len(features)

    if not collected:
        raise GeoError(
            "TIGERweb returned no block groups for LA County. That usually means the layer id "
            f"({BLOCK_GROUP_LAYER}) moved - check {TIGERWEB}?f=json for the current 'Census Block Groups' id."
        )
    print(f"  {len(collected)} block groups.")
    return collected


# --- Point in polygon, with a grid index -----------------------------------
# 2.4 million parcels against 6,500 polygons is 15 billion comparisons done
# naively. The grid narrows each parcel to the handful of polygons whose
# bounding box covers its cell, which is what makes this run in minutes.

GRID = 0.01  # degrees, about 1.1 km


def ring_contains(x, y, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def ring_is_clockwise(ring):
    total = 0.0
    for i in range(len(ring) - 1):
        total += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1])
    return total >= 0


def build_index(block_groups):
    """cell -> [(geoid, bbox, outer_rings, hole_rings)]"""
    index = {}
    shapes = {}
    for geoid, rings in block_groups.items():
        # Esri winding: clockwise rings are outer, counter-clockwise are holes.
        outer = [r for r in rings if ring_is_clockwise(r)]
        holes = [r for r in rings if not ring_is_clockwise(r)]
        if not outer:
            outer = rings
            holes = []
        xs = [p[0] for r in rings for p in r]
        ys = [p[1] for r in rings for p in r]
        bbox = (min(xs), min(ys), max(xs), max(ys))
        shapes[geoid] = (bbox, outer, holes)

        for cx in range(int(bbox[0] / GRID), int(bbox[2] / GRID) + 1):
            for cy in range(int(bbox[1] / GRID), int(bbox[3] / GRID) + 1):
                index.setdefault((cx, cy), []).append(geoid)
    return index, shapes


def locate(lon, lat, index, shapes):
    for geoid in index.get((int(lon / GRID), int(lat / GRID)), ()):
        bbox, outer, holes = shapes[geoid]
        if not (bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]):
            continue
        if any(ring_contains(lon, lat, r) for r in outer) and not any(
            ring_contains(lon, lat, h) for h in holes
        ):
            return geoid
    return None


