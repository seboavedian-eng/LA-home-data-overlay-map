#!/usr/bin/env python3
"""
Brickline's public web server - the one that runs on Render for brickline.tech.

It is NOT scripts/listing-server.py. That one is for your own machine: it
serves the whole project folder (keys, raw-data/, your Redfin exports) and
spends your Anthropic key on request. This one:

  * serves ONLY the files in ./site, which scripts/build-public-site.py fills
    from an allowlist - no folder listings, no dotfiles, known file types only;
  * keeps every key on the server: commute areas, drive times and address
    search are proxied, so the browser never sees a key;
  * takes sign-ups, guards them (hidden field, timing, per-visitor and
    per-address limits), keeps a copy, emails you, and emails the visitor
    their results - with an unsubscribe link that works;
  * sends security headers on every response.

Standard library only, so the Render service needs no install step.

Settings, all environment variables (Render -> the service -> Environment):

  PUBLIC_URL        https://brickline.tech           (links in emails)
  RESEND_API_KEY    re_...                           (sending email; optional)
  MAIL_FROM         Brickline <results@brickline.tech>
  OWNER_EMAIL       where sign-up notifications go
  ORS_API_KEY       OpenRouteService key             (commute areas; optional)
  LOCATIONIQ_KEY    LocationIQ key                   (address search; optional)
  UNSUB_SECRET      any long random string           (signs unsubscribe links)
  DATA_DIR          where leads.jsonl and the unsubscribe list are kept
                    (default ./data - wiped on every Render free-plan restart,
                    which is why every sign-up is also emailed to OWNER_EMAIL)
  PORT              set by Render

Run locally:  python server/brickline_server.py   (after building ./site)
"""

from __future__ import annotations

import datetime
import hashlib
import hmac
import html
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.environ.get("SITE_DIR") or os.path.join(HERE, "site")

RESEND_URL = "https://api.resend.com/emails"
ORS_ISOCHRONES = "https://api.openrouteservice.org/v2/isochrones/driving-car"
ORS_DIRECTIONS = "https://api.openrouteservice.org/v2/directions/driving-car"
LOCATIONIQ = {
    "suggest": "https://api.locationiq.com/v1/autocomplete",
    "search": "https://us1.locationiq.com/v1/search",
}
# LA County plus a margin: proxied lookups outside it are refused, so a key
# can't be borrowed for the rest of the world.
BOUNDS = {"west": -119.2, "east": -117.4, "south": 33.4, "north": 35.1}
VIEWBOX = f"{BOUNDS['west']},{BOUNDS['north']},{BOUNDS['east']},{BOUNDS['south']}"

ALLOWED_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
}
LEAD_KINDS = {"lead", "search", "report_request", "alert"}
MAX_BODY = 40_000
EMAIL_RE = re.compile(r"^[^\s@<>\"',;]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$")

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
    "Strict-Transport-Security": "max-age=31536000",
    # Scripts only from this site, never inline. 'unsafe-eval' because the
    # vendored Turf library builds a few functions with new Function() as it
    # loads (its bundled rbush / robust-predicates); without it the page dies.
    # The map reads public GIS services
    # straight from the browser, hence connect-src https:. Inline styles are
    # used throughout the cards, hence 'unsafe-inline' for style-src only.
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob: https:; connect-src 'self' https:; worker-src 'self' blob:; "
        "font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    ),
}


def env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def data_dir() -> str:
    d = env("DATA_DIR") or os.path.join(HERE, "data")
    os.makedirs(d, exist_ok=True)
    return d


# --- Rate limits -----------------------------------------------------------
class Limiter:
    """At most `n` events per key in `window` seconds. In memory: one Render
    instance, and a restart forgiving everyone is fine at pilot scale."""

    def __init__(self, n: int, window: int):
        self.n, self.window, self.hits, self.lock = n, window, {}, threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.time()
        with self.lock:
            recent = [t for t in self.hits.get(key, []) if now - t < self.window]
            if len(recent) >= self.n:
                self.hits[key] = recent
                return False
            recent.append(now)
            self.hits[key] = recent
            return True


LIMITS = {
    "lead": Limiter(10, 600),          # sign-ups / events per visitor, 10 min
    "mail_to": Limiter(3, 86400),      # result emails to one address, per day
    "proxy": Limiter(120, 600),        # map lookups per visitor, 10 min
}


# --- Unsubscribe -----------------------------------------------------------
def unsub_token(email: str) -> str:
    secret = env("UNSUB_SECRET", "change-me").encode()
    return hmac.new(secret, email.lower().encode(), hashlib.sha256).hexdigest()[:32]


