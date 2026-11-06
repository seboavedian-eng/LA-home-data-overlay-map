#!/usr/bin/env python3
"""
Offline checks for the public deploy: scripts/build-public-site.py and
server/brickline_server.py.

    python3 tests/test_public_server.py

Builds a package from a scratch copy of the project that has every kind of
private file planted in it, checks none of them came through, then runs the
server on that package with the network swapped out: email, routing and
address search are fakes that record what they were sent.
"""

import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from functools import partial
from http.server import ThreadingHTTPServer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
failures = []


def check(name, ok, detail=""):
    print(("PASS" if ok else "FAIL") + "  " + name + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        failures.append(name)


def scratch_project(tmp):
    """The real page files, plus fake data and every private file we fear."""
    proj = os.path.join(tmp, "proj")
    for rel in ["brickline.html", "privacy.html", "terms.html", "blockgroups.html", "css", "js", "vendor", "server", "scripts"]:
        src = os.path.join(ROOT, rel)
        dst = os.path.join(proj, rel)
        if os.path.isdir(src):
            shutil.copytree(src, dst, ignore=shutil.ignore_patterns("data"))
        else:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
    os.makedirs(os.path.join(proj, "js", "data"), exist_ok=True)
    w = lambda rel, text: (os.makedirs(os.path.dirname(os.path.join(proj, rel)), exist_ok=True), open(os.path.join(proj, rel), "w").write(text))
    w("js/data/bg-la-county.json", json.dumps({"meta": {"schemaVersion": 9}, "blockGroups": {}}))
    w("js/data/parcels-la-county.json", "{}")
    w("js/data/schools-la-county.json", json.dumps({
        "meta": {"schemaVersion": 2, "rated": 1, "ratingFiles": ["mine.csv"], "match": {"rows": 1}},
        "schools": {"1": {"name": "Verdugo Woodlands Elementary", "levels": ["elementary"], "lat": 34.2, "lon": -118.2,
                          "ratings": {"elementary": 9}, "ratingSource": "greatschools", "gsUrl": "https://x"}},
    }))
    w("js/data/school-zones-local.json", "{}")
    w(".env", "ANTHROPIC_API_KEY=sk-ant-planted\n")
    w("ors-api-key.txt", "planted-ors-key")
    w("census-api-key.txt", "planted-census-key")
    w("raw-data/leads.jsonl", '{"email":"someone@example.com"}\n')
    w("raw-data/redfin-listings/redfin_2026-11-01.csv", "ADDRESS,PRICE\n")
    w("raw-data/school-ratings/ratings.csv", "name,rating\n")
    return proj


def test_build(tmp):
    proj = scratch_project(tmp)
    out = os.path.join(tmp, "dist")
    run = subprocess.run([sys.executable, os.path.join(proj, "scripts", "build-public-site.py"), "--root", proj, "--out", out], capture_output=True, text=True)
    check("the build succeeds", run.returncode == 0, run.stderr[-300:])
    files = []
    for d, _, fs in os.walk(out):
        files += [os.path.relpath(os.path.join(d, f), out).replace(os.sep, "/") for f in fs]
    blob = "\n".join(files)
    check("the page, its scripts and the server are in", all(f in files for f in ["server.py", "render.yaml", "site/index.html", "site/brickline.html", "site/js/brickline/app.js", "site/js/brickline/headless.js", "site/privacy.html"]))
    for bad in [".env", "api-key", "raw-data", "redfin", "leads.jsonl", "school-ratings", "school-zones-local", "blockgroups.html"]:
        check(f"no '{bad}' in the package", bad not in blob, blob)
    everything = ""
    for f in files:
        with open(os.path.join(out, f), "rb") as fh:
            everything += fh.read().decode("utf-8", "ignore")
    check("no planted key appears in any file", "planted" not in everything and "sk-ant-planted" not in everything)
    with open(os.path.join(out, "site", "js", "data", "schools-la-county.json")) as fh:
        sch = json.load(fh)
    school = sch["schools"]["1"]
    check("schools keep their names and places", school.get("name") and school.get("lat") == 34.2)
    check("GreatSchools ratings are stripped", not any("rating" in k.lower() or k == "gsUrl" for k in school) and "ratingFiles" not in sch["meta"] and "rated" not in sch["meta"])
    check("the schools file still has the schema the page expects", sch["meta"].get("schemaVersion") == 2)
    # A rebuild into an existing deploy repo keeps its .git.
    os.makedirs(os.path.join(out, ".git"), exist_ok=True)
    open(os.path.join(out, ".git", "HEAD"), "w").write("ref: refs/heads/main\n")
    subprocess.run([sys.executable, os.path.join(proj, "scripts", "build-public-site.py"), "--root", proj, "--out", out], capture_output=True, text=True)
    check("rebuilding keeps the deploy repo's .git", os.path.exists(os.path.join(out, ".git", "HEAD")))
    # And a private file that sneaks into the allowlist stops the build.
    shutil.copy2(os.path.join(proj, "ors-api-key.txt"), os.path.join(proj, "vendor", "leaflet", "ors-api-key.txt"))
    bad = subprocess.run([sys.executable, os.path.join(proj, "scripts", "build-public-site.py"), "--root", proj, "--out", os.path.join(tmp, "dist2")], capture_output=True, text=True)
    check("a key file inside an allowed folder makes the build refuse", bad.returncode == 2 and "REFUSING" in bad.stderr, bad.stderr[-200:])
    return out


class FakeResponse(io.BytesIO):
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def start_server(site, data_dir):
    spec = importlib.util.spec_from_file_location("bserver", os.path.join(ROOT, "server", "brickline_server.py"))
    mod = importlib.util.module_from_spec(spec)
    os.environ.update({
        "SITE_DIR": site, "DATA_DIR": data_dir, "PUBLIC_URL": "https://brickline.tech",
        "RESEND_API_KEY": "re_test", "OWNER_EMAIL": "owner@example.com", "ORS_API_KEY": "ors-secret",
        "LOCATIONIQ_KEY": "liq-secret", "UNSUB_SECRET": "s3cret", "MAIL_FROM": "Brickline <results@brickline.tech>",
    })
    spec.loader.exec_module(mod)
    sent, outbound = [], []

    def opener(req, timeout=0):
        outbound.append({"url": req.full_url, "headers": dict(req.header_items()), "data": req.data})
        if "isochrones" in req.full_url:
            return FakeResponse(json.dumps({"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": None}]}).encode())
        if "directions" in req.full_url:
            return FakeResponse(json.dumps({"features": [{"properties": {"summary": {"duration": 900}}}]}).encode())
        return FakeResponse(json.dumps([{"display_name": "1745 Grandview Ave, Glendale, CA", "lat": "34.165", "lon": "-118.27", "address": {"house_number": "1745", "road": "Grandview Ave", "evil": "x"}}]).encode())

    mod.Handler.opener = staticmethod(opener)
    mod.Handler.sender = staticmethod(lambda payload: sent.append(payload) or True)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), partial(mod.Handler, directory=site))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return mod, srv, sent, outbound


