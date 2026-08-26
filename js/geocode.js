// Address -> lat/lon via the US Census Bureau geocoder (free, no API key,
// US addresses only - a solid fit since this app is LA County-only).
const Geocode = (() => {
  async function lookup(addressText) {
    const params = new URLSearchParams({
      address: addressText,
      benchmark: CONFIG.GEOCODER_BENCHMARK,
      format: "json",
    });
    const url = `${CONFIG.GEOCODER_URL}?${params.toString()}`;
    const data = await Utils.fetchJSON(url);
    const matches = data && data.result && data.result.addressMatches;
    if (!matches || matches.length === 0) {
      throw new Error("Address not found. Try including city, state and zip.");
    }
    const m = matches[0];
    const comps = m.addressComponents || {};
    let zip = comps.zip;
    if (!zip) {
      const tail = /(\d{5})(-\d{4})?\s*$/.exec(m.matchedAddress || "");
      zip = tail ? tail[1] : null;
    }
    return {
      matchedAddress: m.matchedAddress,
      lat: m.coordinates.y,
      lon: m.coordinates.x,
      city: comps.city,
      state: comps.state,
      zip,
    };
  }

  return { lookup };
})();
