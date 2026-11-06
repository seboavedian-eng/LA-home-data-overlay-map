#!/usr/bin/env python3
"""
Build the public deploy package for brickline.tech into ./dist.

    python scripts/build-public-site.py            # builds ./dist
    python scripts/build-public-site.py --out DIR   # somewhere else

dist/ is what goes on Render (push it to a PRIVATE GitHub repo of its own):

    dist/server.py      the public server (server/brickline_server.py)
    dist/site/...       the pilot page and ONLY the files it needs
    dist/render.yaml    Render's settings for the service
    dist/README.md      the deploy steps

Everything is copied from an ALLOWLIST, never "the folder minus some
things" - a new file in the project stays private until it is named here.
And then the result is checked: the build fails if any key file, raw-data,
Redfin export, sign-up file or GreatSchools rating made it in.

What is deliberately left out:
  * blockgroups.html (the explorer) - it shows your personal-use data;
  * raw-data/ - Redfin exports, your ratings table, leads.jsonl;
  * every key file (.env, ors-api-key.txt, census-api-key.txt);
  * GreatSchools ratings - schools-la-county.json is copied WITHOUT them,
    so the public page still names the nearest schools.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import shutil
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# Page, styles, scripts, libraries, rules - copied as they are.
SITE_FILES = [
    "brickline.html",
    "privacy.html",
    "terms.html",
    "css/brickline.css",
    "js/utils.js",
    "js/core/layers.js",
    "js/core/envelope.js",
    "js/blockgroups.js",
    "js/brickline/app.js",
    "js/brickline/headless.js",
    "js/zone-rules/*.json",
    "vendor/leaflet/**",
    "vendor/maplibre/**",
    "vendor/turf/**",
]
# Data built on your machine, all from public sources. Missing ones are
# reported, not fatal: the page degrades without them.
DATA_FILES = [
    "js/data/bg-la-county.json",          # Census ACS, public
    "js/data/parcels-la-county.json",     # assessor-roll summaries, public record
    "js/data/parcel-sales-la-county.json",
    "js/data/wind-la-county.json",        # Global Wind Atlas
]
SCHOOLS = "js/data/schools-la-county.json"  # copied with ratings removed

# Nothing matching these may end up in the package.
FORBIDDEN = [
    r"(^|/)\.env", r"api-key", r"(^|/)raw-data/", r"redfin", r"leads\.jsonl",
    r"school-ratings", r"school-zones-local", r"(^|/)blockgroups\.html$", r"(^|/)index\.html\.orig$",
    r"\.py$(?<!server\.py)",
]
RATING_KEYS = re.compile(r"rating|greatschools|gs_?(id|url|link)", re.I)


def expand(pattern: str) -> list[str]:
    hits = glob.glob(os.path.join(ROOT, pattern), recursive=True)
    return sorted(h for h in hits if os.path.isfile(h))


def copy(src: str, dst_root: str) -> str:
    rel = os.path.relpath(src, ROOT)
    dst = os.path.join(dst_root, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)
    return rel


def strip_ratings(obj):
    """Remove every rating-like field, anywhere in the file."""
    if isinstance(obj, dict):
        return {k: strip_ratings(v) for k, v in obj.items() if not RATING_KEYS.search(k)}
    if isinstance(obj, list):
        return [strip_ratings(v) for v in obj]
    return obj


def public_schools(src: str, dst: str) -> int:
    with open(src, encoding="utf-8") as f:
        data = json.load(f)
    meta = data.get("meta") or {}
    out = strip_ratings(data)
    # Keep the schema number so the page accepts the file; say why it's empty.
    out["meta"] = {k: v for k, v in strip_ratings(meta).items() if k not in ("match", "ratingFiles", "rated")}
    out["meta"]["schemaVersion"] = meta.get("schemaVersion")
    out["meta"]["note"] = "Public build: ratings removed (GreatSchools data is licensed for personal use)."
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    return len(out.get("schools") or {})


def check(out_dir: str) -> list[str]:
    bad = []
    for dirpath, _, files in os.walk(out_dir):
        for name in files:
            rel = os.path.relpath(os.path.join(dirpath, name), out_dir).replace(os.sep, "/")
            if rel in ("server.py",):
                continue
            if any(re.search(p, rel, re.I) for p in FORBIDDEN):
                bad.append(rel)
    # Ratings must not survive inside the schools file either.
    sp = os.path.join(out_dir, "site", SCHOOLS)
    if os.path.exists(sp):
        with open(sp, encoding="utf-8") as f:
            text = f.read()
        if re.search(r'"ratings?"\s*:', text, re.I):
            bad.append(f"site/{SCHOOLS} still has ratings")
    return bad


RENDER_YAML = """\
# Render settings for brickline.tech. Secrets are entered in the dashboard
# (Environment tab), never in this file.
services:
  - type: web
    name: brickline
    runtime: python
    plan: free            # change to starter so it never sleeps
    buildCommand: "python --version"
    startCommand: "python server.py"
    healthCheckPath: /api/lead
    envVars:
      - key: PUBLIC_URL
        value: https://brickline.tech
      - key: MAIL_FROM
        value: "Brickline <results@brickline.tech>"
      - key: OWNER_EMAIL
        sync: false
      - key: RESEND_API_KEY
        sync: false
      - key: ORS_API_KEY
        sync: false
      - key: LOCATIONIQ_KEY
        sync: false
      - key: UNSUB_SECRET
        generateValue: true
