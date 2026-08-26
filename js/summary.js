// Address search orchestration: geocode -> spatial join against every layer's
// underlying data -> render a summary table. Uses turf.js for point-in-polygon
// and distance so the result doesn't depend on which layers happen to be
// toggled on.
const Summary = (() => {
  let marker = null;

  function findContaining(pt, geojson) {
    if (!geojson) return null;
    return geojson.features.find((f) => {
      try {
        return turf.booleanPointInPolygon(pt, f);
      } catch (e) {
        return false;
      }
    });
  }

  function nearestSchools(pt, schoolsGJ, n = 5) {
    if (!schoolsGJ) return [];
    return schoolsGJ.features
      .map((f) => ({ f, dist: turf.distance(pt, f, { units: "miles" }) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, n);
  }

  function raceBreakdownRows(rec) {
    if (!rec) return "<tr><td colspan='2'>No ACS data for this ZIP.</td></tr>";
    const R = CONFIG.RACE_VARIABLES;
    const total = rec[R.total];
    const items = [
      ["Hispanic / Latino", rec[R.hispanicLatino]],
      ["White (NH)", rec[R.notHispanicWhite]],
      ["Black (NH)", rec[R.notHispanicBlack]],
      ["Asian (NH)", rec[R.notHispanicAsian]],
      ["AIAN (NH)", rec[R.notHispanicAIAN]],
      ["NHPI (NH)", rec[R.notHispanicNHPI]],
      ["Two+ races (NH)", rec[R.notHispanicTwoOrMore]],
      ["Other (NH)", rec[R.notHispanicOther]],
    ].sort((a, b) => (b[1] || 0) - (a[1] || 0));
    return items
      .map(([label, count]) => `<tr><td class="k">${label}</td><td class="v">${Utils.fmtNumber(count)} (${Utils.fmtPercent(count, total)})</td></tr>`)
      .join("");
  }

  function render(result) {
    const wrap = document.getElementById("summary-table-wrap");
    const { addr, zctaFeature, census, cityFeature, fireFeatures, schools } = result;
    const zcta = zctaFeature ? zctaFeature.properties.ZCTA5 : addr.zip;
    const rec = census[zcta];

    const fireHtml = fireFeatures.length
      ? fireFeatures
          .map((f) => `${f.properties.SOURCE_LAYER || "Zone"}: <strong>${f.properties.HAZ_CLASS || "Unknown"}</strong>`)
          .join("<br>")
      : "No mapped fire hazard zone at this point";

    const schoolsHtml = schools.length
      ? schools
          .map(
            (s) =>
              `<div class="school-item"><strong>${s.f.properties._name || "School"}</strong><br>
              ${(s.f.properties._district || "")} &middot; ${s.dist.toFixed(2)} mi<br>
              <a href="https://www.caschooldashboard.org/" target="_blank" rel="noopener">Check state rating &#8599;</a></div>`
          )
          .join("")
      : "No schools found nearby";

    wrap.innerHTML = `
      <div class="summary-card">
        <h3>${addr.matchedAddress}</h3>
        <table>
          <tr><td class="k">ZIP code</td><td class="v">${zcta || "n/a"}</td></tr>
          <tr><td class="k">City</td><td class="v">${(cityFeature && cityFeature.properties.CITY_NAME) || addr.city || "Unincorporated / n/a"}</td></tr>
          <tr><td class="k">Total population (ZIP)</td><td class="v">${Utils.fmtNumber(rec ? rec[CONFIG.RACE_VARIABLES.total] : null)}</td></tr>
          <tr><td class="k">Median household income</td><td class="v">${Utils.fmtCurrency(rec ? rec[CONFIG.INCOME_VARIABLES.medianHouseholdIncome] : null)}</td></tr>
          <tr><td class="k">Per-capita income</td><td class="v">${Utils.fmtCurrency(rec ? rec[CONFIG.INCOME_VARIABLES.perCapitaIncome] : null)}</td></tr>
          <tr><td class="k">Poverty rate</td><td class="v">${rec ? Utils.fmtPercent(rec[CONFIG.INCOME_VARIABLES.povertyCount], rec[CONFIG.INCOME_VARIABLES.povertyUniverse]) : "n/a"}</td></tr>
        </table>
      </div>
      <div class="summary-card">
        <h3>Ethnicity breakdown (ZIP ${zcta || "n/a"})</h3>
        <table>${raceBreakdownRows(rec)}</table>
      </div>
      <div class="summary-card">
        <h3>Fire hazard at this location</h3>
        <p>${fireHtml}</p>
      </div>
      <div class="summary-card">
        <h3>Nearest schools</h3>
        ${schoolsHtml}
      </div>
    `;
  }

  async function search(addressText) {
    const statusEl = document.getElementById("search-status");
    statusEl.className = "hint";
    statusEl.textContent = "Looking up address...";

    const addr = await Geocode.lookup(addressText);
    const pt = turf.point([addr.lon, addr.lat]);

    statusEl.textContent = "Gathering zip, city, fire hazard and school data...";

    const [zctaGJ, census, cityGJ, fireGJ, schoolsGJ] = await Promise.all([
      DataStore.getZctaGeoJSON(),
      DataStore.getCensusZctaData(),
      DataStore.getCityGeoJSON(),
      DataStore.getFireHazardGeoJSON(),
      DataStore.getSchoolsGeoJSON(),
    ]);

    const zctaFeature = findContaining(pt, zctaGJ);
    const cityFeature = findContaining(pt, cityGJ);
    const fireFeatures = (fireGJ.features || []).filter((f) => {
      try {
        return turf.booleanPointInPolygon(pt, f);
      } catch (e) {
        return false;
      }
    });
    const schools = nearestSchools(pt, schoolsGJ, 5);

    render({ addr, zctaFeature, census, cityFeature, fireFeatures, schools });

    const map = App.map;
    if (marker) map.removeLayer(marker);
    marker = L.marker([addr.lat, addr.lon]).addTo(map).bindPopup(addr.matchedAddress).openPopup();
    map.setView([addr.lat, addr.lon], 14);

    statusEl.className = "hint ok";
    statusEl.textContent = `Found: ${addr.matchedAddress}`;
  }

  return { search };
})();
