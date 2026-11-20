// The twelve "you're done" motifs (TID-073). Coordinates are on a 480 x 480 canvas; the subject
// sits in roughly 60..420. `blob.dx/dy` push the paint off the line work on purpose.
import { arc, burst, loop, ray, sample, twinkle } from './lib.mjs';

const mirror = (pts, axis) => pts.map(([x, y]) => [2 * axis - x, y]);
const rot = (pts, cx, cy, deg) => {
  const c = Math.cos((deg * Math.PI) / 180);
  const s = Math.sin((deg * Math.PI) / 180);
  return pts.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]);
};
const S = (pts, extra = {}) => ({ pts, ...extra });
const rays = (list, w = 5) => list.map((p) => S(p, { w, loose: false, over: 0, wobble: 1 }));

/** A star outline, closed. */
function starPts(cx, cy, R, r, deg = -90) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = ((deg + i * 36) * Math.PI) / 180;
    const k = i % 2 ? r : R;
    pts.push([cx + Math.cos(a) * k, cy + Math.sin(a) * k]);
  }
  return pts;
}

/** A heart outline, closed. */
function heartPts(cx, cy, size) {
  const pts = [];
  for (let i = 0; i < 24; i++) {
    const t = (i / 24) * Math.PI * 2;
    const x = 16 * Math.sin(t) ** 3;
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    pts.push([cx + (x * size) / 16, cy + (y * size) / 16]);
  }
  return pts;
}

/** A leaf as a closed outline plus a midrib. */
function leaf(x, y, len, wid, deg) {
  const local = [
    [0, 0],
    [len * 0.22, -wid * 0.85],
    [len * 0.55, -wid],
    [len * 0.85, -wid * 0.5],
    [len, 0],
    [len * 0.85, wid * 0.5],
    [len * 0.55, wid],
    [len * 0.22, wid * 0.85],
  ].map(([a, b]) => [x + a, y + b]);
  return {
    outline: rot(local, x, y, deg),
    rib: rot(
      [
        [x + 6, y],
        [x + len * 0.5, y + 1],
        [x + len * 0.86, y],
      ],
      x,
      y,
      deg,
    ),
  };
}

/** Dashes along a curve. */
function dashed(pts, dash = 14, gap = 12) {
  const dense = sample(pts, 2);
  const out = [];
  let acc = 0;
  let cur = [];
  let on = true;
  for (let i = 1; i < dense.length; i++) {
    const d = Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]);
    if (on) cur.push(dense[i]);
    acc += d;
    if (on && acc >= dash) {
      if (cur.length > 1) out.push(cur.filter((_, k) => k % 3 === 0 || k === cur.length - 1));
      cur = [];
      acc = 0;
      on = false;
    } else if (!on && acc >= gap) {
      cur = [dense[i]];
      acc = 0;
      on = true;
    }
  }
  return out;
}

// ---- 1. clapping hands ----------------------------------------------------------------------
/** An upright open hand, base centre at (0, 0): scalloped finger tops and a thumb on the right. */
function handLocal() {
  const tips = [-196, -218, -224, -208];
  const out = [
    [-46, 6],
    [-54, -60],
    [-56, -140],
  ];
  tips.forEach((ty, k) => {
    const x = -41 + k * 27;
    out.push([x - 12, ty + 34], [x - 11, ty + 10], [x, ty], [x + 11, ty + 10]);
  });
  out.push([57, -150], [55, -70], [44, 6], [0, 18], [-46, 6]);
  return out;
}
const placeHand = (pts, x, y, deg) =>
  rot(
    pts.map(([a, b]) => [a + x, b + y]),
    x,
    y,
    deg,
  );
const handLeft = placeHand(handLocal(), 140, 400, 15);
const clap = {
  seed: 11,
  blob: { cx: 240, cy: 276, rx: 150, ry: 134, dx: 12, dy: 14 },
  strokes: [
    S(handLeft),
    S(mirror(handLeft, 240), { w: 6 }),
    ...rays(burst(240, 150, -90, 4, 38, 38)),
    ...rays([
      ray(70, 190, -150, 6, 36),
      ray(72, 226, 180, 6, 34),
      ray(410, 190, -30, 6, 36),
      ray(408, 226, 0, 6, 34),
    ]),
  ],
};

