#!/usr/bin/env python3
"""
Offline checks for scripts/fetch-wind-data.py.

There is no Global Wind Atlas file in the repo (they are large, and licensed
for download rather than redistribution), so these build synthetic GeoTIFFs
with the same georeferencing tags GWA writes and check the conversion against
values we can compute by hand. That covers the parts most likely to break
silently: the north-up geotransform, the clip to LA County, cell averaging,
and no-data handling.

Run: python3 tests/test_wind_grid.py     (needs: pip install numpy tifffile)
"""

import importlib.util
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.normpath(os.path.join(HERE, "..", "scripts", "fetch-wind-data.py"))
spec = importlib.util.spec_from_file_location("fetch_wind", SCRIPT)
fetch_wind = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch_wind)

import numpy as np
import tifffile

failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'} - {name}" + (f" :: {detail}" if detail else ""))
    if not ok:
        failures.append(name)


def write_geotiff(path, array, west, north, pixel=0.01, geographic=True, georeferenced=True):
    extratags = []
    if georeferenced:
        extratags = [
            (fetch_wind.TAG_MODEL_PIXEL_SCALE, "d", 3, (pixel, pixel, 0.0), True),
            (fetch_wind.TAG_MODEL_TIEPOINT, "d", 6, (0.0, 0.0, 0.0, west, north, 0.0), True),
            # GeoKeyDirectory header (1,1,0,1) then one key: GTModelType.
            (
                fetch_wind.TAG_GEO_KEY_DIRECTORY,
                "H",
                8,
                (1, 1, 0, 1, fetch_wind.GEOKEY_MODEL_TYPE, 0, 1, 2 if geographic else 1),
                True,
            ),
        ]
    tifffile.imwrite(path, array.astype("float32"), extratags=extratags)


tmp = tempfile.mkdtemp()

# --- A north-up raster over LA County, 0.01 deg pixels ---------------------
# 200 cols x 200 rows starting at (-118.6, 34.4) covers -118.6..-116.6 lon and
# 32.4..34.4 lat, which straddles the clip box on every side.
rows = cols = 200
gradient = np.tile(np.linspace(2.0, 10.0, cols), (rows, 1))  # west 2 m/s -> east 10 m/s
tif_path = os.path.join(tmp, "wind.tif")
write_geotiff(tif_path, gradient, west=-118.6, north=34.4)

array, geo = fetch_wind.read_geotiff(tif_path)
check("reads the raster back at full size", array.shape == (rows, cols), str(array.shape))
check("origin comes from the tiepoint", abs(geo["west"] + 118.6) < 1e-9 and abs(geo["north"] - 34.4) < 1e-9, str(geo))
check("pixel size comes from ModelPixelScale", abs(geo["pixel_w"] - 0.01) < 1e-12, str(geo["pixel_w"]))

grid = fetch_wind.to_grid(array, geo, fetch_wind.DEFAULT_CLIP, 0.01)

# The clip box is wider than the raster on the west and south, so the output
# must be the intersection, not the clip box itself.
check(
    "output is clipped to the overlap, not to the requested box",
    abs(grid["bbox"]["west"] + 118.6) < 1e-9 and abs(grid["bbox"]["north"] - 34.4) < 1e-9,
    str(grid["bbox"]),
)
check(
    "eastern and southern edges come from the clip box",
    abs(grid["bbox"]["east"] + 117.5) < 1e-9 and abs(grid["bbox"]["south"] - 32.7) < 1e-9,
    str(grid["bbox"]),
)
check(
    "grid dimensions match the box and cell size",
    grid["ncols"] == 110 and grid["nrows"] == 170,
    f"{grid['ncols']}x{grid['nrows']}",
)
check("values array is nrows*ncols, row-major", len(grid["values"]) == grid["nrows"] * grid["ncols"])

# Row 0 runs west to east along the top of the raster, so it must rise with
# the gradient - this is what catches a flipped or transposed geotransform.
first_row = grid["values"][: grid["ncols"]]
check("west edge is the low end of the gradient", abs(first_row[0] - 2.0) < 0.1, str(first_row[0]))
check("values rise from west to east", first_row[-1] > first_row[0] + 3, f"{first_row[0]} -> {first_row[-1]}")
check("every cell in the overlap has a value", all(v is not None for v in grid["values"]))

# Latitude must decrease down the rows: sample the same column in the first
# and last row of a raster whose values encode latitude.
lat_encoded = np.tile(np.linspace(9.0, 1.0, rows).reshape(rows, 1), (1, cols))
lat_path = os.path.join(tmp, "lat.tif")
write_geotiff(lat_path, lat_encoded, west=-118.6, north=34.4)
lat_array, lat_geo = fetch_wind.read_geotiff(lat_path)
lat_grid = fetch_wind.to_grid(lat_array, lat_geo, fetch_wind.DEFAULT_CLIP, 0.01)
top = lat_grid["values"][0]
bottom = lat_grid["values"][(lat_grid["nrows"] - 1) * lat_grid["ncols"]]
check("row 0 is the NORTH edge, not the south", top > bottom, f"north={top} south={bottom}")

# --- No-data handling ------------------------------------------------------
with_holes = gradient.copy()
with_holes[:, :50] = -999.0  # the sentinel GWA uses over unmodelled ground
holes_path = os.path.join(tmp, "holes.tif")
write_geotiff(holes_path, with_holes, west=-118.6, north=34.4)
h_array, h_geo = fetch_wind.read_geotiff(holes_path)
h_grid = fetch_wind.to_grid(h_array, h_geo, fetch_wind.DEFAULT_CLIP, 0.01)
h_first_row = h_grid["values"][: h_grid["ncols"]]
check("negative sentinels become null, not negative wind", h_first_row[0] is None, str(h_first_row[0]))
check("cells outside the sentinel area still carry data", h_first_row[-1] is not None)

# --- Error paths -----------------------------------------------------------
plain_path = os.path.join(tmp, "plain.tif")
write_geotiff(plain_path, gradient, west=-118.6, north=34.4, georeferenced=False)
try:
    fetch_wind.read_geotiff(plain_path)
    check("a TIFF with no GeoTIFF tags is rejected", False)
except fetch_wind.WindDataError as err:
    check("a TIFF with no GeoTIFF tags is rejected with advice", "Global Wind Atlas" in str(err), str(err)[:70])

proj_path = os.path.join(tmp, "projected.tif")
write_geotiff(proj_path, gradient, west=400000, north=3800000, geographic=False)
try:
    fetch_wind.read_geotiff(proj_path)
    check("a projected raster is rejected", False)
except fetch_wind.WindDataError as err:
    check("a projected raster is rejected with a reprojection hint", "gdalwarp" in str(err), str(err)[:70])

far_path = os.path.join(tmp, "faraway.tif")
write_geotiff(far_path, gradient, west=10.0, north=55.0)  # Denmark, where GWA is based
f_array, f_geo = fetch_wind.read_geotiff(far_path)
try:
    fetch_wind.to_grid(f_array, f_geo, fetch_wind.DEFAULT_CLIP, 0.01)
    check("a raster that misses LA County is rejected", False)
except fetch_wind.WindDataError as err:
    check("a raster that misses LA County says what it covers", "File covers" in str(err), str(err)[:70])

try:
    fetch_wind.read_geotiff(os.path.join(tmp, "nope.tif"))
    check("a missing file is reported clearly", False)
except fetch_wind.WindDataError as err:
    check("a missing file is reported clearly", "no such file" in str(err))

print(f"\n{len(failures) and 'FAILURES: ' + ', '.join(failures) or 'All checks passed.'}")
sys.exit(1 if failures else 0)
