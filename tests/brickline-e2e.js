// Browser test for the Brickline pilot page (brickline.html).
//
// Same rules as the explorer's suite: real Chromium, real mouse clicks, every
// network call stubbed. Green means the page's own logic is right; it says
// nothing about whether the live county, city and Census services answer.
//
//   node tests/brickline-e2e.js
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");

const REPO = path.join(__dirname, "..");
const PORT = 8951;
const BASE = `http://localhost:${PORT}`;

const json = (body) => ({ contentType: "application/json", body: JSON.stringify(body) });
const ring = (c) => [[...c, c[0]]];
const esriPolygon = (attributes, coords) => ({ attributes, geometry: { rings: ring(coords) } });
const esriFC = (features) => ({ geometryType: "esriGeometryPolygon", spatialReference: { wkid: 4326 }, features });
const box = (w, s, e, n) => [[w, s], [w, n], [e, n], [e, s]];

// --- Three block groups that a filter can tell apart ---------------------
// A: houses, degrees, high income.  B: apartments, middling.  C: far away.
const AGE = { "3": 100, "4": 100, "5": 100, "6": 60, "7": 50, "8": 40, "9": 30, "10": 20, "11": 80, "12": 70, "13": 55, "14": 45, "15": 50, "16": 40, "17": 30, "18": 20, "19": 10, "20": 15, "21": 10, "22": 10, "23": 5, "24": 5, "25": 5 };
function bg(over) {
  return {
    totalPopulation: 1000, ageBrackets: AGE, householdCount: 350, avgHouseholdSize: 2.9,
    eduTotal25plus: 700, eduBachelorsPlus: 210, medianHouseholdIncome: 80000, perCapitaIncome: 38000,
    incomeBrackets: { "< $10k": 10, "$50-60k": 100, "$100-125k": 140, "$200k+": 100 },
    structureTotal: 360, structureUnits: { "1, detached": 120, "1, attached": 20, "2": 20, "3 or 4": 40, "5 to 9": 60, "50 or more": 100 },
    tenureTotal: 350, ownerOccupied: 150, renterOccupied: 200, workersTotal: 450, workedFromHome: 50, transitToWork: 30, walkedToWork: 10,
    commuteWorkers: 400, commuteMedianMinutes: 31, commute45Plus: 80, pop16Plus: 800, civilianLaborForce: 500, unemployed: 30,
    families: 200, familiesWithChildren: 90, edu25to34Total: 150, edu25to34BachelorsPlus: 60, medianHomeValue: 900000,
    medianYearBuilt: 1952, yearBuiltTotal: 360, yearBuiltPre1980: 280,
    ethnicityAcsTotal: 1000, ethnicityAcs: { Hispanic: 400, White: 300, Asian: 200, Black: 100 },
    originTop: { Mexican: 30, Armenian: 15 }, originTopGeo: "tract",
    ...over,
  };
}
const GEO = { A: "060373020001", B: "060373020002", C: "060379100001" };
const CENSUS = {
  meta: { schemaVersion: 9, year: 2022 },
  blockGroups: {
    [GEO.A]: bg({ eduBachelorsPlus: 420, medianHouseholdIncome: 150000, structureUnits: { "1, detached": 300, "1, attached": 20, "2": 10, "3 or 4": 10, "5 to 9": 10, "50 or more": 10 } }),
    [GEO.B]: bg({}),
    [GEO.C]: bg({ eduBachelorsPlus: 70, medianHouseholdIncome: 52000 }),
  },
};
// Block group outlines. The house at 1745 Grandview sits inside A.
const BG_SHAPES = {
  [GEO.A]: { c: [34.165, -118.27], ring: box(-118.28, 34.16, -118.26, 34.17), aland: 2589988 },
  [GEO.B]: { c: [34.165, -118.25], ring: box(-118.26, 34.16, -118.24, 34.17), aland: 518000 },
  [GEO.C]: { c: [34.60, -118.15], ring: box(-118.16, 34.59, -118.14, 34.61), aland: 25899881 },
};
const PARCEL = esriPolygon({ AIN: "5634012003", SitusHouseNo: "1745", SitusStreet: "GRANDVIEW AVE", SitusFullAddress: "1745 GRANDVIEW AVE", SitusCity: "GLENDALE CA", SitusZIP: "91201" },
  box(-118.2705, 34.1650, -118.2700, 34.1653));
const NEIGHBOURS = [
  esriPolygon({ AIN: "5634012002" }, box(-118.2710, 34.1650, -118.2705, 34.1653)),
  esriPolygon({ AIN: "5634012004" }, box(-118.2700, 34.1650, -118.2695, 34.1653)),
  esriPolygon({ AIN: "5634012010" }, box(-118.2705, 34.1653, -118.2700, 34.1656)),
];
const HOUSE = esriPolygon({ OBJECTID: 1 }, box(-118.27035, 34.16505, -118.27015, 34.16518));

// A query's geometry: a point "x,y" or a box "xmin,ymin,xmax,ymax", always as a box.
function pointOf(url) {
  const m = decodeURIComponent(url).match(/geometry=([-\d.]+),([-\d.]+)(?:,([-\d.]+),([-\d.]+))?/);
  if (!m) return null;
  return m[3] ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : [Number(m[1]), Number(m[2]), Number(m[1]), Number(m[2])];
}
// Does a query box touch a ring's bounding box?
const inside = (p, r) => p && p[0] <= r[2][0] && p[2] >= r[0][0] && p[1] <= r[2][1] && p[3] >= r[0][1];

