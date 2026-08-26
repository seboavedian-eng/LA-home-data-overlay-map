const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
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
    // The api.census.gov request is deliberately aborted above to simulate
    // its real-world CORS failure - Chrome logs a generic
    // "Failed to load resource" for that regardless of whether the app
    // recovers from it (which the status-log checks above verify), so
    // it's expected noise here, not a real bug.
    if (msg.type() === "error" && !msg.text().includes("Failed to load resource")) consoleErrors.push(msg.text());
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
  // Discovery calls (?f=json, no /query) return an Esri MapServer layer
  // list; /query calls return native Esri JSON (geometryType + features
  // with attributes/geometry.rings) - the app converts that client-side
  // now, it no longer asks the server for f=geojson. Also added a decoy
  // non-polygon sublayer on the fire service to exercise the new
  // geometryType filter.
  await page.route("**://tigerweb.geo.census.gov/**", (route) => {
    const url = route.request().url();
    if (url.includes("/query")) {
      return route.fulfill(json(F.ZCTA_ESRI));
    }
    return route.fulfill(json({ layers: [{ id: 2, name: "2020 Census ZIP Code Tabulation Areas", geometryType: "esriGeometryPolygon" }] }));
  });

  // Simulate the real-world failure: api.census.gov does not send CORS
  // headers, so a direct browser fetch fails at the network level before
  // any response body is seen. route.abort() reproduces exactly that
  // ("Failed to fetch"), which is what should trigger the CORS-proxy
  // fallback in Utils.fetchJSONWithCorsFallback.
  await page.route("**://api.census.gov/**", (route) => route.abort("failed"));
  await page.route("**://api.allorigins.win/**", (route) => {
    return route.fulfill(json(F.CENSUS_ROWS));
  });

  await page.route("**://dpw.gis.lacounty.gov/**", (route) => {
    const url = route.request().url();
    if (url.includes("/0/query")) {
      return route.fulfill(json(F.CITY_LA_ESRI));
    }
    return route.fulfill(json({ layers: [{ id: 0, name: "City Boundary Lines", geometryType: "esriGeometryPolygon" }] }));
  });

  await page.route("**://services.gis.ca.gov/**Fire_Severity_Zones**", (route) => {
    const url = route.request().url();
    if (url.includes("/0/query")) return route.fulfill(json(F.FIRE_SRA_ESRI));
    if (url.includes("/1/query")) return route.fulfill(json(F.FIRE_LRA_ESRI));
    if (url.includes("/2/query")) return route.fulfill(json({ error: "line layer should have been filtered out" }));
    return route.fulfill(
      json({
        layers: [
          { id: 0, name: "FHSZ SRA", geometryType: "esriGeometryPolygon" },
          { id: 1, name: "FHSZ LRA", geometryType: "esriGeometryPolygon" },
          { id: 2, name: "Hazard Zone Boundaries (lines)", geometryType: "esriGeometryPolyline" },
        ],
      })
    );
  });

  // Exercise the actual multi-candidate fallback in getDistrictsGeoJSON:
  // the first candidate (DistrictAreas2425Locale) 400s just like the real
  // service did in real-browser testing, forcing a fall-through to the
  // next candidate (plain DistrictAreas2425), which succeeds.
  await page.route("**://services3.arcgis.com/**DistrictAreas2425Locale**", (route) => {
    // ArcGIS REST returns errors as HTTP 200 with an "error" object in the
    // body (matching the real "Invalid URL" response seen in testing), not
    // an actual non-2xx status - fetchJSON's data.error check catches this.
    return route.fulfill(json({ error: { code: 400, message: "Invalid URL", details: ["Invalid URL"] } }));
  });
  await page.route("**://services3.arcgis.com/**DistrictAreas2425/**", (route) => {
    return route.fulfill(json(F.DISTRICT_LAUSD_ESRI));
  });

  await page.route("**://services3.arcgis.com/**SchoolSites2425**", (route) => {
    return route.fulfill(json(F.SCHOOLS_ESRI));
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
  // Check by DOM class (li.error), not by text-matching for "fail" - the
  // CORS-proxy recovery message below legitimately contains the word
  // "Failed" as part of describing what it recovered *from*.
  const errorLineCount = await page.locator("#status-log li.error").count();
  const errorLineText = errorLineCount ? await page.locator("#status-log li.error").allTextContents() : [];
  step("no error-level lines in status log after toggling all layers", errorLineCount === 0, errorLineText.join(" | "));
  step(
    "census CORS-proxy fallback actually engaged (not just coincidentally working)",
    statusText.includes("retrying via CORS proxy"),
    statusText.slice(-600)
  );
  step(
    "districts multi-candidate fallback actually engaged (first candidate failed, second used)",
    statusText.includes("didn't work") && statusText.includes("trying next candidate") && statusText.includes("Using district layer:"),
    statusText
  );

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

  // Verify the fire-hazard polygon's hole was correctly cut out (this is
  // the exact multi-ring bug class the f=json + client-side conversion
  // fix addresses) - a point inside the hole should NOT be flagged as
  // being in the hazard zone, while a point elsewhere in the same
  // polygon should.
  const holeTest = await page.evaluate(() => {
    const entry = App.getLayer("fire-hazard");
    let containsHolePoint = false;
    let containsOutsidePoint = false;
    entry.leafletLayer.eachLayer((l) => {
      const holePt = turf.point([-118.29, 34.12]); // inside the fixture's hole
      const outsidePt = turf.point([-118.20, 34.00]); // inside the ring, outside the hole
      if (turf.booleanPointInPolygon(holePt, l.feature)) containsHolePoint = true;
      if (turf.booleanPointInPolygon(outsidePt, l.feature)) containsOutsidePoint = true;
    });
    return { containsHolePoint, containsOutsidePoint };
  });
  step(
    "fire hazard polygon hole is correctly cut out",
    holeTest.containsOutsidePoint === true && holeTest.containsHolePoint === false,
    JSON.stringify(holeTest)
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

  // GreatSchools links: must be per-school Google searches, not one shared URL.
  const gsLinks = await page.locator("#summary-table-wrap a").allTextContents();
  const gsHrefs = await page.locator("#summary-table-wrap a").evaluateAll((els) => els.map((e) => e.href));
  const distinctHrefs = new Set(gsHrefs);
  step(
    "GreatSchools links are per-school Google searches, not one shared URL",
    gsHrefs.length >= 2 &&
      distinctHrefs.size === gsHrefs.length &&
      gsHrefs.every((h) => h.startsWith("https://www.google.com/search?q=") && h.toLowerCase().includes("greatschools")),
    JSON.stringify(gsHrefs)
  );

  step("no console/page errors thrown", consoleErrors.length === 0, consoleErrors.join(" | "));

  // Isolate fire-hazard for a clean visual check of the borderless-polygon fix.
  for (const key of ["city-borders", "demographics", "income", "schools", "school-districts"]) {
    await page.uncheck(`#layer-${key}`);
  }
  await page.mouse.click(700, 400); // close any open popup
  await page.waitForTimeout(300);
  await page.locator("#map").screenshot({ path: path.join(__dirname, "screenshot-fire-only.png") });

  await page.screenshot({ path: path.join(__dirname, "screenshot-full.png"), fullPage: false });
  await page.evaluate(() => document.getElementById("sidebar").scrollTo(0, document.getElementById("sidebar").scrollHeight));
  await page.locator("#sidebar").screenshot({ path: path.join(__dirname, "screenshot-sidebar-bottom.png") });
  await page.evaluate(() => document.getElementById("address-input").blur());

  // --- Local Census snapshot: the new primary path (scripts/fetch-census-data.sh) ---
  // Writes a real fixture file into js/data/ (exactly what the script
  // produces), loads a fresh page, and confirms Demographics reads it
  // same-origin instead of going anywhere near api.census.gov or a proxy.
  // Always removes the file afterward, even on failure.
  const snapshotPath = path.join(REPO, "js", "data", "acs-zcta.json");
  const snapshotDir = path.dirname(snapshotPath);
  const dirExisted = fs.existsSync(snapshotDir);
  try {
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(snapshotPath, JSON.stringify(F.CENSUS_ROWS));

    const page2 = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    await page2.route("**://api.census.gov/**", (route) => route.abort("failed")); // must never be hit
    await page2.route("**://*.basemaps.cartocdn.com/**", (route) => route.fulfill({ contentType: "image/png", body: BLANK_PNG }));
    await page2.route("**://tigerweb.geo.census.gov/**", (route) => {
      const url = route.request().url();
      if (url.includes("/query")) return route.fulfill(json(F.ZCTA_ESRI));
      return route.fulfill(json({ layers: [{ id: 2, name: "2020 Census ZIP Code Tabulation Areas", geometryType: "esriGeometryPolygon" }] }));
    });
    await page2.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "load" });
    await page2.waitForSelector("#layer-toggle-list li");
    await page2.click("#layer-demographics");
    await page2.waitForFunction(
      () => document.getElementById("status-log").textContent.includes("Demographics loaded"),
      { timeout: 10000 }
    );
    const snapshotStatusText = await page2.locator("#status-log").innerText();
    step(
      "local Census snapshot (scripts/fetch-census-data.sh output) is used when present, no network call",
      snapshotStatusText.includes("Loaded ACS data from local snapshot") && !snapshotStatusText.includes("CORS proxy"),
      snapshotStatusText
    );
    await page2.close();
  } finally {
    fs.rmSync(snapshotPath, { force: true });
    if (!dirExisted) fs.rmSync(snapshotDir, { recursive: true, force: true });
  }

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