def unsubscribed(email: str) -> bool:
    path = os.path.join(data_dir(), "unsubscribed.txt")
    try:
        with open(path, encoding="utf-8") as f:
            return email.lower() in {line.strip() for line in f}
    except OSError:
        return False


def add_unsubscribe(email: str) -> None:
    with open(os.path.join(data_dir(), "unsubscribed.txt"), "a", encoding="utf-8") as f:
        f.write(email.lower() + "\n")


# --- Email -----------------------------------------------------------------
def send_email(to: str, subject: str, html_body: str, text_body: str, reply_to: str | None = None, sender=None) -> bool:
    """Send through Resend. Returns False (never raises) when email isn't
    set up or the send fails, so a sign-up is never lost to a mail error."""
    key = env("RESEND_API_KEY")
    if not key:
        return False
    payload = {"from": env("MAIL_FROM", "Brickline <results@brickline.tech>"), "to": [to], "subject": subject, "html": html_body, "text": text_body}
    if reply_to:
        payload["reply_to"] = reply_to
    if sender:  # tests swap the network out
        return sender(payload)
    req = urllib.request.Request(
        RESEND_URL,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": "brickline-server"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return 200 <= res.status < 300
    except (urllib.error.URLError, OSError) as err:
        log(f"email to {mask(to)} failed: {err}")
        return False


def mask(email: str) -> str:
    name, _, dom = email.partition("@")
    return (name[:2] + "***@" + dom) if dom else "***"


def clean_text(v, limit=120) -> str:
    return re.sub(r"[\r\n\t]+", " ", str(v if v is not None else ""))[:limit].strip()


def num(v):
    try:
        f = float(v)
        return f if f == f and abs(f) < 1e12 else None
    except (TypeError, ValueError):
        return None


def results_link(code: str) -> str:
    base = env("PUBLIC_URL", "https://brickline.tech").rstrip("/")
    if code and re.fullmatch(r"[A-Za-z0-9_-]{1,3000}", code):
        return f"{base}/?r={code}#find"
    return f"{base}/#find"


def build_results_email(payload: dict, unsub_url: str):
    """The visitor's shortlist: their answers, how many areas fit, the top
    areas with a few numbers each, and a link that reopens it all."""
    e = html.escape
    count = int(num(payload.get("count")) or 0)
    answers = [clean_text(a, 80) for a in (payload.get("answerLines") or [])][:10]
    rows = []
    for r in (payload.get("results") or [])[:10]:
        if not isinstance(r, dict):
            continue
        rows.append({
            "name": clean_text(r.get("name"), 80),
            "busy": clean_text(r.get("busy"), 30),
            "houses": num(r.get("houses")),
            "income": num(r.get("income")),
            "price": num(r.get("price")),
            "geoid": clean_text(r.get("geoid"), 12) if re.fullmatch(r"\d{12}", str(r.get("geoid", ""))) else "",
        })
    link = results_link(str(payload.get("r") or ""))
    base = env("PUBLIC_URL", "https://brickline.tech").rstrip("/")
    money = lambda v: "–" if v is None else (f"${v / 1e6:.2f}M" if v >= 1e6 else f"${round(v / 1000)}k")
    pct = lambda v: "–" if v is None else f"{round(v)}%"
    subject = f"Your Brickline shortlist: {count} area{'s' if count != 1 else ''} fit"
    cell = "padding:6px 8px;border-bottom:1px solid #e5e7eb"
    trs = ""
    for r in rows:
        name = e(r["name"])
        if r["geoid"]:
            name = '<a href="' + e(base) + "/#area-" + r["geoid"] + '" style="color:#0b6e66">' + name + "</a>"
        trs += (
            "<tr>" + "".join(f"<td style='{cell}'>{v}</td>" for v in (name, e(r["busy"]), pct(r["houses"]), money(r["income"]), money(r["price"]))) + "</tr>"
        )
    answers_html = ("<p style='margin:0 0 4px;font-weight:bold'>You asked for</p><ul style='margin:0 0 14px;color:#374151'>" + "".join("<li>" + e(a) + "</li>" for a in answers) + "</ul>") if answers else ""
    head = "".join(f"<th style='padding:6px 8px'>{t}</th>" for t in ("Area", "Street", "Houses", "Income", "Typical price"))
    table_html = (f"<table style='border-collapse:collapse;font-size:14px;width:100%'><tr style='text-align:left;color:#6b7280'>{head}</tr>{trs}</table>") if rows else ""
    plural = "s" if count != 1 else ""
    html_body = f"""<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:620px">
<h2 style="margin:0 0 6px">{count} area{plural} fit what you asked for</h2>
<p style="margin:0 0 14px;color:#4b5563">Here is your Brickline shortlist. Each area is a Census block group, a few city blocks.</p>
{answers_html}
{table_html}
<p style="margin:18px 0"><a href="{e(link)}" style="background:#0b6e66;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open your results on the map</a></p>
<p style="font-size:12px;color:#6b7280">Numbers come from the Census (ACS 5-year), the LA County Assessor roll and public hazard maps. They are estimates for research, not an appraisal or advice.</p>
<p style="font-size:12px;color:#6b7280">You got this because you asked for your results on brickline.tech. <a href="{e(unsub_url)}" style="color:#6b7280">Unsubscribe</a></p>
</div>"""
    text_lines = [f"{count} area(s) fit what you asked for.", ""]
    if answers:
        text_lines += ["You asked for:"] + [f"- {a}" for a in answers] + [""]
    for r in rows:
        text_lines.append(f"- {r['name']}: {r['busy']}, {pct(r['houses'])} houses, income {money(r['income'])}, typical price {money(r['price'])}")
    text_lines += ["", f"Open your results: {link}", "", "Estimates for research, not an appraisal or advice.", f"Unsubscribe: {unsub_url}"]
    return subject, html_body, "\n".join(text_lines)


def owner_note(rec: dict):
    e = html.escape
    lines = [f"Kind: {rec['kind']}", f"Email: {rec.get('email') or '-'}", f"Journey: {rec.get('journey') or '-'}"]
    if rec.get("address"):
        lines.append(f"House: {rec['address']}")
    if rec.get("count") is not None:
        lines.append(f"Areas that fit: {rec['count']}")
    for a in rec.get("answerLines") or []:
        lines.append(f"  - {a}")
    text = "\n".join(lines)
    return f"Brickline {rec['kind']}: {rec.get('email') or rec.get('address') or 'new event'}", f"<pre style='font-family:Arial'>{e(text)}</pre>", text


# --- Proxies ---------------------------------------------------------------
def in_bounds(lon, lat) -> bool:
    return lon is not None and lat is not None and BOUNDS["west"] <= lon <= BOUNDS["east"] and BOUNDS["south"] <= lat <= BOUNDS["north"]


def fetch_json(url: str, data: bytes | None = None, headers: dict | None = None, opener=None):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "brickline-server", **(headers or {})}, method="POST" if data else "GET")
    open_ = opener or urllib.request.urlopen
    with open_(req, timeout=25) as res:
        return json.loads(res.read().decode("utf-8") or "null")


