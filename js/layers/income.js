// Income Levels - choropleth by median household income; click for details.
(() => {
  const INC_BREAKS = [50000, 75000, 100000, 130000, 170000];
  const INC_COLORS = ["#fff5eb", "#fee6ce", "#fdae6b", "#fd8d3c", "#e6550d", "#a63603"];

  function colorForIncome(v) {
    if (v === undefined || v === null || v < 0) return "#eeeeee";
    for (let i = 0; i < INC_BREAKS.length; i++) {
      if (v < INC_BREAKS[i]) return INC_COLORS[i];
    }
    return INC_COLORS[INC_COLORS.length - 1];
  }

  function popupHTML(zcta, rec) {
    if (!rec) {
      return `<div class="la-popup"><h4>ZIP ${zcta}</h4><p>No ACS data returned for this ZCTA.</p></div>`;
    }
    const I = CONFIG.INCOME_VARIABLES;
    const medianHH = rec[I.medianHouseholdIncome];
    const perCapita = rec[I.perCapitaIncome];
    const povertyRate = Utils.fmtPercent(rec[I.povertyCount], rec[I.povertyUniverse]);
    return `<div class="la-popup">
      <h4>ZIP ${zcta} &mdash; Income</h4>
      <table>
        <tr><td class="k">Median household income</td><td class="v">${Utils.fmtCurrency(medianHH)}</td></tr>
        <tr><td class="k">Per-capita income</td><td class="v">${Utils.fmtCurrency(perCapita)}</td></tr>
        <tr><td class="k">Poverty rate</td><td class="v">${povertyRate}</td></tr>
      </table>
      <p style="font-size:0.7rem;color:#5b6470;margin:6px 0 0;">Source: US Census ACS 5-year estimates, ${CONFIG.ACS_YEAR}</p>
    </div>`;
  }

  App.registerLayer({
    key: "income",
    label: "Income Levels",
    desc: "Median household income choropleth (Census ACS)",
    defaultOn: false,
    legend:
      `<div class="legend-row"><span class="swatch" style="background:${INC_COLORS[0]}"></span>&lt; $${(INC_BREAKS[0]/1000)}k</div>` +
      INC_BREAKS.slice(1).map((b, i) => `<div class="legend-row"><span class="swatch" style="background:${INC_COLORS[i+1]}"></span>$${(INC_BREAKS[i]/1000)}k&ndash;$${(b/1000)}k</div>`).join("") +
      `<div class="legend-row"><span class="swatch" style="background:${INC_COLORS[INC_COLORS.length-1]}"></span>&gt; $${(INC_BREAKS[INC_BREAKS.length-1]/1000)}k</div>`,
    loader: async (map) => {
      const [zctaGJ, census] = await Promise.all([DataStore.getZctaGeoJSON(), DataStore.getCensusZctaData()]);
      return L.geoJSON(zctaGJ, {
        style: (feature) => {
          const rec = census[feature.properties.ZCTA5];
          const v = rec ? rec[CONFIG.INCOME_VARIABLES.medianHouseholdIncome] : null;
          return { color: "#7a4a0d", weight: 0.8, fillColor: colorForIncome(v), fillOpacity: 0.65 };
        },
        onEachFeature: (feature, layer) => {
          const zcta = feature.properties.ZCTA5;
          layer.bindPopup(popupHTML(zcta, census[zcta]));
        },
      });
    },
  });
})();