"""

README = """\
# Brickline public site

Built by `scripts/build-public-site.py` in the LA-home-data-overlay-map
project. Don't edit files here; rebuild instead.

Run locally:  `python server.py`, then open http://localhost:8000
Deploy:       push this folder to a PRIVATE GitHub repo, connect it on Render.
See docs/DEPLOY.md in the main project for every step.
"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", default=None)
    ap.add_argument("--root", default=None, help="project folder to build from (tests use a scratch copy)")
    args = ap.parse_args()
    global ROOT
    if args.root:
        ROOT = os.path.abspath(args.root)
    args.out = args.out or os.path.join(ROOT, "dist")
    out = os.path.abspath(args.out)
    site = os.path.join(out, "site")
    if os.path.exists(out):
        keep_git = os.path.isdir(os.path.join(out, ".git"))
        for entry in os.listdir(out):
            if entry == ".git" and keep_git:
                continue   # rebuilding in place keeps the deploy repo
            p = os.path.join(out, entry)
            shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
    os.makedirs(site, exist_ok=True)

    copied = []
    for pattern in SITE_FILES:
        files = expand(pattern)
        if not files:
            print(f"ERROR: {pattern} not found", file=sys.stderr)
            return 1
        copied += [copy(f, site) for f in files]
    # The page is also the home page.
    shutil.copy2(os.path.join(site, "brickline.html"), os.path.join(site, "index.html"))

    missing = []
    for rel in DATA_FILES:
        src = os.path.join(ROOT, rel)
        if os.path.exists(src):
            copied.append(copy(src, site))
        else:
            missing.append(rel)
    if os.path.exists(os.path.join(ROOT, SCHOOLS)):
        n = public_schools(os.path.join(ROOT, SCHOOLS), os.path.join(site, SCHOOLS))
        copied.append(f"{SCHOOLS} ({n} schools, ratings removed)")
    else:
        missing.append(SCHOOLS)

    shutil.copy2(os.path.join(ROOT, "server", "brickline_server.py"), os.path.join(out, "server.py"))
    with open(os.path.join(out, "render.yaml"), "w") as f:
        f.write(RENDER_YAML)
    with open(os.path.join(out, "README.md"), "w") as f:
        f.write(README)
    with open(os.path.join(out, ".gitignore"), "w") as f:
        f.write("data/\n__pycache__/\n")

    bad = check(out)
    if bad:
        print("REFUSING: private files ended up in the package:", *bad, sep="\n  ", file=sys.stderr)
        shutil.rmtree(site, ignore_errors=True)
        return 2

    size = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(site) for f in fs)
    print(f"Built {out}: {len(copied)} files, {size / 1e6:.1f} MB")
    for m in missing:
        if m.endswith("bg-la-county.json"):
            print(f"  WARNING: {m} not found - the page will load but show no numbers. Run scripts/fetch-blockgroup-data.py first.")
        else:
            print(f"  not found (the page works without it): {m}")
    print("Left out on purpose: blockgroups.html, raw-data/, key files, GreatSchools ratings, Redfin exports.")
    print("Next: see docs/DEPLOY.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
