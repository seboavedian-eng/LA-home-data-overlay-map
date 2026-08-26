// ---------------------------------------------------------------------------
// Central configuration: every external data source the app talks to.
// All of these are public, no-signup government/open-data endpoints except
// where noted. If an endpoint moves, this is the only file that should need
// updating for that layer.
// ---------------------------------------------------------------------------

const CONFIG = {
  // Optional: a free Census API key raises the rate limit. Get one at
  // https://api.census.gov/data/key_signup.html and paste it here.
  // Leave blank to use the small anonymous allowance.
  CENSUS_API_KEY: "",

  // Bounding box around LA County (WGS84), used to spatially filter
  // county-spanning national datasets (ZCTAs, schools) without needing an
  // exact county polygon clip. Generous on purpose (includes the Channel
  // Islands) - a little overinclusion at the edges is fine for v1.
  LA_COUNTY_BBOX: { xmin: -118.95, ymin: 32.70, xmax: -117.60, ymax: 34.85 },

  MAP_CENTER: [34.05, -118.25],
  MAP_ZOOM: 10,

  // Basemap: CARTO Positron, free, no key required.
  BASEMAP_URL: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
  BASEMAP_ATTRIBUTION:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',

  // --- Boundaries ------------------------------------------------------
  // Census TIGERweb: 2020 ZIP Code Tabulation Areas (matches ACS ZCTA-level
  // demographic/income data exactly, unlike USPS ZIP boundaries).
  ZCTA_SERVER: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer",
  ZCTA_LAYER_ID: 2, // "2020 Census ZIP Code Tabulation Areas" - verified via search; re-checked at runtime.
  ZCTA_LAYER_NAME_HINT: "Zip Code Tabulation Area",

  // LA County Dept. of Public Works - legal city boundaries.
  CITY_SERVER: "https://dpw.gis.lacounty.gov/dpw/rest/services/CityBoundaries/MapServer",
  CITY_LAYER_NAME_HINT: "City",

  // --- Census ACS 5-year estimates (demographics + income) -------------
  ACS_YEAR: 2022,
  ACS_DATASET: "acs/acs5",
  // B03002 = Hispanic/Latino Origin by Race (lets us report both race and
  // Hispanic/Latino ethnicity, which is how the Census Bureau splits it).
  RACE_VARIABLES: {
    total: "B03002_001E",
    notHispanicWhite: "B03002_003E",
    notHispanicBlack: "B03002_004E",
    notHispanicAIAN: "B03002_005E",
    notHispanicAsian: "B03002_006E",
    notHispanicNHPI: "B03002_007E",
    notHispanicOther: "B03002_008E",
    notHispanicTwoOrMore: "B03002_009E",
    hispanicLatino: "B03002_012E",
  },
  INCOME_VARIABLES: {
    medianHouseholdIncome: "B19013_001E",
    perCapitaIncome: "B19301_001E",
    povertyUniverse: "B17001_001E",
    povertyCount: "B17001_002E",
  },

  // --- Fire hazard -------------------------------------------------------
  // CAL FIRE Fire Hazard Severity Zones (state agency, both State
  // Responsibility Area and Local Responsibility Area layers).
  FIRE_SERVER: "https://services.gis.ca.gov/arcgis/rest/services/Environment/Fire_Severity_Zones/MapServer",

  // --- Schools -------------------------------------------------------
  // CA Dept. of Education, official 2024-25 public school sites and school
  // district areas - both hosted in the same CDE ArcGIS Online org, which
  // (unlike the state's own services.gis.ca.gov instance) is confirmed
  // reachable with CORS from a browser.
  SCHOOLS_SERVER: "https://services3.arcgis.com/fdvHcZVgB2QSRNkL/arcgis/rest/services/SchoolSites2425/FeatureServer/0",
  DISTRICTS_SERVER: "https://services3.arcgis.com/fdvHcZVgB2QSRNkL/arcgis/rest/services/DistrictAreas2425/FeatureServer/0",

  // --- Geocoding -------------------------------------------------------
  // US Census Bureau geocoder - free, no key, US addresses only.
  GEOCODER_URL: "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress",
  GEOCODER_BENCHMARK: "Public_AR_Current",

  // Public CORS proxies, tried in order, used ONLY as a fallback when a
  // direct browser fetch to a government API is rejected for lacking
  // CORS headers (api.census.gov is the known case - see README). Not
  // used for any ArcGIS REST call, which all support CORS directly.
  CORS_PROXIES: [
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  ],
};
