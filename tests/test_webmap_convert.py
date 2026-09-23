"""Tests for scripts/convert-arcgis-webmap.py.

The interesting failures here are all geometric and all silent: a hole
converted as a separate polygon draws a second zone over the first, and a
projection done wrong puts every zone a few streets off without anything
looking broken. So the tests check the maths against known values and the
winding rules against shapes built to exercise them.

Run:  python tests/test_webmap_convert.py
"""

import importlib.util
import json
import os
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location(
    "webmap_convert", os.path.join(REPO, "scripts", "convert-arcgis-webmap.py")
)
wc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wc)

failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'} - {name}" + (f" :: {detail}" if detail else ""))
    if not ok:
        failures.append(name)


def test_projection():
    """The real webmap's Schools2 layer carries both projected and geographic
    coordinates for the same schools. Those pairs are the test."""
    cases = [
        ("Glendale High", -13161638, 4048426, -118.23299, 34.14602),
        ("Hoover High", -13165638, 4050986, -118.26893, 34.16505),
        ("Monte Vista Elementary", -13161956, 4059797, -118.23585, 34.23051),
        ("Dunsmore Elementary", -13164467, 4060994, -118.25841, 34.23940),
        ("Cerritos Elementary", -13164038, 4045656, -118.25455, 34.12542),
    ]
    worst = 0.0
    for name, x, y, want_lon, want_lat in cases:
        lon, lat = wc.web_mercator_to_wgs84(x, y)
        worst = max(worst, abs(lon - want_lon), abs(lat - want_lat))
    check(
        "Web Mercator converts to within a couple of metres of the published lat/lon",
        worst < 0.00005,
        f"worst error {worst:.6f} degrees, about {worst * 111000:.1f} m",
    )
    lon, lat = wc.web_mercator_to_wgs84(0, 0)
    check("the origin maps to null island, not to an offset", lon == 0 and lat == 0, f"{lon},{lat}")


def test_level_naming():
    """Districts name these layers inconsistently, and one overlap is a trap:
    'Senior High' and 'Junior High' both contain 'high'."""
    cases = [
        ("Elementary_School", "elementary"),
        ("ES Boundaries", "elementary"),
        ("Middle_School", "middle"),
        ("High_School_Boundaries", "high"),
        ("Senior High Attendance", "high"),
        ("Junior High Attendance", "middle"),
        ("Intermediate Schools", "middle"),
        ("Parcels", None),
    ]
    for title, expected in cases:
        got = wc.level_of(title)
        check(f"layer named {title!r} reads as {expected}", got == expected, f"got {got}")


def test_winding():
    """ArcGIS marks a hole by winding it the other way, not by its position.
    Treating every ring as an outer ring turns one zone with a hole into two
    overlapping zones - which on a translucent layer looks like a darker patch
    rather than like a bug."""
    outer = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]          # clockwise-ish
    hole = [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]]                # the other way
    check(
        "an outer ring and a hole wind in opposite directions",
        (wc.signed_area(outer) < 0) != (wc.signed_area(hole) < 0),
        f"outer {wc.signed_area(outer):.1f}, hole {wc.signed_area(hole):.1f}",
    )
    geom_type, coords = wc.rings_to_geojson([outer, hole], already_wgs84=True)
    check(
        "a ring plus its hole becomes ONE polygon, not two",
        geom_type == "Polygon" and len(coords) == 2,
        f"{geom_type} with {len(coords)} ring(s)",
    )
    check("the hole is carried as the second ring", coords[1][0] == [2, 2], str(coords[1][0]))

    # Two separate areas for one school - a zone split by a park, say.
    second = [[20, 0], [20, 5], [25, 5], [25, 0], [20, 0]]
    geom_type, coords = wc.rings_to_geojson([outer, second], already_wgs84=True)
    check(
        "two separate outer rings become a MultiPolygon, not a polygon with a hole",
        geom_type == "MultiPolygon" and len(coords) == 2,
        f"{geom_type} with {len(coords)} part(s)",
    )
    check(
        "an unclosed ring is closed rather than rejected",
        wc.rings_to_geojson([[[0, 0], [0, 1], [1, 1]]], already_wgs84=True)[1][0][0]
        == wc.rings_to_geojson([[[0, 0], [0, 1], [1, 1]]], already_wgs84=True)[1][0][-1],
        "shapefiles often omit the closing point",
    )
    check("point_in_ring finds a point inside", wc.point_in_ring([5, 5], outer))
    check("...and rejects one outside", not wc.point_in_ring([50, 50], outer))


def webmap(layers):
    return {"operationalLayers": layers}


def feature_layer(title, level_name, features, wkid=102100, version=10.3, fields=None):
    return {
        "title": title,
        "featureCollection": {
            "layers": [{
                "layerDefinition": {
                    "name": level_name,
                    "geometryType": "esriGeometryPolygon",
                    "currentVersion": version,
                    "fields": fields if fields is not None else [
                        {"name": "schnam"}, {"name": "NCES_ID"}, {"name": "DistrictId"}
                    ],
                    "spatialReference": {"wkid": wkid, "latestWkid": wkid},
                },
                "featureSet": {
                    "features": features,
                    "geometryType": "esriGeometryPolygon",
                    "spatialReference": {"wkid": wkid, "latestWkid": wkid},
                },
            }]
        },
    }


def poly(name, nces, district="0615240"):
    return {
        "geometry": {"rings": [[
            [-13161638, 4048426], [-13161638, 4049426],
            [-13160638, 4049426], [-13160638, 4048426], [-13161638, 4048426],
        ]]},
        "attributes": {"schnam": name, "NCES_ID": nces, "DistrictId": district},
    }


