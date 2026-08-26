#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# One-time setup: pre-fetches the Census ACS 5-year demographics/income data
# this app needs and saves it locally, so the Demographics and Income
# layers load from a same-origin static file instead of a live call to
# api.census.gov.
#
# Why this exists: api.census.gov does not send Access-Control-Allow-Origin,
# so a browser can NEVER read its response directly (this is a limitation
# of that API, not something fixable from JavaScript - see README). The app
# falls back to public CORS proxies, but those have proven unreliable in
# practice (rate-limited, blocked by some networks/extensions, or requiring
# their own signup). ACS 5-year estimates only change once a year anyway,
# so there's no real downside to fetching it once, here, from a machine
# with normal internet access, instead of on every page load.
#
# Usage:
#   cd LA-home-data-overlay-map
#   bash scripts/fetch-census-data.sh
#
# Re-run it after changing ACS_YEAR or the variable lists in js/config.js -
# the query below must stay in sync with those by hand.
# ---------------------------------------------------------------------------
set -euo pipefail

YEAR=2022
VARS="NAME,B03002_001E,B03002_003E,B03002_004E,B03002_005E,B03002_006E,B03002_007E,B03002_008E,B03002_009E,B03002_012E,B19013_001E,B19301_001E,B17001_001E,B17001_002E"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$SCRIPT_DIR/../js/data/acs-zcta.json"
mkdir -p "$(dirname "$OUT")"

STATE_URL="https://api.census.gov/data/${YEAR}/acs/acs5?get=${VARS}&for=zip%20code%20tabulation%20area:*&in=state:06"
NATIONWIDE_URL="https://api.census.gov/data/${YEAR}/acs/acs5?get=${VARS}&for=zip%20code%20tabulation%20area:*"

echo "Fetching ACS ${YEAR} 5-year estimates for all California ZCTAs..."
if curl -fsS "$STATE_URL" -o "$OUT"; then
  echo "Saved to $OUT"
else
  echo "State-filtered query failed - retrying nationwide (larger response, ~30-60s)..."
  curl -fsS "$NATIONWIDE_URL" -o "$OUT"
  echo "Saved to $OUT"
fi

echo "Done. Reload the map page - Demographics/Income will now load from this local file."
