// Hand-drawn look for the caught-up spot illustrations (TID-073, docs/ux/brand.md section 8).
// Everything here is deterministic: the same drawing and seed always give the same SVG.
//
// A drawing is a list of strokes (point lists on a 480 x 480 canvas). Each stroke is turned into
// a wobbly, variable-width "ink" shape (a main pass and a thinner, looser second pass), and one
// irregular "paint" blob sits underneath, deliberately a little out of register with the lines.

export const SIZE = 480;

/** Small seeded PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r1 = (n) => Math.round(n * 10) / 10;

/** Catmull-Rom spline through `pts`, sampled about every `step` px. */
export function sample(pts, step = 3.5, closed = false) {
  const n = pts.length;
  if (n < 2) return pts.slice();
  const P = (i) => (closed ? pts[((i % n) + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  const out = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = P(i - 1);
    const p1 = P(i);
    const p2 = P(i + 1);
    const p3 = P(i + 2);
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const k = Math.max(2, Math.ceil(len / step));
    for (let j = 0; j < k; j++) {
      const t = j / k;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([
        0.5 *
          (2 * p1[0] +
            (-p0[0] + p2[0]) * t +
            (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
            (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 *
          (2 * p1[1] +
            (-p0[1] + p2[1]) * t +
            (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
            (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  if (!closed) out.push(pts[n - 1].slice());
  return out;
}

/** Smooth 1-D noise in about [-1, 1]: three sines with random phase. */
function noise1(rand) {
  const f = [rand() * 0.9 + 0.6, rand() * 1.7 + 1.6, rand() * 3 + 3.5];
  const p = [rand() * 6.28, rand() * 6.28, rand() * 6.28];
  const a = [0.6, 0.3, 0.14];
  return (t) =>
    (a[0] * Math.sin(f[0] * t + p[0]) +
      a[1] * Math.sin(f[1] * t + p[1]) +
      a[2] * Math.sin(f[2] * t + p[2])) /
    1.04;
}

/**
 * One stroke as a filled polygon: the path wobbles sideways by `wobble` px and the width
 * breathes by about 30 percent and tapers at both ends (a brush lifting off the paper).
 */
function inkShape(pts, width, wobble, rand, { closed = false, taper = 0.28 } = {}) {
  const base = sample(pts, 3.2, closed);
  if (base.length < 2) return '';
  // arc length
  const s = [0];
  for (let i = 1; i < base.length; i++) {
    s.push(s[i - 1] + Math.hypot(base[i][0] - base[i - 1][0], base[i][1] - base[i - 1][1]));
  }
  const total = s[s.length - 1] || 1;
  const nOff = noise1(rand);
  const nW = noise1(rand);
  const left = [];
  const right = [];
  for (let i = 0; i < base.length; i++) {
    const a = base[Math.max(0, i - 1)];
    const b = base[Math.min(base.length - 1, i + 1)];
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const d = Math.hypot(dx, dy) || 1;
    dx /= d;
    dy /= d;
    const nx = -dy;
    const ny = dx;
    const off = nOff(s[i] / 38) * wobble;
    const ramp = Math.min(1, Math.min(s[i], total - s[i]) / Math.min(26, total * 0.4));
    const tp = taper + (1 - taper) * Math.sin((ramp * Math.PI) / 2);
    const w = Math.max(0.5, (width * (1 + 0.3 * nW(s[i] / 21)) * (closed ? 1 : tp)) / 2);
    const cx = base[i][0] + nx * off;
    const cy = base[i][1] + ny * off;
    left.push([cx + nx * w, cy + ny * w]);
    right.push([cx - nx * w, cy - ny * w]);
  }
  const poly = left.concat(right.reverse());
  return 'M' + poly.map((p) => `${r1(p[0])} ${r1(p[1])}`).join('L') + 'Z';
}

/** Jitter control points so no two strokes sit exactly on the nominal line. */
function jitterPts(pts, amt, rand) {
  return pts.map(([x, y]) => [x + (rand() - 0.5) * 2 * amt, y + (rand() - 0.5) * 2 * amt]);
}

/** Extend the two ends of an open polyline along their direction (overshoot, like a quick pen). */
function overshoot(pts, a, b) {
  if (pts.length < 2) return pts;
  const out = pts.slice();
  const [p0, p1] = [pts[0], pts[1]];
  const [q0, q1] = [pts[pts.length - 1], pts[pts.length - 2]];
  const d0 = Math.hypot(p0[0] - p1[0], p0[1] - p1[1]) || 1;
  const d1 = Math.hypot(q0[0] - q1[0], q0[1] - q1[1]) || 1;
  out.unshift([p0[0] + ((p0[0] - p1[0]) / d0) * a, p0[1] + ((p0[1] - p1[1]) / d0) * a]);
  out.push([q0[0] + ((q0[0] - q1[0]) / d1) * b, q0[1] + ((q0[1] - q1[1]) / d1) * b]);
  return out;
}

// ---- point helpers used by the drawings -------------------------------------------------------

/** Points on an ellipse arc, angles in degrees (0 = right, 90 = down), optional rotation. */
export function arc(cx, cy, rx, ry, a0, a1, rot = 0, n) {
  const cnt = n ?? Math.max(3, Math.ceil(Math.abs(a1 - a0) / 22));
  const cr = Math.cos((rot * Math.PI) / 180);
  const sr = Math.sin((rot * Math.PI) / 180);
  const pts = [];
  for (let i = 0; i <= cnt; i++) {
    const a = ((a0 + ((a1 - a0) * i) / cnt) * Math.PI) / 180;
    const x = Math.cos(a) * rx;
    const y = Math.sin(a) * ry;
    pts.push([cx + x * cr - y * sr, cy + x * sr + y * cr]);
  }
  return pts;
}

/** A small dash radiating from (x, y) at `deg` degrees, from distance r0 to r1. */
export function ray(x, y, deg, r0, r1) {
  const c = Math.cos((deg * Math.PI) / 180);
  const s = Math.sin((deg * Math.PI) / 180);
  return [
    [x + c * r0, y + s * r0],
    [x + c * r1, y + s * r1],
  ];
}

/** A spark: three short rays fanned out around `deg`. */
export function burst(x, y, deg, r0 = 30, r1 = 58, spread = 26) {
  return [
    ray(x, y, deg - spread, r0, r1),
    ray(x, y, deg, r0 + 4, r1 + 10),
    ray(x, y, deg + spread, r0, r1),
  ];
}

/** A closed loop that overshoots its own start, like a hand closing a shape. */
export function loop(pts, over = 2) {
  return pts.concat(pts.slice(0, over).map(([x, y]) => [x + 2.5, y - 2]));
}

/** A little four-pointed twinkle drawn as a plus. */
export function twinkle(x, y, r) {
  return [
    [
      [x - r, y + 1],
      [x + r, y - 1],
    ],
    [
      [x + 1, y - r],
      [x - 1, y + r],
    ],
  ];
}

// ---- building an SVG ---------------------------------------------------------------------------

/**
 * drawing = {
 *   seed, blob: {cx, cy, rx, ry, dx, dy, lobes?}, strokes: [{pts, w?, loose?, over?, wobble?}]
 * }
 */
export function buildSvg(drawing, palette) {
  const rand = rng(drawing.seed);
  const paths = [];
  for (const st of drawing.strokes) {
    const w = (st.w ?? 5.2) * 1.32;
    let pts = st.pts;
    if (st.over !== false && !st.closed) pts = overshoot(pts, st.over ?? 4, st.over ?? 4);
    // main pass
    paths.push(
      inkShape(jitterPts(pts, 1.1, rand), w, st.wobble ?? 2.2, rand, { closed: !!st.closed }),
    );
    // looser, thinner second pass on longer strokes only
    const len = pts.reduce(
      (acc, p, i) => (i ? acc + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0),
      0,
    );
    if (st.loose !== false && len > 70) {
      paths.push(
        inkShape(jitterPts(pts, 3.2, rand), w * 0.42, (st.wobble ?? 2.2) * 1.8, rand, {
          closed: !!st.closed,
          taper: 0.15,
        }),
      );
    }
  }

  // paint blob: lobes around an ellipse with smooth radial noise
  const b = drawing.blob;
  const lobes = b.lobes ?? 11;
  const nr = noise1(rng(drawing.seed + 77));
  const bp = [];
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2;
    const k = 1 + 0.16 * nr(a * 1.7 + i * 0.35) + (rand() - 0.5) * 0.12;
    bp.push([b.cx + Math.cos(a) * b.rx * k, b.cy + Math.sin(a) * b.ry * k]);
  }
  const blobPath =
    'M' +
    sample(bp, 5, true)
      .map((p) => `${r1(p[0])} ${r1(p[1])}`)
      .join('L') +
    'Z';
  const extra = (b.extra ?? []).map((e) => {
    const lp = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const k = 1 + (rand() - 0.5) * 0.3;
      lp.push([e.cx + Math.cos(a) * e.rx * k, e.cy + Math.sin(a) * e.ry * k]);
    }
    return (
      'M' +
      sample(lp, 5, true)
        .map((p) => `${r1(p[0])} ${r1(p[1])}`)
        .join('L') +
      'Z'
    );
  });

  const s = drawing.seed;
  const P = palette;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="30 30 420 420" width="${SIZE}" height="${SIZE}">
<defs>
<filter id="paint" filterUnits="userSpaceOnUse" x="0" y="0" width="${SIZE}" height="${SIZE}" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="3" seed="${s}" result="warp"/>
<feDisplacementMap in="SourceGraphic" in2="warp" scale="16" xChannelSelector="R" yChannelSelector="G" result="shape"/>
<feTurbulence type="fractalNoise" baseFrequency="0.011 0.016" numOctaves="3" seed="${s + 3}" result="wash"/>
<feColorMatrix in="wash" type="matrix" values="0 0 0 0 ${P.washR} 0 0 0 0 ${P.washG} 0 0 0 0 ${P.washB} 0 0 0 2 -0.78" result="washTint"/>
<feComposite in="washTint" in2="shape" operator="in" result="washIn"/>
<feMorphology in="shape" operator="erode" radius="7" result="core"/>
<feGaussianBlur in="core" stdDeviation="5" result="coreSoft"/>
<feComposite in="shape" in2="coreSoft" operator="out" result="rim"/>
<feColorMatrix in="rim" type="matrix" values="0 0 0 0 ${P.rimR} 0 0 0 0 ${P.rimG} 0 0 0 0 ${P.rimB} 0 0 0 0.75 0" result="rimTint"/>
<feMerge result="painted"><feMergeNode in="shape"/><feMergeNode in="washIn"/><feMergeNode in="rimTint"/></feMerge>
<feTurbulence type="fractalNoise" baseFrequency="0.4" numOctaves="1" seed="${s + 9}" result="grain"/>
<feColorMatrix in="grain" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 10 -2.9" result="grainA"/>
<feComposite in="painted" in2="grainA" operator="in"/>
</filter>
<filter id="ink" filterUnits="userSpaceOnUse" x="0" y="0" width="${SIZE}" height="${SIZE}" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="2" seed="${s + 5}" result="w"/>
<feDisplacementMap in="SourceGraphic" in2="w" scale="3.2" xChannelSelector="R" yChannelSelector="G" result="rough"/>
<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="1" seed="${s + 11}" result="dry"/>
<feColorMatrix in="dry" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 12 -2.4" result="dryA"/>
<feComposite in="rough" in2="dryA" operator="in"/>
</filter>
</defs>
<g filter="url(#paint)" fill="${P.paint}"><path transform="translate(${b.dx ?? 0} ${b.dy ?? 0})" d="${blobPath}"/>${extra
    .map((d) => `<path transform="translate(${b.dx ?? 0} ${b.dy ?? 0})" d="${d}"/>`)
    .join('')}</g>
<g filter="url(#ink)" fill="${P.ink}">${paths.map((d) => `<path d="${d}"/>`).join('')}</g>
</svg>
`;
}

// Light: ink is the app's text colour; paint is a soft cornflower in the accent family.
// Dark: warm off-white ink; the paint is deepened so the pale line work still reads on it.
export const PALETTES = {
  light: {
    ink: '#1d1c1a',
    paint: '#b6c8f7',
    // wash / rim tints are given as 0..1 rgb for feColorMatrix
    washR: 0.3,
    washG: 0.45,
    washB: 0.85,
    rimR: 0.18,
    rimG: 0.31,
    rimB: 0.74,
  },
  dark: {
    ink: '#f1efe9',
    paint: '#4a6fdc',
    washR: 0.2,
    washG: 0.32,
    washB: 0.7,
    rimR: 0.16,
    rimG: 0.27,
    rimB: 0.62,
  },
};
