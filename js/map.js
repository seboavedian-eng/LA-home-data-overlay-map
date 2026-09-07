// ---------------------------------------------------------------------------
// Map bootstrap + a small layer registry that drives the sidebar toggle list.
// Each layer module (js/layers/*.js) calls App.registerLayer(...) with a
// loader function; the actual network fetch only happens the first time a
// layer is switched on, and failures are caught per-layer so one bad
// endpoint never breaks the rest of the map.
// ---------------------------------------------------------------------------

const App = (() => {
  let map;
  const registry = []; // { key, label, desc, note, defaultOn, loader, leafletLayer, loaded, loading }

  function initMap() {
    map = L.map("map", { zoomControl: true }).setView(CONFIG.MAP_CENTER, CONFIG.MAP_ZOOM);
    L.tileLayer(CONFIG.BASEMAP_URL, {
      maxZoom: 19,
      attribution: CONFIG.BASEMAP_ATTRIBUTION,
    }).addTo(map);
    return map;
  }

  function registerLayer(def) {
    registry.push({ loaded: false, loading: false, leafletLayer: null, ...def });
  }

  function getLayer(key) {
    return registry.find((l) => l.key === key);
  }

  async function enableLayer(entry, checkboxEl) {
    if (entry.loading) return;
    if (!entry.loaded) {
      entry.loading = true;
      checkboxEl.disabled = true;
      Utils.logStatus(entry.key, "info", `Loading ${entry.label}...`);
      try {
        entry.leafletLayer = await entry.loader(map);
        entry.loaded = true;
        Utils.logStatus(entry.key, "ok", `${entry.label} loaded.`);
      } catch (err) {
        Utils.logStatus(entry.key, "error", `${entry.label} failed to load: ${err.message}`);
        checkboxEl.checked = false;
        checkboxEl.disabled = false;
        entry.loading = false;
        return;
      }
      entry.loading = false;
      checkboxEl.disabled = false;
    }
    if (entry.leafletLayer) entry.leafletLayer.addTo(map);
    renderLegend();
  }

  function disableLayer(entry) {
    if (entry.leafletLayer && map.hasLayer(entry.leafletLayer)) {
      map.removeLayer(entry.leafletLayer);
    }
    renderLegend();
  }

  function renderLayerList() {
    const ul = document.getElementById("layer-toggle-list");
    ul.innerHTML = "";
    registry.forEach((entry) => {
      const li = document.createElement("li");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!entry.defaultOn;
      cb.id = `layer-${entry.key}`;

      const label = document.createElement("label");
      label.className = "layer-label";
      label.htmlFor = cb.id;
      label.innerHTML = `<span>${entry.label}</span><span class="layer-desc">${entry.desc || ""}</span>${
        entry.note ? `<span class="layer-note">${entry.note}</span>` : ""
      }`;

      cb.addEventListener("change", () => {
        if (cb.checked) enableLayer(entry, cb);
        else disableLayer(entry);
      });

      li.appendChild(cb);
      li.appendChild(label);
      ul.appendChild(li);

      if (entry.defaultOn) enableLayer(entry, cb);
    });
  }

  function renderLegend() {
    const box = document.getElementById("legend");
    box.innerHTML = "";
    registry.forEach((entry) => {
      if (entry.leafletLayer && map.hasLayer(entry.leafletLayer) && entry.legend) {
        const block = document.createElement("div");
        block.className = "legend-block";
        block.innerHTML = `<div class="legend-title">${entry.label}</div>` + entry.legend;
        box.appendChild(block);
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
      const time = entry.ts.toLocaleTimeString();
      li.textContent = `${time} - ${entry.message}`;
      list.appendChild(li);
      list.scrollTop = list.scrollHeight;
    });
  }

  return {
    initMap,
    registerLayer,
    getLayer,
    get registry() {
      return registry;
    },
    get map() {
      return map;
    },
    renderLayerList,
    renderLegend,
    initStatusPanel,
  };
})();
