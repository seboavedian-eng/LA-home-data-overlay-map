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

  // Look up an ArcGIS MapServer's child layer id by matching part of its
  // name (case-insensitive). Falls back to a provided default id if
  // discovery fails, so a wrong hard-coded guess never fully blocks a layer.
  async function discoverLayerId(serverUrl, nameHint, fallbackId) {
    try {
      const root = await fetchJSON(`${serverUrl}?f=json`);
      const layers = root.layers || [];
      const match = layers.find((l) =>
        (l.name || "").toLowerCase().includes(nameHint.toLowerCase())
      );
      if (match) return match.id;
      Utils.logStatus(
        "discover",
        "warn",
        `No layer at ${serverUrl} matched "${nameHint}"; using fallback id ${fallbackId}.`
      );
      return fallbackId;
    } catch (err) {
      Utils.logStatus(
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
  function arcgisQueryUrl(serverUrl, layerId, { bbox, where, outFields = "*", extraParams = {} }) {
    const params = new URLSearchParams({
      f: "geojson",
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

  return {
    fetchJSON,
    discoverLayerId,
    arcgisQueryUrl,
    bboxToEnvelopeParam,
    pickField,
    fmtNumber,
    fmtCurrency,
    fmtPercent,
    logStatus,
    onStatusChange,
    get statusLog() {
      return statusLog;
    },
  };
})();
