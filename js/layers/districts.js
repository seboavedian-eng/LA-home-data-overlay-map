// School District Boundaries (elementary/high/unified, CA Dept of Education
// via CA state GIS). This is the closest publicly-available approximation
// to "school zones" - fine-grained, parcel-level attendance boundaries are
// not published as a single statewide API (see README for details).
App.registerLayer({
  key: "school-districts",
  label: "School District Boundaries",
  desc: "Elementary / high / unified district service areas (CA state GIS)",
  note: "Approximate \"school zones\" - district-level, not per-school attendance boundaries",
  defaultOn: false,
  loader: async (map) => {
    const gj = await DataStore.getDistrictsGeoJSON();
    return L.geoJSON(gj, {
      style: { color: "#2e7d32", weight: 1.2, fill: false, opacity: 0.8, dashArray: "1 4" },
      onEachFeature: (feature, layer) => {
        const name = feature.properties._name || "Unknown district";
        const type = feature.properties._type || "";
        layer.bindTooltip(`${name} (${type})`, { sticky: true });
      },
    });
  },
});
