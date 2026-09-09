// ---------------------------------------------------------------------------
// LA County Block Group Explorer.
//
// Three independent boundary toggles (zip / tract / block group) plus, for
// block groups only, a click popup showing population, age bands, sex split,
// ethnicity, education and income for that block group.
//
// Ethnicity has two selectable sources: ACS B03002 (survey estimate,
// default) or 2020 Census P2 (actual 100% count, but fixed at 2020).
// Everything else comes from ACS detailed (B) tables, because the Subject
// tables people usually reach for - S0101 for age/sex, S1501 for education -
// are derived products the Census Bureau does not publish at block group.
// B01001 covers age/sex fully; B15003 covers education for the 25+
// population, though without S1501's age breakdown.
//
// Tract and block group polygons are loaded for the *visible map area* only,
// above a minimum zoom - LA County has ~2,500 tracts and ~6,500 block groups,
// and pulling all of them at once would be a many-megabyte download and a
// sluggish map.
// ---------------------------------------------------------------------------

// Sublayers that must never be drawn as hazard zones.
//
// "SRA/LRA Awaiting Zoning" is the one that actually bit us. It is a
// placeholder for ground CAL FIRE has not finished re-zoning - not a hazard
// class - and it is enormous, covering whole unincorporated areas. Because
// its name contains "SRA", a match on /sra|lra/ pulled it in, and it was
// then painted as though it were a real zone. That is the wrong-looking
// wash of colour over the canyons.
//
// The rest are label, line, annotation and responsibility-area boundary
// layers: they query fine and draw as noise.
const FIRE_LAYER_EXCLUDE = /awaiting|pending|unzoned|label|annotation|\bline\b|responsibility area(s)?$|boundar/i;

const BG_CONFIG = {
  MAP_CENTER: [34.05, -118.25],
  MAP_ZOOM: 12,

  // Basemap: OpenFreeMap's Positron style, drawn as vector tiles through
  // MapLibre GL. Vector matters here for one concrete reason - the Esri
  // raster canvas this replaced only publishes tiles to zoom 16, so the map
  // went soft exactly where a block group fills the screen. Vector tiles are
  // drawn at whatever zoom you are at, so labels and streets stay sharp to
  // zoom 20. OpenFreeMap needs no key and sets no limits; it is donation
  // funded and single-maintainer, hence the raster fallback below.
  BASEMAP_STYLE: "https://tiles.openfreemap.org/styles/positron",
  BASEMAP_ATTRIBUTION:
    '&copy; <a href="https://openfreemap.org/">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a> ' +
    'Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  MAX_ZOOM: 20,

  // Raster fallback, used when WebGL is unavailable (older machines, remote
  // desktops, GPU blocklists) or OpenFreeMap cannot be reached.
  //
  // maxNativeZoom is the important part: Esri's Light Gray Canvas stops
  // publishing tiles at zoom 16, so without it the basemap goes blank past
  // that zoom instead of upscaling the last real tile.
  FALLBACK_BASEMAP_URL:
    "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  FALLBACK_BASEMAP_LABELS_URL:
    "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
  FALLBACK_BASEMAP_ATTRIBUTION: "Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ",
  FALLBACK_MAX_NATIVE_ZOOM: 16,

  // All three boundary types come from the same Census TIGERweb service.
  // TIGERweb also carries "Tribal Census Tracts"/"Tribal Block Groups" and
  // "... Labels" layers whose names collide on a loose substring match, and
  // the tribal ones query successfully while returning zero features in most
  // of LA County - hence the exact names and exclusions here.
  TIGERWEB: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer",
  LAYERS: {
    zip: {
      nameHint: "Zip Code Tabulation Area",
      exactNames: ["2020 Census ZIP Code Tabulation Areas", "Zip Code Tabulation Areas"],
      exclude: /tribal|label/i,
      fallbackId: 2,
    },
    tract: {
      nameHint: "Census Tract",
      exactNames: ["Census Tracts"],
      exclude: /tribal|label/i,
      fallbackId: 8,
    },
    blockGroup: {
      nameHint: "Block Group",
      exactNames: ["Census Block Groups", "Block Groups"],
      exclude: /tribal|label/i,
      fallbackId: 10,
    },
  },

  MIN_ZOOM: { tract: 11, blockGroup: 12 },

  // Only the attributes actually used. Requesting "*" pulls every TIGERweb
  // field for thousands of polygons, which is dead weight over the wire.
  OUT_FIELDS: {
    zip: "GEOID,ZCTA5CE20,BASENAME,NAME",
    tract: "GEOID,NAME,BASENAME",
    blockGroup: "GEOID,NAME,BASENAME,TRACT,BLKGRP,AREALAND",
    default: "*",
  },

  // Display age bands, grouped from B01001's own brackets (which is why the
  // data file stores raw brackets - changing this list needs no re-fetch).
  // Keys are B01001 bracket indexes; see ageBracketLabels in the data file.
  AGE_BANDS: [
    { label: "0 to 24", brackets: [3, 4, 5, 6, 7, 8, 9, 10] },
    { label: "25 to 34", brackets: [11, 12] },
    { label: "35 to 44", brackets: [13, 14] },
    { label: "45 to 54", brackets: [15, 16] },
    { label: "55 to 64", brackets: [17, 18, 19] },
    { label: "65 and over", brackets: [20, 21, 22, 23, 24, 25] },
  ],

  // Nominatim (OpenStreetMap) powers the as-you-type suggestions - it does
  // partial matching, which the Census geocoder does not. Their usage policy
  // caps this at ~1 request/second, hence the debounce below.
  NOMINATIM_URL: "https://nominatim.openstreetmap.org/search",
  SEARCH_DEBOUNCE_MS: 700,

  // Census geocoder - exact-match fallback if Nominatim is unavailable.
  GEOCODER_URL: "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress",
  GEOCODER_BENCHMARK: "Public_AR_Current",

  // Population per square mile. Deliberately ordered densest-first: the
  // densest bucket gets the palest fill and the least dense the deepest
  // green, per the brief.
  //
  // NOTE ON THESE THRESHOLDS: I could not sample live block groups to derive
  // them - this build environment has no network access to the Census API.
  // They come from the known spread of LA County densities, which runs from
  // near-empty mountain and desert block groups to very dense central
  // neighbourhoods. Turn on density shading and check the status log: it
  // reports the actual percentiles of whatever is on screen, so these can be
  // tuned against real numbers in one edit here.
  DENSITY_BUCKETS: [
    { max: Infinity, label: "Very high (25,000+ /sq mi)", color: "#e8f6ee" },
    { max: 25000, label: "High (12,000-25,000)", color: "#b7e4c7" },
    { max: 12000, label: "Medium (5,000-12,000)", color: "#74c69d" },
    { max: 5000, label: "Low (1,000-5,000)", color: "#40916c" },
    { max: 1000, label: "Very low (under 1,000)", color: "#1b4332" },
  ],


  // --- Hazard / environment overlays --------------------------------------
  // These are ordinary ArcGIS REST polygon services, but unlike TIGERweb they
  // each live on their own host, so each carries its own candidate list. The
  // first URL that answers wins; the rest exist because government GIS
  // endpoints move without notice and a dead URL should degrade to "try the
  // next one", not to a broken layer.
  OVERLAYS: {
    fire: {
      label: "Fire hazard zones",
      minZoom: 9,
      // Simplify geometry server-side. FHSZ is tens of thousands of small
      // adjacent polygons statewide; full-resolution rings are megabytes for
      // detail no one can see at these zooms.
      simplifyDegrees: 0.0005,
      servers: [
        // LA County's own Hazards service first. It carries the county's
        // adopted SRA and LRA zones for exactly the area this app covers,
        // which is a better match than a statewide service.
        {
          url: "https://public.gis.lacounty.gov/public/rest/services/LACounty_Dynamic/Hazards/MapServer",
          discover: {
            nameHint: "fire hazard severity",
            match: /fire hazard severity|fhsz|vhfhsz/i,
            exclude: FIRE_LAYER_EXCLUDE,
            polygonsOnly: true,
            fallbackId: 2,
          },
        },
        // Same county service on its other public host, in case the first
        // is retired - these two have swapped over the years.
        {
          url: "https://arcgis.gis.lacounty.gov/arcgis/rest/services/LACounty_Dynamic/Hazards/MapServer",
          discover: {
            nameHint: "fire hazard severity",
            match: /fire hazard severity|fhsz|vhfhsz/i,
            exclude: FIRE_LAYER_EXCLUDE,
            polygonsOnly: true,
            fallbackId: 19,
          },
        },
        {
          url: "https://services.gis.ca.gov/arcgis/rest/services/Environment/Fire_Severity_Zones/MapServer",
          // This service splits SRA and LRA into separate sublayers, and
          // also carries label/line sublayers plus an "SRA/LRA Awaiting
          // Zoning" sublayer - see FIRE_LAYER_EXCLUDE for why that one is
          // poison.
          discover: {
            nameHint: "fire hazard severity",
            match: /hazard|fhsz|sra|lra/i,
            exclude: FIRE_LAYER_EXCLUDE,
            polygonsOnly: true,
            fallbackId: 0,
          },
        },
      ],
      outFields: "*",
    },
    pollution: {
      label: "Pollution burden (CalEnviroScreen 4.0)",
      minZoom: 8,
      simplifyDegrees: 0.0005,
      // CES 4.0 is one statewide census-tract layer. OEHHA publishes it as a
      // hosted feature layer; the State Water Board mirrors it on its own
      // portal, which is the fallback if OEHHA's moves.
      servers: [
        {
          url: "https://services1.arcgis.com/PCHfdHz4GlDNAhBb/arcgis/rest/services/CalEnviroScreen_4_0_Results_/FeatureServer",
          layerId: 0,
        },
        {
          url: "https://services.arcgis.com/o6oETlrWetREI1A2/arcgis/rest/services/CES4/FeatureServer",
          layerId: 0,
        },
        {
          url: "https://gispublic.waterboards.ca.gov/portalserver/rest/services/Cal_Enviroscreen_40/MapServer",
          discover: { nameHint: "calenviroscreen", match: /enviroscreen|ces/i, polygonsOnly: true, fallbackId: 0 },
        },
      ],
      outFields: "*",
    },
    flood: {
      label: "FEMA flood zones",
      minZoom: 10,
      simplifyDegrees: 0.0002,
      servers: [
        // The National Flood Hazard Layer. Layer 28 is the flood zone
        // polygons; the same service also carries panels, cross-sections and
        // base flood elevations, none of which belong on this map.
        { url: "https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL/MapServer", layerId: 28 },
        { url: "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer", layerId: 28 },
      ],
      outFields: "*",
    },
    seismic: {
      label: "Liquefaction & landslide zones",
      minZoom: 10,
      simplifyDegrees: 0.0002,
      // Both services are drawn, not just the first that answers: CGS
      // publishes liquefaction and earthquake-induced landslide zones
      // separately, and a hillside buyer wants both at once.
      mergeAll: true,
      servers: [
        {
          url: "https://gis.conservation.ca.gov/server/rest/services/CGS_Earthquake_Hazard_Zones/SHP_Liquefaction_Zones/MapServer",
          layerId: 0,
          hazard: "liquefaction",
        },
        {
          url: "https://gis.conservation.ca.gov/server/rest/services/CGS_Earthquake_Hazard_Zones/SHP_Landslide_Zones/MapServer",
          layerId: 0,
          hazard: "landslide",
        },
      ],
      outFields: "*",
    },
    schoolDistricts: {
      label: "School district boundaries",
      minZoom: 8,
      simplifyDegrees: 0.0005,
      servers: [
        // TIGERweb again - the same host the tract and block group layers
        // come from, which keeps this to one more query against a server
        // already known to work. It carries elementary, secondary and
        // unified districts as separate sublayers; all three are merged,
        // because a given address can sit in an elementary district AND a
        // secondary district at once.
        {
          url: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer",
          discover: {
            nameHint: "school district",
            match: /school district/i,
            exclude: /label/i,
            polygonsOnly: true,
            fallbackId: 14,
          },
        },
        // CA Dept of Education's own composite, which carries district-level
        // attributes TIGERweb does not.
        {
          url: "https://services3.arcgis.com/fdvHcZVgB2QSRNkL/arcgis/rest/services/CaliforniaSchoolDistrictAreas2425/FeatureServer",
          layerId: 0,
        },
        {
          url: "https://services.gis.ca.gov/arcgis/rest/services/Boundaries/CA_School_Districts/MapServer",
          discover: { nameHint: "school district", match: /school district|unified|elementary|secondary/i, exclude: /label/i, polygonsOnly: true, fallbackId: 0 },
        },
      ],
      outFields: "*",
    },
    schoolZones: {
      label: "School attendance zones (LAUSD)",
      minZoom: 10,
      simplifyDegrees: 0.0002,
      servers: [
        // LA City's GeoHub publishes LAUSD's own attendance boundaries, split
        // by level. This is the layer that answers "which school does this
        // address go to" - district boundaries cannot.
        {
          url: "https://maps.lacity.org/lahub/rest/services/LAUSD_Schools/MapServer",
          discover: {
            nameHint: "attendance boundary",
            match: /attendance boundary/i,
            // "Key Codes" layers are lookup tables of boundary ids, not
            // boundaries.
            exclude: /key code|label/i,
            polygonsOnly: true,
            fallbackId: 4,
          },
        },
      ],
      outFields: "*",
    },
  },

  // School points. A FeatureServer of points rather than polygons, so it gets
  // its own small pipeline rather than riding the overlay one.
  SCHOOL_POINTS: {
    label: "Schools",
    minZoom: 11,
    servers: [
      // CA Dept of Education, official 2024-25 public school sites. Proven
      // reachable with CORS from a browser.
      "https://services3.arcgis.com/fdvHcZVgB2QSRNkL/arcgis/rest/services/SchoolSites2425/FeatureServer/0",
      // LA City GeoHub's copy of LAUSD schools, as a fallback.
      "https://maps.lacity.org/lahub/rest/services/LAUSD_Schools/MapServer/0",
    ],
    // Field names differ between those two, so everything is read by
    // candidate list rather than by exact key.
    FIELDS: {
      name: ["SchoolName", "School", "NAME", "SCHOOL_NAME", "Name"],
      district: ["District", "DistrictName", "DIST_NAME", "LEA_NAME"],
      grades: ["GSoffered", "GradeSpan", "GS_offered", "Grades", "GRADE_SPAN", "GRADES"],
      level: ["SOCType", "SchoolType", "Type", "LEVEL", "SCHOOL_LEVEL", "GradeLevel"],
      status: ["StatusType", "Status"],
      charter: ["Charter", "CharterSchool"],
      city: ["City", "CITY"],
    },
  },

  // One colour per level, used for the dots, the legend and the card.
  SCHOOL_LEVEL_COLORS: {
    elementary: "#2a7fbf",
    middle: "#7b3fa0",
    high: "#c2410c",
    other: "#6b7280",
  },

  // FEMA flood zones. A/AE/V/VE are the 1%-annual-chance ("100-year")
  // floodplain, where federally-backed mortgages require flood insurance.
  // X (shaded) is the 0.2% chance zone; plain X is minimal risk.
  FLOOD_CLASSES: [
    { match: /^(V|VE)$/i, label: "V / VE - coastal high hazard", color: "#7f1d1d" },
    { match: /^(A|AE|AH|AO|AR|A99)$/i, label: "A / AE - 1% annual chance (100-yr)", color: "#dc2626" },
    { match: /^(X)$/i, shaded: true, label: "X (shaded) - 0.2% annual chance (500-yr)", color: "#fbbf24" },
    { match: /^(X|AREA NOT INCLUDED)$/i, label: "X - minimal risk", color: "#93c5fd" },
    { match: /^D$/i, label: "D - undetermined", color: "#9ca3af" },
  ],

  SEISMIC_COLORS: {
    liquefaction: "#0e7490",
    landslide: "#a16207",
  },

  // Aviation noise, BTS/DOT. Published as a 24-hour A-weighted average
  // (LAeq), NOT as DNL - so it carries no 10 dB night-time penalty and is
  // not directly comparable with HUD's 65 dB DNL limit.
  NOISE: {
    label: "Aviation noise",
    minZoom: 9,
    servers: [
      "https://geo.dot.gov/server/rest/services/Hosted/Noise_aviation_CONUS_2018/MapServer",
      "https://geo.dot.gov/server/rest/services/hosted/Noise_aviation_CONUS_2016/MapServer",
      "https://maps.bts.dot.gov/services/rest/services/Noise/CONUS_road_and_aviation_noise/MapServer",
    ],
    // Bands the map's own legend uses, for the sidebar key.
    BANDS: [
      { max: 50, label: "Under 50 dB - quiet", color: "#f1f5f9" },
      { max: 55, label: "50-55 dB", color: "#bfdbfe" },
      { max: 60, label: "55-60 dB", color: "#fcd34d" },
      { max: 65, label: "60-65 dB - likely over HUD's limit once the night penalty is applied", color: "#f97316" },
      { max: Infinity, label: "65+ dB", color: "#b91c1c" },
    ],
  },

  // Fire Hazard Severity Zone classes. CAL FIRE only maps three, and only
  // inside a responsibility area - unmapped ground is genuinely unmapped
  // rather than "no hazard", which the legend says explicitly.
  FIRE_CLASS_COLORS: {
    "very high": "#d7301f",
    high: "#fc8d59",
    moderate: "#fdcc8a",
  },

  // CalEnviroScreen percentile bands. CES is a *relative* score: 90 means
  // "worse than 90% of California census tracts", not an absolute dose.
  POLLUTION_BUCKETS: [
    { max: 20, label: "0-20th percentile (least burdened)", color: "#f7f7f7" },
    { max: 40, label: "20-40th", color: "#fee0b6" },
    { max: 60, label: "40-60th", color: "#fdb863" },
    { max: 80, label: "60-80th", color: "#e08214" },
    { max: 100, label: "80-100th (most burdened)", color: "#b35806" },
  ],

  // CES 4.0 field names, as they appear in OEHHA's published shapefile.
  // Each entry is a list because the hosted copies differ in punctuation
  // (Diesel_PM vs DieselPM) and pickField matches on substrings.
  CES_FIELDS: {
    score: ["CIscoreP", "CIScoreP", "CES_4_0_Percentile", "Percentile"],
    rawScore: ["CIscore", "CIScore"],
    tract: ["Tract", "GEOID", "Census_Tract", "TractID"],
    population: ["TotPop19", "TotPop", "Population"],
    indicators: [
      { label: "Ozone", pctl: ["Ozone_Pctl", "OzoneP"], raw: ["Ozone"], unit: "ppm-hours" },
      { label: "PM2.5", pctl: ["PM2_5_Pctl", "PM25_Pctl", "PM2_5P"], raw: ["PM2_5", "PM25"], unit: "\u00b5g/m\u00b3" },
      { label: "Diesel PM", pctl: ["Diesel_PM_Pctl", "DieselPM_Pctl", "DieselP"], raw: ["Diesel_PM", "DieselPM"], unit: "kg/day" },
      { label: "Traffic", pctl: ["Traffic_Pctl", "TrafficP"], raw: ["Traffic"], unit: "vehicle-km/hr" },
      { label: "Drinking water", pctl: ["Drink_Wat_Pctl", "DrinkingWaterP", "Drinking_Water_Pctl"], raw: ["Drink_Wat", "DrinkingWater"], unit: "index" },
      { label: "Pesticides", pctl: ["Pesticide_Pctl", "PesticidesP"], raw: ["Pesticide", "Pesticides"], unit: "lbs/sq mi" },
      { label: "Asthma ER visits", pctl: ["Asthma_Pctl", "AsthmaP"], raw: ["Asthma"], unit: "per 10k" },
    ],
  },

  // --- Wind ---------------------------------------------------------------
  // Global Wind Atlas 3 ships as GeoTIFF only - no tile or WMS service - so
  // scripts/fetch-wind-data.py turns a downloaded GeoTIFF into the compact
  // JSON grid the page draws. See README for the two-minute download step.
  WIND_DATA: "js/data/wind-la-county.json",
  WIND_BUCKETS: [
    { max: 3, label: "Under 3 m/s (calm)", color: "#f0f9e8" },
    { max: 4.5, label: "3-4.5 m/s", color: "#bae4bc" },
    { max: 6, label: "4.5-6 m/s", color: "#7bccc4" },
    { max: 7.5, label: "6-7.5 m/s", color: "#43a2ca" },
    { max: Infinity, label: "7.5+ m/s (windiest)", color: "#0868ac" },
  ],

  // Nominatim again, this time backwards: a dropped pin has coordinates and
  // needs the street address, which is the reverse of the search box.
  NOMINATIM_REVERSE_URL: "https://nominatim.openstreetmap.org/reverse",

  // Padding (in degrees) added around the viewport when loading polygons, so
  // small pans don't trigger a refetch - which used to destroy the open popup.
  BBOX_PADDING: 0.02,

  // Whole-county bbox, used for the zip layer (only ~300 ZCTAs, so it's
  // cheap to load once rather than per-viewport).
  LA_COUNTY_BBOX: { xmin: -118.95, ymin: 32.70, xmax: -117.60, ymax: 34.85 },

  // Produced by scripts/fetch-parcel-data.py from the LA County Assessor roll.
  PARCEL_DATA: "js/data/parcels-la-county.json",

  // OpenRouteService: free, no credit card, 2,500 requests/day. The key lives
  // in ors-api-key.txt beside this project (gitignored) and is read at start.
  ORS_KEY_FILE: "ors-api-key.txt",
  ORS_DIRECTIONS: "https://api.openrouteservice.org/v2/directions/driving-car",

  // Produced by scripts/fetch-blockgroup-data.py (see README).
  BLOCK_GROUP_DATA: "js/data/bg-la-county.json",

  STYLES: {
    zip: { color: "#b3401f", weight: 2, fill: false, opacity: 0.9 },
    tract: { color: "#1a7a3c", weight: 1.2, fill: false, opacity: 0.8, dashArray: "4 3" },
    blockGroup: { color: "#1b4d8c", weight: 0.9, fillColor: "#1b4d8c", fillOpacity: 0.06 },
    blockGroupSelected: { color: "#b3401f", weight: 3, fillColor: "#b3401f", fillOpacity: 0.18 },
    blockGroupMatch: { color: "#14663a", weight: 1.2, fillColor: "#21a35d", fillOpacity: 0.45 },
    blockGroupNoMatch: { color: "#9aa3ad", weight: 0.4, fillColor: "#c8ced4", fillOpacity: 0.05 },
  },
};

