// End-to-end test for blockgroups.html, with every external call mocked.
// Run: node tests/blockgroups-e2e.js   (after `npm install` in tests/)

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const REPO = path.join(__dirname, "..");
const PORT = 8941;

function json(body) {
  return { contentType: "application/json", body: JSON.stringify(body) };
}

// --- Fixtures --------------------------------------------------------------

function ring(coords) {
  return [[...coords, coords[0]]];
}
function esriPolygon(attributes, coords) {
  return { attributes, geometry: { rings: ring(coords) } };
}
function esriFC(features) {
  return { geometryType: "esriGeometryPolygon", fields: [], features };
}

// Block groups sit around the default map center (34.05, -118.25) so they
// fall inside the viewport at the default zoom 12.
const BG_A = esriPolygon({ GEOID: "060372011001", NAME: "Block Group 1, Census Tract 2011" }, [
  [-118.26, 34.04], [-118.26, 34.06], [-118.24, 34.06], [-118.24, 34.04],
]);
const BG_B = esriPolygon({ GEOID: "060372011002", NAME: "Block Group 2, Census Tract 2011" }, [
  [-118.24, 34.04], [-118.24, 34.06], [-118.22, 34.06], [-118.22, 34.04],
]);
const TRACT = esriPolygon({ GEOID: "06037201100", NAME: "Census Tract 2011" }, [
  [-118.26, 34.04], [-118.26, 34.06], [-118.22, 34.06], [-118.22, 34.04],
]);
const ZCTA = esriPolygon({ ZCTA5CE20: "90012", NAME: "ZCTA5 90012" }, [
  [-118.30, 34.00], [-118.30, 34.10], [-118.15, 34.10], [-118.15, 34.00],
]);

// Round numbers chosen so every derived percentage is exact and unambiguous:
//   age    500/300/200 of 1000  -> 50.0% / 30.0% / 20.0%
//   sex    510 F / 490 M        -> 51.0% / 49.0%
//   edu    240 of 800 (25+)     -> 30.0%  (NOT 24% of total pop - proves the
//                                  denominator is the 25+ population)
//   ACS ethnicity totals 1000, decennial totals 900 with a different mix, so
//   switching source visibly changes both the percentages and the ordering.
const CENSUS_DATA = {
  meta: {
    year: 2022,
    decennialYear: 2020,
    geoLevels: {
      age: "block group",
      ethnicityAcs: "block group",
      ethnicityDec: "block group",
      education: "block group",
      income: "block group",
    },
  },
  blockGroups: {
    "060372011001": {
      totalPopulation: 1000,
      under25: 500,
      age25to54: 300,
      age55plus: 200,
      female: 510,
      male: 490,
      ethnicityAcsTotal: 1000,
      ethnicityAcs: {
        "Hispanic or Latino": 450,
        "White (non-Hispanic)": 250,
        "Asian (non-Hispanic)": 200,
        "Black (non-Hispanic)": 100,
      },
      ethnicityDecTotal: 900,
      ethnicityDec: {
        "Hispanic or Latino": 270,
        "White (non-Hispanic)": 360,
        "Asian (non-Hispanic)": 180,
        "Black (non-Hispanic)": 90,
      },
      eduTotal25plus: 800,
      eduBachelorsPlus: 240,
      medianHouseholdIncome: 85000,
      perCapitaIncome: 41000,
    },
  },
};