def test_convert():
    zones, reports, vintage, skipped = wc.convert(webmap([
        feature_layer("Elementary_School", "Elementary_School", [poly("BALBOA ELEMENTARY", "061524001919")]),
        feature_layer("Middle_School", "Middle_School", [poly("ROSEMONT MIDDLE", "061524001944")]),
        feature_layer("High_School", "High_School_Boundaries", [poly("GLENDALE HIGH", "061524001931")]),
    ]))
    check("every level is converted", len(zones) == 3, f"{len(zones)} zones")
    levels = sorted(z["properties"]["level"] for z in zones)
    check("each lands under the right switch", levels == ["elementary", "high", "middle"], str(levels))
    check(
        "the NCES id survives, which is how a zone finds its rating",
        zones[0]["properties"]["ncessch"] == "061524001919",
        str(zones[0]["properties"]),
    )
    check(
        "the district id survives, which is how SABS is suppressed for it",
        zones[0]["properties"]["district"] == "0615240",
        str(zones[0]["properties"]["district"]),
    )
    coords = zones[0]["geometry"]["coordinates"][0][0]
    check(
        "coordinates come out as lon/lat in California, not as raw metres",
        -119 < coords[0] < -117 and 33 < coords[1] < 35,
        str(coords),
    )
    # The honesty requirement: the script must not stay quiet about age.
    check(
        "an old ArcGIS version is reported as a vintage signal",
        any("2015" in s for s in vintage),
        str(vintage),
    )
    check(
        "SABS-style field names are reported as a vintage signal",
        any("SABS" in s for s in vintage),
        str(vintage),
    )

    # A modern layer with its own field naming should NOT be flagged.
    _, _, quiet, _ = wc.convert(webmap([
        feature_layer(
            "Elementary_School", "ES", [poly("NEW ELEMENTARY", "1")],
            version=11.2, fields=[{"name": "SchoolName"}, {"name": "District"}],
        )
    ]))
    check("a modern layer is not flagged as old", quiet == [], str(quiet))


def test_refusals():
    """Wrong input should say what is wrong, not half-convert."""
    try:
        wc.convert({"operationalLayers": []})
        check("an empty webmap is refused", False, "no error raised")
    except wc.ConvertError as err:
        check("an empty webmap is refused with a useful message", "/data?f=json" in str(err), str(err))

    try:
        wc.convert(webmap([feature_layer("Elementary_School", "ES", [poly("X", "1")], wkid=2229)]))
        check("an unknown projection is refused", False, "no error raised")
    except wc.ConvertError as err:
        check("an unknown projection is refused rather than silently misplaced",
              "projection" in str(err), str(err))

    # A hosted-service layer has no embedded data and must be reported, not
    # silently dropped - the user needs to know to use the URL instead.
    zones, _, _, skipped = wc.convert(webmap([
        feature_layer("Elementary_School", "ES", [poly("REAL", "1")]),
        {"title": "Hosted Layer", "url": "https://services5.arcgis.com/x/FeatureServer/0"},
    ]))
    check("a hosted-service layer is reported rather than silently skipped",
          any("hosted service" in s for s in skipped), str(skipped))
    check("...and the embedded layers still convert", len(zones) == 1, f"{len(zones)}")

    zones, _, _, skipped = wc.convert(webmap([
        feature_layer("Elementary_School", "ES", [poly("REAL", "1")]),
        feature_layer("Parcels", "Parcels", [poly("NOT A SCHOOL", "1")]),
    ]))
    check("a layer whose level cannot be read is skipped and named",
          len(zones) == 1 and any("Parcels" in s for s in skipped), str(skipped))


def test_end_to_end():
    with tempfile.TemporaryDirectory() as tmp:
        source = os.path.join(tmp, "glendale-school-zones.json")
        out = os.path.join(tmp, "out.json")
        with open(source, "w", encoding="utf-8") as handle:
            json.dump(webmap([
                feature_layer("Elementary_School", "Elementary_School",
                              [poly("BALBOA ELEMENTARY", "061524001919"),
                               poly("CERRITOS ELEMENTARY", "061524001920")]),
                feature_layer("High_School", "High_School_Boundaries",
                              [poly("GLENDALE HIGH", "061524001931")]),
            ]), handle)
        code = wc.main([source, "--out", out, "--label", "Glendale Unified"])
        check("the script runs end to end and exits clean", code == 0, f"exit {code}")
        with open(out, encoding="utf-8") as handle:
            payload = json.load(handle)
    check("the output is a GeoJSON FeatureCollection the page can read",
          payload["type"] == "FeatureCollection" and len(payload["features"]) == 3,
          f"{len(payload.get('features', []))} features")
    check("the counts are recorded per level",
          payload["meta"]["counts"] == {"elementary": 2, "high": 1},
          str(payload["meta"]["counts"]))
    check("the label reaches the file, so the card can name the source",
          payload["meta"]["label"] == "Glendale Unified", payload["meta"]["label"])
    check("the vintage signals are recorded, not just printed once and lost",
          len(payload["meta"]["vintageSignals"]) >= 1, str(payload["meta"]["vintageSignals"]))

    code = wc.main([os.path.join(tempfile.gettempdir(), "definitely-missing.json")])
    check("a missing input file is an error, not a traceback", code == 1, f"exit {code}")


def main():
    test_projection()
    test_level_naming()
    test_winding()
    test_convert()
    test_refusals()
    test_end_to_end()
    print(f"\n{'FAILED: ' + ', '.join(failures) if failures else 'All webmap-convert checks passed.'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
