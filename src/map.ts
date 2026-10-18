import { mulberry32, type Rng } from './rng';

export type NodeKind = 'capital' | 'fort' | 'village';

export interface MapNode {
  id: number;
  x: number;
  y: number;
  kind: NodeKind;
  name: string;
}

export interface Edge {
  a: number;
  b: number;
  len: number;
}

export interface GraphMap {
  nodes: MapNode[];
  edges: Edge[];
  /** adj[n] lists neighbouring node ids. */
  adj: number[][];
  /** mirror[n] is the node opposite n under the map's point symmetry. */
  mirror: number[];
  capitals: [number, number];
  seed: number;
}

export const WORLD_W = 1600;
export const WORLD_H = 900;

export const NODE_STATS: Record<NodeKind, { growth: number; cap: number; defense: number; label: string }> = {
  capital: { growth: 1.0, cap: 70, defense: 1.5, label: 'Capital' },
  fort: { growth: 0.35, cap: 60, defense: 1.4, label: 'Fort' },
  village: { growth: 0.75, cap: 50, defense: 1.0, label: 'Village' },
};

const MIN_NODE_GAP = 200;
const MAX_EDGE = 520;
const EDGE_CLEARANCE = 60;
const MAX_DEGREE = 4;

const SYL_A = ['Ash', 'Bram', 'Cor', 'Dun', 'Eld', 'Fen', 'Gar', 'Hal', 'Iron', 'Kel', 'Lor', 'Mar', 'Nor', 'Os', 'Red', 'Stone', 'Thorn', 'Vel', 'Wex', 'Yar'];
const SYL_B = ['ford', 'hold', 'wick', 'mere', 'gate', 'moor', 'crest', 'fall', 'haven', 'reach', 'watch', 'stead', 'vale', 'barrow', 'march'];

export function edgeBetween(m: GraphMap, a: number, b: number): Edge | undefined {
  return m.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
}

