#!/usr/bin/env python3
"""
Serve the Block Group Explorer, and extract a listing from a pasted page.

Run this INSTEAD of `python -m http.server`:

    python scripts/listing-server.py

Everything the plain server did still works - the page, the vendored map
libraries, js/data/*.json - and one endpoint is added:

    POST /api/extract   {"text": "...", "url": "..."}

which hands the text to Claude and gets back the listing's fields, so the
property card fills itself instead of you typing beds, baths and square feet
out of a browser tab.

The key never reaches the browser. The page cannot hold one safely: anything
in js/ is readable by anyone the page is shown to, and a static page cannot
read a file outside itself. That is the whole reason this file exists.

SETUP
  1. pip install anthropic
  2. Put your key in a file called  .env  next to blockgroups.html:

         ANTHROPIC_API_KEY=sk-ant-...

     .env is gitignored. Or export ANTHROPIC_API_KEY in your shell and skip
     the file entirely.
  3. python scripts/listing-server.py

Optional environment variables:
  LISTING_MODEL   which model to use. Default claude-haiku-4-5, which is the
                  cheap one and is entirely adequate at reading a listing
                  page. Set it to claude-opus-5 if a page defeats Haiku.
  PORT            default 8000.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_MODEL = "claude-haiku-4-5"

# Enough of a listing page to hold every field we want, and a hard stop so a
# pathological paste cannot turn into a surprising bill.
MAX_INPUT_CHARS = 200_000

# A listing page is mostly navigation, adverts and "similar homes". The model
# reads past that; these instructions are about what NOT to invent.
SYSTEM = """You read a real-estate listing and return its facts.

Rules:
- Report only what the page states. If a field is not stated, return null for
  it. Never estimate, never infer from comparable homes, never carry a number
  over from a "similar homes" or "recently sold nearby" section.
- price is the CURRENT asking price for THIS home, not a sold price, not a
  Zestimate or Redfin Estimate, not a mortgage payment.
- lotSqft is in square feet. If the page gives acres, multiply by 43560.
- baths counts half baths as 0.5, so 2 full and 1 half is 2.5.
- address is the street line only, no city/state/zip - those are separate.
- If the text is not a listing for a single property at all, set address to
  null and say why in `problem`.
"""

SCHEMA = {
    "type": "object",
    "properties": {
        "address": {"type": ["string", "null"], "description": "Street line only, e.g. '331 N Reese Pl'"},
        "city": {"type": ["string", "null"]},
        "zip": {"type": ["string", "null"]},
        "price": {"type": ["number", "null"], "description": "Current asking price in dollars"},
        "beds": {"type": ["number", "null"]},
        "baths": {"type": ["number", "null"], "description": "Half baths count as 0.5"},
        "sqft": {"type": ["number", "null"], "description": "Interior floor area, square feet"},
        "lotSqft": {"type": ["number", "null"], "description": "Lot size in SQUARE FEET, converted from acres if needed"},
        "yearBuilt": {"type": ["number", "null"]},
        "hoa": {"type": ["number", "null"], "description": "Monthly HOA dues in dollars"},
        "type": {"type": ["string", "null"], "description": "Property type as stated, e.g. 'Single Family Residential'"},
        "status": {"type": ["string", "null"], "description": "Listing status as stated, e.g. 'Active'"},
        "mls": {"type": ["string", "null"]},
        "daysOnMarket": {"type": ["number", "null"]},
        "problem": {"type": ["string", "null"], "description": "Null normally; why extraction failed if it did"},
    },
    "required": [
        "address", "city", "zip", "price", "beds", "baths", "sqft", "lotSqft",
        "yearBuilt", "hoa", "type", "status", "mls", "daysOnMarket", "problem",
    ],
    "additionalProperties": False,
}


def load_dotenv(path: str) -> None:
    """Read KEY=value lines into the environment, without overwriting what is
    already set - an exported shell variable should win over a stale file."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            lines = handle.readlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def fetch_page(url: str) -> str:
    """Fetch a listing URL. Redfin and Zillow block plain scripts most of the
    time, so this is the convenience path and pasting is the reliable one -
    the error says so rather than leaving you guessing."""
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/125.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read()
    return raw.decode("utf-8", errors="replace")


