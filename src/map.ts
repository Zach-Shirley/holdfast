import { fbm, makeNoise, mulberry32, type Rng } from './rng';

export const WATER = 0;
export const PLAIN = 1;
export const FOREST = 2;
export const HILL = 3;
export const MOUNTAIN = 4;

/** Movement speed multiplier per terrain (0 = impassable). */
export const SPEED = [0, 1, 0.62, 0.75, 0];
/** Damage-taken multiplier for a unit standing on this terrain. */
export const DEFENSE = [1, 1, 0.75, 0.85, 1];
export const TERRAIN_NAME = ['Water', 'Plains', 'Forest', 'Hills', 'Mountains'];

export interface Pt {
  x: number;
  y: number;
}

export interface GameMap {
  w: number;
  h: number;
  terrain: Uint8Array;
  elev: Float32Array;
  /** Stronghold positions (cell centers) for team 0 and team 1. */
  hq: [Pt, Pt];
  seed: number;
  preset: string;
}

export interface MapPreset {
  id: string;
  name: string;
  desc: string;
  /** Mountain ridges per half, each broken by passes. */
  ridges: number;
  passes: [number, number];
  mountain: number;
  forest: number;
  /** Inland lake threshold (0 = no lakes). */
  lake: number;
}

export const PRESETS: MapPreset[] = [
  {
    id: 'passes',
    name: 'Mountain Passes',
    desc: 'Ridges split the land into lanes joined by narrow passes.',
    ridges: 2,
    passes: [2, 3],
    mountain: 0.74,
    forest: 0.6,
    lake: 0,
  },
  {
    id: 'lakes',
    name: 'Lake Country',
    desc: 'Scattered lakes and woods, many crooked routes.',
    ridges: 0,
    passes: [2, 3],
    mountain: 0.8,
    forest: 0.57,
    lake: 0.36,
  },
  {
    id: 'highlands',
    name: 'Highlands',
    desc: 'Broken mountain blocks with one long ridge and hills everywhere.',
    ridges: 1,
    passes: [3, 3],
    mountain: 0.71,
    forest: 0.62,
    lake: 0,
  },
  {
    id: 'open',
    name: 'Open Steppe',
    desc: 'Few obstacles. Control test: shows the continuous-front problem.',
    ridges: 0,
    passes: [2, 2],
    mountain: 0.86,
    forest: 0.64,
    lake: 0,
  },
];

export const MAP_W = 128;
export const MAP_H = 80;

export function idx(m: GameMap, x: number, y: number): number {
  return y * m.w + x;
}

export function inBounds(m: GameMap, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < m.w && y < m.h;
}

export function terrainAt(m: GameMap, x: number, y: number): number {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (!inBounds(m, cx, cy)) return WATER;
  return m.terrain[cy * m.w + cx];
}

export function passableCell(m: GameMap, cx: number, cy: number): boolean {
  return inBounds(m, cx, cy) && SPEED[m.terrain[cy * m.w + cx]] > 0;
}

export function passableAt(m: GameMap, x: number, y: number): boolean {
  return passableCell(m, Math.floor(x), Math.floor(y));
}

