// Demographics - choropleth by total population; click a zip for the full
// race/ethnicity breakdown and population size.
(() => {
  const POP_BREAKS = [10000, 25000, 40000, 55000, 70000];
  const POP_COLORS = ["#fee5d9", "#fcbba1", "#fc9272", "#fb6a4a", "#de2d26", "#a50f15"];

  function colorForPopulation(pop) {
    if (pop === undefined || pop === null || pop < 0) return "#eeeeee";
    for (let i = 0; i < POP_BREAKS.length; i++) {
      if (pop < POP_BREAKS[i]) return POP_COLORS[i];
    }
    return POP_COLORS[POP_COLORS.length - 1];
  }

  function raceRows(rec) {
    const R = CONFIG.RACE_VARIABLES;
    const total = rec[R.total];
    const rows = [
      ["Hispanic / Latino (any race)", rec[R.hispanicLatino]],
      ["White (non-Hispanic)", rec[R.notHispanicWhite]],
      ["Black / African American (non-Hispanic)", rec[R.notHispanicBlack]],
      ["Asian (non-Hispanic)", rec[R.notHispanicAsian]],
      ["American Indian / Alaska Native (non-Hispanic)", rec[R.notHispanicAIAN]],
      ["Native Hawaiian / Pacific Islander (non-Hispanic)", rec[R.notHispanicNHPI]],
      ["Two or more races (non-Hispanic)", rec[R.notHispanicTwoOrMore]],
      ["Some other race (non-Hispanic)", rec[R.notHispanicOther]],
    ];
    return rows
      .map(([label, count]) => ({ label, count, pct: Utils.fmtPercent(count, total) }))
      .sort((a, b) => (b.count || 0) - (a.count || 0));
  }

  function popupHTML(zcta, rec) {
    if (!rec) {
      return `<div class="la-popup"><h4>ZIP ${zcta}</h4><p>No ACS data returned for this ZCTA.</p></div>`;
    }
    const total = rec[CONFIG.RACE_VARIABLES.total];
    const rows = raceRows(rec)
      .map((r) => `<tr><td class="k">${r.label}</td><td class="v">${Utils.fmtNumber(r.count)} (${r.pct})</td></tr>`)
      .join("");
    return `<div class="la-popup">
      <h4>ZIP ${zcta} &mdash; Demographics</h4>
      <table>
        <tr><td class="k">Total population</td><td class="v">${Utils.fmtNumber(total)}</td></tr>
        ${rows}
      </table>
      <p style="font-size:0.7rem;color:#5b6470;margin:6px 0 0;">Source: US Census ACS 5-year estimates, ${CONFIG.ACS_YEAR}</p>
    </div>`;
  }

  App.registerLayer({
    key: "demographics",
    label: "Demographics",
    desc: "Population choropleth; click a zip for ethnicity breakdown (Census ACS)",
    defaultOn: false,
    legend:
      `<div class="legend-row"><span class="swatch" style="background:${POP_COLORS[0]}"></span>&lt; ${POP_BREAKS[0].toLocaleString()}</div>` +
      POP_BREAKS.slice(1).map((b, i) => `<div class="legend-row"><span class="swatch" style="background:${POP_COLORS[i+1]}"></span>${POP_BREAKS[i].toLocaleString()}&ndash;${b.toLocaleString()}</div>`).join("") +
      `<div class="legend-row"><span class="swatch" style="background:${POP_COLORS[POP_COLORS.length-1]}"></span>&gt; ${POP_BREAKS[POP_BREAKS.length-1].toLocaleString()}</div>`,
    loader: async (map) => {
      const [zctaGJ, census] = await Promise.all([DataStore.getZctaGeoJSON(), DataStore.getCensusZctaData()]);
      return L.geoJSON(zctaGJ, {
        style: (feature) => {
          const rec = census[feature.properties.ZCTA5];
          const pop = rec ? rec[CONFIG.RACE_VARIABLES.total] : null;
          return { color: "#7a1f0d", weight: 0.8, fillColor: colorForPopulation(pop), fillOpacity: 0.65 };
        },
        onEachFeature: (feature, layer) => {
          const zcta = feature.properties.ZCTA5;
          const rec = census[zcta];
          layer.bindPopup(popupHTML(zcta, rec));
        },
      });
    },
  });
})();
