// City Borders - LA County incorporated city boundaries.
App.registerLayer({
  key: "city-borders",
  label: "City Borders",
  desc: "Incorporated city boundaries (LA County Dept. of Public Works)",
  defaultOn: false,
  loader: async (map) => {
    const gj = await DataStore.getCityGeoJSON();
    return L.geoJSON(gj, {
      style: { color: "#1b4d8c", weight: 1.6, fill: false, opacity: 0.85, dashArray: "4 2" },
      onEachFeature: (feature, layer) => {
        const name = feature.properties.CITY_NAME || "Unincorporated";
        layer.bindTooltip(name, { sticky: true });
      },
    });
  },
});
