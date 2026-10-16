import { SPEED, nearestPassable, passableCell, type GameMap, type Pt } from './map';

/** Binary min-heap keyed by f-score. */
class Heap {
  private items: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.items.length;
  }
  push(item: number, key: number) {
    this.items.push(item);
    this.keys.push(key);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): number {
    const top = this.items[0];
    const lastItem = this.items.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.items.length) {
      this.items[0] = lastItem;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let s = i;
        if (l < this.items.length && this.keys[l] < this.keys[s]) s = l;
        if (r < this.items.length && this.keys[r] < this.keys[s]) s = r;
        if (s === i) break;
        this.swap(i, s);
        i = s;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
  }
}

/**
 * A* over the terrain grid (8 directions, terrain-weighted). Returns the dense list of
 * cell centers from start to goal, or null when unreachable. `extra` adds per-cell cost.
 */
export function findCellPath(m: GameMap, from: Pt, to: Pt, extra?: Float32Array): Pt[] | null {
  const s = nearestPassable(m, from.x, from.y);
  const g = nearestPassable(m, to.x, to.y);
  if (!s || !g) return null;
  const sx = Math.floor(s.x);
  const sy = Math.floor(s.y);
  const gx = Math.floor(g.x);
  const gy = Math.floor(g.y);
  const n = m.w * m.h;
  const cost = new Float32Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new Heap();
  const start = sy * m.w + sx;
  const goal = gy * m.w + gx;
  cost[start] = 0;
  const h = (x: number, y: number) => {
    const dx = Math.abs(x - gx);
    const dy = Math.abs(y - gy);
    return Math.max(dx, dy) + 0.4142 * Math.min(dx, dy);
  };
  heap.push(start, h(sx, sy));
  while (heap.size) {
    const i = heap.pop();
    if (i === goal) break;
    if (closed[i]) continue;
    closed[i] = 1;
    const x = i % m.w;
    const y = (i - x) / m.w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (!passableCell(m, nx, ny)) continue;
        if (dx && dy && (!passableCell(m, x + dx, y) || !passableCell(m, x, y + dy))) continue;
        const ni = ny * m.w + nx;
        if (closed[ni]) continue;
        const step = (dx && dy ? 1.4142 : 1) / SPEED[m.terrain[ni]] + (extra ? extra[ni] : 0);
        const c = cost[i] + step;
        if (c < cost[ni]) {
          cost[ni] = c;
          came[ni] = i;
          heap.push(ni, c + h(nx, ny));
        }
      }
    }
  }
  if (start !== goal && came[goal] < 0) return null;
  const out: Pt[] = [];
  for (let i = goal; i >= 0; i = i === start ? -1 : came[i]) {
    const x = i % m.w;
    out.push({ x: x + 0.5, y: (i - x) / m.w + 0.5 });
  }
  out.reverse();
  return out;
}

/** Straight walk between two points stays on passable cells no slower than the start cell. */
function clearLine(m: GameMap, a: Pt, b: Pt): boolean {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.ceil(d / 0.25);
  const base = SPEED[m.terrain[Math.floor(a.y) * m.w + Math.floor(a.x)]];
  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    // Sample a small cross so units of radius ~0.4 do not clip corners.
    for (const [ox, oy] of [[0, 0], [0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35]]) {
      const cx = Math.floor(x + ox);
      const cy = Math.floor(y + oy);
      if (!passableCell(m, cx, cy)) return false;
      if (SPEED[m.terrain[cy * m.w + cx]] < base - 0.01) return false;
    }
  }
  return true;
}

/** Remove waypoints that can be skipped with a straight, clear walk. */
export function smoothPath(m: GameMap, pts: Pt[]): Pt[] {
  if (pts.length <= 2) return pts.slice();
  const out: Pt[] = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !clearLine(m, pts[i], pts[j])) j--;
    out.push(pts[j]);
    i = j;
  }
  return out;
}

/** Waypoints for a unit to walk from `from` to `to` (first point is dropped: the unit is there). */
export function findPath(m: GameMap, from: Pt, to: Pt): Pt[] | null {
  const cells = findCellPath(m, from, to);
  if (!cells) return null;
  const smooth = smoothPath(m, [{ x: from.x, y: from.y }, ...cells.slice(1)]);
  smooth.shift();
  // End exactly on the requested point when it is passable.
  if (smooth.length && passableCell(m, Math.floor(to.x), Math.floor(to.y))) {
    smooth[smooth.length - 1] = { x: to.x, y: to.y };
  }
  return smooth;
}
