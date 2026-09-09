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

// School points. Grade spans are deliberately written the way CDE writes
// them, so the level classifier is exercised on real-shaped input.
function esriPoint(attributes, x, y) {
  return { attributes, geometry: { x, y } };
}
const SCHOOL_ELEM = esriPoint(
  { SchoolName: "Spring Street Elementary", District: "Los Angeles Unified", GSoffered: "K-5", StatusType: "Active", City: "Los Angeles" },
  -118.255,
  34.05
);
const SCHOOL_MIDDLE = esriPoint(
  { SchoolName: "Civic Center Middle", District: "Los Angeles Unified", GSoffered: "6-8", StatusType: "Active", City: "Los Angeles" },
  -118.245,
  34.05
);
const SCHOOL_HIGH = esriPoint(
  { SchoolName: "Downtown Senior High", District: "Los Angeles Unified", GSoffered: "9-12", StatusType: "Active", City: "Los Angeles" },
  -118.235,
  34.05
);
// Closed sites stay in the published file; drawing them puts dots on
// buildings that are not schools any more.
const SCHOOL_CLOSED = esriPoint(
  { SchoolName: "Old Closed Elementary", GSoffered: "K-5", StatusType: "Closed" },
  -118.225,
  34.05
);

// LAUSD attendance zones: one per level, all covering block group A.
const ZONE_ELEM = esriPolygon({ SCHOOL: "Spring Street Elementary" }, [
  [-118.27, 34.03], [-118.27, 34.07], [-118.23, 34.07], [-118.23, 34.03],
]);
const ZONE_MIDDLE = esriPolygon({ SCHOOL: "Civic Center Middle" }, [
  [-118.28, 34.02], [-118.28, 34.08], [-118.22, 34.08], [-118.22, 34.02],
]);
const ZONE_HIGH = esriPolygon({ SCHOOL: "Downtown Senior High" }, [
  [-118.29, 34.01], [-118.29, 34.09], [-118.21, 34.09], [-118.21, 34.01],
]);

const SCHOOL_DISTRICT = esriPolygon({ NAME: "Los Angeles Unified School District", BASENAME: "Los Angeles Unified" }, [
  [-118.40, 33.90], [-118.40, 34.20], [-118.10, 34.20], [-118.10, 33.90],
]);

// FEMA flood zones: an AE zone (the 1% floodplain, insurance required) over
// block group A, and a plain X beside it.
const FLOOD_AE = esriPolygon({ FLD_ZONE: "AE", ZONE_SUBTY: "", OBJECTID: 41 }, [
  [-118.27, 34.03], [-118.27, 34.07], [-118.245, 34.07], [-118.245, 34.03],
]);
const FLOOD_X = esriPolygon({ FLD_ZONE: "X", ZONE_SUBTY: "0.2 PCT ANNUAL CHANCE FLOOD HAZARD", OBJECTID: 42 }, [
  [-118.245, 34.03], [-118.245, 34.07], [-118.20, 34.07], [-118.20, 34.03],
]);

