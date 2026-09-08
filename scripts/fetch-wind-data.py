#!/usr/bin/env python3
"""
Turn a Global Wind Atlas 3 GeoTIFF into the compact JSON grid the map draws.

WHY THIS IS A SCRIPT AND NOT A LIVE API CALL
--------------------------------------------
The Global Wind Atlas publishes rasters only: GeoTIFF downloads and cloud
optimised GeoTIFFs behind their own viewer. There is no tile service, no WMS,
and no feature service, so there is nothing a browser can toggle on directly.
This script does the conversion once, offline, and the page then reads a small
JSON grid - the same shape as the Census snapshot step.

WHAT TO DOWNLOAD (about two minutes)
------------------------------------
  1. Open https://globalwindatlas.info/en/area/United%20States%20of%20America
     (or the map view) and zoom to Los Angeles County.
  2. Pick "Mean wind speed" at the height you care about. 100 m is the GWA
     default; 10 m or 50 m is closer to what a house actually feels.
  3. Download the GeoTIFF for a custom area covering LA County. A box roughly
     -119.0 to -117.5 longitude and 32.7 to 34.9 latitude covers the county.
  4. Run:
         python scripts/fetch-wind-data.py path/to/downloaded.tif
     Add --height 50m if you downloaded a height other than 100 m, so the
     card and legend say the right thing.

The output lands in js/data/wind-la-county.json and the page picks it up on
the next reload.

DEPENDENCIES
------------
    pip install numpy tifffile

Deliberately not rasterio/GDAL: those need a compiler or a conda install on
Windows, and everything needed here (a single-band float raster plus the two
georeferencing tags) is available from tifffile directly.
"""

import argparse
import datetime
import json
import os
import sys

# --- GeoTIFF tag numbers, from the GeoTIFF 1.0 specification ---------------
# ModelPixelScale is (x-size, y-size, z-size) in CRS units per pixel.
# ModelTiepoint maps one raster point to one CRS point: (i, j, k, x, y, z).
TAG_MODEL_PIXEL_SCALE = 33550
TAG_MODEL_TIEPOINT = 33922
TAG_GEO_KEY_DIRECTORY = 34735

# GeoKey 1024 (GTModelTypeGeoKey) == 2 means geographic lat/lon, which is what
# the Global Wind Atlas ships. A projected raster would need reprojection that
# this script deliberately does not attempt.
GEOKEY_MODEL_TYPE = 1024
MODEL_TYPE_GEOGRAPHIC = 2

DEFAULT_OUTPUT = os.path.join("js", "data", "wind-la-county.json")

# LA County plus a margin. Anything outside is dropped, so a state- or
# country-wide download still produces a small file.
DEFAULT_CLIP = {"west": -119.0, "south": 32.7, "east": -117.5, "north": 34.9}

# Output cell size in degrees. 0.01 deg is about 1.1 km, which keeps the file
# near 200 KB. The source is 250 m; going finer multiplies the file size by
# the square of the ratio for detail the map cannot show at these zooms.
DEFAULT_CELL_DEGREES = 0.01


class WindDataError(Exception):
    """A problem the user needs to act on, reported without a traceback."""


def require_deps():
    try:
        import numpy  # noqa: F401
        import tifffile  # noqa: F401
    except ImportError as exc:
        raise WindDataError(
            f"missing dependency ({exc.name}).\n"
            "  Install both with:  pip install numpy tifffile"
        ) from exc


def read_geotiff(path):
    """Return (array, geotransform) where geotransform describes pixel 0,0."""
    import numpy as np
    import tifffile

    if not os.path.exists(path):
        raise WindDataError(f"no such file: {path}")

    with tifffile.TiffFile(path) as tif:
        page = tif.pages[0]
        tags = page.tags

        if TAG_MODEL_PIXEL_SCALE not in tags or TAG_MODEL_TIEPOINT not in tags:
            raise WindDataError(
                f"{path} has no GeoTIFF georeferencing tags (ModelPixelScale/ModelTiepoint).\n"
                "  It may be a plain TIFF, or a screenshot rather than the GIS download.\n"
                "  Re-download it from the Global Wind Atlas 'GIS files' / download button."
            )

        scale = tags[TAG_MODEL_PIXEL_SCALE].value
        tiepoint = tags[TAG_MODEL_TIEPOINT].value

        if TAG_GEO_KEY_DIRECTORY in tags:
            keys = tags[TAG_GEO_KEY_DIRECTORY].value
            # The directory is a flat array of 4-shorts: header then entries of
            # (key id, tiff tag location, count, value).
            for i in range(4, len(keys), 4):
                if keys[i] == GEOKEY_MODEL_TYPE and keys[i + 3] != MODEL_TYPE_GEOGRAPHIC:
                    raise WindDataError(
                        f"{path} is in a projected coordinate system, not lat/lon.\n"
                        "  Download the WGS84 / geographic version from the Global Wind Atlas,\n"
                        "  or reproject it first (gdalwarp -t_srs EPSG:4326 in.tif out.tif)."
                    )

        array = page.asarray()

    if array.ndim == 3:
        array = array[0] if array.shape[0] < array.shape[-1] else array[..., 0]
    array = np.asarray(array, dtype="float64")

    # Tiepoint (i, j, k, x, y, z): raster point i,j sits at CRS x,y.
    raster_i, raster_j = tiepoint[0], tiepoint[1]
    origin_x, origin_y = tiepoint[3], tiepoint[4]
    pixel_w, pixel_h = float(scale[0]), float(scale[1])

    # Northern origin is the norm: y decreases as the row index grows.
    west = origin_x - raster_i * pixel_w
    north = origin_y + raster_j * pixel_h

    return array, {"west": west, "north": north, "pixel_w": pixel_w, "pixel_h": pixel_h}


