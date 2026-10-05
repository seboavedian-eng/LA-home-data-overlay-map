// Map layers as objects.
//
// Each layer is an instance of a class that knows how to style its features,
// what to say when you hover one, what its legend is, and - for the identify
// card - what it says about one point. blockgroups.js still owns fetching and
// the Leaflet plumbing; a layer object owns everything that is ABOUT the layer.
//
// This is the first slice of moving the app onto classes: zoning and historic
// districts are full subclasses; the hazard and school layers are wrapped by
// AdapterLayer so the identify card can treat every layer the same way. Moving
// another layer means writing its subclass and deleting its special case in
// blockgroups.js - nothing else has to change.
//
// The classes never reach into the app directly. Whatever they need (HTML
// escaping, the zone-code reader, the card-row builder) is handed to them as
// `helpers` when the app starts - so a layer can be tested on its own.

const MapLayers = (() => {
  // --- Geometry: does a GeoJSON feature contain a point? ------------------
  // Ray casting on [lon, lat] rings; holes subtract. Exact enough at lot
  // scale, and fast: the identify card runs this against every feature
  // already drawn, so a click costs no network round trip.
  function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function pointInPolygon(lon, lat, rings) {
    if (!rings.length || !pointInRing(lon, lat, rings[0])) return false;
    for (let k = 1; k < rings.length; k++) if (pointInRing(lon, lat, rings[k])) return false;
    return true;
  }

  function pointInFeature(feature, lon, lat) {
    const g = feature && feature.geometry;
    if (!g) return false;
    if (g.type === "Polygon") return pointInPolygon(lon, lat, g.coordinates);
    if (g.type === "MultiPolygon") return g.coordinates.some((rings) => pointInPolygon(lon, lat, rings));
    return false;
  }

  // --- The base class ------------------------------------------------------
  class MapLayer {
    constructor(key, { label } = {}) {
      this.key = key;
      this.label = label || key;
      this.h = null;
    }

    bind(helpers) {
      this.h = helpers;
      return this;
    }

    /** Leaflet path style for one feature. */
    style() {
      return {};
    }

    /** HTML for the hover tooltip, or null for none. */
    tooltip() {
      return null;
    }

    /** Legend rows (HTML strings) for what is on the map now. */
    legendRows() {
      return [];
    }

    /**
     * What this layer says about one of its features, for the identify card:
     * { title, html } or null. `place` carries the jurisdiction, if known.
     */
    describe() {
      return null;
    }

    /** Features of the drawn Leaflet layer that contain the point. */
    hitsAt(leafletLayer, latlng) {
      return [];
    }
  }

  // --- Polygons you can be "inside" ----------------------------------------
  class AreaLayer extends MapLayer {
    hitsAt(leafletLayer, latlng) {
      if (!leafletLayer || !leafletLayer.eachLayer) return [];
      const out = [];
      leafletLayer.eachLayer((l) => {
        const f = l.feature;
        if (!f || (f.geometry && /Point/.test(f.geometry.type))) return;
        if (l.getBounds && !l.getBounds().contains(latlng)) return;
        if (pointInFeature(f, latlng.lng, latlng.lat)) out.push(f);
      });
      return out;
    }
  }

  // --- Drawn with the publisher's own legend where it has one ----------------
  class PublisherStyledLayer extends AreaLayer {
    fallbackStyle() {
      return {};
    }

    style(feature) {
      return (feature.properties && feature.properties.__symStyle) || this.fallbackStyle(feature);
    }

    /** The publisher categories on the map now, grouped by source layer. */
    publisherGroups(leafletLayer) {
      const groups = new Map();
      let unstyled = false;
      if (leafletLayer) {
        leafletLayer.eachLayer((l) => {
          const p = l.feature && l.feature.properties;
          if (!p) return;
          if (!p.__symStyle) {
            unstyled = true;
            return;
          }
          if (!groups.has(p.__symSource)) groups.set(p.__symSource, new Map());
          groups.get(p.__symSource).set(p.__symLabel, { style: p.__symStyle, props: p });
        });
      }
      return { groups, unstyled };
    }

    /** One legend row; subclasses add to it (zoning adds its rules). */
    legendRow(label, style /* , props */) {
      const esc = this.h.escapeHTML;
      return (
        `<div class="legend-row"><span class="swatch" style="background:${style.fillColor};` +
        `opacity:${Math.max(0.5, style.fillOpacity)};border:1px solid ${style.color}"></span>${esc(String(label))}</div>`
      );
    }

    legendRows(leafletLayer) {
      const { groups, unstyled } = this.publisherGroups(leafletLayer);
      const rows = [];
      groups.forEach((labels, source) => {
        rows.push(`<div class="legend-note"><strong>${this.h.escapeHTML(String(source))}</strong> - the publisher's own legend</div>`);
        [...labels.entries()]
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }))
          .forEach(([label, entry]) => rows.push(this.legendRow(label, entry.style, entry.props)));
      });
      return { rows, unstyled };
    }
  }

  // --- Zoning ---------------------------------------------------------------
  class ZoningLayer extends PublisherStyledLayer {
    constructor(zoneRules) {
      super("zoning", { label: "Zoning" });
      this.rules = zoneRules;
    }

    fallbackStyle(feature) {
      const cls = this.h.zoningClass(this.h.zoningCode(feature.properties));
      return { color: cls.color, weight: 1, opacity: 0.9, fillColor: cls.color, fillOpacity: 0.3 };
    }

    /** The name this zone goes by: the publisher's label, else its code. */
    zoneName(props) {
      return props.__symLabel || this.h.zoningCode(props) || "";
    }

    ruleFor(props, place) {
      return this.rules ? this.rules.forZone(this.zoneName(props), { ...place, sourceUrl: props.__sourceUrl }) : null;
    }

    tooltip(feature) {
      const p = feature.properties;
      const esc = this.h.escapeHTML;
      const code = this.h.zoningCode(p);
      const rule = this.ruleFor(p);
      const summary = rule ? this.rules.summary(rule) : "";
      return (
        `${esc(p.__symLabel || `Zone ${code || "?"}`)}<br><span style="opacity:.7">` +
        `${p.__symLabel ? `code ${esc(String(code || "?"))} &middot; publisher's legend` : esc(this.h.zoningClass(code).label)} &middot; ` +
        `${esc(p.SOURCE_LAYER || "")}</span>` +
        (summary ? `<br><span class="zone-tip-summary">${esc(summary)}</span>` : "")
      );
    }

    // The legend row gains an info icon carrying that zone's limits, so a
    // hover on the legend answers "what can I build in this colour".
    legendRow(label, style, props) {
      const row = super.legendRow(label, style, props);
      const rule = props ? this.ruleFor(props) : null;
      if (!rule) return row;
      return row.replace(/<\/div>$/, `${this.h.infoIcon(this.rules.tipText(rule))}</div>`);
    }

    describe(props, place) {
      const esc = this.h.escapeHTML;
      const rule = this.ruleFor(props, place);
      return {
        title: this.zoneName(props) || "Zone",
        html:
          `<p class="here-sub">Zone ${esc(String(this.h.zoningCode(props) || "?"))} &middot; ${esc(props.SOURCE_LAYER || "")}</p>` +
          (rule
            ? this.rules.bulletsHTML(rule, esc)
            : '<p class="hint">No zone rules on file for this jurisdiction yet. The code is the question to ask the city, not the answer.</p>'),
      };
    }
  }

  // --- Historic districts and listed parcels --------------------------------
  class HistoricLayer extends PublisherStyledLayer {
    constructor(config) {
      super("historic", { label: "Historic districts" });
      this.config = config;
    }

    fallbackStyle() {
      return this.config.STYLES.historic;
    }

    nameOf(props) {
      return this.h.pickField(props, this.config.PARCEL_CONTEXT.historic.fields);
    }

    tooltip(feature) {
      const p = feature.properties;
      const esc = this.h.escapeHTML;
      const name = this.nameOf(p);
      const category = p.__symLabel;
      return (
        `${esc(String(name || category || "Historic district"))}<br><span style="opacity:.7">` +
        `${category && category !== name ? `${esc(category)} &middot; ` : ""}` +
        `${esc(p.SOURCE_LAYER || "")} - design review applies to anything visible from the street</span>`
      );
    }

    describe(props) {
      const esc = this.h.escapeHTML;
      const name = this.nameOf(props);
      const category = props.__symLabel;
      return {
        title: String(name || category || "Historic area"),
        html:
          (category && category !== name ? `<p class="here-sub">${esc(category)}</p>` : "") +
          "<ul class=\"zone-rules\">" +
          "<li>Exterior changes visible from the street go through historic design review, not the usual board</li>" +
          "<li>Demolition, even partial, triggers its own review</li>" +
          "<li>SB 9 lot splits and duplexes do not apply on historic properties</li>" +
          "<li>Whether the house is a <em>contributor</em> decides how strict review is - ask the city</li>" +
          "</ul>" +
          `<p class="src-note">From ${esc(props.SOURCE_LAYER || "the historic layer")}. Rules: the city's historic preservation ordinance and that district's design guidelines.</p>`,
      };
    }
  }

  // --- Existing layers, wrapped ----------------------------------------------
  // Not yet migrated: their styling still lives in blockgroups.js. Wrapping
  // them lets the identify card ask every layer the same question today.
  class AdapterLayer extends AreaLayer {
    constructor(key, { label, describe, featureFilter }) {
      super(key, { label });
      this._describe = describe;
      this._filter = featureFilter;
    }

    hitsAt(leafletLayer, latlng) {
      const hits = super.hitsAt(leafletLayer, latlng);
      return this._filter ? hits.filter(this._filter) : hits;
    }

    describe(props, place) {
      return this._describe ? this._describe(props, place) : null;
    }
  }

  // --- Zone rules -------------------------------------------------------------
  // One JSON file per jurisdiction (js/zone-rules/*.json): its zones, each
  // zone's limits, and the state rules that apply on top. Every value carries
  // whether it has been checked against the code itself.
  class ZoneRules {
    constructor() {
      this.sets = [];
    }

    add(set) {
      if (!set || !Array.isArray(set.zones)) return;
      set.zones.forEach((z) => (z._re = new RegExp(z.match, "i")));
      set._source = set.matchSource ? new RegExp(set.matchSource, "i") : null;
      this.sets.push(set);
    }

    /** The set for a place: by the feature's service URL, or the card's jurisdiction. */
    setFor({ sourceUrl, jurisdiction } = {}) {
      return (
        this.sets.find((s) => s._source && sourceUrl && s._source.test(sourceUrl)) ||
        this.sets.find((s) => jurisdiction && String(jurisdiction).toLowerCase().includes(s.matchJurisdiction)) ||
        null
      );
    }

    forZone(zoneName, place) {
      const set = this.setFor(place);
      if (!set || !zoneName) return null;
      const zone = set.zones.find((z) => z._re.test(String(zoneName)));
      if (!zone) return null;
      const state = (set.stateRules || []).filter((r) => r.appliesTo.includes(zone.zone));
      return { set, zone, state };
    }

    _lines(rule) {
      return rule.zone.rules.concat(rule.state).map((r) => ({
        text: `${r.topic}: ${r.value}`,
        verified: r.verified === true,
        conflict: r.conflict || null,
        // FAR depends on a district the chapter does not assign - say so
        // wherever the FAR line appears, rather than let it read as settled.
        note: /floor area/i.test(r.topic) && /District/.test(r.value) ? rule.set.farDistrictNote || null : null,
      }));
    }

    summary(rule) {
      const pick = rule.zone.rules.filter((r) => /coverage|height/i.test(r.topic)).slice(0, 2);
      return pick.map((r) => `${r.topic}: ${r.value}`).join(" · ");
    }

    /** Plain text with line breaks, for the hover tip (which prints text). */
    tipText(rule) {
      const lines = this._lines(rule).map(
        (l) => `• ${l.text}${l.verified ? "" : " (unverified)"}${l.conflict ? ` - ${l.conflict}` : ""}${l.note ? ` (${l.note})` : ""}`
      );
      return (
        `${rule.zone.zone} - ${rule.zone.name}\n` +
        `${lines.join("\n")}\n` +
        `Source: ${rule.set.code}, as of ${rule.set.asOf}.` +
        " Lines marked unverified are state law not checked here. A screening answer - the city's counter has the final word."
      );
    }

    bulletsHTML(rule, esc) {
      const items = this._lines(rule)
        .map(
          (l) =>
            `<li>${esc(l.text)}${l.verified ? "" : ' <span class="unverified">unverified</span>'}` +
            `${l.conflict ? `<br><span class="conflict">${esc(l.conflict)}</span>` : ""}` +
            `${l.note ? `<br><span class="here-sub">${esc(l.note)}</span>` : ""}</li>`
        )
        .join("");
      return (
        `<ul class="zone-rules">${items}</ul>` +
        `<p class="src-note">${esc(rule.set.code)}, as of ${esc(rule.set.asOf)}. ` +
        `${esc(rule.set.howCollected)} ` +
        `<a href="${rule.set.codeUrl}" target="_blank" rel="noopener">Read the code &rarr;</a></p>`
      );
    }
  }

  // --- Registry ---------------------------------------------------------------
  class Registry {
    constructor() {
      this.byKey = new Map();
    }
    register(layer) {
      this.byKey.set(layer.key, layer);
      return layer;
    }
    get(key) {
      return this.byKey.get(key) || null;
    }
    all() {
      return [...this.byKey.values()];
    }
  }

  return { MapLayer, AreaLayer, PublisherStyledLayer, ZoningLayer, HistoricLayer, AdapterLayer, ZoneRules, Registry, pointInFeature };
})();