const BlockGroupApp = (() => {
  let map;
  const layers = {};        // key -> L.geoJSON currently on the map
  const layerIds = {};      // key -> resolved TIGERweb layer id
  const enabled = {
    zip: false, tract: false, blockGroup: false,
    fire: false, pollution: false, wind: false,
    flood: false, seismic: false, noise: false,
    schoolDistricts: false, schoolZones: false, schools: false,
  };
  const loadedBBox = {};    // key -> padded bbox covered by the current layer
  let censusData = null;    // { meta, blockGroups } from the local snapshot
  let censusDataError = null;
  let selectedLayer = null;
  let selectedProps = null;   // so the open detail can re-render on source switch
  let moveTimer = null;
  let ethSource = "acs";      // "acs" = B03002 (default), "dec" = 2020 Census P2
  let densityShading = false; // population-density colour scale on/off

  // --- data ---------------------------------------------------------------

  // Distinguishes "the file isn't there" from "the file is there but
  // unreadable" - they need completely different fixes, and reporting both
  // as "no data file yet" sends you looking in the wrong place.
  // Windows uses `python` and backslashes; macOS/Linux use `python3` and
  // forward slashes. Printing the wrong one sends people chasing a command
  // that doesn't exist on their machine.
  function fetchCommand() {
    const isWindows = /Windows|Win32|Win64/i.test(navigator.userAgent || "");
    return isWindows
      ? "python scripts\\fetch-blockgroup-data.py"
      : "python3 scripts/fetch-blockgroup-data.py";
  }

  function serverCommand() {
    const isWindows = /Windows|Win32|Win64/i.test(navigator.userAgent || "");
    return isWindows ? "python -m http.server 8000" : "python3 -m http.server 8000";
  }

  function describeDataFailure(err) {
    const url = new URL(BG_CONFIG.BLOCK_GROUP_DATA, window.location.href).href;

    // Opening the page by double-clicking the .html file gives it a file://
    // origin, where browsers block fetch() outright. Boundaries still load
    // (those are https:// requests), so the map looks fine and only the
    // local data file fails - which is confusing unless it's called out.
    if (window.location.protocol === "file:") {
      return {
        short: "blocked by the browser",
        detail:
          `This page was opened directly from disk (<code>file://</code>), and browsers block pages from ` +
          `reading local files that way - so the data file can't load no matter what. Serve the folder over ` +
          `HTTP instead: run <code>${serverCommand()}</code> in the project folder, then open ` +
          `<code>http://localhost:8000/blockgroups.html</code>.`,
      };
    }

    if (/HTTP 40[34]/.test(err.message)) {
      return {
        short: "not found",
        detail:
          `No file at ${url} (server said ${err.message}). Run ` +
          `<code>${fetchCommand()}</code> from the project folder, then reload. ` +
          `Note the web server occupies its terminal, so run that in a second terminal window.`,
      };
    }
    if (/JSON|Unexpected token/i.test(err.message)) {
      return {
        short: "unreadable",
        detail: `The file at ${url} exists but isn't valid JSON (${err.message}). The fetch script probably failed partway - re-run it and check its output for errors.`,
      };
    }
    return {
      short: "failed to load",
      detail: `Couldn't load ${url}: ${err.message}`,
    };
  }

  async function loadCensusData() {
    if (censusData || censusDataError) return censusData;
    try {
      censusData = await Utils.fetchJSON(BG_CONFIG.BLOCK_GROUP_DATA, { timeoutMs: 60000 });
      const count = Object.keys(censusData.blockGroups || {}).length;
      Utils.logStatus(
        "census",
        "ok",
        `Loaded block group data for ${count.toLocaleString()} block groups (ACS ${censusData.meta.year}).`
      );
      if (count === 0) {
        Utils.logStatus("census", "warn", "The data file loaded but contains zero block groups - re-run the fetch script.");
      }
    } catch (err) {
      censusDataError = err;
      const { short, detail } = describeDataFailure(err);
      Utils.logStatus(
        "census",
        "warn",
        `Block group data ${short}. ${detail.replace(/<\/?code>/g, "")} Boundaries still work; popups will have no numbers.`
      );
    }
    return censusData;
  }

  // Padded so that panning a little - or Leaflet auto-panning to fit an
  // opening popup - stays inside what's already loaded. Without this, opening
  // a popup could move the map, trigger a refetch, and destroy the very popup
  // that caused it, which read as "the card disappears after a few seconds".
  function bboxOfView() {
    const b = map.getBounds().pad(0);
    const p = BG_CONFIG.BBOX_PADDING;
    return {
      xmin: b.getWest() - p,
      ymin: b.getSouth() - p,
      xmax: b.getEast() + p,
      ymax: b.getNorth() + p,
    };
  }

  function viewIsInside(bbox) {
    if (!bbox) return false;
    const b = map.getBounds();
    return (
      b.getWest() >= bbox.xmin &&
      b.getSouth() >= bbox.ymin &&
      b.getEast() <= bbox.xmax &&
      b.getNorth() <= bbox.ymax
    );
  }

  async function resolveLayerId(key) {
    if (layerIds[key] === undefined) {
      const spec = BG_CONFIG.LAYERS[key];
      layerIds[key] = await Utils.discoverLayerId(BG_CONFIG.TIGERWEB, spec.nameHint, spec.fallbackId, {
        exactNames: spec.exactNames,
        exclude: spec.exclude,
      });
    }
    return layerIds[key];
  }

  async function fetchBoundaries(key, bbox) {
    const layerId = await resolveLayerId(key);
    const url = Utils.arcgisQueryUrl(BG_CONFIG.TIGERWEB, layerId, {
      bbox,
      outFields: BG_CONFIG.OUT_FIELDS[key] || BG_CONFIG.OUT_FIELDS.default,
    });
    return Utils.fetchEsriAsGeoJSON(url, { timeoutMs: 40000 });
  }

  // --- Hazard / environment overlays --------------------------------------
  // Each overlay has a candidate list of servers. Resolution is cached per
  // key: pick the first server that answers, and on a MapServer work out
  // which sublayers to draw (CAL FIRE splits State and Local Responsibility
  // Areas across sublayers, and mixes in label/line sublayers that must not
  // be drawn).
  const overlaySources = {};

  async function resolveOverlaySublayers(serverUrl, spec) {
    const root = await Utils.fetchJSON(`${serverUrl}?f=json`, { timeoutMs: 20000 });
    const all = root.layers || [];
    const hits = all.filter((l) => {
      // County services name layers FIRE_HAZARD_SEVERITY_ZONES_LRA while
      // state ones write "Fire Hazard Severity Zones in LRA". Matching
      // against a normalised name means one pattern covers both.
      const name = (l.name || "").replace(/[_-]+/g, " ");
      if (spec.match && !spec.match.test(name)) return false;
      if (spec.exclude && spec.exclude.test(name)) return false;
      // Group layers cannot be queried at all - ArcGIS answers with an error
      // object, which used to fail the whole layer. They are recognisable by
      // carrying child ids, and their children are listed separately anyway,
      // so dropping them loses nothing.
      if (Array.isArray(l.subLayerIds) && l.subLayerIds.length) return false;
      // A sublayer with no geometryType is an unknown quantity: keep it and
      // let the query decide, rather than dropping a layer we might need.
      if (spec.polygonsOnly && l.geometryType && l.geometryType !== "esriGeometryPolygon") return false;
      return true;
    });
    if (!hits.length) return [{ id: spec.fallbackId, name: `fallback id ${spec.fallbackId}` }];
    return hits.map((l) => ({ id: l.id, name: l.name || `layer ${l.id}` }));
  }

  async function resolveOverlaySource(key) {
    if (overlaySources[key]) return overlaySources[key];
    const spec = BG_CONFIG.OVERLAYS[key];
    const problems = [];

    // mergeAll: every server contributes, rather than the first that answers.
    // Used where one logical layer is published as several services -
    // liquefaction and landslide zones, for instance.
    if (spec.mergeAll) {
      const sources = [];
      for (const candidate of spec.servers) {
        try {
          const sublayers = candidate.discover
            ? await resolveOverlaySublayers(candidate.url, candidate.discover)
            : [{ id: candidate.layerId, name: candidate.hazard || `layer ${candidate.layerId}` }];
          sources.push({ url: candidate.url, sublayers, hazard: candidate.hazard });
        } catch (err) {
          problems.push(`${candidate.url}: ${err.message}`);
        }
      }
      if (!sources.length) throw new Error(`no server answered. Tried - ${problems.join(" | ")}`);
      if (problems.length) Utils.logStatus(key, "warn", `${spec.label}: ${problems.join(" | ")}`);
      const merged = { multi: sources };
      overlaySources[key] = merged;
      return merged;
    }

    for (const candidate of spec.servers) {
      try {
        let sublayers;
        if (candidate.discover) {
          sublayers = await resolveOverlaySublayers(candidate.url, candidate.discover);
        } else {
          sublayers = [{ id: candidate.layerId, name: `layer ${candidate.layerId}` }];
        }
        const source = { url: candidate.url, sublayers };
        overlaySources[key] = source;
        Utils.logStatus(
          key,
          "info",
          `${spec.label}: using ${candidate.url} (${sublayers.map((l) => l.name).join(", ")}).`
        );
        return source;
      } catch (err) {
        problems.push(`${candidate.url}: ${err.message}`);
      }
    }
    throw new Error(`no server answered. Tried - ${problems.join(" | ")}`);
  }

  // How far to subdivide a truncated query. Only boxes that actually come
  // back truncated are split, so depth 3 is a worst case (64 sub-queries for
  // one layer), not the normal cost. It needs to be this deep because CAL
  // FIRE's service caps a query at 1,000 records and an LA-sized viewport
  // holds many times that in hazard polygons.
  const MAX_SPLIT_DEPTH = 3;

  function quadrants(bbox) {
    const midX = (bbox.xmin + bbox.xmax) / 2;
    const midY = (bbox.ymin + bbox.ymax) / 2;
    return [
      { xmin: bbox.xmin, ymin: bbox.ymin, xmax: midX, ymax: midY },
      { xmin: midX, ymin: bbox.ymin, xmax: bbox.xmax, ymax: midY },
      { xmin: bbox.xmin, ymin: midY, xmax: midX, ymax: bbox.ymax },
      { xmin: midX, ymin: midY, xmax: bbox.xmax, ymax: bbox.ymax },
    ];
  }

  function featureKey(feature, index) {
    const id = Utils.pickField(feature.properties, ["OBJECTID", "FID", "OID", "GlobalID"]);
    return id === undefined ? `idx:${index}:${JSON.stringify(feature.geometry).length}` : `id:${id}`;
  }

  // One query, with the two things that actually go wrong in the field
  // handled where they happen:
  //
  //  1. The record cap. FHSZ is tens of thousands of polygons; an LA-sized
  //     viewport blows past any server's maxRecordCount, and the server
  //     answers with a perfectly valid *partial* result. That is what a
  //     hazard layer with chunks missing looks like. So when the response
  //     says it was truncated, split the box into quarters and ask again -
  //     smaller boxes hold fewer records. Every ArcGIS version supports
  //     this; resultOffset paging does not.
  //
  //  2. maxAllowableOffset. Older ArcGIS Server builds reject it outright,
  //     which fails the whole layer for the sake of an optimisation, so a
  //     rejected query is retried once without it.
  async function fetchOverlayFeatures(key, source, sub, bbox, depth = 0, seen = new Set(), stats = null) {
    const spec = BG_CONFIG.OVERLAYS[key];
    const collected = [];

    const build = (simplify) =>
      Utils.arcgisQueryUrl(source.url, sub.id, {
        bbox,
        outFields: spec.outFields || "*",
        extraParams: simplify && spec.simplifyDegrees ? { maxAllowableOffset: String(spec.simplifyDegrees) } : {},
      });

    let gj;
    try {
      gj = await Utils.fetchEsriAsGeoJSON(build(true), { timeoutMs: 40000 });
    } catch (err) {
      if (!spec.simplifyDegrees || !/ArcGIS error/.test(err.message)) throw err;
      Utils.logStatus(key, "warn", `${sub.name}: server rejected geometry simplification (${err.message}); retrying without it.`);
      gj = await Utils.fetchEsriAsGeoJSON(build(false), { timeoutMs: 40000 });
    }

    if (stats) stats.requests += 1;

    if (gj.exceededTransferLimit && depth < MAX_SPLIT_DEPTH) {
      if (stats) stats.split = true;
      for (const quad of quadrants(bbox)) {
        const part = await fetchOverlayFeatures(key, source, sub, quad, depth + 1, seen, stats);
        collected.push(...part);
      }
      return collected;
    }

    if (gj.exceededTransferLimit && stats) stats.stillTruncated = true;

    gj.features.forEach((f, i) => {
      // Quadrants overlap at their shared edges, and a polygon crossing one
      // is returned by both queries, so dedupe on the server's own id.
      const dedupeKey = featureKey(f, i);
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      f.properties.SOURCE_LAYER = sub.name;
      collected.push(f);
    });
    return collected;
  }

  async function fetchOverlay(key, bbox) {
    const spec = BG_CONFIG.OVERLAYS[key];
    const resolved = await resolveOverlaySource(key);
    const sources = resolved.multi || [resolved];
    const features = [];
    const failures = [];

    for (const source of sources) {
    for (const sub of source.sublayers) {
      const stats = { requests: 0, split: false, stillTruncated: false };
      try {
        const got = await fetchOverlayFeatures(key, source, sub, bbox, 0, new Set(), stats);
        // Where several services make up one layer, remember which one each
        // feature came from - the styling depends on it.
        if (source.hazard) got.forEach((f) => (f.properties.HAZARD_KIND = source.hazard));
        features.push(...got);
        Utils.logStatus(
          key,
          got.length ? "info" : "warn",
          `${sub.name}: ${got.length} polygons in ${stats.requests} request(s)` +
            (stats.split ? ", split to get past the server's record cap" : "") +
            (stats.stillTruncated ? " - STILL TRUNCATED, zoom in for full coverage" : "") +
            "."
        );
      } catch (err) {
        failures.push(`${sub.name}: ${err.message}`);
      }
    }
    }

    // Every sublayer failing is a layer failure; some failing is worth saying
    // out loud but not worth throwing away the ones that worked.
    if (failures.length && !features.length) throw new Error(failures.join(" | "));
    if (failures.length) Utils.logStatus(key, "warn", `${spec.label}: ${failures.join(" | ")}`);
    return { type: "FeatureCollection", features };
  }

  // --- Fire hazard --------------------------------------------------------

  function fireClass(props) {
    const raw = Utils.pickField(props, [
      "HAZ_CLASS", "FHSZ_DESC", "FHSZ", "SRA_HAZ_CODE", "HAZARD_CLASS", "HAZARD", "HAZ_CODE", "CLASS",
    ]);
    if (raw === undefined || raw === null || raw === "") return null;
    const s = String(raw).toLowerCase();
    if (s.includes("very high") || s === "3") return "very high";
    if (s.includes("moderate") || s === "1") return "moderate";
    if (s.includes("high") || s === "2") return "high";
    return null;
  }

  // If the live field names ever stop matching, every polygon falls back to
  // grey and the layer just looks wrong with no clue why. This turns that
  // into a status line naming the values seen and the fields available.
  function logFireClasses(geojson) {
    if (!geojson.features.length) return;
    const counts = {};
    let unclassified = 0;
    geojson.features.forEach((f) => {
      const cls = fireClass(f.properties);
      if (!cls) unclassified += 1;
      counts[cls || "unclassified"] = (counts[cls || "unclassified"] || 0) + 1;
    });
    const summary = Object.entries(counts)
      .map(([k, n]) => `${k}: ${n}`)
      .join(", ");
    Utils.logStatus(
      "fire",
      unclassified === geojson.features.length ? "warn" : "ok",
      `Fire hazard classes - ${summary}.` +
        (unclassified
          ? ` Fields available on the first polygon: ${Object.keys(geojson.features[0].properties).join(", ")}.`
          : "")
    );
  }

  // CAL FIRE's polygons are not all hazard zones. The same layer carries
  // "Non-Wildland/Non-Urban" and "Urban Unzoned" ground, which covers most of
  // flat LA. Painting those grey blankets the city in a colour that means
  // nothing - which is what "the fire layer looks wrong" looks like. They are
  // dropped before they reach the map; genuinely unrecognised values are kept
  // and drawn grey, because those are worth seeing and reporting.
  const NON_HAZARD = /non-?wildland|urban unzoned|unzoned|not zoned|awaiting|pending|^none$|^n\/?a$/i;

  function isNonHazard(props) {
    const raw = Utils.pickField(props, [
      "HAZ_CLASS", "FHSZ_DESC", "FHSZ", "SRA_HAZ_CODE", "HAZARD_CLASS", "HAZARD", "HAZ_CODE", "CLASS",
    ]);
    return raw !== undefined && raw !== null && NON_HAZARD.test(String(raw));
  }

  function dropNonHazardZones(geojson) {
    const before = geojson.features.length;
    geojson.features = geojson.features.filter((f) => !isNonHazard(f.properties));
    const dropped = before - geojson.features.length;
    if (dropped) {
      Utils.logStatus("fire", "info", `Skipped ${dropped} non-wildland / unzoned polygons - those are not hazard zones.`);
    }
    return geojson;
  }

  function fireStyle(feature) {
    const cls = fireClass(feature.properties);
    return {
      // No stroke: these are thousands of small adjacent polygons, and a
      // border on each one turns a smooth hazard surface into a grid.
      stroke: false,
      fillColor: cls ? BG_CONFIG.FIRE_CLASS_COLORS[cls] : "#b0b7bf",
      fillOpacity: cls ? 0.5 : 0.25,
    };
  }

  // --- Pollution (CalEnviroScreen 4.0) ------------------------------------

  function cesValue(props, names) {
    const v = Utils.pickField(props, names);
    const n = typeof v === "string" ? parseFloat(v) : v;
    return Number.isFinite(n) ? n : null;
  }

  function cesScore(props) {
    return cesValue(props, BG_CONFIG.CES_FIELDS.score);
  }

  function pollutionBucket(score) {
    if (score === null) return null;
    return BG_CONFIG.POLLUTION_BUCKETS.find((b) => score <= b.max) || null;
  }

  function pollutionStyle(feature) {
    const bucket = pollutionBucket(cesScore(feature.properties));
    if (!bucket) return { color: "#9aa3ad", weight: 0.4, fillColor: "#e9edf0", fillOpacity: 0.15 };
    return { color: "#8a5000", weight: 0.4, fillColor: bucket.color, fillOpacity: 0.6 };
  }

  // CES is tract-level, so a block group inherits its parent tract's score:
  // the first 11 digits of a block group GEOID are the tract GEOID.
  const cesByTract = {};

  function rememberCesTracts(geojson) {
    geojson.features.forEach((f) => {
      const raw = Utils.pickField(f.properties, BG_CONFIG.CES_FIELDS.tract);
      if (raw === undefined || raw === null) return;
      // The Tract field is published as a number in some copies, so it can
      // arrive as 6037101110 - missing the leading zero of state FIPS 06.
      const digits = String(raw).replace(/\D/g, "");
      const geoid = digits.length === 10 ? `0${digits}` : digits;
      if (geoid.length === 11) cesByTract[geoid] = f.properties;
    });
  }

  function cesForBlockGroup(props) {
    const geoid = geoidOf(props) || "";
    return geoid.length >= 11 ? cesByTract[geoid.slice(0, 11)] || null : null;
  }

  function cesRows(props) {
    const ces = cesForBlockGroup(props);
    if (!ces) return "";
    const score = cesScore(ces);
    if (score === null) return "";
    const bucket = pollutionBucket(score);
    return `
      <div class="section-label">Pollution burden${infoIcon(
        "CalEnviroScreen 4.0, from OEHHA. The score is a percentile against every other California census tract, not an absolute measure: 90 means this tract scores worse than 90% of the state. It is reported for the whole tract, so every block group inside it shares one value."
      )}</div>
      <table>
        <tr><td class="k">CalEnviroScreen score</td><td class="v">${score.toFixed(1)}th pct</td></tr>
        <tr><td class="k">Band</td><td class="v">${bucket ? bucket.label : "Unknown"}</td></tr>
      </table>`;
  }

  // --- Home prices (LA County Assessor roll) ------------------------------
  let parcelData = null;
  let parcelError = null;

  async function loadParcelData() {
    if (parcelData || parcelError) return;
    try {
      const res = await fetch(BG_CONFIG.PARCEL_DATA, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      parcelData = data.blockGroups || {};
      Utils.logStatus(
        "prices",
        "ok",
        `Home prices: ${Object.keys(parcelData).length} block groups with sales since ${
          data.meta ? data.meta.salesFrom : "?"
        }.`
      );
    } catch (err) {
      parcelError = err;
      // Not an error worth shouting about: this file is optional, and the
      // rest of the page works without it.
      Utils.logStatus("prices", "info", `No parcel data yet (${err.message}). Run scripts/fetch-parcel-data.py to add home prices.`);
    }
  }

  function parcelFor(props) {
    return parcelData ? parcelData[geoidOf(props)] || null : null;
  }

  function priceRows(props) {
    const rec = parcelFor(props);
    if (!rec) return "";
    const thin = rec.thin || rec.saleCount < 3;
    return `
      <div class="section-label">Home prices${infoIcon(
        "Median RECORDED SALE PRICE of single-family parcels sold here in the last few years, from the LA County " +
          "Assessor roll. Deliberately not assessed value: under Proposition 13 an assessed value reflects how long " +
          "the owner has held the house, not what it is worth, so two identical neighbours can differ tenfold. " +
          "Condos and townhouses are excluded, so this is comparable house to house."
      )}</div>
      <table>
        <tr><td class="k">Median sale price</td><td class="v key-figure">${Utils.fmtCurrency(rec.medianSalePrice)}</td></tr>
        ${
          rec.medianPricePerSqft
            ? `<tr><td class="k">Per square foot</td><td class="v">${Utils.fmtCurrency(rec.medianPricePerSqft)}</td></tr>`
            : ""
        }
        <tr><td class="k">Based on${infoIcon(
          "How many recent sales that median rests on. Three sales is a rumour, not a market rate - treat a thin " +
            "block group's figure as a hint and look at its neighbours."
        )}</td><td class="v${thin ? " thin-sample" : ""}">${rec.saleCount} sale${rec.saleCount === 1 ? "" : "s"}${
      thin ? " - thin" : ""
    }</td></tr>
      </table>`;
  }

  // --- Commute (OpenRouteService) -----------------------------------------
  // A destination address plus the dropped pin is a plain point-to-point
  // routing question, not an isochrone. The free routers have no traffic
  // model, so the number shown is free-flow driving time and says so - in LA
  // that is the difference between 30 minutes and 75.
  let orsKey = null;
  let destination = null;   // { label, lat, lon }
  let routeLine = null;

  async function loadOrsKey() {
    try {
      const res = await fetch(BG_CONFIG.ORS_KEY_FILE, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = (await res.text()).trim();
      // A missing file on some servers returns an HTML 404 page with status
      // 200, so sanity-check the shape rather than trusting the status.
      if (!text || /\s/.test(text) || text.length < 20) throw new Error("file does not look like a key");
      orsKey = text;
      Utils.logStatus("commute", "ok", "Routing key loaded - commute times available.");
    } catch (err) {
      Utils.logStatus(
        "commute",
        "info",
        `No routing key (${err.message}). Put your free OpenRouteService key in ${BG_CONFIG.ORS_KEY_FILE} to get commute times.`
      );
    }
  }

  function clearRoute() {
    if (routeLine) {
      map.removeLayer(routeLine);
      routeLine = null;
    }
  }

  async function routeFromPin() {
    const status = document.getElementById("commute-status");
    if (!destination || !searchMarker) return;
    if (!orsKey) {
      status.className = "hint warn";
      status.textContent = `Add your OpenRouteService key to ${BG_CONFIG.ORS_KEY_FILE} to get drive times.`;
      return;
    }

    const from = searchMarker.getLatLng();
    status.className = "hint";
    status.textContent = "Working out the drive...";
    try {
      const url =
        `${BG_CONFIG.ORS_DIRECTIONS}?` +
        new URLSearchParams({
          api_key: orsKey,
          start: `${from.lng},${from.lat}`,
          end: `${destination.lon},${destination.lat}`,
        });
      const data = await Utils.fetchJSON(url, { timeoutMs: 25000 });
      const route = (data.features || [])[0];
      if (!route) throw new Error("no route found");

      const { duration, distance } = route.properties.summary;
      const minutes = Math.round(duration / 60);
      const miles = distance / 1609.34;

      clearRoute();
      routeLine = L.geoJSON(route, {
        style: { color: "#1b4d8c", weight: 4, opacity: 0.75, dashArray: "6 4" },
      }).addTo(map);

      status.className = "hint ok";
      status.innerHTML =
        `<strong>${minutes} min</strong>, ${miles.toFixed(1)} mi to ${destination.label}` +
        `<br><span class="src-note">Free-flow driving time - OpenRouteService has no traffic model, ` +
        `so a rush-hour LA trip can be twice this.</span>`;
    } catch (err) {
      status.className = "hint error";
      status.textContent = `Could not work out the drive: ${err.message}`;
    }
  }

  let lastDestinationText = null;

  async function setDestination(text) {
    const status = document.getElementById("commute-status");
    // Typing then tabbing away fires both the debounced input handler and the
    // change event. Without this, one destination costs two geocodes and two
    // routing calls - and the free tier is a daily allowance.
    if (text.trim() === lastDestinationText && destination) return;
    lastDestinationText = text.trim();
    if (!text.trim()) {
      destination = null;
      clearRoute();
      status.textContent = "";
      return;
    }
    status.className = "hint";
    status.textContent = "Finding that address...";
    try {
      const matches = await geocode(text);
      if (!matches.length) throw new Error("no match");
      const m = matches[0];
      destination = { label: m.matchedAddress, lat: m.coordinates.y, lon: m.coordinates.x };
      status.className = "hint ok";
      status.textContent = searchMarker
        ? "Destination set - working out the drive..."
        : `Destination: ${destination.label}. Drop a pin to get the drive time.`;
      if (searchMarker) routeFromPin();
    } catch (err) {
      destination = null;
      status.className = "hint error";
      status.textContent = `Could not find that address: ${err.message}`;
    }
  }

  function initCommute() {
    const input = document.getElementById("destination-input");
    let timer = null;
    input.addEventListener("change", () => {
      clearTimeout(timer);
      setDestination(input.value);
    });
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => setDestination(input.value), BG_CONFIG.SEARCH_DEBOUNCE_MS + 300);
    });
    document.getElementById("clear-destination").addEventListener("click", () => {
      input.value = "";
      lastDestinationText = null;
      setDestination("");
    });
  }

  // --- Flood (FEMA NFHL) --------------------------------------------------

  function floodZoneOf(props) {
    return Utils.pickField(props, ["FLD_ZONE", "ZONE", "FLOOD_ZONE", "SFHA_TF"]);
  }

  // "X" appears twice in the class list - once shaded (the 0.2% zone, flagged
  // by ZONE_SUBTY containing "0.2 PCT") and once plain - so the subtype has
  // to break the tie.
  function floodClass(props) {
    const zone = String(floodZoneOf(props) || "").trim().toUpperCase();
    if (!zone) return null;
    const subtype = String(Utils.pickField(props, ["ZONE_SUBTY", "SUBTYPE"]) || "").toUpperCase();
    const shaded = /0\.2 PCT|SHADED/.test(subtype);
    return (
      BG_CONFIG.FLOOD_CLASSES.find((c) => c.match.test(zone) && (!!c.shaded === shaded || !c.shaded)) ||
      BG_CONFIG.FLOOD_CLASSES.find((c) => c.match.test(zone)) ||
      null
    );
  }

  function floodStyle(feature) {
    const cls = floodClass(feature.properties);
    if (!cls) return { stroke: false, fillColor: "#cbd5e1", fillOpacity: 0.2 };
    return { stroke: false, fillColor: cls.color, fillOpacity: 0.45 };
  }

  // Does this block group sit in the 1%-annual-chance floodplain? That is the
  // zone where a federally-backed mortgage requires flood insurance, which is
  // the only part of this most buyers need.
  function inHighRiskFlood(props) {
    const zone = String(floodZoneOf(props) || "").toUpperCase();
    return /^(A|AE|AH|AO|AR|A99|V|VE)$/.test(zone.trim());
  }

  // Flood zone under the block group's centre, read from the polygons already
  // on the map rather than by asking FEMA again.
  function floodRows(feature) {
    if (!enabled.flood || !layers.flood || !feature) return "";
    const center = centroidOf(feature);
    if (!center) return "";

    let hit = null;
    layers.flood.eachLayer((l) => {
      if (!hit && l.feature.geometry && pointInGeometry(center.lat, center.lon, l.feature.geometry)) hit = l.feature;
    });
    if (!hit) return "";

    const zone = floodZoneOf(hit.properties) || "?";
    const cls = floodClass(hit.properties);
    return `
      <div class="section-label">Flood${infoIcon(
        "FEMA National Flood Hazard Layer, read at the centre of this block group. Zones A and AE are the 1% annual chance " +
          "(\"100-year\") floodplain, where a federally-backed mortgage requires flood insurance. A block group can straddle " +
          "two zones, and the zone for a specific address is what the lender actually uses."
      )}</div>
      <table>
        <tr><td class="k">FEMA zone</td><td class="v${inHighRiskFlood(hit.properties) ? " key-figure" : ""}">${zone}</td></tr>
        <tr><td class="k">Meaning</td><td class="v">${cls ? cls.label.split(" - ").slice(1).join(" - ") || cls.label : "Unclassified"}</td></tr>
      </table>`;
  }

  // --- Seismic hazard zones (CGS) -----------------------------------------

  function seismicStyle(feature) {
    const kind = feature.properties.HAZARD_KIND || "liquefaction";
    const color = BG_CONFIG.SEISMIC_COLORS[kind] || "#64748b";
    return { color, weight: 0.6, fillColor: color, fillOpacity: 0.35 };
  }

  // --- Aviation noise (BTS/DOT raster) ------------------------------------
  // This one is a raster, not polygons, so it is drawn by asking the map
  // service to render each tile. That is what an "export" endpoint is for,
  // and it needs no plugin: a Leaflet tile layer whose URL is computed per
  // tile from that tile's bounding box in Web Mercator.
  let noiseServerUrl = null;

  function esriExportTileLayer(url, options) {
    const Layer = L.TileLayer.extend({
      getTileUrl(coords) {
        const size = this.getTileSize();
        const nw = this._map.unproject(coords.scaleBy(size), coords.z);
        const se = this._map.unproject(coords.add([1, 1]).scaleBy(size), coords.z);
        const p1 = L.Projection.SphericalMercator.project(nw);
        const p2 = L.Projection.SphericalMercator.project(se);
        const params = new URLSearchParams({
          bbox: `${p1.x},${p2.y},${p2.x},${p1.y}`,
          bboxSR: "3857",
          imageSR: "3857",
          size: `${size.x},${size.y}`,
          format: "png32",
          transparent: "true",
          f: "image",
        });
        return `${url}/export?${params.toString()}`;
      },
    });
    return new Layer("", options);
  }

  async function addNoiseLayer() {
    const candidates = noiseServerUrl ? [noiseServerUrl] : BG_CONFIG.NOISE.servers;
    const problems = [];
    for (const url of candidates) {
      try {
        // Read the service root first: a dead or renamed service fails here
        // rather than silently drawing empty tiles.
        await Utils.fetchJSON(`${url}?f=json`, { timeoutMs: 20000 });
        noiseServerUrl = url;
        const layer = esriExportTileLayer(url, { opacity: 0.55, zIndex: 350 });
        Utils.logStatus("noise", "ok", `Aviation noise from ${url.split("/services/")[1] || url}.`);
        return layer;
      } catch (err) {
        problems.push(`${url}: ${err.message}`);
      }
    }
    throw new Error(problems.join(" | "));
  }

  // The dB value under a point, read from the same service with identify.
  const noiseByGeoid = {};

  async function lookupNoise(geoid, layer) {
    if (!enabled.noise || noiseByGeoid[geoid] !== undefined || !noiseServerUrl) return;
    const center = layer && layer.getBounds ? layer.getBounds().getCenter() : null;
    if (!center) return;
    noiseByGeoid[geoid] = null;
    try {
      const b = map.getBounds();
      const params = new URLSearchParams({
        geometry: `${center.lng},${center.lat}`,
        geometryType: "esriGeometryPoint",
        sr: "4326",
        tolerance: "2",
        mapExtent: `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`,
        imageDisplay: "800,600,96",
        returnGeometry: "false",
        layers: "all",
        f: "json",
      });
      const data = await Utils.fetchJSON(`${noiseServerUrl}/identify?${params.toString()}`, { timeoutMs: 20000 });
      const hit = (data.results || [])[0];
      const raw = hit ? Utils.pickField(hit.attributes || {}, ["Pixel Value", "PixelValue", "Value", "NOISE", "DB"]) : null;
      const value = Number(raw);
      noiseByGeoid[geoid] = Number.isFinite(value) ? value : null;
    } catch (err) {
      noiseByGeoid[geoid] = null;
      Utils.logStatus("noise", "warn", `Could not read noise for ${geoid}: ${err.message}`);
    }
    if (selectedProps && geoidOf(selectedProps) === geoid) renderSelection();
  }

  function noiseBand(db) {
    if (db === null || db === undefined) return null;
    return BG_CONFIG.NOISE.BANDS.find((b) => db < b.max) || BG_CONFIG.NOISE.BANDS[BG_CONFIG.NOISE.BANDS.length - 1];
  }

  function noiseRows(props) {
    if (!enabled.noise) return "";
    const db = noiseByGeoid[geoidOf(props)];
    if (db === undefined) return "";
    if (db === null) {
      return `<div class="section-label">Aviation noise</div><p class="src-note">No modelled aviation noise at this point (below the map's floor).</p>`;
    }
    const band = noiseBand(db);
    return `
      <div class="section-label">Aviation noise${infoIcon(
        "BTS/DOT National Transportation Noise Map, aviation only. Published as a 24-hour A-weighted average (LAeq) - " +
          "NOT as DNL, so it carries no 10 dB night-time penalty and is not directly comparable with HUD's 65 dB DNL limit. " +
          "An airport with night operations feels worse than this number implies."
      )}</div>
      <table>
        <tr><td class="k">Modelled level</td><td class="v">${db.toFixed(0)} dB LAeq</td></tr>
        <tr><td class="k">Band</td><td class="v">${band ? band.label.split(" - ")[0] : "Unknown"}</td></tr>
      </table>`;
  }

  // --- Schools ------------------------------------------------------------
  // Three related but separate things, which is why they are three toggles:
  //   districts  - who runs the schools (county-wide, always available)
  //   zones      - which school an address is assigned to (LAUSD only, but
  //                that is most of the county's population)
  //   points     - where the schools actually are
  let schoolPointsUrl = null;

  function schoolLevel(props) {
    const F = BG_CONFIG.SCHOOL_POINTS.FIELDS;
    const text = [Utils.pickField(props, F.level), Utils.pickField(props, F.grades), Utils.pickField(props, F.name)]
      .filter((v) => v !== undefined && v !== null)
      .join(" ")
      .toLowerCase();

    // Order matters: "senior high" contains "high", and a K-12 span contains
    // both, so the most specific test has to run first.
    if (/high school|senior high|\b9-12\b|\b9\u201312\b/.test(text)) return "high";
    if (/middle|junior high|intermediate|\b6-8\b|\b7-8\b/.test(text)) return "middle";
    if (/elementary|primary|\bk-5\b|\bk-6\b|\bk-8\b|kindergarten/.test(text)) return "elementary";

    // Fall back to reading the grade span numerically: the highest grade
    // offered decides the level.
    const span = String(Utils.pickField(props, F.grades) || "");
    const nums = span.match(/\d+/g);
    if (nums && nums.length) {
      const top = Math.max(...nums.map(Number));
      if (top >= 9) return "high";
      if (top >= 6) return "middle";
      return "elementary";
    }
    return "other";
  }

  function schoolMarker(feature, latlng) {
    const level = schoolLevel(feature.properties);
    return L.circleMarker(latlng, {
      radius: 5,
      color: "#ffffff",
      weight: 1.5,
      fillColor: BG_CONFIG.SCHOOL_LEVEL_COLORS[level] || BG_CONFIG.SCHOOL_LEVEL_COLORS.other,
      fillOpacity: 0.95,
    });
  }

  function schoolPopup(props) {
    const F = BG_CONFIG.SCHOOL_POINTS.FIELDS;
    const name = Utils.pickField(props, F.name) || "School";
    const rows = [
      ["District", Utils.pickField(props, F.district)],
      ["Grades", Utils.pickField(props, F.grades)],
      ["Level", schoolLevel(props)],
      ["City", Utils.pickField(props, F.city)],
    ]
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `<tr><td class="k">${k}</td><td class="v">${v}</td></tr>`)
      .join("");
    return `<div class="school-popup"><strong>${name}</strong><table>${rows}</table>
      <a href="${Utils.greatSchoolsSearchUrl(name)}" target="_blank" rel="noopener">GreatSchools rating &rarr;</a></div>`;
  }

  async function fetchSchoolPoints(bbox) {
    const spec = BG_CONFIG.SCHOOL_POINTS;
    const candidates = schoolPointsUrl ? [schoolPointsUrl] : spec.servers;
    const problems = [];

    for (const url of candidates) {
      try {
        const gj = await Utils.fetchEsriAsGeoJSON(
          Utils.arcgisQueryUrl(url, null, { bbox, outFields: "*" }),
          { timeoutMs: 30000 }
        );
        schoolPointsUrl = url;
        // Closed and merged schools are still in the file; drawing them puts
        // dots on buildings that are not schools any more.
        const open = gj.features.filter((f) => {
          const status = Utils.pickField(f.properties, spec.FIELDS.status);
          return status === undefined || /active|open/i.test(String(status));
        });
        Utils.logStatus("schools", "info", `Schools: ${open.length} open sites from ${url.split("/services/")[1] || url}.`);
        return { type: "FeatureCollection", features: open };
      } catch (err) {
        problems.push(`${url}: ${err.message}`);
      }
    }
    throw new Error(problems.join(" | "));
  }

  // --- Which schools serve this block group -------------------------------
  // The attendance zone that contains the block group's centre is the answer.
  // Zones are only in memory when that layer is on, so when it is off the
  // same question is asked of the server directly - one small point query,
  // cached per block group.
  const schoolsByGeoid = {};

  function pointInGeometry(lat, lon, geometry) {
    const rings =
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
    return rings.some((polygon) => {
      if (!Utils.pointInRing([lon, lat], polygon[0])) return false;
      // A hit inside a hole is not a hit.
      return !polygon.slice(1).some((hole) => Utils.pointInRing([lon, lat], hole));
    });
  }

  function zoneNameOf(props) {
    return (
      Utils.pickField(props, ["SCHOOL", "School", "SchoolName", "NAME", "Name", "LABEL"]) || null
    );
  }

  function zonesFromLoadedLayer(lat, lon) {
    if (!layers.schoolZones) return null;
    const hits = [];
    layers.schoolZones.eachLayer((l) => {
      if (l.feature && l.feature.geometry && pointInGeometry(lat, lon, l.feature.geometry)) {
        hits.push({ layer: l.feature.properties.SOURCE_LAYER || "", name: zoneNameOf(l.feature.properties) });
      }
    });
    return hits;
  }

  async function lookupSchools(geoid, layer) {
    if (schoolsByGeoid[geoid] !== undefined) return;
    const center = layer && layer.getBounds ? layer.getBounds().getCenter() : null;
    if (!center) return;

    const fromLoaded = zonesFromLoadedLayer(center.lat, center.lng);
    if (fromLoaded && fromLoaded.length) {
      schoolsByGeoid[geoid] = fromLoaded;
      if (selectedProps && geoidOf(selectedProps) === geoid) renderSelection();
      return;
    }

    schoolsByGeoid[geoid] = null; // in flight; stops a second click re-asking
    try {
      const source = await resolveOverlaySource("schoolZones");
      const hits = [];
      for (const sub of source.sublayers) {
        const url = Utils.arcgisQueryUrl(source.url, sub.id, {
          outFields: "*",
          extraParams: {
            geometry: `${center.lng},${center.lat}`,
            geometryType: "esriGeometryPoint",
            inSR: "4326",
            spatialRel: "esriSpatialRelIntersects",
            returnGeometry: "false",
          },
        });
        const data = await Utils.fetchJSON(url, { timeoutMs: 20000 });
        (data.features || []).forEach((f) => {
          const name = zoneNameOf(f.attributes || {});
          if (name) hits.push({ layer: sub.name, name });
        });
      }
      schoolsByGeoid[geoid] = hits;
    } catch (err) {
      schoolsByGeoid[geoid] = [];
      Utils.logStatus("schoolZones", "warn", `Could not look up schools for ${geoid}: ${err.message}`);
    }
    if (selectedProps && geoidOf(selectedProps) === geoid) renderSelection();
  }

  // A zone sublayer is named e.g. "LAUSD Attendance Boundary (Middle
  // Schools)", which is where the level comes from.
  function zoneLevel(layerName) {
    const t = String(layerName).toLowerCase();
    if (t.includes("high")) return "high";
    if (t.includes("middle")) return "middle";
    if (t.includes("elementary")) return "elementary";
    return "other";
  }

  function schoolRows(props) {
    const geoid = geoidOf(props);
    const hits = schoolsByGeoid[geoid];
    if (hits === undefined) return "";
    if (hits === null) {
      return `<div class="section-label">Schools</div><p class="src-note">Looking up assigned schools&hellip;</p>`;
    }
    if (!hits.length) {
      return `<div class="section-label">Schools${infoIcon(
        "Assigned-school boundaries are published by each district, and only LAUSD's are wired up here. " +
          "Outside LAUSD - Long Beach, Pasadena, Glendale, Santa Monica-Malibu and the rest - no boundary is shown rather than a guess."
      )}</div><p class="src-note">No published attendance boundary covers this block group.</p>`;
    }

    const rows = hits
      .map(
        (h) =>
          `<tr><td class="k"><span class="school-dot" style="background:${
            BG_CONFIG.SCHOOL_LEVEL_COLORS[zoneLevel(h.layer)] || BG_CONFIG.SCHOOL_LEVEL_COLORS.other
          }"></span>${zoneLevel(h.layer).replace(/^./, (c) => c.toUpperCase())}</td>` +
          `<td class="v">${h.name}</td></tr>`
      )
      .join("");

    return `<div class="section-label">Schools${infoIcon(
      "The school whose attendance boundary contains the centre of this block group (LAUSD's own boundaries). " +
        "A large block group can straddle two zones, and magnet, charter and permit options are not attendance-based at all - " +
        "so treat this as the default assignment, not a guarantee."
    )}</div><table>${rows}</table>`;
  }

  // --- Wind (Global Wind Atlas 3) -----------------------------------------
  // GWA publishes GeoTIFF rasters only - no tile service, no WMS - so this
  // reads the JSON grid that scripts/fetch-wind-data.py bakes out of a
  // downloaded GeoTIFF: a plain row-major array of mean wind speeds plus the
  // bounding box it covers.
  let windGrid = null;
  let windError = null;
  let windOverlay = null;

  async function loadWindData() {
    if (windGrid || windError) return;
    try {
      const res = await fetch(BG_CONFIG.WIND_DATA, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const data = await res.json();
      if (!data.values || !data.bbox || !data.nrows || !data.ncols) {
        throw new Error("file is missing bbox/nrows/ncols/values");
      }
      windGrid = data;
      Utils.logStatus(
        "wind",
        "ok",
        `Wind grid loaded: ${data.ncols}x${data.nrows} cells at ${data.meta && data.meta.height ? data.meta.height : "?"} height.`
      );
    } catch (err) {
      windError = err;
      Utils.logStatus(
        "wind",
        "error",
        `No wind data at ${BG_CONFIG.WIND_DATA} (${err.message}). Download a Global Wind Atlas GeoTIFF for LA County and run ${fetchCommand().replace("fetch-blockgroup-data.py", "fetch-wind-data.py")} - see README.`
      );
    }
  }

  function windAt(lat, lon) {
    if (!windGrid) return null;
    const { bbox, nrows, ncols, values } = windGrid;
    if (lat > bbox.north || lat < bbox.south || lon < bbox.west || lon > bbox.east) return null;
    const row = Math.min(nrows - 1, Math.floor(((bbox.north - lat) / (bbox.north - bbox.south)) * nrows));
    const col = Math.min(ncols - 1, Math.floor(((lon - bbox.west) / (bbox.east - bbox.west)) * ncols));
    const v = values[row * ncols + col];
    return Number.isFinite(v) ? v : null;
  }

  function windBucket(speed) {
    if (speed === null || speed === undefined) return null;
    return BG_CONFIG.WIND_BUCKETS.find((b) => speed < b.max) || BG_CONFIG.WIND_BUCKETS[BG_CONFIG.WIND_BUCKETS.length - 1];
  }

  // Web Mercator y, in radians of the projected axis. Leaflet places an image
  // overlay linearly in *projected* space, so a grid drawn in equal steps of
  // latitude would sit progressively wrong as you move north. Drawing each
  // pixel row at its true Mercator position is what keeps the raster aligned
  // with the block group polygons underneath it.
  function mercatorY(lat) {
    return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  }
  function inverseMercatorY(y) {
    return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
  }

  function buildWindOverlay() {
    const { bbox, ncols } = windGrid;
    const width = Math.min(ncols, 1200);
    const yTop = mercatorY(bbox.north);
    const yBottom = mercatorY(bbox.south);
    // Keep pixels roughly square in projected space so the colour blocks
    // don't look stretched.
    const lonSpan = bbox.east - bbox.west;
    const height = Math.max(1, Math.round((width * (yTop - yBottom)) / ((lonSpan * Math.PI) / 180)));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(width, height);

    for (let j = 0; j < height; j += 1) {
      const y = yTop + ((j + 0.5) / height) * (yBottom - yTop);
      const lat = inverseMercatorY(y);
      for (let i = 0; i < width; i += 1) {
        const lon = bbox.west + ((i + 0.5) / width) * lonSpan;
        const bucket = windBucket(windAt(lat, lon));
        const o = (j * width + i) * 4;
        if (!bucket) {
          img.data[o + 3] = 0; // transparent where the grid has no data
          continue;
        }
        const hex = bucket.color;
        img.data[o] = parseInt(hex.slice(1, 3), 16);
        img.data[o + 1] = parseInt(hex.slice(3, 5), 16);
        img.data[o + 2] = parseInt(hex.slice(5, 7), 16);
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    return L.imageOverlay(canvas.toDataURL(), [[bbox.south, bbox.west], [bbox.north, bbox.east]], {
      opacity: 0.5,
      interactive: false,
    });
  }

  function windRows(feature) {
    if (!windGrid || !feature || !feature.geometry) return "";
    const center = centroidOf(feature);
    if (!center) return "";
    const speed = windAt(center.lat, center.lon);
    if (speed === null) return "";
    const bucket = windBucket(speed);
    const height = (windGrid.meta && windGrid.meta.height) || "100 m";
    return `
      <div class="section-label">Wind${infoIcon(
        `Mean wind speed ${height} above ground, from Global Wind Atlas 3 (DTU/World Bank). A long-run climatological average at 250 m resolution, sampled at this block group's centre - not a forecast and not a Santa Ana gust figure.`
      )}</div>
      <table>
        <tr><td class="k">Mean wind speed</td><td class="v">${speed.toFixed(1)} m/s</td></tr>
        <tr><td class="k">Band</td><td class="v">${bucket ? bucket.label : "Unknown"}</td></tr>
      </table>`;
  }

  // Average of the outer ring's vertices - good enough to sample a raster
  // with, and far cheaper than a true area centroid.
  function centroidOf(feature) {
    const g = feature.geometry;
    const ring =
      g.type === "Polygon" ? g.coordinates[0] : g.type === "MultiPolygon" ? g.coordinates[0][0] : null;
    if (!ring || !ring.length) return null;
    let lat = 0;
    let lon = 0;
    ring.forEach(([x, y]) => {
      lon += x;
      lat += y;
    });
    return { lat: lat / ring.length, lon: lon / ring.length };
  }

  // --- rendering ----------------------------------------------------------

  function geoidOf(props) {
    return Utils.pickField(props, ["GEOID", "GEOID20", "GEOID10", "BLKGRPCE"]);
  }

  // A block group GEOID is SS CCC TTTTTT B: state, county, 6-digit tract,
  // block group number. Tract codes carry two implied decimals, so 301801
  // is tract 3018.01 and 201100 is tract 2011.
  function tractAndBlockGroup(props) {
    const geoid = geoidOf(props) || "";
    let tract = Utils.pickField(props, ["TRACT", "TRACTCE", "TRACTCE20"]);
    let bg = Utils.pickField(props, ["BLKGRPCE", "BLKGRPCE20", "BLOCKGROUP"]);

    if (!tract && geoid.length >= 11) tract = geoid.slice(5, 11);
    if (!bg && geoid.length >= 12) bg = geoid.slice(11, 12);

    let tractLabel = tract || "unknown";
    if (/^\d{6}$/.test(tractLabel)) {
      const whole = String(parseInt(tractLabel.slice(0, 4), 10));
      const decimals = tractLabel.slice(4);
      tractLabel = decimals === "00" ? whole : `${whole}.${decimals}`;
    }
    return { tractLabel, bgLabel: bg || "?", geoid };
  }

  function pctOf(part, whole) {
    if (!whole || part === null || part === undefined) return null;
    return (part / whole) * 100;
  }

  function pctText(part, whole) {
    const p = pctOf(part, whole);
    return p === null ? "n/a" : `${p.toFixed(1)}%`;
  }

  function barRow(label, count, whole) {
    const p = pctOf(count, whole);
    const width = p === null ? 0 : Math.min(100, p);
    return `<div class="bar-row">
      <div class="bar-label"><span>${label}</span><span class="pct">${pctText(count, whole)}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
      <div class="bar-label"><span class="layer-desc">${Utils.fmtNumber(count)} people</span></div>
    </div>`;
  }

  // --- Density ------------------------------------------------------------
  // Population per square mile of LAND area (water excluded - a coastal block
  // group that is mostly ocean would otherwise look artificially empty).
  //
  // TIGERweb supplies AREALAND in square metres on each feature. If it's
  // missing, the area is computed from the polygon itself using the spherical
  // excess formula, so density still works rather than silently blanking.

  const EARTH_RADIUS_M = 6371008.8;
  const SQ_METERS_PER_SQ_MILE = 2589988.11;

  function ringAreaSqMeters(ring) {
    if (!ring || ring.length < 4) return 0;
    let total = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [lon1, lat1] = ring[i];
      const [lon2, lat2] = ring[i + 1];
      total +=
        ((lon2 - lon1) * Math.PI) / 180 *
        (2 + Math.sin((lat1 * Math.PI) / 180) + Math.sin((lat2 * Math.PI) / 180));
    }
    return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
  }

  function geometryAreaSqMeters(geometry) {
    if (!geometry) return 0;
    const polys =
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
    // First ring is the outer boundary; the rest are holes and subtract.
    return polys.reduce(
      (sum, rings) =>
        sum + rings.reduce((a, ring, i) => a + (i === 0 ? ringAreaSqMeters(ring) : -ringAreaSqMeters(ring)), 0),
      0
    );
  }

  function landAreaSqMiles(feature) {
    const declared = Number(Utils.pickField(feature.properties, ["AREALAND", "ALAND"]));
    const sqm = declared > 0 ? declared : geometryAreaSqMeters(feature.geometry);
    return sqm > 0 ? sqm / SQ_METERS_PER_SQ_MILE : null;
  }

  function densityOf(feature) {
    const record = recordFor(feature.properties);
    if (!record || !record.totalPopulation) return null;
    const sqMiles = landAreaSqMiles(feature);
    if (!sqMiles) return null;
    return record.totalPopulation / sqMiles;
  }

  function densityBucket(density) {
    if (density == null) return null;
    // Buckets are listed densest-first, so scan from the sparse end up.
    const ordered = [...BG_CONFIG.DENSITY_BUCKETS].reverse();
    return ordered.find((b) => density < b.max) || ordered[ordered.length - 1];
  }

  // Reports the real percentiles of what's on screen, so the hardcoded
  // thresholds above can be checked against actual data.
  function logDensityDistribution() {
    if (!layers.blockGroup) return;
    const values = [];
    layers.blockGroup.eachLayer((l) => {
      const d = densityOf(l.feature);
      if (d != null) values.push(d);
    });
    if (values.length < 2) return; // min/max alone is still useful for calibration
    values.sort((a, b) => a - b);
    const at = (p) => Math.round(values[Math.floor((values.length - 1) * p)]);
    Utils.logStatus(
      "density",
      "info",
      `Density of ${values.length} visible block groups (people/sq mi) - ` +
        `min ${at(0)}, 20th ${at(0.2)}, 40th ${at(0.4)}, 60th ${at(0.6)}, 80th ${at(0.8)}, max ${at(1)}.`
    );
  }

  // Small "i" with a hover explanation. Uses title= so it works without any
  // extra JS or positioning logic, including inside a Leaflet popup.
  // The explanation is carried on the element and shown by initInfoTips
  // below, not by the browser's own title tooltip. Two reasons: a native
  // tooltip only appears after a long hover and is easy to miss entirely,
  // and inside the card - which is a scrolling box - it competes with the
  // scroll container. The custom one is attached to <body>, so it can never
  // be clipped by the card it sits in.
  function infoIcon(text) {
    const safe = String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    return `<span class="info-icon" data-tip="${safe}" tabindex="0" role="button" aria-label="Explain this figure">i</span>`;
  }

  // One tooltip element, shown wherever an info icon is hovered, focused or
  // tapped - the card exists in two places (map popup and sidebar) and both
  // are re-rendered constantly, so this listens on the document rather than
  // wiring up each icon as it is created.
  let tipEl = null;

  function hideInfoTip() {
    if (tipEl) tipEl.classList.add("hidden");
  }

  function showInfoTip(icon) {
    const text = icon.getAttribute("data-tip");
    if (!text) return;
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.id = "info-tip";
      tipEl.className = "hidden";
      document.body.appendChild(tipEl);
    }
    tipEl.textContent = text;
    tipEl.classList.remove("hidden");

    // Position under the icon, then pull back inside the window if that
    // would push it off the right or bottom edge.
    const box = icon.getBoundingClientRect();
    const tip = tipEl.getBoundingClientRect();
    let left = box.left;
    let top = box.bottom + 6;
    if (left + tip.width > window.innerWidth - 8) left = window.innerWidth - tip.width - 8;
    if (top + tip.height > window.innerHeight - 8) top = box.top - tip.height - 6;
    tipEl.style.left = `${Math.max(8, left)}px`;
    tipEl.style.top = `${Math.max(8, top)}px`;
  }

  function initInfoTips() {
    document.addEventListener("mouseover", (e) => {
      const icon = e.target.closest && e.target.closest(".info-icon");
      if (icon) showInfoTip(icon);
    });
    document.addEventListener("mouseout", (e) => {
      if (e.target.closest && e.target.closest(".info-icon")) hideInfoTip();
    });
    document.addEventListener("focusin", (e) => {
      const icon = e.target.closest && e.target.closest(".info-icon");
      if (icon) showInfoTip(icon);
    });
    document.addEventListener("focusout", hideInfoTip);
    // Tap support: on a touch screen there is no hover at all.
    document.addEventListener("click", (e) => {
      const icon = e.target.closest && e.target.closest(".info-icon");
      if (icon) {
        e.stopPropagation();
        showInfoTip(icon);
      } else {
        hideInfoTip();
      }
    });
    // A tooltip left hanging over a moving map looks broken.
    map.on("movestart zoomstart popupclose", hideInfoTip);
  }

  // B19001: households by income bracket. This was being fetched all along
  // but never displayed - the card only showed the single median figure.
  function incomeBracketBars(record) {
    const brackets = record.incomeBrackets;
    if (!brackets) return "";
    const households = record.householdCount || Object.values(brackets).reduce((a, b) => a + b, 0);
    if (!households) return "";

    const rows = Object.entries(brackets)
      .filter(([, n]) => n > 0)
      .map(([label, n]) => barRow(label, n, households))
      .join("");
    if (!rows) return "";

    return `<div class="sub-label">Households by income bracket${infoIcon(
      "ACS B19001. Percentages are of the " +
        Utils.fmtNumber(households) +
        " households in this block group, not of people."
    )}</div>${rows}`;
  }

  function densityRows(feature) {
    if (!feature) return "";
    const sqMiles = landAreaSqMiles(feature);
    const density = densityOf(feature);
    if (density == null || !sqMiles) return "";
    const bucket = densityBucket(density);
    return `
      <tr><td class="k">Land area</td><td class="v">${sqMiles.toFixed(2)} sq mi</td></tr>
      <tr><td class="k">Density</td><td class="v">${Utils.fmtNumber(Math.round(density))} /sq mi</td></tr>
      ${bucket ? `<tr><td class="k">Density band</td><td class="v">
        <span class="swatch inline" style="background:${bucket.color}"></span>${bucket.label.replace(/\s*\(.*\)/, "")}
      </td></tr>` : ""}`;
  }

  // Average household size. Prefer ACS B25010, which the Census Bureau
  // computes as population living in households divided by occupied units.
  // Where that is missing - a data file fetched before B25010 was added -
  // fall back to total population over the B19001 household count. The two
  // differ slightly, because B25010 excludes people in group quarters
  // (dorms, care homes, barracks) while total population does not, so the
  // derived figure is labelled as an estimate rather than passed off as the
  // published one.
  // Returns { value, published } so the card can mark a derived figure and
  // the filter can use the same number without duplicating the fallback.
  function householdSize(record) {
    if (!record) return { value: null, published: false };
    if (record.avgHouseholdSize !== undefined && record.avgHouseholdSize !== null) {
      return { value: record.avgHouseholdSize, published: true };
    }
    if (record.householdCount && record.totalPopulation) {
      return { value: record.totalPopulation / record.householdCount, published: false };
    }
    return { value: null, published: false };
  }

  function householdSizeRow(record) {
    const { value, published } = householdSize(record);
    if (!value) return "";

    const tip = published
      ? "ACS B25010: people living in households divided by occupied housing units. " +
        "People in group quarters - dorms, care homes, barracks - are excluded from both sides."
      : "Estimated as total population divided by the number of households (ACS B19001), " +
        "because this data file predates the B25010 fetch. It runs slightly high where a " +
        "block group holds group quarters such as dorms or care homes, since those residents " +
        "count in the population but live in no household. Re-run the fetch script for the " +
        "Census Bureau's own figure.";

    return `<tr><td class="k">Average household size${infoIcon(tip)}</td>` +
      `<td class="v key-figure">${value.toFixed(2)} people${published ? "" : " (est.)"}</td></tr>`;
  }

  function shareOf(part, whole) {
    return whole ? (part / whole) * 100 : null;
  }

  function detachedShare(record) {
    if (!record || !record.structureUnits || !record.structureTotal) return null;
    return shareOf(record.structureUnits["1, detached"] || 0, record.structureTotal);
  }

  function ownerShare(record) {
    if (!record || !record.tenureTotal) return null;
    return shareOf(record.ownerOccupied || 0, record.tenureTotal);
  }

  function wfhShare(record) {
    if (!record || !record.workersTotal) return null;
    return shareOf(record.workedFromHome || 0, record.workersTotal);
  }

  function pre1980Share(record) {
    if (!record || !record.yearBuiltTotal) return null;
    return shareOf(record.yearBuiltPre1980 || 0, record.yearBuiltTotal);
  }

  function housingRows(record) {
    const detached = detachedShare(record);
    const owner = ownerShare(record);
    if (detached === null && owner === null && !record.medianYearBuilt) return "";

    const rows = [];
    if (detached !== null) {
      rows.push(
        `<tr><td class="k">Detached houses${infoIcon(
          "Share of all housing units that are single detached houses (ACS B25024). This is what separates a dense block " +
            "group of small lots from one holding an apartment tower - population density alone cannot tell them apart."
        )}</td><td class="v">${detached.toFixed(1)}%</td></tr>`
      );
    }
    if (owner !== null) {
      rows.push(
        `<tr><td class="k">Owner-occupied${infoIcon(
          "Share of occupied homes lived in by their owner (ACS B25003). Worth reading next to the income figures: two " +
            "block groups can show the same median household income while one is mostly owners and the other mostly renters."
        )}</td><td class="v">${owner.toFixed(1)}%</td></tr>`
      );
    }
    if (record.medianYearBuilt) {
      const pre80 = pre1980Share(record);
      rows.push(
        `<tr><td class="k">Median year built${infoIcon(
          "ACS B25035, the midpoint year for housing here. LA thresholds worth knowing: before 1978 lead paint is likely, " +
            "before 1980 asbestos, before 1994 pre-Northridge soft-story risk. This describes the stock, not any one house - " +
            "a remodelled 1948 home looks identical here to an untouched one."
        )}</td><td class="v">${record.medianYearBuilt}</td></tr>`
      );
      if (pre80 !== null) {
        rows.push(`<tr><td class="k">Built before 1980</td><td class="v">${pre80.toFixed(0)}%</td></tr>`);
      }
    }
    return `<div class="section-label">Housing stock</div><table>${rows.join("")}</table>`;
  }

  function commuteRows(record) {
    const wfh = wfhShare(record);
    if (wfh === null) return "";
    const walked = shareOf(record.walkedToWork || 0, record.workersTotal);
    const transit = shareOf(record.transitToWork || 0, record.workersTotal);
    return `
      <div class="section-label">Work${infoIcon(
        "ACS B08301, how residents get to work. Nearly everyone in LA drives, so the useful lines are these three. " +
          "Work-from-home share is the closest thing to an occupation signal available at block group level, and it " +
          "also predicts whether a neighbourhood is alive on a Tuesday afternoon. Walking above about 5% marks a " +
          "genuinely walkable pocket - it is near zero almost everywhere else."
      )}</div>
      <table>
        <tr><td class="k">Work from home</td><td class="v">${wfh.toFixed(1)}%</td></tr>
        <tr><td class="k">Walk to work</td><td class="v">${walked === null ? "n/a" : `${walked.toFixed(1)}%`}</td></tr>
        <tr><td class="k">Public transit</td><td class="v">${transit === null ? "n/a" : `${transit.toFixed(1)}%`}</td></tr>
      </table>`;
  }

  function ageBandCount(record, band) {
    if (!record.ageBrackets) return null;
    return band.brackets.reduce((sum, i) => sum + (record.ageBrackets[String(i)] || 0), 0);
  }

  // --- ZIP lookup ---------------------------------------------------------
  // Block groups don't nest inside ZCTAs, so the ZIP has to be resolved
  // spatially: ask TIGERweb which ZCTA polygon contains the block group's
  // centre. One request per block group, cached, so repeat clicks are free.
  const zipCache = {};

  function zipForGeoid(geoid) {
    return zipCache[geoid] || null;
  }

  async function lookupZip(geoid, layer) {
    if (!geoid || zipCache[geoid] !== undefined) return;
    zipCache[geoid] = null; // mark in-flight so we don't ask twice
    try {
      const c = layer.getBounds().getCenter();
      const layerId = await resolveLayerId("zip"); // cached; this used to refetch every click
      const url = Utils.arcgisQueryUrl(BG_CONFIG.TIGERWEB, layerId, {
        bbox: { xmin: c.lng, ymin: c.lat, xmax: c.lng, ymax: c.lat },
        outFields: "*",
      });
      const gj = await Utils.fetchEsriAsGeoJSON(url, { timeoutMs: 20000 });
      const f = gj.features[0];
      const zip = f
        ? Utils.pickField(f.properties, ["ZCTA5CE20", "ZCTA5CE10", "ZCTA5", "BASENAME", "NAME"])
        : null;
      zipCache[geoid] = zip ? String(zip).replace(/\D/g, "").slice(-5) : null;
      // Re-render if this block group is still the one on screen.
      if (zipCache[geoid] && selectedProps && geoidOf(selectedProps) === geoid) {
        renderSelection();
      }
    } catch (err) {
      Utils.logStatus("zip", "warn", `Could not resolve ZIP for ${geoid}: ${err.message}`);
    }
  }

  function ethnicityBlock(record) {
    const useDecennial = ethSource === "dec";
    const counts = useDecennial ? record.ethnicityDec : record.ethnicityAcs;
    const total = useDecennial ? record.ethnicityDecTotal : record.ethnicityAcsTotal;
    const sourceName = useDecennial ? "2020 Census P2" : `ACS ${censusData.meta.year} B03002`;

    if (!counts) {
      return `<p class="footnote">No ${sourceName} data for this block group.</p>`;
    }
    // Bars rather than a table, matching the age section - relative size is
    // the thing you actually read here, and a column of percentages makes you
    // do that comparison in your head.
    const bars = Object.entries(counts)
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => barRow(label, count, total))
      .join("");

    return `${bars || "<p class='footnote'>No ethnicity counts for this block group.</p>"}
      <p class="src-note">Source: ${sourceName}${geoNote("ethnicity" + (useDecennial ? "Dec" : "Acs"))}</p>`;
  }

  // Flags any metric the fetch script had to pull from tract level because
  // it wasn't published at block group.
  function geoNote(key) {
    const level = ((censusData && censusData.meta.geoLevels) || {})[key];
    return level && level !== "block group" ? ` &mdash; <strong>${level}-level</strong>` : "";
  }

  // compact=true trims the footnotes for the map popup, which has to fit on
  // screen; the sidebar carries the fuller version.
  function detailHTML(props, record, { compact = false, feature = null } = {}) {
    const { tractLabel, bgLabel, geoid } = tractAndBlockGroup(props);
    const heading = `Tract ${tractLabel}, Block Group ${bgLabel}`;

    if (!record) {
      const reason = censusData
        ? "This block group isn't in the local data file (it may fall outside LA County)."
        : censusDataError
        ? describeDataFailure(censusDataError).detail
        : "Block group data is still loading.";
      return `<div class="detail-card">
        <h3>${heading}</h3>
        <p class="geoid">GEOID ${geoid || "unknown"}</p>
        <p class="footnote">${reason}</p>
      </div>`;
    }

    const pop = record.totalPopulation;
    const sexTotal = (record.male || 0) + (record.female || 0);
    const bachelorsPct = pctText(record.eduBachelorsPlus, record.eduTotal25plus);
    const zip = zipForGeoid(geoid);

    // Data files written before age brackets were stored individually can't
    // produce these bands - say so instead of rendering silent blanks.
    const ageHtml = record.ageBrackets
      ? BG_CONFIG.AGE_BANDS.map((band) => barRow(band.label, ageBandCount(record, band), pop)).join("")
      : `<p class="footnote">This data file predates the current age bands. Re-run
         <code>${fetchCommand()}</code> to refresh it.</p>`;

    // Header order is deliberate: ZIP first and loud, because it is the thing
    // people orient by, then the tract/block group name, then the GEOID for
    // anyone cross-referencing Census tables.
    return `<div class="detail-card">
      ${zip ? `<p class="card-zip key-figure">ZIP ${zip}</p>` : ""}
      <h3>${heading}</h3>
      <p class="geoid">GEOID ${geoid}</p>

      <table>
        <tr><td class="k">Total population</td><td class="v">${Utils.fmtNumber(pop)}</td></tr>
        ${householdSizeRow(record)}
        ${densityRows(feature)}
      </table>

      <div class="section-label">Age</div>
      ${ageHtml}

      <div class="section-label">Sex</div>
      <table>
        <tr><td class="k">Female</td><td class="v">${pctText(record.female, sexTotal)}</td><td class="v count">${Utils.fmtNumber(record.female)}</td></tr>
        <tr><td class="k">Male</td><td class="v">${pctText(record.male, sexTotal)}</td><td class="v count">${Utils.fmtNumber(record.male)}</td></tr>
      </table>

      <div class="section-label">Ethnicity</div>
      ${ethnicityBlock(record)}

      <div class="section-label">Education</div>
      <table>
        <tr><td class="k">Bachelor's degree or higher${infoIcon(
          "Share of residents aged 25 and over, not of total population. " +
            "ACS table B15003 only covers the 25+ population - under-25s are " +
            "excluded from both the numerator and the denominator, so this " +
            "figure is not comparable with the age, sex and ethnicity " +
            "percentages above (which are shares of everyone)."
        )}</td><td class="v key-figure">${bachelorsPct}</td></tr>
      </table>
      ${compact ? "" : `<p class="src-note">Source: ACS B15003, share of the 25-and-over population${geoNote("education")}</p>`}

      <div class="section-label">Income</div>
      <table>
        <tr><td class="k">Median household income${infoIcon(
          "The midpoint of household incomes (ACS B19013): half the households " +
            "earn more, half less. A household is everyone living at one address, " +
            "so this is not the same as an individual's earnings."
        )}</td><td class="v key-figure">${Utils.fmtCurrency(record.medianHouseholdIncome)}</td></tr>
        <tr><td class="k">Per-capita income${infoIcon(
          "Total income divided by every resident including children (ACS B19301). " +
            "Always lower than the household median, and the gap widens where " +
            "households are larger."
        )}</td><td class="v key-figure">${Utils.fmtCurrency(record.perCapitaIncome)}</td></tr>
      </table>
      <p class="src-note">Per-capita income counts <strong>every resident, children included</strong>,
         which is why it sits well below the household median.</p>
      ${incomeBracketBars(record)}
      ${compact ? "" : `<p class="src-note">Source: ACS B19013 / B19301${geoNote("income")}</p>`}

      ${priceRows(props)}
      ${housingRows(record)}
      ${commuteRows(record)}
      ${schoolRows(props)}
      ${noiseRows(props)}
      ${floodRows(feature)}
      ${enabled.pollution ? cesRows(props) : ""}
      ${enabled.wind ? windRows(feature) : ""}

      ${
        compact
          ? ""
          : `<p class="footnote">Age and sex from ACS B01001${geoNote("age")}. Bands are built from the
             table's own 5-year brackets, so they align exactly and never overlap.</p>`
      }
    </div>`;
  }

  function recordFor(props) {
    return censusData && censusData.blockGroups ? censusData.blockGroups[geoidOf(props)] : null;
  }

  // --- Filters ------------------------------------------------------------
  // Every metric is a function from a block group record to a number (or null
  // when that block group has no data). Filtering is then: compute metric,
  // compare against the threshold, AND the active filters together. All of it
  // runs against data already in memory, so it's instant and offline.
  const METRICS = {
    bachelors: {
      label: "Bachelor's degree or higher (%)",
      unit: "%",
      value: (r) => (r.eduTotal25plus ? (r.eduBachelorsPlus / r.eduTotal25plus) * 100 : null),
    },
    density: {
      label: "Population density (/sq mi)",
      unit: "/sq mi",
      value: (r, f) => (f ? densityOf(f) : null),
    },
    medianIncome: {
      label: "Median household income ($)",
      unit: "$",
      // Dollar filters step in $5k: the arrows and the scroll wheel move by a
      // meaningful amount instead of $1 at a time.
      step: 5000,
      value: (r) => (r.medianHouseholdIncome != null ? r.medianHouseholdIncome : null),
    },
    perCapitaIncome: {
      label: "Per-capita income ($)",
      unit: "$",
      step: 5000,
      value: (r) => (r.perCapitaIncome != null ? r.perCapitaIncome : null),
    },
    population: {
      label: "Total population",
      unit: "",
      value: (r) => (r.totalPopulation != null ? r.totalPopulation : null),
    },
    householdSize: {
      label: "Average household size (people)",
      unit: "people",
      value: (r) => householdSize(r).value,
    },
    medianSalePrice: {
      label: "Median home sale price ($)",
      unit: "$",
      step: 25000,
      value: (r, f, props) => {
        const p = props ? parcelFor(props) : null;
        return p ? p.medianSalePrice : null;
      },
    },
    pricePerSqft: {
      label: "Home price per sq ft ($)",
      unit: "$",
      step: 25,
      value: (r, f, props) => {
        const p = props ? parcelFor(props) : null;
        return p && p.medianPricePerSqft ? p.medianPricePerSqft : null;
      },
    },
    detached: {
      label: "Detached houses (%)",
      unit: "%",
      value: (r) => detachedShare(r),
    },
    owner: {
      label: "Owner-occupied (%)",
      unit: "%",
      value: (r) => ownerShare(r),
    },
    wfh: {
      label: "Work from home (%)",
      unit: "%",
      value: (r) => wfhShare(r),
    },
    medianYearBuilt: {
      label: "Median year built",
      unit: "",
      step: 5,
      value: (r) => (r.medianYearBuilt != null ? r.medianYearBuilt : null),
    },
    pre1980: {
      label: "Built before 1980 (%)",
      unit: "%",
      value: (r) => pre1980Share(r),
    },
  };

  // Ethnicity metrics are generated from whichever source is selected, so the
  // filter follows the B03002 / P2 toggle rather than being pinned to one.
  const ETHNICITIES = [
    "Hispanic or Latino",
    "White (non-Hispanic)",
    "Black (non-Hispanic)",
    "Asian (non-Hispanic)",
    "American Indian / Alaska Native (non-Hispanic)",
    "Native Hawaiian / Pacific Islander (non-Hispanic)",
    "Two or more races (non-Hispanic)",
    "Some other race (non-Hispanic)",
  ];

  function metricFor(key) {
    if (METRICS[key]) return METRICS[key];
    if (key.startsWith("eth:")) {
      const name = key.slice(4);
      return {
        label: `${name} (%)`,
        unit: "%",
        value: (r) => {
          const counts = ethSource === "dec" ? r.ethnicityDec : r.ethnicityAcs;
          const total = ethSource === "dec" ? r.ethnicityDecTotal : r.ethnicityAcsTotal;
          if (!counts || !total) return null;
          return ((counts[name] || 0) / total) * 100;
        },
      };
    }
    // Age bands, e.g. "age:25 to 34"
    if (key.startsWith("age:")) {
      const label = key.slice(4);
      const band = BG_CONFIG.AGE_BANDS.find((b) => b.label === label);
      return {
        label: `Age ${label} (%)`,
        unit: "%",
        value: (r) => {
          const n = band ? ageBandCount(r, band) : null;
          return n == null || !r.totalPopulation ? null : (n / r.totalPopulation) * 100;
        },
      };
    }
    return null;
  }

  const filters = [
    { enabled: false, metric: "bachelors", op: "above", value: 50 },
    { enabled: false, metric: "eth:Asian (non-Hispanic)", op: "above", value: 30 },
    { enabled: false, metric: "medianIncome", op: "above", value: 100000 },
    { enabled: false, metric: "perCapitaIncome", op: "above", value: 50000 },
    { enabled: false, metric: "age:25 to 34", op: "above", value: 20 },
    { enabled: false, metric: "density", op: "below", value: 5000 },
  ];

  function activeFilters() {
    return filters.filter((f) => f.enabled && f.value !== "" && !isNaN(Number(f.value)));
  }

  // A block group matches only if EVERY active filter passes. No data for a
  // given metric counts as not matching - better than silently treating a
  // gap as a zero.
  function matchesFilters(record, feature) {
    if (!record) return false;
    return activeFilters().every((f) => {
      const metric = metricFor(f.metric);
      if (!metric) return true;
      // Third argument is the polygon's own attributes: price metrics key off
      // the GEOID rather than the census record, which may not exist.
      const v = metric.value(record, feature, feature ? feature.properties : null);
      if (v == null) return false;
      return f.op === "above" ? v > Number(f.value) : v < Number(f.value);
    });
  }

  // A block group's colour is a property OF THE BLOCK GROUP, not of the
  // filter. Density shading decides the shade; filters only decide whether
  // that shade is shown or dimmed. So turning filters on doesn't repaint
  // anything - the survivors keep exactly the shade they already had.
  function baseStyleFor(feature) {
    if (densityShading) {
      const bucket = densityBucket(densityOf(feature));
      return bucket
        ? { color: "#1b4332", weight: 0.6, fillColor: bucket.color, fillOpacity: 0.75 }
        : { color: "#9aa3ad", weight: 0.4, fillColor: "#e9edf0", fillOpacity: 0.3 };
    }
    return BG_CONFIG.STYLES.blockGroup;
  }

  function styleForBlockGroup(feature) {
    const base = baseStyleFor(feature);
    if (!activeFilters().length) return base;

    const record = recordFor(feature.properties);
    if (matchesFilters(record, feature)) {
      // Keep the block group's own shade; just make it read as "selected".
      return densityShading
        ? { ...base, weight: 1.4, color: "#14663a" }
        : BG_CONFIG.STYLES.blockGroupMatch;
    }
    // Non-matching: dimmed rather than recoloured, so the shading you're
    // looking at stays comparable.
    return { ...base, fillOpacity: 0.04, weight: 0.3, color: "#9aa3ad" };
  }

  function renderDensityLegend() {
    const box = document.getElementById("density-legend");
    if (!densityShading) {
      box.classList.add("hidden");
      return;
    }
    box.classList.remove("hidden");
    box.innerHTML = BG_CONFIG.DENSITY_BUCKETS.map(
      (b) => `<div class="legend-row"><span class="swatch" style="background:${b.color}"></span>${b.label}</div>`
    ).join("");
  }

  function applyFilters() {
    let matched = 0;
    let total = 0;
    if (layers.blockGroup) {
      layers.blockGroup.eachLayer((l) => {
        total++;
        const style = styleForBlockGroup(l.feature);
        if (matchesFilters(recordFor(l.feature.properties), l.feature)) matched++;
        if (l !== selectedLayer) l.setStyle(style);
      });
    }

    const summary = document.getElementById("filter-summary");
    const active = activeFilters();
    if (!active.length) {
      summary.className = "hint";
      summary.textContent = "Off - all block groups shown normally.";
    } else {
      summary.className = "hint active";
      const desc = active
        .map((f) => `${metricFor(f.metric).label} ${f.op} ${f.value}`)
        .join(" AND ");
      summary.textContent = `${matched} of ${total} visible block groups match: ${desc}`;
    }
  }

  function stepFor(metricKey) {
    const m = metricFor(metricKey);
    return m && m.step ? m.step : "any";
  }

  function renderFilterRows() {
    const wrap = document.getElementById("filter-rows");
    const options = [
      ...Object.entries(METRICS).map(([k, m]) => ({ key: k, label: m.label })),
      ...ETHNICITIES.map((n) => ({ key: `eth:${n}`, label: `${n} (%)` })),
      ...BG_CONFIG.AGE_BANDS.map((b) => ({ key: `age:${b.label}`, label: `Age ${b.label} (%)` })),
    ];

    wrap.innerHTML = filters
      .map(
        (f, i) => `
      <div class="filter-row-head">
        <input type="checkbox" class="filter-enable" id="filter-on-${i}" ${f.enabled ? "checked" : ""} />
        <label for="filter-on-${i}">Filter ${i + 1}</label>
      </div>
      <div class="filter-row">
        <select id="filter-metric-${i}">
          ${options
            .map((o) => `<option value="${o.key}" ${o.key === f.metric ? "selected" : ""}>${o.label}</option>`)
            .join("")}
        </select>
        <select id="filter-op-${i}">
          <option value="above" ${f.op === "above" ? "selected" : ""}>above</option>
          <option value="below" ${f.op === "below" ? "selected" : ""}>below</option>
        </select>
        <input type="number" id="filter-value-${i}" value="${f.value}" step="${stepFor(f.metric)}" min="0" />
      </div>`
      )
      .join("");

    filters.forEach((f, i) => {
      document.getElementById(`filter-on-${i}`).addEventListener("change", (e) => {
        f.enabled = e.target.checked;
        applyFilters();
      });
      document.getElementById(`filter-metric-${i}`).addEventListener("change", (e) => {
        f.metric = e.target.value;
        // The step belongs to the metric, so it has to follow a change of
        // metric without redrawing (and losing focus on) the whole row.
        const box = document.getElementById(`filter-value-${i}`);
        const step = stepFor(f.metric);
        box.step = step;
        if (step !== "any" && box.value !== "") {
          box.value = Math.round(Number(box.value) / step) * step;
          f.value = box.value;
        }
        applyFilters();
      });
      document.getElementById(`filter-op-${i}`).addEventListener("change", (e) => {
        f.op = e.target.value;
        applyFilters();
      });
      document.getElementById(`filter-value-${i}`).addEventListener("input", (e) => {
        f.value = e.target.value;
        applyFilters();
      });
    });
  }

  // Draws whatever is currently selected. Split out from selectBlockGroup so
  // the card can be re-rendered in place (ZIP arriving, ethnicity source
  // switching) without re-running selection side effects.
  function renderSelection() {
    if (!selectedProps) return;
    const record = recordFor(selectedProps);
    const feature = selectedLayer ? selectedLayer.feature : null;
    document.getElementById("detail-panel").innerHTML = detailHTML(selectedProps, record, { feature });
    if (cardPopup && cardPopup.isOpen()) {
      cardPopup.setContent(`<div class="bg-popup">${detailHTML(selectedProps, record, { compact: true, feature })}</div>`);
    }
  }

  const POPUP_OPTIONS = {
    maxWidth: 300,
    minWidth: 250,
    maxHeight: 480,
    autoPanPadding: [20, 20],
    autoClose: false,   // don't vanish when another popup opens
    closeOnClick: false, // ...or when the map is clicked
  };

  // ONE popup object for the whole session, owned by the map rather than
  // bound to a polygon.
  //
  // This is deliberate. A bound popup belongs to its layer, and the block
  // group layer is thrown away and rebuilt every time the map is panned far
  // enough to refetch - so the card had to be closed, re-bound and re-opened
  // on each rebuild, which is what made it blink out and back in. A map-owned
  // popup is untouched by those rebuilds: the polygons come and go
  // underneath it and the card just stays put. It also makes "only one card
  // at a time" structural rather than something to keep sweeping up after.
  let cardPopup = null;
  let selectedGeoid = null;

  function ensureCardPopup() {
    if (cardPopup) return cardPopup;
    cardPopup = L.popup(POPUP_OPTIONS);
    cardPopup.on("remove", () => {
      // Closing the card clears the highlight, but keeps the sidebar copy.
      const wasSelected = selectedLayer;
      selectedLayer = null;
      selectedGeoid = null;
      if (wasSelected && wasSelected._map) wasSelected.setStyle(styleForBlockGroup(wasSelected.feature));
    });
    return cardPopup;
  }

  // A synthetic click (as the tests fire) carries no latlng, so fall back to
  // the polygon's own centre.
  function anchorFor(layer, latlng) {
    if (latlng) return latlng;
    if (layer && layer.getBounds) return layer.getBounds().getCenter();
    return map.getCenter();
  }

  function selectBlockGroup(layer, props, { openPopup = true, latlng = null } = {}) {
    const record = recordFor(props);

    if (selectedLayer && selectedLayer !== layer && selectedLayer._map) {
      selectedLayer.setStyle(styleForBlockGroup(selectedLayer.feature));
    }
    selectedLayer = layer;
    selectedProps = props;
    selectedGeoid = geoidOf(props);
    layer.setStyle(BG_CONFIG.STYLES.blockGroupSelected);

    const html = `<div class="bg-popup">${detailHTML(props, record, { compact: true, feature: layer.feature })}</div>`;
    if (openPopup) {
      const popup = ensureCardPopup();
      popup.setLatLng(anchorFor(layer, latlng)).setContent(html);
      if (!popup.isOpen()) popup.openOn(map);
    }
    document.getElementById("detail-panel").innerHTML = detailHTML(props, record, { feature: layer.feature });

    lookupZip(geoidOf(props), layer);
    lookupSchools(geoidOf(props), layer);
    lookupNoise(geoidOf(props), layer);
  }

  // After a layer reload the polygons are new objects, so the highlight has
  // to be re-attached to the one that replaced the selected block group. The
  // card itself needs nothing: it belongs to the map, not to the polygon.
  function restoreSelection() {
    if (!selectedGeoid || !layers.blockGroup) return;

    let found = null;
    layers.blockGroup.eachLayer((l) => {
      if (!found && geoidOf(l.feature.properties) === selectedGeoid) found = l;
    });

    selectedLayer = found;
    if (found) found.setStyle(BG_CONFIG.STYLES.blockGroupSelected);
  }

  function buildLayer(key, geojson) {
    if (key === "fire") {
      dropNonHazardZones(geojson);
      logFireClasses(geojson);
      return L.geoJSON(geojson, {
        style: fireStyle,
        onEachFeature: (feature, layer) => {
          const cls = fireClass(feature.properties);
          const raw = Utils.pickField(feature.properties, [
            "HAZ_CLASS", "FHSZ_DESC", "FHSZ", "SRA_HAZ_CODE", "HAZARD_CLASS", "HAZARD", "HAZ_CODE", "CLASS",
          ]);
          layer.bindTooltip(
            `Fire hazard: ${cls ? cls.replace(/^./, (c) => c.toUpperCase()) : "unclassified"}` +
              `<br><span style="opacity:.7">${feature.properties.SOURCE_LAYER || ""}` +
              `${raw !== undefined && String(raw).toLowerCase() !== String(cls) ? ` &middot; field says "${raw}"` : ""}</span>`,
            { sticky: true }
          );
        },
      });
    }

    if (key === "pollution") {
      rememberCesTracts(geojson);
      return L.geoJSON(geojson, {
        style: pollutionStyle,
        onEachFeature: (feature, layer) => {
          layer.bindTooltip(() => pollutionTooltip(feature.properties), { sticky: true });
        },
      });
    }

    if (key === "flood") {
      return L.geoJSON(geojson, {
        style: floodStyle,
        onEachFeature: (feature, layer) => {
          const cls = floodClass(feature.properties);
          const zone = floodZoneOf(feature.properties) || "?";
          layer.bindTooltip(
            `Flood zone ${zone}<br><span style="opacity:.7">${cls ? cls.label : "unclassified"}</span>`,
            { sticky: true }
          );
        },
      });
    }

    if (key === "seismic") {
      return L.geoJSON(geojson, {
        style: seismicStyle,
        onEachFeature: (feature, layer) => {
          const kind = feature.properties.HAZARD_KIND || "hazard";
          layer.bindTooltip(
            `${kind.replace(/^./, (c) => c.toUpperCase())} zone<br>` +
              `<span style="opacity:.7">CGS seismic hazard zone - site investigation required before building</span>`,
            { sticky: true }
          );
        },
      });
    }

    if (key === "schoolDistricts") {
      return L.geoJSON(geojson, {
        style: { color: "#6d28d9", weight: 2, fill: false, opacity: 0.85, dashArray: "6 3" },
        onEachFeature: (feature, layer) => {
          const name =
            Utils.pickField(feature.properties, ["NAME", "BASENAME", "DistrictName", "District", "LEA_NAME"]) ||
            "School district";
          layer.bindTooltip(`${name}<br><span style="opacity:.7">${feature.properties.SOURCE_LAYER || ""}</span>`, {
            sticky: true,
          });
        },
      });
    }

    if (key === "schoolZones") {
      return L.geoJSON(geojson, {
        style: (feature) => {
          const level = zoneLevel(feature.properties.SOURCE_LAYER || "");
          const color = BG_CONFIG.SCHOOL_LEVEL_COLORS[level] || BG_CONFIG.SCHOOL_LEVEL_COLORS.other;
          return { color, weight: 1.4, fillColor: color, fillOpacity: 0.08 };
        },
        onEachFeature: (feature, layer) => {
          const name = zoneNameOf(feature.properties) || "Attendance zone";
          layer.bindTooltip(`${name}<br><span style="opacity:.7">${feature.properties.SOURCE_LAYER || ""}</span>`, {
            sticky: true,
          });
        },
      });
    }

    if (key === "schools") {
      return L.geoJSON(geojson, {
        pointToLayer: schoolMarker,
        onEachFeature: (feature, layer) => {
          layer.bindTooltip(
            Utils.pickField(feature.properties, BG_CONFIG.SCHOOL_POINTS.FIELDS.name) || "School"
          );
          layer.bindPopup(schoolPopup(feature.properties));
        },
      });
    }

    if (key === "blockGroup") {
      return L.geoJSON(geojson, {
        style: (feature) => styleForBlockGroup(feature),
        onEachFeature: (feature, layer) => {
          layer.on("click", (e) => {
            if (pinArmed) return; // the armed pin-drop owns this click
            selectBlockGroup(layer, feature.properties, { latlng: e && e.latlng });
          });
        },
      });
    }
    const style = BG_CONFIG.STYLES[key];
    return L.geoJSON(geojson, {
      style: () => style,
      onEachFeature: (feature, layer) => {
        const label =
          key === "zip"
            ? `ZIP ${Utils.pickField(feature.properties, ["ZCTA5CE20", "ZCTA5CE10", "BASENAME", "NAME"]) || ""}`
            : Utils.pickField(feature.properties, ["NAME", "BASENAME"]) || "Census tract";
        layer.bindTooltip(label, { sticky: true });
      },
    });
  }

  function labelFor(key) {
    if (key === "schools") return BG_CONFIG.SCHOOL_POINTS.label;
    const overlay = BG_CONFIG.OVERLAYS[key];
    if (overlay) return overlay.label;
    return { zip: "Zip code borders", tract: "Census tract borders", blockGroup: "Block group borders" }[key];
  }

  function minZoomFor(key) {
    if (key === "schools") return BG_CONFIG.SCHOOL_POINTS.minZoom;
    const overlay = BG_CONFIG.OVERLAYS[key];
    return overlay ? overlay.minZoom : BG_CONFIG.MIN_ZOOM[key];
  }

  function pollutionTooltip(props) {
    const score = cesScore(props);
    const rows = BG_CONFIG.CES_FIELDS.indicators
      .map((ind) => {
        const pctl = cesValue(props, ind.pctl);
        if (pctl === null) return "";
        const raw = cesValue(props, ind.raw);
        const rawText = raw === null ? "" : ` <span style="opacity:.6">(${raw} ${ind.unit})</span>`;
        return `<tr><td class="k">${ind.label}</td><td class="v">${pctl.toFixed(0)}th${rawText}</td></tr>`;
      })
      .join("");
    const tract = Utils.pickField(props, BG_CONFIG.CES_FIELDS.tract);
    return `<div class="ces-tip"><strong>Census tract ${tract || "?"}</strong><br>
      CalEnviroScreen ${score === null ? "not scored" : `${score.toFixed(1)}th percentile`}
      <table>${rows}</table>
      <span class="tip-note">Percentiles are against all California tracts.</span></div>`;
  }

  async function refreshLayer(key, { force = false } = {}) {
    if (!enabled[key]) return;

    const minZoom = minZoomFor(key);
    if (minZoom && map.getZoom() < minZoom) {
      if (layers[key]) {
        map.removeLayer(layers[key]);
        delete layers[key];
        delete loadedBBox[key];
      }
      updateZoomHint();
      return;
    }

    const bbox = key === "zip" ? BG_CONFIG.LA_COUNTY_BBOX : bboxOfView();


    // Skip the refetch entirely when the current view is still inside the
    // padded area already loaded. This is what stops a popup's auto-pan from
    // triggering a reload that would destroy that same popup.
    if (!force && layers[key] && viewIsInside(loadedBBox[key])) return;

    const label = labelFor(key);
    Utils.logStatus(key, "info", `Loading ${label}...`);
    try {
      const geojson =
        key === "schools"
          ? await fetchSchoolPoints(bbox)
          : BG_CONFIG.OVERLAYS[key]
          ? await fetchOverlay(key, bbox)
          : await fetchBoundaries(key, bbox);
      if (!enabled[key]) return; // toggled off while the request was in flight

      if (layers[key]) map.removeLayer(layers[key]);
      layers[key] = buildLayer(key, geojson).addTo(map);
      // Hazard and pollution are area fills: they belong under the boundary
      // lines and the block group polygons, not on top of them.
      if (BG_CONFIG.OVERLAYS[key] && layers[key].bringToBack) layers[key].bringToBack();
      if (key === "schools" && layers[key].bringToFront) layers[key].bringToFront();
      loadedBBox[key] = bbox;
      if (key === "pollution") renderSelection(); // the open card gains its CES rows

      // Re-attach the highlight to the polygon that replaced the selected
      // one. The card is a map popup and rides through untouched.
      if (key === "blockGroup") {
        restoreSelection();
        applyFilters();
      }

      if (geojson.features.length === 0) {
        // A successful query returning nothing usually means the wrong
        // TIGERweb layer id was selected (their tribal/label layers query
        // fine but are empty here), not that the area is genuinely empty.
        Utils.logStatus(
          key,
          "warn",
          BG_CONFIG.OVERLAYS[key]
            ? `${label}: 0 features in this view. Either nothing is mapped here, or the service moved.`
            : `${label}: 0 features returned from layer id ${layerIds[key]}. If this area should have data, that layer id is probably wrong.`
        );
      } else {
        Utils.logStatus(key, "ok", `${label}: ${geojson.features.length} features loaded.`);
      }
    } catch (err) {
      Utils.logStatus(key, "error", `${label} failed to load: ${err.message}`);
    }
    updateZoomHint();
  }

  function updateZoomHint() {
    const hintEl = document.getElementById("zoom-hint");
    const zoom = map.getZoom();
    const waiting = [];
    if (enabled.tract && zoom < BG_CONFIG.MIN_ZOOM.tract) waiting.push(`tracts (zoom ${BG_CONFIG.MIN_ZOOM.tract}+)`);
    if (enabled.blockGroup && zoom < BG_CONFIG.MIN_ZOOM.blockGroup) waiting.push(`block groups (zoom ${BG_CONFIG.MIN_ZOOM.blockGroup}+)`);

    if (waiting.length) {
      hintEl.className = "hint warn";
      hintEl.textContent = `Current zoom is ${zoom}. Zoom in to load ${waiting.join(" and ")}.`;
    } else {
      hintEl.className = "hint";
      hintEl.textContent = `Zoom ${zoom}. Tract and block group layers load for the visible area only.`;
    }
  }

  let noiseLayer = null;

  async function onToggleNoise(checked) {
    enabled.noise = checked;
    if (!checked) {
      if (noiseLayer) {
        map.removeLayer(noiseLayer);
        noiseLayer = null;
      }
      renderOverlayLegend("noise");
      renderSelection();
      return;
    }
    Utils.logStatus("noise", "info", "Loading aviation noise...");
    try {
      const layer = await addNoiseLayer();
      if (!enabled.noise) return; // toggled off while the service was checked
      noiseLayer = layer.addTo(map);
      renderOverlayLegend("noise");
      if (selectedProps && selectedLayer) lookupNoise(geoidOf(selectedProps), selectedLayer);
    } catch (err) {
      Utils.logStatus("noise", "error", `Aviation noise failed to load: ${err.message}`);
      document.getElementById("toggle-noise").checked = false;
      enabled.noise = false;
    }
  }

  async function onToggleWind(checked) {
    enabled.wind = checked;
    if (!checked) {
      if (windOverlay) {
        map.removeLayer(windOverlay);
        windOverlay = null;
      }
      renderOverlayLegend("wind");
      renderSelection();
      return;
    }
    await loadWindData();
    if (!enabled.wind) return; // toggled off while the file was loading
    if (windGrid && !windOverlay) {
      windOverlay = buildWindOverlay().addTo(map);
      windOverlay.bringToBack();
    }
    renderOverlayLegend("wind");
    renderSelection(); // the open card gains its wind rows
  }

  function onToggle(key, checked) {
    if (key === "wind") return onToggleWind(checked);
    if (key === "noise") return onToggleNoise(checked);
    enabled[key] = checked;
    if (!checked) {
      if (layers[key]) {
        map.removeLayer(layers[key]);
        delete layers[key];
        delete loadedBBox[key];
      }
      if (key === "blockGroup") {
        if (cardPopup && cardPopup.isOpen()) map.closePopup(cardPopup);
        selectedLayer = null;
        selectedProps = null;
        selectedGeoid = null;
        document.getElementById("detail-panel").innerHTML =
          '<p class="hint">Turn on <strong>Block Group Borders</strong>, zoom in, and click a block group.</p>';
      }
      if (BG_CONFIG.OVERLAYS[key] || key === "schools") {
        renderOverlayLegend(key);
        if (key === "pollution") renderSelection();
      }
      updateZoomHint();
      return;
    }
    if (key === "blockGroup") loadCensusData();
    if (BG_CONFIG.OVERLAYS[key] || key === "schools" || key === "noise") renderOverlayLegend(key);
    refreshLayer(key, { force: true });
  }

  // One legend box per overlay, shown only while that overlay is on.
  function renderOverlayLegend(key) {
    const box = document.getElementById(`${key}-legend`);
    if (!box) return;
    if (!enabled[key]) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }
    let rows;
    if (key === "fire") {
      rows = Object.entries(BG_CONFIG.FIRE_CLASS_COLORS).map(
        ([name, color]) =>
          `<div class="legend-row"><span class="swatch" style="background:${color}"></span>${name.replace(
            /^./,
            (c) => c.toUpperCase()
          )}</div>`
      );
      rows.push('<div class="legend-note">Blank ground is outside any mapped zone, which is not the same as "no hazard".</div>');
    } else if (key === "pollution") {
      rows = BG_CONFIG.POLLUTION_BUCKETS.map(
        (b) => `<div class="legend-row"><span class="swatch" style="background:${b.color}"></span>${b.label}</div>`
      );
    } else if (key === "flood") {
      rows = BG_CONFIG.FLOOD_CLASSES.map(
        (c) => `<div class="legend-row"><span class="swatch" style="background:${c.color}"></span>${c.label}</div>`
      );
      rows.push('<div class="legend-note">A/AE/V/VE is the 1% annual chance floodplain - the zone where a federally-backed mortgage requires flood insurance.</div>');
    } else if (key === "seismic") {
      rows = Object.entries(BG_CONFIG.SEISMIC_COLORS).map(
        ([name, color]) =>
          `<div class="legend-row"><span class="swatch" style="background:${color}"></span>${name.replace(
            /^./,
            (c) => c.toUpperCase()
          )} zone</div>`
      );
      rows.push('<div class="legend-note">CGS zones where a site investigation is required before building - not a prediction that ground will fail.</div>');
    } else if (key === "noise") {
      rows = BG_CONFIG.NOISE.BANDS.map(
        (b) => `<div class="legend-row"><span class="swatch" style="background:${b.color}"></span>${b.label}</div>`
      );
      rows.push('<div class="legend-note">24-hour average (LAeq), not DNL: no night-time penalty, so it understates an airport that flies at night.</div>');
    } else if (key === "schools" || key === "schoolZones") {
      rows = Object.entries(BG_CONFIG.SCHOOL_LEVEL_COLORS)
        .filter(([name]) => name !== "other")
        .map(
          ([name, color]) =>
            `<div class="legend-row"><span class="swatch" style="background:${color}"></span>${name.replace(
              /^./,
              (c) => c.toUpperCase()
            )}</div>`
        );
      if (key === "schoolZones") {
        rows.push('<div class="legend-note">LAUSD only. Other districts publish their own boundaries; none is shown rather than a guess.</div>');
      }
    } else {
      rows = BG_CONFIG.WIND_BUCKETS.map(
        (b) => `<div class="legend-row"><span class="swatch" style="background:${b.color}"></span>${b.label}</div>`
      );
    }
    box.classList.remove("hidden");
    box.innerHTML = rows.join("");
  }

  // --- Address search -----------------------------------------------------
  // Typing queries the Census geocoder (free, no key), which returns up to
  // several candidate matches - those become the suggestion list. Picking one
  // drops a pin, then asks TIGERweb which block group polygon contains that
  // point. That spatial lookup is authoritative and works even if the block
  // group isn't currently loaded on screen.
  let searchTimer = null;
  let searchMarker = null;
  let suggestions = [];

  // Suggestions come from Nominatim, NOT the Census geocoder. The Census
  // geocoder is an address *matcher*: it wants a complete, well-formed
  // address and returns nothing for a partial one, so using it for
  // as-you-type suggestions produces an empty list until the address is
  // fully typed - which looks exactly like broken autocomplete.
  // Nominatim does partial/fuzzy matching, needs no key, and returns
  // coordinates directly.
  async function suggestAddresses(text) {
    const params = new URLSearchParams({
      q: text,
      format: "jsonv2",
      addressdetails: "1",
      limit: "6",
      countrycodes: "us",
      // Bias toward LA County without hard-excluding anything outside it.
      viewbox: `${BG_CONFIG.LA_COUNTY_BBOX.xmin},${BG_CONFIG.LA_COUNTY_BBOX.ymax},${BG_CONFIG.LA_COUNTY_BBOX.xmax},${BG_CONFIG.LA_COUNTY_BBOX.ymin}`,
    });
    const results = await Utils.fetchJSON(`${BG_CONFIG.NOMINATIM_URL}?${params}`, { timeoutMs: 15000 });
    return (Array.isArray(results) ? results : []).map((r) => ({
      matchedAddress: r.display_name,
      coordinates: { x: Number(r.lon), y: Number(r.lat) },
    }));
  }

  // Fallback for when Nominatim is unreachable (rate limited, blocked by an
  // extension). Needs a complete address, but better than nothing.
  async function geocodeExact(text) {
    const params = new URLSearchParams({
      address: text,
      benchmark: BG_CONFIG.GEOCODER_BENCHMARK,
      format: "json",
    });
    const data = await Utils.fetchJSON(`${BG_CONFIG.GEOCODER_URL}?${params}`, { timeoutMs: 15000 });
    return (data && data.result && data.result.addressMatches) || [];
  }

  async function geocode(text) {
    try {
      const hits = await suggestAddresses(text);
      if (hits.length) return hits;
    } catch (err) {
      Utils.logStatus("search", "warn", `Address suggestions unavailable (${err.message}); trying the Census geocoder.`);
    }
    return geocodeExact(text);
  }

  async function blockGroupAt(lat, lon) {
    const layerId = await resolveLayerId("blockGroup");
    const url = Utils.arcgisQueryUrl(BG_CONFIG.TIGERWEB, layerId, {
      bbox: { xmin: lon, ymin: lat, xmax: lon, ymax: lat },
      outFields: "*",
    });
    const gj = await Utils.fetchEsriAsGeoJSON(url, { timeoutMs: 20000 });
    return gj.features[0] || null;
  }

  function renderSuggestions() {
    const ul = document.getElementById("address-suggestions");
    if (!suggestions.length) {
      ul.classList.add("hidden");
      ul.innerHTML = "";
      return;
    }
    ul.innerHTML = suggestions.map((m, i) => `<li data-i="${i}">${m.matchedAddress}</li>`).join("");
    ul.classList.remove("hidden");
    ul.querySelectorAll("li").forEach((li) => {
      li.addEventListener("click", () => chooseAddress(suggestions[Number(li.dataset.i)]));
    });
  }

  async function chooseAddress(match) {
    const status = document.getElementById("search-status");
    document.getElementById("address-suggestions").classList.add("hidden");
    document.getElementById("address-input").value = match.matchedAddress;

    const lat = match.coordinates.y;
    const lon = match.coordinates.x;

    if (searchMarker) map.removeLayer(searchMarker);
    searchMarker = L.marker([lat, lon]).addTo(map).bindPopup(match.matchedAddress);
    document.getElementById("clear-pin").classList.remove("hidden");
    map.setView([lat, lon], Math.max(map.getZoom(), BG_CONFIG.MIN_ZOOM.blockGroup + 2));

    status.className = "hint";
    status.textContent = "Finding the block group for this address...";

    try {
      const feature = await blockGroupAt(lat, lon);
      if (!feature) {
        status.className = "hint warn";
        status.textContent = "Found the address, but no block group covers that point.";
        return;
      }

      // Make sure the block group layer is on and loaded around the address,
      // then select the matching polygon.
      if (!enabled.blockGroup) {
        document.getElementById("toggle-bg").checked = true;
        onToggle("blockGroup", true);
      }
      await refreshLayer("blockGroup", { force: true });

      const wanted = geoidOf(feature.properties);
      let target = null;
      if (layers.blockGroup) {
        layers.blockGroup.eachLayer((l) => {
          if (!target && geoidOf(l.feature.properties) === wanted) target = l;
        });
      }

      if (target) {
        selectBlockGroup(target, target.feature.properties);
      } else {
        // Not in the loaded viewport (rare) - still show the card.
        selectedProps = feature.properties;
        selectedLayer = null;
        renderSelection();
        lookupZip(wanted, L.geoJSON(feature));
      }

      const { tractLabel, bgLabel } = tractAndBlockGroup(feature.properties);
      status.className = "hint ok";
      status.textContent = `Tract ${tractLabel}, Block Group ${bgLabel}`;
    } catch (err) {
      status.className = "hint error";
      status.textContent = `Could not resolve the block group: ${err.message}`;
    }
  }

  function clearPin() {
    setPinArmed(false);
    clearRoute();
    if (searchMarker) {
      map.removeLayer(searchMarker);
      searchMarker = null;
    }
    document.getElementById("clear-pin").classList.add("hidden");
    document.getElementById("address-input").value = "";
    document.getElementById("search-status").textContent = "";
    suggestions = [];
    renderSuggestions();
  }

  // --- Drop a pin ---------------------------------------------------------
  // A plain map click already means "select this block group", so pin-drop is
  // an explicitly armed mode: press the button, the next click on the map
  // drops a pin and reverse-geocodes it, then the mode disarms itself. One
  // click never does both things, and the block group click handler stands
  // down while the mode is armed.
  let pinArmed = false;

  function setPinArmed(armed) {
    pinArmed = armed;
    const btn = document.getElementById("drop-pin");
    btn.classList.toggle("armed", armed);
    btn.textContent = armed ? "Click the map… (Esc to cancel)" : "Drop a pin";
    document.getElementById("map").classList.toggle("pin-armed", armed);
    if (armed) {
      const status = document.getElementById("search-status");
      status.className = "hint";
      status.textContent = "Click anywhere on the map to drop a pin there.";
    }
  }

  async function reverseGeocode(lat, lon) {
    const url =
      `${BG_CONFIG.NOMINATIM_REVERSE_URL}?` +
      new URLSearchParams({ lat: String(lat), lon: String(lon), format: "jsonv2", zoom: "18", addressdetails: "1" });
    const data = await Utils.fetchJSON(url, { timeoutMs: 15000 });
    if (!data || data.error) throw new Error((data && data.error) || "no address found");
    return data;
  }

  // Nominatim's display_name is the full "house, street, neighbourhood, city,
  // county, state, ZIP, country" chain. The first four parts are the street
  // address people recognise; the rest is noise in a popup this size.
  function shortAddress(place) {
    const a = place.address || {};
    const line1 = [a.house_number, a.road].filter(Boolean).join(" ");
    const city = a.city || a.town || a.village || a.suburb || a.neighbourhood || "";
    const parts = [line1 || a.name, city, a.state, a.postcode].filter(Boolean);
    return parts.length ? parts.join(", ") : place.display_name || "";
  }

  async function dropPinAt(latlng) {
    if (searchMarker) map.removeLayer(searchMarker);
    searchMarker = L.marker(latlng).addTo(map);
    document.getElementById("clear-pin").classList.remove("hidden");

    const coords = `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
    searchMarker.bindPopup(`<div class="pin-popup"><strong>Looking up address…</strong><br>${coords}</div>`).openPopup();

    const status = document.getElementById("search-status");
    try {
      const place = await reverseGeocode(latlng.lat, latlng.lng);
      const address = shortAddress(place);
      const wind = windAt(latlng.lat, latlng.lng);
      searchMarker.setPopupContent(
        `<div class="pin-popup"><strong>${address || "No address on record here"}</strong>` +
          `<br><span class="pin-coords">${coords}</span>` +
          (wind === null ? "" : `<br><span class="pin-coords">Mean wind ${wind.toFixed(1)} m/s</span>`) +
          `</div>`
      );
      document.getElementById("address-input").value = address;
      if (destination) routeFromPin();
      status.className = "hint ok";
      status.textContent = address || "Pin dropped - no street address at this point.";
    } catch (err) {
      searchMarker.setPopupContent(`<div class="pin-popup"><strong>${coords}</strong><br>Address lookup failed.</div>`);
      status.className = "hint error";
      status.textContent = `Pin dropped, but the address lookup failed: ${err.message}`;
    }
  }

  function initPinDrop() {
    document.getElementById("drop-pin").addEventListener("click", () => setPinArmed(!pinArmed));

    map.on("click", (e) => {
      if (!pinArmed) return;
      setPinArmed(false);
      dropPinAt(e.latlng);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && pinArmed) setPinArmed(false);
    });
  }

  function initAddressSearch() {
    const input = document.getElementById("address-input");
    const status = document.getElementById("search-status");
    document.getElementById("clear-pin").addEventListener("click", clearPin);

    input.addEventListener("input", () => {
      clearTimeout(searchTimer);
      const text = input.value.trim();
      if (text.length < 5) {
        suggestions = [];
        renderSuggestions();
        status.textContent = "";
        return;
      }
      // Debounced: one request per pause in typing, not per keystroke.
      searchTimer = setTimeout(async () => {
        status.className = "hint";
        status.textContent = "Searching...";
        try {
          suggestions = await geocode(text);
          renderSuggestions();
          status.textContent = suggestions.length
            ? `${suggestions.length} match${suggestions.length > 1 ? "es" : ""} - pick one`
            : "No matches. Try including city and state.";
        } catch (err) {
          status.className = "hint error";
          status.textContent = `Address lookup failed: ${err.message}`;
        }
      }, BG_CONFIG.SEARCH_DEBOUNCE_MS);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (suggestions.length) chooseAddress(suggestions[0]);
      } else if (e.key === "Escape") {
        document.getElementById("address-suggestions").classList.add("hidden");
      }
    });

    document.addEventListener("click", (e) => {
      if (!document.getElementById("search-wrap").contains(e.target)) {
        document.getElementById("address-suggestions").classList.add("hidden");
      }
    });
  }

  // --- Basemap ------------------------------------------------------------
  let basemapKind = null; // "vector" | "raster", exposed for tests

  function webglAvailable() {
    try {
      const canvas = document.createElement("canvas");
      return !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
    } catch (err) {
      return false;
    }
  }

  function addRasterBasemap(reason) {
    L.tileLayer(BG_CONFIG.FALLBACK_BASEMAP_URL, {
      maxZoom: BG_CONFIG.MAX_ZOOM,
      maxNativeZoom: BG_CONFIG.FALLBACK_MAX_NATIVE_ZOOM,
      attribution: BG_CONFIG.FALLBACK_BASEMAP_ATTRIBUTION,
    }).addTo(map);
    // Labels ride in a pane above the polygon fills so street names stay
    // readable instead of being buried by them.
    L.tileLayer(BG_CONFIG.FALLBACK_BASEMAP_LABELS_URL, {
      maxZoom: BG_CONFIG.MAX_ZOOM,
      maxNativeZoom: BG_CONFIG.FALLBACK_MAX_NATIVE_ZOOM,
      pane: "shadowPane",
    }).addTo(map);
    basemapKind = "raster";
    Utils.logStatus("basemap", "warn", `Using the Esri raster basemap: ${reason}. It is only published to zoom ${BG_CONFIG.FALLBACK_MAX_NATIVE_ZOOM}, so it softens past that.`);
  }

  function addBasemap() {
    if (typeof L.maplibreGL !== "function") {
      addRasterBasemap("MapLibre did not load");
      return;
    }
    if (!webglAvailable()) {
      addRasterBasemap("this browser has no WebGL");
      return;
    }
    try {
      const gl = L.maplibreGL({
        style: BG_CONFIG.BASEMAP_STYLE,
        attribution: BG_CONFIG.BASEMAP_ATTRIBUTION,
      }).addTo(map);
      // The GL layer does not feed Leaflet's attribution control the way a
      // tile layer does, and OpenFreeMap's terms ask for the OpenMapTiles and
      // OpenStreetMap credit, so add it explicitly.
      if (map.attributionControl) map.attributionControl.addAttribution(BG_CONFIG.BASEMAP_ATTRIBUTION);
      basemapKind = "vector";
      Utils.logStatus("basemap", "ok", "Vector basemap (OpenFreeMap Positron) - sharp to zoom 20.");

      // A style that 404s or a host that is down fails asynchronously, well
      // after addTo() returned, so the swap to raster has to happen here.
      const glMap = gl.getMaplibreMap && gl.getMaplibreMap();
      if (glMap && glMap.on) {
        glMap.on("error", (e) => {
          if (basemapKind !== "vector") return; // already fell back
          map.removeLayer(gl);
          if (map.attributionControl) map.attributionControl.removeAttribution(BG_CONFIG.BASEMAP_ATTRIBUTION);
          addRasterBasemap(`OpenFreeMap failed (${(e && e.error && e.error.message) || "tile or style error"})`);
        });
      }
    } catch (err) {
      addRasterBasemap(`MapLibre failed to start (${err.message})`);
    }
  }

  function initStatusPanel() {
    const toggle = document.getElementById("status-toggle");
    const list = document.getElementById("status-log");
    toggle.addEventListener("click", () => list.classList.toggle("hidden"));
    Utils.onStatusChange((entry) => {
      const li = document.createElement("li");
      li.className = entry.level === "info" ? "" : entry.level;
      li.textContent = `${entry.ts.toLocaleTimeString()} - ${entry.message}`;
      list.appendChild(li);
      list.scrollTop = list.scrollHeight;
    });
  }

  function init() {
    // preferCanvas: with a few thousand block group polygons, Leaflet's
    // default SVG renderer creates a DOM node each and panning crawls.
    map = L.map("map", { preferCanvas: true, maxZoom: BG_CONFIG.MAX_ZOOM }).setView(
      BG_CONFIG.MAP_CENTER,
      BG_CONFIG.MAP_ZOOM
    );
    addBasemap();

    initStatusPanel();
    initAddressSearch();
    initPinDrop();
    initInfoTips();
    initCommute();
    loadParcelData();
    loadOrsKey();
    renderFilterRows();
    document.getElementById("toggle-density").addEventListener("change", (e) => {
      densityShading = e.target.checked;
      renderDensityLegend();
      applyFilters();      // repaints polygons under the new scheme
      renderSelection();   // card gains/keeps its density rows
      if (densityShading) logDensityDistribution();
    });

    document.getElementById("filter-clear").addEventListener("click", () => {
      filters.forEach((f) => (f.enabled = false));
      renderFilterRows();
      applyFilters();
    });

    // Warn immediately rather than waiting for a click to fail.
    if (window.location.protocol === "file:") {
      const banner = document.createElement("div");
      banner.id = "file-protocol-warning";
      banner.innerHTML =
        `<strong>Opened as a file, not a web page.</strong> Boundaries will work, but block group ` +
        `demographics cannot load — browsers block local file reads over <code>file://</code>. ` +
        `Run <code>${serverCommand()}</code> in this folder and open ` +
        `<code>http://localhost:8000/blockgroups.html</code> instead.`;
      document.getElementById("sidebar").prepend(banner);
      Utils.logStatus("setup", "warn", "Page opened over file:// - local data cannot load. Serve over HTTP instead.");
    }

    document.getElementById("toggle-zip").addEventListener("change", (e) => onToggle("zip", e.target.checked));
    document.getElementById("toggle-tract").addEventListener("change", (e) => onToggle("tract", e.target.checked));
    document.getElementById("toggle-bg").addEventListener("change", (e) => onToggle("blockGroup", e.target.checked));
    document.getElementById("toggle-fire").addEventListener("change", (e) => onToggle("fire", e.target.checked));
    document.getElementById("toggle-pollution").addEventListener("change", (e) => onToggle("pollution", e.target.checked));
    document.getElementById("toggle-wind").addEventListener("change", (e) => onToggle("wind", e.target.checked));
    document
      .getElementById("toggle-school-districts")
      .addEventListener("change", (e) => onToggle("schoolDistricts", e.target.checked));
    document
      .getElementById("toggle-school-zones")
      .addEventListener("change", (e) => onToggle("schoolZones", e.target.checked));
    document.getElementById("toggle-schools").addEventListener("change", (e) => onToggle("schools", e.target.checked));
    document.getElementById("toggle-flood").addEventListener("change", (e) => onToggle("flood", e.target.checked));
    document.getElementById("toggle-seismic").addEventListener("change", (e) => onToggle("seismic", e.target.checked));
    document.getElementById("toggle-noise").addEventListener("change", (e) => onToggle("noise", e.target.checked));

    // Switching ethnicity source re-renders whatever block group is open.
    document.querySelectorAll('input[name="eth-source"]').forEach((radio) => {
      radio.addEventListener("change", (e) => {
        if (!e.target.checked) return;
        ethSource = e.target.value;
        renderSelection();
        applyFilters(); // ethnicity filters follow the selected source
      });
    });

    // Debounced: panning fires moveend constantly, and each reload is a
    // network round trip.
    map.on("moveend zoomend", () => {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(() => {
        refreshLayer("tract");
        refreshLayer("blockGroup");
        refreshLayer("fire");
        refreshLayer("pollution");
        refreshLayer("flood");
        refreshLayer("seismic");
        refreshLayer("schoolDistricts");
        refreshLayer("schoolZones");
        refreshLayer("schools");
      }, 400);
      updateZoomHint();
    });

    updateZoomHint();
  }

  return {
    init,
    // Forces a layer reload, so a test can prove the card survives one.
    refreshForTest: (key) => refreshLayer(key, { force: true }),
    // Lets a test drive the filter state directly rather than through five
    // form controls.
    refreshFiltersForTest: () => {
      renderFilterRows();
      applyFilters();
    },
    // exposed for tests
    get state() {
      return {
        map, enabled, layers, censusData, selectedProps, windGrid, windOverlay,
        pinArmed, cesByTract, basemapKind, filters, parcelData,
      };
    },
  };
})();

document.addEventListener("DOMContentLoaded", () => BlockGroupApp.init());