def to_grid(array, geo, clip, cell_degrees, nodata_below=0.0, nodata_above=60.0):
    """Average the raster into cell_degrees cells over the clip box."""
    import numpy as np

    rows, cols = array.shape
    src_west = geo["west"]
    src_north = geo["north"]
    src_east = src_west + cols * geo["pixel_w"]
    src_south = src_north - rows * geo["pixel_h"]

    west = max(clip["west"], src_west)
    east = min(clip["east"], src_east)
    south = max(clip["south"], src_south)
    north = min(clip["north"], src_north)

    if west >= east or south >= north:
        raise WindDataError(
            "the GeoTIFF does not overlap Los Angeles County.\n"
            f"  File covers  lon {src_west:.3f} to {src_east:.3f}, lat {src_south:.3f} to {src_north:.3f}\n"
            f"  Wanted       lon {clip['west']} to {clip['east']}, lat {clip['south']} to {clip['north']}\n"
            "  Re-download with LA County inside the selected area."
        )

    ncols = max(1, int(round((east - west) / cell_degrees)))
    nrows = max(1, int(round((north - south) / cell_degrees)))

    # Sentinel values in wind rasters are large negatives or zeros over water.
    clean = np.where((array > nodata_below) & (array < nodata_above), array, np.nan)

    values = []
    for row in range(nrows):
        cell_north = north - row * (north - south) / nrows
        cell_south = north - (row + 1) * (north - south) / nrows
        j0 = int((src_north - cell_north) / geo["pixel_h"])
        j1 = max(j0 + 1, int((src_north - cell_south) / geo["pixel_h"]))
        j0, j1 = max(0, j0), min(rows, j1)

        for col in range(ncols):
            cell_west = west + col * (east - west) / ncols
            cell_east = west + (col + 1) * (east - west) / ncols
            i0 = int((cell_west - src_west) / geo["pixel_w"])
            i1 = max(i0 + 1, int((cell_east - src_west) / geo["pixel_w"]))
            i0, i1 = max(0, i0), min(cols, i1)

            if j0 >= j1 or i0 >= i1:
                values.append(None)
                continue
            window = clean[j0:j1, i0:i1]
            mean = np.nanmean(window) if np.any(~np.isnan(window)) else np.nan
            values.append(None if np.isnan(mean) else round(float(mean), 2))

    return {
        "bbox": {"west": west, "south": south, "east": east, "north": north},
        "nrows": nrows,
        "ncols": ncols,
        "values": values,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("geotiff", help="Global Wind Atlas GeoTIFF covering LA County")
    parser.add_argument("--height", default="100 m", help='Height above ground the file represents (default "100 m")')
    parser.add_argument("--cell", type=float, default=DEFAULT_CELL_DEGREES, help="Output cell size in degrees")
    parser.add_argument("--out", default=DEFAULT_OUTPUT, help="Output JSON path")
    args = parser.parse_args()

    require_deps()
    array, geo = read_geotiff(args.geotiff)
    grid = to_grid(array, geo, DEFAULT_CLIP, args.cell)

    covered = sum(1 for v in grid["values"] if v is not None)
    if covered == 0:
        raise WindDataError(
            "every cell came out empty. The file overlaps LA County but holds no usable wind values -\n"
            "  check you downloaded a wind *speed* raster rather than, say, an RGB preview image."
        )

    speeds = [v for v in grid["values"] if v is not None]
    grid["meta"] = {
        "source": "Global Wind Atlas 3 (DTU Wind Energy / World Bank Group), CC BY 4.0",
        "height": args.height,
        "sourceFile": os.path.basename(args.geotiff),
        "cellDegrees": args.cell,
        "generated": datetime.datetime.now().strftime("%Y-%m-%d"),
        "units": "m/s",
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(grid, fh, separators=(",", ":"))

    size_kb = os.path.getsize(args.out) / 1024
    print(f"Wrote {args.out} ({size_kb:.0f} KB)")
    print(f"  {grid['ncols']} x {grid['nrows']} cells at {args.cell} deg (~{args.cell * 111:.1f} km)")
    print(f"  {covered} of {len(grid['values'])} cells have data")
    print(f"  wind speed {min(speeds):.1f} to {max(speeds):.1f} m/s at {args.height}")
    print("\nReload blockgroups.html and tick 'Wind speed'.")


if __name__ == "__main__":
    try:
        main()
    except WindDataError as err:
        print(f"\nCould not build the wind grid: {err}\n", file=sys.stderr)
        sys.exit(1)
