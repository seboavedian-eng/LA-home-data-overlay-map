// Fixture API responses shaped like the real endpoints in js/config.js,
// used only for local Playwright testing (route interception) - never
// shipped in the app itself.

function ring(coords) {
  return [[...coords, coords[0]]];
}

const ZCTA_90012 = {
  type: "Feature",
  properties: { ZCTA5CE20: "90012" },
  geometry: {
    type: "Polygon",
    coordinates: ring([
      [-118.30, 34.00],
      [-118.30, 34.10],
      [-118.15, 34.10],
      [-118.15, 34.00],
    ]),
  },
};
const ZCTA_90210 = {
  type: "Feature",
  properties: { ZCTA5CE20: "90210" },
  geometry: {
    type: "Polygon",
    coordinates: ring([
      [-118.45, 34.05],
      [-118.45, 34.12],
      [-118.38, 34.12],
      [-118.38, 34.05],
    ]),
  },
};

const CITY_LA = {
  type: "Feature",
  properties: { CITY_NAME: "Los Angeles" },
  geometry: {
    type: "Polygon",
    coordinates: ring([
      [-118.50, 33.90],
      [-118.50, 34.30],
      [-118.00, 34.30],
      [-118.00, 33.90],
    ]),
  },
};

const FIRE_SRA_MODERATE = {
  type: "Feature",
  properties: { HAZ_CLASS: "Moderate" },
  geometry: {
    type: "Polygon",
    coordinates: ring([
      [-118.35, 33.95],
      [-118.35, 34.15],
      [-118.10, 34.15],
      [-118.10, 33.95],
    ]),
  },
};
const FIRE_LRA_HIGH = {
  type: "Feature",
  properties: { HAZ_CLASS: "High" },
  geometry: {
    type: "Polygon",
    coordinates: ring([
      [-118.60, 34.20],
      [-118.60, 34.25],
      [-118.55, 34.25],
      [-118.55, 34.20],
    ]),
  },
};

const DISTRICT_LAUSD = {
  type: "Feature",
  properties: { DistrictName: "Los Angeles Unified" },
  geometry: {
    type: "Polygon",
    coordinates: ring([
      [-118.50, 33.90],
      [-118.50, 34.30],
      [-118.00, 34.30],
      [-118.00, 33.90],
    ]),
  },
};

function schoolPoint(name, level, district, lon, lat) {
  return {
    type: "Feature",
    properties: {
      SchoolName: name,
      DistrictName: district,
      EILCode: level,
      Street: "123 Test St",
      City: "Los Angeles",
      Zip: "90012",
      StatusType: "Active",
      CDSCode: "19647330000000",
    },
    geometry: { type: "Point", coordinates: [lon, lat] },
  };
}

const SCHOOLS = [
  schoolPoint("Central Elementary", "Elementary", "Los Angeles Unified", -118.2440, 34.0540),
  schoolPoint("Downtown Middle", "Middle", "Los Angeles Unified", -118.2460, 34.0560),
  schoolPoint("Metro High", "High", "Los Angeles Unified", -118.2500, 34.0600),
  schoolPoint("Eastside Elementary", "Elementary", "Los Angeles Unified", -118.2200, 34.0400),
  schoolPoint("Northside High", "High", "Los Angeles Unified", -118.1800, 34.1200),
  schoolPoint("Far Away School", "Elementary", "Some Other District", -118.90, 34.70),
];

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
  ZCTA_90012, ZCTA_90210, CITY_LA, FIRE_SRA_MODERATE, FIRE_LRA_HIGH,
  DISTRICT_LAUSD, SCHOOLS, CENSUS_ROWS, GEOCODER_RESPONSE,
  fc: (features) => ({ type: "FeatureCollection", features }),
};