// ---- 2. smiling cat -------------------------------------------------------------------------
const catWhiskL = [
  [
    [134, 292],
    [66, 270],
  ],
  [
    [130, 314],
    [56, 316],
  ],
  [
    [138, 336],
    [74, 362],
  ],
];
const cat = {
  seed: 23,
  blob: { cx: 240, cy: 280, rx: 150, ry: 128, dx: -10, dy: 14 },
  strokes: [
    S(
      [
        [124, 222],
        [114, 150],
        [112, 108],
        [150, 132],
        [188, 164],
        [240, 158],
        [292, 164],
        [330, 132],
        [368, 108],
        [366, 150],
        [356, 222],
        [376, 290],
        [346, 356],
        [286, 392],
        [240, 396],
        [194, 392],
        [134, 356],
        [104, 290],
        [124, 226],
      ],
      { w: 6 },
    ),
    S(
      [
        [138, 150],
        [150, 190],
      ],
      { w: 4 },
    ),
    S(
      mirror(
        [
          [138, 150],
          [150, 190],
        ],
        240,
      ),
      { w: 4 },
    ),
    S(arc(182, 268, 26, 22, 195, 345), { w: 6 }),
    S(arc(298, 268, 26, 22, 195, 345), { w: 6 }),
    S(
      [
        [224, 304],
        [256, 304],
        [240, 320],
        [224, 304],
      ],
      { w: 5, over: 0 },
    ),
    S(
      [
        [240, 320],
        [240, 334],
      ],
      { w: 4.4, over: 0 },
    ),
    S(
      [
        [206, 326],
        [222, 346],
        [240, 334],
        [258, 346],
        [274, 326],
      ],
      { w: 5 },
    ),
    S(
      [
        [150, 316],
        [158, 322],
      ],
      { w: 9, over: 0, loose: false },
    ),
    S(
      [
        [330, 316],
        [322, 322],
      ],
      { w: 9, over: 0, loose: false },
    ),
    ...catWhiskL.map((p) => S(p, { w: 3.8, loose: false })),
    ...catWhiskL.map((p) => S(mirror(p, 240), { w: 3.8, loose: false })),
    ...twinkle(400, 190, 14).map((p) => S(p, { w: 4, over: 0, loose: false })),
  ],
};

// ---- 3. trophy ------------------------------------------------------------------------------
const handle = [
  [166, 142],
  [116, 138],
  [92, 176],
  [112, 222],
  [172, 244],
];
const trophy = {
  seed: 37,
  blob: { cx: 240, cy: 270, rx: 140, ry: 150, dx: 14, dy: 12 },
  strokes: [
    S(
      [
        [150, 124],
        [330, 126],
      ],
      { w: 6 },
    ),
    S(
      [
        [156, 128],
        [164, 202],
        [196, 256],
        [240, 276],
        [284, 256],
        [316, 202],
        [324, 128],
      ],
      { w: 6 },
    ),
    S(handle),
    S(mirror(handle, 240)),
    S(
      [
        [226, 274],
        [222, 330],
      ],
      { w: 5 },
    ),
    S(
      [
        [254, 274],
        [258, 330],
      ],
      { w: 5 },
    ),
    S(
      loop([
        [180, 330],
        [300, 332],
        [312, 376],
        [168, 374],
        [180, 330],
      ]),
      { w: 5.6 },
    ),
    S(
      [
        [150, 402],
        [334, 400],
      ],
      { w: 6.5 },
    ),
    S(starPts(240, 196, 32, 14), { w: 4.6, closed: true }),
    S(
      [
        [188, 152],
        [192, 204],
        [208, 238],
      ],
      { w: 4, over: 0 },
    ),
    ...twinkle(98, 96, 16).map((p) => S(p, { w: 4, over: 0, loose: false })),
    ...twinkle(388, 92, 12).map((p) => S(p, { w: 4, over: 0, loose: false })),
    ...rays(burst(402, 300, -30, 6, 28, 40), 4.6),
  ],
};

// ---- 4. OK hand -----------------------------------------------------------------------------
function finger(x, y, len, w, deg) {
  const local = [
    [0, 0],
    [0, -len + w / 2],
    [w * 0.12, -len + w * 0.05],
    [w / 2, -len - w * 0.05],
    [w * 0.88, -len + w * 0.05],
    [w, -len + w / 2],
    [w, 0],
  ].map(([a, b]) => [x + a, y + b]);
  return rot(local, x, y, deg);
}
const ok = {
  seed: 41,
  blob: { cx: 236, cy: 270, rx: 150, ry: 140, dx: 14, dy: 10 },
  strokes: [
    // ring made by thumb and index finger
    S(arc(172, 232, 62, 62, 10, 372), { w: 6 }),
    S(arc(172, 232, 32, 32, 40, 360), { w: 4.2, loose: false }),
    // three fingers
    S(finger(232, 228, 148, 40, -10)),
    S(finger(278, 244, 128, 38, 4)),
    S(finger(320, 270, 100, 34, 14)),
    // palm and wrist
    S(
      [
        [124, 280],
        [112, 340],
        [138, 404],
        [212, 420],
        [292, 406],
        [346, 372],
        [362, 316],
      ],
      { w: 6 },
    ),
    S(
      [
        [214, 250],
        [226, 322],
        [250, 350],
      ],
      { w: 4.2 },
    ),
    ...rays(burst(124, 140, -140, 12, 40, 30), 4.6),
  ],
};

