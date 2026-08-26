// Schools - point locations from the CA Dept of Education's official
// school directory. GreatSchools.com has no free public API (requires an
// approved partner agreement), so instead of fabricating a rating we link
// out to the official CA School Dashboard for real state accountability
// data, and clearly label the gap. See README for details.
(() => {
  const LEVEL_COLORS = { Elementary: "#1e88e5", Middle: "#8e24aa", High: "#e53935", Other: "#546e7a" };

  function levelFor(raw) {
    const s = String(raw || "").toLowerCase();
    if (s.includes("elem")) return "Elementary";
    if (s.includes("middle") || s.includes("junior") || s.includes("intermediate")) return "Middle";
    if (s.includes("high")) return "High";
    return "Other";
  }

  function popupHTML(props) {
    const name = props._name || "School";
    const district = props._district || "n/a";
    const level = levelFor(props._level);
    const addr = [props._street, props._city, props._zip].filter(Boolean).join(", ");
    const status = props._status || "n/a";
    return `<div class="la-popup">
      <h4>${name}</h4>
      <table>
        <tr><td class="k">District</td><td class="v">${district}</td></tr>
        <tr><td class="k">Level</td><td class="v">${level}</td></tr>
        <tr><td class="k">Address</td><td class="v">${addr || "n/a"}</td></tr>
        <tr><td class="k">Status</td><td class="v">${status}</td></tr>
      </table>
      <p style="font-size:0.72rem;margin:6px 0 0;">GreatSchools.com has no free API, so this searches Google instead:
        <a href="${Utils.greatSchoolsSearchUrl(name)}" target="_blank" rel="noopener">Check GreatSchools rating &#8599;</a></p>
      <p style="font-size:0.7rem;color:#5b6470;margin:4px 0 0;">Source: CA Dept of Education, School Sites 2024-25</p>
    </div>`;
  }

  App.registerLayer({
    key: "schools",
    label: "Schools",
    desc: "Public school locations (CA Dept of Education)",
    note: "GreatSchools ratings unavailable (no free API) - links to official CA state ratings instead",
    defaultOn: false,
    legend: Object.entries(LEVEL_COLORS)
      .map(([k, c]) => `<div class="legend-row"><span class="swatch" style="background:${c};border-radius:50%;"></span>${k}</div>`)
      .join(""),
    loader: async (map) => {
      const gj = await DataStore.getSchoolsGeoJSON();
      return L.geoJSON(gj, {
        pointToLayer: (feature, latlng) => {
          const level = levelFor(feature.properties._level);
          return L.circleMarker(latlng, {
            radius: 5,
            weight: 1,
            color: "#222",
            fillColor: LEVEL_COLORS[level],
            fillOpacity: 0.85,
          });
        },
        onEachFeature: (feature, layer) => {
          layer.bindPopup(popupHTML(feature.properties));
        },
      });
    },
  });
})();