def log(msg: str) -> None:
    sys.stderr.write(f"{datetime.datetime.utcnow().isoformat(timespec='seconds')}Z {msg}\n")


class Handler(SimpleHTTPRequestHandler):
    opener = None   # tests swap these for fakes
    sender = None

    # ---- static files: the allowlisted site, nothing else ----
    def translate_path(self, path):
        clean = urllib.parse.urlsplit(path).path
        clean = urllib.parse.unquote(clean)
        parts = [p for p in clean.split("/") if p]
        if any(p.startswith(".") or p in ("..",) for p in parts):
            return ""
        full = os.path.normpath(os.path.join(SITE, *parts))
        if not (full == SITE or full.startswith(SITE + os.sep)):
            return ""
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        return full

    def list_directory(self, path):
        self.send_error(404, "Not found")
        return None

    def guess_type(self, path):
        return ALLOWED_TYPES.get(os.path.splitext(path)[1].lower(), "application/octet-stream")

    def send_head(self):
        path = self.translate_path(self.path)
        if not path or os.path.splitext(path)[1].lower() not in ALLOWED_TYPES or not os.path.isfile(path):
            self.send_error(404, "Not found")
            return None
        return super().send_head()

    def end_headers(self):
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        if self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            log(f"{self.command} {self.path.split('?')[0]} {args[1] if len(args) > 1 else ''}")

    # ---- helpers ----
    def client_key(self) -> str:
        ip = (self.headers.get("X-Forwarded-For") or self.client_address[0] or "").split(",")[0].strip()
        return hashlib.sha256(ip.encode()).hexdigest()[:16]

    def reply(self, status: int, obj) -> None:
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if length <= 0 or length > MAX_BODY:
            return None
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None
        return data if isinstance(data, dict) else None

    # ---- routes ----
    def do_GET(self):  # noqa: N802
        route = urllib.parse.urlsplit(self.path)
        q = urllib.parse.parse_qs(route.query)
        if route.path == "/api/config":
            return self.reply(200, {"ors": bool(env("ORS_API_KEY")), "geocode": "proxy" if env("LOCATIONIQ_KEY") else None, "email": bool(env("RESEND_API_KEY"))})
        if route.path == "/api/lead":
            return self.reply(200, {"ready": True})
        if route.path == "/api/unsubscribe":
            return self.unsubscribe(q)
        if route.path == "/api/directions":
            return self.directions(q)
        if route.path == "/api/geocode":
            return self.geocode(q)
        if route.path.startswith("/api/"):
            return self.reply(404, {"error": "unknown endpoint"})
        return super().do_GET()

    def do_HEAD(self):  # noqa: N802
        if self.path.startswith("/api/"):
            return self.reply(405, {"error": "method not allowed"})
        return super().do_HEAD()

    def do_POST(self):  # noqa: N802
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/lead":
            return self.lead()
        if path == "/api/isochrone":
            return self.isochrone()
        return self.reply(404, {"error": "unknown endpoint"})

    def lead(self):
        if not LIMITS["lead"].allow(self.client_key()):
            return self.reply(429, {"error": "too many requests, try again in a few minutes"})
        p = self.read_json()
        if p is None:
            return self.reply(400, {"error": "bad request"})
        kind = p.get("kind")
        if kind not in LEAD_KINDS:
            return self.reply(400, {"error": "unknown kind"})
        # Bots fill every field and submit instantly; people leave the hidden
        # field empty and take more than a second.
        if p.get("website") or (num(p.get("t")) is not None and num(p.get("t")) < 1200):
            return self.reply(200, {"ok": True, "emailed": False})
        email = clean_text(p.get("email"), 254)
        if email and not EMAIL_RE.match(email):
            return self.reply(400, {"error": "that doesn't look like an email address"})
        if kind in ("lead", "alert") and not email:
            return self.reply(400, {"error": "email required"})
        rec = {
            "at": datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "kind": kind,
            "email": email or None,
            "journey": clean_text(p.get("journey"), 30) or None,
            "answerLines": [clean_text(a, 80) for a in (p.get("answerLines") or [])][:10],
            "count": int(num(p.get("count"))) if num(p.get("count")) is not None else None,
            "geoid": clean_text(p.get("geoid"), 12) or None,
            "address": clean_text(p.get("address"), 160) or None,
            "visitor": self.client_key(),
        }
        try:
            with open(os.path.join(data_dir(), "leads.jsonl"), "a", encoding="utf-8") as f:
                f.write(json.dumps(rec) + "\n")
        except OSError as err:
            log(f"could not save lead: {err}")
        owner = env("OWNER_EMAIL")
        if owner and kind != "search":
            subj, h, t = owner_note(rec)
            send_email(owner, subj, h, t, reply_to=email or None, sender=self.sender)
        emailed = False
        if kind == "lead" and email and not unsubscribed(email) and LIMITS["mail_to"].allow(email.lower()):
            base = env("PUBLIC_URL", "https://brickline.tech").rstrip("/")
            unsub = f"{base}/api/unsubscribe?e={urllib.parse.quote(email)}&t={unsub_token(email)}"
            subj, h, t = build_results_email(p, unsub)
            emailed = send_email(email, subj, h, t, reply_to=owner or None, sender=self.sender)
        return self.reply(200, {"ok": True, "emailed": emailed})

    def unsubscribe(self, q):
        email = (q.get("e") or [""])[0]
        token = (q.get("t") or [""])[0]
        ok = bool(email) and hmac.compare_digest(token, unsub_token(email))
        if ok:
            add_unsubscribe(email)
        body = (
            "<!doctype html><meta charset=utf-8><title>Brickline</title><body style='font-family:Arial;padding:40px'>"
            + ("<h2>You're unsubscribed.</h2><p>We won't email you again.</p>" if ok else "<h2>That link didn't work.</h2><p>Reply to any of our emails and we'll remove you.</p>")
            + "</body>"
        ).encode()
        self.send_response(200 if ok else 400)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def proxy_guard(self) -> bool:
        if not LIMITS["proxy"].allow(self.client_key()):
            self.reply(429, {"error": "too many requests"})
            return False
        return True

    def isochrone(self):
        key = env("ORS_API_KEY")
        if not key:
            return self.reply(503, {"error": "commute areas aren't set up"})
        if not self.proxy_guard():
            return
        p = self.read_json() or {}
        lon, lat, sec = num(p.get("lon")), num(p.get("lat")), num(p.get("seconds"))
        if not in_bounds(lon, lat) or sec is None or not (60 <= sec <= 3600):
            return self.reply(400, {"error": "outside the area or range"})
        body = json.dumps({"locations": [[lon, lat]], "range": [int(sec)], "range_type": "time"}).encode()
        try:
            data = fetch_json(ORS_ISOCHRONES, body, {"Authorization": key, "Content-Type": "application/json"}, opener=self.opener)
        except (urllib.error.URLError, OSError, ValueError) as err:
            log(f"isochrone failed: {err}")
            return self.reply(502, {"error": "routing service didn't answer"})
        return self.reply(200, data)

    def directions(self, q):
        key = env("ORS_API_KEY")
        if not key:
            return self.reply(503, {"error": "drive times aren't set up"})
        if not self.proxy_guard():
            return
        try:
            s = [float(x) for x in (q.get("start") or [""])[0].split(",")]
            t = [float(x) for x in (q.get("end") or [""])[0].split(",")]
        except ValueError:
            return self.reply(400, {"error": "bad coordinates"})
        if len(s) != 2 or len(t) != 2 or not in_bounds(*s) or not in_bounds(*t):
            return self.reply(400, {"error": "outside the area"})
        url = f"{ORS_DIRECTIONS}?" + urllib.parse.urlencode({"api_key": key, "start": f"{s[0]},{s[1]}", "end": f"{t[0]},{t[1]}"})
        try:
            data = fetch_json(url, opener=self.opener)
        except (urllib.error.URLError, OSError, ValueError) as err:
            log(f"directions failed: {err}")
            return self.reply(502, {"error": "routing service didn't answer"})
        return self.reply(200, data)

    def geocode(self, q):
        key = env("LOCATIONIQ_KEY")
        if not key:
            return self.reply(503, {"error": "address search isn't set up"})
        if not self.proxy_guard():
            return
        text = clean_text((q.get("q") or [""])[0], 200)
        mode = (q.get("mode") or ["search"])[0]
        if len(text) < 3 or mode not in LOCATIONIQ:
            return self.reply(400, {"error": "type a little more"})
        params = {"key": key, "q": text, "countrycodes": "us", "viewbox": VIEWBOX, "bounded": "1", "limit": "6", "format": "json", "addressdetails": "1"}
        try:
            rows = fetch_json(f"{LOCATIONIQ[mode]}?" + urllib.parse.urlencode(params), opener=self.opener)
        except urllib.error.HTTPError as err:
            if err.code == 404:   # LocationIQ's "nothing found"
                return self.reply(200, [])
            log(f"geocode failed: {err}")
            return self.reply(502, {"error": "address service didn't answer"})
        except (urllib.error.URLError, OSError, ValueError) as err:
            log(f"geocode failed: {err}")
            return self.reply(502, {"error": "address service didn't answer"})
        out = []
        for r in rows if isinstance(rows, list) else []:
            lat, lon = num(r.get("lat")), num(r.get("lon"))
            if lat is None or lon is None:
                continue
            a = r.get("address") or {}
            out.append({
                "display_name": clean_text(r.get("display_name") or r.get("display_place"), 200),
                "lat": lat, "lon": lon,
                # Same shape as Nominatim's, which the lot finder reads.
                "address": {k: clean_text(a.get(k), 80) for k in ("house_number", "road", "city", "town", "suburb", "postcode", "state") if a.get(k)},
            })
        return self.reply(200, out)


def main() -> int:
    if not os.path.isdir(SITE):
        print(f"No site at {SITE}. Run: python scripts/build-public-site.py", file=sys.stderr)
        return 1
    port = int(env("PORT", "8000"))
    server = ThreadingHTTPServer(("", port), partial(Handler, directory=SITE))
    print(f"Brickline public server on port {port}, serving {SITE}")
    print("  email:", "on" if env("RESEND_API_KEY") else "OFF (no RESEND_API_KEY)",
          "| commute:", "on" if env("ORS_API_KEY") else "OFF",
          "| address search:", "on" if env("LOCATIONIQ_KEY") else "OFF")
    if env("UNSUB_SECRET", "change-me") == "change-me":
        print("  WARNING: set UNSUB_SECRET to a long random string", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
