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

  // OpenStreetMap standard tiles: genuinely free, no API key. (CARTO's
  // basemap tier now asks for an API key, so it's no longer a no-signup
  // default.)
  BASEMAP_URL: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  BASEMAP_ATTRIBUTION:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',

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
  },
};

const BlockGroupApp = (() => {
  let map;
  const layers = {};        // key -> L.geoJSON currently on the map
  const layerIds = {};      // key -> resolved TIGERweb layer id
  const enabled = { zip: false, tract: false, blockGroup: false };
  const lastBBoxKey = {};   // key -> bbox string of the last successful load
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
          `HTTP instead: run <code>python -m http.server 8000</code> in the project folder, then open ` +
          `<code>http://localhost:8000/blockgroups.html</code>.`,
      };
    }

    if (/HTTP 40[34]/.test(err.message)) {
      return {
        short: "not found",
        detail: `No file at ${url} (server said ${err.message}). Run <code>python3 scripts/fetch-blockgroup-data.py</code> from the project folder, then reload.`,
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

  function bboxOfView() {
    const b = map.getBounds();
    return { xmin: b.getWest(), ymin: b.getSouth(), xmax: b.getEast(), ymax: b.getNorth() };
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

    return `<div class="detail-card">
      <h3>${heading}</h3>
      <p class="geoid">GEOID ${geoid}</p>

      <table>
        <tr><td class="k">Total population</td><td class="v">${Utils.fmtNumber(pop)}</td></tr>
      </table>

      <div class="section-label">Age</div>
      ${barRow("0 to 24", record.under25, pop)}
      ${barRow("25 to 54", record.age25to54, pop)}
      ${barRow("55 and over", record.age55plus, pop)}

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
        <tr><td class="k">Population 25+</td><td class="v">${Utils.fmtNumber(record.eduTotal25plus)}</td></tr>
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
          : `<p class="footnote">Age and sex from ACS B01001${geoNote("age")}. Age bands follow the table's own
             brackets, which break at 25 and 55 - so they are 0-24, 25-54 and 55+, with no overlap.</p>`
      }
    </div>`;
  }

  function selectBlockGroup(layer, props) {
    const record = censusData && censusData.blockGroups ? censusData.blockGroups[geoidOf(props)] : null;

    if (selectedLayer && selectedLayer !== layer) {
      selectedLayer.setStyle(BG_CONFIG.STYLES.blockGroup);
    }
    selectedLayer = layer;
    selectedProps = props;
    layer.setStyle(BG_CONFIG.STYLES.blockGroupSelected);

    layer
      .bindPopup(`<div class="bg-popup">${detailHTML(props, record, { compact: true })}</div>`, {
        maxWidth: 300,
        minWidth: 250,
        maxHeight: 480,
        autoPanPadding: [20, 20],
      })
      .openPopup();
    document.getElementById("detail-panel").innerHTML = detailHTML(props, record);
  }

  function buildLayer(key, geojson) {
    if (key === "blockGroup") {
      return L.geoJSON(geojson, {
        style: () => BG_CONFIG.STYLES.blockGroup,
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
        delete lastBBoxKey[key];
      }
      updateZoomHint();
      return;
    }

    const bbox = key === "zip" ? BG_CONFIG.LA_COUNTY_BBOX : bboxOfView();
    const bboxKey = `${bbox.xmin.toFixed(4)},${bbox.ymin.toFixed(4)},${bbox.xmax.toFixed(4)},${bbox.ymax.toFixed(4)}`;
    if (!force && lastBBoxKey[key] === bboxKey) return;

    const label = { zip: "Zip code borders", tract: "Census tract borders", blockGroup: "Block group borders" }[key];
    Utils.logStatus(key, "info", `Loading ${label}...`);
    try {
      const geojson = await fetchBoundaries(key, bbox);
      if (!enabled[key]) return; // toggled off while the request was in flight

      if (layers[key]) map.removeLayer(layers[key]);
      layers[key] = buildLayer(key, geojson).addTo(map);
      lastBBoxKey[key] = bboxKey;
      selectedLayer = null;
      selectedProps = null;

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
        delete lastBBoxKey[key];
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

    initStatusPanel();

    // Warn immediately rather than waiting for a click to fail.
    if (window.location.protocol === "file:") {
      const banner = document.createElement("div");
      banner.id = "file-protocol-warning";
      banner.innerHTML =
        `<strong>Opened as a file, not a web page.</strong> Boundaries will work, but block group ` +
        `demographics cannot load — browsers block local file reads over <code>file://</code>. ` +
        `Run <code>python -m http.server 8000</code> in this folder and open ` +
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
        if (selectedLayer && selectedProps) selectBlockGroup(selectedLayer, selectedProps);
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
