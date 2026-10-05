// Room to build on one lot, in 2D.
//
// Given the lot outline, its neighbours, the buildings on it and the zone's
// setbacks, this works out:
//   - which lot lines face a street (front / street side) and which face a
//     neighbour (interior side / rear),
//   - the main-building envelope: the lot pulled in by the zone's setbacks,
//   - the open ground where a detached ADU could go: the lot pulled in by the
//     ADU setbacks, minus every existing building,
//   - the largest rectangle that fits in that open ground.
//
// Everything is computed here, in metres, in a flat frame centred on the lot -
// exact enough at lot scale, and needing no geometry library. It is a
// SCREENING answer: no easements, slope, trees, utilities or access are known
// to it, and every result says so.

const LotEnvelope = (() => {
  const M_TO_FT = 3.28084;
  const SQM_TO_SQFT = 10.7639;

  // --- A flat frame around the lot ---------------------------------------
  function frameFor(ring) {
    const lon0 = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
    const ky = 110540;
    return {
      toLocal: ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky],
      toLonLat: ([x, y]) => [x / kx + lon0, y / ky + lat0],
    };
  }

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const len = (a) => Math.hypot(a[0], a[1]);

  function signedArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  }

  function openRing(ring) {
    const r = ring.slice();
    if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
    return r;
  }

  // Parcel outlines are digitised with many vertices along what is really one
  // straight lot line. Merge near-collinear runs, so a "side" is a side.
  function simplify(pts, minTurnDeg = 15, minEdge = 0.4) {
    let out = pts.filter((p, i) => i === 0 || len(sub(p, pts[i - 1])) >= minEdge);
    let changed = true;
    while (changed && out.length > 3) {
      changed = false;
      for (let i = 0; i < out.length && out.length > 3; i++) {
        const a = out[(i - 1 + out.length) % out.length];
        const b = out[i];
        const c = out[(i + 1) % out.length];
        const u = sub(b, a);
        const v = sub(c, b);
        const turn = Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], dot(u, v))) * (180 / Math.PI);
        if (turn < minTurnDeg) {
          out.splice(i, 1);
          changed = true;
          i--;
        }
      }
    }
    return out;
  }

  function pointInRing(p, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // Sutherland-Hodgman against one half-plane: keep where f(p) <= 0.
  function clipHalfPlane(poly, f) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const fp = f(p);
      const fq = f(q);
      if (fp <= 0) out.push(p);
      if ((fp <= 0) !== (fq <= 0)) {
        const t = fp / (fp - fq);
        out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
    }
    return out;
  }

  // The lot pulled in by a setback per edge. Each edge's half-plane runs the
  // full length of its line, so on a lot with an inward corner this trims a
  // little more than the code would - erring small, never large.
  function inset(pts, edges, setbackOf) {
    let poly = pts.slice();
    edges.forEach((e) => {
      const d = setbackOf(e);
      if (!(d > 0) || poly.length < 3) return;
      poly = clipHalfPlane(poly, (p) => dot(sub(p, e.a), e.normal) + d);
    });
    return poly.length >= 3 ? poly : [];
  }

  // --- Largest rectangle of free cells (classic histogram method) ---------
  function largestRectangle(grid, cols, rows) {
    const heights = new Array(cols).fill(0);
    let best = { area: 0 };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) heights[c] = grid[r * cols + c] ? heights[c] + 1 : 0;
      const stack = [];
      for (let c = 0; c <= cols; c++) {
        const h = c === cols ? 0 : heights[c];
        let start = c;
        while (stack.length && stack[stack.length - 1].h >= h) {
          const top = stack.pop();
          const area = top.h * (c - top.start);
          if (area > best.area) best = { area, c0: top.start, c1: c, r0: r - top.h + 1, r1: r + 1 };
          start = top.start;
        }
        stack.push({ h, start });
      }
    }
    return best;
  }

  /**
   * lot:        GeoJSON Polygon/MultiPolygon feature of the lot
   * neighbours: GeoJSON features of the parcels around it (the lot may be among them)
   * buildings:  GeoJSON features of building outlines near it
   * rules:      { front, streetSide, interior } in feet (main building)
   * adu:        { front, streetSide, side, rear } in feet
   */
  function compute({ lot, neighbours = [], buildings = [], rules, adu, cell = 0.25 }) {
    const g = lot && lot.geometry;
    if (!g) return { error: "no lot outline" };
    const outer = g.type === "Polygon" ? g.coordinates[0] : g.type === "MultiPolygon" ? g.coordinates[0][0] : null;
    if (!outer || outer.length < 4) return { error: "lot outline unreadable" };

    const frame = frameFor(openRing(outer));
    let pts = simplify(openRing(outer).map(frame.toLocal));
    if (signedArea(pts) < 0) pts.reverse(); // counter-clockwise: interior on the left
    const lotArea = signedArea(pts);
    const centroid = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];

    const ringsOf = (f) => {
      const geom = f && f.geometry;
      if (!geom) return [];
      const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
      return polys.map((rings) => openRing(rings[0]).map(frame.toLocal));
    };
    // A neighbour that contains the lot's own centre is the lot itself.
    const neighbourRings = neighbours.flatMap(ringsOf).filter((r) => !pointInRing(centroid, r));
    const buildingRings = buildings.flatMap(ringsOf);

    // --- Which way does each lot line face? ---
    const edges = pts.map((a, i) => {
      const b = pts[(i + 1) % pts.length];
      const d = sub(b, a);
      const l = len(d);
      const normal = [d[1] / l, -d[0] / l]; // outward, for a counter-clockwise ring
      let neighbourHits = 0;
      [0.25, 0.5, 0.75].forEach((t) => {
        const p = [a[0] + d[0] * t + normal[0] * 1.5, a[1] + d[1] * t + normal[1] * 1.5];
        if (neighbourRings.some((r) => pointInRing(p, r))) neighbourHits++;
      });
      return { a, b, length: l, normal, street: neighbourHits < 2, role: null };
    });

    const assumptions = [];
    const streets = edges.filter((e) => e.street && e.length >= 3);
    const streetUnknown = !neighbourRings.length || !streets.length || streets.length === edges.length;
    if (streetUnknown) {
      edges.forEach((e) => (e.street = false));
      assumptions.push("Could not tell which lot line faces the street (no neighbouring parcels loaded), so every line was given the interior setback - the front setback is NOT applied.");
    }
    let front = null;
    if (!streetUnknown) {
      // A corner lot's front is its narrower street frontage.
      front = streets.slice().sort((x, y) => x.length - y.length)[0];
      front.role = "front";
      edges.filter((e) => e.street && e !== front).forEach((e) => (e.role = "street side"));
      if (streets.length > 1) assumptions.push("Corner or through lot: the shorter street frontage was taken as the front.");
      const rearCandidate = edges
        .filter((e) => !e.role)
        .map((e) => ({ e, facing: dot(e.normal, front.normal) }))
        .sort((x, y) => x.facing - y.facing)[0];
      if (rearCandidate && rearCandidate.facing < -0.5) rearCandidate.e.role = "rear";
    }
    edges.forEach((e) => {
      if (!e.role) e.role = "side";
    });

    const FT = 1 / M_TO_FT;
    const mainSet = (e) =>
      (e.role === "front" ? rules.front : e.role === "street side" ? rules.streetSide : rules.interior) * FT;
    const aduSet = (e) =>
      (e.role === "front" ? adu.front : e.role === "street side" ? adu.streetSide : e.role === "rear" ? adu.rear : adu.side) * FT;
    const mainEnv = inset(pts, edges, mainSet);
    const aduEnv = inset(pts, edges, aduSet);

    // --- Rasterise in a frame aligned with the front, so the open-ground
    // rectangles line up with the lot rather than with north. ---
    const ref = front || edges.slice().sort((x, y) => y.length - x.length)[0];
    const ang = Math.atan2(ref.b[1] - ref.a[1], ref.b[0] - ref.a[0]);
    const cos = Math.cos(-ang);
    const sin = Math.sin(-ang);
    const rot = (p) => [p[0] * cos - p[1] * sin, p[0] * sin + p[1] * cos];
    const unrot = (p) => [p[0] * cos + p[1] * sin, -p[0] * sin + p[1] * cos];
    const lotR = pts.map(rot);
    const aduR = aduEnv.map(rot);
    const bldR = buildingRings.map((r) => r.map(rot));

    const xs = lotR.map((p) => p[0]);
    const ys = lotR.map((p) => p[1]);
    let size = cell;
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    while ((spanX / size) * (spanY / size) > 160000) size *= 1.5; // keep big hillside lots quick
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const cols = Math.ceil(spanX / size);
    const rows = Math.ceil(spanY / size);
    const free = new Uint8Array(cols * rows);
    let lotCells = 0;
    let builtCells = 0;
    let freeCells = 0;
    const touched = new Set();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const p = [x0 + (c + 0.5) * size, y0 + (r + 0.5) * size];
        if (!pointInRing(p, lotR)) continue;
        lotCells++;
        const bi = bldR.findIndex((ring) => pointInRing(p, ring));
        if (bi >= 0) {
          builtCells++;
          touched.add(bi);
          continue;
        }
        if (aduR.length && pointInRing(p, aduR)) {
          free[r * cols + c] = 1;
          freeCells++;
        }
      }
    }
    const cellSqft = size * size * SQM_TO_SQFT;

    const best = largestRectangle(free, cols, rows);
    const toLL = (p) => frame.toLonLat(unrot(p));
    const rectRing = (c0, c1, r0, r1) => {
      const ring = [
        [x0 + c0 * size, y0 + r0 * size],
        [x0 + c1 * size, y0 + r0 * size],
        [x0 + c1 * size, y0 + r1 * size],
        [x0 + c0 * size, y0 + r1 * size],
      ].map(toLL);
      ring.push(ring[0]);
      return ring;
    };

    // Open ground as merged row runs - few polygons, drawn without a stroke.
    const runs = [];
    const open = new Map();
    for (let r = 0; r <= rows; r++) {
      const rowRuns = [];
      if (r < rows) {
        let c = 0;
        while (c < cols) {
          if (!free[r * cols + c]) {
            c++;
            continue;
          }
          const s = c;
          while (c < cols && free[r * cols + c]) c++;
          rowRuns.push(`${s}:${c}`);
        }
      }
      const seen = new Set(rowRuns);
      open.forEach((v, k) => {
        if (!seen.has(k)) {
          runs.push(rectRing(v.c0, v.c1, v.r0, r));
          open.delete(k);
        }
      });
      rowRuns.forEach((k) => {
        if (!open.has(k)) {
          const [c0, c1] = k.split(":").map(Number);
          open.set(k, { c0, c1, r0: r });
        }
      });
    }

    const closeLL = (poly) => {
      const ring = poly.map(frame.toLonLat);
      if (ring.length) ring.push(ring[0]);
      return ring;
    };
    const largest =
      best.area > 0
        ? {
            wFt: Math.round((best.c1 - best.c0) * size * M_TO_FT),
            hFt: Math.round((best.r1 - best.r0) * size * M_TO_FT),
            sqft: Math.round(best.area * cellSqft),
            ring: rectRing(best.c0, best.c1, best.r0, best.r1),
          }
        : null;

    return {
      lotSqft: Math.round(lotArea * SQM_TO_SQFT),
      builtSqft: Math.round(builtCells * cellSqft),
      buildingCount: touched.size,
      freeSqft: Math.round(freeCells * cellSqft),
      gridCellFt: +(size * M_TO_FT).toFixed(1),
      largest,
      mainEnvelope: mainEnv.length ? closeLL(mainEnv) : null,
      aduOpen: runs,
      edges: edges.map((e) => ({
        role: e.role,
        lengthFt: Math.round(e.length * M_TO_FT),
        mainSetbackFt: Math.round(mainSet(e) * M_TO_FT * 10) / 10,
        aduSetbackFt: Math.round(aduSet(e) * M_TO_FT * 10) / 10,
        line: [frame.toLonLat(e.a), frame.toLonLat(e.b)],
      })),
      streetUnknown,
      assumptions,
    };
  }

  return { compute };
})();