// ---- 5. coffee ------------------------------------------------------------------------------
const coffee = {
  seed: 53,
  blob: { cx: 236, cy: 290, rx: 152, ry: 126, dx: -12, dy: 12 },
  strokes: [
    S(loop(arc(226, 252, 100, 20, 0, 360, 0, 16), 3), { w: 6 }),
    S(
      [
        [128, 262],
        [140, 340],
        [182, 386],
        [226, 392],
        [272, 386],
        [314, 340],
        [326, 262],
      ],
      { w: 6 },
    ),
    S(
      [
        [328, 282],
        [372, 276],
        [394, 308],
        [368, 346],
        [316, 350],
      ],
      { w: 5.4 },
    ),
    S(arc(226, 396, 150, 20, 8, 172), { w: 5.4 }),
    S(heartPts(226, 322, 34).concat([[226 + 1, 322 - 3]]), { w: 4.4, closed: true }),
    S(
      [
        [182, 218],
        [168, 190],
        [194, 160],
        [178, 122],
      ],
      { w: 4.6 },
    ),
    S(
      [
        [228, 216],
        [214, 184],
        [240, 150],
        [224, 104],
      ],
      { w: 4.6 },
    ),
    S(
      [
        [272, 218],
        [258, 192],
        [284, 164],
        [270, 130],
      ],
      { w: 4.6 },
    ),
    ...twinkle(380, 150, 14).map((p) => S(p, { w: 4, over: 0, loose: false })),
  ],
};

// ---- 6. paper plane -------------------------------------------------------------------------
const plane = {
  seed: 67,
  blob: { cx: 252, cy: 232, rx: 154, ry: 118, dx: -10, dy: 20, lobes: 12 },
  strokes: [
    S(
      loop([
        [84, 232],
        [406, 108],
        [236, 382],
        [202, 292],
        [84, 232],
      ]),
      { w: 6 },
    ),
    S(
      [
        [202, 292],
        [406, 108],
      ],
      { w: 5 },
    ),
    S(
      [
        [202, 292],
        [268, 324],
        [236, 382],
      ],
      { w: 4.6 },
    ),
    S(
      [
        [150, 258],
        [196, 290],
      ],
      { w: 4, over: 0 },
    ),
    ...dashed(
      [
        [46, 420],
        [96, 384],
        [126, 340],
        [160, 352],
        [150, 392],
        [116, 376],
        [180, 330],
        [218, 316],
      ],
      18,
      14,
    ).map((p) => S(p, { w: 4.6, over: 0, loose: false, wobble: 0.6 })),
    ...rays([ray(416, 150, -30, 6, 30), ray(422, 182, 10, 8, 30)], 4.6),
    ...twinkle(120, 120, 14).map((p) => S(p, { w: 4, over: 0, loose: false })),
  ],
};

// ---- 7. sun in sunglasses -------------------------------------------------------------------
const sunRays = [];
for (let i = 0; i < 12; i++) {
  const a = i * 30 + 8;
  sunRays.push(ray(240, 240, a, 128, i % 2 ? 160 : 176));
}
const sun = {
  seed: 79,
  blob: { cx: 240, cy: 244, rx: 120, ry: 116, dx: 16, dy: 14 },
  strokes: [
    S(loop(arc(240, 240, 94, 92, -100, 252, 8, 20), 2), { w: 6 }),
    ...rays(sunRays, 6),
    // sunglasses
    S(
      loop([
        [162, 214],
        [226, 212],
        [222, 252],
        [194, 262],
        [166, 250],
        [162, 214],
      ]),
      { w: 6 },
    ),
    S(
      loop([
        [254, 212],
        [318, 214],
        [314, 250],
        [286, 262],
        [258, 252],
        [254, 212],
      ]),
      { w: 6 },
    ),
    S(
      [
        [226, 220],
        [254, 220],
      ],
      { w: 5 },
    ),
    S(
      [
        [162, 216],
        [140, 204],
      ],
      { w: 4.6 },
    ),
    S(
      [
        [318, 216],
        [340, 204],
      ],
      { w: 4.6 },
    ),
    S(
      [
        [176, 222],
        [194, 234],
      ],
      { w: 3.4, loose: false, over: 0 },
    ),
    S(
      [
        [268, 222],
        [286, 234],
      ],
      { w: 3.4, loose: false, over: 0 },
    ),
    S(arc(240, 270, 46, 34, 20, 160), { w: 5.4 }),
  ],
};