def req(port, path, body=None, headers=None, method=None):
    data = json.dumps(body).encode() if isinstance(body, (dict, list)) else body
    r = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, headers={"Content-Type": "application/json", **(headers or {})}, method=method or ("POST" if data is not None else "GET"))
    try:
        with urllib.request.urlopen(r, timeout=10) as res:
            return res.status, dict(res.headers), res.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers), err.read().decode("utf-8", "ignore")


def test_server(site, tmp):
    data_dir = os.path.join(tmp, "data")
    mod, srv, sent, outbound = start_server(site, data_dir)
    port = srv.server_address[1]
    ip = iter(range(1, 10_000))
    fresh = lambda: {"X-Forwarded-For": f"10.0.0.{next(ip)}"}

    st, h, body = req(port, "/", headers=fresh())
    check("the home page is the pilot", st == 200 and "Brickline" in body)
    check("security headers are sent", "script-src 'self' 'unsafe-eval';" in h.get("Content-Security-Policy", "") and h.get("X-Frame-Options") == "DENY" and h.get("X-Content-Type-Options") == "nosniff")
    check("the page has no inline script for the policy to block", "<script>" not in body)
    for path in ["/.env", "/raw-data/", "/raw-data/leads.jsonl", "/ors-api-key.txt", "/server.py", "/../server.py", "/%2e%2e/server.py", "/js/", "/js/data/", "/blockgroups.html", "/render.yaml"]:
        st, _, _ = req(port, path, headers=fresh())
        check(f"{path} is not served", st == 404, str(st))

    st, _, body = req(port, "/api/config", headers=fresh())
    cfg = json.loads(body)
    check("config says what the server proxies, and no key", cfg == {"ors": True, "geocode": "proxy", "email": True} and "secret" not in body)

    # --- sign-ups ---
    st, _, _ = req(port, "/api/lead", {"kind": "lead", "email": "not-an-email", "t": 5000}, fresh())
    check("a bad email is refused", st == 400)
    st, _, _ = req(port, "/api/lead", {"kind": "hack", "email": "a@b.co"}, fresh())
    check("an unknown kind is refused", st == 400)
    st, _, _ = req(port, "/api/lead", b"x" * 50_000, fresh())
    check("an oversized body is refused", st == 400)
    n_before = len(sent)
    st, _, body = req(port, "/api/lead", {"kind": "lead", "email": "bot@example.com", "website": "http://spam", "t": 5000}, fresh())
    check("the honeypot answers OK but sends nothing", st == 200 and len(sent) == n_before and '"emailed": false' in body)
    st, _, body = req(port, "/api/lead", {"kind": "lead", "email": "fast@example.com", "t": 200}, fresh())
    check("a form sent in under a second sends nothing", len(sent) == n_before)

    lead = {
        "kind": "lead", "email": "buyer@example.com", "journey": "neighbourhood", "t": 8000, "count": 2,
        "answerLines": ["35 min to work · rush hour", "Bachelor's 40%+"],
        "results": [
            {"geoid": "060373020001", "name": "Tract 3020, block group 1<script>alert(1)</script>", "busy": "Quiet streets", "houses": 83, "income": 150000, "price": 1450000},
            {"geoid": "bad'id", "name": "Tract 3020, block group 2", "busy": "Lively", "houses": 33, "income": 80000, "price": None},
        ],
        "r": "eyJjIjpbXX0",
    }
    st, _, body = req(port, "/api/lead", lead, fresh())
    check("a real sign-up is accepted and emailed", st == 200 and json.loads(body).get("emailed") is True, body)
    to_visitor = [m for m in sent if m["to"] == ["buyer@example.com"]]
    to_owner = [m for m in sent if m["to"] == ["owner@example.com"]]
    check("the visitor gets their results", len(to_visitor) == 1 and "2 areas fit" in to_visitor[0]["subject"])
    check("you get a copy, replying to the visitor", len(to_owner) == 1 and to_owner[0].get("reply_to") == "buyer@example.com")
    v = to_visitor[0]["html"] if to_visitor else ""
    check("the email escapes what the page sent", "<script>" not in v and "&lt;script&gt;" in v)
    check("the email links back to the results", "https://brickline.tech/?r=eyJjIjpbXX0#find" in v)
    check("a malformed area id gets no link", "bad'id" not in v and "/#area-060373020001" in v)
    check("the email has a working-looking unsubscribe link", "/api/unsubscribe?e=buyer%40example.com&amp;t=" in v)
    check("the plain-text version is there too", "Open your results" in (to_visitor[0]["text"] if to_visitor else ""))
    with open(os.path.join(data_dir, "leads.jsonl")) as fh:
        rows = [json.loads(l) for l in fh]
    check("the sign-up is kept on the server", any(r["email"] == "buyer@example.com" for r in rows))
    check("the visitor's internet address isn't stored", all("10.0.0." not in json.dumps(r) for r in rows))

    st, _, body = req(port, "/api/lead", {"kind": "search", "journey": "neighbourhood"}, fresh())
    check("a search event needs no email, and sends none", st == 200 and len([m for m in sent if "search" in m["subject"]]) == 0)

    for _ in range(3):
        req(port, "/api/lead", {**lead, "t": 9000}, fresh())
    st, _, body = req(port, "/api/lead", {**lead, "t": 9000}, fresh())
    check("one address gets at most 3 result emails a day", json.loads(body).get("emailed") is False)

    one = {"X-Forwarded-For": "10.9.9.9"}
    codes = [req(port, "/api/lead", {"kind": "search"}, one)[0] for _ in range(11)]
    check("one visitor is slowed down after 10 posts", codes[-1] == 429 and codes[0] == 200, str(codes))

    # --- unsubscribe ---
    token = mod.unsub_token("later@example.com")
    st, _, _ = req(port, "/api/unsubscribe?e=later%40example.com&t=wrong", headers=fresh())
    check("a forged unsubscribe link is refused", st == 400)
    st, _, body = req(port, f"/api/unsubscribe?e=later%40example.com&t={token}", headers=fresh())
    check("a real unsubscribe link works", st == 200 and "unsubscribed" in body)
    n = len(sent)
    st, _, body = req(port, "/api/lead", {**lead, "email": "later@example.com"}, fresh())
    check("an unsubscribed address gets no more results emails", json.loads(body).get("emailed") is False and not any(m["to"] == ["later@example.com"] for m in sent[n:]))

    # --- proxies ---
    st, _, body = req(port, "/api/isochrone", {"lon": 2.35, "lat": 48.85, "seconds": 1200}, fresh())
    check("a commute area outside LA County is refused", st == 400)
    st, _, body = req(port, "/api/isochrone", {"lon": -118.25, "lat": 34.15, "seconds": 99999}, fresh())
    check("an absurd commute time is refused", st == 400)
    st, _, body = req(port, "/api/isochrone", {"lon": -118.25, "lat": 34.15, "seconds": 1200}, fresh())
    iso = [o for o in outbound if "isochrones" in o["url"]]
    check("a commute area is fetched with the server's key", st == 200 and iso and iso[-1]["headers"].get("Authorization") == "ors-secret")
    check("...and the key never reaches the browser", "ors-secret" not in body)
    st, _, body = req(port, "/api/directions?start=-118.27,34.165&end=-118.25,34.147", headers=fresh())
    check("a drive time is fetched for the browser", st == 200 and "900" in body and "ors-secret" not in body)
    st, _, _ = req(port, "/api/directions?start=0,0&end=-118.25,34.147", headers=fresh())
    check("a drive from outside the area is refused", st == 400)
    st, _, body = req(port, "/api/geocode?q=1745+Grandview&mode=suggest", headers=fresh())
    g = [o for o in outbound if "locationiq" in o["url"]]
    rows = json.loads(body)
    check("address suggestions come through the server", st == 200 and g and "autocomplete" in g[-1]["url"] and "liq-secret" in g[-1]["url"] and "bounded=1" in g[-1]["url"])
    check("...in the shape the page reads, without the key", rows and rows[0]["lat"] == 34.165 and rows[0]["address"].get("road") == "Grandview Ave" and "evil" not in rows[0]["address"] and "liq-secret" not in body)
    st, _, _ = req(port, "/api/geocode?q=ab&mode=suggest", headers=fresh())
    check("a two-letter search is refused", st == 400)
    st, _, _ = req(port, "/api/geocode?q=hello&mode=../../x", headers=fresh())
    check("an unknown search mode is refused", st == 400)

    for k in ["ORS_API_KEY", "LOCATIONIQ_KEY", "RESEND_API_KEY"]:
        os.environ.pop(k, None)
    st, _, body = req(port, "/api/config", headers=fresh())
    check("without keys, config says nothing is proxied", json.loads(body) == {"ors": False, "geocode": None, "email": False})
    st, _, _ = req(port, "/api/isochrone", {"lon": -118.25, "lat": 34.15, "seconds": 1200}, fresh())
    check("without a key, commute areas say they aren't set up", st == 503)
    st, _, body = req(port, "/api/lead", {**lead, "email": "nomail@example.com"}, fresh())
    check("without email set up, a sign-up is still kept", st == 200 and json.loads(body).get("emailed") is False)
    srv.shutdown()


def main():
    tmp = tempfile.mkdtemp(prefix="brickline-public-")
    try:
        out = test_build(tmp)
        test_server(os.path.join(out, "site"), tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if failures:
        print(f"\n{len(failures)} check(s) failed")
        return 1
    print("\nAll public-server checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
