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
const BG_A = esriPolygon({ GEOID: "060372011001", NAME: "Block Group 1, Census Tract 2011", AREALAND: 5179976 }, [
  [-118.26, 34.04], [-118.26, 34.06], [-118.24, 34.06], [-118.24, 34.04],
]);
const BG_B = esriPolygon({ GEOID: "060372011002", NAME: "Block Group 2, Census Tract 2011" }, [
  [-118.24, 34.04], [-118.24, 34.06], [-118.22, 34.06], [-118.22, 34.04],
]);
// Third block group exists so filters have something to discriminate:
// BG_C fails both filters that BG_A passes.
const BG_C = esriPolygon({ GEOID: "060372011003", NAME: "Block Group 3, Census Tract 2011", AREALAND: 25900 }, [
  [-118.22, 34.04], [-118.22, 34.06], [-118.20, 34.06], [-118.20, 34.04],
]);
// Fire hazard zones covering the block groups: one Very High (SRA) and one
// Moderate (LRA), so the class colouring and the two-sublayer merge are both
// visible in one view. A third polygon is "Non-Wildland/Non-Urban" - real
// CAL FIRE data is full of those, and painting them grey blankets flat LA in
// a colour that means nothing.
const FIRE_VERY_HIGH = esriPolygon({ HAZ_CLASS: "Very High", OBJECTID: 1 }, [
  [-118.26, 34.04], [-118.26, 34.06], [-118.24, 34.06], [-118.24, 34.04],
]);
const FIRE_MODERATE = esriPolygon({ HAZ_CLASS: "Moderate", OBJECTID: 2 }, [
  [-118.24, 34.04], [-118.24, 34.06], [-118.22, 34.06], [-118.22, 34.04],
]);
const FIRE_NON_WILDLAND = esriPolygon({ HAZ_CLASS: "Non-Wildland/Non-Urban", OBJECTID: 3 }, [
  [-118.22, 34.04], [-118.22, 34.06], [-118.20, 34.06], [-118.20, 34.04],
]);
// The polygon from the bug report: it sits in the "SRA/LRA Awaiting Zoning"
// placeholder layer but still carries an old class value, so it was being
// drawn - and labelled - as a Very High zone.
const FIRE_AWAITING = esriPolygon({ HAZ_CLASS: "Very High", OBJECTID: 9 }, [
  [-118.40, 34.20], [-118.40, 34.30], [-118.30, 34.30], [-118.30, 34.20],
]);
// Stands in for the polygons that only arrive once a truncated query is
// split: the mock returns it solely for sub-boxes, never for the whole view.
const FIRE_SPLIT_ONLY = esriPolygon({ HAZ_CLASS: "High", OBJECTID: 4 }, [
  [-118.30, 34.00], [-118.30, 34.02], [-118.28, 34.02], [-118.28, 34.00],
]);

// CalEnviroScreen tract. Tract 06037201100 is the parent of every block group
// above (GEOID 0603720110 0 + block group digit), which is what lets the card
// inherit a tract-level score. Published as a NUMBER, missing the leading
// zero of state FIPS 06 - exactly how OEHHA's copy serves it.
const CES_TRACT = esriPolygon(
  {
    Tract: 6037201100,
    CIscoreP: 87.4,
    Ozone_Pctl: 91,
    Ozone: 0.056,
    PM2_5_Pctl: 78,
    PM2_5: 12.4,
    Diesel_PM_Pctl: 95,
    Diesel_PM: 30.1,
    Traffic_Pctl: 88,
    Traffic: 1900,
    TotPop19: 4200,
  },
  [[-118.26, 34.04], [-118.26, 34.06], [-118.20, 34.06], [-118.20, 34.04]]
);

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
      avgHouseholdSize: 3.4,
      householdCount: 400,
      incomeBrackets: { "< $10k": 40, "$50-60k": 120, "$100-125k": 200, "$200k+": 40 },
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
      // No avgHouseholdSize: stands in for a data file fetched before
      // B25010 was added, where the card has to derive the figure.
      householdCount: 200,
    },
  },
};