async function main() {
  const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO });
  await new Promise((r) => setTimeout(r, 800));

  const dataPath = path.join(REPO, "js", "data", "bg-la-county.json");
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  fs.writeFileSync(dataPath, JSON.stringify(CENSUS_DATA));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });

  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && !msg.text().includes("Failed to load resource")) consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push("pageerror: " + err.message));

  const BLANK_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  await page.route("**://tile.openstreetmap.org/**", (route) =>
    route.fulfill({ contentType: "image/png", body: BLANK_PNG })
  );

  let tigerQueryCount = { zip: 0, tract: 0, bg: 0 };
  let decoyQueryCount = 0;
  await page.route("**://tigerweb.geo.census.gov/**", (route) => {
    const url = route.request().url();
    if (url.includes("/2/query")) {
      tigerQueryCount.zip++;
      return route.fulfill(json(esriFC([ZCTA])));
    }
    if (url.includes("/8/query")) {
      tigerQueryCount.tract++;
      return route.fulfill(json(esriFC([TRACT])));
    }
    if (url.includes("/10/query")) {
      tigerQueryCount.bg++;
      return route.fulfill(json(esriFC([BG_A, BG_B])));
    }
    // Empty layers standing in for TIGERweb's tribal/label layers, which
    // query successfully but return nothing in most of LA County.
    if (url.includes("/4/query") || url.includes("/5/query") || url.includes("/9/query") || url.includes("/11/query")) {
      decoyQueryCount++;
      return route.fulfill(json(esriFC([])));
    }
    // Layer discovery (?f=json on the MapServer root). The decoy layers are
    // listed BEFORE the real ones on purpose: a naive substring match on
    // "Census Tract"/"Block Group" picks the tribal layer and silently
    // returns zero features, which is exactly the bug this guards against.
    return route.fulfill(
      json({
        layers: [
          { id: 4, name: "Tribal Census Tracts", geometryType: "esriGeometryPolygon" },
          { id: 5, name: "Tribal Block Groups", geometryType: "esriGeometryPolygon" },
          { id: 9, name: "Census Tracts Labels", geometryType: "esriGeometryPoint" },
          { id: 11, name: "Census Block Groups Labels", geometryType: "esriGeometryPoint" },
          { id: 2, name: "2020 Census ZIP Code Tabulation Areas", geometryType: "esriGeometryPolygon" },
          { id: 8, name: "Census Tracts", geometryType: "esriGeometryPolygon" },
          { id: 10, name: "Census Block Groups", geometryType: "esriGeometryPolygon" },
        ],
      })
    );
  });

  const steps = [];
  function step(name, ok, detail) {
    steps.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} - ${name}${detail ? " :: " + detail : ""}`);
  }

  try {
    await page.goto(`http://localhost:${PORT}/blockgroups.html`, { waitUntil: "load" });
    await page.waitForSelector("#toggle-bg");

    step("page loads with three boundary toggles", (await page.locator("#layer-toggle-list li").count()) === 3);
    step("no layers are on before any toggle is clicked", tigerQueryCount.zip === 0 && tigerQueryCount.tract === 0 && tigerQueryCount.bg === 0);

    // --- Zip toggle ---
    await page.check("#toggle-zip");
    await page.waitForFunction(() => document.getElementById("status-log").textContent.includes("Zip code borders: "), { timeout: 10000 });
    step("zip layer loads when toggled on", tigerQueryCount.zip > 0);

    // --- Tract toggle ---
    await page.check("#toggle-tract");
    await page.waitForFunction(() => document.getElementById("status-log").textContent.includes("Census tract borders: "), { timeout: 10000 });
    step("tract layer loads when toggled on", tigerQueryCount.tract > 0);

    // --- Block group toggle ---
    await page.check("#toggle-bg");
    await page.waitForFunction(() => document.getElementById("status-log").textContent.includes("Block group borders: "), { timeout: 10000 });
    step("block group layer loads when toggled on", tigerQueryCount.bg > 0);

    step(
      "never queries TIGERweb's tribal/label decoy layers (the 0-features bug)",
      decoyQueryCount === 0,
      `decoy layers queried ${decoyQueryCount} times`
    );
    step(
      "layers actually return features, not an empty result",
      !(await page.locator("#status-log").innerText()).includes("0 features returned"),
      await page.locator("#status-log").innerText()
    );

    // --- Click a block group ---
    const clicked = await page.evaluate(() => {
      const layers = BlockGroupApp.state.layers;
      if (!layers.blockGroup) return false;
      let done = false;
      layers.blockGroup.eachLayer((l) => {
        if (!done && l.feature.properties.GEOID === "060372011001") {
          l.fire("click");
          done = true;
        }
      });
      return done;
    });
    step("clicking a block group fires its handler", clicked);

    await page.waitForSelector(".leaflet-popup-content .detail-card", { timeout: 5000 });
    const popupText = await page.locator(".leaflet-popup-content").innerText();
    const panelText = await page.locator("#detail-panel").innerText();

    step(
      "popup heads with census tract and block group number",
      popupText.includes("Tract 2011") && /Block Group\s*1\b/.test(popupText),
      popupText.replace(/\s+/g, " ").slice(0, 120)
    );
    step("popup shows total population", popupText.includes("1,000"));
    step(
      "popup shows age bands 0-24 / 25-54 / 55+ with correct percentages",
      popupText.includes("0 to 24") && popupText.includes("50.0%") &&
        popupText.includes("25 to 54") && popupText.includes("30.0%") &&
        popupText.includes("55 and over") && popupText.includes("20.0%"),
      popupText.replace(/\s+/g, " ").slice(0, 260)
    );
    step(
      "popup shows sex split (51% female / 49% male)",
      popupText.includes("51.0%") && popupText.includes("49.0%"),
      popupText.replace(/\s+/g, " ").slice(0, 260)
    );
    step(
      "ethnicity defaults to B03002 (ACS) values, ordered high to low",
      (() => {
        const order = ["Hispanic or Latino", "White (non-Hispanic)", "Asian (non-Hispanic)", "Black (non-Hispanic)"];
        let last = -1;
        for (const label of order) {
          const i = popupText.indexOf(label);
          if (i === -1 || i < last) return false;
          last = i;
        }
        return popupText.includes("45.0%") && popupText.includes("25.0%");
      })(),
      popupText.replace(/\s+/g, " ").slice(0, 320)
    );
    step(
      "education % is of the 25+ population, not total population (30.0%, not 24.0%)",
      popupText.includes("30.0%") && !popupText.includes("24.0%"),
      popupText.replace(/\s+/g, " ").slice(0, 320)
    );
    step("popup shows median household income", popupText.includes("$85,000"));
    step("popup shows per-capita income", popupText.includes("$41,000"));
    step("sidebar detail panel mirrors the popup", panelText.includes("Hispanic or Latino") && panelText.includes("$85,000"));

    // --- Ethnicity source toggle ---
    const defaultChecked = await page.isChecked("#source-acs");
    step("ethnicity source defaults to B03002 (ACS)", defaultChecked);

    await page.check("#source-dec");
    await page.waitForTimeout(300);
    const decText = await page.locator("#detail-panel").innerText();
    step(
      "switching to P2 re-renders with 2020 Census values (White now leads at 40.0%)",
      decText.includes("2020 Census P2") && decText.includes("40.0%") && decText.includes("30.0%") &&
        decText.indexOf("White (non-Hispanic)") < decText.indexOf("Hispanic or Latino"),
      decText.replace(/\s+/g, " ").slice(0, 320)
    );
    step(
      "non-ethnicity numbers are unchanged by the source switch",
      decText.includes("$85,000") && decText.includes("51.0%"),
      decText.replace(/\s+/g, " ").slice(0, 200)
    );

    await page.check("#source-acs");
    await page.waitForTimeout(300);
    const backText = await page.locator("#detail-panel").innerText();
    step("switching back to B03002 restores ACS values", backText.includes("B03002") && backText.includes("45.0%"));

    // Capture the interesting state (popup open with data) before the
    // teardown checks below zoom out and toggle layers off.
    await page.screenshot({ path: path.join(__dirname, "screenshot-blockgroups.png") });

    // --- Block group with no data in the file ---
    await page.evaluate(() => {
      BlockGroupApp.state.layers.blockGroup.eachLayer((l) => {
        if (l.feature.properties.GEOID === "060372011002") l.fire("click");
      });
    });
    await page.waitForTimeout(300);
    const missingText = await page.locator("#detail-panel").innerText();
    step("block group missing from the data file degrades gracefully", missingText.includes("060372011002") && !missingText.includes("$85,000"), missingText.slice(0, 160));

    // --- Zoom out: block groups should unload below min zoom ---
    await page.evaluate(() => {
      const m = BlockGroupApp.state.layers.blockGroup._map;
      m.setZoom(9);
    });
    await page.waitForTimeout(1200);
    const hintText = await page.locator("#zoom-hint").innerText();
    const bgStillOn = await page.evaluate(() => !!BlockGroupApp.state.layers.blockGroup);
    step("block groups unload when zoomed out past the minimum", !bgStillOn, `layerPresent=${bgStillOn}`);
    step("zoom hint tells the user to zoom in", /zoom in/i.test(hintText), hintText);

    // --- Toggling off ---
    await page.uncheck("#toggle-zip");
    const zipOff = await page.evaluate(() => !BlockGroupApp.state.layers.zip);
    step("toggling a layer off removes it", zipOff);

    step("no console/page errors thrown", consoleErrors.length === 0, consoleErrors.join(" | "));

    // --- Missing / corrupt data file diagnostics ---
    // These are what a user actually hits before running the fetch script,
    // so the message has to name the real cause and the exact URL.
    const page404 = await browser.newPage();
    await page404.route("**/js/data/bg-la-county.json", (route) =>
      route.fulfill({ status: 404, contentType: "text/plain", body: "File not found" })
    );
    await page404.route("**://tile.openstreetmap.org/**", (route) =>
      route.fulfill({ contentType: "image/png", body: BLANK_PNG })
    );
    await page404.route("**://tigerweb.geo.census.gov/**", (route) => {
      const url = route.request().url();
      if (url.includes("/10/query")) return route.fulfill(json(esriFC([BG_A])));
      return route.fulfill(json({ layers: [{ id: 10, name: "Census Block Groups", geometryType: "esriGeometryPolygon" }] }));
    });
    await page404.goto(`http://localhost:${PORT}/blockgroups.html`, { waitUntil: "load" });
    await page404.check("#toggle-bg");
    await page404.waitForFunction(
      () => document.getElementById("status-log").textContent.includes("Block group data"),
      { timeout: 10000 }
    );
    await page404.evaluate(() => {
      BlockGroupApp.state.layers.blockGroup.eachLayer((l) => l.fire("click"));
    });
    await page404.waitForTimeout(300);
    const missingFileText = await page404.locator("#detail-panel").innerText();
    step(
      "missing data file reports 'not found' with the full URL, not a generic message",
      missingFileText.includes("bg-la-county.json") && /not found|No file at/i.test(missingFileText) &&
        missingFileText.includes("fetch-blockgroup-data.py"),
      missingFileText.replace(/\s+/g, " ").slice(0, 220)
    );
    step(
      "missing-file message warns that the web server occupies its own terminal",
      /second terminal/i.test(missingFileText),
      missingFileText.replace(/\s+/g, " ").slice(0, 260)
    );

    // Same page on a Windows user agent must print Windows commands - telling
    // a Windows user to run `python3 scripts/...` sends them after a command
    // that doesn't exist there.
    const winContext = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    });
    const winPage = await winContext.newPage();
    await winPage.route("**/js/data/bg-la-county.json", (route) =>
      route.fulfill({ status: 404, contentType: "text/plain", body: "File not found" })
    );
    await winPage.route("**://tile.openstreetmap.org/**", (route) =>
      route.fulfill({ contentType: "image/png", body: BLANK_PNG })
    );
    await winPage.route("**://tigerweb.geo.census.gov/**", (route) => {
      const u = route.request().url();
      if (u.includes("/10/query")) return route.fulfill(json(esriFC([BG_A])));
      return route.fulfill(json({ layers: [{ id: 10, name: "Census Block Groups", geometryType: "esriGeometryPolygon" }] }));
    });
    await winPage.goto(`http://localhost:${PORT}/blockgroups.html`, { waitUntil: "load" });
    await winPage.check("#toggle-bg");
    await winPage.waitForFunction(
      () => document.getElementById("status-log").textContent.includes("Block group data"),
      { timeout: 10000 }
    );
    await winPage.evaluate(() => {
      BlockGroupApp.state.layers.blockGroup.eachLayer((l) => l.fire("click"));
    });
    await winPage.waitForTimeout(300);
    const winText = await winPage.locator("#detail-panel").innerText();
    step(
      "Windows browsers are told `python scripts\\...`, not `python3 scripts/...`",
      winText.includes("python scripts\\fetch-blockgroup-data.py") && !winText.includes("python3"),
      winText.replace(/\s+/g, " ").slice(0, 240)
    );
    await winContext.close();

    const pageBad = await browser.newPage();
    await pageBad.route("**/js/data/bg-la-county.json", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{ this is not valid json" })
    );
    await pageBad.route("**://tile.openstreetmap.org/**", (route) =>
      route.fulfill({ contentType: "image/png", body: BLANK_PNG })
    );
    await pageBad.route("**://tigerweb.geo.census.gov/**", (route) => {
      const url = route.request().url();
      if (url.includes("/10/query")) return route.fulfill(json(esriFC([BG_A])));
      return route.fulfill(json({ layers: [{ id: 10, name: "Census Block Groups", geometryType: "esriGeometryPolygon" }] }));
    });
    await pageBad.goto(`http://localhost:${PORT}/blockgroups.html`, { waitUntil: "load" });
    await pageBad.check("#toggle-bg");
    await pageBad.waitForFunction(
      () => document.getElementById("status-log").textContent.includes("Block group data"),
      { timeout: 10000 }
    );
    await pageBad.evaluate(() => {
      BlockGroupApp.state.layers.blockGroup.eachLayer((l) => l.fire("click"));
    });
    await pageBad.waitForTimeout(300);
    const badFileText = await pageBad.locator("#detail-panel").innerText();
    step(
      "corrupt data file is reported as unreadable, not as missing",
      /isn't valid JSON|unreadable/i.test(badFileText) && !/No file at/i.test(badFileText),
      badFileText.replace(/\s+/g, " ").slice(0, 220)
    );
    await page404.close();
    await pageBad.close();

    // --- file:// origin (double-clicking the .html instead of serving it) ---
    // The single most likely setup mistake: the map looks fine because
    // boundaries are https:// requests, but local data can never load.
    const pageFile = await browser.newPage();
    await pageFile.route("**://tile.openstreetmap.org/**", (route) =>
      route.fulfill({ contentType: "image/png", body: BLANK_PNG })
    );
    await pageFile.route("**://tigerweb.geo.census.gov/**", (route) => {
      const url = route.request().url();
      if (url.includes("/10/query")) return route.fulfill(json(esriFC([BG_A])));
      return route.fulfill(json({ layers: [{ id: 10, name: "Census Block Groups", geometryType: "esriGeometryPolygon" }] }));
    });
    await pageFile.goto(`file://${path.join(REPO, "blockgroups.html")}`, { waitUntil: "load" });
    await pageFile.waitForSelector("#toggle-bg");
    const bannerVisible = await pageFile.locator("#file-protocol-warning").isVisible();
    const bannerText = bannerVisible ? await pageFile.locator("#file-protocol-warning").innerText() : "";
    step(
      "file:// origin shows an upfront banner explaining why data can't load",
      bannerVisible && /http\.server/.test(bannerText) && /localhost:8000/.test(bannerText),
      bannerText.replace(/\s+/g, " ").slice(0, 200)
    );
    await pageFile.close();
  } finally {
    fs.rmSync(dataPath, { force: true });
  }

  const failed = steps.filter((s) => !s.ok);
  console.log(`\n${steps.length - failed.length}/${steps.length} checks passed.`);
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
