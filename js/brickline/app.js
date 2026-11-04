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
    useMix: false, mix: [40, 42, 18], sE: 0, sM: 0, sH: 0, email: null, gateSeen: false, searchLogged: false,
  };
  const metricCache = new Map();
  const areaCache = new Map();
  let step = 0;
  const NQ = 8;
  let map, canvasRenderer, dotLayer, isoLayer, focusLayer, hazardLayer, pinLayer;
  const dots = new Map();
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

  async function loadOrsKey() {
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
    const key = `${c.lat.toFixed(4)},${c.lon.toFixed(4)},${eff},${D.orsKey ? "ors" : "line"}`;
    if (isoCache.has(key)) return isoCache.get(key);
    let result;
    if (D.orsKey) {
      try {
        const res = await fetch(C.ORS_ISOCHRONES, {
          method: "POST",
          headers: { Authorization: D.orsKey, "Content-Type": "application/json" },
          body: JSON.stringify({ locations: [[c.lon, c.lat]], range: [Math.min(3600, eff * 60)], range_type: "time" }),
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
    updateDots();
  }
  async function geocodeDestination(i) {
    const c = S.commutes[i];
    if (!c.text.trim()) { c.lat = c.lon = null; c.area = null; c.found = ""; renderQ(); refreshCommutes(); return; }
    c.found = "Finding…"; renderFound(i);
    try {
      const hits = await E().geocode(c.text.trim());
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
  // =======================================================================
  function initMap() {
    map = L.map("map", { preferCanvas: true, zoomControl: true, maxZoom: 19 }).setView(C.MAP_CENTER, 10);
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
    dotLayer = L.layerGroup().addTo(map);
    isoLayer = L.layerGroup().addTo(map);
    hazardLayer = L.layerGroup().addTo(map);
    focusLayer = L.layerGroup().addTo(map);
    pinLayer = L.layerGroup().addTo(map);
    map.on("click", (e) => {
      if (view === "area" || view === "house") openHouse({ latlng: e.latlng });
    });
  }
  function buildDots() {
    dotLayer.clearLayers(); dots.clear();
    allMetrics().forEach((m) => {
      const d = L.circleMarker([m.lat, m.lon], { renderer: canvasRenderer, radius: 2.5, weight: 0, fillOpacity: 0.35, fillColor: "#9fb0ab" });
      d.on("click", (e) => { L.DomEvent.stopPropagation(e); if (view === "find") openArea(m.geoid); });
      d.addTo(dotLayer);
      dots.set(m.geoid, d);
    });
  }
  let dotFrame = null;
  function updateDots() {
    if (dotFrame) cancelAnimationFrame(dotFrame);
    dotFrame = requestAnimationFrame(() => {
      const upTo = Math.min(step, 7);
      let n = 0;
      dots.forEach((d, geoid) => {
        const ok = passes(metrics(geoid), upTo);
        if (ok) n++;
        d.setStyle(ok ? { radius: 4, fillOpacity: 0.85, fillColor: "#0b6e66" } : { radius: 2.5, fillOpacity: 0.3, fillColor: "#9fb0ab" });
      });
      if (view === "find") renderCounter(n);
    });
  }
  function drawIsos() {
    isoLayer.clearLayers();
    if (view !== "find") return;
    S.commutes.forEach((c, k) => {
      if (!c.area) return;
      L.geoJSON(c.area.poly, { interactive: false, style: { color: "#2f5f9e", weight: 1.6, dashArray: "6 5", fillColor: "#2f5f9e", fillOpacity: 0.08 } }).addTo(isoLayer);
      L.circleMarker([c.lat, c.lon], { interactive: false, radius: 7, color: "#fff", weight: 2, fillColor: "#2f5f9e", fillOpacity: 1 }).bindTooltip(k ? `Commute ${k + 1}` : "Work", { permanent: true, direction: "right", className: "" }).addTo(isoLayer);
    });
  }
  function renderCounter(n) {
    const total = dots.size;
    const applied = appliedChips();
    $("#map-overlay").innerHTML = `<div class="count"><b>${n.toLocaleString()}</b><span>of ${total.toLocaleString()} areas match</span></div><div class="applied">${applied.map((a) => `<span>${esc(a)}</span>`).join("")}</div>`;
  }
  function appliedChips() {
    const a = [], u = Math.min(step, 7);
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
  function clearFocus() { focusLayer.clearLayers(); hazardLayer.clearLayers(); pinLayer.clearLayers(); $("#map-layers").hidden = true; $("#map-hint").hidden = true; }

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
    el.oninput = () => { set(+el.value); document.getElementById(id + "-o").textContent = fmt(+el.value); if (after) after(); updateDots(); };
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
  function renderFind() {
    const P = $("#panel");
    if (!D.census || !dots.size) {
      P.innerHTML = `<div class="pad"><div class="qhead"><h2>Loading LA County…</h2><p>Block group data and centres. If this stays, open Data status (top right).</p></div></div>`;
      return;
    }
    P.innerHTML = `<div class="steps" id="steps"></div><div class="pad" id="qpane"></div><div class="qfoot" id="qfoot"><button class="btn ghost" id="back" type="button">Back</button><span class="spacer"></span><button class="btn" id="next" type="button">Next</button><button class="btn ghost" id="skip" type="button">Skip</button></div>`;
    $("#back").onclick = () => { if (step > 0) { step--; renderQ(); } };
    $("#next").onclick = () => { step = step === NQ ? 0 : step + 1; renderQ(); };
    $("#skip").onclick = () => { step = Math.min(NQ, step + 1); renderQ(); };
    renderQ();
  }
  function renderQ() {
    const pane = $("#qpane");
    if (!pane) return;
    $("#steps").innerHTML = QUESTIONS.concat([["Results"]]).map((q, i) => `<button type="button" aria-label="${esc(q[0])}" class="${i < step ? "done" : i === step ? "cur" : ""}" data-s="${i}"></button>`).join("");
    $("#steps").querySelectorAll("button").forEach((b) => (b.onclick = () => { step = +b.dataset.s; renderQ(); }));
    const foot = $("#qfoot");
    if (step === NQ) {
      if (!S.gateSeen) { renderGate(pane); foot.hidden = true; } else { renderResults(pane); foot.hidden = false; $("#next").textContent = "Edit answers"; $("#skip").hidden = true; $("#back").disabled = false; }
      updateDots();
      return;
    }
    foot.hidden = false; $("#next").textContent = step === NQ - 1 ? "See results" : "Next"; $("#skip").hidden = false; $("#back").disabled = step === 0;
    const cty = D.county || {};
    let body = "";
    if (step === 0) {
      body = S.commutes.map((c, k) => `<div class="commute"><form class="row" data-geo="${k}"><input type="text" id="c-addr-${k}" placeholder="${k ? "Partner's work address" : "Work address"}" value="${esc(c.text)}" aria-label="Commute destination ${k + 1}"><button class="btn ghost" type="submit">Set</button>${k ? `<button class="x" type="button" data-rm="${k}" aria-label="Remove this commute">×</button>` : ""}</form><span class="found" id="c-found-${k}"></span>${rangeField("c-min-" + k, "Up to", 10, 90, 5, c.min, (v) => v + " min")}</div>`).join("") +
        (S.commutes.length < 3 ? `<button class="add" id="addC" type="button">+ Add another commute</button>` : "") +
        `<label class="toggle"><input type="checkbox" id="rush" ${S.rush ? "checked" : ""}> Rush-hour traffic (about ${RUSH_FACTOR}× free-flow time)</label><p class="note">${D.orsKey ? "Areas follow the road network (OpenRouteService, no live traffic; rush hour is an estimate)." : `No routing key, so areas are straight-line estimates at ${FALLBACK_MPH} mph.`}</p>`;
    }
    if (step === 1) {
      body = `<div class="sub">People around you</div><div class="opts">${DENS.map((b, i) => `<button type="button" class="opt" data-d="${i}" aria-pressed="${S.dens.has(i)}"><i style="background:${b.color}"></i><div><b>${b.label}</b><span>${b.sub}</span></div><span class="n">${b.num}</span></button>`).join("")}</div>` +
        `<div class="sub">Shops and cafés nearby <span class="soon">coming soon</span></div><p class="note">Needs OpenStreetMap places data, not loaded yet.</p>`;
    }
    if (step === 2) body = rangeField("det", "Detached houses on the block, at least", 0, 90, 5, S.detMin, (v) => (v ? `${v}%+ houses` : "Any mix")) + `<div class="ends"><span>More apartments</span><span>More houses</span></div>`;
    if (step === 3) body = rangeField("edu", "At least", 0, 80, 5, S.edu, (v) => (v ? v + "%" : "Any"), cty.edu, `LA County ≈ ${cty.edu}%`);
    if (step === 4) body = rangeField("inc", "At least", 0, 200000, 10000, S.inc, (v) => (v ? fmtK(v) : "Any"), cty.inc, `LA County ≈ ${fmtK(cty.inc)}`);
    if (step === 5) { const hf = (v) => (+v).toFixed(1) + " people"; body = rangeField("hhMin", "From", 1, 6, 0.1, S.hhMin, hf, cty.hh, `LA County ≈ ${cty.hh}`) + rangeField("hhMax", "To", 1, 6, 0.1, S.hhMax, hf); }
    if (step === 6) {
      body = `<label class="toggle"><input type="checkbox" id="useMix" ${S.useMix ? "checked" : ""}> Use age mix in my search</label>` +
        (S.useMix ? `<div class="mix"><div class="mixbar" aria-hidden="true">${S.mix.map((v, i) => `<i style="width:${v}%;background:${AGE_COL[i]}"></i>`).join("")}</div>${S.mix.map((v, i) => rangeField("mix" + i, `<span style="color:${AGE_COL[i]}">●</span> ${AGE_L[i]}`, 0, 100, 1, v, (x) => x + "%", cty.mix && cty.mix[i], cty.mix ? `County ≈ ${cty.mix[i]}%` : "")).join("")}<p class="note">The three always add up to 100%. Areas within about 12 points of your mix stay on the map.</p></div>` : `<p class="note">Off by default. Turn it on only if the age mix matters to you.</p>`);
    }
    if (step === 7) {
      body = ratingsAvailable()
        ? rangeField("sE", "Elementary", 0, 10, 1, S.sE, (v) => (v ? v + "/10" : "Any")) + rangeField("sM", "Middle", 0, 10, 1, S.sM, (v) => (v ? v + "/10" : "Any")) + rangeField("sH", "High", 0, 10, 1, S.sH, (v) => (v ? v + "/10" : "Any"))
        : `<div class="empty">School ratings aren't available in this version${PERSONAL ? " (no ratings file loaded)" : ""}. Skip this question; the house card still lists the nearest schools.</div>`;
    }
    pane.innerHTML = `<div class="qhead"><span class="qnum">Question ${step + 1} of ${NQ}</span><h2>${esc(QUESTIONS[step][0])}</h2><p>${esc(QUESTIONS[step][1])}</p></div>${body}`;

    if (step === 0) {
      S.commutes.forEach((c, k) => {
        renderFound(k);
        bindRange("c-min-" + k, (v) => v + " min", (v) => { c.min = v; }, () => debounceCommutes());
        document.getElementById(`c-addr-${k}`).oninput = (e) => { c.text = e.target.value.slice(0, 120); };
      });
      pane.querySelectorAll("form[data-geo]").forEach((f) => (f.onsubmit = (e) => { e.preventDefault(); geocodeDestination(+f.dataset.geo); }));
      pane.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { S.commutes.splice(+b.dataset.rm, 1); renderQ(); refreshCommutes(); }));
      const add = $("#addC"); if (add) add.onclick = () => { S.commutes.push({ text: "", min: 35 }); renderQ(); };
      $("#rush").onchange = (e) => { S.rush = e.target.checked; refreshCommutes(); };
    }
    if (step === 1) pane.querySelectorAll("[data-d]").forEach((b) => (b.onclick = () => { const i = +b.dataset.d; S.dens.has(i) ? S.dens.delete(i) : S.dens.add(i); b.setAttribute("aria-pressed", S.dens.has(i)); updateDots(); }));
    if (step === 2) bindRange("det", (v) => (v ? `${v}%+ houses` : "Any mix"), (v) => (S.detMin = v));
    if (step === 3) bindRange("edu", (v) => (v ? v + "%" : "Any"), (v) => (S.edu = v));
    if (step === 4) bindRange("inc", (v) => (v ? fmtK(v) : "Any"), (v) => (S.inc = v));
    if (step === 5) {
      const hf = (v) => (+v).toFixed(1) + " people";
      bindRange("hhMin", hf, (v) => { S.hhMin = v; if (S.hhMax < v) { S.hhMax = v; $("#hhMax").value = v; $("#hhMax-o").textContent = hf(v); } });
      bindRange("hhMax", hf, (v) => { S.hhMax = v; if (S.hhMin > v) { S.hhMin = v; $("#hhMin").value = v; $("#hhMin-o").textContent = hf(v); } });
    }
    if (step === 6) {
      $("#useMix").onchange = (e) => { S.useMix = e.target.checked; renderQ(); };
      if (S.useMix) [0, 1, 2].forEach((i) => { const el = document.getElementById("mix" + i); el.oninput = () => { setMix(i, +el.value); updateDots(); }; });
    }
    if (step === 7 && ratingsAvailable()) { bindRange("sE", (v) => (v ? v + "/10" : "Any"), (v) => (S.sE = v)); bindRange("sM", (v) => (v ? v + "/10" : "Any"), (v) => (S.sM = v)); bindRange("sH", (v) => (v ? v + "/10" : "Any"), (v) => (S.sH = v)); }
    updateDots();
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
  function renderGate(pane) {
    const n = allMetrics().filter((m) => passes(m, 7)).length;
    pane.innerHTML = `<div class="qhead"><span class="qnum">Almost there</span><h2>${n.toLocaleString()} areas fit what you asked for</h2><p>Where should we send your shortlist? We may also ask what you thought of the tool.</p></div>
      <form class="gate" id="gateForm" novalidate><label class="lbl" for="gEmail">Email</label><div class="row"><input id="gEmail" type="email" placeholder="you@example.com" autocomplete="email"><button class="btn" type="submit">Show my results</button></div><span class="err" id="gErr" hidden></span><p class="note">Used only to send your shortlist and ask for feedback. No spam.</p></form>
      <button type="button" class="linkbtn" id="gSkip" style="color:var(--muted)">Skip for now and show results</button>`;
    $("#gateForm").onsubmit = async (e) => {
      e.preventDefault();
      const v = $("#gEmail").value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) { $("#gErr").textContent = "That doesn't look like an email address."; $("#gErr").hidden = false; return; }
      const r = await postLead("lead", { email: v, journey: "neighbourhood", answers: answersSummary() });
      S.email = v; S.gateSeen = true; S.savedWhere = r.where; renderQ();
    };
    $("#gSkip").onclick = () => { S.gateSeen = true; renderQ(); };
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
  function renderResults(pane) {
    if (!S.searchLogged) { S.searchLogged = true; postLead("search", { email: S.email, journey: "neighbourhood", answers: answersSummary() }); }
    const keys = Object.keys(SORTS).filter((k) => (k !== "age" || S.useMix) && (k !== "school" || ratingsAvailable()) && (k !== "commute" || S.commutes.some((c) => c.lat != null)) && (k !== "sale" || PERSONAL));
    if (!keys.includes(SORT.k)) { SORT.k = keys[0]; SORT.dir = SORTS[SORT.k].d; }
    const M = SORTS[SORT.k];
    const hits = allMetrics().filter((m) => passes(m, 7)).map((m) => ({ m, v: M.v(m) })).sort((a, b) => {
      if (a.v == null) return 1; if (b.v == null) return -1;
      return SORT.dir === "asc" ? a.v - b.v : b.v - a.v;
    });
    const shown = hits.slice(0, 25);
    pane.innerHTML = `<div class="qhead"><span class="qnum">Results${S.email ? ` · ${S.savedWhere === "device" ? "saved on this device" : "we'll email " + esc(S.email)}` : ""}</span><h2>${hits.length.toLocaleString()} areas fit what you asked for</h2><p>Each is a Census block group (a few city blocks). Open one to see what it's like${PERSONAL ? " and the homes for sale in it" : ""}.</p></div>` +
      (hits.length ? `<div class="sortbar"><span class="note">Showing ${shown.length} of ${hits.length.toLocaleString()}</span><div class="ctl"><label for="sortK" class="note">Sort by</label><select id="sortK">${keys.map((k) => `<option value="${k}" ${k === SORT.k ? "selected" : ""}>${SORTS[k].l}</option>`).join("")}</select><button type="button" id="sortDir">${SORT.dir === "asc" ? "↑ Low to high" : "↓ High to low"}</button></div></div>
        <div class="results">${shown.map(({ m, v }) => resultCard(m, M.f(v))).join("")}</div>` : `<div class="empty">Nothing matches every answer. Try a longer commute, or loosen income or the other filters.</div>`);
    const sk = $("#sortK"); if (sk) sk.onchange = () => { SORT.k = sk.value; SORT.dir = SORTS[SORT.k].d; renderResults(pane); };
    const sd = $("#sortDir"); if (sd) sd.onclick = () => { SORT.dir = SORT.dir === "asc" ? "desc" : "asc"; renderResults(pane); };
    pane.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => openArea(b.dataset.open)));
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
    h.present = { fire: h.fire.cls === "bad" || h.fire.cls === "watch", flood: h.flood.cls === "bad" || h.flood.cls === "watch", seismic: h.liquefaction.cls === "watch" || h.landslide.cls === "watch" };
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
    det.promise = (async () => {
      const [bg, hz] = await Promise.all([
        E().blockGroupAt(m.lat, m.lon).catch((err) => { log("area", "warn", `Block group outline failed: ${err.message}`); return null; }),
        hazardsAt(m.lat, m.lon),
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
    return `<div class="sig ${worst}"><small>Natural hazards</small><b>Watch: ${flagged.map(([k, v]) => `${k} (${esc(v.text)})`).join(", ")}</b><em>${list.length - flagged.length - unknown.length} of ${list.length} checks clear</em></div>`;
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
  const peopleTile = (m) => `<div class="sig neutral"><small>People</small><b>${num(m.pop)} residents</b><em>${m.hh != null ? m.hh.toFixed(1) + " per home" : ""}${densBand(m.density) >= 0 ? " · " + DENS[densBand(m.density)].label.toLowerCase() : ""}</em></div>`;
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
    area = { geoid }; atab = 0;
    const det = areaDetails(geoid);
    shownLayers = new Set();
    if (location.hash !== `#area-${geoid}`) location.hash = `area-${geoid}`; else route();
    det.promise.then(() => {
      if (!area || area.geoid !== geoid) return;
      const h = det.hazards;
      shownLayers = new Set(Object.entries(h.present).filter(([, v]) => v).map(([k]) => k));
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
    P.innerHTML = `<div class="card-head"><div class="crumb"><a href="#find" id="toResults">← Back to results</a></div><h2>${esc(areaName(geoid))}</h2><p>${band >= 0 ? DENS[band].label + " · " : ""}${pct(m.det)} houses${PERSONAL ? ` · ${L.length} for sale` : ""}</p></div><div class="tabs" id="aTabs">${tabsHTML(ATABS, atab)}</div><div class="tabpane" id="aPane"></div>`;
    $("#toResults").onclick = () => { step = NQ; S.gateSeen = true; };
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
    if (det.outline) {
      const lay = L.geoJSON(det.outline, { interactive: false, style: { color: "#0b6e66", weight: 3, fillColor: "#0b6e66", fillOpacity: 0.08 } }).addTo(focusLayer);
      map.fitBounds(lay.getBounds(), { padding: [40, 40], maxZoom: 17 });
    } else if (m) map.setView([m.lat, m.lon], 16);
    if (PERSONAL) listingsIn(area.geoid).forEach((l) => {
      L.marker([l.lat, l.lon], { icon: L.divIcon({ className: "", html: `<span class="price-pin">${fmtM(l.price)}</span>`, iconSize: null }) })
        .on("click", (e) => { L.DomEvent.stopPropagation(e); openHouse({ listing: l }); }).addTo(pinLayer);
    });
    renderLayerPanel(det.hazards, det.outline ? L.geoJSON(det.outline).getBounds() : map.getBounds());
    $("#map-hint").textContent = PERSONAL ? "Red pins are for sale · click any lot to check it" : "Click any lot to check it";
    $("#map-hint").hidden = false;
  }

  // --- Hazard layers on the map ------------------------------------------
  const LAYERS = [
    { k: "fire", label: "Fire", color: "#d7301f", from: (h) => h.fire },
    { k: "flood", label: "Flood", color: "#2b7bd0", from: (h) => h.flood },
    { k: "seismic", label: "Landslide & liquefaction", color: "#a16207", from: (h) => (h.landslide.cls === "watch" ? h.landslide : h.liquefaction) },
  ];
  const shapeCache = new Map();
  function renderLayerPanel(h, bounds) {
    const box = $("#map-layers");
    box.hidden = false;
    box.innerHTML = `<h3>Show on map</h3>` + LAYERS.map((l) => { const v = h ? l.from(h) : null; return `<button type="button" class="layer" data-l="${l.k}" aria-pressed="${shownLayers.has(l.k)}"><i style="background:${l.color}"></i><b>${l.label}</b><span style="color:var(--${v && v.cls !== "na" ? (v.cls === "good" ? "good" : v.cls) : "muted"})">${v ? (v.cls === "good" ? "None here" : esc(v.text)) : "…"}</span></button>`; }).join("");
    box.querySelectorAll("[data-l]").forEach((b) => (b.onclick = () => { const k = b.dataset.l; shownLayers.has(k) ? shownLayers.delete(k) : shownLayers.add(k); renderLayerPanel(h, bounds); drawHazards(bounds); }));
    drawHazards(bounds);
  }
  async function drawHazards(bounds) {
    hazardLayer.clearLayers();
    const pad = 0.01;
    const bbox = { xmin: bounds.getWest() - pad, ymin: bounds.getSouth() - pad, xmax: bounds.getEast() + pad, ymax: bounds.getNorth() + pad };
    for (const k of shownLayers) {
      const key = `${k}|${bbox.xmin.toFixed(3)},${bbox.ymin.toFixed(3)}`;
      try {
        if (!shapeCache.has(key)) shapeCache.set(key, E().hazardShapes(k, bbox));
        const gj = await shapeCache.get(key);
        if (!shownLayers.has(k)) continue;
        L.geoJSON(gj, {
          interactive: false,
          style: (f) => {
            const p = f.properties || {};
            const color = k === "fire" ? (C.FIRE_CLASS_COLORS[E().fireClass(p)] || "#fc8d59") : k === "flood" ? ((E().floodClass(p) || {}).color || "#93c5fd") : (C.SEISMIC_COLORS[p.__hazard] || "#a16207");
            return { color, weight: 0.6, fillColor: color, fillOpacity: k === "flood" && /minimal/i.test((E().floodClass(p) || {}).label || "") ? 0 : 0.3 };
          },
        }).addTo(hazardLayer);
      } catch (err) {
        shapeCache.delete(key);
        log(k, "warn", `${k} shapes failed: ${err.message}`);
      }
    }
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
    house = { loading: true, src, from: view === "area" || src.listing ? "area" : "home", areaGeoid: area && area.geoid };
    htab = 0;
    if (location.hash !== "#house") location.hash = "house"; else route();
    try {
      let lat, lon, text = null, details = null, listing = src.listing || null;
      if (listing) { lat = listing.lat; lon = listing.lon; text = [listing.address, listing.city].filter(Boolean).join(", "); }
      else if (src.latlng) { lat = src.latlng.lat; lon = src.latlng.lng; }
      else {
        text = addressFromLink(src.text.trim());
        const hits = await E().geocode(text);
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
  function renderHouse() {
    const P = $("#panel");
    if (!house) {
      P.innerHTML = `<div class="pad"><div class="qhead"><h2>Check a house</h2><p>Paste an address or a Redfin / Zillow link, or click any lot on the map.</p></div><form class="gate" id="houseForm" autocomplete="off"><div class="row"><input id="houseQ" type="text" aria-label="Address or listing link" placeholder="Address or listing link"><button class="btn" type="submit">Check it</button></div></form></div>`;
      $("#houseForm").onsubmit = (e) => { e.preventDefault(); const v = $("#houseQ").value.trim(); if (v) openHouse({ text: v }); };
      return;
    }
    const back = house.from === "area" && house.areaGeoid ? `<a href="#area-${house.areaGeoid}">← Back to the area</a>` : `<a href="#home">← New search</a>`;
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
      const hits = await E().geocode(text);
      if (!hits.length) return { error: "Couldn't find that address." };
      const to = hits[0].coordinates;
      if (D.orsKey) {
        const url = `${C.ORS_DIRECTIONS}?${new URLSearchParams({ api_key: D.orsKey, start: `${house.lon},${house.lat}`, end: `${to.x},${to.y}` })}`;
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
      out.push(`<div class="sec"><h3>Room to build</h3>
        ${row("Backyard ADU", pill(fits ? "good" : "watch", fits ? `Open ground about ${b.largest.wFt} × ${b.largest.hFt} ft` : "Little open ground"), `Setbacks from ${esc(rule.set.code || "the city code")} · ADU limits ${vt(false)}`, null, `Shown in green on the map. ${num(b.freeSqft)} sq ft of open ground meets the ADU setbacks${b.streetUnknown ? "; the street side couldn't be told, so all edges use the interior setback" : ""}.`)}
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
      const lay = L.geoJSON(parcel.feature, { interactive: false, style: { color: "#0b6e66", weight: 3, fillColor: "#0b6e66", fillOpacity: 0.06 } }).addTo(focusLayer);
      map.fitBounds(lay.getBounds(), { padding: [80, 80], maxZoom: 20 });
    } else map.setView([house.lat, house.lon], 18);
    const b = house.build;
    if (b && !b.unavailable) {
      (b.buildings || []).forEach((f) => L.geoJSON(f, { interactive: false, style: { color: "#6b7a76", weight: 1, fillColor: "#6b7a76", fillOpacity: 0.45 } }).addTo(focusLayer));
      if (b.mainEnvelope) L.polygon(b.mainEnvelope.map(([x, y]) => [y, x]), { interactive: false, color: "#2f5f9e", weight: 1.5, dashArray: "5 4", fill: false }).addTo(focusLayer);
      if (b.largest && b.largest.ring) L.polygon(b.largest.ring.map(([x, y]) => [y, x]), { interactive: false, color: "#1f8a4c", weight: 1.5, fillColor: "#1f8a4c", fillOpacity: 0.3 }).bindTooltip(`ADU space ~${b.largest.wFt}×${b.largest.hFt} ft`, { permanent: true, direction: "center" }).addTo(focusLayer);
    }
    L.circleMarker([house.lat, house.lon], { interactive: false, radius: 7, color: "#fff", weight: 2, fillColor: "#0b6e66", fillOpacity: 1 }).addTo(pinLayer);
    renderLayerPanel(house.hazards, map.getBounds());
    $("#map-hint").textContent = "Click another lot to check it";
    $("#map-hint").hidden = false;
  }

  // =======================================================================
  // Leads (sign-ups, searches, report clicks, alerts)
  // =======================================================================
  async function postLead(kind, data) {
    const body = { kind, ...data };
    try {
      const res = await fetch(C.LEAD_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ok: true, where: "server" };
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
    view = m ? "area" : ["home", "find", "house"].includes(h) ? h : "home";
    if (m && (!area || area.geoid !== m[1])) { area = { geoid: m[1] }; atab = 0; areaDetails(m[1]).promise.then(() => { if (view === "area" && area.geoid === m[1]) { const hz = areaDetails(m[1]).hazards; shownLayers = new Set(Object.entries(hz.present).filter(([, v]) => v).map(([k]) => k)); renderArea(); drawAreaMap(); } }); }
    $("#view-home").hidden = view !== "home";
    $("#workspace").hidden = view === "home";
    const nav = view === "area" ? "find" : view;
    document.querySelectorAll(".nav a").forEach((a) => (a.dataset.v === nav ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
    if (view === "home") return;
    setTimeout(() => map.invalidateSize(), 0);
    dotLayer.eachLayer((d) => d.setStyle({ opacity: view === "find" ? 1 : 0 }));
    if (view === "find") { clearFocus(); $("#map-overlay").hidden = false; renderFind(); drawIsos(); if (map.getZoom() > 13) map.setView(C.MAP_CENTER, 10); }
    else { $("#map-overlay").hidden = true; isoLayer.clearLayers(); }
    if (view === "area") { if (D.census) { renderArea(); drawAreaMap(); } else $("#panel").innerHTML = `<div class="pad"><p class="loading">Loading…</p></div>`; }
    if (view === "house") { renderHouse(); drawHouseMap(); }
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
    $("#home-search").onsubmit = (e) => { e.preventDefault(); const v = $("#home-q").value.trim(); if (v) openHouse({ text: v }); else $("#home-q").focus(); };
    window.addEventListener("hashchange", route);
    route();
    await loadAll();
    buildDots();
    if (view === "find") { renderFind(); updateDots(); }
    else route();
  }

  return {
    init,
    // For tests: the pieces a browser test checks without clicking through.
    forTest: { get state() { return { S, D, view, area, house, step, dots: dots.size, PERSONAL }; }, metrics, passes, postLead, openArea, openHouse, densBand },
  };
})();

document.addEventListener("DOMContentLoaded", () => Brickline.init());