/** Nearest passable cell center to (x, y), searching outward in rings. */
export function nearestPassable(m: GameMap, x: number, y: number): Pt | null {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (passableCell(m, cx, cy)) return { x: cx + 0.5, y: cy + 0.5 };
  for (let r = 1; r < 20; r++) {
    let best: Pt | null = null;
    let bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (!passableCell(m, cx + dx, cy + dy)) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = { x: cx + dx + 0.5, y: cy + dy + 0.5 };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/** Flood fill over passable cells; returns reached mask. `blocked` cells are skipped. */
export function floodFrom(m: GameMap, start: Pt, blocked?: Uint8Array): Uint8Array {
  const seen = new Uint8Array(m.w * m.h);
  const sx = Math.floor(start.x);
  const sy = Math.floor(start.y);
  if (!passableCell(m, sx, sy)) return seen;
  if (blocked && blocked[sy * m.w + sx]) return seen;
  const queue = new Int32Array(m.w * m.h);
  let head = 0;
  let tail = 0;
  queue[tail++] = sy * m.w + sx;
  seen[sy * m.w + sx] = 1;
  while (head < tail) {
    const i = queue[head++];
    const x = i % m.w;
    const y = (i - x) / m.w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (!passableCell(m, nx, ny)) continue;
        // No diagonal squeezing between two impassable cells.
        if (dx && dy && (!passableCell(m, x + dx, y) || !passableCell(m, x, y + dy))) continue;
        const ni = ny * m.w + nx;
        if (seen[ni] || (blocked && blocked[ni])) continue;
        seen[ni] = 1;
        queue[tail++] = ni;
      }
    }
  }
  return seen;
}

/** Write a cell and its point-mirror so both halves stay identical. */
function setSym(t: Uint8Array, w: number, h: number, x: number, y: number, v: number) {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  t[y * w + x] = v;
  t[(h - 1 - y) * w + (w - 1 - x)] = v;
}

function carveRidges(t: Uint8Array, elev: Float32Array, w: number, h: number, preset: MapPreset, rng: Rng) {
  const wobble = makeNoise(rng);
  for (let r = 0; r < preset.ridges; r++) {
    const frac = preset.ridges === 1 ? 0.3 : 0.22 + (0.16 * r) / (preset.ridges - 1);
    const x0 = w * frac;
    const tilt = (rng() - 0.5) * 0.5;
    const nPasses = preset.passes[0] + Math.floor(rng() * (preset.passes[1] - preset.passes[0] + 1));
    // Spread passes along the ridge so no two are adjacent.
    const passes: [number, number][] = [];
    for (let p = 0; p < nPasses; p++) {
      const band = (h - 10) / nPasses;
      const center = 5 + band * p + band * (0.25 + rng() * 0.5);
      const half = 1.8 + rng() * 1.4;
      passes.push([center - half, center + half]);
    }
    const off = rng() * 100;
    for (let y = 0; y < h; y++) {
      const cx = x0 + (y - h / 2) * tilt + (wobble(y * 0.07, off) - 0.5) * 12;
      const thick = 1.4 + wobble(y * 0.15, off + 50) * 2.2;
      const inPass = passes.some(([a, b]) => y >= a && y <= b);
      for (let x = Math.floor(cx - thick - 3); x <= Math.ceil(cx + thick + 3); x++) {
        if (x < 0 || x >= w) continue;
        const i = y * w + x;
        const d = Math.abs(x + 0.5 - cx);
        // Raise the elevation around the ridge so the hillshade shows it as a range.
        const bump = Math.max(0, 1 - d / (thick + 3)) * 0.25;
        elev[i] = Math.min(1, elev[i] + bump);
        elev[(h - 1 - y) * w + (w - 1 - x)] = elev[i];
        if (t[i] === WATER) continue;
        if (inPass) {
          if (t[i] === MOUNTAIN && d < thick + 3) setSym(t, w, h, x, y, HILL);
        } else if (d <= thick) setSym(t, w, h, x, y, MOUNTAIN);
        else if (d <= thick + 1.5 && t[i] !== MOUNTAIN) setSym(t, w, h, x, y, HILL);
      }
    }
  }
}