async function stub(page, captured) {
  // Anything not named below fails like a dead host, so the page's
  // degrade-don't-crash paths are exercised for free.
  await page.route(/^https?:\/\/(?!localhost)/, (route) => route.abort("failed"));
  const BLANK = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  // A valid but empty vector style: the basemap is not under test.
  await page.route("**://tiles.openfreemap.org/**", (r) => r.fulfill(json({ version: 8, sources: {}, layers: [] })));
  await page.route("**://services.arcgisonline.com/**", (r) => r.fulfill({ contentType: "image/png", body: BLANK }));
  await page.route("**://*.basemaps.cartocdn.com/**", (r) => r.fulfill({ contentType: "image/png", body: BLANK }));

  await page.route("**/js/data/bg-la-county.json", (r) => r.fulfill(json(CENSUS)));
  await page.route("**/js/data/parcels-la-county.json", (r) => r.fulfill(json({ meta: {}, blockGroups: {
    [GEO.A]: { medianSalePrice: 1450000, saleCount: 22, thin: false, years: { "2022": { median: 1300000 }, "2023": { median: 1400000 }, "2024": { median: 1500000 } } },
    [GEO.B]: { medianSalePrice: 980000, saleCount: 3, thin: true, years: {} },
  } })));
  await page.route("**/js/data/parcel-sales-la-county.json", (r) => r.fulfill(json({
    meta: { columns: ["address", "recorded", "sqft", "land", "improvement", "exemption", "assessed", "yearBuilt", "beds", "baths"] },
    byBlockGroup: { [GEO.A]: {
      "2023": [["1745 GRANDVIEW AVE, GLENDALE", "20230612", 1400, 800000, 400000, 7000, 1200000, 1938, 3, 2]],
      "2024": [["1801 GRANDVIEW AVE, GLENDALE", "20240301", 1700, 900000, 600000, 0, 1500000, 1941, 3, 2]],
    } },
  })));
  await page.route("**/js/data/schools-la-county.json", (r) => r.fulfill(json({
    meta: { schemaVersion: 99, rated: 2 },
    schools: {
      "1": { name: "Verdugo Woodlands Elementary", district: "Glendale Unified", levels: ["elementary"], ratings: { elementary: 9 }, lat: 34.166, lon: -118.268 },
      "2": { name: "Far Desert High", district: "Antelope Valley", levels: ["high"], ratings: { high: 4 }, lat: 34.60, lon: -118.15 },
    },
  })));
  await page.route("**/js/data/wind-la-county.json", (r) => r.fulfill(json({ bbox: { north: 34.3, south: 34.0, west: -118.4, east: -118.1 }, nrows: 2, ncols: 2, values: [3.2, 5.1, 6.4, 8.0], meta: { height: "100m" } })));
  // CalEnviroScreen tract (air quality), one polygon over the test area.
  await page.route("**://services1.arcgis.com/**", (r) => r.fulfill(json(esriFC([esriPolygon({ Tract: 6037302000, CIscoreP: 64.2 }, box(-118.30, 34.10, -118.20, 34.20))]))));
  // DOT noise: an empty folder listing, and one tile-cached aviation service.
  // BTS's folder lists one road noise service (cached tiles); aviation is on geo.dot.gov.
  const LODS = Array.from({ length: 13 }, (_, level) => ({ level, resolution: 156543.03 / 2 ** level, scale: 591657527.59 / 2 ** level }));
  await page.route("**://tiles.arcgis.com/**", (r) => {
    const u = r.request().url();
    if (/\/tile\//.test(u)) return r.fulfill({ contentType: "image/png", body: BLANK });
    if (/NTAD_Noise_2020_CONUS_road\/MapServer/.test(u)) return r.fulfill(json({ singleFusedMapCache: true, tileInfo: { lods: LODS } }));
    return r.fulfill(json({ services: [{ name: "NTAD_Noise_2020_CONUS_road", type: "MapServer" }] }));
  });
  await page.route("**://geo.dot.gov/**", (r) => {
    captured.noise++;
    if (/\/tile\//.test(r.request().url())) return r.fulfill({ contentType: "image/png", body: BLANK });
    if (/\/legend\?/.test(r.request().url())) return r.fulfill(json({ layers: [{ legend: [{ label: "45 - 50 dB", imageData: BLANK.toString("base64"), contentType: "image/png" }, { label: "50 - 55 dB", imageData: BLANK.toString("base64"), contentType: "image/png" }] }] }));
    return r.fulfill(json({ singleFusedMapCache: true, tileInfo: { lods: Array.from({ length: 13 }, (_, level) => ({ level, resolution: 156543.03 / 2 ** level, scale: 591657527.59 / 2 ** level })) } }));
  });
  await page.route("**/raw-data/redfin-listings/**", (r) => r.fulfill({ status: 404, body: "" }));
  await page.route("**/ors-api-key.txt", (r) => r.fulfill({ contentType: "text/plain", body: "test-key" }));
  await page.route("**/api/lead", (r) => {
    if (r.request().method() === "POST") captured.leads.push(JSON.parse(r.request().postData()));
    if (captured.leadDown) return r.fulfill({ status: 404, body: "" });
    return r.fulfill(json({ ok: true }));
  });

  // Geocoder: two places, the house and the office.
  await page.route("**://nominatim.openstreetmap.org/**", (r) => {
    const u = decodeURIComponent(r.request().url());
    captured.geocodes.push(u);
    if (/grandview/i.test(u)) return r.fulfill(json([{ display_name: "1745 Grandview Ave, Glendale, CA 91201, USA", lat: "34.16515", lon: "-118.27025", address: { house_number: "1745", road: "Grandview Avenue", city: "Glendale", postcode: "91201" } }]));
    return r.fulfill(json([{ display_name: "100 N Brand Blvd, Glendale, CA 91203, USA", lat: "34.147", lon: "-118.255" }]));
  });
  // Routing: the commute area covers A and B, not C; one drive takes 23 min.
  await page.route("**://api.openrouteservice.org/**", (r) => {
    const u = r.request().url();
    captured.ors.push(u);
    if (/isochrones/.test(u)) return r.fulfill(json({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: ring(box(-118.30, 34.10, -118.22, 34.20)) } }] }));
    return r.fulfill(json({ features: [{ properties: { summary: { duration: 1380, distance: 14000 } } }] }));
  });

  // Census TIGERweb: the list of every block group centre, and outlines.
  await page.route("**://tigerweb.geo.census.gov/**", (r) => {
    const u = decodeURIComponent(r.request().url());
    if (!u.includes("/query")) return r.fulfill(json({ layers: [{ id: 10, name: "Census Block Groups", geometryType: "esriGeometryPolygon" }, { id: 2, name: "2020 Census ZIP Code Tabulation Areas", geometryType: "esriGeometryPolygon" }, { id: 8, name: "Census Tracts", geometryType: "esriGeometryPolygon" }] }));
    if (/\/2\/query/.test(u)) {
      if (/BASENAME=/.test(u)) return r.fulfill(json({ error: { code: 400, message: "Failed to execute query." } }));
      if (/ZCTA5='91201'/.test(u)) return r.fulfill(json(esriFC([esriPolygon({ ZCTA5: "91201" }, box(-118.28, 34.16, -118.261, 34.17))])));
      return r.fulfill(json(esriFC([])));
    }
    if (/returnGeometry=false/.test(u)) {
      captured.index++;
      return r.fulfill(json({ features: Object.entries(BG_SHAPES).map(([g, s]) => ({ attributes: { GEOID: g, AREALAND: s.aland, INTPTLAT: String(s.c[0]), INTPTLON: String(s.c[1]) } })) }));
    }
    const p = pointOf(u);
    // A point (one block group) or a map tile (every one it touches). A
    // point on a shared edge goes to the first, as a server would pick one.
    const hits = Object.entries(BG_SHAPES).filter(([, s]) => inside(p, s.ring));
    const one = p && p[0] === p[2] && p[1] === p[3];
    return r.fulfill(json(esriFC((one ? hits.slice(0, 1) : hits).map(([g, s]) => esriPolygon({ GEOID: g }, s.ring)))));
  });

  // LA County: city boundaries (Glendale), parcels, the rest empty.
  await page.route("**://public.gis.lacounty.gov/**", (r) => {
    const u = decodeURIComponent(r.request().url());
    if (/Political_Boundaries/.test(u) && /\/23\/query/.test(u)) {
      if (/returnGeometry=false/.test(u)) return r.fulfill(json({ features: ["Los Angeles - Silver Lake", "City of Beverly Hills", "Unincorporated - Altadena"].map((LABEL) => ({ attributes: { LABEL } })) }));
      if (/Silver[+ ]Lake/.test(u)) return r.fulfill(json(esriFC([esriPolygon({ LABEL: "Los Angeles - Silver Lake" }, box(-118.285, 34.155, -118.235, 34.175))])));
      if (/Beverly[+ ]Hills/.test(u)) return r.fulfill(json(esriFC([esriPolygon({ LABEL: "City of Beverly Hills" }, box(-118.43, 34.06, -118.38, 34.10))])));
      return r.fulfill(json(esriFC([])));
    }
    if (/Political_Boundaries/.test(u)) {
      if (u.includes("/query")) return r.fulfill(json(esriFC([esriPolygon({ CITY_NAME: "Glendale" }, box(-118.30, 34.10, -118.20, 34.25))])));
      return r.fulfill(json({ layers: [{ id: 0, name: "City Boundaries", geometryType: "esriGeometryPolygon" }, { id: 23, name: "Countywide Statistical Areas (CSA)", geometryType: "esriGeometryPolygon" }] }));
    }
    if (/Parcel\//.test(u)) {
      if (u.includes("/query")) {
        captured.parcel.push(u);
        if (u.includes("esriGeometryEnvelope")) return r.fulfill(json(esriFC([PARCEL, ...NEIGHBOURS])));
        return r.fulfill(json(esriFC([PARCEL])));
      }
      if (/MapServer\/0\?/.test(u)) return r.fulfill(json({ id: 0, name: "Parcels", geometryType: "esriGeometryPolygon", fields: ["AIN", "SitusHouseNo", "SitusStreet", "SitusFullAddress", "SitusCity", "SitusZIP"].map((name) => ({ name, type: "esriFieldTypeString" })) }));
      return r.fulfill(json({ layers: [{ id: 0, name: "Parcels", geometryType: "esriGeometryPolygon" }] }));
    }
    if (u.includes("/query")) {
      // County fire layer: a Very High zone over block group C only.
      if (/\/19\/query/.test(u) && inside(pointOf(u), BG_SHAPES[GEO.C].ring)) return r.fulfill(json(esriFC([esriPolygon({ HAZ_CLASS: "Very High" }, BG_SHAPES[GEO.C].ring)])));
      return r.fulfill(json(esriFC([])));
    }
    return r.fulfill(json({ layers: [{ id: 19, name: "FIRE_HAZARD_SEVERITY_ZONES_SRA", geometryType: "esriGeometryPolygon" }] }));
  });
  // LA County building outlines.
  await page.route("**://rpgis.isd.lacounty.gov/**", (r) => {
    const u = r.request().url();
    if (u.includes("/query")) return r.fulfill(json(esriFC([HOUSE])));
    return r.fulfill(json({ layers: [{ id: 434, name: "Building Outline (2023)", geometryType: "esriGeometryPolygon" }] }));
  });
  // Glendale zoning (R1 by its own legend) and historic parcels (none here).
  const glendale = (r) => {
    const u = r.request().url();
    if (u.includes("/query")) {
      if (/Zoning\/FeatureServer\/2\//.test(u)) return r.fulfill(json(esriFC([esriPolygon({ OBJECTID: 1, ZON_CD: 100 }, box(-118.30, 34.10, -118.20, 34.25))])));
      return r.fulfill(json(esriFC([])));
    }
    if (/Zoning\/FeatureServer\/2\?/.test(u)) {
      return r.fulfill(json({ id: 2, name: "Zoning", geometryType: "esriGeometryPolygon", fields: [{ name: "OBJECTID", type: "esriFieldTypeOID" }, { name: "ZON_CD", type: "esriFieldTypeInteger" }],
        drawingInfo: { renderer: { type: "uniqueValue", field1: "ZON_CD", uniqueValueInfos: [{ value: "100", label: "R1 Low Density Residential", symbol: { type: "esriSFS", color: [250, 230, 150, 255] } }] } } }));
    }
    if (/HistoricParcels/.test(u)) return r.fulfill(json({ id: 0, name: "Historic Parcels", geometryType: "esriGeometryPolygon", layers: [{ id: 0, name: "Historic Parcels", geometryType: "esriGeometryPolygon" }] }));
    return r.fulfill(json({ layers: [{ id: 0, name: "Glendale_Boundary", geometryType: "esriGeometryPolygon" }, { id: 2, name: "Zoning", geometryType: "esriGeometryPolygon" }] }));
  };
  await page.route("**://gisapps.glendaleca.gov/**", glendale);
  await page.route("**://gismap.glendaleca.gov/**", glendale);
}

