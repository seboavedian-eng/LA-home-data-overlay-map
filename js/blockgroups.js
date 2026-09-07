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

const BG_CONFIG = {
  MAP_CENTER: [34.05, -118.25],
  MAP_ZOOM: 12,

  // Esri World Light Gray Canvas: a muted basemap built for data overlays -
  // minimal labels, no POI clutter, so the polygons carry the visual weight.
  // Standard OSM tiles are a general-purpose map and fight the data for
  // attention.
  BASEMAP_URL:
    "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  BASEMAP_ATTRIBUTION: "Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ",
  // Place names/roads ride on top of the polygons so they stay readable.
  BASEMAP_LABELS_URL:
    "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",

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

  // Census geocoder - free, no key, US addresses.
  GEOCODER_URL: "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress",
  GEOCODER_BENCHMARK: "Public_AR_Current",

  // Padding (in degrees) added around the viewport when loading polygons, so
  // small pans don't trigger a refetch - which used to destroy the open popup.
  BBOX_PADDING: 0.02,

  // Whole-county bbox, used for the zip layer (only ~300 ZCTAs, so it's
  // cheap to load once rather than per-viewport).
  LA_COUNTY_BBOX: { xmin: -118.95, ymin: 32.70, xmax: -117.60, ymax: 34.85 },

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
  const enabled = { zip: false, tract: false, blockGroup: false };
  const loadedBBox = {};    // key -> padded bbox covered by the current layer
  let censusData = null;    // { meta, blockGroups } from the local snapshot
  let censusDataError = null;
  let selectedLayer = null;
  let selectedProps = null;   // so the open detail can re-render on source switch
  let moveTimer = null;
  let ethSource = "acs";      // "acs" = B03002 (default), "dec" = 2020 Census P2

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
    const url = Utils.arcgisQueryUrl(BG_CONFIG.TIGERWEB, layerId, { bbox, outFields: "*" });
    return Utils.fetchEsriAsGeoJSON(url, { timeoutMs: 40000 });
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
      const layerId = await Utils.discoverLayerId(
        BG_CONFIG.TIGERWEB,
        BG_CONFIG.LAYERS.zip.nameHint,
        BG_CONFIG.LAYERS.zip.fallbackId,
        { exactNames: BG_CONFIG.LAYERS.zip.exactNames, exclude: BG_CONFIG.LAYERS.zip.exclude }
      );
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
    const rows = Object.entries(counts)
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => `<tr><td class="k">${label}</td><td class="v">${pctText(count, total)}</td>
        <td class="v count">${Utils.fmtNumber(count)}</td></tr>`)
      .join("");

    return `<table class="eth-table">${rows}</table>
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
  function detailHTML(props, record, { compact = false } = {}) {
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

    return `<div class="detail-card">
      <h3>${heading}</h3>
      <p class="geoid">GEOID ${geoid}${zip ? ` &middot; ZIP ${zip}` : ""}</p>

      <table>
        <tr><td class="k">Total population</td><td class="v">${Utils.fmtNumber(pop)}</td></tr>
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
        <tr><td class="k">Bachelor's degree or higher</td><td class="v">${bachelorsPct}</td></tr>
      </table>
      ${compact ? "" : `<p class="src-note">Source: ACS B15003, share of the 25-and-over population${geoNote("education")}</p>`}

      <div class="section-label">Income</div>
      <table>
        <tr><td class="k">Median household income</td><td class="v">${Utils.fmtCurrency(record.medianHouseholdIncome)}</td></tr>
        <tr><td class="k">Per-capita income</td><td class="v">${Utils.fmtCurrency(record.perCapitaIncome)}</td></tr>
      </table>
      ${compact ? "" : `<p class="src-note">Source: ACS B19013 / B19301${geoNote("income")}</p>`}

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
    medianIncome: {
      label: "Median household income ($)",
      unit: "$",
      value: (r) => (r.medianHouseholdIncome != null ? r.medianHouseholdIncome : null),
    },
    population: {
      label: "Total population",
      unit: "",
      value: (r) => (r.totalPopulation != null ? r.totalPopulation : null),
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
  ];

  function activeFilters() {
    return filters.filter((f) => f.enabled && f.value !== "" && !isNaN(Number(f.value)));
  }

  // A block group matches only if EVERY active filter passes. No data for a
  // given metric counts as not matching - better than silently treating a
  // gap as a zero.
  function matchesFilters(record) {
    if (!record) return false;
    return activeFilters().every((f) => {
      const metric = metricFor(f.metric);
      if (!metric) return true;
      const v = metric.value(record);
      if (v == null) return false;
      return f.op === "above" ? v > Number(f.value) : v < Number(f.value);
    });
  }

  function styleForBlockGroup(feature) {
    if (!activeFilters().length) return BG_CONFIG.STYLES.blockGroup;
    const record = recordFor(feature.properties);
    return matchesFilters(record) ? BG_CONFIG.STYLES.blockGroupMatch : BG_CONFIG.STYLES.blockGroupNoMatch;
  }

  function applyFilters() {
    let matched = 0;
    let total = 0;
    if (layers.blockGroup) {
      layers.blockGroup.eachLayer((l) => {
        total++;
        const style = styleForBlockGroup(l.feature);
        if (style === BG_CONFIG.STYLES.blockGroupMatch) matched++;
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
        <input type="number" id="filter-value-${i}" value="${f.value}" step="any" />
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
    document.getElementById("detail-panel").innerHTML = detailHTML(selectedProps, record);
    if (selectedLayer) {
      const html = `<div class="bg-popup">${detailHTML(selectedProps, record, { compact: true })}</div>`;
      if (selectedLayer.getPopup()) selectedLayer.setPopupContent(html);
    }
  }

  function selectBlockGroup(layer, props, { openPopup = true } = {}) {
    const record = recordFor(props);

    if (selectedLayer && selectedLayer !== layer) {
      selectedLayer.setStyle(styleForBlockGroup(selectedLayer.feature));
    }
    selectedLayer = layer;
    selectedProps = props;
    layer.setStyle(BG_CONFIG.STYLES.blockGroupSelected);

    layer.bindPopup(`<div class="bg-popup">${detailHTML(props, record, { compact: true })}</div>`, {
      maxWidth: 300,
      minWidth: 250,
      maxHeight: 480,
      autoPanPadding: [20, 20],
      autoClose: false,   // don't vanish when another popup opens
      closeOnClick: false, // ...or when the map is clicked
    });
    if (openPopup) layer.openPopup();
    document.getElementById("detail-panel").innerHTML = detailHTML(props, record);

    lookupZip(geoidOf(props), layer);
  }

  // Re-selects the previously selected block group after a layer reload, so
  // panning or zooming doesn't silently drop the open card.
  //
  // A reload genuinely can happen while a card is open: opening a popup makes
  // Leaflet auto-pan to fit it, and for a tall popup that pan can exceed the
  // loaded area. Restyling alone isn't enough - the popup belongs to the
  // discarded layer object, so it has to be re-bound and re-opened on the new
  // one, otherwise the card silently vanishes a moment after opening.
  function restoreSelection(popupWasOpen) {
    if (!selectedProps || !layers.blockGroup) return;
    const wantedGeoid = geoidOf(selectedProps);

    let found = null;
    layers.blockGroup.eachLayer((l) => {
      if (!found && geoidOf(l.feature.properties) === wantedGeoid) found = l;
    });

    if (found) {
      selectBlockGroup(found, found.feature.properties, { openPopup: popupWasOpen });
    } else {
      selectedLayer = null; // panned away from it; the sidebar card stays
    }
  }

  function buildLayer(key, geojson) {
    if (key === "blockGroup") {
      return L.geoJSON(geojson, {
        style: (feature) => styleForBlockGroup(feature),
        onEachFeature: (feature, layer) => {
          layer.on("click", () => selectBlockGroup(layer, feature.properties));
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

  async function refreshLayer(key, { force = false } = {}) {
    if (!enabled[key]) return;

    const minZoom = BG_CONFIG.MIN_ZOOM[key];
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

    const label = { zip: "Zip code borders", tract: "Census tract borders", blockGroup: "Block group borders" }[key];
    Utils.logStatus(key, "info", `Loading ${label}...`);
    try {
      const geojson = await fetchBoundaries(key, bbox);
      if (!enabled[key]) return; // toggled off while the request was in flight

      // Capture this BEFORE removing the layer: removing it closes the popup,
      // so asking afterwards always reports "closed" and the card would never
      // be restored.
      const popupWasOpen = !!(
        key === "blockGroup" &&
        selectedLayer &&
        selectedLayer.isPopupOpen &&
        selectedLayer.isPopupOpen()
      );

      if (layers[key]) map.removeLayer(layers[key]);
      layers[key] = buildLayer(key, geojson).addTo(map);
      loadedBBox[key] = bbox;

      // Re-attach the open selection to its polygon in the rebuilt layer
      // rather than dropping it - the card should survive a pan.
      if (key === "blockGroup") {
        restoreSelection(popupWasOpen);
        applyFilters();
      }

      if (geojson.features.length === 0) {
        // A successful query returning nothing usually means the wrong
        // TIGERweb layer id was selected (their tribal/label layers query
        // fine but are empty here), not that the area is genuinely empty.
        Utils.logStatus(
          key,
          "warn",
          `${label}: 0 features returned from layer id ${layerIds[key]}. If this area should have data, that layer id is probably wrong.`
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

  function onToggle(key, checked) {
    enabled[key] = checked;
    if (!checked) {
      if (layers[key]) {
        map.removeLayer(layers[key]);
        delete layers[key];
        delete loadedBBox[key];
      }
      if (key === "blockGroup") {
        selectedLayer = null;
        selectedProps = null;
        document.getElementById("detail-panel").innerHTML =
          '<p class="hint">Turn on <strong>Block Group Borders</strong>, zoom in, and click a block group.</p>';
      }
      updateZoomHint();
      return;
    }
    if (key === "blockGroup") loadCensusData();
    refreshLayer(key, { force: true });
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

  async function geocode(text) {
    const params = new URLSearchParams({
      address: text,
      benchmark: BG_CONFIG.GEOCODER_BENCHMARK,
      format: "json",
    });
    const data = await Utils.fetchJSON(`${BG_CONFIG.GEOCODER_URL}?${params}`, { timeoutMs: 15000 });
    return (data && data.result && data.result.addressMatches) || [];
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

  function initAddressSearch() {
    const input = document.getElementById("address-input");
    const status = document.getElementById("search-status");

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
      }, 450);
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
    map = L.map("map").setView(BG_CONFIG.MAP_CENTER, BG_CONFIG.MAP_ZOOM);
    L.tileLayer(BG_CONFIG.BASEMAP_URL, {
      maxZoom: 19,
      attribution: BG_CONFIG.BASEMAP_ATTRIBUTION,
    }).addTo(map);
    // Labels go in Leaflet's top pane so streets stay readable over the
    // polygon fills rather than being buried by them.
    L.tileLayer(BG_CONFIG.BASEMAP_LABELS_URL, { maxZoom: 19, pane: "shadowPane" }).addTo(map);

    initStatusPanel();
    initAddressSearch();
    renderFilterRows();
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
      }, 400);
      updateZoomHint();
    });

    updateZoomHint();
  }

  return {
    init,
    // exposed for tests
    get state() {
      return { enabled, layers, censusData };
    },
  };
})();

document.addEventListener("DOMContentLoaded", () => BlockGroupApp.init());