// ---- 8. party popper ------------------------------------------------------------------------
const confetti = [
  [
    [330, 90],
    [344, 84],
    [350, 100],
  ],
  [
    [400, 150],
    [414, 146],
    [412, 162],
    [398, 164],
  ],
  [
    [110, 150],
    [124, 140],
    [128, 156],
  ],
  [
    [420, 250],
    [436, 254],
  ],
  [
    [88, 260],
    [100, 250],
    [110, 264],
  ],
];
const popper = {
  seed: 83,
  blob: { cx: 252, cy: 268, rx: 150, ry: 140, dx: -14, dy: 8 },
  strokes: [
    S(
      [
        [78, 428],
        [176, 218],
      ],
      { w: 6 },
    ),
    S(
      [
        [78, 428],
        [276, 312],
      ],
      { w: 6 },
    ),
    S(loop(arc(226, 266, 68, 26, 0, 360, 40, 14), 2), { w: 5.6 }),
    S(
      [
        [110, 360],
        [176, 398],
      ],
      { w: 4.6 },
    ),
    S(
      [
        [140, 304],
        [214, 346],
      ],
      { w: 4.6 },
    ),
    S(
      [
        [168, 258],
        [236, 292],
      ],
      { w: 4.2 },
    ),
    S(
      [
        [236, 234],
        [250, 176],
        [316, 186],
        [320, 124],
        [372, 118],
      ],
      { w: 4.8 },
    ),
    S(
      [
        [262, 262],
        [318, 248],
        [336, 292],
        [398, 272],
        [420, 304],
      ],
      { w: 4.8 },
    ),
    S(
      [
        [222, 228],
        [196, 170],
        [226, 118],
        [204, 70],
      ],
      { w: 4.8 },
    ),
    ...confetti.map((p) => S(p, { w: 4.2, over: 0, loose: false, wobble: 0.8 })),
    S(starPts(392, 206, 17, 7), { w: 3.8, closed: true, loose: false }),
    S(starPts(120, 150, 16, 7), { w: 3.8, closed: true, loose: false }),
    S(starPts(280, 90, 12, 5), { w: 3.6, closed: true, loose: false }),
  ],
};

// ---- 9. thumbs up ---------------------------------------------------------------------------
const thumbs = {
  seed: 97,
  blob: { cx: 244, cy: 266, rx: 150, ry: 142, dx: 12, dy: 14 },
  strokes: [
    // cuff
    S(
      loop([
        [96, 252],
        [150, 246],
        [160, 404],
        [104, 410],
        [96, 252],
      ]),
      { w: 6 },
    ),
    // thumb and back of the hand
    S(
      [
        [158, 262],
        [196, 236],
        [226, 178],
        [236, 112],
        [264, 96],
        [290, 122],
        [284, 188],
        [276, 226],
        [346, 228],
        [378, 252],
        [372, 290],
      ],
      { w: 6 },
    ),
    // finger pills
    S(
      [
        [372, 290],
        [388, 318],
        [366, 344],
        [356, 346],
      ],
      { w: 5.2 },
    ),
    S(
      [
        [356, 346],
        [376, 372],
        [352, 398],
      ],
      { w: 5.2 },
    ),
    S(
      [
        [352, 398],
        [336, 416],
        [290, 422],
        [226, 412],
        [162, 404],
      ],
      { w: 5.6 },
    ),
    S(
      [
        [182, 292],
        [340, 290],
      ],
      { w: 4.4 },
    ),
    S(
      [
        [182, 340],
        [332, 344],
      ],
      { w: 4.4 },
    ),
    S(
      [
        [178, 382],
        [320, 390],
      ],
      { w: 4.4 },
    ),
    S(
      [
        [206, 220],
        [222, 246],
      ],
      { w: 4, over: 0 },
    ),
    ...rays(burst(360, 100, -40, 8, 40, 32), 4.6),
    ...rays([ray(90, 210, -150, 6, 34)], 4.6),
  ],
};

