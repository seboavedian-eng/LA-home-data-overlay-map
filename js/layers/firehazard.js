// Fire Hazard - CAL FIRE Fire Hazard Severity Zones (SRA + LRA).
(() => {
  const CLASS_COLORS = {
    moderate: "#ffeda0",
    high: "#feb24c",
    "very high": "#f03b20",
  };
  const DEFAULT_COLOR = "#cccccc";

  function normalizeClass(raw) {
    if (raw === undefined || raw === null) return null;
    const s = String(raw).toLowerCase();
    if (s.includes("very high") || s === "3") return "very high";
    if (s.includes("high") || s === "2") return "high";
    if (s.includes("moderate") || s === "1") return "moderate";
    return null;
  }

  function colorFor(raw) {
    const cls = normalizeClass(raw);
    return cls ? CLASS_COLORS[cls] : DEFAULT_COLOR;
  }

  App.registerLayer({
    key: "fire-hazard",
    label: "Fire Hazard Zones",
    desc: "CAL FIRE Fire Hazard Severity Zones (State + Local Responsibility Area)",
    defaultOn: false,
    legend: Object.entries(CLASS_COLORS)
      .map(([k, c]) => `<div class="legend-row"><span class="swatch" style="background:${c}"></span>${k[0].toUpperCase()}${k.slice(1)}</div>`)
      .join(""),
    loader: async (map) => {
      const gj = await DataStore.getFireHazardGeoJSON();
      return L.geoJSON(gj, {
        // No stroke: this dataset is thousands of small adjacent polygons,
        // and drawing a border on every one is what made same-colored
        // neighboring zones look like a messy grid instead of one smooth
        // hazard-severity choropleth.
        style: (feature) => ({
          stroke: false,
          fillColor: colorFor(feature.properties.HAZ_CLASS),
          fillOpacity: 0.55,
        }),
        onEachFeature: (feature, layer) => {
          const cls = normalizeClass(feature.properties.HAZ_CLASS) || "Unknown";
          const src = feature.properties.SOURCE_LAYER || "";
          layer.bindPopup(
            `<div class="la-popup"><h4>Fire Hazard Severity Zone</h4>
              <table>
                <tr><td class="k">Hazard class</td><td class="v">${cls}</td></tr>
                <tr><td class="k">Responsibility area</td><td class="v">${src}</td></tr>
              </table>
              <p style="font-size:0.7rem;color:#5b6470;margin:6px 0 0;">Source: CAL FIRE / CA state GIS</p>
            </div>`
          );
        },
      });
    },
  });
})();
