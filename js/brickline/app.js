// ---------------------------------------------------------------------------
// Brickline pilot page (brickline.html).
//
// Two journeys on the explorer's own data and lookups:
//   1. "I have an address"  -> house card: the building, things to know,
//      room to build, zoning, rules; then the neighbourhood around it.
//   2. "Find my neighbourhood" -> eight questions over every LA County block
//      group, a shortlist, an area card, then a house inside it.
//
// Everything is read through BlockGroupApp.engine (js/blockgroups.js), so the
// service URLs, field fallbacks and domain decoding are the explorer's, not a
// second copy that drifts. This file only adds the questions, the cards and
// the map drawing. It degrades per source: one dead service blanks one row
// and says so in Data status, never the page.
// ---------------------------------------------------------------------------

const Brickline = (() => {
  const C = BG_CONFIG;
  const E = () => BlockGroupApp.engine;
  const esc = Utils.escapeHTML;
  const $ = (s) => document.querySelector(s);

  // --- Mode --------------------------------------------------------------
  // Your GreatSchools table and Redfin exports are licensed for personal use.
  // They show only on your own machine (localhost, or your Tailscale address),
  // never on a public host. ?mode=public / ?mode=personal override for testing.
  const forced = (location.search.match(/[?&]mode=(public|personal)/) || [])[1];
  const PERSONAL = forced ? forced === "personal" : /^(localhost|127\.|\[?::1\]?$|100\.)/.test(location.hostname);

  const BG_INDEX_KEY = "brickline.bgIndex.v1";
  const LOCAL_LEADS_KEY = "brickline.leads.v1";
  const SQM_PER_SQMI = 2589988.11;
  const RUSH_FACTOR = 1.7;          // free-flow minutes x this ~ rush hour (estimate, labelled)
  const FALLBACK_MPH = 30;          // straight-line speed when there is no routing key
  const SALES_COLUMNS = ["address", "recorded", "sqft", "land", "improvement", "exemption", "assessed", "yearBuilt", "beds", "baths"];

  // Street-busyness bands: the explorer's density buckets, friendlier words.
  const DENS_MAX = (C.DENSITY_BUCKETS || []).map((b) => b.max).sort((a, b) => a - b);
  const DENS_WORDS = [
    ["Wide open", "Big lots, very few people out walking"],
    ["Quiet streets", "Classic suburb, the odd dog walker"],
    ["Neighbourly", "People out walking most of the day"],
    ["Lively", "Busy sidewalks, lots of neighbours"],
    ["City buzz", "Always someone on the street"],
  ];
  const DENS = DENS_MAX.map((max, i) => {
    const lo = i ? DENS_MAX[i - 1] : 0;
    const num = max === Infinity ? `${lo.toLocaleString()}+ / sq mi` : `${lo ? lo.toLocaleString() : "under"}${lo ? "–" : " "}${max.toLocaleString()}${lo ? "" : " / sq mi"}`;
    const color = (C.DENSITY_BUCKETS.find((b) => b.max === max) || {}).color || "#74c69d";
    return { max, label: (DENS_WORDS[i] || DENS_WORDS[4])[0], sub: (DENS_WORDS[i] || DENS_WORDS[4])[1], num, color };
  });
  const densBand = (d) => (d == null ? -1 : DENS.findIndex((b) => d < b.max));
  const AGE_COL = ["#74c69d", "#2f5f9e", "#b26b00"];
  const AGE_L = ["Under 35", "35 to 64", "65 and over"];

  // --- State -------------------------------------------------------------
  const D = { census: null, index: new Map(), prices: null, sales: null, schools: [], listings: [], wind: null, county: null, orsKey: null, schoolGrid: null };
  const S = {
    commutes: [{ text: "", min: 35 }], rush: true, dens: new Set(), detMin: 0, edu: 0, inc: 0, hhMin: 1, hhMax: 6,
    useMix: false, mix: [40, 42, 18], sE: 0, sM: 0, sH: 0, email: null, gateSeen: false, searchLogged: false, showMatches: true,
  };
  const metricCache = new Map();
  const areaCache = new Map();
  let step = 0;
  const NQ = 8;
  let map, canvasRenderer, isoLayer, focusLayer, hazardLayer, pinLayer;
  let view = "home";
  let area = null;       // { geoid }
  let house = null;      // resolved house context
  let atab = 0, htab = 0;
  let houseCommute = null;
  let reserved = new Set();
  let shownLayers = new Set();

  // =======================================================================
  // Data
  // =======================================================================
  function log(key, level, msg) { Utils.logStatus(key, level, msg); }

  async function loadIndex() {
    try {
      const cached = JSON.parse(localStorage.getItem(BG_INDEX_KEY) || "null");
      if (cached && Array.isArray(cached.rows) && cached.rows.length > 1000) {
        cached.rows.forEach((r) => D.index.set(r[0], { lat: r[1], lon: r[2], aland: r[3] }));
        log("index", "ok", `Block group centres: ${cached.rows.length.toLocaleString()} from this browser's cache (${cached.at}).`);
        return;
      }
    } catch (err) { /* storage blocked: fetch instead */ }
    const layerId = await E().blockGroupLayerId();
    const rows = [];
    for (let page = 0, offset = 0; page < 12; page++) {
      const params = new URLSearchParams({
        where: "STATE='06' AND COUNTY='037'", outFields: "GEOID,AREALAND,INTPTLAT,INTPTLON",
        returnGeometry: "false", orderByFields: "GEOID", resultOffset: String(offset), resultRecordCount: "2000", f: "json",
      });
      const data = await Utils.fetchJSON(`${C.TIGERWEB}/${layerId}/query?${params}`, { timeoutMs: 60000 });
      const feats = data.features || [];
      feats.forEach((f) => {
        const a = f.attributes || {};
        const lat = parseFloat(a.INTPTLAT), lon = parseFloat(a.INTPTLON);
        if (a.GEOID && Number.isFinite(lat) && Number.isFinite(lon)) rows.push([String(a.GEOID), lat, lon, Number(a.AREALAND) || null]);
      });
      if (!data.exceededTransferLimit && feats.length < 2000) break;
      offset += feats.length;
      if (!feats.length) break;
    }
    rows.forEach((r) => D.index.set(r[0], { lat: r[1], lon: r[2], aland: r[3] }));
    log("index", rows.length ? "ok" : "warn", `Block group centres: ${rows.length.toLocaleString()} from Census TIGERweb (layer ${layerId}).`);
    try { localStorage.setItem(BG_INDEX_KEY, JSON.stringify({ at: new Date().toISOString().slice(0, 10), rows })); } catch (err) { /* fine */ }
  }

  // On the public server (server/brickline_server.py), /api/config says
  // which lookups it proxies; keys never reach the browser there. On your
  // own machine it 404s and the page reads the key file as before.
  async function loadConfig() {
    try {
      const res = await fetch("api/config", { cache: "no-store" });
      D.cfg = res.ok ? await res.json() : {};
    } catch (err) { D.cfg = {}; }
    if (!D.cfg || typeof D.cfg !== "object") D.cfg = {};
  }
  const routing = () => !!(D.orsKey || D.orsProxy);
  async function loadOrsKey() {
    if (D.cfg && D.cfg.ors) {
      D.orsProxy = true;
      log("commute", "ok", "Commute areas follow the road network (through the Brickline server).");
      return;
    }
    if (!PERSONAL) { log("commute", "info", "Commute areas are straight-line estimates on this site."); return; }
    try {
      const res = await fetch(C.ORS_KEY_FILE, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const key = (await res.text()).trim();
      if (!key) throw new Error("file is empty");
      D.orsKey = key;
      log("commute", "ok", "Routing key loaded - commute areas follow the road network.");
    } catch (err) {
      log("commute", "warn", `No routing key (${err.message}); commute areas are straight-line estimates. Put your OpenRouteService key in ${C.ORS_KEY_FILE}.`);
    }
  }

  async function loadWind() {
    try {
      D.wind = await Utils.fetchJSON(C.WIND_DATA, { timeoutMs: 20000 });
    } catch (err) {
      log("wind", "info", `Wind grid not loaded (${err.message}).`);
    }
  }

  async function loadAll() {
    const jobs = {
      census: E().census().then((d) => (D.census = d)),
      index: loadIndex(),
      prices: E().prices().then((d) => (D.prices = d || {})),
      sales: E().sales().then((d) => (D.sales = d || {}), (err) => log("prices", "info", `Sales table not loaded (${err.message}).`)),
      schools: E().schools().then((d) => {
        D.schools = Object.entries((d && d.schools) || {}).map(([cds, s]) => ({ cds, ...s })).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
        buildSchoolGrid();
      }),
      listings: PERSONAL ? E().listings().then((l) => (D.listings = l || [])) : Promise.resolve(),
      ors: loadOrsKey(),
      wind: loadWind(),
      rules: E().ready(),
    };
    const out = await Promise.allSettled(Object.values(jobs));
    Object.keys(jobs).forEach((k, i) => {
      if (out[i].status === "rejected") log(k, "warn", `${k} did not load: ${out[i].reason && out[i].reason.message}`);
    });
    if (!D.census) {
      const err = E().censusError();
      log("census", "error", `Block group data missing${err ? ` (${err.message || err})` : ""}. Run python scripts/fetch-blockgroup-data.py.`);
    }
    computeCounty();
  }

  // --- Per block group measures -----------------------------------------
  const share = (n, d) => (n != null && d ? (n / d) * 100 : null);
  function ageBand(rec, band) { return rec && rec.ageBrackets ? band.brackets.reduce((s, i) => s + (rec.ageBrackets[String(i)] || 0), 0) : null; }
  function agesOf(rec) {
    if (!rec || !rec.ageBrackets || !rec.totalPopulation) return null;
    const b = C.AGE_BANDS.map((band) => ageBand(rec, band) || 0);
    const tot = b.reduce((a, x) => a + x, 0) || rec.totalPopulation;
    const u35 = ((b[0] + b[1]) / tot) * 100, s65 = (b[5] / tot) * 100;
    const r = [Math.round(u35), 0, Math.round(s65)];
    r[1] = 100 - r[0] - r[2];
    return r;
  }
  function metrics(geoid) {
    if (metricCache.has(geoid)) return metricCache.get(geoid);
    const rec = D.census && D.census.blockGroups[geoid];
    const idx = D.index.get(geoid);
    if (!rec) return null;
    const sqmi = idx && idx.aland ? idx.aland / SQM_PER_SQMI : null;
    const m = {
      geoid, rec, lat: idx && idx.lat, lon: idx && idx.lon,
      pop: rec.totalPopulation,
      density: sqmi && rec.totalPopulation != null ? rec.totalPopulation / sqmi : null,
      det: share(rec.structureUnits && rec.structureUnits["1, detached"], rec.structureTotal),
      edu: share(rec.eduBachelorsPlus, rec.eduTotal25plus),
      inc: rec.medianHouseholdIncome,
      hh: rec.avgHouseholdSize,
      ages: agesOf(rec),
      schools: idx ? nearestSchools(idx.lat, idx.lon) : {},
    };
    metricCache.set(geoid, m);
    return m;
  }
  function computeCounty() {
    if (!D.census) return;
    let bach = 0, e25 = 0, hhW = 0, hhN = 0, incW = 0, incN = 0;
    const ages = [0, 0, 0];
    Object.values(D.census.blockGroups).forEach((r) => {
      if (r.eduBachelorsPlus != null && r.eduTotal25plus) { bach += r.eduBachelorsPlus; e25 += r.eduTotal25plus; }
      if (r.avgHouseholdSize && r.householdCount) { hhW += r.avgHouseholdSize * r.householdCount; hhN += r.householdCount; }
      if (r.medianHouseholdIncome > 0 && r.householdCount) { incW += r.medianHouseholdIncome * r.householdCount; incN += r.householdCount; }
      if (r.ageBrackets) {
        const b = C.AGE_BANDS.map((band) => ageBand(r, band) || 0);
        ages[0] += b[0] + b[1]; ages[1] += b[2] + b[3] + b[4]; ages[2] += b[5];
      }
    });
    const at = ages[0] + ages[1] + ages[2];
    D.county = {
      edu: e25 ? Math.round((bach / e25) * 100) : null,
      inc: incN ? Math.round(incW / incN / 1000) * 1000 : null,
      hh: hhN ? +(hhW / hhN).toFixed(1) : null,
      mix: at ? ages.map((a) => Math.round((a / at) * 100)) : null,
    };
  }

  // --- Nearest schools (a stand-in for attendance zones in the finder) ----
  function buildSchoolGrid() {
    const g = new Map();
    D.schools.forEach((s) => {
      const k = `${Math.floor(s.lat / 0.05)},${Math.floor(s.lon / 0.05)}`;
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(s);
    });
    D.schoolGrid = g;
  }
  function miles(lat1, lon1, lat2, lon2) {
    const dx = (lon2 - lon1) * 69.17 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180), dy = (lat2 - lat1) * 69.05;
    return Math.hypot(dx, dy);
  }
  function nearestSchools(lat, lon) {
    const out = {};
    if (!D.schoolGrid) return out;
    const ci = Math.floor(lat / 0.05), cj = Math.floor(lon / 0.05);
    ["elementary", "middle", "high"].forEach((level) => {
      let best = null;
      for (let r = 1; r <= 3 && !best; r++) {
        for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
          (D.schoolGrid.get(`${i},${j}`) || []).forEach((s) => {
            if (!(s.levels || []).includes(level)) return;
            const d = miles(lat, lon, s.lat, s.lon);
            if (!best || d < best.miles) best = { name: s.name, district: s.district, miles: d, rating: PERSONAL && s.ratings && typeof s.ratings[level] === "number" ? s.ratings[level] : null };
          });
        }
      }
      out[level] = best;
    });
    return out;
  }
  const ratingsAvailable = () => PERSONAL && D.schools.some((s) => s.ratings);

  // =======================================================================
  // Commute areas
  // =======================================================================
  const isoCache = new Map();
  async function commuteArea(c) {
    const eff = Math.max(5, Math.round(c.min / (S.rush ? RUSH_FACTOR : 1)));
    const key = `${c.lat.toFixed(4)},${c.lon.toFixed(4)},${eff},${routing() ? "ors" : "line"}`;
    if (isoCache.has(key)) return isoCache.get(key);
    let result;
    if (routing()) {
      try {
        const seconds = Math.min(3600, eff * 60);
        const res = D.orsProxy
          ? await fetch("api/isochrone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lon: c.lon, lat: c.lat, seconds }) })
          : await fetch(C.ORS_ISOCHRONES, {
            method: "POST",
            headers: { Authorization: D.orsKey, "Content-Type": "application/json" },
            body: JSON.stringify({ locations: [[c.lon, c.lat]], range: [seconds], range_type: "time" }),
          });
        const data = await res.json();
        if (!res.ok || !data.features || !data.features.length) throw new Error((data.error && (data.error.message || data.error)) || `HTTP ${res.status}`);
        result = { poly: data.features[0], how: "road network (OpenRouteService)" };
      } catch (err) {
        log("commute", "warn", `Isochrone failed (${err.message}); using a straight-line estimate.`);
      }
    }
    if (!result) result = { poly: turf.circle([c.lon, c.lat], (eff / 60) * FALLBACK_MPH, { units: "miles", steps: 48 }), how: `straight-line estimate at ${FALLBACK_MPH} mph` };
    isoCache.set(key, result);
    return result;
  }
  async function refreshCommutes() {
    for (const c of S.commutes) {
      if (c.lat == null) { c.area = null; continue; }
      c.area = await commuteArea(c);
    }
    drawIsos();
    updateMatches();
  }
  async function geocodeDestination(i) {
    const c = S.commutes[i];
    if (!c.text.trim()) { c.lat = c.lon = null; c.area = null; c.found = ""; redrawQuestion(0); refreshCommutes(); return; }
    c.found = "Finding…"; renderFound(i);
    try {
      const hits = await geocodeText(c.text.trim());
      if (!hits.length) throw new Error("no match");
      c.lat = hits[0].coordinates.y; c.lon = hits[0].coordinates.x;
      c.found = hits[0].matchedAddress; c.err = false;
    } catch (err) {
      c.lat = c.lon = null; c.found = `Couldn't find that address (${err.message}).`; c.err = true;
    }
    renderFound(i);
    await refreshCommutes();
  }
  function renderFound(i) {
    const el = document.getElementById(`c-found-${i}`);
    if (el) { el.textContent = S.commutes[i].found || ""; el.classList.toggle("err", !!S.commutes[i].err); }
  }
  const inAllCommutes = (m) => S.commutes.every((c) => !c.area || (m.lat != null && turf.booleanPointInPolygon([m.lon, m.lat], c.area.poly)));

  // =======================================================================
  // Filtering
  // =======================================================================
  const mixGap = (m) => (m.ages ? (Math.abs(m.ages[0] - S.mix[0]) + Math.abs(m.ages[1] - S.mix[1]) + Math.abs(m.ages[2] - S.mix[2])) / 2 : Infinity);
  function passes(m, upTo) {
    if (!m || m.lat == null) return false;
    if (upTo >= 0 && !inAllCommutes(m)) return false;
    if (upTo >= 1 && S.dens.size && !S.dens.has(densBand(m.density))) return false;
    if (upTo >= 2 && S.detMin && !(m.det >= S.detMin)) return false;
    if (upTo >= 3 && S.edu && !(m.edu >= S.edu)) return false;
    if (upTo >= 4 && S.inc && !(m.inc >= S.inc)) return false;
    if (upTo >= 5 && (S.hhMin > 1 || S.hhMax < 6) && !(m.hh >= S.hhMin && m.hh <= S.hhMax)) return false;
    if (upTo >= 6 && S.useMix && !(mixGap(m) <= 12)) return false;
    if (upTo >= 7 && ratingsAvailable()) {
      const sc = m.schools || {};
      const ok = (lvl, min) => !min || (sc[lvl] && sc[lvl].rating != null && sc[lvl].rating >= min);
      if (!ok("elementary", S.sE) || !ok("middle", S.sM) || !ok("high", S.sH)) return false;
    }
    return true;
  }
  function allMetrics() {
    if (!D.census) return [];
    return Object.keys(D.census.blockGroups).map(metrics).filter((m) => m && m.lat != null);
  }

  // =======================================================================
  // Map
  //
  // Neighbourhoods are drawn as block group outlines, shaded by street
  // busyness, and only from zoom MINZ in: zoomed further out there are too
  // many to read, so nothing is drawn. Areas that fail your answers fade to
  // grey. Outlines are loaded per 0.05° square as you pan and kept.
  //
  // Every outline is interactive: false, so every click reaches the map and
  // one rule decides what it means (onMapClick):
  //   no area selected        -> select the area under the cursor
  //   inside the selected one -> check the house / lot at that point
  //   inside another area     -> select that area instead
  //   outside every area      -> clear the selection
  // =======================================================================
  const MINZ = (C.MIN_ZOOM && C.MIN_ZOOM.blockGroup) || 12;
  const TILE = 0.05;
  const bgPolys = new Map();   // geoid -> { feature, layer, bbox }
  const bgTiles = new Map();   // "row,col" -> load promise
  let bgLayer, selLayer, rasterLayer, ready = false, sel = null, totalAreas = 0;

  function initMap() {
    // Fractional zoom, so a selected area can be sized to a share of the map.
    map = L.map("map", { preferCanvas: true, zoomControl: true, maxZoom: 19, zoomSnap: 0.25 }).setView(C.MAP_CENTER, 10);
    canvasRenderer = L.canvas({ padding: 0.3 });
    let vector = false;
    try {
      const gl = document.createElement("canvas").getContext("webgl");
      if (gl && L.maplibreGL) {
        L.maplibreGL({ style: C.BASEMAP_STYLE, attribution: C.BASEMAP_ATTRIBUTION }).addTo(map);
        vector = true;
      }
    } catch (err) { vector = false; }
    if (!vector) {
      L.tileLayer(C.FALLBACK_BASEMAP_URL, { attribution: C.FALLBACK_BASEMAP_ATTRIBUTION, maxNativeZoom: C.FALLBACK_MAX_NATIVE_ZOOM, maxZoom: 19 }).addTo(map);
      L.tileLayer(C.FALLBACK_BASEMAP_LABELS_URL, { maxNativeZoom: C.FALLBACK_MAX_NATIVE_ZOOM, maxZoom: 19 }).addTo(map);
    }
    // Noise and wind are image tiles. They get their own pane UNDER the vector
    // canvas, so they never cover it or catch clicks (a tile pane is fine; a
    // vector pane would be a second canvas that swallows clicks).
    map.createPane("rasterOverlay");
    map.getPane("rasterOverlay").style.zIndex = 350;   // under the vector canvas (400): air quality etc. draw over noise
    map.getPane("rasterOverlay").style.pointerEvents = "none";
    rasterLayer = L.layerGroup().addTo(map);
    bgLayer = L.layerGroup();
    hazardLayer = L.layerGroup().addTo(map);
    isoLayer = L.layerGroup().addTo(map);
    placeLayer = L.layerGroup().addTo(map);
    focusLayer = L.layerGroup().addTo(map);
    selLayer = L.layerGroup().addTo(map);
    pinLayer = L.layerGroup().addTo(map);
    // A double-click zooms in and selects nothing: a click waits a moment,
    // and a second click within that moment cancels it.
    let clickTimer = null;
    map.on("click", (e) => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
      clickTimer = setTimeout(() => { clickTimer = null; onMapClick(e.latlng); }, 300);
    });
    map.on("dblclick", () => { if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; } });
    let moveTimer = null;
    map.on("moveend", () => { clearTimeout(moveTimer); moveTimer = setTimeout(onMove, 250); });
  }

  // Paint order on the one canvas: area shading < hazards < commute < lot < selected outline.
  function restack() {
    const front = (l) => (l.bringToFront && !l.eachLayer ? l.bringToFront() : l.eachLayer && l.eachLayer(front));
    [hazardLayer, isoLayer, placeLayer, focusLayer, selLayer].forEach((g) => g.eachLayer(front));
  }

  function onMove() {
    if (view === "home") return;
    const show = map.getZoom() >= MINZ;
    if (show && !map.hasLayer(bgLayer)) map.addLayer(bgLayer);
    if (!show && map.hasLayer(bgLayer)) map.removeLayer(bgLayer);
    if (show) loadOutlines();
    drawHazards();
    renderLayerPanel();
    updateHint();
  }

  async function loadOutlines() {
    if (map.getZoom() < MINZ) return;
    const b = map.getBounds();
    const jobs = [];
    let layerId = null;
    for (let i = Math.floor(b.getSouth() / TILE); i <= Math.floor(b.getNorth() / TILE); i++) {
      for (let j = Math.floor(b.getWest() / TILE); j <= Math.floor(b.getEast() / TILE); j++) {
        const key = `${i},${j}`;
        if (bgTiles.has(key)) { jobs.push(bgTiles.get(key)); continue; }
        const job = (async () => {
          layerId = layerId || (await E().blockGroupLayerId());
          const url = Utils.arcgisQueryUrl(C.TIGERWEB, layerId, {
            bbox: { xmin: j * TILE, ymin: i * TILE, xmax: (j + 1) * TILE, ymax: (i + 1) * TILE },
            where: "STATE='06' AND COUNTY='037'",
            outFields: "GEOID",
            extraParams: { maxAllowableOffset: String((C.SIMPLIFY_DEGREES && C.SIMPLIFY_DEGREES.blockGroup) || 0.0002) },
          });
          const gj = await Utils.fetchEsriAsGeoJSON(url, { timeoutMs: 30000 });
          (gj.features || []).forEach(addOutline);
        })().catch((err) => {
          bgTiles.delete(key);
          log("areas", "warn", `Neighbourhood outlines failed for part of the map: ${err.message}`);
        });
        bgTiles.set(key, job);
        jobs.push(job);
      }
    }
    await Promise.all(jobs);
    styleOutlines();
    drawSel();
    restack();
  }
  function addOutline(f) {
    const geoid = f.properties && f.properties.GEOID ? String(f.properties.GEOID) : null;
    if (!geoid || bgPolys.has(geoid)) return;
    const layer = L.geoJSON(f, { interactive: false, style: outlineStyle(geoid) }).addTo(bgLayer);
    bgPolys.set(geoid, { feature: f, layer, bbox: turf.bbox(f) });
  }
  // Every drawn area is shaded by street busyness. When you've searched a
  // place, or your answers are shown, only those areas are drawn at all: the
  // rest are left off the map (and can't be clicked) until you clear the
  // place or choose "Show all areas". The selected area always shows.
  const HIDDEN = { opacity: 0, fillOpacity: 0, weight: 0 };
  function inFocus(geoid) {
    if (geoid === sel) return true;
    if (place && place.geoids && !place.geoids.has(geoid)) return false;
    if (resultsOn()) { const m = metrics(geoid); if (!m || !passes(m, 7)) return false; }
    return true;
  }
  function outlineStyle(geoid) {
    if (!inFocus(geoid)) return HIDDEN;
    const m = metrics(geoid);
    if (!m) return { opacity: 1, color: "#9aa3ad", weight: 0.5, fillColor: "#c8ced4", fillOpacity: 0.08 };
    const band = densBand(m.density);
    return { opacity: 1, color: "#4b5b57", weight: 0.7, fillColor: band >= 0 ? DENS[band].color : "#c8ced4", fillOpacity: 0.5 };
  }
  const anyAnswer = () => !!(S.commutes.some((c) => c.area) || S.dens.size || S.detMin || S.edu || S.inc || S.hhMin > 1 || S.hhMax < 6 || S.useMix || (ratingsAvailable() && (S.sE || S.sM || S.sH)));
  const resultsOn = () => S.showMatches && anyAnswer();
  function resetAnswers() {
    Object.assign(S, { commutes: [{ text: "", min: 35 }], rush: true, dens: new Set(), detMin: 0, edu: 0, inc: 0, hhMin: 1, hhMax: 6, useMix: false, mix: [40, 42, 18], sE: 0, sM: 0, sH: 0, showMatches: true, searchLogged: false });
    step = 0;
    drawIsos();
    if (openPill != null) openFilter(openPill);
    if (view === "find") renderFind();
    updateMatches();
  }
  function styleOutlines() { bgPolys.forEach((p, geoid) => p.layer.setStyle(outlineStyle(geoid))); }
  function outlineAt(latlng) {
    const pt = [latlng.lng, latlng.lat];
    for (const [geoid, p] of bgPolys) {
      const [w, s, e, n] = p.bbox;
      if (pt[0] < w || pt[0] > e || pt[1] < s || pt[1] > n) continue;
      if (!inFocus(geoid)) continue;   // left off the map, so not clickable
      if (turf.booleanPointInPolygon(pt, p.feature)) return geoid;
    }
    return null;
  }

  async function onMapClick(latlng) {
    if (view === "home") return;
    if (map.getZoom() < MINZ) { map.setView(latlng, MINZ); return; }   // nothing is drawn out there yet
    await loadOutlines();
    const geoid = outlineAt(latlng);
    if (!geoid) { deselect(); return; }
    if (geoid === sel) { openHouse({ latlng }); return; }
    selectArea(geoid);
  }
  // Zoom so the area takes roughly 20-30% of the map: its box fills half
  // the width or half the height, whichever comes first.
  const AREA_SHARE = 0.25;   // the area's box takes about a quarter of the map
  function fitArea(shape) {
    const bounds = L.geoJSON(shape).getBounds();
    const size = map.getSize();
    const z = map.getZoom();
    const nw = map.project(bounds.getNorthWest(), z), se = map.project(bounds.getSouthEast(), z);
    const bw = Math.max(1, se.x - nw.x), bh = Math.max(1, se.y - nw.y);
    // Scale so box area = AREA_SHARE of the map, but never wider or taller than 90% of it.
    const f = Math.min(Math.sqrt((AREA_SHARE * size.x * size.y) / (bw * bh)), (0.9 * size.x) / bw, (0.9 * size.y) / bh);
    map.setView(bounds.getCenter(), Math.min(18, z + Math.log2(f)));
  }
  function selectArea(geoid) {
    if (view === "find") {
      sel = geoid;
      const p = bgPolys.get(geoid);
      if (p) fitArea(p.feature);
      drawSel();
      areaDetails(geoid).promise.then(() => { if (sel === geoid) { renderPreview(); renderLayerPanel(); } });
      renderPreview();
      renderLayerPanel();
      updateHint();
    } else openArea(geoid);
  }
  function deselect() {
    sel = null;
    selLayer.clearLayers();
    renderPreview();
    if (view === "area" || view === "house") { location.hash = "find"; return; }
    renderLayerPanel();
    updateHint();
  }
  function drawSel() {
    selLayer.clearLayers();
    if (!sel) return;
    const p = bgPolys.get(sel);
    const det = areaCache.get(sel);
    const shape = (p && p.feature) || (det && det.outline);
    if (shape) L.geoJSON(shape, { interactive: false, style: { color: "#0b6e66", weight: 3.5, fill: false } }).addTo(selLayer);
  }
  function renderPreview() {
    const box = $("#map-preview");
    if (view !== "find" || !sel) { box.hidden = true; return; }
    const m = metrics(sel);
    const band = m ? densBand(m.density) : -1;
    const fits = m && passes(m, 7);
    box.hidden = false;
    box.innerHTML = `<button type="button" class="x" id="pvClose" aria-label="Clear the selection">×</button><b>${esc(areaName(sel))}</b>
      <span>${m ? `${band >= 0 ? DENS[band].label + " · " : ""}${pct(m.det)} houses · ${fmtK(m.inc)} income` : "No Census data here"}</span>
      ${m && anyAnswer() ? `<span class="tag ${fits ? "hot" : ""}">${fits ? "Fits your answers" : "Doesn't fit every answer"}</span>` : ""}
      <button type="button" class="btn" id="pvOpen">Open the area card</button>
      <small>Click inside the outline to check a house</small>`;
    $("#pvClose").onclick = () => deselect();
    $("#pvOpen").onclick = () => openArea(sel);
  }
  function updateHint() {
    const hint = $("#map-hint");
    if (view === "home") return;
    let t;
    if (map.getZoom() < MINZ) t = view === "place" ? "Zoom in to see its block groups" : "Zoom in to see neighbourhood outlines";
    else if (!sel) t = "Click a neighbourhood to select it";
    else t = `${view === "area" && PERSONAL && listingsIn(sel).length ? "Red pins are for sale · " : ""}Click inside the outline to check a house · outside to pick another area`;
    hint.textContent = t;
    hint.hidden = false;
  }

  let matchFrame = null;
  function updateMatches() {
    if (matchFrame) cancelAnimationFrame(matchFrame);
    matchFrame = requestAnimationFrame(() => {
      styleOutlines();
      renderOverlay();
      renderFilterBar();
      updateFilterCount();
      const wc = $("#wcount");
      if (wc) { const n = allMetrics().filter((m) => passes(m, 7)).length; wc.innerHTML = `<b>${n.toLocaleString()}</b> of ${totalAreas.toLocaleString()} areas fit so far`; }
      if (view === "find") { renderPreview(); if (!S.wizard) scheduleExplore(); }
    });
  }
  function drawIsos() {
    isoLayer.clearLayers();
    if (view !== "find") return;
    S.commutes.forEach((c, k) => {
      if (!c.area) return;
      L.geoJSON(c.area.poly, { interactive: false, style: { color: "#2f5f9e", weight: 1.6, dashArray: "6 5", fillColor: "#2f5f9e", fillOpacity: 0.05 } }).addTo(isoLayer);
      L.circleMarker([c.lat, c.lon], { interactive: false, radius: 7, color: "#fff", weight: 2, fillColor: "#2f5f9e", fillOpacity: 1 }).bindTooltip(k ? `Commute ${k + 1}` : "Work", { permanent: true, direction: "right", className: "" }).addTo(isoLayer);
    });
    restack();
  }
  // The card top-left: how many areas fit your answers, with Hide / Edit /
  // Reset, and the searched place. Shown on every map screen, so your
  // results stay with you while you click around.
  function renderOverlay() {
    const box = $("#map-overlay");
    if (view === "home") return;
    const answered = anyAnswer();
    // In the finder the count lives at the top of the list, as on AllTrails.
    const showCount = ready && answered && view !== "find";
    box.hidden = !showCount && !place;
    if (box.hidden) return;
    const n = showCount ? allMetrics().filter((m) => passes(m, 7)).length : 0;
    const applied = appliedChips();
    box.innerHTML = (showCount ? `<div class="count"><b>${n.toLocaleString()}</b><span>of ${totalAreas.toLocaleString()} areas fit your answers</span></div>
      <div class="applied">${applied.map((a) => `<span>${esc(a)}</span>`).join("")}</div>
      ${answered ? `<div class="mctl"><button type="button" id="mShow" aria-pressed="${S.showMatches}">${S.showMatches ? "Show all areas" : "Show only my matches"}</button>${view !== "find" ? `<a href="#find">Edit answers</a><button type="button" id="mReset">Reset</button>` : ""}</div>` : ""}` : "")
      + (place ? `<div class="placechip"><i></i><span>${esc(place.name)}</span><button type="button" id="plClear" aria-label="Clear ${esc(place.name)}">×</button></div>` : "");
    const sh = $("#mShow"); if (sh) sh.onclick = () => { S.showMatches = !S.showMatches; updateMatches(); };
    const rs = $("#mReset"); if (rs) rs.onclick = () => resetAnswers();
    const pc = $("#plClear"); if (pc) pc.onclick = () => clearPlace();
  }
  function appliedChips() {
    const a = [], u = 7;
    const set = S.commutes.filter((c) => c.area);
    if (set.length) a.push(set.map((c, k) => `${c.min} min to ${k ? "commute " + (k + 1) : "work"}`).join(" + ") + (S.rush ? " · rush hour" : ""));
    if (u >= 1 && S.dens.size) a.push([...S.dens].sort().map((i) => DENS[i].label).join(", "));
    if (u >= 2 && S.detMin) a.push(`${S.detMin}%+ houses`);
    if (u >= 3 && S.edu) a.push(`Bachelor's ${S.edu}%+`);
    if (u >= 4 && S.inc) a.push(`Income ${fmtK(S.inc)}+`);
    if (u >= 5 && (S.hhMin > 1 || S.hhMax < 6)) a.push(`Household ${S.hhMin.toFixed(1)}–${S.hhMax.toFixed(1)}`);
    if (u >= 6 && S.useMix) a.push(`Ages ${S.mix.join("/")}`);
    if (u >= 7 && (S.sE || S.sM || S.sH)) a.push("Schools " + [S.sE && "E" + S.sE, S.sM && "M" + S.sM, S.sH && "H" + S.sH].filter(Boolean).join(" "));
    return a;
  }
  function clearFocus() { focusLayer.clearLayers(); pinLayer.clearLayers(); }

  // =======================================================================
  // Formatting and small builders
  // =======================================================================
  const fmtK = (n) => (n == null ? "–" : "$" + Math.round(n / 1000) + "k");
  const fmtM = (n) => (n == null ? "–" : n >= 1e6 ? "$" + (n / 1e6).toFixed(2) + "M" : "$" + Math.round(n / 1000) + "k");
  const pct = (v) => (v == null ? "–" : Math.round(v) + "%");
  const num = (v) => (v == null ? "–" : Math.round(v).toLocaleString());
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const row = (k, v, src, bar, expl) => `<div class="rowv"><span>${k}</span><b>${v}</b>${bar != null ? `<div class="bar6"><i style="width:${clamp(bar, 0, 100)}%"></i></div>` : ""}${expl ? `<p>${expl}</p>` : ""}${src ? `<small>${src}</small>` : ""}</div>`;
  const pill = (cls, t) => `<span class="pillv ${cls}">${t}</span>`;
  const vt = (ok) => (ok ? `<span class="vtag ok">verified</span>` : `<span class="vtag no">not yet verified</span>`);
  const stack = (vals, cols, labels) => `<div class="stack">${vals.map((v, i) => `<i style="width:${clamp(v, 0, 100)}%;background:${cols[i]}"></i>`).join("")}</div><div class="legend2">${labels.map((l, i) => `<span style="--c:${cols[i]}">${esc(l)} ${Math.round(vals[i])}%</span>`).join("")}</div>`;
  function tabsHTML(groups, cur) {
    let i = 0;
    return groups.map((g, gi) => `${gi ? '<span class="tabsep" aria-hidden="true"></span>' : ""}<div class="tabgroup ${g.cls || ""}">${g.label ? `<span class="glabel">${g.label}</span>` : ""}<div class="pills" role="tablist">${g.tabs.map((t) => { const k = i++; return `<button type="button" role="tab" aria-selected="${k === cur}" data-t="${k}">${t}</button>`; }).join("")}</div></div>`).join("");
  }
  const areaName = (geoid) => `Tract ${Number(geoid.slice(5, 11)) / 100}, block group ${geoid.slice(11)}`;

  // =======================================================================
  // Journey 2: the interview
  // =======================================================================
  const QUESTIONS = [
    ["Where do you commute, and how long is OK?", "We draw the area you can reach in time. Add a second commute and we keep only places that work for both."],
    ["How busy do you like your street?", "Do you want people out and about, or quiet? Pick one or more; leave empty for any."],
    ["Houses or apartments around you?", "Slide toward the mix you want on your block. Share of detached houses, Census B25024."],
    ["How educated is the neighbourhood?", "Adults 25 and over with a bachelor's degree or higher, Census B15003."],
    ["Median household income, at least?", "Census B19013, five-year estimate."],
    ["What size are the households here?", "Average people per home, Census B25010. Use it to find areas with homes sized like yours."],
    ["Age mix of the area", "Share of residents by age, Census B01001. Your own preference only; we never rank or recommend areas by who lives there."],
    ["Minimum school ratings?", "Nearest school of each level. Attendance zones are checked on the house card."],
  ];
  function rangeField(id, label, min, max, st, val, fmt, avg, avgLabel) {
    const pos = avg == null ? null : ((avg - min) / (max - min)) * 100;
    return `<div class="field"><label for="${id}">${label}</label><div class="range"><div class="track"><input id="${id}" type="range" min="${min}" max="${max}" step="${st}" value="${val}">${pos == null ? "" : `<div class="avg"><span style="left:${clamp(pos, 8, 92)}%">${avgLabel}</span></div>`}</div><output id="${id}-o">${fmt(val)}</output></div></div>`;
  }
  function bindRange(id, fmt, set, after) {
    const el = document.getElementById(id);
    if (!el) return;
    el.oninput = () => { set(+el.value); document.getElementById(id + "-o").textContent = fmt(+el.value); if (after) after(); updateMatches(); };
  }
  const pctOf = (v, min, max) => ((v - min) / (max - min)) * 100;
  function paintHousehold() {
    const seg = $("#hhSeg");
    if (seg) { seg.style.left = pctOf(S.hhMin, 1, 6) + "%"; seg.style.width = pctOf(S.hhMax, 1, 6) - pctOf(S.hhMin, 1, 6) + "%"; }
    const o = $("#hh-o"); if (o) o.textContent = `${S.hhMin.toFixed(1)}–${S.hhMax.toFixed(1)} people`;
    // Both knobs at the top: lift the lower one so it can still be dragged back.
    const a = $("#hhMin"); if (a) a.style.zIndex = S.hhMin >= 5.5 ? 4 : 2;
  }
  function paintMix() {
    [0, 1, 2].forEach((k) => {
      const seg = $("#mixSeg" + k); if (seg) seg.style.width = S.mix[k] + "%";
      const l = $("#mixL" + k); if (l) l.textContent = S.mix[k] + "%";
    });
    const a = $("#mixA"); if (a) a.style.zIndex = S.mix[0] >= 90 ? 4 : 2;
  }
  function setMix(i, v) {
    v = clamp(v, 0, 100);
    const o = [0, 1, 2].filter((k) => k !== i), rest = 100 - v, cur = S.mix[o[0]] + S.mix[o[1]];
    const a = cur ? Math.round((S.mix[o[0]] / cur) * rest) : Math.round(rest / 2);
    S.mix[i] = v; S.mix[o[0]] = a; S.mix[o[1]] = rest - a;
    [0, 1, 2].forEach((k) => { const el = document.getElementById("mix" + k); if (el) { el.value = S.mix[k]; document.getElementById("mix" + k + "-o").textContent = S.mix[k] + "%"; } });
    const bar = document.querySelector(".mixbar");
    if (bar) bar.innerHTML = S.mix.map((x, k) => `<i style="width:${x}%;background:${AGE_COL[k]}"></i>`).join("");
  }
  // --- The neighbourhood finder -----------------------------------------
  // Like AllTrails: filter pills across the top of the map, each opening its
  // own small panel; the left panel is the live list. "All" opens the guided
  // eight questions instead. Both use the same controls (questionBody /
  // bindQuestion), and only one of them is on the page at a time, so the
  // controls' ids never clash.
  function renderFind() {
    const P = $("#panel");
    if (!D.census || !ready) {
      P.innerHTML = `<div class="pad"><div class="qhead"><h2>Loading LA County…</h2><p>Block group data and centres. If this stays, open Data status (top right).</p></div></div>`;
      return;
    }
    if (!S.wizard) { renderExplore(); return; }
    closeFilter();
    P.innerHTML = `<div class="steps" id="steps"></div><div class="wcount" id="wcount"></div><div class="pad" id="qpane"></div><div class="qfoot" id="qfoot"><button class="btn ghost" id="back" type="button">Back</button><span class="spacer"></span><button class="btn ghost" id="wizClose" type="button">Close</button><button class="btn" id="next" type="button">Next</button><button class="btn ghost" id="skip" type="button">Skip</button></div>`;
    $("#wizClose").onclick = () => finishWizard();
    $("#back").onclick = () => { if (step > 0) { step--; renderQ(); } };
    $("#next").onclick = () => { step = Math.min(NQ, step + 1); renderQ(); };
    $("#skip").onclick = () => { step = Math.min(NQ, step + 1); renderQ(); };
    renderQ();
  }
  // Re-draw question i wherever it is showing: a pill panel or the guided questions.
  function redrawQuestion(i) {
    if (openPill === i) openFilter(i);
    else if (S.wizard && step === i && view === "find") renderQ();
  }
  function finishWizard() {
    S.wizard = false;
    if (!S.searchLogged && anyAnswer()) { S.searchLogged = true; postLead("search", { email: S.email, journey: "neighbourhood", answers: answersSummary() }); }
    renderFind();
    updateMatches();
  }
  function renderQ() {
    const pane = $("#qpane");
    if (!pane) return;
    $("#steps").innerHTML = QUESTIONS.concat([["Results"]]).map((q, i) => `<button type="button" aria-label="${esc(q[0])}" class="${i < step ? "done" : i === step ? "cur" : ""}" data-s="${i}"></button>`).join("");
    $("#steps").querySelectorAll("button").forEach((b) => (b.onclick = () => { step = +b.dataset.s; renderQ(); }));
    const foot = $("#qfoot");
    if (step === NQ) {
      if (!S.gateSeen) { renderGate(pane, () => finishWizard()); foot.hidden = true; } else finishWizard();
      updateMatches();
      return;
    }
    foot.hidden = false; $("#next").textContent = step === NQ - 1 ? "See results" : "Next"; $("#skip").hidden = false; $("#back").disabled = step === 0;
    pane.innerHTML = `<div class="qhead"><span class="qnum">Question ${step + 1} of ${NQ}</span><h2>${esc(QUESTIONS[step][0])}</h2><p>${esc(QUESTIONS[step][1])}</p></div>${questionBody(step)}`;
    bindQuestion(step, pane, renderQ);
    updateMatches();
  }
  function questionBody(i) {
    const cty = D.county || {};
    if (i === 0) {
      return S.commutes.map((c, k) => `<div class="commute"><form class="row" data-geo="${k}"><input type="text" id="c-addr-${k}" placeholder="${k ? "Partner's work address" : "Work address or place"}" value="${esc(c.text)}" aria-label="Commute destination ${k + 1}"><button class="btn ghost" type="submit">Set</button>${k ? `<button class="x" type="button" data-rm="${k}" aria-label="Remove this commute">×</button>` : ""}</form><span class="found" id="c-found-${k}"></span>${rangeField("c-min-" + k, "Up to", 10, 90, 5, c.min, (v) => v + " min")}</div>`).join("") +
        (S.commutes.length < 3 ? `<button class="add" id="addC" type="button">+ Add another commute</button>` : "") +
        `<label class="toggle"><input type="checkbox" id="rush" ${S.rush ? "checked" : ""}> Rush-hour traffic (about ${RUSH_FACTOR}× free-flow time)</label><p class="note">${routing() ? "Areas follow the road network (OpenRouteService, no live traffic; rush hour is an estimate)." : `No routing key, so areas are straight-line estimates at ${FALLBACK_MPH} mph.`}</p>`;
    }
    if (i === 1) {
      return `<div class="sub">People around you</div><div class="opts">${DENS.map((b, k) => `<button type="button" class="opt" data-d="${k}" aria-pressed="${S.dens.has(k)}"><i style="background:${b.color}"></i><div><b>${b.label}</b><span>${b.sub}</span></div><span class="n">${b.num}</span></button>`).join("")}</div>` +
        `<div class="sub">Shops and cafés nearby <span class="soon">coming soon</span></div><p class="note">Needs OpenStreetMap places data, not loaded yet.</p>`;
    }
    if (i === 2) return rangeField("det", "Detached houses on the block, at least", 0, 90, 5, S.detMin, (v) => (v ? `${v}%+ houses` : "Any mix")) + `<div class="ends"><span>More apartments</span><span>More houses</span></div>`;
    if (i === 3) return rangeField("edu", "At least", 0, 80, 5, S.edu, (v) => (v ? v + "%" : "Any"), cty.edu, `LA County ≈ ${cty.edu}%`);
    if (i === 4) return rangeField("inc", "At least", 0, 200000, 10000, S.inc, (v) => (v ? fmtK(v) : "Any"), cty.inc, `LA County ≈ ${fmtK(cty.inc)}`);
    if (i === 5) {
      const avg = cty.hh != null ? `<div class="avg"><span style="left:${clamp(pctOf(cty.hh, 1, 6), 8, 92)}%">LA County ≈ ${cty.hh}</span></div>` : "";
      return `<div class="field"><label for="hhMin">People per home, from and to</label><div class="range"><div class="track"><div class="mslider"><div class="rail"><i class="seg" id="hhSeg"></i></div><input id="hhMin" type="range" min="1" max="6" step="0.1" value="${S.hhMin}" aria-label="From"><input id="hhMax" type="range" min="1" max="6" step="0.1" value="${S.hhMax}" aria-label="To"></div>${avg}</div><output id="hh-o"></output></div></div>`;
    }
    if (i === 6) {
      return `<label class="toggle"><input type="checkbox" id="useMix" ${S.useMix ? "checked" : ""}> Use age mix in my search</label>` +
        (S.useMix ? `<div class="mix"><div class="mslider tall"><div class="rail">${[0, 1, 2].map((k) => `<i id="mixSeg${k}" style="background:${AGE_COL[k]}"></i>`).join("")}</div><input id="mixA" type="range" min="0" max="100" step="1" value="${S.mix[0]}" aria-label="Where under 35 ends"><input id="mixB" type="range" min="0" max="100" step="1" value="${S.mix[0] + S.mix[1]}" aria-label="Where 65 and over starts"></div>
          <div class="mixlegend">${[0, 1, 2].map((k) => `<span><i style="background:${AGE_COL[k]}"></i>${AGE_L[k]} <b id="mixL${k}"></b></span>`).join("")}</div>
          ${cty.mix ? `<p class="note">LA County: ${AGE_L.map((l, k) => `${l.toLowerCase()} ≈ ${cty.mix[k]}%`).join(" · ")}</p>` : ""}
          <p class="note">Drag the two knobs to split the bar; the three parts always add up to 100%. Areas within about 12 points of your mix stay on the map.</p></div>` : `<p class="note">Off by default. Turn it on only if the age mix matters to you.</p>`);
    }
    return ratingsAvailable()
      ? rangeField("sE", "Elementary", 0, 10, 1, S.sE, (v) => (v ? v + "/10" : "Any")) + rangeField("sM", "Middle", 0, 10, 1, S.sM, (v) => (v ? v + "/10" : "Any")) + rangeField("sH", "High", 0, 10, 1, S.sH, (v) => (v ? v + "/10" : "Any"))
      : `<div class="empty">School ratings aren't available in this version${PERSONAL ? " (no ratings file loaded)" : ""}. Skip this question; the house card still lists the nearest schools.</div>`;
  }
  // `again` re-draws whichever holder the controls are in (wizard or pill panel).
  function bindQuestion(i, root, again) {
    if (i === 0) {
      S.commutes.forEach((c, k) => {
        renderFound(k);
        bindRange("c-min-" + k, (v) => v + " min", (v) => { c.min = v; }, () => debounceCommutes());
        const inp = document.getElementById(`c-addr-${k}`);
        inp.oninput = (e) => { c.text = e.target.value.slice(0, 120); };
        attachSuggest(inp, (it) => {
          c.text = it.label;
          if (it.type === "address" && it.hit) {
            c.lat = it.hit.coordinates.y; c.lon = it.hit.coordinates.x; c.found = it.hit.matchedAddress; c.err = false;
            renderFound(k);
            refreshCommutes();
          } else geocodeDestination(k);
        }, { places: false, anyText: true });
      });
      root.querySelectorAll("form[data-geo]").forEach((f) => (f.onsubmit = (e) => { e.preventDefault(); geocodeDestination(+f.dataset.geo); }));
      root.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { S.commutes.splice(+b.dataset.rm, 1); again(); refreshCommutes(); }));
      const add = $("#addC"); if (add) add.onclick = () => { S.commutes.push({ text: "", min: 35 }); again(); };
      $("#rush").onchange = (e) => { S.rush = e.target.checked; refreshCommutes(); };
    }
    if (i === 1) root.querySelectorAll("[data-d]").forEach((b) => (b.onclick = () => { const k = +b.dataset.d; S.dens.has(k) ? S.dens.delete(k) : S.dens.add(k); b.setAttribute("aria-pressed", S.dens.has(k)); updateMatches(); }));
    if (i === 2) bindRange("det", (v) => (v ? `${v}%+ houses` : "Any mix"), (v) => (S.detMin = v));
    if (i === 3) bindRange("edu", (v) => (v ? v + "%" : "Any"), (v) => (S.edu = v));
    if (i === 4) bindRange("inc", (v) => (v ? fmtK(v) : "Any"), (v) => (S.inc = v));
    if (i === 5) {
      // Two knobs on one bar; dragging one past the other pushes it along.
      const a = $("#hhMin"), b = $("#hhMax");
      a.oninput = () => { S.hhMin = +a.value; if (S.hhMax < S.hhMin) { S.hhMax = S.hhMin; b.value = S.hhMax; } paintHousehold(); updateMatches(); };
      b.oninput = () => { S.hhMax = +b.value; if (S.hhMin > S.hhMax) { S.hhMin = S.hhMax; a.value = S.hhMin; } paintHousehold(); updateMatches(); };
      paintHousehold();
    }
    if (i === 6) {
      $("#useMix").onchange = (e) => { S.useMix = e.target.checked; again(); updateMatches(); };
      if (S.useMix) {
        // Knob A ends "under 35", knob B starts "65 and over"; they can't cross.
        const a = $("#mixA"), b = $("#mixB");
        const set = () => { const x = +a.value, y = +b.value; S.mix = [x, y - x, 100 - y]; paintMix(); updateMatches(); };
        a.oninput = () => { if (+a.value > +b.value) a.value = b.value; set(); };
        b.oninput = () => { if (+b.value < +a.value) b.value = a.value; set(); };
        paintMix();
      }
    }
    if (i === 7 && ratingsAvailable()) { bindRange("sE", (v) => (v ? v + "/10" : "Any"), (v) => (S.sE = v)); bindRange("sM", (v) => (v ? v + "/10" : "Any"), (v) => (S.sM = v)); bindRange("sH", (v) => (v ? v + "/10" : "Any"), (v) => (S.sH = v)); }
  }

  // --- Filter pills on the map ------------------------------------------
  const FILTERS = ["Commute", "Street", "Homes", "Education", "Income", "Household", "Age mix", "Schools"];
  let openPill = null;
  function filterValue(i) {
    if (i === 0) { const set = S.commutes.filter((c) => c.area); return set.length ? set.map((c, k) => `${c.min} min to ${k ? "commute " + (k + 1) : "work"}`).join(" + ") : null; }
    if (i === 1) { const l = [...S.dens].sort().map((k) => DENS[k].label); return l.length ? l[0] + (l.length > 1 ? ` +${l.length - 1}` : "") : null; }
    if (i === 2) return S.detMin ? `${S.detMin}%+ houses` : null;
    if (i === 3) return S.edu ? `Bachelor's ${S.edu}%+` : null;
    if (i === 4) return S.inc ? `${fmtK(S.inc)}+ income` : null;
    if (i === 5) return S.hhMin > 1 || S.hhMax < 6 ? `${S.hhMin.toFixed(1)}–${S.hhMax.toFixed(1)} people` : null;
    if (i === 6) return S.useMix ? `Ages ${S.mix.join("/")}` : null;
    return S.sE || S.sM || S.sH ? "Schools " + [S.sE && "E" + S.sE, S.sM && "M" + S.sM, S.sH && "H" + S.sH].filter(Boolean).join(" ") : null;
  }
  function clearFilter(i) {
    if (i === 0) { S.commutes = [{ text: "", min: 35 }]; drawIsos(); }
    if (i === 1) S.dens = new Set();
    if (i === 2) S.detMin = 0;
    if (i === 3) S.edu = 0;
    if (i === 4) S.inc = 0;
    if (i === 5) { S.hhMin = 1; S.hhMax = 6; }
    if (i === 6) S.useMix = false;
    if (i === 7) { S.sE = 0; S.sM = 0; S.sH = 0; }
    if (openPill === i) openFilter(i);
    if (S.wizard && step === i) renderQ();
    updateMatches();
  }
  const pillIcon = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2 4h12M4 8h8M6 12h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
  function renderFilterBar() {
    const bar = $("#filterbar");
    if (view === "home" || !ready) { bar.hidden = true; return; }
    bar.hidden = false;
    const pills = FILTERS.map((label, i) => {
      if (i === 7 && !ratingsAvailable()) return "";
      const v = filterValue(i);
      return v
        ? `<span class="pill on${openPill === i ? " open" : ""}"><button type="button" data-f="${i}">${esc(v)}</button><button type="button" class="px" data-fx="${i}" aria-label="Clear ${esc(label)}">×</button></span>`
        : `<span class="pill${openPill === i ? " open" : ""}"><button type="button" data-f="${i}">${esc(label)}<i class="chev" aria-hidden="true"></i></button></span>`;
    }).join("");
    bar.innerHTML = `<span class="pill all${S.wizard ? " open" : ""}"><button type="button" id="fAll">${pillIcon}All</button></span>${pills}${anyAnswer() ? `<button type="button" class="freset" id="fReset">Reset</button>` : ""}`;
    $("#fAll").onclick = () => { closeFilter(); S.wizard = true; step = 0; if (view !== "find") location.hash = "find"; else renderFind(); renderFilterBar(); };
    bar.querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => (openPill === +b.dataset.f ? closeFilter() : openFilter(+b.dataset.f))));
    bar.querySelectorAll("[data-fx]").forEach((b) => (b.onclick = () => clearFilter(+b.dataset.fx)));
    const r = $("#fReset"); if (r) r.onclick = () => resetAnswers();
  }
  function openFilter(i) {
    // The guided questions and a pill panel never show the same controls at once.
    if (S.wizard) { S.wizard = false; if (view === "find") renderFind(); }
    openPill = i;
    const pop = $("#filter-pop");
    pop.innerHTML = `<div class="fhead"><b>${esc(QUESTIONS[i][0])}</b><button type="button" class="x" id="fpClose" aria-label="Close">×</button></div><p class="note">${esc(QUESTIONS[i][1])}</p>${questionBody(i)}<div class="ffoot"><button type="button" class="btn ghost" id="fpClear">Clear</button><button type="button" class="btn" id="fpDone">${showLabel()}</button></div>`;
    pop.hidden = false;
    const pill = $(`#filterbar [data-f="${i}"]`);
    const box = $(".mapbox").getBoundingClientRect();
    const left = pill ? pill.getBoundingClientRect().left - box.left : 12;
    pop.style.left = Math.max(8, Math.min(left, box.width - pop.offsetWidth - 8)) + "px";
    bindQuestion(i, pop, () => openFilter(i));
    $("#fpClose").onclick = () => closeFilter();
    $("#fpDone").onclick = () => closeFilter();
    $("#fpClear").onclick = () => clearFilter(i);
    renderFilterBar();
  }
  function closeFilter() {
    openPill = null;
    const pop = $("#filter-pop");
    if (pop) { pop.hidden = true; pop.innerHTML = ""; }
    renderFilterBar();
  }
  function showLabel() { const n = allMetrics().filter((m) => passes(m, 7)).length; return `Show ${n.toLocaleString()} area${n === 1 ? "" : "s"}`; }
  function updateFilterCount() {
    const b = $("#fpDone");
    if (b) b.textContent = showLabel();
  }
  let commuteTimer = null;
  function debounceCommutes() { clearTimeout(commuteTimer); commuteTimer = setTimeout(refreshCommutes, 700); }

  function answersSummary() {
    return {
      commutes: S.commutes.filter((c) => c.area).map((c) => ({ to: c.found || c.text, minutes: c.min })), rush: S.rush,
      busy: [...S.dens].map((i) => DENS[i].label), housesMin: S.detMin, bachelorsMin: S.edu, incomeMin: S.inc,
      household: [S.hhMin, S.hhMax], ageMix: S.useMix ? S.mix : null, schools: ratingsAvailable() ? { e: S.sE, m: S.sM, h: S.sH } : null,
    };
  }
  // The answers in one short code, for the "open your results" link.
  function answersCode() {
    const o = { c: S.commutes.filter((c) => c.lat != null).map((c) => [String(c.found || c.text).slice(0, 80), c.min, +c.lat.toFixed(5), +c.lon.toFixed(5)]), r: S.rush ? 1 : 0, d: [...S.dens], h: S.detMin, e: S.edu, i: S.inc, s: [S.hhMin, S.hhMax], m: S.useMix ? S.mix : 0, k: [S.sE, S.sM, S.sH] };
    return btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function restoreAnswers(code) {
    try {
      const o = JSON.parse(decodeURIComponent(escape(atob(code.replace(/-/g, "+").replace(/_/g, "/")))));
      const n = (v, a, b, d) => (Number.isFinite(+v) ? clamp(+v, a, b) : d);
      S.commutes = (Array.isArray(o.c) ? o.c : []).slice(0, 3).map((c) => ({ text: String(c[0] || "").slice(0, 120), found: String(c[0] || "").slice(0, 120), min: n(c[1], 10, 90, 35), lat: n(c[2], 32, 36, null), lon: n(c[3], -120, -116, null) })).filter((c) => c.lat != null && c.lon != null);
      if (!S.commutes.length) S.commutes = [{ text: "", min: 35 }];
      S.rush = !!o.r;
      S.dens = new Set((Array.isArray(o.d) ? o.d : []).map(Number).filter((i) => i >= 0 && i < DENS.length));
      S.detMin = n(o.h, 0, 90, 0); S.edu = n(o.e, 0, 80, 0); S.inc = n(o.i, 0, 200000, 0);
      S.hhMin = n(o.s && o.s[0], 1, 6, 1); S.hhMax = n(o.s && o.s[1], 1, 6, 6);
      S.useMix = Array.isArray(o.m) && o.m.length === 3; if (S.useMix) S.mix = o.m.map((x) => n(x, 0, 100, 33));
      [S.sE, S.sM, S.sH] = (Array.isArray(o.k) ? o.k : [0, 0, 0]).map((x) => n(x, 0, 10, 0));
      S.gateSeen = true; S.searchLogged = true; step = NQ;
      return true;
    } catch (err) {
      log("results", "warn", "That results link couldn't be read; start the questions again.");
      return false;
    }
  }
  function shortlist() {
    const M = SORTS[SORT.k] || SORTS.edu;
    return allMetrics().filter((m) => passes(m, 7)).map((m) => ({ m, v: M.v(m) })).sort((a, b) => (a.v == null ? 1 : b.v == null ? -1 : SORT.dir === "asc" ? a.v - b.v : b.v - a.v)).map((x) => x.m);
  }
  function emailResults(list) {
    return list.slice(0, 10).map((m) => ({ geoid: m.geoid, name: areaName(m.geoid), busy: densBand(m.density) >= 0 ? DENS[densBand(m.density)].label : "", houses: m.det, income: m.inc, price: D.prices && D.prices[m.geoid] ? D.prices[m.geoid].medianSalePrice : null }));
  }
  // The email step. In the guided questions it comes before the list (with
  // "Skip"); in the list it opens from "Email me this list".
  function renderGate(pane, onDone, inline) {
    const n = allMetrics().filter((m) => passes(m, 7)).length;
    const shownAt = Date.now();
    pane.innerHTML = (inline ? "" : `<div class="qhead"><span class="qnum">Almost there</span><h2>${n.toLocaleString()} ${n === 1 ? "area fits" : "areas fit"} what you asked for</h2><p>Where should we send your shortlist? We may also ask what you thought of the tool.</p></div>`) +
      `<form class="gate" id="gateForm" novalidate><label class="lbl" for="gEmail">Email</label><div class="row"><input id="gEmail" type="email" placeholder="you@example.com" autocomplete="email"><button class="btn" type="submit">${inline ? "Email me this list" : "Show my results"}</button></div><input type="text" id="gWeb" name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true"><span class="err" id="gErr" hidden></span><p class="note">Used only to send your shortlist and ask for feedback. No spam. <a href="privacy.html">Privacy</a></p></form>` +
      (inline ? "" : `<button type="button" class="linkbtn" id="gSkip" style="color:var(--muted)">Skip for now and show results</button>`);
    $("#gateForm").onsubmit = async (e) => {
      e.preventDefault();
      const v = $("#gEmail").value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) { $("#gErr").textContent = "That doesn't look like an email address."; $("#gErr").hidden = false; return; }
      const list = shortlist();
      const r = await postLead("lead", { email: v, journey: "neighbourhood", answers: answersSummary(), answerLines: appliedChips(), count: list.length, results: emailResults(list), r: answersCode(), website: $("#gWeb").value, t: Date.now() - shownAt });
      S.email = v; S.gateSeen = true; S.savedWhere = r.where; S.emailed = !!r.emailed; S.showGate = false;
      onDone();
    };
    const sk = $("#gSkip"); if (sk) sk.onclick = () => { S.gateSeen = true; onDone(); };
  }

  const SORTS = {
    busy: { l: "Street busyness", v: (m) => m.density, f: (v) => (v == null ? "–" : Math.round(v).toLocaleString() + " /sq mi"), d: "asc" },
    houses: { l: "Share of houses", v: (m) => m.det, f: (v) => pct(v) + " houses", d: "desc" },
    edu: { l: "Education", v: (m) => m.edu, f: (v) => pct(v) + " bachelor's", d: "desc" },
    inc: { l: "Income", v: (m) => m.inc, f: fmtK, d: "desc" },
    hh: { l: "Household size", v: (m) => m.hh, f: (v) => (v == null ? "–" : v.toFixed(1) + " per home"), d: "desc" },
    age: { l: "Age-mix match", v: (m) => mixGap(m), f: (v) => Math.round(v) + " pts from your mix", d: "asc" },
    school: { l: "Nearest school ratings", v: (m) => avgRating(m), f: (v) => (v == null ? "–" : v.toFixed(1) + " / 10"), d: "desc" },
    commute: { l: "Distance to work", v: (m) => commuteMiles(m), f: (v) => (v == null ? "–" : v.toFixed(1) + " mi"), d: "asc" },
    sale: { l: "Homes for sale", v: (m) => listingsIn(m.geoid).length, f: (v) => v + " for sale", d: "desc" },
    price: { l: "Median price", v: (m) => (D.prices && D.prices[m.geoid] ? D.prices[m.geoid].medianSalePrice : null), f: fmtM, d: "asc" },
  };
  const SORT = { k: "edu", dir: "desc" };
  function avgRating(m) { const r = ["elementary", "middle", "high"].map((l) => m.schools && m.schools[l] && m.schools[l].rating).filter((x) => x != null); return r.length ? r.reduce((a, b) => a + b, 0) / r.length : null; }
  function commuteMiles(m) { const c = S.commutes.find((x) => x.lat != null); return c ? miles(m.lat, m.lon, c.lat, c.lon) : null; }
  // The left panel of the finder: the live list, like AllTrails' "32 trails".
  let exploreFrame = null, exploreMore = 25;
  function scheduleExplore() {
    if (exploreFrame) cancelAnimationFrame(exploreFrame);
    exploreFrame = requestAnimationFrame(() => { if (view === "find" && !S.wizard && ready) renderExplore(); });
  }
  function renderExplore() {
    const P = $("#panel");
    const keys = Object.keys(SORTS).filter((k) => (k !== "age" || S.useMix) && (k !== "school" || ratingsAvailable()) && (k !== "commute" || S.commutes.some((c) => c.lat != null)) && (k !== "sale" || PERSONAL));
    if (!keys.includes(SORT.k)) { SORT.k = keys[0]; SORT.dir = SORTS[SORT.k].d; }
    const M = SORTS[SORT.k];
    const hits = shortlist();
    const shown = hits.slice(0, exploreMore);
    const answered = anyAnswer();
    const sent = S.email ? (S.savedWhere === "device" ? "Saved on this device" : S.emailed ? `Sent to ${esc(S.email)}, check your inbox` : `Saved for ${esc(S.email)}`) : "";
    // Keep the email form open across re-draws while you type in it.
    const typing = S.showGate && document.activeElement && document.activeElement.id === "gEmail" ? document.activeElement.value : null;
    P.innerHTML = `<div class="explore"><div class="ehead"><h2>Explore areas</h2>
      <div class="erow"><span class="ecount"><b>${hits.length.toLocaleString()}</b> ${answered ? (hits.length === 1 ? "area fits" : "areas fit") : "areas in LA County"}</span>
      <span class="esort"><select id="sortK" aria-label="Sort by">${keys.map((k) => `<option value="${k}" ${k === SORT.k ? "selected" : ""}>${SORTS[k].l}</option>`).join("")}</select><button type="button" id="sortDir" aria-label="Sort direction">${SORT.dir === "asc" ? "↑ Low to high" : "↓ High to low"}</button></span></div>
      ${answered ? `<div class="erow2"><button type="button" class="linkbtn" id="mShow">${S.showMatches ? "Show all areas on the map" : "Show only my matches on the map"}</button>${S.showGate ? "" : `<button type="button" class="btn ghost sm" id="emailList">${sent ? "Email it again" : "Email me this list"}</button>`}</div>` : ""}
      ${sent ? `<p class="note sent">${sent}</p>` : ""}<div id="gateSlot"></div></div>
      ${answered ? "" : `<div class="eintro">Use the filters along the top of the map, or <button type="button" class="linkbtn" id="wizStart">answer 8 quick questions</button>. Each area is a Census block group, a few city blocks.</div>`}
      ${hits.length ? `<div class="results">${shown.map((m) => resultCard(m, M.f(M.v(m)))).join("")}</div>${hits.length > shown.length ? `<button type="button" class="btn ghost more" id="more">Show ${Math.min(25, hits.length - shown.length)} more of ${hits.length.toLocaleString()}</button>` : ""}`
        : `<div class="empty">Nothing matches every filter. Try a longer commute, or loosen income or the other filters.</div>`}</div>`;
    const sk = $("#sortK"); if (sk) sk.onchange = () => { SORT.k = sk.value; SORT.dir = SORTS[SORT.k].d; renderExplore(); };
    const sd = $("#sortDir"); if (sd) sd.onclick = () => { SORT.dir = SORT.dir === "asc" ? "desc" : "asc"; renderExplore(); };
    const sh = $("#mShow"); if (sh) sh.onclick = () => { S.showMatches = !S.showMatches; updateMatches(); };
    const em = $("#emailList"); if (em) em.onclick = () => { S.showGate = true; renderExplore(); };
    const ws = $("#wizStart"); if (ws) ws.onclick = () => { S.wizard = true; step = 0; renderFind(); renderFilterBar(); };
    const mo = $("#more"); if (mo) mo.onclick = () => { exploreMore += 25; renderExplore(); };
    if (S.showGate) {
      renderGate($("#gateSlot"), () => renderExplore(), true);
      if (typing != null) { const g = $("#gEmail"); g.value = typing; g.focus(); }
    }
    P.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => openArea(b.dataset.open)));
  }
  function resultCard(m, val) {
    const n = PERSONAL ? listingsIn(m.geoid).length : 0;
    const sc = m.schools || {};
    const r = ["elementary", "middle", "high"].map((l) => (sc[l] && sc[l].rating != null ? sc[l].rating : "–")).join("/");
    const band = densBand(m.density);
    return `<button type="button" class="res" data-open="${m.geoid}"><div class="t"><b>${esc(areaName(m.geoid))}</b><span class="v">${esc(val)}</span></div><div class="tags">
      ${band >= 0 ? `<span class="tag">${DENS[band].label}</span>` : ""}<span class="tag">${pct(m.det)} houses</span><span class="tag">Bachelor's ${pct(m.edu)}</span><span class="tag">${fmtK(m.inc)} income</span>
      <span class="tag">${m.hh != null ? m.hh.toFixed(1) : "–"} per home</span>${m.ages ? `<span class="tag">Under 35: ${m.ages[0]}% · 65+: ${m.ages[2]}%</span>` : ""}${ratingsAvailable() ? `<span class="tag">Schools ${r}</span>` : ""}${PERSONAL ? `<span class="tag ${n ? "hot" : ""}">${n} for sale</span>` : ""}</div></button>`;
  }

  // =======================================================================
  // Area details (live lookups, cached per block group)
  // =======================================================================
  function listingsIn(geoid) {
    const det = areaCache.get(geoid);
    const outline = det && det.outline;
    if (!PERSONAL || !D.listings.length) return [];
    if (outline) return D.listings.filter((l) => turf.booleanPointInPolygon([l.lon, l.lat], outline));
    const m = metrics(geoid);
    return m ? D.listings.filter((l) => miles(l.lat, l.lon, m.lat, m.lon) < 0.15) : [];
  }
  async function hazardsAt(lat, lon) {
    const ask = async (key) => { try { return { hits: await E().hazardAt(key, lat, lon) }; } catch (err) { log(key, "warn", `${key} check failed: ${err.message}`); return { error: err.message }; } };
    const [fire, flood, seismic, pollution] = await Promise.all(["fire", "flood", "seismic", "pollution"].map(ask));
    const h = {};
    // fire
    if (fire.error) h.fire = { cls: "na", text: "Couldn't check" };
    else {
      const cs = fire.hits.map((x) => E().fireClass(x.attrs)).filter(Boolean);
      const worst = ["very high", "high", "moderate"].find((c) => cs.includes(c));
      h.fire = worst ? { cls: worst === "very high" ? "bad" : "watch", text: worst[0].toUpperCase() + worst.slice(1) } : { cls: "good", text: "Not in a mapped zone" };
    }
    // flood
    if (flood.error) h.flood = { cls: "na", text: "Couldn't check" };
    else {
      const fc = flood.hits.map((x) => E().floodClass(x.attrs)).filter(Boolean)[0];
      if (!fc) h.flood = { cls: "good", text: "Not in a mapped zone" };
      else h.flood = { cls: /^A|^V/.test(fc.label) ? "bad" : /shaded|D -/.test(fc.label) ? "watch" : "good", text: fc.label };
    }
    // seismic (liquefaction / landslide)
    if (seismic.error) { h.liquefaction = h.landslide = { cls: "na", text: "Couldn't check" }; }
    else {
      const kinds = new Set(seismic.hits.map((x) => x.hazard));
      h.liquefaction = kinds.has("liquefaction") ? { cls: "watch", text: "In a zone" } : { cls: "good", text: "Not in a zone" };
      h.landslide = kinds.has("landslide") ? { cls: "watch", text: "In a zone" } : { cls: "good", text: "Not in a zone" };
    }
    // pollution burden (CalEnviroScreen, by tract)
    if (pollution.error || !pollution.hits.length) h.pollution = { cls: "na", text: pollution.error ? "Couldn't check" : "No score" };
    else {
      const p = Number(Utils.pickField(pollution.hits[0].attrs, C.CES_FIELDS.score));
      h.pollution = Number.isFinite(p) ? { cls: p > 75 ? "bad" : p > 50 ? "watch" : "good", text: `${Math.round(p)}th percentile`, value: p } : { cls: "na", text: "No score" };
    }
    // wind (local grid)
    const w = windAt(lat, lon);
    if (w == null) h.wind = { cls: "na", text: "No data" };
    else {
      const b = (C.WIND_BUCKETS || []).find((x) => w < x.max);
      h.wind = { cls: w > 7 ? "watch" : "good", text: `${w.toFixed(1)} m/s${b && b.label ? ` · ${b.label}` : ""}` };
    }
    return h;
  }
  function windAt(lat, lon) {
    const g = D.wind;
    if (!g || !g.bbox) return null;
    const { bbox, nrows, ncols, values } = g;
    if (lat > bbox.north || lat < bbox.south || lon < bbox.west || lon > bbox.east) return null;
    const r = Math.min(nrows - 1, Math.floor(((bbox.north - lat) / (bbox.north - bbox.south)) * nrows));
    const c = Math.min(ncols - 1, Math.floor(((lon - bbox.west) / (bbox.east - bbox.west)) * ncols));
    const v = values[r * ncols + c];
    return Number.isFinite(v) ? v : null;
  }
  function areaDetails(geoid) {
    if (areaCache.has(geoid)) return areaCache.get(geoid);
    const m = metrics(geoid);
    const det = { outline: null, hazards: null, loading: true };
    areaCache.set(geoid, det);
    // The point to ask about: the Census centre, or the drawn outline's if
    // this block group has no Census row.
    const drawn = bgPolys.get(geoid);
    const c = m && m.lat != null ? [m.lat, m.lon] : drawn ? turf.pointOnFeature(drawn.feature).geometry.coordinates.slice().reverse() : null;
    if (!c) { det.loading = false; det.promise = Promise.resolve(det); return det; }
    det.promise = (async () => {
      const [bg, hz] = await Promise.all([
        E().blockGroupAt(c[0], c[1]).catch((err) => { log("area", "warn", `Block group outline failed: ${err.message}`); return null; }),
        hazardsAt(c[0], c[1]),
      ]);
      det.outline = bg && bg.geometry ? bg : null;
      det.hazards = hz;
      det.loading = false;
      return det;
    })();
    return det;
  }

  // --- Neighbourhood tab content (shared by area and house cards) ---------
  function hazardTile(h) {
    if (!h) return `<div class="sig na"><small>Natural hazards</small><b>Checking…</b></div>`;
    const list = [["Fire", h.fire], ["Flood", h.flood], ["Landslide", h.landslide], ["Liquefaction", h.liquefaction]];
    const flagged = list.filter(([, v]) => v.cls === "bad" || v.cls === "watch");
    const unknown = list.filter(([, v]) => v.cls === "na");
    if (!flagged.length) return `<div class="sig ${unknown.length ? "neutral" : "good"}"><small>Natural hazards</small><b>${unknown.length ? "None found so far" : "None mapped here"}</b><em>${unknown.length ? `${unknown.length} check(s) didn't answer` : "Fire, flood, landslide, liquefaction"}</em></div>`;
    const worst = flagged.some(([, v]) => v.cls === "bad") ? "bad" : "watch";
    const clear = list.filter(([, v]) => v.cls === "good").map(([k]) => k.toLowerCase());
    return `<div class="sig ${worst}"><small>Natural hazards</small><b>${flagged.map(([k, v]) => `${k}: ${esc(v.text.toLowerCase())}`).join(" · ")}</b><em>${clear.length ? `No ${clear.join(", ")} zone mapped` : ""}${unknown.length ? `${clear.length ? " · " : ""}${unknown.map(([k]) => k.toLowerCase()).join(", ")} couldn't be checked` : ""}</em></div>`;
  }
  function airTile(h) {
    if (!h) return `<div class="sig na"><small>Noise & air</small><b>Checking…</b></div>`;
    return `<div class="sig ${h.pollution.cls}"><small>Noise & air</small><b>Air: ${esc(h.pollution.text)}</b><em>Pollution burden, CalEnviroScreen. Noise: on the full map</em></div>`;
  }
  const streetTile = () => `<div class="sig na"><small>Street level</small><b>Crime, lights, pavement</b><em>Coming soon</em></div>`;
  function schoolTile(m) {
    const sc = m.schools || {};
    const r = ["elementary", "middle", "high"].map((l) => sc[l] && sc[l].rating);
    if (r.some((x) => x != null)) { const a = avgRating(m); return `<div class="sig ${a >= 7 ? "good" : a >= 5 ? "neutral" : "watch"}"><small>Schools (nearest)</small><b>${r.map((x) => (x == null ? "–" : x)).join(" · ")}</b><em>Elementary · middle · high</em></div>`; }
    const e = sc.elementary;
    return `<div class="sig neutral"><small>Schools (nearest)</small><b>${e ? esc(e.name) : "–"}</b><em>${e ? e.miles.toFixed(1) + " mi · ratings not shown" : "No school data loaded"}</em></div>`;
  }
  // The block group's homes: who owns, and how much of it is houses. (Who
  // lives there stays in the People tab, by choice.)
  const peopleTile = (m) => {
    const own = share(m.rec.ownerOccupied, m.rec.tenureTotal);
    return `<div class="sig neutral"><small>Block group: homes</small><b>${own != null ? `${Math.round(own)}% owners · ${Math.round(100 - own)}% renters` : "Owners vs renters: –"}</b><em>${m.det != null ? `${Math.round(m.det)}% single-family houses` : "Single-family share: –"} · Census B25003, B25024</em></div>`;
  };
  const moneyTile = (m) => `<div class="sig neutral"><small>Money & work</small><b>${fmtK(m.inc)} median income</b><em>${D.county && D.county.inc && m.inc ? (m.inc >= D.county.inc ? "Above" : "Below") + ` LA County (${fmtK(D.county.inc)})` : "Census B19013"}</em></div>`;
  function salesTile(geoid) {
    const p = D.prices && D.prices[geoid];
    return p ? `<div class="sig neutral"><small>Sales & prices</small><b>${fmtM(p.medianSalePrice)} median</b><em>${p.saleCount} sale${p.saleCount === 1 ? "" : "s"}${p.thin ? " · thin sample" : ""}</em></div>` : `<div class="sig na"><small>Sales & prices</small><b>No sales on file</b><em>Assessor roll</em></div>`;
  }
  function autoSummary(m, h) {
    const parts = [];
    const band = densBand(m.density);
    parts.push(`${band >= 0 ? DENS[band].label + "," : "An area"} where ${m.det >= 70 ? "most homes are detached houses" : m.det >= 30 ? "houses sit alongside apartment buildings" : "apartments outnumber houses"}.`);
    const own = share(m.rec.ownerOccupied, m.rec.tenureTotal);
    if (own != null) parts.push(own >= 60 ? "Most homes are owner-occupied, so turnover tends to be low." : "Many homes are rented, so the area tends to change faster.");
    const wfh = share(m.rec.workedFromHome, m.rec.workersTotal);
    if (m.rec.commuteMedianMinutes) parts.push(`Workers here commute about ${Math.round(m.rec.commuteMedianMinutes)} minutes${wfh != null && wfh >= 15 ? `, and ${Math.round(wfh)}% work from home` : ""}.`);
    const a = avgRating(m);
    if (a != null) parts.push(`The nearest schools rate ${a.toFixed(1)} out of 10 on average.`);
    if (h) {
      const flags = [["fire", h.fire], ["flood", h.flood], ["landslide", h.landslide]].filter(([, v]) => v.cls === "bad" || v.cls === "watch").map(([k]) => k);
      parts.push(flags.length ? `Plan for ${flags.join(" and ")} risk and get insurance quotes before you offer.` : "No natural hazard zones are mapped here.");
    }
    return `<div class="summary"><h3>What it's like here</h3><p>${esc(parts.join(" "))}</p><small>Written automatically from the numbers on this card only, never about who your neighbours are</small></div>`;
  }
  function incomeBands(rec) {
    const b = rec.incomeBrackets; if (!b || !rec.householdCount) return null;
    const out = [0, 0, 0, 0];
    Object.entries(b).forEach(([label, n]) => {
      // Labels look like "< $10k", "$50-60k", "$200k+": the top of the range decides the band.
      const mm = label.match(/(\d+)k\+?$/);
      const hi = mm ? Number(mm[1]) : null;
      const k = /\+/.test(label) ? 3 : hi == null ? 0 : hi <= 50 ? 0 : hi <= 100 ? 1 : hi <= 200 ? 2 : 3;
      out[k] += n || 0;
    });
    const t = out.reduce((a, x) => a + x, 0) || 1;
    return out.map((x) => (x / t) * 100);
  }
  function peopleTab(m) {
    const r = m.rec, cty = D.county || {};
    const ages = C.AGE_BANDS.map((band) => share(ageBand(r, band), r.totalPopulation) || 0);
    const eth = r.ethnicityAcs && r.ethnicityAcsTotal ? Object.entries(r.ethnicityAcs).sort((a, b) => b[1] - a[1]) : [];
    const ethCols = ["#e07a5f", "#3d5a80", "#81b29a", "#f2cc8f", "#9c89b8", "#b0b8b5", "#6d597a"];
    const origins = r.originTop ? Object.entries(r.originTop).sort((a, b) => b[1] - a[1]).slice(0, 5) : [];
    const band = densBand(m.density);
    return `<div class="sec"><h3>Who lives here</h3>${row("Residents", num(r.totalPopulation), "Census ACS B01001")}${row("Average household size", m.hh != null ? m.hh.toFixed(1) + " people" : "–", `B25010${cty.hh ? " · LA County ≈ " + cty.hh : ""}`)}${row("Families with children under 18", pct(share(r.familiesWithChildren, r.families)), "B11003", share(r.familiesWithChildren, r.families))}${row("Owners vs renters", pct(share(r.ownerOccupied, r.tenureTotal)) + " own", "B25003", share(r.ownerOccupied, r.tenureTotal))}${row("Street feel", band >= 0 ? `${DENS[band].label} · ${num(m.density)} / sq mi` : "–", "People per sq mi of land, TIGERweb land area")}</div>
      <div class="sec"><h3>Age</h3>${stack(ages, ["#b7e4c7", "#74c69d", "#2f5f9e", "#7fa8e0", "#3d5a80", "#b26b00"], C.AGE_BANDS.map((b) => b.label))}<p class="note">B01001${cty.mix ? ` · LA County: under 35 ≈ ${cty.mix[0]}%, 65+ ≈ ${cty.mix[2]}%` : ""}</p></div>
      <div class="sec"><h3>Education (adults 25+)</h3>${row("Bachelor's degree or higher", pct(m.edu), `B15003${cty.edu ? " · LA County ≈ " + cty.edu + "%" : ""}`, m.edu)}${row("Among 25–34 year olds", pct(share(r.edu25to34BachelorsPlus, r.edu25to34Total)), "B15001", share(r.edu25to34BachelorsPlus, r.edu25to34Total))}</div>
      ${eth.length ? `<div class="sec"><h3>Race and ethnicity</h3>${stack(eth.map(([, n]) => (n / r.ethnicityAcsTotal) * 100), ethCols, eth.map(([k]) => k))}<p class="note">ACS B03002, five-year estimate</p></div>` : ""}
      ${origins.length ? `<div class="sec"><h3>Most common origins and ancestries</h3>${origins.map(([k, v]) => row(esc(k), v.toFixed(0) + "%", null, v * 3)).join("")}<p class="note">Share of the ${esc(r.originTopGeo || "area")} (B03001, B02015, B04006); people can report more than one</p></div>` : ""}`;
  }
  function moneyTab(m) {
    const r = m.rec, cty = D.county || {};
    const ib = incomeBands(r);
    const emp = r.civilianLaborForce ? share(r.civilianLaborForce - (r.unemployed || 0), r.pop16Plus) : null;
    const units = r.structureUnits && r.structureTotal ? (() => {
      const u = r.structureUnits, t = r.structureTotal;
      const det = u["1, detached"] || 0, att = u["1, attached"] || 0;
      const small = Object.entries(u).filter(([k]) => /^(2|3 or 4)/.test(k)).reduce((a, [, n]) => a + n, 0);
      return [det, att, small, Math.max(0, t - det - att - small)].map((x) => (x / t) * 100);
    })() : null;
    return `<div class="sec"><h3>Income</h3>${row("Median household income", r.medianHouseholdIncome ? "$" + r.medianHouseholdIncome.toLocaleString() : "–", `B19013${cty.inc ? " · LA County ≈ " + fmtK(cty.inc) : ""}`)}${row("Per-person income", r.perCapitaIncome ? "$" + r.perCapitaIncome.toLocaleString() : "–", "B19301")}${ib ? stack(ib, ["#d6dedb", "#a9c9c4", "#0b6e66", "#06403b"], ["Under $50k", "$50–100k", "$100–200k", "$200k+"]) + `<p class="note">Households by income, B19001</p>` : ""}</div>
      <div class="sec"><h3>Work</h3>${row("Employed (16+)", pct(emp), "B23025", emp)}${row("Unemployment", pct(share(r.unemployed, r.civilianLaborForce)), "B23025")}${row("Work from home", pct(share(r.workedFromHome, r.workersTotal)), "B08301", share(r.workedFromHome, r.workersTotal))}${row("Take transit", pct(share(r.transitToWork, r.workersTotal)), "B08301")}${row("Walk to work", pct(share(r.walkedToWork, r.workersTotal)), "B08301")}${row("Median commute", r.commuteMedianMinutes ? Math.round(r.commuteMedianMinutes) + " min" : "–", "B08303")}${row("Commutes of 45 min or more", pct(share(r.commute45Plus, r.commuteWorkers)), "B08303", share(r.commute45Plus, r.commuteWorkers))}</div>
      <div class="sec"><h3>Homes</h3>${row("Owner-reported home value", r.medianHomeValue ? fmtM(r.medianHomeValue) : "–", "B25077 · owners' own estimate, not a sale price")}${row("Median year built", r.medianYearBuilt ? String(r.medianYearBuilt) : "–", "B25035")}${row("Built before 1980", pct(share(r.yearBuiltPre1980, r.yearBuiltTotal)), "B25034", share(r.yearBuiltPre1980, r.yearBuiltTotal))}${units ? stack(units, ["#0b6e66", "#74c69d", "#7fa8e0", "#3d5a80"], ["Detached", "Attached", "2–4 units", "5+ units"]) + `<p class="note">Units in structure, B25024</p>` : ""}</div>`;
  }
  function safetyTab(h) {
    if (!h) return `<p class="loading">Checking fire, flood, quake and air…</p>`;
    const r = (k, v, src, expl) => row(k, pill(v.cls, esc(v.text)), src, null, expl);
    return `<div class="sec"><h3>Natural hazards</h3>${r("Fire", h.fire, "CAL FIRE Fire Hazard Severity Zones (county and state services)")}${r("Flood", h.flood, "FEMA National Flood Hazard Layer", h.flood.cls === "bad" ? "In a 1% annual-chance floodplain: a federally backed mortgage requires flood insurance." : null)}${r("Landslide", h.landslide, "CA Geological Survey seismic hazard zones")}${r("Liquefaction", h.liquefaction, "CA Geological Survey seismic hazard zones")}${r("Wind", h.wind, "Global Wind Atlas 3 (local grid)")}</div>
      ${h.fire.text === "Very high" ? `<div class="flag"><b>Insurance:</b> very high fire zones often need the California FAIR Plan plus a wrap-around policy. Get quotes before you offer.</div>` : ""}
      <div class="sec"><h3>Noise & air</h3>${r("Pollution burden", h.pollution, "CalEnviroScreen 4.0, by census tract · higher is worse")}${row("Aircraft, road and rail noise", pill("na", "On the full map"), "BTS / DOT noise map (tiles only, no point lookup yet)")}</div>
      <div class="sec"><h3>Street level</h3>${row("Crime", pill("na", "Coming soon"), "Police incident data")}${row("Street lights", pill("na", "Coming soon"), "OpenStreetMap")}${row("Pavement quality", pill("na", "Coming soon"), "City pavement data")}${row("Traffic on nearby roads", pill("na", "Coming soon"), "Caltrans traffic counts")}</div>`;
  }
  function schoolsTab(m) {
    const sc = m.schools || {};
    return `<div class="sec"><h3>Nearest schools</h3>${["elementary", "middle", "high"].map((l) => { const s = sc[l]; return row(l[0].toUpperCase() + l.slice(1), s ? (s.rating != null ? s.rating + " / 10" : esc(s.name)) : "–", s ? `${s.rating != null ? esc(s.name) + " · " : ""}${esc(s.district || "")} · ${s.miles.toFixed(1)} mi${s.rating != null ? " · your GreatSchools table" : ""}` : "CA Dept of Education directory"); }).join("")}</div><p class="note">Nearest by distance, not the assigned school: attendance zones can cut across blocks. Confirm with the district.${PERSONAL ? "" : " Ratings aren't shown in the public version."}</p>`;
  }
  function trend(geoid) {
    const p = D.prices && D.prices[geoid];
    const yrs = p && p.years ? Object.entries(p.years).sort((a, b) => a[0] - b[0]).slice(-6) : [];
    if (!yrs.length) return "";
    const mx = Math.max(...yrs.map(([, y]) => y.median || 0)) || 1;
    return `<div class="sec"><h3>Median price by year</h3><div class="spark">${yrs.map(([y, v]) => `<div><span>${v.median ? (v.median / 1e6).toFixed(2) : "–"}</span><i style="height:${Math.round(((v.median || 0) / mx) * 44)}px"></i><span>${y}</span></div>`).join("")}</div><p class="note">Median, $ millions · number of sales per year varies</p></div>`;
  }
  function salesRows(geoid) {
    // The sales file groups each block group's rows by year: { "2021": [row, ...], ... }.
    const byYear = (D.sales && D.sales[geoid]) || {};
    const rows = Array.isArray(byYear) ? byYear : Object.values(byYear).flat();
    return rows.map((r) => Object.fromEntries(SALES_COLUMNS.map((c, i) => [c, r[i]]))).sort((a, b) => String(b.recorded).localeCompare(String(a.recorded)));
  }
  const fmtDate = (d) => { const s = String(d || ""); return /^\d{8}$/.test(s) ? `${s.slice(4, 6)}/${s.slice(0, 4)}` : s || "–"; };
  function salesTab(geoid, extra) {
    const p = D.prices && D.prices[geoid];
    const last = salesRows(geoid).slice(0, 5);
    return `<div class="sec"><h3>This area</h3>${row("Median single-family price", p ? fmtM(p.medianSalePrice) : "–", "Assessor roll: assessed value at the last sale")}${row("Sales behind it", p ? String(p.saleCount) + (p.thin ? " (thin sample)" : "") : "–", "Assessor roll")}${PERSONAL ? row("Homes for sale now", String(listingsIn(geoid).length), "Your Redfin exports") : ""}</div>${trend(geoid)}
      ${last.length ? `<div class="sec"><h3>Last ${last.length} sold</h3><table class="comps"><thead><tr><th>Sold</th><th>Address</th><th>Sq ft</th><th>Price*</th></tr></thead><tbody>${last.map((s) => `<tr><td>${fmtDate(s.recorded)}</td><td>${esc(s.address || "")}</td><td>${num(s.sqft)}</td><td>${fmtM(s.assessed)}</td></tr>`).join("")}</tbody></table><p class="note">*Assessed value set at the sale, within a percent or two of the price. The newest 6–18 months aren't on the roll yet.</p></div>` : ""}${extra || ""}`;
  }
  function dataTab(geoid) {
    const meta = (D.census && D.census.meta) || {};
    return `<div class="sec"><h3>Where these numbers come from</h3>${row("Census tables", `ACS 5-year ${meta.year || ""}`, "api.census.gov, built by fetch-blockgroup-data.py")}${row("Boundaries and land area", "Live", "Census TIGERweb")}${row("Hazards", "Live", "CAL FIRE, FEMA, CA Geological Survey, CalEnviroScreen")}${row("Prices and sales", "Assessor roll", "fetch-parcel-data.py")}${row("Schools", "CA Dept of Education", PERSONAL ? "Ratings: your GreatSchools table" : "Ratings hidden in the public version")}${row("Census block group", geoid, "GEOID")}</div>`;
  }

  // =======================================================================
  // Area card
  // =======================================================================
  const ATABS = [{ cls: "grow", tabs: ["Summary", "People", "Money & work", "Safety & environment", "Schools", "Sales & prices", "Data"] }];
  function openArea(geoid) {
    area = { geoid, from: view === "area" || view === "house" ? (area && area.from) || "find" : view }; atab = 0; sel = geoid;
    const det = areaDetails(geoid);
    if (location.hash !== `#area-${geoid}`) location.hash = `area-${geoid}`; else route();
    det.promise.then(() => {
      if (!area || area.geoid !== geoid) return;
      if (view === "area") { renderArea(); drawAreaMap(); }
    });
  }
  function renderArea() {
    const geoid = area.geoid, m = metrics(geoid), det = areaDetails(geoid);
    const P = $("#panel");
    if (!m) { P.innerHTML = `<div class="pad"><div class="empty">No Census data for block group ${esc(geoid)}.</div></div>`; return; }
    const L = listingsIn(geoid);
    const h = det.hazards;
    const commute = S.commutes.filter((c) => c.area).map((c, k) => `<div class="sig good"><small>Drive to ${k ? "commute " + (k + 1) : "work"}</small><b>Inside your ${c.min}-min area</b><em>${esc(c.area.how)}</em></div>`).join("");
    const fits = [];
    if (S.commutes.some((c) => c.area)) fits.push(`Inside your ${S.commutes.filter((c) => c.area).map((c) => c.min + "-minute").join(" and ")} commute`);
    if (S.dens.size && densBand(m.density) >= 0) fits.push(`${DENS[densBand(m.density)].label}, as you asked`);
    if (S.edu) fits.push(`Bachelor's share ${pct(m.edu)}, above your ${S.edu}%`);
    if (S.inc) fits.push(`Median income ${fmtK(m.inc)}, above your ${fmtK(S.inc)}`);
    if (S.detMin) fits.push(`${pct(m.det)} detached houses, above your ${S.detMin}%`);
    const forSale = !PERSONAL ? `<div class="empty">Homes for sale will appear here once a listing feed is connected. Click any lot on the map to check it.</div>`
      : L.length ? `<div class="sec"><h3>Homes for sale here</h3><div class="listings">${L.slice(0, 20).map((l, i) => `<button type="button" class="lst" data-l="${i}"><i aria-hidden="true"></i><b>${esc(l.address || "")}</b><span class="p">${fmtM(l.price)}</span><small>${l.beds ?? "–"} bd · ${l.baths ?? "–"} ba · ${num(l.sqft)} sq ft${l.yearBuilt ? " · built " + l.yearBuilt : ""}</small></button>`).join("")}</div><p class="note">From your Redfin exports. Or click any lot on the map to check it.</p></div>`
      : `<div class="empty"><b>No homes for sale here ${det.outline ? "right now" : "found yet"}.</b> Click any lot on the map to check it, or <button type="button" class="linkbtn" id="alertMe">get an email when one lists</button>.<div id="alertSlot"></div></div>`;
    const band = densBand(m.density);
    P.innerHTML = `<div class="card-head"><div class="crumb">${area.from === "place" && place ? `<a href="#place">← Back to ${esc(place.name)}</a>` : `<a href="#find" id="toResults">← Back to the list</a>`}</div><h2>${esc(areaName(geoid))}</h2><p>${band >= 0 ? DENS[band].label + " · " : ""}${pct(m.det)} houses${PERSONAL ? ` · ${L.length} for sale` : ""}</p></div><div class="tabs" id="aTabs">${tabsHTML(ATABS, atab)}</div><div class="tabpane" id="aPane"></div>`;
    $("#aTabs").querySelectorAll("button").forEach((b) => (b.onclick = () => { atab = +b.dataset.t; renderArea(); }));
    const panes = [
      () => `<div class="signals">${commute}${hazardTile(h)}${airTile(h)}${streetTile()}${schoolTile(m)}${peopleTile(m)}${moneyTile(m)}${salesTile(geoid)}</div>${autoSummary(m, h)}${fits.length ? `<div class="fit"><h3>Why it matched</h3><ul>${fits.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>` : ""}${forSale}`,
      () => peopleTab(m), () => moneyTab(m), () => safetyTab(h), () => schoolsTab(m), () => salesTab(geoid), () => dataTab(geoid),
    ];
    $("#aPane").innerHTML = panes[atab]();
    $("#aPane").querySelectorAll("[data-l]").forEach((b) => (b.onclick = () => openHouse({ listing: L[+b.dataset.l] })));
    const al = $("#alertMe");
    if (al) al.onclick = () => alertForm(geoid);
  }
  function alertForm(geoid) {
    const slot = $("#alertSlot");
    if (S.email) { postLead("alert", { email: S.email, geoid }).then((r) => { slot.innerHTML = `<p class="note" style="color:var(--good)">${r.where === "device" ? "Saved on this device." : "Done. We'll email " + esc(S.email) + "."}</p>`; }); return; }
    slot.innerHTML = `<form class="gate" id="alertForm" style="margin-top:8px"><div class="row"><input id="aEmail" type="email" placeholder="you@example.com" aria-label="Email for alerts"><button class="btn" type="submit">Alert me</button></div><span class="err" id="aErr" hidden></span></form>`;
    $("#alertForm").onsubmit = async (e) => {
      e.preventDefault();
      const v = $("#aEmail").value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) { $("#aErr").textContent = "That doesn't look like an email address."; $("#aErr").hidden = false; return; }
      S.email = v;
      const r = await postLead("alert", { email: v, geoid });
      slot.innerHTML = `<p class="note" style="color:var(--good)">${r.where === "device" ? "Saved on this device." : "Done. We'll email you when one lists."}</p>`;
    };
  }
  function drawAreaMap() {
    clearFocus();
    const det = areaDetails(area.geoid), m = metrics(area.geoid);
    sel = area.geoid;
    drawSel();
    const shape = (bgPolys.get(sel) || {}).feature || det.outline;
    // Centre the area once, when it is opened - not on every redraw, so a
    // pan or zoom of yours isn't undone a second later.
    if (shape && !area.fitted) { fitArea(shape); area.fitted = true; }
    else if (!shape && m && (map.getZoom() < MINZ || !map.getBounds().contains([m.lat, m.lon]))) map.setView([m.lat, m.lon], 15);
    if (PERSONAL) listingsIn(area.geoid).forEach((l) => {
      L.marker([l.lat, l.lon], { icon: L.divIcon({ className: "", html: `<span class="price-pin">${fmtM(l.price)}</span>`, iconSize: null }) })
        .on("click", (e) => { L.DomEvent.stopPropagation(e); openHouse({ listing: l }); }).addTo(pinLayer);
    });
    renderLayerPanel();
    updateHint();
    restack();
  }

  // --- Map layers (upper right) ------------------------------------------
  // All off until you switch them on. Each row also says what was found at
  // the selected spot, whether or not its layer is drawn.
  const LAYERS = [
    { k: "fire", label: "Fire", color: "#d7301f", vector: true, from: (h) => h.fire },
    { k: "flood", label: "Flood", color: "#2b7bd0", vector: true, from: (h) => h.flood },
    { k: "seismic", label: "Landslide & liquefaction", color: "#a16207", vector: true, from: (h) => (h.landslide.cls === "watch" ? h.landslide : h.liquefaction) },
    { k: "noise", label: "Noise (air, road, rail)", color: "#c51b8a", from: () => null },
    { k: "pollution", label: "Air quality", color: "#e08214", vector: true, from: (h) => h.pollution },
    { k: "wind", label: "Wind", color: "#43a2ca", from: (h) => h.wind },
  ];
  const vecState = new Map();   // key -> { box, layer }
  const rasters = new Map();    // key -> Leaflet layer (or a promise of one)
  const layerNote = new Map();  // key -> a message shown in place of the spot's answer
  function spotHazards() {
    if (view === "house") return house && house.hazards;
    const g = view === "area" ? area && area.geoid : view === "find" ? sel : null;
    const det = g ? areaCache.get(g) : null;
    return det && det.hazards;
  }
  function legendFor(k) {
    const sw = (list) => `<div class="lgd">${list.map(([c, t]) => `<span><i style="background:${c}"></i>${esc(t)}</span>`).join("")}</div>`;
    if (k === "fire") return sw(Object.entries(C.FIRE_CLASS_COLORS).map(([t, c]) => [c, t]));
    if (k === "pollution") return sw((C.POLLUTION_BUCKETS || []).map((b) => [b.color, b.label.replace(/ \(.*\)/, "")])) + `<small>CalEnviroScreen percentile, by census tract</small>`;
    if (k === "wind") return sw((C.WIND_BUCKETS || []).map((b) => [b.color, b.label.replace(/ \(.*\)/, "")]));
    if (k === "noise") {
      const lay = rasters.get("noise");
      const rows = [];
      const seen = new Set();
      (lay && lay.getLayers ? lay.getLayers() : []).forEach((l) => (l.legendRows || []).forEach((r) => { if (!seen.has(r.label)) { seen.add(r.label); rows.push(r); } }));
      if (rows.length) return `<div class="lgd">${rows.slice(0, 8).map((r) => `<span>${r.image ? `<img src="${esc(r.image)}" alt="" width="12" height="12">` : ""}${esc(r.label)}</span>`).join("")}</div><small>US DOT noise map, its own legend</small>`;
      return sw((C.NOISE && C.NOISE.FALLBACK_BANDS || []).map((b) => [b.color, b.label])) + `<small>US DOT noise map; approximate bands (the service sent no legend)</small>`;
    }
    return "";
  }
  // What each drawn line means, listed under the layers whenever it is on the map.
  const KEY = { lot: "#d6336c", building: "#6b7a76", envelope: "#334155", adu: "#1f8a4c", sel: "#0b6e66", place: "#2f5f9e", commute: "#2f5f9e" };
  function mapKey() {
    const k = [];
    const line = (c, dash, t, fill) => `<span><i class="k" style="border-color:${c};border-style:${dash ? "dashed" : "solid"};${fill ? `background:${fill}` : ""}"></i>${esc(t)}</span>`;
    if (map.hasLayer(bgLayer) && bgPolys.size) k.push(`<span><i class="k sw" style="background:linear-gradient(90deg,${DENS.map((d) => d.color).join(",")})"></i>Shading: darker green = quieter street</span>`);
    if (view === "find" && S.commutes.some((c) => c.area)) k.push(line(KEY.commute, true, "Reachable within your commute", "rgba(47,95,158,.08)"));
    if (place && place.shape) k.push(line(KEY.place, true, `${/zip/i.test(place.sub) ? "Zip code" : /city/i.test(place.sub) ? "City" : "Neighbourhood"} border`));
    if (sel && view !== "house") k.push(line(KEY.sel, false, "Selected area: click inside for a house"));
    if (view === "house" && house && !house.loading && !house.error) {
      k.push(line(KEY.lot, false, "Selected lot"));
      const b = house.build;
      if (b && !b.unavailable) {
        if ((b.buildings || []).length) k.push(line(KEY.building, false, "Existing buildings", "rgba(107,122,118,.45)"));
        if (b.mainEnvelope) k.push(line(KEY.envelope, true, "Where the main house may go"));
        if (b.largest) k.push(line(KEY.adu, false, "Largest open spot for a backyard ADU", "rgba(31,138,76,.3)"));
      }
    }
    return k.length ? `<h3 class="keyh">On this map</h3><div class="key">${k.join("")}</div>` : "";
  }
  function renderLayerPanel() {
    const box = $("#map-layers");
    if (view === "home") { box.hidden = true; return; }
    const h = spotHazards();
    box.hidden = false;
    box.innerHTML = `<h3>Show on map</h3>` + LAYERS.map((l) => {
      const on = shownLayers.has(l.k);
      const minZ = l.vector && C.OVERLAYS[l.k] ? C.OVERLAYS[l.k].minZoom : 0;
      const note = layerNote.get(l.k) || (on && minZ && map.getZoom() < minZ ? "Zoom in to see it" : null);
      const v = h ? l.from(h) : null;
      const answer = note ? `<span style="color:var(--muted)">${esc(note)}</span>` : v ? `<span style="color:var(--${v.cls === "na" ? "muted" : v.cls})">${v.cls === "good" && l.k !== "wind" && l.k !== "pollution" ? "None here" : esc(v.text)}</span>` : "<span></span>";
      return `<button type="button" class="layer" data-l="${l.k}" aria-pressed="${on}"><i style="background:${l.color}"></i><b>${l.label}</b>${answer}</button>${on ? legendFor(l.k) : ""}`;
    }).join("") + mapKey();
    box.querySelectorAll("[data-l]").forEach((b) => (b.onclick = () => toggleLayer(b.dataset.l)));
  }
  async function toggleLayer(k) {
    const on = !shownLayers.has(k);
    on ? shownLayers.add(k) : shownLayers.delete(k);
    layerNote.delete(k);
    renderLayerPanel();
    const spec = LAYERS.find((l) => l.k === k);
    if (spec.vector) { drawHazards(); return; }
    if (!on) { const r = rasters.get(k); if (r && r.remove) rasterLayer.removeLayer(r); rasters.delete(k); return; }
    try {
      let lay;
      if (k === "noise") {
        // Road and rail first, aircraft on top: road noise covers far more
        // ground and would otherwise hide the airport contours.
        const got = await Promise.allSettled([E().noiseLayer("surface"), E().noiseLayer("aviation")]);
        const ok = got.filter((g) => g.status === "fulfilled").map((g) => g.value);
        got.filter((g) => g.status === "rejected").forEach((g) => log("noise", "warn", `A noise service failed: ${g.reason && g.reason.message}`));
        if (!ok.length) throw new Error("no noise service answered");
        lay = L.layerGroup(ok);
        // Fainter than the explorer's, so vector layers on top stay readable.
        const fade = (l, z) => (l.setOpacity ? (l.setOpacity(0.4), l.setZIndex && l.setZIndex(z)) : l.eachLayer && l.eachLayer((x) => fade(x, z)));
        ok.forEach((l, i) => fade(l, got[0].status === "fulfilled" && i === 0 ? 2 : 3));
      } else {
        lay = await E().windOverlay();
        if (!lay) throw new Error("no wind file");
      }
      if (!shownLayers.has(k)) return;      // switched off while loading
      rasters.set(k, lay);
      rasterLayer.addLayer(lay);
      renderLayerPanel();   // the noise legend arrives with the layer
    } catch (err) {
      shownLayers.delete(k);
      layerNote.set(k, k === "wind" ? "No wind file on this machine" : "Couldn't load");
      log(k, "warn", `${spec.label} layer failed: ${err.message}`);
      renderLayerPanel();
    }
  }
  // Vector hazards for what's on screen, re-fetched only when you pan past
  // what was loaded. Each overlay has its own minimum zoom in BG_CONFIG.
  async function drawHazards() {
    for (const l of LAYERS.filter((x) => x.vector)) {
      const k = l.k, st = vecState.get(k);
      const minZ = (C.OVERLAYS[k] && C.OVERLAYS[k].minZoom) || 0;
      if (!shownLayers.has(k) || map.getZoom() < minZ) {
        if (st) { hazardLayer.removeLayer(st.layer); vecState.delete(k); }
        continue;
      }
      if (st && st.box.contains(map.getBounds())) continue;
      const box = map.getBounds().pad(0.4);
      const bbox = { xmin: box.getWest(), ymin: box.getSouth(), xmax: box.getEast(), ymax: box.getNorth() };
      try {
        const gj = await E().hazardShapes(k, bbox);
        if (!shownLayers.has(k)) continue;
        const layer = L.geoJSON(gj, { interactive: false, style: (f) => hazardStyle(k, f.properties || {}) });
        const old = vecState.get(k);
        if (old) hazardLayer.removeLayer(old.layer);
        hazardLayer.addLayer(layer);
        vecState.set(k, { box, layer });
        restack();
      } catch (err) {
        log(k, "warn", `${l.label} shapes failed: ${err.message}`);
      }
    }
  }
  function hazardStyle(k, p) {
    if (k === "pollution") {
      const score = Number(Utils.pickField(p, C.CES_FIELDS.score));
      const b = Number.isFinite(score) ? (C.POLLUTION_BUCKETS || []).find((x) => score <= x.max) : null;
      return { color: "#8a5a00", weight: 0.4, fillColor: b ? b.color : "#ccc", fillOpacity: b ? 0.55 : 0 };
    }
    const color = k === "fire" ? (C.FIRE_CLASS_COLORS[E().fireClass(p)] || "#fc8d59") : k === "flood" ? ((E().floodClass(p) || {}).color || "#93c5fd") : (C.SEISMIC_COLORS[p.__hazard] || "#a16207");
    return { color, weight: 0.6, fillColor: color, fillOpacity: k === "flood" && /minimal/i.test((E().floodClass(p) || {}).label || "") ? 0 : 0.35 };
  }

  // =======================================================================
  // Places: one search box for an address, a neighbourhood or a zip
  //
  // Neighbourhood and city names (with their borders) come from the county,
  // zip borders from Census TIGERweb; both lists of candidates live in
  // BG_CONFIG.PLACES. A place's block groups are the ones whose Census
  // interior point falls inside its border.
  // =======================================================================
  const PL = C.PLACES || { sources: [], nameFields: [], zipWhere: [] };
  const places = [];
  let place = null;     // { name, sub, shape, geoids:Set } once loaded
  let placeLayer;

  async function findLayer(src) {
    const data = await Utils.fetchJSON(`${src.url}?f=json`, { timeoutMs: 20000 });
    if (data && data.error) throw new Error(data.error.message || "service error");
    const lay = (data.layers || []).find((l) => src.match.test(l.name || "") && !(src.exclude && src.exclude.test(l.name || "")) && (!l.geometryType || /polygon/i.test(l.geometryType)));
    if (!lay) throw new Error(`no layer matching ${src.match}`);
    return lay;
  }
  function placeName(raw, kind) {
    const t = String(raw).trim();
    let m;
    if ((m = t.match(/^City of (.+)$/i))) return { name: m[1], sub: "City" };
    if ((m = t.match(/^Los Angeles\s*-\s*(.+)$/i))) return { name: m[1], sub: "Los Angeles neighbourhood" };
    if ((m = t.match(/^Unincorporated\s*-\s*(.+)$/i))) return { name: m[1], sub: "Unincorporated community" };
    return { name: t, sub: kind === "city" ? "City" : "Neighbourhood" };
  }
  async function loadPlaces() {
    const seen = new Set(), done = new Set();
    for (const src of PL.sources) {
      if (done.has(src.kind)) continue;
      try {
        const lay = await findLayer(src);
        const params = new URLSearchParams({ where: "1=1", outFields: "*", returnGeometry: "false", resultRecordCount: "2000", f: "json" });
        const data = await Utils.fetchJSON(`${src.url}/${lay.id}/query?${params}`, { timeoutMs: 30000 });
        if (data && data.error) throw new Error(data.error.message || "query error");
        const feats = data.features || [];
        const field = PL.nameFields.find((f) => feats.some((x) => x.attributes && x.attributes[f]));
        if (!field) throw new Error(`no name field among ${PL.nameFields.join(", ")}`);
        let n = 0;
        feats.forEach((x) => {
          const raw = x.attributes[field];
          if (!raw) return;
          const pn = placeName(raw, src.kind);
          if (seen.has(pn.name.toLowerCase())) return;
          seen.add(pn.name.toLowerCase());
          places.push({ ...pn, raw: String(raw), src: { url: src.url, layerId: lay.id, field } });
          n++;
        });
        done.add(src.kind);
        log("places", "ok", `Place names: ${n} from "${lay.name}" (field ${field}) at ${src.url}.`);
      } catch (err) {
        log("places", "warn", `Place names (${src.kind}) from ${src.url} failed: ${err.message}`);
      }
    }
    places.sort((a, b) => a.name.localeCompare(b.name));
  }
  async function placeShape(pl) {
    const where = `${pl.src.field}='${pl.raw.replace(/'/g, "''")}'`;
    const gj = await Utils.fetchEsriAsGeoJSON(Utils.arcgisQueryUrl(pl.src.url, pl.src.layerId, { where, outFields: pl.src.field, extraParams: { maxAllowableOffset: "0.0003" } }), { timeoutMs: 30000 });
    if (!gj.features.length) throw new Error("no border returned");
    return { type: "FeatureCollection", features: gj.features };
  }
  async function zipShape(zip) {
    const layerId = await E().zipLayerId();
    for (const w of PL.zipWhere) {
      try {
        const gj = await Utils.fetchEsriAsGeoJSON(Utils.arcgisQueryUrl(C.TIGERWEB, layerId, { where: w.replace("{zip}", zip), outFields: "*", extraParams: { maxAllowableOffset: "0.0003" } }), { timeoutMs: 30000 });
        if (gj.features.length) { log("places", "ok", `Zip ${zip} border from TIGERweb layer ${layerId} (${w.split("=")[0]}).`); return { type: "FeatureCollection", features: gj.features }; }
      } catch (err) { /* that field isn't on this vintage: try the next */ }
    }
    throw new Error(`zip ${zip} not found on TIGERweb`);
  }
  const inShape = (shape, lon, lat) => shape.features.some((f) => f.geometry && turf.booleanPointInPolygon([lon, lat], f));

  async function openPlace(pl) {
    place = { loading: true, name: pl.zip ? `Zip ${pl.zip}` : pl.name, sub: pl.zip ? "Zip code" : pl.sub };
    const mine = place;
    if (location.hash !== "#place") location.hash = "place"; else route();
    try {
      const shape = pl.zip ? await zipShape(pl.zip) : await placeShape(pl);
      const geoids = new Set();
      D.index.forEach((v, g) => { if (inShape(shape, v.lon, v.lat)) geoids.add(g); });
      Object.assign(mine, { loading: false, shape, geoids });
    } catch (err) {
      Object.assign(mine, { loading: false, error: `Couldn't load the border of ${mine.name} (${err.message}).` });
      log("places", "warn", mine.error);
    }
    if (place !== mine) return;
    styleOutlines();
    renderOverlay();
    if (view === "place") { renderPlace(); drawPlaceMap(true); }
  }
  function clearPlace() {
    place = null;
    placeLayer.clearLayers();
    styleOutlines();
    renderOverlay();
    if (view === "place") location.hash = "lookup";
  }
  function drawPlaceMap(fit) {
    placeLayer.clearLayers();
    if (!place || !place.shape) return;
    const lay = L.geoJSON(place.shape, { interactive: false, style: { color: "#2f5f9e", weight: 2.5, dashArray: "7 5", fill: false } }).addTo(placeLayer);
    if (fit) map.fitBounds(lay.getBounds(), { padding: [30, 30], maxZoom: 15 });
    restack();
  }
  function renderPlace() {
    const P = $("#panel");
    const head = (extra) => `<div class="card-head"><div class="crumb"><a href="#home">← New search</a></div><h2>${esc(place.name)}</h2><p>${esc(place.sub)}${extra || ""}</p></div>`;
    if (!place) { renderLookup(); return; }
    if (place.loading) { P.innerHTML = head() + `<div class="pad"><p class="loading">Finding its border and block groups…</p></div>`; return; }
    if (place.error) { P.innerHTML = head() + `<div class="pad"><div class="empty">${esc(place.error)}</div></div>`; return; }
    const ms = [...place.geoids].map(metrics).filter(Boolean);
    const sum = (f) => ms.reduce((a, m) => a + (f(m) || 0), 0);
    const pop = sum((m) => m.rec.totalPopulation);
    const det = share(sum((m) => m.rec.structureUnits && m.rec.structureUnits["1, detached"]), sum((m) => m.rec.structureTotal));
    const edu = share(sum((m) => m.rec.eduBachelorsPlus), sum((m) => m.rec.eduTotal25plus));
    const hh = sum((m) => (m.inc > 0 ? m.rec.householdCount : 0));
    const inc = hh ? sum((m) => (m.inc > 0 ? m.inc * m.rec.householdCount : 0)) / hh : null;
    const pr = ms.map((m) => D.prices && D.prices[m.geoid]).filter((p) => p && p.medianSalePrice);
    const sales = pr.reduce((a, p) => a + p.saleCount, 0);
    const price = sales ? pr.reduce((a, p) => a + p.medianSalePrice * p.saleCount, 0) / sales : null;
    const fit = resultsOn() ? ms.filter((m) => passes(m, 7)).length : null;
    const list = ms.slice().sort((a, b) => (b.inc || 0) - (a.inc || 0));
    P.innerHTML = head(` · ${place.geoids.size} block group${place.geoids.size === 1 ? "" : "s"}`) + `<div class="tabpane">
      <div class="signals">
        <div class="sig neutral"><small>People</small><b>${num(pop)} residents</b><em>Census B01001, summed</em></div>
        <div class="sig neutral"><small>Money & work</small><b>${fmtK(inc)} typical income</b><em>Household-weighted median, B19013</em></div>
        <div class="sig neutral"><small>Homes</small><b>${pct(det)} detached houses</b><em>B25024</em></div>
        <div class="sig neutral"><small>Education</small><b>${pct(edu)} bachelor's+</b><em>Adults 25+, B15003</em></div>
        <div class="sig neutral"><small>Sales & prices</small><b>${price ? fmtM(price) + " typical" : "No sales on file"}</b><em>${sales ? sales + " single-family sales · assessor roll" : "Assessor roll"}</em></div>
        ${fit != null ? `<div class="sig ${fit ? "good" : "watch"}"><small>Your answers</small><b>${fit} of ${ms.length} fit</b><em>Only those are shaded on the map</em></div>` : ""}
      </div>
      <div class="sec"><h3>Block groups in ${esc(place.name)}</h3><p class="note">Each is a few city blocks. Open one for its full card, or click it on the map.</p></div>
      <div class="results">${list.slice(0, 60).map((m) => resultCard(m, fmtK(m.inc) + " income")).join("")}</div>
      ${list.length > 60 ? `<p class="note">Showing the first 60 of ${list.length}. Zoom the map to see the rest.</p>` : ""}
    </div>`;
    P.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => openArea(b.dataset.open)));
  }

  // --- Address search ----------------------------------------------------
  async function proxyGeo(q, mode) {
    const res = await fetch(`api/geocode?${new URLSearchParams({ q, mode })}`);
    if (!res.ok) throw new Error(`address service HTTP ${res.status}`);
    const rows = await res.json();
    return (Array.isArray(rows) ? rows : []).map((r) => ({ matchedAddress: r.display_name, coordinates: { x: Number(r.lon), y: Number(r.lat) }, details: r.address || null }));
  }
  const geoProxy = () => D.cfg && D.cfg.geocode === "proxy";
  async function geocodeText(text) {
    if (geoProxy()) { const hits = await proxyGeo(text, "search").catch(() => []); if (hits.length) return hits; }
    return E().geocode(text);
  }
  async function suggestAddr(q) {
    if (geoProxy()) return proxyGeo(q, "suggest");
    if (!PERSONAL) return [];
    return E().suggestAddresses(q);
  }

  // --- The search box, with suggestions as you type ----------------------
  const shortAddr = (s) => String(s).split(",").slice(0, 3).join(",");
  function localSuggestions(q) {
    const t = q.trim();
    if (/^\d{5}$/.test(t)) return [{ type: "zip", label: t, sub: "Zip code · its block groups" }];
    if (t.length < 2 || /^\d/.test(t)) return [];
    const n = t.toLowerCase();
    const starts = places.filter((p) => p.name.toLowerCase().startsWith(n));
    const has = places.filter((p) => !p.name.toLowerCase().startsWith(n) && p.name.toLowerCase().includes(n));
    return starts.concat(has).slice(0, 6).map((p) => ({ type: "place", label: p.name, sub: p.sub, place: p }));
  }
  function classify(text) {
    const t = text.trim();
    const z = t.match(/^(\d{5})(-\d{4})?$/);
    if (z) return { type: "zip", label: z[1] };
    if (!/^https?:/i.test(t) && !/^\d/.test(t)) {
      const n = t.replace(/,.*$/, "").trim().toLowerCase();
      const hit = places.find((p) => p.name.toLowerCase() === n || p.raw.toLowerCase() === n);
      if (hit) return { type: "place", label: hit.name, place: hit };
    }
    return { type: "text", label: t };
  }
  function lookUp(it) {
    if (typeof it === "string") it = classify(it);
    if (!it.label) return;
    if (it.type === "zip") openPlace({ zip: it.label });
    else if (it.type === "place") openPlace(it.place);
    else if (it.type === "address") openHouse({ text: it.hit.matchedAddress, hit: it.hit });
    else openHouse({ text: it.label });
  }
  function attachSuggest(input, onPick, opts = {}) {
    const local = (q) => (opts.places === false ? [] : localSuggestions(q));
    const ul = document.createElement("ul");
    ul.className = "suggest";
    ul.hidden = true;
    ul.setAttribute("role", "listbox");
    input.parentElement.classList.add("has-suggest");
    input.parentElement.appendChild(ul);
    input.setAttribute("autocomplete", "off");
    let items = [], cur = -1, timer = null, seq = 0;
    const draw = () => {
      ul.hidden = !items.length;
      ul.innerHTML = items.map((it, i) => `<li role="option" data-i="${i}" aria-selected="${i === cur}"><b>${esc(it.label)}</b><span>${esc(it.sub)}</span></li>`).join("")
        // LocationIQ's free plan asks for a visible credit where its results show.
        + (geoProxy() && items.some((it) => it.type === "address") ? `<li class="credit" aria-hidden="true">Address search by <a href="https://locationiq.com" target="_blank" rel="noopener">LocationIQ</a></li>` : "");
      ul.querySelectorAll("li[data-i]").forEach((li) => (li.onmousedown = (e) => { e.preventDefault(); pick(items[+li.dataset.i]); }));
    };
    const pick = (it) => { items = []; draw(); input.value = it.label; onPick(it); };
    input.addEventListener("input", () => {
      const q = input.value.trim(), my = ++seq;
      items = local(q); cur = -1; draw();
      clearTimeout(timer);
      // Street addresses (a number and a word) also ask the address service.
      const wantAddresses = opts.anyText ? q.length >= 3 : (/\d/.test(q) && /[a-z]/i.test(q)) || (q.length >= 5 && !local(q).length);
      if (q.length >= 3 && wantAddresses && !/^https?:/i.test(q)) {
        timer = setTimeout(async () => {
          try {
            const hits = await suggestAddr(q);
            if (my !== seq) return;
            items = local(q).concat(hits.slice(0, 5).map((h) => ({ type: "address", label: shortAddr(h.matchedAddress), sub: "Address", hit: h })));
            draw();
          } catch (err) { log("search", "info", `Address suggestions unavailable (${err.message}).`); }
        }, C.SEARCH_DEBOUNCE_MS || 700);
      }
    });
    input.addEventListener("keydown", (e) => {
      if (ul.hidden) return;
      if (e.key === "ArrowDown") { cur = Math.min(items.length - 1, cur + 1); draw(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { cur = Math.max(-1, cur - 1); draw(); e.preventDefault(); }
      else if (e.key === "Enter" && cur >= 0) { e.preventDefault(); e.stopPropagation(); pick(items[cur]); }
      else if (e.key === "Escape") { items = []; draw(); }
    });
    input.addEventListener("blur", () => setTimeout(() => { items = []; draw(); }, 150));
  }

  // =======================================================================
  // Journey 1: house card
  // =======================================================================
  function addressFromLink(v) {
    const m = v.match(/redfin\.com\/[A-Z]{2}\/[^/]+\/([^/]+)\/home/i) || v.match(/zillow\.com\/homedetails\/([^/]+)\//i);
    return m ? decodeURIComponent(m[1]).replace(/-/g, " ").replace(/\s+\d+_zpid$/i, "") : v;
  }
  const normAddr = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  async function openHouse(src) {
    const from = src.listing ? "area" : view === "house" && house ? house.from : view;
    house = { loading: true, src, from, areaGeoid: sel || (area && area.geoid) };
    htab = 0;
    if (location.hash !== "#house") location.hash = "house"; else route();
    try {
      let lat, lon, text = null, details = null, listing = src.listing || null;
      if (listing) { lat = listing.lat; lon = listing.lon; text = [listing.address, listing.city].filter(Boolean).join(", "); }
      else if (src.latlng) { lat = src.latlng.lat; lon = src.latlng.lng; }
      else {
        text = addressFromLink(src.text.trim());
        const hits = src.hit ? [src.hit] : await geocodeText(text);
        if (!hits.length) throw new Error(`Couldn't find "${text}". Try the full street address with the city.`);
        lat = hits[0].coordinates.y; lon = hits[0].coordinates.x; details = hits[0].details; text = text || hits[0].matchedAddress;
        house.matched = hits[0].matchedAddress;
      }
      if (text) {
        const lot = await E().findLotForAddress(E().addressParts(text, details), lat, lon).catch((err) => { log("parcel", "warn", `Lot lookup failed: ${err.message}`); return null; });
        if (lot && lot.point) { lat = lot.point.lat; lon = lot.point.lon; house.lotMethod = lot.method; }
      }
      house.lat = lat; house.lon = lon;
      const [ctx, bg] = await Promise.all([
        E().lookupDevelopment(lat, lon),
        E().blockGroupAt(lat, lon).catch(() => null),
      ]);
      house.ctx = ctx;
      house.geoid = bg && bg.properties && bg.properties.GEOID ? String(bg.properties.GEOID) : null;
      if (bg && bg.geometry) addOutline(bg);
      if (house.geoid) { sel = house.geoid; house.areaGeoid = house.areaGeoid || house.geoid; if (view === "house") drawSel(); }
      const parcel = ctx.parcel && ctx.parcel.value;
      house.address = (listing && listing.address) || (parcel && parcel.address) || house.matched || text || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
      if (!listing && PERSONAL && D.listings.length) {
        const near = D.listings.map((l) => ({ l, d: miles(lat, lon, l.lat, l.lon) })).sort((a, b) => a.d - b.d)[0];
        if (near && near.d < 0.025) listing = near.l;
      }
      house.listing = listing;
      if (house.geoid) {
        const key = normAddr(parcel && parcel.address ? parcel.address : house.address).split(" ").slice(0, 3).join(" ");
        house.sale = key ? salesRows(house.geoid).find((s) => normAddr(s.address).startsWith(key)) || null : null;
      }
      house.hazards = await hazardsAt(lat, lon);
      house.loading = false;
      if (view === "house") { renderHouse(); drawHouseMap(); }
      await E().ready();
      house.build = await E().buildable(ctx).catch((err) => ({ unavailable: `Room to build failed: ${err.message}` }));
      if (view === "house") { renderHouse(); drawHouseMap(); }
    } catch (err) {
      house.loading = false; house.error = err.message;
      if (view === "house") renderHouse();
    }
  }
  const HGROUPS = [{ label: "This house", tabs: ["Summary", "Lot & building"] }, { label: "The neighbourhood", cls: "grow", tabs: ["People", "Money & work", "Safety & environment", "Schools", "Sales & prices", "Data"] }];
  function renderLookup() {
    const P = $("#panel");
    const recent = [
      place && place.geoids ? `<a href="#place">${esc(place.name)}</a>` : "",
      house && house.address ? `<a href="#house">${esc(house.address)}</a>` : "",
    ].filter(Boolean);
    P.innerHTML = `<div class="pad"><div class="qhead"><h2>Look up a place</h2><p>An address, a neighbourhood, a city or a zip code. Or click the map.</p></div>
      <form class="gate" id="houseForm" autocomplete="off"><div class="row"><input id="houseQ" type="text" aria-label="Address, neighbourhood or zip" placeholder="Address, neighbourhood or zip"><button class="btn" type="submit">Look it up</button></div></form>
      ${recent.length ? `<p class="note recent">Back to: ${recent.join(" · ")}</p>` : ""}</div>`;
    attachSuggest($("#houseQ"), lookUp);
    $("#houseForm").onsubmit = (e) => { e.preventDefault(); const v = $("#houseQ").value.trim(); if (v) lookUp(v); };
  }
  function renderHouse() {
    const P = $("#panel");
    if (!house) { renderLookup(); return; }
    const back = house.from === "place" && place ? `<a href="#place">← Back to ${esc(place.name)}</a>` : house.from === "find" ? `<a href="#find">← Back to the list</a>` : house.from === "area" && house.areaGeoid ? `<a href="#area-${house.areaGeoid}">← Back to the area</a>` : `<a href="#home">← New search</a>`;
    if (house.error) { P.innerHTML = `<div class="card-head"><div class="crumb">${back}</div></div><div class="pad"><div class="empty">${esc(house.error)}</div></div>`; return; }
    if (house.loading) { P.innerHTML = `<div class="card-head"><div class="crumb">${back}</div><h2>Looking it up…</h2><p>Lot, zoning, hazards and the neighbourhood.</p></div>`; return; }
    const ctx = house.ctx, parcel = ctx.parcel && ctx.parcel.value, zoning = ctx.zoning && ctx.zoning.value, jur = ctx.jurisdiction && ctx.jurisdiction.value;
    const l = house.listing;
    const m = house.geoid ? metrics(house.geoid) : null;
    P.innerHTML = `<div class="card-head"><div class="crumb">${back}</div><h2>${esc(house.address)}</h2><p>${l ? `For sale · ${fmtM(l.price)} · ` : ""}${zoning ? "Zone " + esc(zoning) : "Zone not found"}${jur ? " · " + esc(jur) : ""}${parcel && parcel.sqft ? " · lot " + parcel.sqft.toLocaleString() + " sq ft" : ""}</p></div><div class="tabs" id="hTabs">${tabsHTML(HGROUPS, htab)}</div><div class="tabpane" id="hPane"></div>`;
    $("#hTabs").querySelectorAll("button").forEach((b) => (b.onclick = () => { htab = +b.dataset.t; renderHouse(); }));
    const noArea = `<div class="empty">No Census data for this spot's block group.</div>`;
    const panes = [
      () => houseSummary(m),
      () => lotTab(),
      () => (m ? peopleTab(m) : noArea), () => (m ? moneyTab(m) : noArea), () => safetyTab(house.hazards), () => (m ? schoolsTab(m) : noArea),
      () => (house.geoid ? salesTab(house.geoid) : noArea), () => (house.geoid ? dataTab(house.geoid) : noArea),
    ];
    $("#hPane").innerHTML = panes[htab]();
    const r = $("#reserve");
    if (r) r.onclick = async () => { const key = house.address; reserved.add(key); await postLead("report_request", { email: S.email, address: house.address, geoid: house.geoid, price: 129 }); renderHouse(); };
    const ask = $("#askCommute");
    if (ask) ask.onclick = () => {
      $("#askSlot").innerHTML = `<form class="gate" id="askForm"><span class="lbl">Where do you work?</span><div class="row"><input id="askQ" type="text" aria-label="Work address" placeholder="Work address"><button class="btn" type="submit">Add</button></div><span class="err" id="askErr" hidden></span></form>`;
      $("#askQ").focus();
      $("#askForm").onsubmit = async (e) => { e.preventDefault(); const v = $("#askQ").value.trim(); if (!v) return; const res = await driveTime(v); if (res.error) { $("#askErr").textContent = res.error; $("#askErr").hidden = false; return; } houseCommute = res; renderHouse(); };
    };
  }
  async function driveTime(text) {
    try {
      const hits = await geocodeText(text);
      if (!hits.length) return { error: "Couldn't find that address." };
      const to = hits[0].coordinates;
      if (routing()) {
        const url = D.orsProxy
          ? `api/directions?${new URLSearchParams({ start: `${house.lon},${house.lat}`, end: `${to.x},${to.y}` })}`
          : `${C.ORS_DIRECTIONS}?${new URLSearchParams({ api_key: D.orsKey, start: `${house.lon},${house.lat}`, end: `${to.x},${to.y}` })}`;
        const data = await Utils.fetchJSON(url, { timeoutMs: 20000 });
        const sec = data.features && data.features[0] && data.features[0].properties.summary.duration;
        if (sec) return { label: text, min: Math.round(sec / 60), rush: Math.round((sec / 60) * RUSH_FACTOR), how: "OpenRouteService, free-flow; rush hour estimated" };
      }
      const mi = miles(house.lat, house.lon, to.y, to.x);
      return { label: text, min: Math.round((mi / FALLBACK_MPH) * 60), rush: Math.round((mi / FALLBACK_MPH) * 60 * RUSH_FACTOR), how: `straight-line estimate at ${FALLBACK_MPH} mph` };
    } catch (err) {
      return { error: `Couldn't work out the drive (${err.message}).` };
    }
  }
  function houseSummary(m) {
    const b = house.build, zoning = house.ctx.zoning && house.ctx.zoning.value;
    const lotTile = !b ? `<div class="sig na"><small>Lot & building</small><b>Working out room to build…</b></div>`
      : b.unavailable ? `<div class="sig neutral"><small>Lot & building</small><b>${zoning ? "Zone " + esc(zoning) : "Zone unknown"}</b><em>Room to build not available here yet</em></div>`
      : `<div class="sig ${b.largest && b.largest.sqft >= 400 ? "good" : "neutral"}"><small>Lot & building</small><b>${b.largest && b.largest.sqft >= 400 ? `Room for an ADU ~${b.largest.wFt}×${b.largest.hFt} ft` : "Little open ground for an ADU"}</b><em>${b.lotSqft ? `Buildings cover ${Math.round((b.builtSqft / b.lotSqft) * 100)}% of the lot` : ""}</em></div>`;
    let commute;
    if (houseCommute) commute = `<div class="sig good"><small>Drive to ${esc(houseCommute.label)}</small><b>~${houseCommute.min} min · ~${houseCommute.rush} at rush hour</b><em>${esc(houseCommute.how)}</em></div>`;
    else commute = `<button type="button" class="sig ask" id="askCommute"><small>Commute</small><b>+ Add your work address</b></button>`;
    const done = reserved.has(house.address);
    return `<div class="signals">${lotTile}${commute}${hazardTile(house.hazards)}${airTile(house.hazards)}${streetTile()}${m ? schoolTile(m) + peopleTile(m) + moneyTile(m) : ""}${house.geoid ? salesTile(house.geoid) : ""}</div><div id="askSlot"></div>${m ? autoSummary(m, house.hazards) : ""}
      <div class="fit"><h3>Is it right for you?</h3><p class="note">Answer 8 quick questions to see which areas fit you. <a href="#find">Start the questions</a></p></div>
      <div class="cta"><b>Full house report</b><p>Comparable sales, a fair price range with condition costs, red flags and questions to ask before you offer.</p>${done ? `<span class="done">You're on the list. We'll be in touch when reports open.</span>` : `<button class="btn" id="reserve" type="button">Get the report · $129 · free during the pilot</button>`}</div>`;
  }
  function lotTab() {
    const ctx = house.ctx, parcel = ctx.parcel && ctx.parcel.value, l = house.listing, s = house.sale, b = house.build;
    const zoning = ctx.zoning && ctx.zoning.value, jur = ctx.jurisdiction && ctx.jurisdiction.value, hist = ctx.historic && ctx.historic.value;
    const living = (l && l.sqft) || (s && s.sqft) || null;
    const lotSqft = (b && b.lotSqft) || (parcel && parcel.sqft) || (l && l.lotSqft) || null;
    const histIn = hist && !/^not /i.test(hist);
    const rule = b && b.rule;
    const env = rule && rule.zone.envelope;
    const out = [];
    out.push(`<div class="sec"><h3>The building</h3>${row("Living area", living ? num(living) + " sq ft" : "–", l && l.sqft ? "Listing" : s ? "Assessor roll (last sale)" : "Not on file")}${row("Year built", (l && l.yearBuilt) || (s && s.yearBuilt) || "–", l && l.yearBuilt ? "Listing" : "Assessor roll")}${row("Beds · baths", `${(l && l.beds) ?? (s && s.beds) ?? "–"} · ${(l && l.baths) ?? (s && s.baths) ?? "–"}`, l ? "Listing" : "Assessor roll")}${row("Lot size", lotSqft ? num(lotSqft) + " sq ft" : "–", parcel ? "Lot outline, county parcel map" : "Listing")}${row("Building footprint", b && b.builtSqft != null ? num(b.builtSqft) + " sq ft" : "–", b && b.buildingSource ? "County building outlines" : "Not loaded")}${row("Last recorded sale", s ? `${fmtDate(s.recorded)} · ${fmtM(s.assessed)}` : "–", "Assessor roll: assessed value at that sale")}${parcel && parcel.apn ? row("Assessor ID (AIN)", esc(parcel.apn), "LA County parcel map") : ""}</div>`);
    const flags = [];
    if (l && l.sqft && s && s.sqft && l.sqft - s.sqft > 100) flags.push(`<div class="flag"><b>The listing says ${num(l.sqft)} sq ft; the county record says ${num(s.sqft)}.</b> Ask whether the extra ${num(l.sqft - s.sqft)} sq ft was permitted.</div>`);
    out.push(`<div class="sec"><h3>Things to know about this house</h3>${flags.join("")}${row("Historic district", hist ? pill(histIn ? "watch" : "good", esc(hist)) : pill("na", "Couldn't check"), "City historic districts and LA City HPOZs", null, histIn ? "Changes visible from the street need design review, and some demolitions aren't allowed." : "Exterior changes don't need historic design review.")}${row("City rules that apply", jur ? esc(jur) : "–", "LA County city boundaries")}${row("Easements", pill("na", "Needs a title report"), null)}${row("Sewer line location", pill("na", "Needs a sewer map or scope"), null)}${row("Permit history", pill("na", "Planned"), null)}</div>`);
    // Room to build
    if (!b) out.push(`<div class="sec"><h3>Room to build</h3><p class="loading">Working out the setback envelope…</p></div>`);
    else if (b.unavailable) out.push(`<div class="sec"><h3>Room to build</h3><div class="empty">${esc(b.unavailable)}</div></div>`);
    else {
      const fits = b.largest && b.largest.sqft >= 400;
      const farAll = env && env.far && lotSqft ? E().farAllowance(env.far, lotSqft) : null;
      const sb9 = (rule.state || []).find((r) => /SB 9/i.test(r.topic));
      const aduState = (rule.state || []).find((r) => /ADU/i.test(r.topic));
      // The open spot is an upper bound. What you can likely build is the
      // smaller of: the spot, and (beyond the size state law guarantees) the
      // lot coverage still left. Easements, slope and utilities are unknown.
      const aduSet = rule.set.adu || { side: 4, rear: 4 };
      const guaranteed = Number(aduSet.guaranteedSqft) || 800;
      const covLeft = env && env.coverage && b.lotSqft ? Math.max(0, Math.round(env.coverage * b.lotSqft - b.builtSqft)) : null;
      const usable = fits ? Math.min(b.largest.sqft, Math.max(Math.min(guaranteed, b.largest.sqft), covLeft == null ? b.largest.sqft : covLeft)) : 0;
      const usableWhy = fits ? `State law guarantees an ADU up to ${num(guaranteed)} sq ft whatever the lot coverage. ${covLeft != null ? `Beyond that, this lot has about ${num(covLeft)} sq ft of coverage left (zone limit ${Math.round(env.coverage * 100)}%).` : ""} The open spot caps it at ${num(b.largest.sqft)} sq ft. Easements, slope, trees and sewer aren't known here.` : "";
      out.push(`<div class="sec"><h3>Room to build</h3>
        ${row("Largest open spot for a backyard ADU", fits ? `About ${b.largest.wFt} × ${b.largest.hFt} ft (${num(b.largest.sqft)} sq ft)` : "Little open ground", `Setbacks from ${esc(rule.set.code || "the city code")} · ADU limits ${vt(false)}`, null, `The green box on the map. It already leaves out every existing building, and keeps ${aduSet.side} ft from the side and ${aduSet.rear} ft from the rear lot lines. ${num(b.freeSqft)} sq ft of open ground meets those setbacks in all${b.streetUnknown ? "; the street side couldn't be told, so every edge uses the interior setback" : ""}.`)}
        ${fits ? row("ADU footprint you could likely build", `Up to about ${num(usable)} sq ft`, `State ADU law ${vt(false)}`, null, usableWhy) : ""}
        ${aduState ? row("ADU rules (state law)", "By right", `${esc(aduState.source || "")} ${vt(aduState.verified)}`, null, esc(aduState.value)) : ""}
        ${row("Junior ADU", "Up to 500 sq ft", `State ADU law ${vt(false)}`, null, "Inside the existing house, with its own entrance.")}
        ${sb9 ? row("SB 9", histIn ? pill("watch", "Not in a historic district") : "2 homes or a lot split", `${esc(sb9.source || "")} ${vt(sb9.verified)}`, null, esc(sb9.value)) : ""}
        ${farAll && living ? row("Bigger main house", `Up to ${num(Math.max(...farAll.map((f) => f.sqft)) - living)} sq ft more`, "Floor-area limit, " + esc(rule.set.code || ""), null, farAll.length > 1 ? `Depends on the lot's floor-area district: ${farAll.map((f) => `${f.label} ${num(f.sqft)} sq ft`).join(", ")}. ${esc(rule.set.farDistrictNote || "")}` : null) : ""}</div>`);
      const cov = b.lotSqft ? (b.builtSqft / b.lotSqft) * 100 : null;
      out.push(`<div class="sec"><h3>Zoning</h3>${row("Zone", esc(zoning || "–") + (rule ? " · " + esc(rule.zone.name || "") : ""), `${esc(jur || "")} zoning map`)}
        ${env && cov != null ? `<div class="meter"><small>Lot coverage: all buildings may cover up to ${Math.round(env.coverage * 100)}% of the lot</small><div class="m"><i style="width:${clamp((cov / (env.coverage * 100)) * 100, 0, 100)}%"></i></div><small>Now ${Math.round(cov)}% (${num(b.builtSqft)} of ${num(b.lotSqft)} sq ft) · about ${num(Math.max(0, env.coverage * b.lotSqft - b.builtSqft))} sq ft of footprint left</small></div>` : ""}
        ${farAll && living ? `<div class="meter"><small>Floor area: house size limit by floor-area district</small><div class="m"><i style="width:${clamp((living / Math.max(...farAll.map((f) => f.sqft))) * 100, 0, 100)}%"></i></div><small>Now ${num(living)} sq ft · cap ${farAll.map((f) => num(f.sqft)).join(" / ")} sq ft</small></div>` : ""}</div>`);
      out.push(`<div class="sec"><h3>Rules to follow when building</h3>${rule.zone.rules.map((r) => row(esc(r.topic), "", `${esc(r.section || rule.set.code || "")} ${vt(r.verified)}`, null, esc(r.value))).join("")}</div>`);
    }
    if (b && b.unavailable && zoning) out.push(`<div class="sec"><h3>Zoning</h3>${row("Zone", esc(zoning), `${esc(jur || "")} zoning map`, null, "Only Glendale's residential zone rules are transcribed so far, so the rules for this zone aren't shown.")}</div>`);
    return out.join("");
  }
  function drawHouseMap() {
    clearFocus();
    if (!house || house.loading || house.error) return;
    const parcel = house.ctx.parcel && house.ctx.parcel.value;
    if (parcel && parcel.feature) {
      const lay = L.geoJSON(parcel.feature, { interactive: false, style: { color: KEY.lot, weight: 3, fillColor: KEY.lot, fillOpacity: 0.06 } }).addTo(focusLayer);
      if (map.getZoom() < 17 || !map.getBounds().contains(lay.getBounds())) map.fitBounds(lay.getBounds(), { padding: [80, 80], maxZoom: 19 });
    } else if (map.getZoom() < 17) map.setView([house.lat, house.lon], 18);
    const b = house.build;
    if (b && !b.unavailable) {
      (b.buildings || []).forEach((f) => L.geoJSON(f, { interactive: false, style: { color: "#6b7a76", weight: 1, fillColor: "#6b7a76", fillOpacity: 0.45 } }).addTo(focusLayer));
      if (b.mainEnvelope) L.polygon(b.mainEnvelope.map(([x, y]) => [y, x]), { interactive: false, color: KEY.envelope, weight: 1.6, dashArray: "5 4", fill: false }).addTo(focusLayer);
      if (b.largest && b.largest.ring) L.polygon(b.largest.ring.map(([x, y]) => [y, x]), { interactive: false, color: KEY.adu, weight: 1.5, fillColor: KEY.adu, fillOpacity: 0.3 }).addTo(focusLayer);
    }
    L.circleMarker([house.lat, house.lon], { interactive: false, radius: 7, color: "#fff", weight: 2, fillColor: KEY.lot, fillOpacity: 1 }).addTo(pinLayer);
    drawSel();
    renderLayerPanel();
    updateHint();
    restack();
  }

  // =======================================================================
  // Leads (sign-ups, searches, report clicks, alerts)
  // =======================================================================
  async function postLead(kind, data) {
    const body = { kind, ...data };
    try {
      const res = await fetch(C.LEAD_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json().catch(() => ({}));
      return { ok: true, where: "server", emailed: !!(j && j.emailed) };
    } catch (err) {
      try {
        const list = JSON.parse(localStorage.getItem(LOCAL_LEADS_KEY) || "[]");
        list.push({ at: new Date().toISOString(), ...body });
        localStorage.setItem(LOCAL_LEADS_KEY, JSON.stringify(list.slice(-500)));
      } catch (e) { /* storage blocked */ }
      log("leads", "warn", `Sign-up server not reachable (${err.message}); saved in this browser only. Run python scripts/listing-server.py.`);
      return { ok: false, where: "device" };
    }
  }

  // =======================================================================
  // Routing and start-up
  // =======================================================================
  function route() {
    const h = (location.hash || "#home").slice(1);
    const m = h.match(/^area-(\d{12})$/);
    if (h === "questions") { S.wizard = true; step = 0; history.replaceState(null, "", "#find"); }
    view = m ? "area" : h === "questions" ? "find" : ["home", "find", "house", "place", "lookup"].includes(h) ? h : "home";
    if (m && (!area || area.geoid !== m[1])) { area = { geoid: m[1] }; atab = 0; areaDetails(m[1]).promise.then(() => { if (view === "area" && area.geoid === m[1]) { renderArea(); drawAreaMap(); } }); }
    $("#view-home").hidden = view !== "home";
    $("#workspace").hidden = view === "home";
    const nav = view === "area" ? "find" : view === "place" || view === "house" ? "lookup" : view;
    document.querySelectorAll(".nav a").forEach((a) => (a.dataset.v === nav ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
    if (view === "home") return;
    setTimeout(() => { map.invalidateSize(); onMove(); }, 0);
    if (view === "find") { clearFocus(); renderFind(); drawIsos(); drawSel(); }
    else isoLayer.clearLayers();
    if (view === "place") { clearFocus(); renderPlace(); drawPlaceMap(false); }
    renderOverlay();
    renderPreview();
    renderLayerPanel();
    updateHint();
    if (view === "home") closeFilter(); else renderFilterBar();
    if (view === "area") { if (D.census) { renderArea(); drawAreaMap(); } else $("#panel").innerHTML = `<div class="pad"><p class="loading">Loading…</p></div>`; }
    if (view === "house") { renderHouse(); drawHouseMap(); }
    if (view === "lookup") { clearFocus(); renderLookup(); }
  }
  function initStatus() {
    const list = $("#status-list"), btn = $("#status-btn");
    let warns = 0;
    const add = (e) => {
      const li = document.createElement("li");
      li.className = e.level;
      li.textContent = `${e.ts.toLocaleTimeString()} · ${e.layerKey}: ${e.message}`;
      list.appendChild(li);
      if (e.level === "warn" || e.level === "error") { warns++; btn.classList.add("has-warn"); btn.innerHTML = `<span class="lg">Data status</span><span class="sm">Data</span> (${warns})`; }
    };
    Utils.statusLog.forEach(add);
    Utils.onStatusChange(add);
    btn.onclick = () => { const p = $("#status-panel"); p.hidden = !p.hidden; btn.setAttribute("aria-expanded", String(!p.hidden)); };
    $("#status-close").onclick = () => { $("#status-panel").hidden = true; };
    $("#pilot-tag").textContent = PERSONAL ? "Pilot · your data" : "Pilot";
    log("mode", "info", PERSONAL ? "Personal mode: your GreatSchools ratings and Redfin exports are shown (this machine only)." : "Public mode: personal-use data (ratings, Redfin exports) is hidden.");
  }
  async function init() {
    initStatus();
    initMap();
    attachSuggest($("#home-q"), lookUp);
    document.addEventListener("mousedown", (e) => {
      if (openPill == null) return;
      if (e.target.closest("#filter-pop") || e.target.closest("#filterbar")) return;
      closeFilter();
    });
    $("#home-search").onsubmit = (e) => { e.preventDefault(); const v = $("#home-q").value.trim(); if (v) lookUp(v); else $("#home-q").focus(); };
    window.addEventListener("hashchange", route);
    route();
    loadPlaces();
    await loadConfig();
    const code = new URLSearchParams(location.search).get("r");
    const restored = code ? restoreAnswers(code) : false;
    if (restored && location.hash !== "#find") location.hash = "find";
    await loadAll();
    totalAreas = allMetrics().length;
    ready = true;
    if (restored) refreshCommutes();
    if (view === "find") { renderFind(); updateMatches(); }
    else route();
  }

  return {
    init,
    // For tests: the pieces a browser test checks without clicking through.
    forTest: { styleOf: (g) => outlineStyle(g), get place() { return place && { name: place.name, n: place.geoids ? place.geoids.size : null, error: place.error || null }; }, get places() { return places.length; }, get state() { return { S, D, view, area, house, step, ready, sel, PERSONAL, outlines: bgPolys.size, drawn: map.hasLayer(bgLayer) ? bgPolys.size : 0, shown: [...shownLayers], hazards: hazardLayer.getLayers().length, rasters: rasterLayer.getLayers().length }; }, get map() { return map; }, get noiseOrder() { const out = []; const walk = (l) => (l.getTileUrl ? out.push({ air: /aviation/i.test(l._url), z: l.options.zIndex }) : l.eachLayer && l.eachLayer(walk)); rasterLayer.eachLayer(walk); return out; }, metrics, passes, postLead, openArea, openHouse, densBand },
  };
})();

document.addEventListener("DOMContentLoaded", () => Brickline.init());
