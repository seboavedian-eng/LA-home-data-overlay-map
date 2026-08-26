// Fixture API responses shaped like the real endpoints in js/config.js,
// used only for local Playwright testing (route interception) - never
// shipped in the app itself.
//
// IMPORTANT: these are native Esri JSON (what f=json returns), matching
// what js/utils.js's esriFeatureSetToGeoJSON() now consumes - the app no
// longer requests f=geojson (see README "Known limitations" for why).

function closeRing(coords) {
  return [...coords, coords[0]];
}

// Esri convention: exterior rings wind clockwise, holes counter-clockwise.
const RING_90012 = closeRing([
  [-118.30, 34.00], [-118.30, 34.10], [-118.15, 34.10], [-118.15, 34.00],
]); // clockwise
const RING_90210 = closeRing([
  [-118.45, 34.05], [-118.45, 34.12], [-118.38, 34.12], [-118.38, 34.05],
]); // clockwise

const RING_LA_CITY = closeRing([
  [-118.50, 33.90], [-118.50, 34.30], [-118.00, 34.30], [-118.00, 33.90],
]); // clockwise

// Fire SRA "Moderate" zone: a clockwise exterior ring PLUS a counter-clockwise
// hole ring, positioned away from the test address point (-118.2437, 34.0537)
// so the address is still correctly "inside the hazard zone, outside the
// hole". This is exactly the multi-ring shape that used to render as
// disconnected/stray lines before the ring-nesting fix.
const RING_FIRE_SRA_OUTER = closeRing([
  [-118.35, 33.95], [-118.35, 34.15], [-118.10, 34.15], [-118.10, 33.95],
]); // clockwise
const RING_FIRE_SRA_HOLE = closeRing([
  [-118.30, 34.11], [-118.28, 34.11], [-118.28, 34.13], [-118.30, 34.13],
]); // counter-clockwise hole, far from the test point (this point order
   // is CCW by the same shoelace convention as the app's ringIsClockwise -
   // do not add .reverse() here, that flips it to a second exterior ring)

const RING_FIRE_LRA = closeRing([
  [-118.60, 34.20], [-118.60, 34.25], [-118.55, 34.25], [-118.55, 34.20],
]); // clockwise, doesn't contain the test point

const RING_DISTRICT_LAUSD = RING_LA_CITY;

function esriPolygonFeature(attributes, rings) {
  return { attributes, geometry: { rings } };
}

function esriPointFeature(attributes, x, y) {
  return { attributes, geometry: { x, y } };
}

function esriFC(geometryType, features) {
  return { geometryType, fields: [], features };
}

const CITY_LA_ESRI = esriFC("esriGeometryPolygon", [
  esriPolygonFeature({ CITY_NAME: "Los Angeles" }, [RING_LA_CITY]),
]);

const ZCTA_ESRI = esriFC("esriGeometryPolygon", [
  esriPolygonFeature({ ZCTA5CE20: "90012" }, [RING_90012]),
  esriPolygonFeature({ ZCTA5CE20: "90210" }, [RING_90210]),
]);

const FIRE_SRA_ESRI = esriFC("esriGeometryPolygon", [
  esriPolygonFeature({ HAZ_CLASS: "Moderate" }, [RING_FIRE_SRA_OUTER, RING_FIRE_SRA_HOLE]),
]);
const FIRE_LRA_ESRI = esriFC("esriGeometryPolygon", [
  esriPolygonFeature({ HAZ_CLASS: "High" }, [RING_FIRE_LRA]),
]);

const DISTRICT_LAUSD_ESRI = esriFC("esriGeometryPolygon", [
  esriPolygonFeature({ DistrictName: "Los Angeles Unified" }, [RING_DISTRICT_LAUSD]),
]);

function schoolFeature(name, level, district, lon, lat) {
  return esriPointFeature(
    {
      SchoolName: name,
      DistrictName: district,
      EILCode: level,
      Street: "123 Test St",
      City: "Los Angeles",
      Zip: "90012",
      StatusType: "Active",
      CDSCode: "19647330000000",
    },
    lon,
    lat
  );
}

const SCHOOLS_ESRI = esriFC("esriGeometryPoint", [
  schoolFeature("Central Elementary", "Elementary", "Los Angeles Unified", -118.2440, 34.0540),
  schoolFeature("Downtown Middle", "Middle", "Los Angeles Unified", -118.2460, 34.0560),
  schoolFeature("Metro High", "High", "Los Angeles Unified", -118.2500, 34.0600),
  schoolFeature("Eastside Elementary", "Elementary", "Los Angeles Unified", -118.2200, 34.0400),
  schoolFeature("Northside High", "High", "Los Angeles Unified", -118.1800, 34.1200),
  schoolFeature("Far Away School", "Elementary", "Some Other District", -118.90, 34.70),
]);

const CENSUS_HEADER = [
  "NAME",
  "B03002_001E", "B03002_003E", "B03002_004E", "B03002_005E", "B03002_006E",
  "B03002_007E", "B03002_008E", "B03002_009E", "B03002_012E",
  "B19013_001E", "B19301_001E", "B17001_001E", "B17001_002E",
  "state", "zip code tabulation area",
];
const CENSUS_ROWS = [
  CENSUS_HEADER,
  ["ZCTA5 90012", "25000", "6000", "2500", "100", "8000", "50", "300", "550", "7500", "68000", "42000", "24000", "4800", "06", "90012"],
  ["ZCTA5 90210", "21000", "15000", "400", "50", "3000", "20", "130", "400", "2000", "155000", "110000", "20500", "800", "06", "90210"],
];

const GEOCODER_RESPONSE = {
  result: {
    addressMatches: [
      {
        matchedAddress: "200 N SPRING ST, LOS ANGELES, CA, 90012",
        coordinates: { x: -118.2437, y: 34.0537 },
        addressComponents: { city: "LOS ANGELES", state: "CA", zip: "90012" },
      },
    ],
  },
};

module.exports = {
  ZCTA_ESRI, CITY_LA_ESRI, FIRE_SRA_ESRI, FIRE_LRA_ESRI, DISTRICT_LAUSD_ESRI,
  SCHOOLS_ESRI, CENSUS_ROWS, GEOCODER_RESPONSE,
};
