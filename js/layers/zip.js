// Zip Code Borders - plain outline layer (no fill), just the boundary lines.
App.registerLayer({
  key: "zip-borders",
  label: "Zip Code Borders",
  desc: "2020 Census ZIP Code Tabulation Areas (US Census Bureau)",
  defaultOn: true,
  loader: async (map) => {
    const gj = await DataStore.getZctaGeoJSON();
    return L.geoJSON(gj, {
      style: { color: "#5b6470", weight: 1.2, fill: false, opacity: 0.8 },
      onEachFeature: (feature, layer) => {
        const zcta = feature.properties.ZCTA5 || "unknown";
        layer.bindTooltip(`ZIP ${zcta}`, { sticky: true });
      },
    });
  },
});