function cross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** Proper intersection of segments p1-p2 and p3-p4 (shared endpoints do not count). */
function segmentsCross(p1: MapNode, p2: MapNode, p3: MapNode, p4: MapNode): boolean {
  if (p1 === p3 || p1 === p4 || p2 === p3 || p2 === p4) return false;
  const d1 = cross(p3.x, p3.y, p4.x, p4.y, p1.x, p1.y);
  const d2 = cross(p3.x, p3.y, p4.x, p4.y, p2.x, p2.y);
  const d3 = cross(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
  const d4 = cross(p1.x, p1.y, p2.x, p2.y, p4.x, p4.y);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function pointSegDist(px: number, py: number, a: MapNode, b: MapNode) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
}

function makeNames(rng: Rng, n: number): string[] {
  const out = new Set<string>();
  while (out.size < n) out.add(SYL_A[Math.floor(rng() * SYL_A.length)] + SYL_B[Math.floor(rng() * SYL_B.length)]);
  return [...out];
}

/** Shortest number of road hops between two nodes. */
export function hops(m: GraphMap, from: number, to: number): number {
  const dist = new Array(m.nodes.length).fill(-1);
  dist[from] = 0;
  const q = [from];
  while (q.length) {
    const n = q.shift()!;
    for (const k of m.adj[n]) {
      if (dist[k] < 0) {
        dist[k] = dist[n] + 1;
        q.push(k);
      }
    }
  }
  return dist[to];
}

function tryBuild(seed: number, count: number): GraphMap | null {
  const rng = mulberry32(seed);
  const W = WORLD_W;
  const H = WORLD_H;
  const mirrorPt = (p: { x: number; y: number }) => ({ x: W - p.x, y: H - p.y });
  const nodes: MapNode[] = [];
  const mirror: number[] = [];
  const add = (x: number, y: number, kind: NodeKind) => {
    nodes.push({ id: nodes.length, x, y, kind, name: '' });
    return nodes.length - 1;
  };
  const pair = (x: number, y: number, kind: NodeKind) => {
    const a = add(x, y, kind);
    const m = mirrorPt({ x, y });
    const b = add(m.x, m.y, kind);
    mirror[a] = b;
    mirror[b] = a;
  };

  // Capitals face each other across the map.
  pair(150 + rng() * 40, H / 2 + (rng() - 0.5) * 260, 'capital');
  const hasCenter = (count - 2) % 2 === 1;
  if (hasCenter) {
    const c = add(W / 2, H / 2, 'fort');
    mirror[c] = c;
  }
  const pairs = Math.floor((count - 2) / 2);
  const kinds: NodeKind[] = [];
  for (let i = 0; i < pairs; i++) kinds.push(i === 0 ? 'village' : i === 1 ? 'fort' : rng() < 0.55 ? 'village' : 'fort');
  for (const kind of kinds) {
    let placed = false;
    for (let attempt = 0; attempt < 400 && !placed; attempt++) {
      const x = 320 + rng() * 460;
      const y = 100 + rng() * (H - 200);
      const m = mirrorPt({ x, y });
      if (Math.hypot(x - m.x, y - m.y) < MIN_NODE_GAP) continue;
      if (nodes.some((n) => Math.hypot(n.x - x, n.y - y) < MIN_NODE_GAP || Math.hypot(n.x - m.x, n.y - m.y) < MIN_NODE_GAP)) continue;
      pair(x, y, kind);
      placed = true;
    }
    if (!placed) return null;
  }

  // Roads: shortest candidates first, added in mirrored pairs, never crossing and never
  // brushing past another node, never linking the two capitals directly.
  const edges: Edge[] = [];
  const deg = new Array(nodes.length).fill(0);
  const has = (a: number, b: number) => edges.some((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
  const cands: Edge[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      cands.push({ a: i, b: j, len: Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y) });
    }
  }
  cands.sort((p, q) => p.len - q.len);
  const caps = [0, 1];
  const ok = (e: Edge, others: Edge[]) => {
    if (e.len > MAX_EDGE) return false;
    if (caps.includes(e.a) && caps.includes(e.b)) return false;
    if (deg[e.a] >= MAX_DEGREE || deg[e.b] >= MAX_DEGREE) return false;
    for (const n of nodes) {
      if (n.id === e.a || n.id === e.b) continue;
      if (pointSegDist(n.x, n.y, nodes[e.a], nodes[e.b]) < EDGE_CLEARANCE) return false;
    }
    return !others.some((o) => segmentsCross(nodes[e.a], nodes[e.b], nodes[o.a], nodes[o.b]));
  };
  for (const e of cands) {
    if (has(e.a, e.b)) continue;
    const me: Edge = { a: mirror[e.a], b: mirror[e.b], len: e.len };
    const same = (me.a === e.a && me.b === e.b) || (me.a === e.b && me.b === e.a);
    if (!ok(e, edges)) continue;
    if (!same && (!ok(me, edges) || segmentsCross(nodes[e.a], nodes[e.b], nodes[me.a], nodes[me.b]))) continue;
    edges.push(e);
    deg[e.a]++;
    deg[e.b]++;
    if (!same) {
      edges.push(me);
      deg[me.a]++;
      deg[me.b]++;
    }
  }
  const adj: number[][] = nodes.map(() => []);
  for (const e of edges) {
    adj[e.a].push(e.b);
    adj[e.b].push(e.a);
  }
  const names = makeNames(rng, nodes.length);
  nodes.forEach((n, i) => (n.name = names[i]));
  const m: GraphMap = { nodes, edges, adj, mirror, capitals: [0, 1], seed };
  // Every node reachable, every node has a choice of roads, and the capitals are not next door.
  if (nodes.some((n) => hops(m, 0, n.id) < 0)) return null;
  if (nodes.some((n) => adj[n.id].length < 2)) return null;
  if (hops(m, 0, 1) < 3) return null;
  return m;
}

export function generateMap(seed: number, count: number): GraphMap {
  const n = Math.max(6, Math.min(10, Math.round(count)));
  for (let attempt = 0; attempt < 200; attempt++) {
    const m = tryBuild(seed * 7 + attempt * 104729, n);
    if (m) {
      m.seed = seed;
      return m;
    }
  }
  throw new Error(`Could not generate a ${n}-node map for seed ${seed}`);
}
