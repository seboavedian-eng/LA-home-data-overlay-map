// ---------------------------------------------------------------------------
// LA County Block Group Explorer.
//
// Three independent boundary toggles (zip / tract / block group) plus, for
// block groups only, a click popup showing the top 5 ancestries (ACS B04006)
// and income for that block group.
//
// Tract and block group polygons are loaded for the *visible map area* only,
// above a minimum zoom - LA County has ~2,500 tracts and ~6,500 block groups,
// and pulling all of them at once would be a many-megabyte download and a
// sluggish map.
// ---------------------------------------------------------------------------

const BG_CONFIG = {
  MAP_CENTER: [34.05, -118.25],
  MAP_ZOOM: 12,

  BASEMAP_URL: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
  BASEMAP_ATTRIBUTION:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',

  // All three boundary types come from the same Census TIGERweb service.
  TIGERWEB: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer",
  LAYERS: {
    zip: { nameHint: "Zip Code Tabulation Area", fallbackId: 2 },
    tract: { nameHint: "Census Tract", fallbackId: 8 },
    blockGroup: { nameHint: "Block Group", fallbackId: 10 },
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
  let moveTimer = null;

  // --- data ---------------------------------------------------------------

  async function loadCensusData() {
    if (censusData || censusDataError) return censusData;
    try {
      censusData = await Utils.fetchJSON(BG_CONFIG.BLOCK_GROUP_DATA, { timeoutMs: 60000 });
      const count = Object.keys(censusData.blockGroups || {}).length;
      Utils.logStatus("census", "ok", `Loaded block group data for ${count.toLocaleString()} block groups (ACS ${censusData.meta.year}).`);
    } catch (err) {
      censusDataError = err;
      Utils.logStatus(
        "census",
        "warn",
        `No block group data file at ${BG_CONFIG.BLOCK_GROUP_DATA} - run "python3 scripts/fetch-blockgroup-data.py" once to create it. Boundaries still work; popups will have no numbers.`
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
      layerIds[key] = await Utils.discoverLayerId(BG_CONFIG.TIGERWEB, spec.nameHint, spec.fallbackId);
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

  function topAncestries(record, n = 5) {
    const entries = Object.entries(record.ancestries || {});
    entries.sort((a, b) => b[1] - a[1]);
    return entries.slice(0, n).map(([code, count]) => ({
      code,
      count,
      label: (censusData.meta.ancestryLabels || {})[code] || code,
    }));
  }

  // compact=true trims the long methodology footnote for the map popup,
  // which has to fit on screen; the sidebar carries the full version.
  function detailHTML(props, record, { compact = false } = {}) {
    const geoid = geoidOf(props) || "unknown";
    const name = Utils.pickField(props, ["NAME", "BASENAME"]) || `Block Group ${geoid}`;

    if (!record) {
      const reason = censusData
        ? "This block group isn't in the local data file (it may fall outside LA County)."
        : `No local data file yet - run <code>python3 scripts/fetch-blockgroup-data.py</code> once, then reload.`;
      return `<div class="detail-card">
        <h3>${name}</h3>
        <p class="geoid">GEOID ${geoid}</p>
        <p class="footnote">${reason}</p>
      </div>`;
    }

    const ancestryTotal = record.ancestryTotal;
    const top = topAncestries(record, 5);
    const bars = top.length
      ? top
          .map((a) => {
            const pct = ancestryTotal ? (a.count / ancestryTotal) * 100 : null;
            const pctText = pct === null ? "n/a" : `${pct.toFixed(1)}%`;
            const width = pct === null ? 0 : Math.min(100, pct);
            return `<div class="bar-row">
              <div class="bar-label"><span>${a.label}</span><span class="pct">${pctText}</span></div>
              <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
              <div class="bar-label"><span class="layer-desc">${Utils.fmtNumber(a.count)} people</span></div>
            </div>`;
          })
          .join("")
      : "<p class='footnote'>No ancestry responses reported for this block group.</p>";

    return `<div class="detail-card">
      <h3>${name}</h3>
      <p class="geoid">GEOID ${geoid}</p>

      <div class="section-label">Top 5 ancestries</div>
      ${bars}

      <div class="section-label">Income</div>
      <table>
        <tr><td class="k">Median household income</td><td class="v">${Utils.fmtCurrency(record.medianHouseholdIncome)}</td></tr>
        <tr><td class="k">Per-capita income</td><td class="v">${Utils.fmtCurrency(record.perCapitaIncome)}</td></tr>
      </table>

      <div class="section-label">Population</div>
      <table>
        <tr><td class="k">Total population</td><td class="v">${Utils.fmtNumber(record.totalPopulation)}</td></tr>
        <tr><td class="k">Reporting an ancestry</td><td class="v">${Utils.fmtNumber(ancestryTotal)}</td></tr>
      </table>

      <p class="footnote">${
        compact
          ? `% of the ${Utils.fmtNumber(ancestryTotal)} people reporting an ancestry (not total population); dual-ancestry responses count twice.`
          : `Percentages are of the <strong>${Utils.fmtNumber(ancestryTotal)}</strong> people reporting an ancestry, not of
             total population. People reporting two ancestries are counted in both, so these can sum to more than 100%.
             Source: US Census ACS ${censusData.meta.year} 5-year estimates, table B04006 (ancestry) and B19013/B19301 (income).`
      }</p>
    </div>`;
  }

  function selectBlockGroup(layer, props) {
    const record = censusData && censusData.blockGroups ? censusData.blockGroups[geoidOf(props)] : null;

    if (selectedLayer && selectedLayer !== layer) {
      selectedLayer.setStyle(BG_CONFIG.STYLES.blockGroup);
    }
    selectedLayer = layer;
    layer.setStyle(BG_CONFIG.STYLES.blockGroupSelected);

    layer
      .bindPopup(`<div class="bg-popup">${detailHTML(props, record, { compact: true })}</div>`, {
        maxWidth: 300,
        minWidth: 250,
        maxHeight: 420,
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
      Utils.logStatus(key, "ok", `${label}: ${geojson.features.length} features loaded.`);
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
      subdomains: "abcd",
    }).addTo(map);

    initStatusPanel();

    document.getElementById("toggle-zip").addEventListener("change", (e) => onToggle("zip", e.target.checked));
    document.getElementById("toggle-tract").addEventListener("change", (e) => onToggle("tract", e.target.checked));
    document.getElementById("toggle-bg").addEventListener("change", (e) => onToggle("blockGroup", e.target.checked));

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