async function main() {
  const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
  const kill = () => { try { server.kill(); } catch (e) { /* gone */ } };
  process.on("exit", kill);
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/brickline.html`)).ok) break; } catch (e) { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }

  const browser = await chromium.launch();
  const results = [];
  const step = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

  async function open(url, opts = {}) {
    const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1400, height: 950 } });
    const page = await ctx.newPage();
    const captured = { leads: [], geocodes: [], ors: [], parcel: [], index: 0, noise: 0, errors: [], leadDown: !!opts.leadDown };
    page.on("pageerror", (e) => captured.errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_FAILED/.test(m.text())) captured.errors.push(m.text()); });
    await stub(page, captured);
    await page.goto(BASE + url);
    return { page, captured, ctx };
  }
  // SHOTS=dir saves a screenshot at each journey stage, for eyeballing the layout.
  const shot = (page, name) => (process.env.SHOTS ? page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }) : null);
  const waitFor = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);

  // ---------------------------------------------------------------- Landing
  const { page, captured } = await open("/brickline.html");
  step("landing offers 'I have a place in mind'", /I have a place in mind/.test(await page.innerText("#view-home")));
  step("landing shows both journeys", (await page.locator(".choice").count()) === 2 && (await page.isVisible("#view-home")));
  step("workspace is hidden on the landing", !(await page.isVisible("#workspace")));
  step("personal mode on localhost", await page.evaluate(() => Brickline.forTest.state.PERSONAL));

  await shot(page, "1-landing");
  // ----------------------------------------------------------- Journey two
  await page.click("text=Start the questions");
  step("the questions open with the map", await waitFor(page, () => !document.querySelector("#workspace").hidden && document.querySelector("#map").offsetHeight > 200));
  step("all three block groups load", await waitFor(page, () => Brickline.forTest.state.ready && Brickline.forTest.state.S && /of 3 areas/.test(((document.querySelector("#wcount") || document.querySelector(".ecount") || {}).innerText || ""))));
  step("block group centres come from TIGERweb", captured.index >= 1, `${captured.index} index request(s)`);
  step("the counter starts at 3 of 3", await waitFor(page, () => /3\s*of 3 areas/.test(((document.querySelector("#wcount") || document.querySelector(".ecount") || {}).innerText || ""))));

  await page.fill("#c-addr-0", "100 N Brand Blvd, Glendale");
  await page.click("form[data-geo='0'] button[type=submit]");
  step("the work address geocodes", await waitFor(page, () => /Brand/.test(document.querySelector("#c-found-0").textContent)));
  step("an isochrone is asked of OpenRouteService", await waitFor(page, () => true) && captured.ors.some((u) => /isochrones/.test(u)));
  step("the commute area drops the far block group", await waitFor(page, () => /2\s*of 3 areas/.test(((document.querySelector("#wcount") || document.querySelector(".ecount") || {}).innerText || ""))));
  step("the commute shows as an active filter pill", /min to work/.test(await page.innerText("#filterbar")));

  await page.click("#addC");
  step("a second commute can be added", (await page.locator(".commute").count()) === 2);
  await page.click("[data-rm='1']");
  step("...and removed", (await page.locator(".commute").count()) === 1);
  await page.fill("#c-addr-0", "");
  await page.type("#c-addr-0", "100 N Brand Blvd", { delay: 15 });
  step("the commute box suggests addresses as you type", await waitFor(page, () => [...document.querySelectorAll(".commute .suggest li")].some((li) => /Brand/.test(li.textContent) && /Address/.test(li.textContent))));
  await page.click(".commute .suggest li:has-text('Brand')");
  step("...and picking one sets the commute", await waitFor(page, () => /Brand/.test(document.querySelector("#c-found-0").textContent) && /2\s*of 3 areas/.test(((document.querySelector("#wcount") || document.querySelector(".ecount") || {}).innerText || ""))));

  await page.click("#next");
  step("question 2 is street busyness, in plain words", /busy/i.test(await page.innerText(".qhead h2")) && (await page.locator(".opt").count()) === 5);
  step("shops and cafés are marked coming soon", /coming soon/i.test(await page.innerText("#qpane")));
  await page.click(".opt[data-d='4']");
  step("picking 'City buzz' alone empties the map", await waitFor(page, () => /\b0\s*of 3 areas/.test(((document.querySelector("#wcount") || document.querySelector(".ecount") || {}).innerText || ""))));
  await page.click(".opt[data-d='4']");
  step("un-picking it brings the areas back", await waitFor(page, () => /2\s*of 3 areas/.test(((document.querySelector("#wcount") || document.querySelector(".ecount") || {}).innerText || ""))));

  await shot(page, "2-question");
  await page.click("#next"); // houses
  await page.click("#next"); // education
  step("education shows the LA County marker", /LA County ≈ \d+%/.test(await page.innerText("#qpane")));
  await page.$eval("#edu", (el) => { el.value = "40"; el.dispatchEvent(new Event("input")); });
  step("bachelor's 40%+ leaves one area", await waitFor(page, () => /1\s*of 3 areas/.test(((document.querySelector("#wcount") || document.querySelector(".ecount") || {}).innerText || ""))));

  await page.click("#next"); // income
  await page.click("#next"); // household
  await page.$eval("#hhMax", (el) => { el.value = "2"; el.dispatchEvent(new Event("input")); });
  await page.$eval("#hhMin", (el) => { el.value = "3"; el.dispatchEvent(new Event("input")); });
  await shot(page, "10-household");
  step("household size is one bar with two knobs", (await page.locator(".mslider #hhMin").count()) === 1 && (await page.locator(".mslider #hhMax").count()) === 1 && /2\.0–3\.0 people|3\.0–3\.0 people/.test(await page.innerText("#hh-o")));
  step("household from/to can't cross", await page.evaluate(() => { const s = Brickline.forTest.state.S; return s.hhMin <= s.hhMax && s.hhMax === 3; }));
  await page.$eval("#hhMin", (el) => { el.value = "1"; el.dispatchEvent(new Event("input")); });
  await page.$eval("#hhMax", (el) => { el.value = "6"; el.dispatchEvent(new Event("input")); });

  await page.click("#next"); // age mix
  step("age mix is off by default", !(await page.isChecked("#useMix")));
  await page.click("#useMix");
  step("age mix is one bar with a knob at each boundary", (await page.locator(".mix .mslider input[type=range]").count()) === 2 && (await page.locator(".mix .rail i").count()) === 3);
  await page.$eval("#mixA", (el) => { el.value = "70"; el.dispatchEvent(new Event("input")); });
  step("the three age shares always add to 100", await page.evaluate(() => { const m = Brickline.forTest.state.S.mix; return m.reduce((a, b) => a + b, 0) === 100 && m[0] === 70; }));
  await shot(page, "11-age");
  await page.$eval("#mixA", (el) => { el.value = "99"; el.dispatchEvent(new Event("input")); });
  step("...and the knobs can't cross", await page.evaluate(() => Brickline.forTest.state.S.mix.every((x) => x >= 0)));
  await page.click("#useMix");

  await page.click("#next"); // schools
  step("school question offers ratings in personal mode", (await page.locator("#sE").count()) === 1);
  await page.click("#next"); // -> results gate
  step("the email step comes before results", await page.isVisible("#gateForm"));
  await page.fill("#gEmail", "not-an-email");
  await page.click("#gateForm button[type=submit]");
  step("a bad email is refused with a message", await page.isVisible("#gErr"));
  await page.fill("#gEmail", "tester@example.com");
  await page.click("#gateForm button[type=submit]");
  step("results show after the email", await waitFor(page, () => document.querySelectorAll(".res").length === 1));
  const lead = captured.leads.find((l) => l.kind === "lead");
  step("the sign-up reaches the lead endpoint with the answers", lead && lead.email === "tester@example.com" && lead.answers && lead.answers.bachelorsMin === 40, JSON.stringify(lead || {}).slice(0, 120));
  step("the search itself is logged once", captured.leads.filter((l) => l.kind === "search").length === 1);
  const resText = await page.innerText(".res");
  step("a result card shows household size and age mix", /per home/.test(resText) && /Under 35/.test(resText));
  await shot(page, "3-results");
  await page.selectOption("#sortK", "inc");
  await page.click("#sortDir");
  step("sorting by income and flipping direction works", /Low to high/.test(await page.innerText("#sortDir")));
  step("after the questions, the list shows like AllTrails: count and sort on top", /Explore areas/.test(await page.innerText("#panel")) && await page.isVisible(".ecount") && await page.isVisible("#sortK"));
  step("Reset sits with the filters, next to the active pills", await page.isVisible("#filterbar #fReset"));

  // --------------------------------------------------------------- Area card
  await page.click(".res");
  step("a result opens the area card", await waitFor(page, () => location.hash.startsWith("#area-") && !!document.querySelector("#aTabs")));
  step("summary tiles render", await waitFor(page, () => document.querySelectorAll("#aPane .sig").length >= 8));
  step("the homes tile shows owners vs renters and single-family share, not a head count", await page.evaluate(() => { const t = [...document.querySelectorAll("#aPane .sig")].find((x) => /Block group: homes/.test(x.textContent)); return t && /owners/.test(t.textContent) && /renters/.test(t.textContent) && /single-family/.test(t.textContent) && !/residents/.test(t.textContent); }));
  step("the summary says why it matched", /Why it matched/.test(await page.textContent("#aPane")));
  step("the automatic summary describes the place", /What it's like here/.test(await page.innerText("#aPane")));
  step("hazards answer (not stuck on Checking)", await waitFor(page, () => !/Checking/.test(document.querySelector("#aPane").innerText)));
  for (const [label, re] of [["People", /Who lives here/], ["Money & work", /Median household income/], ["Safety & environment", /Fire/], ["Schools", /Nearest schools/], ["Sales & prices", /Last 2 sold/], ["Data", /Where these numbers come from/]]) {
    await page.click(`#aTabs button:has-text("${label}")`);
    step(`area tab "${label}" renders`, re.test(await page.textContent("#aPane")));
  }
  await page.click("#aTabs button:has-text('Summary')");
  await page.waitForTimeout(500);
  await shot(page, "4-area");
  step("the layer panel is on the map", await page.isVisible("#map-layers"));
  step("opening an area turns no layer on by itself", (await page.evaluate(() => Brickline.forTest.state.shown.length)) === 0);
  await page.click("#aTabs button:has-text('Summary')");

  // ---------------------------------------------- What a click on the map does
  // Real mouse clicks at a lat/lon, so the canvas hit-testing is exercised.
  // home: first put the map back on the test area at zoom 14, since
  // selecting an area zooms the map to it.
  const clickAt = async (lat, lon, home = true) => {
    if (home) { await page.evaluate(() => Brickline.forTest.map.setView([34.165, -118.26], 14, { animate: false })); await page.waitForTimeout(400); }
    const pt = await page.evaluate(([la, lo]) => { const p = Brickline.forTest.map.latLngToContainerPoint([la, lo]); return [p.x, p.y]; }, [lat, lon]);
    const mb = await page.locator("#map").boundingBox();
    await page.mouse.click(mb.x + pt[0], mb.y + pt[1]);
    await page.waitForTimeout(700);
  };
  const st = () => page.evaluate(() => { const s = Brickline.forTest.state; return { view: s.view, sel: s.sel, house: s.house && s.house.src && s.house.src.latlng ? 1 : 0 }; });
  await page.click(".nav a[data-v='find']");
  await page.evaluate(() => Brickline.forTest.map.setView([34.165, -118.26], 10));
  await page.waitForTimeout(600);
  step("zoomed out, no neighbourhood outlines are drawn", (await page.evaluate(() => Brickline.forTest.state.drawn)) === 0);
  step("...and the hint says to zoom in", /Zoom in/.test(await page.innerText("#map-hint")));
  await clickAt(34.165, -118.26, false);
  step("a click while zoomed out zooms in to where outlines show", await waitFor(page, () => Brickline.forTest.map.getZoom() >= 12));
  await page.evaluate(() => Brickline.forTest.map.setView([34.165, -118.26], 14));
  step("zoomed in, the outlines load and draw", await waitFor(page, () => Brickline.forTest.state.drawn >= 2));
  // Your answers leave only A on the map; show every area to click around.
  step("with answers set, areas that don't fit are left off the map", (await page.evaluate(() => Brickline.forTest.styleOf("060373020002").fillOpacity)) === 0);
  await page.click("#mShow");
  step("'Show all areas' puts them back", await waitFor(page, () => Brickline.forTest.styleOf("060373020002").fillOpacity > 0));
  await clickAt(34.165, -118.295);   // east of B: no block group there
  step("a click outside every area clears the selection", await waitFor(page, () => Brickline.forTest.state.sel === null) && await page.isHidden("#map-preview"));

  {
    await page.evaluate(() => Brickline.forTest.map.setView([34.165, -118.26], 14, { animate: false }));
    await page.waitForTimeout(400);
    const z0 = await page.evaluate(() => Brickline.forTest.map.getZoom());
    const pt = await page.evaluate(() => { const p = Brickline.forTest.map.latLngToContainerPoint([34.168, -118.275]); return [p.x, p.y]; });
    const mb = await page.locator("#map").boundingBox();
    await page.mouse.dblclick(mb.x + pt[0], mb.y + pt[1]);
    await page.waitForTimeout(900);
    const after = await page.evaluate(() => ({ z: Brickline.forTest.map.getZoom(), sel: Brickline.forTest.state.sel, view: Brickline.forTest.state.view }));
    step("a double-click zooms in and selects nothing", after.z > z0 && after.sel === null && after.view === "find", JSON.stringify({ z0, ...after }));
  }
  await clickAt(34.168, -118.275);
  let s = await st();
  await page.waitForTimeout(300);
  await shot(page, "8-selected");
  step("first click (mid-questions) selects that block group", s.sel === GEO.A && s.view === "find", JSON.stringify(s));
  step("...the questions stay on screen", (await page.locator("#qpane, .results").count()) >= 1);
  const share = await page.evaluate(() => {
    const m = Brickline.forTest.map, sz = m.getSize();
    const b = L.latLngBounds([34.16, -118.28], [34.17, -118.26]);
    const a = m.latLngToContainerPoint(b.getNorthWest()), c = m.latLngToContainerPoint(b.getSouthEast());
    return ((c.x - a.x) * (c.y - a.y)) / (sz.x * sz.y);
  });
  step("selecting it zooms so it fills 20-30% of the map, centred", share >= 0.2 && share <= 0.3, `${Math.round(share * 100)}%`);
  step("...and a preview names the area", await page.isVisible("#map-preview") && /Tract 3020, block group 1/.test(await page.innerText("#map-preview")));
  await clickAt(34.168, -118.25);
  s = await st();
  step("a click in another area selects that one instead", s.sel === GEO.B && s.view === "find", JSON.stringify(s));
  await clickAt(34.165, -118.295);
  step("a click outside every area deselects", await waitFor(page, () => Brickline.forTest.state.sel === null));
  await clickAt(34.168, -118.25);
  await clickAt(34.163, -118.245, false);   // the map is now zoomed on B
  step("a second click inside the selected area checks the house there", await waitFor(page, () => { const x = Brickline.forTest.state; return x.view === "house" && x.house && x.house.src && x.house.src.latlng; }));
  step("...and its back link returns to the list", await waitFor(page, () => /Back to the list/.test(document.querySelector("#panel .crumb").textContent), null, 20000));
  await waitFor(page, () => { const h = Brickline.forTest.state.house; return h && !h.loading && h.build; }, null, 20000);
  step("...the house's block group stays selected", await waitFor(page, () => Brickline.forTest.state.sel === "060373020002", null, 20000));
  await page.evaluate(() => Brickline.forTest.map.setView([34.165, -118.26], 14));
  await page.waitForTimeout(500);
  await clickAt(34.168, -118.275);
  step("from a house, a click in another area opens that area's card", await waitFor(page, () => { const x = Brickline.forTest.state; return x.view === "area" && x.sel === "060373020001"; }));
  await page.evaluate(() => Brickline.forTest.map.setView([34.165, -118.26], 14));
  await page.waitForTimeout(500);
  await clickAt(34.16515, -118.27025);
  step("from an area card, a click inside it checks the house there", await waitFor(page, () => Brickline.forTest.state.view === "house"));
  await waitFor(page, () => { const h = Brickline.forTest.state.house; return h && !h.loading && h.build; }, null, 20000);
  await page.evaluate(() => Brickline.forTest.map.setView([34.165, -118.26], 14));
  await page.waitForTimeout(500);
  await clickAt(34.165, -118.295);   // west of A, clear of the layer panel
  step("from a house, a click outside every area deselects and goes back to the questions", await waitFor(page, () => { const x = Brickline.forTest.state; return x.view === "find" && x.sel === null; }), JSON.stringify(await st()));

  await page.click("#mShow");
  step("'Show only my matches' hides the others again", await waitFor(page, () => Brickline.forTest.styleOf("060373020002").fillOpacity === 0));

  // ----------------------------------------------------------- Layer toggles
  const layerRows = await page.locator("#map-layers .layer").count();
  step("six map layers on the questions screen", layerRows === 6 && await page.isVisible("#map-layers"), `${layerRows} rows`);
  step("...all off until you turn them on", (await page.locator('#map-layers .layer[aria-pressed="true"]').count()) === 0);
  await page.click('#map-layers [data-l="pollution"]');
  step("Air quality draws CalEnviroScreen tracts", await waitFor(page, () => Brickline.forTest.state.hazards >= 1 && Brickline.forTest.state.shown.includes("pollution")));
  step("...with its legend", /percentile/i.test(await page.innerText("#map-layers")));
  await page.click('#map-layers [data-l="pollution"]');
  step("...and turns off again", await waitFor(page, () => Brickline.forTest.state.hazards === 0));
  await page.click('#map-layers [data-l="wind"]');
  step("Wind draws the local grid", await waitFor(page, () => Brickline.forTest.state.rasters === 1));
  await page.click('#map-layers [data-l="wind"]');
  step("...and turns off", await waitFor(page, () => Brickline.forTest.state.rasters === 0));
  await page.click('#map-layers [data-l="noise"]');
  step("Noise draws the DOT noise tiles", await waitFor(page, () => Brickline.forTest.state.rasters === 1) && captured.noise > 0, `${captured.noise} noise requests`);
  const noiseOrder = await page.evaluate(() => Brickline.forTest.noiseOrder);
  const air = noiseOrder.filter((o) => o.air), road = noiseOrder.filter((o) => !o.air);
  step("the noise legend is the service's own decibel bands", await waitFor(page, () => /45 - 50 dB/.test(document.querySelector("#map-layers").innerText)));
  step("aircraft noise sits on top of road and rail noise", air.length && road.length && Math.min(...air.map((o) => o.z)) > Math.max(...road.map((o) => o.z)), JSON.stringify(noiseOrder));
  await page.click('#map-layers [data-l="noise"]');
  await page.click('#map-layers [data-l="fire"]');
  step("Fire draws when switched on", await waitFor(page, () => Brickline.forTest.state.hazards >= 1));
  await page.click('#map-layers [data-l="fire"]');
  step("layers only change when you click them", await waitFor(page, () => Brickline.forTest.state.shown.length === 0));

  // ----------------------------------------------- Filter pills, AllTrails-style
  const bar = await page.innerText("#filterbar");
  step("filter pills run along the top of the map", await page.isVisible("#filterbar") && /All/.test(bar) && /Street/.test(bar) && /Homes/.test(bar) && /Income/.test(bar));
  step("active filters show their value with an ×", /min to work/.test(bar) && /Bachelor's 40%\+/.test(bar) && (await page.locator("#filterbar .pill.on .px").count()) >= 2);
  step("the list sits on the left with its count and sort", /Explore areas/.test(await page.innerText("#panel")) && /1\s*area fits/.test(await page.innerText(".ecount")));
  await page.click("#filterbar [data-f='2']");
  step("a pill opens its own panel under it", await page.isVisible("#filter-pop") && (await page.locator("#filter-pop #det").count()) === 1);
  await page.$eval("#det", (el) => { el.value = "60"; el.dispatchEvent(new Event("input")); });
  await page.waitForTimeout(300);
  await shot(page, "9-pill");
  step("changing it updates the pill, the button count and the list", await waitFor(page, () => /60%\+ houses/.test(document.querySelector("#filterbar").innerText) && /Show 1 area$/.test(document.querySelector("#fpDone").textContent) && /1\s*area fits/.test(document.querySelector(".ecount").innerText)));
  await page.mouse.click(700, 600);   // somewhere on the map, away from the panel
  step("a click elsewhere closes the panel", await waitFor(page, () => document.querySelector("#filter-pop").hidden));
  await page.click("#filterbar [data-fx='2']");
  step("the pill's × clears that filter only", await waitFor(page, () => Brickline.forTest.state.S.detMin === 0 && Brickline.forTest.state.S.edu === 40));
  await page.click("#filterbar [data-f='0']");
  await page.fill("#c-addr-0", "");
  await page.type("#c-addr-0", "Warner Bros", { delay: 15 });
  step("the commute box suggests places with no street number", await waitFor(page, () => document.querySelectorAll("#filter-pop .suggest li[data-i]").length > 0));
  await page.click("#fpDone");
  await page.click("#fAll");
  step("'All' opens the guided questions in the panel", await waitFor(page, () => !!document.querySelector("#qpane") && Brickline.forTest.state.S.wizard === true) && await page.isHidden("#filter-pop"));
  await page.click("#wizClose");
  step("closing them goes back to the list", await waitFor(page, () => !!document.querySelector(".ecount")));

  // -------------------------------------------------------------- Journey one
  await page.click(".nav a[data-v='home']");
  await page.fill("#home-q", "https://www.redfin.com/CA/Glendale/1745-Grandview-Ave-91201/home/123456");
  await page.click("#home-search button");
  for (let i = 0; i < 50 && !captured.geocodes.some((u) => /1745/.test(u)); i++) await page.waitForTimeout(100);
  step("a Redfin link is read as its address", captured.geocodes.some((u) => /1745[+ ]Grandview[+ ]Ave[+ ]91201/i.test(u)), captured.geocodes.slice(-1)[0]);
  step("the house card opens", await waitFor(page, () => /GRANDVIEW/i.test((document.querySelector("#panel h2") || {}).textContent || ""), null, 20000));
  await waitFor(page, () => { const h = Brickline.forTest.state.house; return h && !h.loading && h.build; }, null, 20000);
  const head = await page.innerText(".card-head");
  step("the header names the zone and the city", /Zone R1/.test(head) && /Glendale/.test(head), head.replace(/\s+/g, " ").slice(0, 120));
  step("tabs split 'This house' from 'The neighbourhood'", (await page.locator(".tabgroup").count()) === 2 && (await page.locator(".tabsep").count()) === 1);
  step("room to build is worked out", await waitFor(page, () => { const b = Brickline.forTest.state.house.build; return b && !b.unavailable && b.largest; }, null, 20000),
    JSON.stringify(await page.evaluate(() => { const b = Brickline.forTest.state.house.build; return b && (b.unavailable || (b.largest && b.largest.sqft)); })));
  await page.click("#hTabs button:has-text('Lot & building')");
  const lot = await page.textContent("#hPane");
  const order = ["The building", "Things to know", "Room to build", "Zoning", "Rules to follow"].map((h) => lot.indexOf(h));
  step("Lot & building runs building → things to know → room → zoning → rules", order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), order.join(","));
  await page.waitForTimeout(500);
  await shot(page, "5-house-lot");
  step("the assessor record matched the house (1,400 sq ft)", /1,400 sq ft/.test(lot));
  step("rules carry verified / not-yet-verified tags", /verified/.test(lot));
  step("the selected lot is drawn in its own colour, not the area green", await page.evaluate(() => { let c = null; Brickline.forTest.map.eachLayer((l) => { if (l.feature && l.feature.properties && l.feature.properties.AIN === "5634012003" && l.options && l.options.weight === 3) c = l.options.color; }); return c && c !== "#0b6e66"; }));
  step("every map-key entry fits on one line", await page.evaluate(() => [...document.querySelectorAll(".key span")].every((s) => s.getBoundingClientRect().height < 22)));
  step("no ADU label sits on the map itself", await page.evaluate(() => ![...document.querySelectorAll(".leaflet-tooltip")].some((t) => /ADU/.test(t.textContent))));
  const key = await page.innerText("#map-layers .key");
  step("the map key explains the dashed line and the green box", /main house may go/.test(key) && /open spot for a backyard ADU/.test(key) && /Existing buildings/.test(key) && /Selected lot/.test(key) && !/zone setbacks/.test(key), key.replace(/\s+/g, " ").slice(0, 160));
  step("the ADU row is plain text, not a coloured pill", await page.evaluate(() => { const r = [...document.querySelectorAll("#hPane .rowv")].find((x) => /Largest open spot/.test(x.textContent)); return r && !r.querySelector(".pillv"); }));
  step("...and says the open spot already leaves out the buildings", /leaves out every existing building/.test(lot));
  step("the card gives the footprint you could likely build", /ADU footprint you could likely build/.test(lot) && /guarantees an ADU up to 800 sq ft/.test(lot));

  await page.click("#hTabs button:has-text('Summary')");
  await page.click("#askCommute");
  await page.fill("#askQ", "100 N Brand Blvd, Glendale");
  await page.click("#askForm button[type=submit]");
  step("adding a work address gives a drive time", await waitFor(page, () => /~23 min/.test(document.querySelector("#hPane").innerText)));
  await page.click("#reserve");
  step("the full report is 'coming soon' with no price, and the button logs interest", !/\$\d/.test(await page.innerText(".cta")) && /coming soon/i.test(await page.innerText(".cta")) && await waitFor(page, () => /on the list/.test(document.querySelector("#hPane").innerText)) && captured.leads.some((l) => l.kind === "report_request" && /GRANDVIEW/i.test(l.address)));

  // ------------------------------------------- One search box: place or house
  const typeHome = async (text) => {
    await page.click(".nav a[data-v='home']");
    await page.fill("#home-q", "");
    await page.type("#home-q", text, { delay: 20 });
  };
  step("place names load from the county", await waitFor(page, () => Brickline.forTest.places >= 3), String(await page.evaluate(() => Brickline.forTest.places)));
  await typeHome("silv");
  step("typing a neighbourhood suggests it", await waitFor(page, () => [...document.querySelectorAll(".suggest li")].some((li) => /Silver Lake/.test(li.textContent) && /neighbourhood/i.test(li.textContent))));
  await page.click(".suggest li:has-text('Silver Lake')");
  step("picking it highlights its block groups", await waitFor(page, () => { const p = Brickline.forTest.place; return p && p.n === 2; }), JSON.stringify(await page.evaluate(() => Brickline.forTest.place)));
  step("...opens its card with the list", await waitFor(page, () => /Silver Lake/.test(document.querySelector("#panel h2").textContent) && document.querySelectorAll("#panel .res").length === 2));
  step("...shades only the block groups inside it", await page.evaluate(() => Brickline.forTest.styleOf("060373020001").fillOpacity > 0 && Brickline.forTest.styleOf("060379100001").fillOpacity === 0));
  step("...and shows it as a chip on the map", await page.isVisible(".placechip"));
  await page.evaluate(() => Brickline.forTest.map.setView([34.165, -118.26], 14));
  await page.waitForTimeout(800);
  await shot(page, "7-place");
  step("the key names the border by kind", /Neighbourhood border/.test(await page.innerText("#map-layers .key")));
  await page.click("#plClear");
  step("the chip's × clears the place", await waitFor(page, () => !Brickline.forTest.place));
  step("...and keeps you on the map, not the home page", await waitFor(page, () => Brickline.forTest.state.view === "lookup" && !document.querySelector("#workspace").hidden));
  // C is outside Silver Lake and also fails your answers: show all areas to see the place filter is really gone.
  await page.click("#mShow");
  step("...with the areas outside it back on the map", await waitFor(page, () => Brickline.forTest.styleOf("060379100001").fillOpacity > 0));
  await page.click("#mShow");
  await typeHome("Beverly Hills");
  await page.keyboard.press("Enter");
  step("a city typed in full and Enter goes straight to it", await waitFor(page, () => { const p = Brickline.forTest.place; return p && p.name === "Beverly Hills" && p.n === 0; }));
  await typeHome("91201");
  step("five digits are suggested as a zip code", await waitFor(page, () => /Zip code/.test((document.querySelector(".suggest") || {}).textContent || "")));
  await page.keyboard.press("Enter");
  step("a zip shows the block groups inside it", await waitFor(page, () => { const p = Brickline.forTest.place; return p && p.name === "Zip 91201" && p.n === 1; }), JSON.stringify(await page.evaluate(() => Brickline.forTest.place)));
  await typeHome("1745 Grandview");
  step("a street address gets address suggestions as you type", await waitFor(page, () => [...document.querySelectorAll(".suggest li")].some((li) => /Grandview/.test(li.textContent) && /Address/.test(li.textContent))));
  await page.click(".suggest li:has-text('Grandview')");
  step("picking one opens that house", await waitFor(page, () => Brickline.forTest.state.view === "house" && /GRANDVIEW/i.test(document.querySelector("#panel h2").textContent), null, 20000));
  await waitFor(page, () => { const h = Brickline.forTest.state.house; return h && !h.loading && h.build; }, null, 20000);

  // ---------------------------------------- Your matches stay on the map
  await page.click("#plClear");   // the zip from the search above is still on
  const shown = (g) => `Brickline.forTest.styleOf("${g}").fillOpacity > 0`;
  step("on a house card, only your matches are shaded", await page.isVisible("#mShow") && await page.evaluate(`${shown(GEO.A)} && !(${shown(GEO.C)})`));
  step("...in street-busyness greens, not a highlight colour", (await page.evaluate(() => Brickline.forTest.styleOf("060373020001").fillColor)) !== "#f97316");
  await page.click("#mShow");
  step("'Show all areas' gives a full map, answers kept", await waitFor(page, () => Brickline.forTest.styleOf("060379100001").fillOpacity > 0) && (await page.evaluate(() => Brickline.forTest.state.S.edu)) === 40);
  await page.click("#mShow");
  step("'Show only my matches' narrows it again", await waitFor(page, () => Brickline.forTest.styleOf("060379100001").fillOpacity === 0));
  step("on the map card, Reset sits next to Edit answers", /Edit answers\s*Reset/.test(await page.innerText(".mctl")));
  await page.click("#mReset");
  step("'Reset' clears the answers and shows every area", await waitFor(page, () => Brickline.forTest.state.S.edu === 0 && Brickline.forTest.styleOf("060379100001").fillOpacity > 0));
  await page.click(".nav a[data-v='lookup']");
  step("'Look up a place' always opens the search box, even with a house open", await waitFor(page, () => !!document.querySelector("#houseQ") && Brickline.forTest.state.view === "lookup"));
  step("...and offers a way back to the last house", /Back to:.*GRANDVIEW/i.test(await page.innerText("#panel")));
  await page.click("#panel .recent a");
  step("a house found by address selects its block group", (await page.evaluate(() => Brickline.forTest.state.sel)) === GEO.A);
  step("no page errors in the whole run", captured.errors.length === 0, captured.errors.slice(0, 3).join(" | "));

  // -------------------------------------------------------------- Public mode
  {
    const { page: p, captured: c, ctx } = await open("/brickline.html?mode=public#questions");
    await waitFor(p, () => Brickline.forTest.state.ready);
    step("public mode is honoured", !(await p.evaluate(() => Brickline.forTest.state.PERSONAL)));
    for (let i = 0; i < 7; i++) await p.click("#skip");
    step("public mode hides school ratings", (await p.locator("#sE").count()) === 0 && /aren't available/.test(await p.innerText("#qpane")));
    await p.click("#skip");
    await p.click("#gSkip");
    step("'Skip for now' still shows results", await waitFor(p, () => document.querySelectorAll(".res").length === 3));
    step("public results carry no ratings or listings", !/Schools \d/.test(await p.innerText(".results")) && !/for sale/.test(await p.innerText(".results")));
    step("no page errors in public mode", c.errors.length === 0, c.errors.slice(0, 3).join(" | "));
    await ctx.close();
  }

  // ------------------------------------------------- Lead server unreachable
  {
    const { page: p, captured: c, ctx } = await open("/brickline.html#questions", { leadDown: true });
    await waitFor(p, () => Brickline.forTest.state.ready);
    for (let i = 0; i < 8; i++) await p.click("#skip");
    await p.fill("#gEmail", "later@example.com");
    await p.click("#gateForm button[type=submit]");
    await waitFor(p, () => document.querySelectorAll(".res").length > 0);
    const local = await p.evaluate(() => JSON.parse(localStorage.getItem("brickline.leads.v1") || "[]"));
    step("with no lead server the sign-up is kept in the browser", local.some((l) => l.email === "later@example.com"));
    step("...and the page says so", /saved on this device/i.test(await p.innerText(".ehead")));
    await ctx.close();
  }

  // ------------------------------------------------------------------- Phone
  {
    const { page: p, ctx } = await open("/brickline.html", { viewport: { width: 390, height: 844 } });
    await shot(p, "6-phone");
    const wide = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    step("phone: landing has no sideways scroll", !wide);
    await p.click("text=Start the questions");
    await waitFor(p, () => Brickline.forTest.state.ready);
    step("phone: questions have no sideways scroll", !(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
    await ctx.close();
  }

  // ------------------------------------------------ The explorer still loads
  {
    const { page: p, captured: c, ctx } = await open("/blockgroups.html");
    step("the old explorer page still starts", await waitFor(p, () => typeof BlockGroupApp !== "undefined" && !!BlockGroupApp.state && !!BlockGroupApp.state.map));
    step("the explorer builds its own map (not headless)", await p.evaluate(() => !window.BLOCKGROUPS_HEADLESS && !!document.querySelector("#map .leaflet-pane")));
    await ctx.close();
  }

  await browser.close();
  kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