function buildCandidate(seed: number, preset: MapPreset): GameMap {
  const w = MAP_W;
  const h = MAP_H;
  const rng = mulberry32(seed);
  const elevN = makeNoise(rng);
  const forestN = makeNoise(rng);
  const coastN = makeNoise(rng);
  const lakeN = makeNoise(rng);
  const t = new Uint8Array(w * h);
  const elev = new Float32Array(w * h);
  // Average each noise field with its point-mirror: symmetric and seamless.
  const sym = (f: (x: number, y: number) => number, x: number, y: number) => (f(x, y) + f(w - 1 - x, h - 1 - y)) / 2;
  const stretch = (v: number, k: number) => Math.max(0, Math.min(1, (v - 0.5) * k + 0.5));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const e = stretch(sym((a, b) => fbm(elevN, (a / w) * 5, (b / h) * 3.2, 4), x, y), 2.6);
      elev[i] = e;
      const dx = Math.abs((x + 0.5) / w - 0.5) * 2;
      const dy = Math.abs((y + 0.5) / h - 0.5) * 2;
      const d = Math.cbrt(dx ** 3 + dy ** 3);
      const coast = sym((a, b) => fbm(coastN, (a / w) * 6, (b / h) * 4, 3), x, y);
      if (d > 0.93 - (coast - 0.5) * 0.4) {
        t[i] = WATER;
        continue;
      }
      if (preset.lake > 0 && stretch(sym((a, b) => fbm(lakeN, (a / w) * 7, (b / h) * 4.5, 3), x, y), 2.2) < preset.lake - 0.12) {
        t[i] = WATER;
        continue;
      }
      const f = stretch(sym((a, b) => fbm(forestN, (a / w) * 9, (b / h) * 6, 3), x, y), 2.2);
      if (e > preset.mountain) t[i] = MOUNTAIN;
      else if (e > preset.mountain - 0.1) t[i] = HILL;
      else if (f > preset.forest) t[i] = FOREST;
      else t[i] = PLAIN;
    }
  }

  carveRidges(t, elev, w, h, preset, rng);

  // Stronghold for team 0 on the west side, mirrored for team 1; clear ground around both.
  const hq0: Pt = { x: 12.5, y: Math.floor(h / 2 + (rng() - 0.5) * h * 0.35) + 0.5 };
  for (let dy = -7; dy <= 7; dy++) {
    for (let dx = -7; dx <= 7; dx++) {
      const x = Math.floor(hq0.x) + dx;
      const y = Math.floor(hq0.y) + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const d = Math.hypot(dx, dy);
      const cur = t[y * w + x];
      if (d <= 4) setSym(t, w, h, x, y, PLAIN);
      else if (d <= 7 && (cur === WATER || cur === MOUNTAIN)) setSym(t, w, h, x, y, HILL);
    }
  }
  const hq1: Pt = { x: w - hq0.x, y: h - hq0.y };
  return { w, h, terrain: t, elev, hq: [hq0, hq1], seed, preset: preset.id };
}


/** True when the strongholds connect by at least two routes that are not within 3 cells of each other. */
export function hasTwoRoutes(m: GameMap, route: Pt[]): boolean {
  const blocked = new Uint8Array(m.w * m.h);
  for (const p of route) {
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const x = Math.floor(p.x) + dx;
        const y = Math.floor(p.y) + dy;
        if (!inBounds(m, x, y)) continue;
        if (Math.hypot(x + 0.5 - m.hq[0].x, y + 0.5 - m.hq[0].y) < 10) continue;
        if (Math.hypot(x + 0.5 - m.hq[1].x, y + 0.5 - m.hq[1].y) < 10) continue;
        blocked[y * m.w + x] = 1;
      }
    }
  }
  const seen = floodFrom(m, m.hq[0], blocked);
  return !!seen[idx(m, Math.floor(m.hq[1].x), Math.floor(m.hq[1].y))];
}

export function generateMap(seed: number, presetId: string, routeFinder: (m: GameMap, a: Pt, b: Pt) => Pt[] | null): GameMap {
  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];
  let fallback: GameMap | null = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    const m = buildCandidate(seed + attempt * 7919, preset);
    m.seed = seed;
    const route = routeFinder(m, m.hq[0], m.hq[1]);
    if (!route) continue;
    fallback ??= m;
    if (hasTwoRoutes(m, route)) return m;
  }
  if (fallback) return fallback;
  throw new Error(`Could not generate a connected map for seed ${seed}`);
}
