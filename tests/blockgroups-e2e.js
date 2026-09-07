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

// Deliberately: ancestryTotal (1000) differs from totalPopulation (1200), so
// the test can prove percentages use "people reporting ancestry" as the
// denominator (400/1000 = 40.0%) and not total population (400/1200 = 33.3%).
// Six ancestries are present so the 6th (Greek) must be excluded from top 5.
const CENSUS_DATA = {
  meta: {
    year: 2022,
    dataset: "acs/acs5",
    ancestryLabels: {
      B04006_050E: "Mexican",
      B04006_030E: "German",
      B04006_038E: "Irish",
      B04006_020E: "Chinese",
      B04006_025E: "Filipino",
      B04006_031E: "Greek",
    },
  },
  blockGroups: {
    "060372011001": {
      ancestryTotal: 1000,
      ancestries: {
        B04006_050E: 400,
        B04006_030E: 200,
        B04006_038E: 150,
        B04006_020E: 100,
        B04006_025E: 80,
        B04006_031E: 30,
      },
      totalPopulation: 1200,
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
  await page.route("**://*.basemaps.cartocdn.com/**", (route) =>
    route.fulfill({ contentType: "image/png", body: BLANK_PNG })
  );

  let tigerQueryCount = { zip: 0, tract: 0, bg: 0 };
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
    // Layer discovery (?f=json on the MapServer root)
    return route.fulfill(
      json({
        layers: [
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

    step("popup shows top 5 ancestries, highest first", (() => {
      const order = ["Mexican", "German", "Irish", "Chinese", "Filipino"];
      let lastIdx = -1;
      for (const name of order) {
        const idx = popupText.indexOf(name);
        if (idx === -1 || idx < lastIdx) return false;
        lastIdx = idx;
      }
      return true;
    })(), popupText.replace(/\s+/g, " ").slice(0, 200));

    step("6th ancestry (Greek) is excluded from the top 5", !popupText.includes("Greek"));

    step(
      "percentages use people-reporting-ancestry as denominator (40.0%, not 33.3%)",
      popupText.includes("40.0%") && popupText.includes("20.0%") && !popupText.includes("33.3%"),
      popupText.replace(/\s+/g, " ").slice(0, 300)
    );

    step("popup shows median household income", popupText.includes("$85,000"));
    step("popup shows per-capita income", popupText.includes("$41,000"));
    step("popup shows total population separately from ancestry total", popupText.includes("1,200") && popupText.includes("1,000"));
    step("popup explains the denominator caveat", popupText.toLowerCase().includes("not of") || popupText.toLowerCase().includes("reporting an ancestry"));
    step("sidebar detail panel mirrors the popup", panelText.includes("Mexican") && panelText.includes("$85,000"));

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
