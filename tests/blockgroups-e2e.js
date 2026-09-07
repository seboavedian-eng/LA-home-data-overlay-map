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
// Third block group exists so filters have something to discriminate:
// BG_C fails both filters that BG_A passes.
const BG_C = esriPolygon({ GEOID: "060372011003", NAME: "Block Group 3, Census Tract 2011" }, [
  [-118.22, 34.04], [-118.22, 34.06], [-118.20, 34.06], [-118.20, 34.04],
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
// Age brackets are keyed by B01001's own bracket index. These sum to 1000
// and are laid out so each display band has a distinct, exact percentage:
//   0-24  -> brackets 3-10   = 500 (50.0%)
//   25-34 -> brackets 11,12  = 150 (15.0%)
//   35-44 -> brackets 13,14  = 100 (10.0%)
//   45-54 -> brackets 15,16  =  90  (9.0%)
//   55-64 -> brackets 17-19  =  80  (8.0%)
//   65+   -> brackets 20-25  =  80  (8.0%)
const AGE_BRACKETS = {
  "3": 100, "4": 100, "5": 100, "6": 60, "7": 50, "8": 40, "9": 30, "10": 20,
  "11": 80, "12": 70,
  "13": 55, "14": 45,
  "15": 50, "16": 40,
  "17": 30, "18": 25, "19": 25,
  "20": 20, "21": 15, "22": 15, "23": 10, "24": 10, "25": 10,
};

const CENSUS_DATA = {
  meta: {
    schemaVersion: 2,
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
      ageBrackets: AGE_BRACKETS,
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
    // Fails both default filters: 10% bachelor's (not >50) and 5% Asian
    // (not >30). Used to prove filtering discriminates rather than
    // highlighting everything.
    "060372011003": {
      totalPopulation: 500,
      ageBrackets: AGE_BRACKETS,
      female: 250,
      male: 250,
      ethnicityAcsTotal: 500,
      ethnicityAcs: {
        "Hispanic or Latino": 400,
        "White (non-Hispanic)": 50,
        "Asian (non-Hispanic)": 25,
        "Black (non-Hispanic)": 25,
      },
      ethnicityDecTotal: 500,
      ethnicityDec: {
        "Hispanic or Latino": 400,
        "White (non-Hispanic)": 50,
        "Asian (non-Hispanic)": 25,
        "Black (non-Hispanic)": 25,
      },
      eduTotal25plus: 400,
      eduBachelorsPlus: 40,
      medianHouseholdIncome: 42000,
      perCapitaIncome: 21000,
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
      return route.fulfill(json(esriFC([BG_A, BG_B, BG_C])));
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
      "popup shows six age bands: 0-24 then 10-year steps to 65+",
      ["0 to 24", "25 to 34", "35 to 44", "45 to 54", "55 to 64", "65 and over"].every((b) =>
        popupText.includes(b)
      ),
      popupText.replace(/\s+/g, " ").slice(0, 300)
    );
    step(
      "age band percentages are computed from the raw brackets (50/15/10/9/8/8)",
      ["50.0%", "15.0%", "10.0%", "9.0%", "8.0%"].every((p) => popupText.includes(p)),
      popupText.replace(/\s+/g, " ").slice(0, 300)
    );
    step("'Population 25+' row is gone", !popupText.includes("Population 25+"));
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

    // --- ZIP code on the card (resolved spatially from the ZCTA layer) ---
    await page.waitForFunction(
      () => document.getElementById("detail-panel").innerText.includes("ZIP"),
      { timeout: 10000 }
    );
    const zipText = await page.locator("#detail-panel").innerText();
    step("card shows the ZIP code for the block group", /ZIP\s*90012/.test(zipText), zipText.slice(0, 120));

    // --- Card must not vanish on pan (the auto-pan refetch bug) ---
    await page.evaluate(() => {
      const m = BlockGroupApp.state.layers.blockGroup._map;
      m.panBy([40, 40]); // small pan, inside the padded loaded area
    });
    await page.waitForTimeout(1500);
    const afterPanPopup = await page.locator(".leaflet-popup-content").count();
    const afterPanPanel = await page.locator("#detail-panel").innerText();
    step(
      "card survives a small pan instead of disappearing",
      afterPanPopup > 0 && afterPanPanel.includes("Tract 2011"),
      `popups=${afterPanPopup}`
    );

    // --- Filters ---
    // Filter 1 defaults to bachelor's > 50%: BG_A (30%) fails, BG_C (10%) fails.
    // Set it to >20% so exactly one of the two data-bearing block groups matches.
    await page.selectOption("#filter-metric-0", "bachelors");
    await page.fill("#filter-value-0", "20");
    await page.check("#filter-on-0");
    await page.waitForTimeout(400);
    const oneFilter = await page.locator("#filter-summary").innerText();
    step(
      "one filter highlights only matching block groups",
      /1 of 3/.test(oneFilter) && /above 20/.test(oneFilter),
      oneFilter
    );

    const matchStyles = await page.evaluate(() => {
      const out = {};
      BlockGroupApp.state.layers.blockGroup.eachLayer((l) => {
        out[l.feature.properties.GEOID] = l.options.fillColor;
      });
      return out;
    });
    step(
      "matching block group is styled differently from non-matching",
      matchStyles["060372011001"] !== matchStyles["060372011003"],
      JSON.stringify(matchStyles)
    );

    // Layer a second filter on top: Asian > 15% (BG_A is 20%, BG_C is 5%).
    await page.selectOption("#filter-metric-1", "eth:Asian (non-Hispanic)");
    await page.fill("#filter-value-1", "15");
    await page.check("#filter-on-1");
    await page.waitForTimeout(400);
    const twoFilters = await page.locator("#filter-summary").innerText();
    step(
      "two filters combine with AND",
      /1 of 3/.test(twoFilters) && /AND/.test(twoFilters),
      twoFilters
    );

    // Tighten filter 2 so nothing satisfies both - proves it's really ANDing.
    await page.fill("#filter-value-1", "80");
    await page.waitForTimeout(400);
    const noMatch = await page.locator("#filter-summary").innerText();
    step("AND is real: an unsatisfiable second filter drops the count to zero", /0 of 3/.test(noMatch), noMatch);

    await page.click("#filter-clear");
    await page.waitForTimeout(300);
    const cleared = await page.locator("#filter-summary").innerText();
    step("clearing filters restores the normal view", /Off/i.test(cleared), cleared);

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
