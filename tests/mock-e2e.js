const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const F = require("./fixtures");

const REPO = path.join(__dirname, "..");
const PORT = 8940;

function json(body) {
  return { contentType: "application/json", body: JSON.stringify(body) };
}

async function main() {
  const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO });
  await new Promise((r) => setTimeout(r, 800));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });

  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push("pageerror: " + err.message));
  page.on("requestfailed", (req) => console.log("REQUEST FAILED:", req.url(), req.failure() && req.failure().errorText));

  // Basemap tiles: not part of app logic under test, just stub a blank PNG
  // (real CARTO tiles are unreachable from this sandbox's network policy but
  // work fine from a normal browser with real internet access).
  const BLANK_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  await page.route("**://*.basemaps.cartocdn.com/**", (route) =>
    route.fulfill({ contentType: "image/png", body: BLANK_PNG })
  );

  // --- Route interception: mock every external GIS/Census/geocoder call ---
  await page.route("**://tigerweb.geo.census.gov/**", (route) => {
    const url = route.request().url();
    if (url.includes("f=json") && !url.includes("/query")) {
      return route.fulfill(json({ layers: [{ id: 2, name: "2020 Census ZIP Code Tabulation Areas" }] }));
    }
    if (url.includes("/2/query")) {
      return route.fulfill(json(F.fc([F.ZCTA_90012, F.ZCTA_90210])));
    }
    return route.fulfill(json({ error: "unhandled tigerweb route: " + url }));
  });

  await page.route("**://api.census.gov/**", (route) => {
    return route.fulfill(json(F.CENSUS_ROWS));
  });

  await page.route("**://dpw.gis.lacounty.gov/**", (route) => {
    const url = route.request().url();
    if (url.includes("f=json") && !url.includes("/query")) {
      return route.fulfill(json({ layers: [{ id: 0, name: "City Boundary Lines" }] }));
    }
    if (url.includes("/0/query")) {
      return route.fulfill(json(F.fc([F.CITY_LA])));
    }
    return route.fulfill(json({ error: "unhandled city route: " + url }));
  });

  await page.route("**://services.gis.ca.gov/**Fire_Severity_Zones**", (route) => {
    const url = route.request().url();
    if (url.includes("f=json") && !url.includes("/query")) {
      return route.fulfill(json({ layers: [{ id: 0, name: "FHSZ SRA" }, { id: 1, name: "FHSZ LRA" }] }));
    }
    if (url.includes("/0/query")) return route.fulfill(json(F.fc([F.FIRE_SRA_MODERATE])));
    if (url.includes("/1/query")) return route.fulfill(json(F.fc([F.FIRE_LRA_HIGH])));
    return route.fulfill(json({ error: "unhandled fire route: " + url }));
  });

  await page.route("**://services.gis.ca.gov/**CA_School_Districts**", (route) => {
    const url = route.request().url();
    if (url.includes("f=json") && !url.includes("/query")) {
      return route.fulfill(json({ layers: [{ id: 0, name: "Unified School Districts" }] }));
    }
    if (url.includes("/0/query")) return route.fulfill(json(F.fc([F.DISTRICT_LAUSD])));
    return route.fulfill(json({ error: "unhandled district route: " + url }));
  });

  await page.route("**://services3.arcgis.com/**SchoolSites2425**", (route) => {
    return route.fulfill(json(F.fc(F.SCHOOLS)));
  });

  await page.route("**://geocoding.geo.census.gov/**", (route) => {
    return route.fulfill(json(F.GEOCODER_RESPONSE));
  });

  const results = { steps: [] };
  function step(name, ok, detail) {
    results.steps.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} - ${name}${detail ? " :: " + detail : ""}`);
  }

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "load" });
  await page.waitForSelector("#layer-toggle-list li");

  const layerCount = await page.locator("#layer-toggle-list li").count();
  step("layer list rendered", layerCount === 7, `found ${layerCount} layers`);

  // zip-borders is defaultOn - wait for its status log "loaded"
  await page.waitForFunction(
    () => document.getElementById("status-log").textContent.includes("Zip Code Borders loaded"),
    { timeout: 10000 }
  );
  step("zip borders auto-loaded", true);

  const keys = ["city-borders", "demographics", "income", "fire-hazard", "schools", "school-districts"];
  for (const key of keys) {
    await page.click(`#layer-${key}`);
    await page.waitForFunction(
      (k) => {
        const log = document.getElementById("status-log").textContent;
        return log.includes(`${k}`) || true; // fallback below checks per-label text
      },
      key,
      { timeout: 15000 }
    );
  }
  // Give async loaders a moment, then check each logged an "ok" (loaded) line.
  await page.waitForTimeout(1500);
  const statusText = await page.locator("#status-log").innerText();
  for (const label of ["City Borders", "Demographics", "Income Levels", "Fire Hazard Zones", "Schools", "School District Boundaries"]) {
    const ok = statusText.includes(`${label} loaded`);
    step(`${label} loaded without error`, ok, ok ? "" : statusText.slice(-400));
  }
  const errorLines = statusText.split("\n").filter((l) => l.toLowerCase().includes("error") || l.toLowerCase().includes("fail"));
  step("no error lines in status log after toggling all layers", errorLines.length === 0, errorLines.join(" | "));

  // Click a zip polygon feature to confirm popup content (demographics).
  // Programmatically open popup via Leaflet layer to avoid pixel-coordinate flakiness.
  const demoPopupHTML = await page.evaluate(() => {
    const entry = App.getLayer("demographics");
    let html = null;
    entry.leafletLayer.eachLayer((l) => {
      if (!html && l.feature.properties.ZCTA5 === "90012") {
        l.openPopup();
        html = l.getPopup().getContent();
      }
    });
    return html;
  });
  step(
    "demographics popup for 90012 shows population + hispanic/white rows",
    !!demoPopupHTML && demoPopupHTML.includes("25,000") && demoPopupHTML.includes("Hispanic") && demoPopupHTML.includes("30.0%"),
    demoPopupHTML ? demoPopupHTML.replace(/\s+/g, " ").slice(0, 300) : "no popup html"
  );

  const incomePopupHTML = await page.evaluate(() => {
    const entry = App.getLayer("income");
    let html = null;
    entry.leafletLayer.eachLayer((l) => {
      if (!html && l.feature.properties.ZCTA5 === "90210") {
        l.openPopup();
        html = l.getPopup().getContent();
      }
    });
    return html;
  });
  step(
    "income popup for 90210 shows $155,000 median income",
    !!incomePopupHTML && incomePopupHTML.includes("$155,000"),
    incomePopupHTML ? incomePopupHTML.replace(/\s+/g, " ").slice(0, 300) : "no popup html"
  );

  // --- Address search flow ---
  await page.fill("#address-input", "200 N Spring St, Los Angeles, CA 90012");
  await page.click("#search-form button");
  await page.waitForFunction(() => document.getElementById("search-status").textContent.startsWith("Found:"), { timeout: 15000 });

  const summaryText = await page.locator("#summary-table-wrap").innerText();
  step("summary shows matched address", summaryText.includes("200 N SPRING ST"));
  step("summary shows ZIP 90012", /ZIP code\s*\n?90012/.test(summaryText) || summaryText.includes("90012"));
  step("summary shows city Los Angeles", summaryText.includes("Los Angeles"));
  step("summary shows total population 25,000", summaryText.includes("25,000"));
  step("summary shows median household income $68,000", summaryText.includes("$68,000"));
  step("summary shows fire hazard Moderate", summaryText.includes("Moderate"));
  step("summary shows nearest school Central Elementary before farther ones", (() => {
    const idxCentral = summaryText.indexOf("Central Elementary");
    const idxNorthside = summaryText.indexOf("Northside High");
    const idxFar = summaryText.indexOf("Far Away School");
    return idxCentral !== -1 && (idxNorthside === -1 || idxCentral < idxNorthside) && idxFar === -1;
  })());

  step("no console/page errors thrown", consoleErrors.length === 0, consoleErrors.join(" | "));

  await page.screenshot({ path: path.join(__dirname, "screenshot-full.png"), fullPage: false });
  await page.evaluate(() => document.getElementById("sidebar").scrollTo(0, document.getElementById("sidebar").scrollHeight));
  await page.locator("#sidebar").screenshot({ path: path.join(__dirname, "screenshot-sidebar-bottom.png") });
  await page.evaluate(() => document.getElementById("address-input").blur());

  const failed = results.steps.filter((s) => !s.ok);
  console.log(`\n${results.steps.length - failed.length}/${results.steps.length} checks passed.`);
  if (failed.length) {
    console.log("FAILURES:");
    failed.forEach((f) => console.log(` - ${f.name}: ${f.detail}`));
  }

  await browser.close();
  server.kill();
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
