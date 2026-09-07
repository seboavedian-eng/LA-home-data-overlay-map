// ---------------------------------------------------------------------------
// Shared, cached fetches. Several layers (and the address-search summary)
// need the same underlying data - e.g. both the "Zip Code Borders" layer and
// the "Demographics" and "Income" layers all need ZCTA polygons - so each
// data set is fetched at most once per page load and reused everywhere.
// ---------------------------------------------------------------------------

const DataStore = (() => {
  const cache = {};

  function once(key, fn) {
    if (!cache[key]) cache[key] = fn();
    return cache[key];
  }

  // 2020 Census ZIP Code Tabulation Areas covering LA County.
  function getZctaGeoJSON() {
    return once("zcta", async () => {
      // exclude tribal/label layers - TIGERweb's loose name collisions
      // otherwise select a layer that queries fine but returns nothing.
      const layerId = await Utils.discoverLayerId(CONFIG.ZCTA_SERVER, CONFIG.ZCTA_LAYER_NAME_HINT, CONFIG.ZCTA_LAYER_ID, {
        exactNames: ["2020 Census ZIP Code Tabulation Areas", "Zip Code Tabulation Areas"],
        exclude: /tribal|label/i,
      });
      const url = Utils.arcgisQueryUrl(CONFIG.ZCTA_SERVER, layerId, {
        bbox: CONFIG.LA_COUNTY_BBOX,
        outFields: "*",
      });
      const gj = await Utils.fetchEsriAsGeoJSON(url);
      gj.features.forEach((f) => {
        f.properties.ZCTA5 = Utils.pickField(f.properties, ["ZCTA5CE20", "ZCTA5CE10", "ZCTA5CE", "GEOID20", "GEOID"]);
        if (f.properties.ZCTA5 && f.properties.ZCTA5.length > 5) {
          f.properties.ZCTA5 = f.properties.ZCTA5.slice(-5);
        }
      });
      return gj;
    });
  }

  // Bulk ACS 5-year race/ethnicity + income variables for every CA ZCTA,
  // fetched once and then matched by code to whichever ZCTAs are on screen.
  function getCensusZctaData() {
    return once("census", async () => {
      const vars = [
        ...Object.values(CONFIG.RACE_VARIABLES),
        ...Object.values(CONFIG.INCOME_VARIABLES),
      ];
      const get = ["NAME", ...vars].join(",");
      const keyParam = CONFIG.CENSUS_API_KEY ? `&key=${CONFIG.CENSUS_API_KEY}` : "";
      const base = `https://api.census.gov/data/${CONFIG.ACS_YEAR}/${CONFIG.ACS_DATASET}`;

      // Prefer a local pre-fetched snapshot (see
      // scripts/fetch-census-data.sh): it's same-origin, so it always
      // works with zero live dependency. api.census.gov itself never sends
      // Access-Control-Allow-Origin, so a direct browser fetch to it is
      // expected to fail - and public CORS proxies have proven unreliable
      // in practice (rate-limited, 403s, or blocked by the visitor's own
      // network/extensions), so that path is now a last resort, not the
      // primary plan.
      let rows;
      try {
        rows = await Utils.fetchJSON(CONFIG.CENSUS_LOCAL_SNAPSHOT);
        Utils.logStatus("census", "ok", `Loaded ACS data from local snapshot (${CONFIG.CENSUS_LOCAL_SNAPSHOT}).`);
      } catch (localErr) {
        Utils.logStatus(
          "census",
          "info",
          `No local ACS snapshot at ${CONFIG.CENSUS_LOCAL_SNAPSHOT} (run scripts/fetch-census-data.sh once to add it); trying a live request instead.`
        );
        try {
          const url = `${base}?get=${get}&for=zip%20code%20tabulation%20area:*&in=state:06${keyParam}`;
          rows = await Utils.fetchJSONWithCorsFallback(url, undefined, "census");
        } catch (err) {
          Utils.logStatus("census", "warn", `State-filtered ACS query failed (${err.message}); retrying nationwide.`);
          const url = `${base}?get=${get}&for=zip%20code%20tabulation%20area:*${keyParam}`;
          rows = await Utils.fetchJSONWithCorsFallback(url, undefined, "census");
        }
      }

      const header = rows[0];
      const zctaIdx = header.indexOf("zip code tabulation area");
      const map = {};
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const zcta = row[zctaIdx];
        const rec = {};
        header.forEach((h, idx) => {
          if (vars.includes(h)) rec[h] = row[idx] === null ? null : Number(row[idx]);
        });
        map[zcta] = rec;
      }
      return map;
    });
  }

  // LA County legal city boundaries.
  function getCityGeoJSON() {
    return once("cities", async () => {
      const layerId = await Utils.discoverLayerId(CONFIG.CITY_SERVER, CONFIG.CITY_LAYER_NAME_HINT, 0);
      const url = Utils.arcgisQueryUrl(CONFIG.CITY_SERVER, layerId, {
        bbox: CONFIG.LA_COUNTY_BBOX,
        outFields: "*",
      });
      const gj = await Utils.fetchEsriAsGeoJSON(url);
      gj.features.forEach((f) => {
        f.properties.CITY_NAME = Utils.pickField(f.properties, ["CITY_NAME", "CITY", "NAME", "LABEL", "CITYLABEL"]);
      });
      return gj;
    });
  }

  // CAL FIRE Fire Hazard Severity Zones - both SRA and LRA layers merged.
  function getFireHazardGeoJSON() {
    return once("fire", async () => {
      const root = await Utils.fetchJSON(`${CONFIG.FIRE_SERVER}?f=json`);
      // Only keep sublayers that are actually polygons: this service also
      // exposes label/boundary-line sublayers whose names match "hazard"
      // too, and pulling those in alongside the fill polygons is what
      // produced the stray unfilled lines on the map.
      const layers = (root.layers || []).filter(
        (l) => /hazard|fhsz|sra|lra/i.test(l.name) && (!l.geometryType || l.geometryType === "esriGeometryPolygon")
      );
      const targets = layers.length ? layers : [{ id: 0, name: "Fire Hazard Severity Zones" }];

      const features = [];
      for (const layer of targets) {
        try {
          const url = Utils.arcgisQueryUrl(CONFIG.FIRE_SERVER, layer.id, {
            bbox: CONFIG.LA_COUNTY_BBOX,
            outFields: "*",
          });
          const gj = await Utils.fetchEsriAsGeoJSON(url);
          gj.features.forEach((f) => {
            f.properties.HAZ_CLASS = Utils.pickField(f.properties, [
              "HAZ_CLASS", "FHSZ", "SRA_HAZ_CODE", "FHSZ_DESC", "HAZARD", "HAZARD_CLASS", "HAZ_CODE",
            ]);
            f.properties.SOURCE_LAYER = layer.name;
            features.push(f);
          });
        } catch (err) {
          Utils.logStatus("fire", "warn", `Sub-layer "${layer.name}" failed: ${err.message}`);
        }
      }
      // Diagnostic: if the live field name for hazard class doesn't match
      // any of our guesses, every polygon silently falls back to gray -
      // this makes that visible in the status log instead of just looking
      // "off" with no clue why.
      const unclassified = features.filter((f) => !f.properties.HAZ_CLASS).length;
      if (features.length > 0 && unclassified > 0) {
        Utils.logStatus(
          "fire",
          unclassified === features.length ? "warn" : "info",
          `${unclassified}/${features.length} fire hazard polygons had no recognized hazard-class field (fields seen: ${Object.keys(features[0].properties).join(", ")}).`
        );
      }
      return { type: "FeatureCollection", features };
    });
  }

  // CA Dept of Education public school sites (2024-25), filtered to LA County bbox.
  function getSchoolsGeoJSON() {
    return once("schools", async () => {
      const url = Utils.arcgisQueryUrl(CONFIG.SCHOOLS_SERVER, undefined, {
        bbox: CONFIG.LA_COUNTY_BBOX,
        outFields: "*",
      });
      const gj = await Utils.fetchEsriAsGeoJSON(url);
      gj.features.forEach((f) => {
        f.properties._name = Utils.pickField(f.properties, ["SchoolName", "School", "NAME", "SCHOOLNAME"]);
        f.properties._district = Utils.pickField(f.properties, ["DistrictName", "District", "DNAME"]);
        f.properties._level = Utils.pickField(f.properties, ["EILCode", "SOC", "Level", "SchoolType", "EILName"]);
        f.properties._street = Utils.pickField(f.properties, ["Street", "StreetAbr", "Address"]);
        f.properties._city = Utils.pickField(f.properties, ["City"]);
        f.properties._zip = Utils.pickField(f.properties, ["Zip", "ZipCode"]);
        f.properties._cds = Utils.pickField(f.properties, ["CDSCode", "CDS_CODE", "CDS"]);
        f.properties._status = Utils.pickField(f.properties, ["StatusType", "Status"]);
      });
      return gj;
    });
  }

  // CA school district areas (elementary/high/unified boundaries), CDE's
  // composite layer - same ArcGIS Online org as the schools layer. The
  // exact current service name couldn't be verified live, so try each
  // candidate in CONFIG.DISTRICTS_SERVER_CANDIDATES until one responds.
  function getDistrictsGeoJSON() {
    return once("districts", async () => {
      let lastErr;
      for (const server of CONFIG.DISTRICTS_SERVER_CANDIDATES) {
        try {
          const url = Utils.arcgisQueryUrl(server, undefined, {
            bbox: CONFIG.LA_COUNTY_BBOX,
            outFields: "*",
          });
          const gj = await Utils.fetchEsriAsGeoJSON(url);
          Utils.logStatus("districts", "ok", `Using district layer: ${server}`);
          gj.features.forEach((f) => {
            f.properties._name = Utils.pickField(f.properties, ["DistrictName", "NAME", "DNAME", "District"]);
            f.properties._type = Utils.pickField(f.properties, ["DistrictType", "Type", "SOC"]) || "School District";
          });
          return gj;
        } catch (err) {
          Utils.logStatus("districts", "info", `${server} didn't work (${err.message}); trying next candidate.`);
          lastErr = err;
        }
      }
      throw lastErr || new Error("No district layer candidate responded");
    });
  }

  return {
    getZctaGeoJSON,
    getCensusZctaData,
    getCityGeoJSON,
    getFireHazardGeoJSON,
    getSchoolsGeoJSON,
    getDistrictsGeoJSON,
  };
})();