def extract(text: str, url: str | None) -> dict:
    try:
        import anthropic
    except ImportError:
        raise RuntimeError(
            "The anthropic package is not installed. Run:  pip install anthropic"
        )

    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        raise RuntimeError(
            "No API key. Put ANTHROPIC_API_KEY=sk-ant-... in a file called .env "
            "next to blockgroups.html, then restart this server."
        )

    model = os.environ.get("LISTING_MODEL", DEFAULT_MODEL)
    client = anthropic.Anthropic()

    prompt = text[:MAX_INPUT_CHARS]
    if url:
        prompt = f"Listing URL: {url}\n\n{prompt}"

    response = client.messages.create(
        model=model,
        max_tokens=4000,
        system=SYSTEM,
        messages=[{"role": "user", "content": prompt}],
        output_config={"format": {"type": "json_schema", "schema": SCHEMA}},
    )

    parts = [block.text for block in response.content if block.type == "text"]
    if not parts:
        raise RuntimeError("The model returned no text. Try again, or paste more of the page.")
    try:
        fields = json.loads("".join(parts))
    except json.JSONDecodeError as err:
        raise RuntimeError(f"Could not read the model's answer as JSON: {err}")

    usage = getattr(response, "usage", None)
    return {
        "fields": fields,
        "model": model,
        "usage": {
            "input": getattr(usage, "input_tokens", None),
            "output": getattr(usage, "output_tokens", None),
        },
    }


class Handler(SimpleHTTPRequestHandler):
    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - the base class names it this
        if self.path.rstrip("/") == "/api/extract":
            # The page asks this on load so it can show or hide the paste box
            # rather than offering a button that cannot work.
            have_key = bool(
                os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
            )
            try:
                import anthropic  # noqa: F401

                have_sdk = True
            except ImportError:
                have_sdk = False
            self._send_json(200, {
                "ready": have_key and have_sdk,
                "haveKey": have_key,
                "haveSdk": have_sdk,
                "model": os.environ.get("LISTING_MODEL", DEFAULT_MODEL),
            })
            return
        super().do_GET()

    def do_POST(self):  # noqa: N802
        if self.path.rstrip("/") != "/api/extract":
            self._send_json(404, {"error": "No such endpoint."})
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            self._send_json(400, {"error": "Empty request."})
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, {"error": "Could not read the request."})
            return

        text = (payload.get("text") or "").strip()
        url = (payload.get("url") or "").strip() or None

        if not text and url:
            if not url.startswith(("http://", "https://")):
                self._send_json(400, {"error": "That does not look like a URL."})
                return
            try:
                text = fetch_page(url)
            except (urllib.error.URLError, urllib.error.HTTPError, OSError) as err:
                self._send_json(502, {
                    "error": f"Could not fetch that page ({err}). Redfin and Zillow "
                             "block scripts - open the listing, select all, copy, and "
                             "paste the text instead."
                })
                return

        if not text:
            self._send_json(400, {"error": "Paste the listing text, or give a URL."})
            return

        try:
            result = extract(text, url)
        except RuntimeError as err:
            self._send_json(400, {"error": str(err)})
            return
        except Exception as err:  # the API can fail in many ways; say which
            self._send_json(502, {"error": f"{type(err).__name__}: {err}"})
            return

        self._send_json(200, result)

    def log_message(self, fmt, *args):
        # Keep the API calls visible, drop the static-file chatter that would
        # bury them.
        if "/api/" in self.path:
            sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))


def main() -> int:
    load_dotenv(os.path.join(ROOT, ".env"))
    port = int(os.environ.get("PORT", "8000"))
    handler = partial(Handler, directory=ROOT)
    server = ThreadingHTTPServer(("", port), handler)

    have_key = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
    print(f"Serving {ROOT} on http://localhost:{port}/blockgroups.html")
    if have_key:
        print(f"Listing extraction is ON, using {os.environ.get('LISTING_MODEL', DEFAULT_MODEL)}.")
    else:
        print("Listing extraction is OFF - no ANTHROPIC_API_KEY found.")
        print("Everything else works. See the top of this file to switch it on.")
    print("Ctrl-C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
