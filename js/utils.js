// ---------------------------------------------------------------------------
// Shared helpers: fetch wrappers, ArcGIS layer discovery, formatting, status
// reporting. Every network call in this app goes through fetchJSON so
// failures show up in the on-page status log instead of dying silently.
// ---------------------------------------------------------------------------

const Utils = (() => {
  const statusLog = [];
  const listeners = [];

  function onStatusChange(fn) {
    listeners.push(fn);
  }

  function logStatus(layerKey, level, message) {
    const entry = { layerKey, level, message, ts: new Date() };
    statusLog.push(entry);
    listeners.forEach((fn) => fn(entry));
    const tag = level === "error" ? "ERROR" : level === "warn" ? "WARN" : "OK";
    console.log(`[${tag}] ${layerKey}: ${message}`);
    return entry;
  }

  async function fetchJSON(url, { timeoutMs = 20000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const data = await res.json();
      if (data && data.error) {
        throw new Error(
          typeof data.error === "string" ? data.error : JSON.stringify(data.error)
        );
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  // Some government JSON APIs (api.census.gov is the known offender - see
  // README) never send Access-Control-Allow-Origin, so a direct browser
  // fetch fails with a generic "Failed to fetch" before any HTTP status is
  // even visible. When that happens, retry through public CORS proxies
  // (CONFIG.CORS_PROXIES) that fetch the URL server-side and re-serve it
  // with permissive CORS headers. Only used as a fallback, and only for
  // plain JSON APIs - every ArcGIS REST endpoint in this app supports CORS
  // directly and never needs this path.
  async function fetchJSONWithCorsFallback(url, opts, layerKeyForLog = "fetch") {
    try {
      return await fetchJSON(url, opts);
    } catch (directErr) {
      const proxies = (typeof CONFIG !== "undefined" && CONFIG.CORS_PROXIES) || [];
      for (let i = 0; i < proxies.length; i++) {
        try {
          logStatus(
            layerKeyForLog,
            "warn",
            `Direct request blocked (${directErr.message}); retrying via CORS proxy ${i + 1}/${proxies.length}.`
          );
          return await fetchJSON(proxies[i](url), opts);
        } catch (proxyErr) {
          if (i === proxies.length - 1) throw proxyErr;
        }
      }
      throw directErr;
    }
  }

  // Look up an ArcGIS MapServer's child layer id by name. Falls back to a
  // provided default id if discovery fails, so a wrong hard-coded guess
  // never fully blocks a layer.
  //
  // Matching order matters: a plain substring search is dangerously loose on
  // services like TIGERweb, which carries "Tribal Census Tracts" alongside
  // "Census Tracts" and "... Labels" variants alongside the real polygon
  // layers. Substring-matching "Census Tract" there silently selects the
  // tribal layer, which queries fine and returns zero features - so prefer
  // an exact name, then a substring match that skips excluded names.
  //
  //   options.exactNames - exact layer names to prefer, in order
  //   options.exclude    - RegExp of layer names to never match
  async function discoverLayerId(serverUrl, nameHint, fallbackId, options = {}) {
    const { exactNames = [], exclude = null } = options;
    try {
      const root = await fetchJSON(`${serverUrl}?f=json`);
      const layers = root.layers || [];
      const allowed = layers.filter((l) => !(exclude && exclude.test(l.name || "")));

      for (const wanted of exactNames) {
        const hit = allowed.find((l) => (l.name || "").toLowerCase() === wanted.toLowerCase());
        if (hit) {
          logStatus("discover", "info", `Matched layer "${hit.name}" (id ${hit.id}) for "${nameHint}".`);
          return hit.id;
        }
      }

      const match = allowed.find((l) => (l.name || "").toLowerCase().includes(nameHint.toLowerCase()));
      if (match) {
        logStatus("discover", "info", `Matched layer "${match.name}" (id ${match.id}) for "${nameHint}".`);
        return match.id;
      }

      logStatus(
        "discover",
        "warn",
        `No layer at ${serverUrl} matched "${nameHint}"; using fallback id ${fallbackId}.`
      );
      return fallbackId;
    } catch (err) {
      logStatus(
        "discover",
        "warn",
        `Could not read ${serverUrl}: ${err.message}. Using fallback id ${fallbackId}.`
      );
      return fallbackId;
    }
  }

  function bboxToEnvelopeParam(bbox) {
    return `${bbox.xmin},${bbox.ymin},${bbox.xmax},${bbox.ymax}`;
  }

  // Build an ArcGIS REST query URL against a bounding-box envelope.
  //
  // Deliberately requests f=json (native Esri JSON), NOT f=geojson: the
  // geojson output format is an opt-in per-service setting that a lot of
  // older government ArcGIS Server instances (Census TIGERweb, county DPW
  // servers, etc.) never turned on, and even where it is on, older
  // versions have known bugs converting multi-ring/donut-hole polygons
  // (self-intersecting rings that render as stray lines). f=json is
  // universally supported, so we convert it to GeoJSON ourselves - see
  // esriFeatureSetToGeoJSON()/fetchEsriAsGeoJSON() below.
  function arcgisQueryUrl(serverUrl, layerId, { bbox, where, outFields = "*", extraParams = {} }) {
    const params = new URLSearchParams({
      f: "json",
      outFields,
      returnGeometry: "true",
      outSR: "4326",
      ...extraParams,
    });
    if (bbox) {
      params.set("geometry", bboxToEnvelopeParam(bbox));
      params.set("geometryType", "esriGeometryEnvelope");
      params.set("inSR", "4326");
      params.set("spatialRel", "esriSpatialRelIntersects");
    }
    params.set("where", where || "1=1");
    const base = layerId === undefined || layerId === null ? serverUrl : `${serverUrl}/${layerId}`;
    return `${base}/query?${params.toString()}`;
  }

  // --- Esri JSON -> GeoJSON conversion --------------------------------
  // Minimal, dependency-free port of the standard algorithm (as used by
  // Esri's own arcgis-to-geojson-utils): group rings into outer
  // rings + holes by winding direction, then match each hole to the
  // outer ring that contains it. This is what a well-formed converter
  // needs to do to avoid the twisted/self-intersecting polygons that a
  // naive "just relabel the fields" conversion produces.

  function ringIsClockwise(ring) {
    let total = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      total += (x2 - x1) * (y2 + y1);
    }
    return total >= 0;
  }

  function closeRing(ring) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (!first || !last) return ring;
    return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
  }

  function pointInRing(point, ring) {
    const [x, y] = point;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function ringsToGeoJSONGeometry(rawRings) {
    const outerRings = [];
    const holes = [];
    rawRings.forEach((r) => {
      const ring = closeRing(r);
      if (ring.length < 4) return;
      if (ringIsClockwise(ring)) {
        outerRings.push({ ring, holes: [] });
      } else {
        holes.push(ring);
      }
    });
    // Malformed/unusual winding (seen on some legacy servers) - treat every
    // ring as its own outer boundary rather than dropping the geometry.
    if (outerRings.length === 0) {
      rawRings.forEach((r) => outerRings.push({ ring: closeRing(r), holes: [] }));
    } else {
      holes.forEach((hole) => {
        for (let i = outerRings.length - 1; i >= 0; i--) {
          if (pointInRing(hole[0], outerRings[i].ring)) {
            outerRings[i].holes.push(hole);
            return;
          }
        }
        // Didn't fit inside any known outer ring - keep it as its own
        // polygon rather than silently dropping data.
        outerRings.push({ ring: hole, holes: [] });
      });
    }
    const polygons = outerRings.map((o) => [o.ring, ...o.holes]);
    return polygons.length === 1
      ? { type: "Polygon", coordinates: polygons[0] }
      : { type: "MultiPolygon", coordinates: polygons };
  }

  function esriGeometryToGeoJSON(geom, geometryType) {
    if (!geom) return null;
    const type = geometryType || (geom.rings ? "esriGeometryPolygon" : geom.paths ? "esriGeometryPolyline" : geom.x !== undefined ? "esriGeometryPoint" : geom.points ? "esriGeometryMultipoint" : null);
    switch (type) {
      case "esriGeometryPoint":
        return geom.x === undefined || geom.x === null ? null : { type: "Point", coordinates: [geom.x, geom.y] };
      case "esriGeometryMultipoint":
        return { type: "MultiPoint", coordinates: geom.points };
      case "esriGeometryPolyline":
        return (geom.paths || []).length === 1
          ? { type: "LineString", coordinates: geom.paths[0] }
          : { type: "MultiLineString", coordinates: geom.paths };
      case "esriGeometryPolygon":
        return ringsToGeoJSONGeometry(geom.rings || []);
      default:
        return null;
    }
  }

  function esriFeatureSetToGeoJSON(featureSet) {
    const geometryType = featureSet.geometryType;
    const features = (featureSet.features || [])
      .map((f) => {
        const geometry = esriGeometryToGeoJSON(f.geometry, geometryType);
        if (!geometry) return null;
        return { type: "Feature", properties: { ...f.attributes }, geometry };
      })
      .filter(Boolean);
    return { type: "FeatureCollection", features };
  }

  // Fetch an ArcGIS REST query URL (built with f=json) and convert the
  // response to a GeoJSON FeatureCollection.
  async function fetchEsriAsGeoJSON(url, opts) {
    const data = await fetchJSON(url, opts);

    // ArcGIS reports its own errors with HTTP 200 and an {error:{...}} body,
    // so a failed query looks like a success to fetch(). Without this, every
    // such failure surfaced as the generic "no features array" and the real
    // reason - an unsupported parameter, a group layer that cannot be
    // queried, a token requirement - was thrown away.
    if (data && data.error) {
      const e = data.error;
      const details = Array.isArray(e.details) && e.details.length ? ` (${e.details.join("; ")})` : "";
      throw new Error(`ArcGIS error ${e.code || "?"}: ${e.message || "unknown"}${details}`);
    }
    if (!Array.isArray(data.features)) {
      throw new Error("Unexpected ArcGIS response: no features array");
    }

    const gj = esriFeatureSetToGeoJSON(data);
    // Servers cap how many records one query may return. When that cap is
    // hit the response is a valid, silently INCOMPLETE answer - which on a
    // map looks like a layer with holes in it rather than an error. Carry
    // the flag through so callers can do something about it.
    gj.exceededTransferLimit = !!(data.exceededTransferLimit || data.properties?.exceededTransferLimit);
    return gj;
  }

  // Case/substring-tolerant field reader: government schemas vary in exact
  // casing/naming release to release, so read by "contains" rather than an
  // exact key match wherever we can't be 100% sure of the field name.
  function pickField(attrs, substrings) {
    if (!attrs) return undefined;
    const keys = Object.keys(attrs);
    for (const needle of substrings) {
      const key = keys.find((k) => k.toLowerCase() === needle.toLowerCase());
      if (key && attrs[key] !== null && attrs[key] !== "") return attrs[key];
    }
    for (const needle of substrings) {
      const key = keys.find((k) => k.toLowerCase().includes(needle.toLowerCase()));
      if (key && attrs[key] !== null && attrs[key] !== "") return attrs[key];
    }
    return undefined;
  }

  function fmtNumber(n) {
    if (n === undefined || n === null || n === "" || Number(n) < 0) return "n/a";
    return Number(n).toLocaleString("en-US");
  }

  function fmtCurrency(n) {
    if (n === undefined || n === null || n === "" || Number(n) < 0) return "n/a";
    return Number(n).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  }

  function fmtPercent(part, whole) {
    const p = Number(part);
    const w = Number(whole);
    if (!w || w <= 0 || p < 0 || isNaN(p) || isNaN(w)) return "n/a";
    return `${((p / w) * 100).toFixed(1)}%`;
  }

  function greatSchoolsSearchUrl(schoolName) {
    const q = `${schoolName} greatschools rating`;
    return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  }

  return {
    fetchJSON,
    fetchJSONWithCorsFallback,
    fetchEsriAsGeoJSON,
    esriFeatureSetToGeoJSON,
    discoverLayerId,
    arcgisQueryUrl,
    bboxToEnvelopeParam,
    pointInRing,
    pickField,
    fmtNumber,
    fmtCurrency,
    fmtPercent,
    greatSchoolsSearchUrl,
    logStatus,
    onStatusChange,
    get statusLog() {
      return statusLog;
    },
  };
})();