// CGS publishes liquefaction and landslide as two separate services; both
// have to end up on the map.
const LIQUEFACTION = esriPolygon({ OBJECTID: 51 }, [
  [-118.27, 34.03], [-118.27, 34.05], [-118.24, 34.05], [-118.24, 34.03],
]);
const LANDSLIDE = esriPolygon({ OBJECTID: 52 }, [
  [-118.24, 34.05], [-118.24, 34.07], [-118.21, 34.07], [-118.21, 34.05],
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
      avgHouseholdSize: 3.4,
      // 600 of 1,000 units detached, 300 of 400 owner-occupied, 120 of 600
      // workers at home, half the stock pre-1980.
      structureTotal: 1000,
      structureUnits: { "1, detached": 600, "1, attached": 100, "5 to 9": 300 },
      tenureTotal: 400,
      ownerOccupied: 300,
      renterOccupied: 100,
      workersTotal: 600,
      workedFromHome: 120,
      walkedToWork: 30,
      transitToWork: 60,
      medianYearBuilt: 1962,
      yearBuiltTotal: 1000,
      yearBuiltPre1980: 500,
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

  // Assessor-derived home prices. Block group A has a healthy sample, C rests
  // on two sales and must be flagged as thin rather than passed off as a
  // market rate.
  const parcelPath = path.join(REPO, "js", "data", "parcels-la-county.json");
  fs.writeFileSync(
    parcelPath,
    JSON.stringify({
      meta: {
        salesFrom: 2021,
        source: "LA County Assessor parcel roll (test fixture)",
        countyByYear: { "2021": { n: 40000, median: 800000 }, "2024": { n: 30000, median: 950000 } },
      },
      blockGroups: {
        "060372011001": {
          medianSalePrice: 1250000,
          saleCount: 34,
          medianPricePerSqft: 780.5,
          thin: false,
          sfhTotal: 210,
          years: {
            "2021": { n: 9, median: 1100000, p10: 890000, p90: 1400000, ppsf: 690.0, turnover: 4.29 },
            "2024": { n: 3, median: 1310000, ppsf: 812.0, turnover: 1.43 },
          },
        },
        "060372011003": { medianSalePrice: 640000, saleCount: 2, thin: true, sfhTotal: 60, years: {} },
      },
    })
  );

  // The per-sale detail behind each count, in its own file because it is far
  // larger than the summary and only fetched when a count is clicked.
  const salesPath = path.join(REPO, "js", "data", "parcel-sales-la-county.json");
  fs.writeFileSync(
    salesPath,
    JSON.stringify({
      meta: {
        columns: ["address", "recorded", "sqft", "land", "improvement", "exemption", "total", "yearBuilt"],
      },
      byBlockGroup: {
        "060372011001": {
          "2021": [
            ["123 N Spring St, Los Angeles", "20210415", 1480, 620000, 430000, 7000, 1050000, 1948],
            ["77 Bunker Hill Rd, Los Angeles", "20210902", 2100, 900000, 500000, 0, 1400000, 1962],
            ["9 Olive Ct, Los Angeles", "20211118", 1150, 500000, 380000, 7000, 880000, 1939],
          ],
          "2024": [["55 Hill St, Los Angeles", "20240220", 1600, 800000, 510000, 7000, 1310000, 1971]],
        },
      },
    })
  );

  // Listings, as they actually arrive: Redfin "Download All" CSVs in a folder,
  // parsed by the page itself. No import step is exercised because there no
  // longer is one - the fixture is the raw file, quoted addresses, MLS notice
  // row and all.
  const LISTING_HEADER =
    "SALE TYPE,SOLD DATE,PROPERTY TYPE,ADDRESS,CITY,STATE OR PROVINCE,ZIP OR POSTAL CODE,PRICE,BEDS," +
    "BATHS,LOCATION,SQUARE FEET,LOT SIZE,YEAR BUILT,DAYS ON MARKET,$/SQUARE FEET,HOA/MONTH,STATUS," +
    "NEXT OPEN HOUSE START TIME,NEXT OPEN HOUSE END TIME,URL,SOURCE,MLS#,FAVORITE,INTERESTED,LATITUDE,LONGITUDE";
  // Redfin puts this on its own line under the header. It is one field wide,
  // so it must be recognised as a note rather than parsed as a home.
  const MLS_NOTICE =
    '"In accordance with local MLS rules, some MLS listings are not included in the download"';

  function listingRow(f) {
    return [
      "MLS Listing", "", f.type || "Single Family Residential", `"${f.address}"`, f.city || "",
      "CA", f.zip || "", f.price, f.beds || "", f.baths || "", "", f.sqft || "", f.lot || "",
      f.built || "", f.dom, f.ppsf || "", f.hoa || "", f.status || "Active", "", "",
      f.url, f.source || "CRMLS", f.mls || "", "", "", f.lat, f.lon,
    ].join(",");
  }

  const REESE = {
    // The comma in the address is the point: split on commas and every later
    // column shifts by one.
    address: "331 N Reese Pl, Unit A",
    city: "Burbank", zip: "91506", price: 1400000, beds: 3, baths: 2, sqft: 1921,
    lot: 6746, built: 1940, dom: 7, hoa: "", mls: "BB26142414",
    url: "https://www.redfin.com/CA/Burbank/331-N-Reese-Pl-91506/home/5334447",
    lat: 34.05, lon: -118.25,
  };
  const LINCOLN = {
    address: "322 S Lincoln St", city: "Burbank", zip: "91506", price: 995000, beds: 3,
    baths: 3, sqft: 1721, lot: 7067, built: 1944, dom: 39, mls: "BB26192871",
    url: "https://www.redfin.com/CA/Burbank/322-S-Lincoln-St-91506/home/5327903",
    lat: 34.052, lon: -118.252,
  };
  // In block group C, so it must NOT be drawn while A is selected.
  const OLIVE = {
    address: "9 Olive Ct", price: 780000, sqft: 1000, lot: 5000, dom: 8,
    url: "https://www.redfin.com/CA/Burbank/other/home/1", lat: 34.05, lon: -118.21,
  };
  // A lot given in acres - Redfin switches units above an acre without
  // renaming the column, and 0.5 square feet is not a lot.
  const ACRE_LOT = {
    address: "1 Ranch Rd", city: "Burbank", price: 2000000, sqft: 2000, lot: 0.5, dom: 3,
    url: "https://www.redfin.com/CA/Burbank/ranch/home/2", lat: 34.055, lon: -118.255,
  };

  function listingCsv(rows) {
    return [LISTING_HEADER, MLS_NOTICE, ...rows.map(listingRow)].join("\n") + "\n";
  }

  // Two downloads, so "new since your last download" is a fact and not a
  // guess: Lincoln was already there in July, the rest arrived in September.
  const LISTING_FILES = {
    "redfin_20260702100000.csv": listingCsv([{ ...LINCOLN, dom: 0 }]),
    "redfin_20260909160153.csv": listingCsv([REESE, LINCOLN, OLIVE, ACRE_LOT]),
  };

  // The routing key. Read as a file so it never has to be pasted into code.
  const orsKeyPath = path.join(REPO, "ors-api-key.txt");
  fs.writeFileSync(orsKeyPath, "5b3ce3597851110001cf6248TESTKEYTESTKEYTESTKEY");

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

  // The listings folder. python's http.server publishes a directory index for
  // it and the page scrapes the .csv links out of that, so the stub has to be
  // an index page and not a JSON manifest - a manifest would test something
  // the app does not do.
  let listingsIndexRequests = 0;
  await page.route(/\/raw-data\/redfin-listings\//, (route) => {
    const url = new URL(route.request().url());
    const name = decodeURIComponent(url.pathname.split("/").pop() || "");
    if (!name) {
      listingsIndexRequests++;
      const links = Object.keys(LISTING_FILES)
        .map((f) => `<li><a href="${f}">${f}</a></li>`)
        .join("");
      return route.fulfill({
        contentType: "text/html",
        body: `<!DOCTYPE HTML><html><head><title>Directory listing for /raw-data/redfin-listings/</title></head>
               <body><h1>Directory listing for /raw-data/redfin-listings/</h1><hr><ul>
               <li><a href="notes.txt">notes.txt</a></li>${links}</ul><hr></body></html>`,
      });
    }
    if (LISTING_FILES[name] === undefined) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({
      contentType: "text/csv",
      headers: { "last-modified": "Wed, 09 Sep 2026 23:01:53 GMT" },
      body: LISTING_FILES[name],
    });
  });
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
    if (url.includes("Potential_Landslides")) {
      cgsQueries.push(url);
      if (url.includes("/query")) return route.fulfill(json(esriFC([LANDSLIDE])));
      return route.fulfill(json({ id: 0, name: "Potential Landslides", geometryType: "esriGeometryPolygon" }));
    }
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

  // LA City GeoHub: LAUSD attendance boundaries, one sublayer per level,
  // plus a "Key Codes" lookup table that must never be drawn.
  let zoneQueries = [];
  await page.route("**://maps.lacity.org/**", (route) => {
    const url = route.request().url();
    if (url.includes("/query")) {
      zoneQueries.push(url);
      if (url.includes("/4/query")) return route.fulfill(json(esriFC([ZONE_ELEM])));
      if (url.includes("/5/query")) return route.fulfill(json(esriFC([ZONE_MIDDLE])));
      if (url.includes("/6/query")) return route.fulfill(json(esriFC([ZONE_HIGH])));
      return route.fulfill(json(esriFC([])));
    }
    return route.fulfill(
      json({
        layers: [
          { id: 0, name: "Schools (LAUSD)", geometryType: "esriGeometryPoint" },
          { id: 4, name: "LAUSD Attendance Boundary (Elementary Schools)", geometryType: "esriGeometryPolygon" },
          { id: 5, name: "LAUSD Attendance Boundary (Middle Schools)", geometryType: "esriGeometryPolygon" },
          { id: 6, name: "LAUSD Attendance Boundary (High Schools)", geometryType: "esriGeometryPolygon" },
          { id: 7, name: "LAUSD Attendance Boundary Key Codes (Elementary Schools)", geometryType: "esriGeometryPolygon" },
        ],
      })
    );
  });

  // CA Dept of Education school sites.
  let schoolQueries = [];
  await page.route("**://services3.arcgis.com/**", (route) => {
    schoolQueries.push(route.request().url());
    return route.fulfill(json({ ...esriFC([SCHOOL_ELEM, SCHOOL_MIDDLE, SCHOOL_HIGH, SCHOOL_CLOSED]), geometryType: "esriGeometryPoint" }));
  });

  let femaQueries = [];
  // The first host in the candidate list is dead - exactly the case that used
  // to strand the layer, because a candidate with a fixed layer id was
  // accepted without a single request and its working sibling never tried.
  await page.route("**://hazards.fema.gov/gis/nfhl/**", (route) => route.abort("failed"));
  await page.route("**://hazards.fema.gov/arcgis/**", (route) => {
    const url = route.request().url();
    if (url.includes("/query")) {
      femaQueries.push(url);
      return route.fulfill(json(esriFC([FLOOD_AE, FLOOD_X])));
    }
    // Layer metadata, read to prove the service is actually reachable.
    return route.fulfill(json({ id: 28, name: "Flood Hazard Zones", geometryType: "esriGeometryPolygon" }));
  });

  // Two CGS services, one per hazard type - the merge-all path.
  let cgsQueries = [];
  // CGS's own server answers 500 "Service not started" - the failure the user
  // hit - so the mirrors have to take over.
  await page.route("**://gis.conservation.ca.gov/**", (route) =>
    route.fulfill(json({ error: { code: 500, message: "Service not started ", details: [] } }))
  );
  await page.route("**://services2.arcgis.com/**", (route) => {
    const url = route.request().url();
    cgsQueries.push(url);
    if (url.includes("/query")) return route.fulfill(json(esriFC([LIQUEFACTION])));
    return route.fulfill(json({ id: 0, name: "Liquefaction Zones", geometryType: "esriGeometryPolygon" }));
  });

  // BTS/DOT noise: a raster service, so the page asks it to draw tiles and
  // to identify a pixel value at a point.
  // The real DOT service is TILE-CACHED, which is why a well-formed /export
  // URL drew nothing: a cached service refuses export outright. The mock
  // behaves the same way - export 404s, /tile serves an image - so the page
  // has to read the service's metadata and pick the right endpoint.
  let noiseServicesChosen = [];
  await page.route("**://tiles.arcgis.com/**", (route) => {
    const url = route.request().url();
    // The folder listing, named the way BTS actually names these.
    if (/\/services\?f=json/.test(url)) {
      return route.fulfill(
        json({
          services: [
            { name: "NTAD_Noise_2018_Alaska_aviation_road", type: "MapServer" },
            { name: "NTAD_Noise_2020_Alaska_aviation", type: "MapServer" },
            { name: "NTAD_Noise_2018_CONUS_aviation_road", type: "MapServer" },
            { name: "NTAD_Noise_2020_CONUS_aviation", type: "MapServer" },
            { name: "NTAD_Noise_2018_CONUS_aviation", type: "MapServer" },
            { name: "NTAD_Noise_2020_CONUS_road", type: "MapServer" },
            { name: "NTAD_Noise_2020_CONUS_rail", type: "MapServer" },
          ],
        })
      );
    }
    if (url.includes("/legend")) {
      return route.fulfill(
        json({
          layers: [
            {
              legend: [
                { label: "45 - 55 dB", imageData: BLANK_PNG.toString("base64"), contentType: "image/png" },
                { label: "55 - 65 dB", imageData: BLANK_PNG.toString("base64"), contentType: "image/png" },
                { label: "65 - 75 dB", imageData: BLANK_PNG.toString("base64"), contentType: "image/png" },
              ],
            },
          ],
        })
      );
    }
    if (url.includes("/tile/")) return route.fulfill({ contentType: "image/png", body: BLANK_PNG });
    // Service metadata: cached, with a cache that stops at zoom 13.
    noiseServicesChosen.push(url);
    return route.fulfill(
      json({
        mapName: "NTAD noise",
        singleFusedMapCache: true,
        tileInfo: { lods: [{ level: 0 }, { level: 12 }, { level: 13 }] },
      })
    );
  });

  let noiseRequests = { root: 0, exports: 0, tiles: 0, identify: 0 };
  await page.route("**://geo.dot.gov/**", (route) => {
    const url = route.request().url();
    if (url.includes("/export")) {
      noiseRequests.exports++;
      return route.fulfill({ status: 400, contentType: "text/plain", body: "Export not supported" });
    }
    if (url.includes("/tile/")) {
      noiseRequests.tiles++;
      return route.fulfill({ contentType: "image/png", body: BLANK_PNG });
    }
    if (url.includes("/identify")) {
      noiseRequests.identify++;
      return route.fulfill(json({ results: [{ attributes: { "Pixel Value": "58.4" } }] }));
    }
    noiseRequests.root++;
    // The legacy DOT service is gone, so the folder discovery has to carry it.
    return route.fulfill(json({ error: { code: 400, message: "Service not found" } }));
  });

  // OpenRouteService directions. Returns a GeoJSON LineString plus a summary,
  // which is what the page reads for the drive time.
  let orsRequests = [];
  await page.route("**://api.openrouteservice.org/**", (route) => {
    orsRequests.push(route.request().url());
    return route.fulfill(
      json({
        features: [
          {
            type: "Feature",
            properties: { summary: { duration: 1380, distance: 14484 } },
            geometry: { type: "LineString", coordinates: [[-118.243, 34.055], [-118.30, 34.18]] },
          },
        ],
      })
    );
  });

  let tigerQueryCount = { zip: 0, tract: 0, bg: 0 };
  let decoyQueryCount = 0;
  const tigerUrls = [];
  await page.route("**://tigerweb.geo.census.gov/**", (route) => {
    const url = route.request().url();
    tigerUrls.push(url);
    if (url.includes("/2/query")) {
      // The real service answers a request naming a field it does not carry
      // with a flat 400 - which is how the zip layer broke.
      if (url.includes("ZCTA5CE20")) {
        return route.fulfill(json({ error: { code: 400, message: "Failed to execute query.", details: [] } }));
      }
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
    // School districts live on the same TIGERweb service as the boundaries.
    if (url.includes("/13/query") || url.includes("/14/query") || url.includes("/16/query")) {
      return route.fulfill(json(esriFC([SCHOOL_DISTRICT])));
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
          { id: 13, name: "Elementary School Districts", geometryType: "esriGeometryPolygon" },
          { id: 14, name: "Unified School Districts", geometryType: "esriGeometryPolygon" },
          { id: 15, name: "Unified School Districts Labels", geometryType: "esriGeometryPoint" },
          { id: 16, name: "Secondary School Districts", geometryType: "esriGeometryPolygon" },
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
    step(
      "the zip query asks only for fields the service actually has",
      !tigerUrls.some((u) => u.includes("/2/query") && u.includes("ZCTA5CE20")),
      "ZCTA5CE20 belongs to the shapefile, not this service, and a 400 kills the whole layer"
    );

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

    // --- The address card: assigned schools at this exact point ---
    // Separate from the block group card on purpose: a block group can
    // straddle two attendance zones, so only the pin's own coordinates
    // resolve the assignment.
    await page.waitForTimeout(700);
    const addressCard = await page.locator("#address-card").innerText();
    step(
      "picking an address raises a card for that address, not for its block group",
      (await page.locator("#address-card").isVisible()) && /this address/i.test(addressCard),
      addressCard.replace(/\n/g, " ").slice(0, 90)
    );
    step(
      "the address card names the assigned school for each level",
      addressCard.includes("Spring Street Elementary") &&
        addressCard.includes("Civic Center Middle") &&
        addressCard.includes("Downtown Senior High"),
      addressCard.replace(/\n/g, " ").slice(0, 200)
    );
    step(
      "it says magnets and permits are not address-based, and links to the district's own tool",
      /magnets|zones of choice/i.test(addressCard) &&
        (await page.locator('#address-card a[href*="rsi.lausd.net"]').count()) === 1,
      addressCard.replace(/\n/g, " ").slice(-140)
    );
    step(
      "the assignment is read at the address's own coordinates",
      zoneQueries.some((u) => u.includes("34.0537") || u.includes("34.05")),
      (zoneQueries[zoneQueries.length - 1] || "").slice(0, 110)
    );

    // --- Clear-pin button ---
    step("clear-pin button appears once a pin exists", await page.locator("#clear-pin").isVisible());
    await page.click("#clear-pin");
    await page.waitForTimeout(300);
    step(
      "clearing the pin takes the address card with it",
      !(await page.locator("#address-card").isVisible())
    );
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
      "ZIP, household size, education % and both income figures are highlighted",
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

    // --- Home prices from the assessor roll ---
    const priceCard = await page.locator("#detail-panel").innerText();
    step(
      "card has a Home prices section for single-family homes",
      /home prices/i.test(priceCard),
      priceCard.replace(/\n/g, " ").match(/Home prices.{0,60}/i)
    );
    // The table is the point: one row per year, most recent first.
    const priceTable = await page.evaluate(() =>
      [...document.querySelectorAll("#detail-panel .price-table tbody tr")].map((tr) =>
        [...tr.children].map((td) => td.textContent.trim())
      )
    );
    step(
      "the price table has one row per year, newest first",
      priceTable.length === 2 && priceTable[0][0] === "2024" && priceTable[1][0] === "2021",
      JSON.stringify(priceTable.map((r) => r[0]))
    );
    step(
      "each row carries median, 10th, 90th, $/sqft, sales and turnover",
      priceTable[1][1] === "$1.10M" &&
        priceTable[1][2] === "$890k" &&
        priceTable[1][3] === "$1.40M" &&
        priceTable[1][4] === "$690" &&
        priceTable[1][5] === "9" &&
        priceTable[1][6] === "4.3%",
      JSON.stringify(priceTable[1])
    );
    step(
      "a year with too few sales shows no fake spread and flags the count",
      priceTable[0][2] === "-" && priceTable[0][3] === "-",
      JSON.stringify(priceTable[0])
    );
    // --- Listings for the selected block group ---
    step(
      "the selected block group's listings appear as dots",
      (await page.evaluate(() => {
        let n = 0;
        BlockGroupApp.state.map.eachLayer((l) => {
          if (l.options && l.options.fillColor === "#b3261e") n += 1;
        });
        return n;
      })) === 3,
      "block group A has three listings, block group C has one"
    );
    step(
      "the folder is read as a directory index, not a hand-maintained manifest",
      listingsIndexRequests >= 1,
      `${listingsIndexRequests} index request(s)`
    );
    step(
      "a non-CSV file in the same folder is ignored",
      (await page.evaluate(() => BlockGroupApp.state.listingsMeta.files.map((f) => f.file))).join(",") ===
        "redfin_20260702100000.csv,redfin_20260909160153.csv",
      JSON.stringify(await page.evaluate(() => BlockGroupApp.state.listingsMeta.files.map((f) => f.file)))
    );
    step(
      "the MLS notice row under the header is skipped, not read as a home",
      (await page.evaluate(() => BlockGroupApp.state.listingsData.length)) === 4,
      "four homes across two files, deduplicated"
    );
    step(
      "an address containing a comma keeps every later column in place",
      await page.evaluate(() => {
        const l = BlockGroupApp.state.listingsData.find((r) => r.lat === 34.05 && r.lon === -118.25);
        return l && l.address === "331 N Reese Pl, Unit A" && l.price === 1400000 && l.sqft === 1921;
      })
    );
    step(
      "a lot size under an acre's worth of units is read as acres, not square feet",
      (await page.evaluate(() => {
        const l = BlockGroupApp.state.listingsData.find((r) => r.address === "1 Ranch Rd");
        return l && l.lotSqft;
      })) === 21780,
      "0.5 in the file means half an acre"
    );
    step(
      "a listing in a DIFFERENT block group is not drawn",
      await page.evaluate(() => {
        // Block group C's listing sits east of -118.22; A's two sit west of it.
        let found = false;
        BlockGroupApp.state.map.eachLayer((l) => {
          if (l.getLatLng && l.options && l.options.fillColor === "#b3261e" && l.getLatLng().lng > -118.22) {
            found = true;
          }
        });
        return !found;
      })
    );

    await page.evaluate(() => {
      BlockGroupApp.state.map.eachLayer((l) => {
        if (l.getLatLng && l.options && l.options.fillColor === "#b3261e" && l.getLatLng().lat === 34.05) {
          l.fire("click", { latlng: l.getLatLng() });
        }
      });
    });
    await page.waitForTimeout(400);
    const houseCard = await page.locator("#house-card").innerText();
    const housePrice = await page.locator("#house-card .house-price").innerText();
    step("clicking a listing opens the house card", await page.locator("#house-card").isVisible());
    step(
      "the block group card stays open alongside it",
      (await page.locator(".leaflet-popup").count()) === 1 && (await page.locator("#detail-panel .detail-card").count()) === 1,
      "both cards readable at once"
    );
    step(
      "price leads the card, with both per-square-foot rates",
      housePrice.startsWith("$1,400,000") && houseCard.includes("$729") && houseCard.includes("$208"),
      `${housePrice} | ${(houseCard.match(/\$\d+\/ft.{0,30}/g) || []).join(" ")}`
    );
    // Listed 2026-09-02; the file said 7 days on the day it was downloaded.
    // The card must count forward from the listing date, not repeat the 7.
    // The label carries an info icon, so match across whatever sits between.
    const domText = (houseCard.match(/Days on market\D*(\d+)/) || [])[1];
    step(
      "days on market is counted from the listing date, not copied from the file",
      Number(domText) >= 7,
      `card says ${domText} days; the export said 7 on 2026-09-09`
    );
    step(
      "the card carries the Redfin link, opening in a new tab",
      (await page.locator('#house-card a[href*="redfin.com"][target="_blank"]').count()) === 1
    );
    step(
      "a listing first seen in the latest download is flagged NEW, an older one is not",
      (await page.locator("#house-card .new-badge").count()) === 1,
      "331 N Reese first appeared in this download"
    );

    // Another house in the SAME block group: swap the house card, keep the
    // block group card.
    await page.evaluate(() => {
      BlockGroupApp.state.map.eachLayer((l) => {
        if (l.getLatLng && l.options && l.options.fillColor && l.getLatLng().lat === 34.052) {
          l.fire("click", { latlng: l.getLatLng() });
        }
      });
    });
    await page.waitForTimeout(400);
    const secondPrice = await page.locator("#house-card .house-price").innerText();
    step(
      "clicking another house in the same block group swaps the house card only",
      secondPrice.startsWith("$995,000") && (await page.locator(".leaflet-popup").count()) === 1,
      secondPrice
    );
    step(
      "a listing seen in an earlier download is not flagged NEW",
      (await page.locator("#house-card .new-badge").count()) === 0
    );

    // --- What you decide about a house ---
    // The card is showing 322 S Lincoln St, which was already in the July
    // download.
    step(
      "the card says when the home entered your list, not when it was listed",
      /In your list since\D*2026-07-02/.test(await page.locator("#house-card").innerText()),
      (await page.locator("#house-card").innerText()).split("\n").find((l) => /In your list/.test(l))
    );
    step(
      "an untouched house offers Remove and Not interested",
      (await page.locator('#house-card [data-act="remove"]').count()) === 1 &&
        (await page.locator('#house-card [data-act="not-interested"]').count()) === 1
    );

    // Not interested: asks why, records it, greys the dot.
    step(
      "the reason box is out of the way until Not interested is clicked",
      !(await page.locator("#house-card .house-reason").isVisible())
    );
    await page.locator('#house-card [data-act="not-interested"]').click();
    await page.waitForTimeout(200);
    step(
      "clicking Not interested asks why",
      await page.locator("#house-card .house-reason input").isVisible()
    );
    await page.locator("#house-card .house-reason input").fill("Backs onto the 5");
    await page.locator('#house-card .house-reason button[type="submit"]').click();
    await page.waitForTimeout(400);
    const coldText = await page.locator("#house-card").innerText();
    step(
      "the reason is shown above the price, where it is read before anything else",
      coldText.indexOf("Backs onto the 5") < coldText.indexOf("$995,000") &&
        coldText.includes("Not interested"),
      coldText.split("\n").slice(0, 4).join(" | ")
    );
    step(
      "and the buttons become Remove and Interested, so it can be undone",
      (await page.locator('#house-card [data-act="interested"]').count()) === 1 &&
        (await page.locator('#house-card [data-act="not-interested"]').count()) === 0
    );
    step(
      "the dot greys out rather than disappearing",
      await page.evaluate(() => {
        let grey = 0;
        BlockGroupApp.state.map.eachLayer((l) => {
          if (l.getLatLng && l.options && l.options.fillColor === "#98a2ac") grey += 1;
        });
        return grey === 1;
      })
    );
    step(
      "the verdict survives a reload, because it is kept in this browser",
      await page.evaluate(() => {
        const store = JSON.parse(localStorage.getItem("la-home-map.listings.v1"));
        const note = store["https://www.redfin.com/CA/Burbank/322-S-Lincoln-St-91506/home/5327903"];
        return note.status === "notInterested" && note.reason === "Backs onto the 5" && !!note.added;
      })
    );

    await page.locator('#house-card [data-act="interested"]').click();
    await page.waitForTimeout(400);
    step(
      "clicking Interested clears the verdict and the grey",
      (await page.locator("#house-card .house-cold").count()) === 0 &&
        (await page.locator('#house-card [data-act="not-interested"]').count()) === 1 &&
        (await page.evaluate(() => {
          let grey = 0;
          BlockGroupApp.state.map.eachLayer((l) => {
            if (l.getLatLng && l.options && l.options.fillColor === "#98a2ac") grey += 1;
          });
          return grey === 0;
        }))
    );

    // Remove: for a home that has sold or been withdrawn.
    await page.locator('#house-card [data-act="remove"]').click();
    await page.waitForTimeout(400);
    step(
      "Remove closes the card and takes the dot off the map",
      !(await page.locator("#house-card").isVisible()) &&
        (await page.evaluate(() => {
          let n = 0;
          BlockGroupApp.state.map.eachLayer((l) => {
            if (l.options && l.options.fillColor === "#b3261e") n += 1;
          });
          return n;
        })) === 2
    );
    // A removal made BEFORE the newest download is a stale verdict: the home
    // is still being published, so it is still for sale.
    await page.evaluate(() => {
      const key = "la-home-map.listings.v1";
      const store = JSON.parse(localStorage.getItem(key));
      store["https://www.redfin.com/CA/Burbank/322-S-Lincoln-St-91506/home/5327903"].statusAt =
        "2026-08-01T00:00:00.000Z";
      localStorage.setItem(key, JSON.stringify(store));
    });
    await page.evaluate(() => BlockGroupApp.reloadListingsForTest());
    await page.waitForTimeout(500);
    step(
      "a home you removed comes back when a newer download still carries it",
      (await page.evaluate(() => {
        let n = 0;
        BlockGroupApp.state.map.eachLayer((l) => {
          if (l.options && l.options.fillColor === "#b3261e") n += 1;
        });
        return n;
      })) === 3,
      "still being published means still for sale"
    );
    step(
      "a removal made after the newest download stands",
      await page.evaluate(async () => {
        const key = "la-home-map.listings.v1";
        const id = "https://www.redfin.com/CA/Burbank/322-S-Lincoln-St-91506/home/5327903";
        const store = JSON.parse(localStorage.getItem(key));
        store[id] = { ...store[id], status: "removed", statusAt: new Date().toISOString() };
        localStorage.setItem(key, JSON.stringify(store));
        await BlockGroupApp.reloadListingsForTest();
        let n = 0;
        BlockGroupApp.state.map.eachLayer((l) => {
          if (l.options && l.options.fillColor === "#b3261e") n += 1;
        });
        // Put it back so the counts below are the ones the rest of the run
        // expects.
        const after = JSON.parse(localStorage.getItem(key));
        delete after[id].status;
        delete after[id].statusAt;
        localStorage.setItem(key, JSON.stringify(after));
        await BlockGroupApp.reloadListingsForTest();
        return n === 2;
      })
    );

    // A different block group closes both, then opens the new one.
    await page.evaluate(() => {
      BlockGroupApp.state.layers.blockGroup.eachLayer((l) => {
        if (l.feature.properties.GEOID === "060372011003") l.fire("click");
      });
    });
    await page.waitForTimeout(500);
    step(
      "switching block group closes the house card",
      !(await page.locator("#house-card").isVisible())
    );
    step(
      "and swaps in that block group's listings",
      (await page.evaluate(() => {
        let n = 0;
        BlockGroupApp.state.map.eachLayer((l) => {
          if (l.options && l.options.fillColor === "#b3261e") n += 1;
        });
        return n;
      })) === 1
    );
    step(
      "a block group's homes are worked out from its own polygon, with no lookup table",
      await page.evaluate(() => {
        let inside = true;
        BlockGroupApp.state.map.eachLayer((l) => {
          if (l.getLatLng && l.options && l.options.fillColor === "#b3261e") {
            inside = inside && l.getLatLng().lng > -118.22;
          }
        });
        return inside;
      }),
      "the one dot left is the one inside block group C"
    );
    // Closing the block group card is a deselection: its houses go with it,
    // rather than being left floating over a block group nothing is showing.
    await page.evaluate(() => BlockGroupApp.state.map.closePopup());
    await page.waitForTimeout(400);
    step(
      "closing the block group card takes its houses off the map too",
      await page.evaluate(() => {
        let n = 0;
        BlockGroupApp.state.map.eachLayer((l) => {
          if (l.getLatLng && l.options && /^#(b3261e|98a2ac|7f1d1d)$/.test(l.options.fillColor || "")) n += 1;
        });
        return n === 0;
      })
    );
    await page.evaluate(() => {
      BlockGroupApp.state.layers.blockGroup.eachLayer((l) => {
        if (l.feature.properties.GEOID === "060372011001") l.fire("click");
      });
    });
    await page.waitForTimeout(400);

    // --- Data sources table ---
    await page.evaluate(() => document.getElementById("sources-details").setAttribute("open", "open"));
    await page.waitForTimeout(300);
    const sourceRows = await page.evaluate(() =>
      [...document.querySelectorAll("#source-table tbody tr")].map((tr) =>
        [...tr.children].map((td) => td.textContent.trim())
      )
    );
    step(
      "the sources table lists every layer with a one-line description",
      sourceRows.length >= 15 && sourceRows.every((r) => r[0] && r[1]),
      `${sourceRows.length} sources listed`
    );
    step(
      "live services say live, and file-backed ones give the date they were built",
      sourceRows.some((r) => r[2] === "live") &&
        sourceRows.some((r) => /2026-09-09/.test(r[2])),
      JSON.stringify(sourceRows.filter((r) => /listing|Home prices/i.test(r[0])).map((r) => [r[0], r[2]]))
    );
    step(
      "the listings row names Redfin as the source",
      sourceRows.some((r) => /listings/i.test(r[0]) && /redfin/i.test(r[1])),
      JSON.stringify(sourceRows.find((r) => /listings/i.test(r[0])))
    );

    // --- The sales behind a count ---
    step(
      "the sales count is clickable, the other cells are not",
      (await page.locator("#detail-panel .price-table .sales-link").count()) === 2,
      `${await page.locator("#detail-panel .price-table .sales-link").count()} clickable counts`
    );
    step("no sale detail is fetched until a count is clicked", !(await page.locator("#sales-panel").isVisible()));

    await page.click('#detail-panel .price-table .sales-link[data-year="2021"]');
    await page.waitForTimeout(600);
    step("clicking a count opens the sales panel", await page.locator("#sales-panel").isVisible());
    const salesRows = await page.evaluate(() =>
      [...document.querySelectorAll("#sales-panel .sales-table tbody tr")].map((tr) =>
        [...tr.children].map((td) => td.textContent.trim())
      )
    );
    step(
      "it lists one row per sale that year, and only that year",
      salesRows.length === 3,
      `${salesRows.length} rows for 2021 (2024 has 1)`
    );
    step(
      "each row carries address, date, size, year built and the values that net to the total",
      salesRows[0][0].includes("Bunker Hill") &&
        salesRows[0][1] === "2021-09-02" &&
        salesRows[0][2] === "2,100" &&
        salesRows[0][3] === "1962" &&
        salesRows[0][4] === "$900,000" &&
        salesRows[0][5] === "$500,000" &&
        salesRows[0][7] === "$1,400,000",
      JSON.stringify(salesRows[0])
    );
    step(
      "rows are dearest first, so the top of the range is the first thing read",
      Number(salesRows[0][7].replace(/\D/g, "")) > Number(salesRows[2][7].replace(/\D/g, "")),
      salesRows.map((r) => r[7]).join(" > ")
    );
    step(
      "an exemption is shown as the subtraction it is",
      salesRows.some((r) => r[6].startsWith("-$")),
      JSON.stringify(salesRows.map((r) => r[6]))
    );
    await page.click('#detail-panel .price-table .sales-link[data-year="2024"]');
    await page.waitForTimeout(400);
    step(
      "clicking another year swaps the panel's contents rather than stacking panels",
      (await page.locator("#sales-panel").count()) === 1 &&
        (await page.locator("#sales-panel .sales-table tbody tr").count()) === 1
    );
    await page.click("#sales-panel .sales-close");
    await page.waitForTimeout(200);
    step("the panel closes", !(await page.locator("#sales-panel").isVisible()));

    const turnHeader = await page.evaluate(() => {
      const th = [...document.querySelectorAll("#detail-panel .price-table th")].pop();
      return th ? th.textContent.replace(/\s+/g, " ").trim() : "";
    });
    step(
      "the turnover column header says what the percentage is out of",
      /of 210/.test(turnHeader),
      turnHeader
    );
    step(
      "the block group's single-family total is shown, so turnover can be read",
      priceCard.includes("210 single-family homes"),
      priceCard.replace(/\n/g, " ").match(/\d+ single-family homes.{0,40}/i)
    );
    step(
      "the county median for each year is shown for comparison",
      priceCard.includes("2021 $800k") && priceCard.includes("2024 $950k"),
      priceCard.replace(/\n/g, " ").match(/County-wide.{0,60}/i)
    );
    await page.evaluate(() => {
      BlockGroupApp.state.layers.blockGroup.eachLayer((l) => {
        if (l.feature.properties.GEOID === "060372011003") l.fire("click");
      });
    });
    await page.waitForTimeout(300);
    // Block group 3's fixture has no `years` - the shape an older parcel file
    // has. Headers over an empty table would read as "no sales here".
    const thinCard = await page.locator("#detail-panel").innerText();
    step(
      "a parcel file with no year data falls back to the pooled figure and says why",
      /home prices/i.test(thinCard) &&
        thinCard.includes("$640,000") &&
        /predates the year-by-year table/i.test(thinCard),
      thinCard.replace(/\n/g, " ").match(/Home prices.{0,140}/i)
    );
    step(
      "and it does not render an empty table",
      (await page.locator("#detail-panel .price-table").count()) === 0
    );
    const priceMetrics = await page.evaluate(() =>
      [...document.querySelectorAll("#filter-metric-0 option")].map((o) => o.value)
    );
    step(
      "price and price-per-sqft are filterable",
      priceMetrics.includes("medianSalePrice") && priceMetrics.includes("pricePerSqft"),
      JSON.stringify(priceMetrics.filter((m) => /price/i.test(m)))
    );
    // Price lives on the parcel file keyed by GEOID, not in the census record,
    // so filtering has to reach the polygon's own properties.
    await page.evaluate(() => {
      BlockGroupApp.state.filters[0].enabled = true;
      BlockGroupApp.state.filters[0].metric = "medianSalePrice";
      BlockGroupApp.state.filters[0].op = "above";
      BlockGroupApp.state.filters[0].value = "1000000";
      BlockGroupApp.refreshFiltersForTest();
    });
    await page.waitForTimeout(300);
    step(
      "filtering on price matches only the block group above the threshold",
      (await page.locator("#filter-summary").innerText()).includes("1 of 3"),
      await page.locator("#filter-summary").innerText()
    );
    await page.evaluate(() => {
      BlockGroupApp.state.filters[0].enabled = false;
      BlockGroupApp.refreshFiltersForTest();
    });
    await page.evaluate(() => {
      BlockGroupApp.state.layers.blockGroup.eachLayer((l) => {
        if (l.feature.properties.GEOID === "060372011001") l.fire("click");
      });
    });
    await page.waitForTimeout(300);

    // --- Commute from the dropped pin to a typed destination ---
    await page.fill("#destination-input", "500 S Buena Vista St, Burbank");
    await page.dispatchEvent("#destination-input", "change");
    await page.waitForTimeout(800);
    step(
      "with no pin down yet, the destination is set and says what is missing",
      /drop a pin/i.test(await page.locator("#commute-status").innerText()),
      await page.locator("#commute-status").innerText()
    );
    await page.click("#drop-pin");
    await page.evaluate(() => {
      BlockGroupApp.state.map.fire("click", { latlng: L.latLng(34.055, -118.243) });
    });
    await page.waitForTimeout(900);
    const commuteText = await page.locator("#commute-status").innerText();
    step(
      "dropping a pin routes to the destination and reports the drive",
      /23 min/.test(commuteText) && /9\.0 mi/.test(commuteText),
      commuteText.replace(/\n/g, " ")
    );
    step(
      "the drive time is labelled free-flow, because no free router models traffic",
      /free-flow/i.test(commuteText) && /traffic/i.test(commuteText),
      commuteText.replace(/\n/g, " ").slice(-90)
    );
    step(
      "the route is drawn on the map",
      (await page.evaluate(() => !!document.querySelector("path[stroke='#1b4d8c'], canvas"))) &&
        orsRequests.length === 1, // one destination, one route - not one per keystroke
      `${orsRequests.length} routing request(s)`
    );
    step(
      "the key is sent from the key file, not hardcoded",
      orsRequests[0].includes("api_key=5b3ce3597851110001cf6248TESTKEY"),
      orsRequests[0].replace(/api_key=([^&]{12}).*/, "api_key=$1...")
    );
    await page.click("#clear-destination");
    await page.waitForTimeout(200);
    step("clearing the destination clears the commute line", (await page.locator("#commute-status").innerText()) === "");
    await page.click("#clear-pin");
    await page.waitForTimeout(200);

    // --- Housing stock, tenure and work, from the new ACS tables ---
    const acsCard = await page.locator("#detail-panel").innerText();
    step(
      "card shows detached-house share, which density alone cannot tell you",
      /detached houses/i.test(acsCard) && acsCard.includes("60.0%"),
      acsCard.replace(/\n/g, " ").match(/Detached houses.{0,20}/i)
    );
    step(
      "card shows owner-occupancy, computed over occupied units not population",
      /owner-occupied/i.test(acsCard) && acsCard.includes("75.0%"),
      acsCard.replace(/\n/g, " ").match(/Owner-occupied.{0,20}/i)
    );
    step(
      "card shows median year built and the pre-1980 share",
      acsCard.includes("1962") && acsCard.includes("50%"),
      acsCard.replace(/\n/g, " ").match(/Median year built.{0,40}/i)
    );
    step(
      "card shows work-from-home, walking and transit shares",
      acsCard.includes("20.0%") && acsCard.includes("5.0%") && acsCard.includes("10.0%"),
      acsCard.replace(/\n/g, " ").match(/Work from home.{0,60}/i)
    );
    const metricKeys = await page.evaluate(() =>
      [...document.querySelectorAll("#filter-metric-0 option")].map((o) => o.value)
    );
    step(
      "the new ACS measures are all available as filters",
      ["detached", "owner", "wfh", "medianYearBuilt", "pre1980"].every((k) => metricKeys.includes(k)),
      JSON.stringify(metricKeys)
    );

    // --- FEMA flood zones ---
    await page.click("#toggle-flood");
    await page.waitForTimeout(700);
    const floodColors = await page.evaluate(() => {
      const out = [];
      BlockGroupApp.state.layers.flood.eachLayer((l) => out.push([l.feature.properties.FLD_ZONE, l.options.fillColor]));
      return out;
    });
    step(
      "AE draws as high risk and X as low, not the same colour",
      floodColors.find((c) => c[0] === "AE")[1] === "#dc2626" &&
        floodColors.find((c) => c[0] === "X")[1] !== "#dc2626",
      JSON.stringify(floodColors)
    );
    step(
      "a shaded X (0.2% chance) is told apart from a plain X by its subtype",
      floodColors.find((c) => c[0] === "X")[1] === "#fbbf24",
      JSON.stringify(floodColors)
    );
    await page.evaluate(() => {
      BlockGroupApp.state.layers.blockGroup.eachLayer((l) => {
        if (l.feature.properties.GEOID === "060372011001") l.fire("click");
      });
    });
    await page.waitForTimeout(400);
    const floodCard = await page.locator("#detail-panel").innerText();
    step(
      "the card reports the FEMA zone under this block group",
      /FEMA zone/i.test(floodCard) && /\bAE\b/.test(floodCard),
      floodCard.replace(/\n/g, " ").match(/FEMA zone.{0,60}/i)
    );
    step(
      "a 1%-floodplain zone is highlighted as a key figure, an X zone would not be",
      await page.evaluate(() =>
        [...document.querySelectorAll("#detail-panel .key-figure")].some((el) => el.textContent.trim() === "AE")
      )
    );

    // --- CGS liquefaction + landslide, from two separate services ---
    await page.click("#toggle-seismic");
    await page.waitForTimeout(800);
    const seismicKinds = await page.evaluate(() => {
      const out = [];
      BlockGroupApp.state.layers.seismic.eachLayer((l) =>
        out.push([l.feature.properties.HAZARD_KIND, l.options.fillColor])
      );
      return out.sort();
    });
    step(
      "both CGS services are drawn, not just the first that answered",
      seismicKinds.length === 2 &&
        seismicKinds.some((k) => k[0] === "liquefaction") &&
        seismicKinds.some((k) => k[0] === "landslide"),
      JSON.stringify(seismicKinds)
    );
    step(
      "liquefaction and landslide are coloured differently",
      seismicKinds[0][1] !== seismicKinds[1][1],
      JSON.stringify(seismicKinds)
    );

    // --- Noise: aviation and surface, kept apart ---
    await page.click("#toggle-noise");
    await page.waitForTimeout(1200);
    const aviationUrl = await page.evaluate(() => {
      const img = document.querySelector('.leaflet-rasterOverlay-pane img[src*="/tile/"]');
      return img ? img.src : null;
    });
    step(
      "aviation picks the newest CONUS aviation-only service",
      aviationUrl && aviationUrl.includes("NTAD_Noise_2020_CONUS_aviation/"),
      aviationUrl && aviationUrl.split("/services/")[1]
    );
    step(
      "it does not pick an Alaska service",
      aviationUrl && !/alaska/i.test(aviationUrl),
      aviationUrl && aviationUrl.split("/services/")[1]
    );
    step(
      "it does not pick a combined aviation+road service, which is how road noise leaked in",
      aviationUrl && !/aviation_road/i.test(aviationUrl),
      aviationUrl && aviationUrl.split("/services/")[1]
    );
    step(
      "the cache's top zoom is read from the service, so zooming past it upscales instead of failing",
      await page.evaluate(() => {
        let found = null;
        BlockGroupApp.state.map.eachLayer((l) => {
          if (l.options && l.options.pane === "rasterOverlay" && l.options.maxNativeZoom) {
            found = l.options.maxNativeZoom;
          }
        });
        return found === 13;
      }),
      "the mocked cache stops at level 13"
    );
    const noiseLegend = await page.locator("#noise-legend").innerText();
    step(
      "the legend comes from the service, so it matches what is drawn",
      /45 - 55 dB/.test(noiseLegend) && /65 - 75 dB/.test(noiseLegend),
      noiseLegend.replace(/\n/g, " | ").slice(0, 120)
    );
    step(
      "the legend swatches are the service's own images, not our approximations",
      (await page.locator("#noise-legend img.swatch").count()) === 3
    );

    await page.click("#toggle-noise-surface");
    await page.waitForTimeout(1200);
    const surfaceUrl = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('.leaflet-rasterOverlay-pane img[src*="/tile/"]')].map((i) => i.src);
      return imgs.find((u) => /road|rail/i.test(u)) || null;
    });
    step(
      "road & rail is a separate layer with its own service",
      surfaceUrl && /NTAD_Noise_2020_CONUS_(road|rail)/.test(surfaceUrl),
      surfaceUrl && surfaceUrl.split("/services/")[1]
    );
    step(
      "both noise layers can be on at once without one replacing the other",
      aviationUrl && surfaceUrl && aviationUrl !== surfaceUrl
    );
    await page.click("#toggle-noise-surface");
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      BlockGroupApp.state.layers.blockGroup.eachLayer((l) => {
        if (l.feature.properties.GEOID === "060372011001") l.fire("click");
      });
    });
    await page.waitForTimeout(600);

    await page.click("#toggle-flood");
    await page.click("#toggle-seismic");
    await page.click("#toggle-noise");
    await page.waitForTimeout(300);
    step(
      "turning the hazard layers off removes them",
      (await page.evaluate(() => !BlockGroupApp.state.layers.flood && !BlockGroupApp.state.layers.seismic)) &&
        (await page.locator('img[src*="/tile/"]').count()) === 0
    );

    // --- Schools: dots, zones, districts ---
    await page.click("#toggle-schools");
    await page.waitForTimeout(700);
    const schoolDots = await page.evaluate(() => {
      const out = [];
      BlockGroupApp.state.layers.schools.eachLayer((l) =>
        out.push({
          name: l.feature.properties.SchoolName,
          color: l.options.fillColor,
        })
      );
      return out;
    });
    step(
      "closed school sites are not drawn",
      schoolDots.length === 3 && !schoolDots.some((d) => /Closed/.test(d.name)),
      JSON.stringify(schoolDots.map((d) => d.name))
    );
    step(
      "school dots are colour-coded elementary / middle / high",
      schoolDots.find((d) => /Elementary/.test(d.name)).color === "#2a7fbf" &&
        schoolDots.find((d) => /Middle/.test(d.name)).color === "#7b3fa0" &&
        schoolDots.find((d) => /High/.test(d.name)).color === "#c2410c",
      JSON.stringify(schoolDots)
    );
    step(
      "a K-5 span is read as elementary and a 9-12 span as high, not both",
      schoolDots.find((d) => /Elementary/.test(d.name)).color !==
        schoolDots.find((d) => /High/.test(d.name)).color
    );
    const schoolsLegend = await page.locator("#schools-legend").innerText();
    step(
      "the school legend names the three levels",
      /elementary/i.test(schoolsLegend) && /middle/i.test(schoolsLegend) && /high/i.test(schoolsLegend),
      schoolsLegend.replace(/\n/g, " | ")
    );

    // Clicking a dot outlines that school's district. The polygon is fetched
    // for that one point, so nothing is downloaded until something is clicked.
    step(
      "no district is drawn before any school is clicked",
      !(await page.evaluate(() => !!BlockGroupApp.state.districtLayer))
    );
    await page.evaluate(() => {
      BlockGroupApp.state.layers.schools.eachLayer((l) => {
        if (l.feature.properties.SchoolName === "Civic Center Middle") l.fire("click", { latlng: l.getLatLng() });
      });
    });
    await page.waitForTimeout(900);
    step(
      "clicking a school outlines its district",
      await page.evaluate(() => !!BlockGroupApp.state.districtLayer),
      JSON.stringify(tigerUrls.filter((u) => /\/1[3-6]\/query/.test(u)).map((u) => u.match(/\/(\d+)\/query/)[1]))
    );
    step(
      "the district is found by asking which polygon contains the school",
      tigerUrls.some((u) => /\/1[346]\/query/.test(u) && u.includes("esriGeometryPoint")),
      (tigerUrls.find((u) => u.includes("esriGeometryPoint")) || "").slice(0, 110)
    );
    step(
      "the district label sublayer is never queried",
      !tigerUrls.some((u) => u.includes("/15/query"))
    );
    const districtLog = await page.locator("#status-log").innerText();
    step(
      "the status log names the district the school belongs to",
      /Los Angeles Unified/.test(districtLog),
      (districtLog.split("\n").find((l) => /is in /.test(l)) || "").slice(0, 110)
    );

    // The card still names the assigned schools - that lookup is a point
    // query against LAUSD's zones, and never needed a drawn layer.
    await page.evaluate(() => {
      BlockGroupApp.state.layers.blockGroup.eachLayer((l) => {
        if (l.feature.properties.GEOID === "060372011001") l.fire("click");
      });
    });
    await page.waitForTimeout(700);
    const schoolCard = await page.locator("#detail-panel").innerText();
    step(
      "the card names the assigned elementary, middle and high school",
      schoolCard.includes("Spring Street Elementary") &&
        schoolCard.includes("Civic Center Middle") &&
        schoolCard.includes("Downtown Senior High"),
      schoolCard.slice(schoolCard.toUpperCase().indexOf("SCHOOLS")).replace(/\n/g, " ").slice(0, 160)
    );
    step(
      "the zone service is asked by point, never for whole polygons",
      zoneQueries.length > 0 && zoneQueries.every((u) => u.includes("esriGeometryPoint")),
      `${zoneQueries.length} point queries`
    );
    step(
      "the 'Key Codes' lookup layer is never queried",
      !zoneQueries.some((u) => u.includes("/7/query"))
    );

    await page.click("#toggle-schools");
    await page.waitForTimeout(300);
    step(
      "turning schools off clears the district outline too",
      !(await page.evaluate(() => !!BlockGroupApp.state.districtLayer))
    );

    // --- Income filters step in $5k ---
    await page.selectOption("#filter-metric-0", "medianIncome");
    await page.waitForTimeout(150);
    step(
      "the median income filter steps in $5,000",
      (await page.getAttribute("#filter-value-0", "step")) === "5000",
      await page.getAttribute("#filter-value-0", "step")
    );
    await page.selectOption("#filter-metric-0", "perCapitaIncome");
    await page.waitForTimeout(150);
    step(
      "per-capita income steps in $5,000 too",
      (await page.getAttribute("#filter-value-0", "step")) === "5000"
    );
    await page.selectOption("#filter-metric-0", "bachelors");
    await page.waitForTimeout(150);
    step(
      "a percentage filter is not forced onto a $5,000 step",
      (await page.getAttribute("#filter-value-0", "step")) === "any",
      await page.getAttribute("#filter-value-0", "step")
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
    step(
      "the pin is reverse-geocoded",
      reverseQueries.length >= 1 && reverseQueries[reverseQueries.length - 1].includes("format=jsonv2"),
      `${reverseQueries.length} reverse lookup(s)`
    );
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
    fs.rmSync(parcelPath, { force: true });
    fs.rmSync(salesPath, { force: true });
    fs.rmSync(orsKeyPath, { force: true });
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
