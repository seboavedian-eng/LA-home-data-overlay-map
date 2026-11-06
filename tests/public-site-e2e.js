// The public package in a real browser, served by the real public server
// with its Content-Security-Policy on. Catches what the page test can't: a
// policy that blocks the map, a page that still reaches for a key file, or
// address search that still goes to Nominatim from a public site.
//
//   node tests/public-site-e2e.js
const { chromium } = require("playwright");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
const PORT = 8961;

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brickline-site-"));
  const out = path.join(tmp, "dist");
  const build = spawnSync("python3", [path.join(REPO, "scripts", "build-public-site.py"), "--out", out], { encoding: "utf8" });
  if (build.status !== 0) { console.error(build.stderr); process.exit(1); }
  const server = spawn("python3", [path.join(out, "server.py")], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(tmp, "data"), ORS_API_KEY: "fake-ors", LOCATIONIQ_KEY: "fake-liq", UNSUB_SECRET: "x" },
    stdio: "ignore",
  });
  const kill = () => { try { server.kill(); } catch (e) { /* gone */ } fs.rmSync(tmp, { recursive: true, force: true }); };
  process.on("exit", kill);
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch (e) { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }

  const results = [];
  const step = (name, ok, detail) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}`); };
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const csp = [], requests = [], errors = [];
  page.on("console", (m) => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) csp.push(t); });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => requests.push(r.url()));
  // Outside services are not under test here; refuse them like a dead host.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort("failed"));

  const res = await page.goto(`http://127.0.0.1:${PORT}/?mode=public`);
  step("the public home page loads", res.status() === 200);
  step("it is sent with a strict script policy", /script-src 'self' 'unsafe-eval';/.test(res.headers()["content-security-policy"] || ""));
  await page.waitForFunction(() => window.Brickline && Brickline.forTest.state.D.cfg, null, { timeout: 15000 }).catch(() => {});
  step("the page runs under that policy (no blocked scripts)", await page.evaluate(() => typeof Brickline !== "undefined" && typeof BG_CONFIG !== "undefined"));
  step("the map starts", await page.evaluate(() => !!document.querySelector("#map .leaflet-pane")));
  step("nothing is refused by the policy", csp.length === 0, csp.slice(0, 2).join(" | "));
  step("the server's config reaches the page", await page.evaluate(() => { const c = Brickline.forTest.state.D.cfg; return c.ors === true && c.geocode === "proxy"; }));
  step("public mode is on", !(await page.evaluate(() => Brickline.forTest.state.PERSONAL)));
  step("the page never asks for a key file", !requests.some((u) => /api-key|\.env/.test(u)));
  step("no ratings or Redfin files are requested", !requests.some((u) => /redfin-listings|raw-data/.test(u)));

  await page.fill("#home-q", "");
  await page.type("#home-q", "1745 Grandview", { delay: 20 });
  await page.waitForTimeout(1500);
  step("address suggestions go to the Brickline server", requests.some((u) => /\/api\/geocode\?/.test(u)));
  step("...never to Nominatim from a public site", !requests.some((u) => /nominatim\.openstreetmap\.org/.test(u)));
  const priv = await page.request.get(`http://127.0.0.1:${PORT}/privacy.html`);
  step("the privacy page is served", priv.status() === 200 && /What we collect/.test(await priv.text()));
  const leaked = await Promise.all(["/.env", "/ors-api-key.txt", "/raw-data/leads.jsonl", "/blockgroups.html", "/server.py"].map(async (p) => (await page.request.get(`http://127.0.0.1:${PORT}${p}`)).status()));
  step("private paths answer 404", leaked.every((s) => s === 404), leaked.join(","));
  step("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