async function main() {
  const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO });
  await new Promise((r) => setTimeout(r, 800));

  const dataPath = path.join(REPO, "js", "data", "bg-la-county.json");
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  fs.writeFileSync(dataPath, JSON.stringify(CENSUS_DATA));

  // A 2x2 wind grid over the block groups: calm in the north-west, windy in
  // the south-east, so a wrong row/column order shows up as a wrong reading
  // rather than a plausible one.
  const windPath = path.join(REPO, "js", "data", "wind-la-county.json");
  fs.writeFileSync(
    windPath,
    JSON.stringify({
      meta: { height: "100 m", units: "m/s", source: "Global Wind Atlas 3 (test fixture)" },
      bbox: { west: -118.28, south: 34.02, east: -118.18, north: 34.08 },
      nrows: 2,
      ncols: 2,
      values: [2.0, 5.0, 6.5, 9.0],
    })
  );

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
  await page.route("**://services.arcgisonline.com/**", (route) =>
    route.fulfill({ contentType: "image/png", body: BLANK_PNG })
  );

  // OpenFreeMap's Positron style, reduced to the smallest valid MapLibre
  // style: one background layer, no sources, so nothing else is fetched.
  const MINIMAL_STYLE = {
    version: 8,
    name: "Positron (test stub)",
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": "#f7f8fa" } }],
  };
  let styleRequests = 0;
  await page.route("**://tiles.openfreemap.org/**", (route) => {
    styleRequests++;
    return route.fulfill(json(MINIMAL_STYLE));
  });

  // Nominatim now backs autocomplete. It matches partial input, which is the
  // whole reason it replaced the Census geocoder here.
  let nominatimQueries = [];
  let reverseQueries = [];
  await page.route("**://nominatim.openstreetmap.org/**", (route) => {
    const url = route.request().url();
    // Same host, two different services: /search returns an array of
    // candidates, /reverse returns one place object for a coordinate.
    if (url.includes("/reverse")) {
      reverseQueries.push(url);
      return route.fulfill(
        json({
          display_name: "410 W Temple St, Civic Center, Los Angeles, Los Angeles County, California, 90012, United States",
          address: {
            house_number: "410",
            road: "W Temple St",
            city: "Los Angeles",
            state: "California",
            postcode: "90012",
          },
        })
      );
    }
    nominatimQueries.push(url);
    return route.fulfill(
      json([
        { display_name: "200 N Spring St, Los Angeles, CA 90012, USA", lon: "-118.2437", lat: "34.0537" },
        { display_name: "200 S Spring St, Los Angeles, CA 90012, USA", lon: "-118.2450", lat: "34.0520" },
      ])
    );
  });

  // CAL FIRE Fire Hazard Severity Zones. The root lists a label sublayer
  // whose name also matches "hazard" - drawing it is what produced stray
  // unfilled lines on the old page, so the test asserts it is never queried.
  // LA County's own Hazards service is tried first. Its layers are named
  // UPPER_SNAKE_CASE, and it carries the "SRA/LRA Awaiting Zoning"
  // placeholder that was being painted as a real hazard zone.
  let countyFireQueries = [];
  await page.route("**://public.gis.lacounty.gov/**", (route) => {
    const url = route.request().url();
    if (url.includes("/query")) {
      countyFireQueries.push(url);
      const geom = decodeURIComponent(url.match(/geometry=([^&]*)/)[1]).split(",").map(Number);
      const isWholeView = geom[2] - geom[0] > 0.08;
      if (url.includes("/19/query")) {
        if (isWholeView) {
          return route.fulfill(json({ ...esriFC([FIRE_VERY_HIGH]), exceededTransferLimit: true }));
        }
        return route.fulfill(json(esriFC([FIRE_VERY_HIGH, FIRE_SPLIT_ONLY])));
      }
      if (url.includes("/20/query")) return route.fulfill(json(esriFC([FIRE_MODERATE, FIRE_NON_WILDLAND])));
      if (url.includes("/21/query")) return route.fulfill(json(esriFC([FIRE_AWAITING])));
      if (url.includes("/2/query")) {
        return route.fulfill(json({ error: { code: 400, message: "Cannot perform query on a group layer" } }));
      }
      return route.fulfill(json(esriFC([])));
    }
    return route.fulfill(
      json({
        layers: [
          { id: 2, name: "Fire Hazard Severity Zones", subLayerIds: [19, 20] },
          { id: 19, name: "FIRE_HAZARD_SEVERITY_ZONES_SRA", geometryType: "esriGeometryPolygon" },
          { id: 20, name: "FIRE_HAZARD_SEVERITY_ZONES_LRA", geometryType: "esriGeometryPolygon" },
          // The layer behind the bug report: a placeholder for ground not yet
          // re-zoned, whose name matches on "SRA" and whose polygons are huge.
          { id: 21, name: "SRA/LRA Awaiting Zoning", geometryType: "esriGeometryPolygon" },
          { id: 22, name: "FIRE_HAZARD_SEVERITY_ZONES_LABELS", geometryType: "esriGeometryPoint" },
        ],
      })
    );
  });

  let fireQueries = [];
  await page.route("**://services.gis.ca.gov/**", (route) => {
    const url = route.request().url();
    if (url.includes("/query")) {
      fireQueries.push(url);
      // The real service caps a query at 1,000 records and reports the
      // truncation in the body, with HTTP 200 - a silently partial answer.
      // Layer 0 does that for the full viewport and only serves everything
      // once the client has split the box into quarters.
      const geom = decodeURIComponent(url.match(/geometry=([^&]*)/)[1]).split(",").map(Number);
      const boxWidth = geom[2] - geom[0];
      const isWholeView = boxWidth > 0.08;
      if (url.includes("/0/query")) {
        if (isWholeView) {
          return route.fulfill(json({ ...esriFC([FIRE_VERY_HIGH]), exceededTransferLimit: true }));
        }
        return route.fulfill(json(esriFC([FIRE_VERY_HIGH, FIRE_SPLIT_ONLY])));
      }
      if (url.includes("/1/query")) return route.fulfill(json(esriFC([FIRE_MODERATE, FIRE_NON_WILDLAND])));
      // A group layer answers a query with an error object and HTTP 200.
      if (url.includes("/3/query")) {
        return route.fulfill(json({ error: { code: 400, message: "Cannot perform query on a group layer" } }));
      }
      return route.fulfill(json(esriFC([])));
    }
    return route.fulfill(
      json({
        layers: [
          { id: 0, name: "Fire Hazard Severity Zones in SRA", geometryType: "esriGeometryPolygon" },
          { id: 1, name: "Very High Fire Hazard Severity Zones in LRA", geometryType: "esriGeometryPolygon" },
          // Group layer: cannot be queried, and its children are listed
          // separately anyway.
          { id: 3, name: "Fire Hazard Severity Zones", subLayerIds: [0, 1] },
          { id: 7, name: "Fire Hazard Severity Zone Labels", geometryType: "esriGeometryPoint" },
        ],
      })
    );
  });

  // CalEnviroScreen 4.0, OEHHA's hosted copy.
  let cesQueries = [];
  await page.route("**://services1.arcgis.com/**", (route) => {
    cesQueries.push(route.request().url());
    return route.fulfill(json(esriFC([CES_TRACT])));
  });

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

    // --- Basemap: vector by default ---
    await page.waitForTimeout(600);
    step(
      "basemap is the OpenFreeMap vector style, not raster tiles",
      (await page.evaluate(() => BlockGroupApp.state.basemapKind)) === "vector" && styleRequests > 0,
      `${styleRequests} style request(s)`
    );
    // The Esri raster basemap this replaced stops publishing tiles at 16, so
    // "can we actually get to 20" is the point of the swap.
    const reachedZoom = await page.evaluate(() => {
      BlockGroupApp.state.map.setZoom(20);
      return BlockGroupApp.state.map.getZoom();
    });
    step("the map zooms to 20, well past the raster basemap's zoom 16 ceiling", reachedZoom === 20, `reached ${reachedZoom}`);
    await page.evaluate(() => BlockGroupApp.state.map.setView(BG_CONFIG.MAP_CENTER, BG_CONFIG.MAP_ZOOM));
    await page.waitForTimeout(200);
    const attribution = await page.locator(".leaflet-control-attribution").innerText();
    step(
      "attribution credits OpenFreeMap, OpenMapTiles and OpenStreetMap",
      /OpenFreeMap/.test(attribution) && /OpenMapTiles/.test(attribution) && /OpenStreetMap/.test(attribution),
      attribution
    );
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

    step("there are six filter slots", (await page.locator(".filter-row").count()) === 6);

    // Four filters at once, all ANDed. Set them so BG_A passes every one.
    await page.selectOption("#filter-metric-0", "bachelors");
    await page.fill("#filter-value-0", "20");
    await page.check("#filter-on-0");
    await page.selectOption("#filter-metric-1", "eth:Asian (non-Hispanic)");
    await page.fill("#filter-value-1", "15");
    await page.check("#filter-on-1");
    await page.selectOption("#filter-metric-2", "medianIncome");
    await page.fill("#filter-value-2", "60000");
    await page.check("#filter-on-2");
    await page.selectOption("#filter-metric-3", "age:25 to 34");
    await page.fill("#filter-value-3", "10");
    await page.check("#filter-on-3");
    await page.waitForTimeout(400);
    const fourFilters = await page.locator("#filter-summary").innerText();
    step(
      "all four filters AND together",
      /1 of 3/.test(fourFilters) && (fourFilters.match(/AND/g) || []).length === 3,
      fourFilters
    );
    await page.click("#filter-clear");
    await page.waitForTimeout(300);

    // --- Density shading ---
    // BG_A: 1000 people over 2 sq mi  ->    500/sq mi -> least dense -> deepest
    // BG_C:  500 people over 0.01 sq mi -> 50,000/sq mi -> densest  -> palest
    // Select BG_B first: the selected block group deliberately keeps its
    // highlight rather than being repainted by the density scale, so parking
    // the selection on the no-data polygon leaves both data-bearing ones
    // showing their true density colour.
    await page.evaluate(() => {
      BlockGroupApp.state.layers.blockGroup.eachLayer((l) => {
        if (l.feature.properties.GEOID === "060372011002") l.fire("click");
      });
    });
    await page.waitForTimeout(300);

    await page.check("#toggle-density");
    await page.waitForTimeout(500);
    const densityFills = await page.evaluate(() => {
      const out = {};
      BlockGroupApp.state.layers.blockGroup.eachLayer((l) => {
        out[l.feature.properties.GEOID] = l.options.fillColor;
      });
      return out;
    });
    step(
      "least dense block group gets the deepest green, densest gets the palest",
      densityFills["060372011003"] === "#e8f6ee" && densityFills["060372011001"] === "#1b4332",
      JSON.stringify(densityFills)
    );
    step(
      "density legend appears with five buckets",
      (await page.locator("#density-legend .legend-row").count()) === 5
    );

    // Back to BG_A (1000 people over 2 sq mi) to read its density on the card.
    await page.evaluate(() => {
      BlockGroupApp.state.layers.blockGroup.eachLayer((l) => {
        if (l.feature.properties.GEOID === "060372011001") l.fire("click");
      });
    });
    await page.waitForTimeout(300);
    const densityCard = await page.locator("#detail-panel").innerText();
    step(
      "card shows land area, density and the density band",
      /2\.00 sq mi/.test(densityCard) && /500 \/sq mi/.test(densityCard) && /Very low/i.test(densityCard),
      densityCard.replace(/\s+/g, " ").slice(0, 240)
    );

    const distLog = await page.locator("#status-log").innerText();
    step(
      "actual density percentiles are logged so the buckets can be tuned",
      /20th/.test(distLog) && /80th/.test(distLog),
      (distLog.match(/Density of[^\n]*/) || [""])[0]
    );

    await page.uncheck("#toggle-density");
    await page.waitForTimeout(300);
    step(
      "turning density off restores the plain style",
      (await page.evaluate(() => {
        let c = null;
        BlockGroupApp.state.layers.blockGroup.eachLayer((l) => {
          if (l.feature.properties.GEOID === "060372011003") c = l.options.fillColor;
        });
        return c;
      })) === "#1b4d8c"
    );

    // --- Ethnicity as bars, matching the age section ---
    const ethBars = await page.evaluate(() => {
      const panel = document.getElementById("detail-panel");
      const labels = [...panel.querySelectorAll(".bar-row .bar-label span")].map((s) => s.textContent);
      return labels.filter((t) => /Hispanic|White|Asian|Black/.test(t));
    });
    step(
      "ethnicity is rendered as bars, not a plain table",
      ethBars.length >= 4,
      JSON.stringify(ethBars.slice(0, 6))
    );

    // --- Autocomplete now uses a partial-matching service ---
    await page.fill("#address-input", "200 N Spring");
    await page.waitForFunction(
      () => !document.getElementById("address-suggestions").classList.contains("hidden"),
      { timeout: 10000 }
    );
    const suggestionCount = await page.locator("#address-suggestions li").count();
    step(
      "typing a PARTIAL address returns suggestions (the old geocoder returned none)",
      suggestionCount === 2,
      `${suggestionCount} suggestions from ${nominatimQueries.length} query/queries`
    );
    step(
      "suggestions come from the partial-matching service, not the exact-match geocoder",
      nominatimQueries.length > 0,
      nominatimQueries[0] || "none"
    );

    await page.click("#address-suggestions li:first-child");
    await page.waitForFunction(
      () => /Tract/.test(document.getElementById("search-status").textContent),
      { timeout: 15000 }
    );
    const searchStatus = await page.locator("#search-status").innerText();
    step(
      "picking a suggestion resolves it to a block group",
      /Tract 2011/.test(searchStatus) && /Block Group/.test(searchStatus),
      searchStatus
    );
    step(
      "a pin is dropped at the address",
      (await page.locator(".leaflet-marker-icon").count()) > 0
    );

    // --- Clear-pin button ---
    step("clear-pin button appears once a pin exists", await page.locator("#clear-pin").isVisible());
    await page.click("#clear-pin");
    await page.waitForTimeout(300);
    step(
      "clear-pin removes the pin and empties the box",
      (await page.locator(".leaflet-marker-icon").count()) === 0 &&
        (await page.inputValue("#address-input")) === "" &&
        !(await page.locator("#clear-pin").isVisible())
    );

    // --- Only one card on the map at a time ---
    await page.evaluate(() => {
      BlockGroupApp.state.layers.blockGroup.eachLayer((l) => {
        if (l.feature.properties.GEOID === "060372011001") l.fire("click");
      });
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      BlockGroupApp.state.layers.blockGroup.eachLayer((l) => {
        if (l.feature.properties.GEOID === "060372011003") l.fire("click");
      });
    });
    await page.waitForTimeout(400);
    step(
      "clicking another block group leaves exactly one card on the map",
      (await page.locator(".leaflet-popup").count()) === 1,
      `${await page.locator(".leaflet-popup").count()} popups`
    );

    // --- Income brackets (B19001 - fetched all along, now rendered) ---
    await page.evaluate(() => {
      BlockGroupApp.state.layers.blockGroup.eachLayer((l) => {
        if (l.feature.properties.GEOID === "060372011001") l.fire("click");
      });
    });
    await page.waitForTimeout(300);
    const incomeCard = await page.locator("#detail-panel").innerText();
    step(
      "card shows the B19001 household income brackets, not just the median",
      /Households by income bracket/i.test(incomeCard) &&
        incomeCard.includes("$100-125k") &&
        incomeCard.includes("50.0%"), // 200 of 400 households
      incomeCard.replace(/\s+/g, " ").slice(0, 260)
    );

    // --- Info icons ---
    const infoTitles = await page.locator("#detail-panel .info-icon").evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-tip"))
    );
    step(
      "bachelor's % carries an info icon explaining the 25+ universe",
      infoTitles.some((t) => /25 and over/i.test(t) && /not of total population/i.test(t)),
      JSON.stringify(infoTitles.map((t) => (t || "").slice(0, 50)))
    );

    // --- Density shade persists under filters ---
    // The whole point: a block group's colour belongs to the block group.
    // Turning a filter on must not repaint the survivors.
    await page.check("#toggle-density");
    await page.waitForTimeout(400);
    const shadeBefore = await page.evaluate(() => {
      let c = null;
      BlockGroupApp.state.layers.blockGroup.eachLayer((l) => {
        if (l.feature.properties.GEOID === "060372011003") c = l.options.fillColor;
      });
      return c;
    });
    await page.selectOption("#filter-metric-0", "bachelors");
    await page.fill("#filter-value-0", "5");
    await page.check("#filter-on-0");
    await page.waitForTimeout(400);
    const shadeAfter = await page.evaluate(() => {
      let c = null;
      BlockGroupApp.state.layers.blockGroup.eachLayer((l) => {
        if (l.feature.properties.GEOID === "060372011003") c = l.options.fillColor;
      });
      return c;
    });
    step(
      "a matching block group keeps its density shade when a filter is applied",
      shadeBefore === shadeAfter && shadeBefore === "#e8f6ee",
      `before=${shadeBefore} after=${shadeAfter}`
    );
    await page.click("#filter-clear");
    await page.uncheck("#toggle-density");
    await page.waitForTimeout(300);

    // --- Per-capita income is filterable ---
    const metricOptions = await page.locator("#filter-metric-0 option").evaluateAll((els) =>
      els.map((e) => e.value)
    );
    step(
      "average household size is available as a filter metric",
      (await page.evaluate(() =>
        [...document.querySelectorAll("#filter-metric-0 option")].map((o) => o.value)
      )).includes("householdSize")
    );
    step(
      "per-capita income is available as a filter metric",
      metricOptions.includes("perCapitaIncome"),
      JSON.stringify(metricOptions.slice(0, 6))
    );

    // --- Source descriptions ---
    const acsDesc = await page.locator('label[for="source-acs"]').innerText();
    const decDesc = await page.locator('label[for="source-dec"]').innerText();
    step(
      "ACS option explains it is a current but estimated sample",
      /estimat/i.test(acsDesc) && /margin of error/i.test(acsDesc) && acsDesc.length > 120,
      acsDesc.replace(/\s+/g, " ").slice(0, 120)
    );
    step(
      "2020 Census option explains it is exact but frozen at 2020",
      /100% count/i.test(decDesc) && /2020/.test(decDesc) && decDesc.length > 120,
      decDesc.replace(/\s+/g, " ").slice(0, 120)
    );

    // --- Card: household size, key figures, per-capita note ---
    await page.evaluate(() => {
      BlockGroupApp.state.layers.blockGroup.eachLayer((l) => {
        if (l.feature.properties.GEOID === "060372011001") l.fire("click");
      });
    });
    await page.waitForTimeout(300);
    const sizeCard = await page.locator("#detail-panel").innerText();
    step(
      "card shows the published average household size (ACS B25010)",
      /average household size/i.test(sizeCard) && sizeCard.includes("3.40 people") && !sizeCard.includes("(est.)"),
      sizeCard.replace(/\n/g, " ").slice(0, 150)
    );
    step(
      "per-capita income carries a visible note that it counts children",
      /children included/i.test(sizeCard),
      sizeCard.replace(/\n/g, " ").slice(-200)
    );
    const keyFigures = await page.evaluate(() =>
      [...document.querySelectorAll("#detail-panel .key-figure")].map((el) => el.textContent.trim())
    );
    step(
      "ZIP, household size, education %, median income and per-capita income are the highlighted figures",
      keyFigures.length === 5 &&
        keyFigures[0].startsWith("ZIP") &&
        keyFigures.includes("3.40 people") &&
        keyFigures.includes("30.0%") &&
        keyFigures.includes("$85,000") &&
        keyFigures.includes("$41,000"),
      JSON.stringify(keyFigures)
    );
    // Header order: ZIP first and loud, then the tract/block group name,
    // then the GEOID.
    const headerOrder = await page.evaluate(() =>
      [...document.querySelectorAll("#detail-panel .detail-card > *")]
        .slice(0, 3)
        .map((el) => `${el.tagName}:${el.className}`)
    );
    step(
      "the card leads with ZIP, then tract/block group, then GEOID",
      headerOrder[0] === "P:card-zip key-figure" && headerOrder[1] === "H3:" && headerOrder[2] === "P:geoid",
      JSON.stringify(headerOrder)
    );
    const sectionStyle = await page.evaluate(() => {
      const el = document.querySelector("#detail-panel .section-label");
      const cs = getComputedStyle(el);
      return { weight: cs.fontWeight, borderTop: cs.borderTopWidth, label: el.textContent.trim() };
    });
    step(
      "category headings are bold with a pale rule above",
      Number(sectionStyle.weight) >= 700 && sectionStyle.borderTop === "1px",
      JSON.stringify(sectionStyle)
    );
    const keyFigureStyle = await page.evaluate(() => {
      const el = document.querySelector("#detail-panel td.key-figure");
      const cs = getComputedStyle(el);
      return { color: cs.color, weight: cs.fontWeight };
    });
    step(
      "highlighted figures render bold and dark green",
      keyFigureStyle.color === "rgb(20, 102, 58)" && Number(keyFigureStyle.weight) >= 700,
      JSON.stringify(keyFigureStyle)
    );

    // A data file without B25010 must still show a household size, marked as
    // the estimate it is rather than passed off as the published figure.
    await page.evaluate(() => {
      BlockGroupApp.state.layers.blockGroup.eachLayer((l) => {
        if (l.feature.properties.GEOID === "060372011003") l.fire("click");
      });
    });
    await page.waitForTimeout(300);
    const derivedCard = await page.locator("#detail-panel").innerText();
    step(
      "an older data file falls back to population over households, labelled (est.)",
      derivedCard.includes("2.50 people (est.)"),
      derivedCard.replace(/\n/g, " ").slice(0, 140)
    );
    await page.evaluate(() => {
      BlockGroupApp.state.layers.blockGroup.eachLayer((l) => {
        if (l.feature.properties.GEOID === "060372011001") l.fire("click");
      });
    });
    await page.waitForTimeout(300);

    // --- Info icons actually explain something on hover ---
    step(
      "info icons carry their explanation as data, not a native title tooltip",
      (await page.evaluate(() => {
        const icon = document.querySelector("#detail-panel .info-icon");
        return { tip: !!icon.getAttribute("data-tip"), title: icon.hasAttribute("title") };
      })).tip === true
    );
    await page.hover("#detail-panel .info-icon");
    await page.waitForTimeout(200);
    const tipText = await page.locator("#info-tip").innerText();
    step(
      "hovering an info icon shows the explanation",
      (await page.locator("#info-tip").isVisible()) && tipText.length > 20,
      tipText.slice(0, 80)
    );
    step(
      "the tooltip is attached to <body>, so the scrolling card cannot clip it",
      await page.evaluate(() => document.getElementById("info-tip").parentElement === document.body)
    );
    await page.mouse.move(5, 5);
    await page.waitForTimeout(200);
    step("the tooltip goes away when the pointer leaves", !(await page.locator("#info-tip").isVisible()));

    // --- The card is a map popup, so a layer reload cannot destroy it ---
    // This is what made it flicker: the old card was bound to a polygon, and
    // every refetch threw that polygon away and rebuilt the popup.
    const popupBefore = await page.evaluate(() => {
      const el = document.querySelector(".leaflet-popup");
      window.__cardEl = el;
      return !!el;
    });
    await page.evaluate(() => BlockGroupApp.refreshForTest("blockGroup"));
    await page.waitForTimeout(700);
    step(
      "the card survives a full block group layer reload as the same DOM node",
      popupBefore &&
        (await page.evaluate(() => window.__cardEl === document.querySelector(".leaflet-popup"))) &&
        (await page.locator(".leaflet-popup").count()) === 1,
      `${await page.locator(".leaflet-popup").count()} popup(s)`
    );
    step(
      "the highlight is re-attached to the rebuilt polygon",
      await page.evaluate(() => {
        const sel = BlockGroupApp.state.selectedProps;
        let styled = false;
        BlockGroupApp.state.layers.blockGroup.eachLayer((l) => {
          if (l.feature.properties.GEOID === sel.GEOID && l.options.color === "#b3401f") styled = true;
        });
        return styled;
      })
    );

    // --- Fire hazard zones (CAL FIRE FHSZ) ---
    await page.click("#toggle-fire");
    await page.waitForTimeout(700);
    const fireColors = await page.evaluate(() => {
      const out = [];
      BlockGroupApp.state.layers.fire.eachLayer((l) => out.push(l.options.fillColor));
      return out.sort();
    });
    step("fire layer draws hazard polygons", fireColors.length === 3, JSON.stringify(fireColors));
    step(
      "hazard class drives the colour: Very High is red, Moderate is pale",
      fireColors.includes("#d7301f") && fireColors.includes("#fdcc8a"),
      JSON.stringify(fireColors)
    );
    step(
      "LA County's own hazard service is preferred over the statewide one",
      countyFireQueries.length > 0 && fireQueries.length === 0,
      `${countyFireQueries.length} county queries, ${fireQueries.length} state queries`
    );
    step(
      "both responsibility-area sublayers are queried and merged",
      countyFireQueries.some((u) => u.includes("/19/query")) && countyFireQueries.some((u) => u.includes("/20/query")),
      `${countyFireQueries.length} queries`
    );
    step(
      "UPPER_SNAKE_CASE county layer names still match the pattern",
      countyFireQueries.some((u) => u.includes("/19/query")),
      JSON.stringify(countyFireQueries.map((u) => u.match(/\/(\d+)\/query/)[1]))
    );
    step(
      "the label sublayer is never queried (the stray-lines bug)",
      !countyFireQueries.some((u) => u.includes("/22/query")),
      JSON.stringify(countyFireQueries.map((u) => u.match(/\/(\d+)\/query/)[1]))
    );
    // The bug report: an "SRA/LRA Awaiting Zoning" polygon drawn - and
    // labelled - as a Very High zone. It matches on "SRA", it is huge, and it
    // is not a hazard zone at all.
    step(
      "the 'Awaiting Zoning' placeholder layer is never queried",
      !countyFireQueries.some((u) => u.includes("/21/query")),
      JSON.stringify(countyFireQueries.map((u) => u.match(/\/(\d+)\/query/)[1]))
    );
    step(
      "geometry is generalised server-side rather than pulled at full resolution",
      countyFireQueries.every((u) => u.includes("maxAllowableOffset")),
      countyFireQueries[0]
    );
    step(
      "the un-queryable group layer is never asked for features",
      !countyFireQueries.some((u) => u.includes("/2/query"))
    );

    // The record cap is the real-world failure: CAL FIRE's service returns at
    // most 1,000 polygons and says so in the body, with HTTP 200. Before the
    // split, that partial answer was drawn as if it were the whole layer.
    step(
      "a truncated response is split into smaller boxes rather than drawn as-is",
      countyFireQueries.filter((u) => u.includes("/19/query")).length === 5,
      `${countyFireQueries.filter((u) => u.includes("/19/query")).length} queries on the SRA layer (1 whole view + 4 quadrants)`
    );
    const fireClasses = await page.evaluate(() => {
      const out = [];
      BlockGroupApp.state.layers.fire.eachLayer((l) => out.push(l.feature.properties.HAZ_CLASS));
      return out.sort();
    });
    step(
      "polygons that only the split reveals do make it onto the map",
      fireClasses.includes("High"),
      JSON.stringify(fireClasses)
    );
    step(
      "polygons returned by two overlapping sub-boxes are not drawn twice",
      fireClasses.filter((c) => c === "Very High").length === 1,
      JSON.stringify(fireClasses)
    );
    step(
      "non-wildland / unzoned ground is dropped instead of painted grey over the city",
      !fireClasses.includes("Non-Wildland/Non-Urban"),
      JSON.stringify(fireClasses)
    );
    const fireLog = await page.locator("#status-log").innerText();
    step(
      "the status log reports what the hazard field actually said",
      /Fire hazard classes/i.test(fireLog) && /very high/i.test(fireLog),
      (fireLog.split("\n").find((l) => /Fire hazard classes/i.test(l)) || "").slice(0, 140)
    );
    step(
      "the status log says the box had to be split to beat the record cap",
      /record cap/i.test(fireLog),
      (fireLog.split("\n").find((l) => /record cap/i.test(l)) || "").slice(0, 140)
    );
    const fireLegend = await page.locator("#fire-legend").innerText();
    step(
      "fire legend lists the three classes and warns blank is not 'no hazard'",
      /Very high/i.test(fireLegend) && /Moderate/i.test(fireLegend) && /not the same as/i.test(fireLegend),
      fireLegend.replace(/\n/g, " | ")
    );

    // --- Pollution (CalEnviroScreen 4.0) ---
    await page.click("#toggle-pollution");
    await page.waitForTimeout(700);
    const cesFill = await page.evaluate(() => {
      let color = null;
      BlockGroupApp.state.layers.pollution.eachLayer((l) => (color = l.options.fillColor));
      return color;
    });
    step("pollution layer shades tracts by CES percentile (87th = most burdened band)", cesFill === "#b35806", String(cesFill));
    step(
      "a tract published as a number still keys on the 11-digit GEOID",
      Object.keys(await page.evaluate(() => BlockGroupApp.state.cesByTract)).includes("06037201100"),
      JSON.stringify(Object.keys(await page.evaluate(() => BlockGroupApp.state.cesByTract)))
    );

    // Re-select a block group: its card should now inherit the parent tract's score.
    await page.evaluate(() => {
      BlockGroupApp.state.layers.blockGroup.eachLayer((l) => {
        if (l.feature.properties.GEOID === "060372011001") l.fire("click");
      });
    });
    await page.waitForTimeout(400);
    // Section labels are uppercased by CSS, so match case-insensitively:
    // innerText reports what the user actually sees.
    const cesCard = await page.locator("#detail-panel").innerText();
    step(
      "block group card inherits its parent tract's CalEnviroScreen score",
      /pollution burden/i.test(cesCard) && cesCard.includes("87.4th pct"),
      cesCard.replace(/\n/g, " ").slice(-160)
    );
    const pollutionLegend = await page.locator("#pollution-legend").innerText();
    step("pollution legend spans the five percentile bands", pollutionLegend.split("\n").filter(Boolean).length === 5, pollutionLegend.replace(/\n/g, " | "));

    // --- Wind (Global Wind Atlas grid) ---
    await page.click("#toggle-wind");
    await page.waitForTimeout(600);
    step(
      "wind grid loads from the local snapshot",
      await page.evaluate(() => !!BlockGroupApp.state.windGrid),
      JSON.stringify(await page.evaluate(() => BlockGroupApp.state.windGrid && BlockGroupApp.state.windGrid.meta))
    );
    step(
      "wind draws as an image overlay covering the grid's bbox",
      (await page.locator("#map img.leaflet-image-layer").count()) === 1,
      `${await page.locator("#map img.leaflet-image-layer").count()} image layer(s)`
    );
    // The block group's centre sits in the grid's SOUTH-WEST cell (6.5 m/s).
    // The north-west cell holds 2.0, so a flipped row order would read 2.0
    // here and this check would catch it.
    const windCard = await page.locator("#detail-panel").innerText();
    step(
      "card reports the wind speed sampled at this block group, with rows the right way up",
      /mean wind speed/i.test(windCard) && windCard.includes("6.5 m/s"),
      windCard.replace(/\n/g, " ").slice(-120)
    );
    const windLegend = await page.locator("#wind-legend").innerText();
    step("wind legend spans five speed bands", windLegend.split("\n").filter(Boolean).length === 5, windLegend.replace(/\n/g, " | "));

    // --- Drop a pin ---
    const selectedBefore = await page.evaluate(() => BlockGroupApp.state.selectedProps.GEOID);
    await page.click("#drop-pin");
    step("the drop-pin button arms rather than acting immediately", await page.evaluate(() => BlockGroupApp.state.pinArmed));
    step(
      "armed mode is visible: the button changes and the map takes a crosshair",
      (await page.locator("#drop-pin.armed").count()) === 1 && (await page.locator("#map.pin-armed").count()) === 1
    );

    // Click straight onto a block group polygon. While armed, that must drop
    // a pin and NOT change the selected block group - the whole reason the
    // mode is armed rather than always-on.
    await page.evaluate(() => {
      const target = BlockGroupApp.state.layers.blockGroup.getLayers()[2];
      target.fire("click");
      BlockGroupApp.state.layers.blockGroup._map.fire("click", { latlng: L.latLng(34.055, -118.243) });
    });
    await page.waitForTimeout(600);
    step(
      "a click while armed drops a pin instead of selecting a block group",
      (await page.evaluate(() => BlockGroupApp.state.selectedProps.GEOID)) === selectedBefore,
      `still ${selectedBefore}`
    );
    step("the pin lands on the map", (await page.locator(".leaflet-marker-icon").count()) === 1);
    step("the mode disarms itself after one drop", !(await page.evaluate(() => BlockGroupApp.state.pinArmed)));
    step("the pin is reverse-geocoded", reverseQueries.length === 1, JSON.stringify(reverseQueries));
    const pinPopup = await page.locator(".leaflet-popup-content").allInnerTexts();
    step(
      "the pin popup shows the street address, not the full Nominatim chain",
      pinPopup.some((t) => t.includes("410 W Temple St, Los Angeles, California, 90012")) &&
        !pinPopup.some((t) => t.includes("United States")),
      JSON.stringify(pinPopup)
    );
    step(
      "the address box is filled in from the pin",
      (await page.inputValue("#address-input")).startsWith("410 W Temple St"),
      await page.inputValue("#address-input")
    );

    // Escape cancels an armed pin without dropping anything.
    await page.click("#drop-pin");
    await page.keyboard.press("Escape");
    step("Escape cancels armed mode", !(await page.evaluate(() => BlockGroupApp.state.pinArmed)));

    await page.click("#clear-pin");
    await page.waitForTimeout(200);
    step("clearing the pin also removes the dropped one", (await page.locator(".leaflet-marker-icon").count()) === 0);

    // Turn the environment layers back off so the teardown checks below see
    // the same map they were written against.
    await page.click("#toggle-fire");
    await page.click("#toggle-pollution");
    await page.click("#toggle-wind");
    await page.waitForTimeout(300);
    step(
      "turning the environment layers off removes them and their legends",
      (await page.locator("#map img.leaflet-image-layer").count()) === 0 &&
        !(await page.locator("#fire-legend").isVisible()) &&
        !(await page.locator("#pollution-legend").isVisible())
    );

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

    // --- Basemap fallback when OpenFreeMap is unreachable ---
    // OpenFreeMap is donation-funded and single-maintainer, so "it is down"
    // is a real scenario, and it fails asynchronously - long after addTo()
    // returned - which is the part that is easy to get wrong.
    const pageNoVector = await browser.newPage();
    await pageNoVector.route("**://tiles.openfreemap.org/**", (route) =>
      route.fulfill({ status: 503, contentType: "text/plain", body: "down" })
    );
    await pageNoVector.route("**://services.arcgisonline.com/**", (route) =>
      route.fulfill({ contentType: "image/png", body: BLANK_PNG })
    );
    await pageNoVector.goto(`http://localhost:${PORT}/blockgroups.html`, { waitUntil: "load" });
    await pageNoVector
      .waitForFunction(() => BlockGroupApp.state.basemapKind === "raster", { timeout: 8000 })
      .catch(() => {});
    step(
      "an unreachable OpenFreeMap falls back to the raster basemap",
      (await pageNoVector.evaluate(() => BlockGroupApp.state.basemapKind)) === "raster",
      String(await pageNoVector.evaluate(() => BlockGroupApp.state.basemapKind))
    );
    const fallbackLog = await pageNoVector.locator("#status-log").innerText();
    step(
      "the fallback says why, and warns the raster basemap stops at zoom 16",
      /raster basemap/i.test(fallbackLog) && fallbackLog.includes("zoom 16"),
      fallbackLog.replace(/\n/g, " | ").slice(0, 180)
    );
    step(
      "the fallback raster upscales past its last real tile instead of going blank",
      await pageNoVector.evaluate(() => {
        let found = null;
        BlockGroupApp.state.map.eachLayer((l) => {
          if (l.options && l.options.maxNativeZoom) found = l.options.maxNativeZoom;
        });
        return found === 16;
      })
    );
    await pageNoVector.close();

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
    fs.rmSync(windPath, { force: true });
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