// ---- 10. sleeping dog -----------------------------------------------------------------------
const earL = [
  [154, 202],
  [108, 224],
  [92, 290],
  [104, 346],
  [146, 354],
  [168, 296],
];
const zed = (x, y, s) => [
  [x, y],
  [x + s, y - 2],
  [x - 2, y + s],
  [x + s + 2, y + s - 2],
];
const dog = {
  seed: 109,
  blob: { cx: 238, cy: 290, rx: 150, ry: 124, dx: 10, dy: 14 },
  strokes: [
    S(
      [
        [160, 194],
        [210, 168],
        [262, 166],
        [318, 194],
        [346, 252],
        [338, 320],
        [296, 384],
        [240, 398],
        [184, 384],
        [142, 320],
        [134, 252],
        [162, 196],
      ],
      { w: 6 },
    ),
    S(earL, { w: 5.6 }),
    S(mirror(earL, 240), { w: 5.6 }),
    S(
      [
        [116, 252],
        [128, 326],
      ],
      { w: 3.6, over: 0 },
    ),
    S(arc(190, 262, 24, 14, 12, 168), { w: 5.8 }),
    S(arc(290, 262, 24, 14, 12, 168), { w: 5.8 }),
    S(
      [
        [220, 308],
        [260, 308],
      ],
      { w: 24, over: 0, loose: false, wobble: 0.6 },
    ),
    S(
      [
        [240, 318],
        [240, 340],
      ],
      { w: 4.4, over: 0 },
    ),
    S(
      [
        [196, 338],
        [216, 356],
        [240, 340],
        [264, 356],
        [284, 338],
      ],
      { w: 5 },
    ),
    S(
      [
        [234, 356],
        [236, 384],
        [254, 384],
        [256, 356],
      ],
      { w: 4.2, over: 0 },
    ),
    S(zed(332, 138, 26), { w: 5, over: 0, loose: false }),
    S(zed(374, 90, 34), { w: 5.4, over: 0, loose: false }),
    S(zed(300, 168, 16), { w: 4.4, over: 0, loose: false }),
  ],
};

// ---- 11. medal ------------------------------------------------------------------------------
const medal = {
  seed: 127,
  blob: { cx: 240, cy: 276, rx: 128, ry: 140, dx: -12, dy: 12 },
  strokes: [
    S(
      loop([
        [150, 56],
        [208, 56],
        [262, 210],
        [206, 222],
        [150, 56],
      ]),
      { w: 5.6 },
    ),
    S(
      loop([
        [330, 56],
        [272, 56],
        [218, 210],
        [274, 222],
        [330, 56],
      ]),
      { w: 5.6 },
    ),
    S(loop(arc(240, 306, 98, 98, -90, 270, 0, 18), 2), { w: 6 }),
    S(arc(240, 306, 76, 76, -60, 250), { w: 3.8, loose: false }),
    S(starPts(240, 306, 50, 22), { w: 5.2, closed: true }),
    ...twinkle(96, 190, 14).map((p) => S(p, { w: 4, over: 0, loose: false })),
    ...twinkle(392, 150, 18).map((p) => S(p, { w: 4, over: 0, loose: false })),
    ...rays(burst(400, 360, 20, 6, 30, 38), 4.4),
  ],
};

// ---- 12. potted plant with a smile ----------------------------------------------------------
const leaves = [
  leaf(240, 320, 186, 30, -90),
  leaf(236, 322, 156, 28, -56),
  leaf(244, 322, 156, 28, -124),
  leaf(230, 326, 120, 24, -22),
  leaf(250, 326, 120, 24, -158),
];
const plant = {
  seed: 139,
  blob: { cx: 240, cy: 276, rx: 136, ry: 150, dx: 12, dy: 12 },
  strokes: [
    ...leaves.flatMap((l) => [
      S(l.outline, { w: 5, closed: true }),
      S(l.rib, { w: 3.6, loose: false }),
    ]),
    S(
      [
        [150, 322],
        [330, 324],
      ],
      { w: 6.5 },
    ),
    S(
      loop([
        [166, 326],
        [314, 328],
        [296, 424],
        [184, 424],
        [166, 326],
      ]),
      { w: 6 },
    ),
    S(
      [
        [210, 366],
        [212, 374],
      ],
      { w: 10, over: 0, loose: false },
    ),
    S(
      [
        [270, 366],
        [272, 374],
      ],
      { w: 10, over: 0, loose: false },
    ),
    S(arc(241, 384, 20, 12, 15, 165), { w: 4.6 }),
    ...twinkle(104, 140, 14).map((p) => S(p, { w: 4, over: 0, loose: false })),
    ...twinkle(392, 120, 12).map((p) => S(p, { w: 4, over: 0, loose: false })),
  ],
};

/** name -> drawing. Names are the PNG file stems. */
export const DRAWINGS = {
  clap,
  cat,
  trophy,
  ok,
  coffee,
  plane,
  sun,
  popper,
  thumbs,
  dog,
  medal,
  plant,
};
