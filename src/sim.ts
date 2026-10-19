import { NODE_STATS, edgeBetween, type GraphMap } from './map';
import { mulberry32 } from './rng';

/** 0 = you, 1 = AI, 2 = neutral. */
export type Owner = 0 | 1 | 2;
export type Player = 0 | 1;

/** World pixels per second a column marches. */
export const COLUMN_SPEED = 55;
/** Battle losses per second for each side: (BASE + PER_TROOP * enemy troops) * enemy momentum * enemy defence. */
export const BASE_LOSS = 0.6;
export const PER_TROOP_LOSS = 0.045;
export const MOMENTUM_MIN = 0.5;
export const MOMENTUM_MAX = 4;
/** Multiplier on every quick-time success (tripled after playtest feedback, 2026-10-19). */
export const QTE_POWER = 3;
/** Momentum drifts back toward 1 at this rate per second. */
export const MOMENTUM_DECAY = 0.06;
/** War clock: when it runs out, whoever holds more strongholds wins (troops break ties). */
export const MATCH_TIME = 720;

export type QteKind = 'volley' | 'parry' | 'slash' | 'banner';

export interface NodeState {
  id: number;
  owner: Owner;
  troops: number;
  battleId: number | null;
}

export interface Column {
  id: number;
  owner: Player;
  troops: number;
  /** Node the column last left; it is walking the road from `from` to `path[0]`. */
  from: number;
  /** Remaining nodes to visit; the last one is the destination. */
  path: number[];
  /** Distance walked along the current road. */
  progress: number;
  edgeLen: number;
  battleId: number | null;
}

export interface Side {
  owner: Owner;
  troops: number;
  momentum: number;
  /** Road battles only: where this side was marching, so survivors can carry on. */
  march?: { from: number; path: number[]; progress: number; edgeLen: number };
}

export interface Battle {
  id: number;
  /** Node the battle is at, or null for a fight on a road. */
  nodeId: number | null;
  road: { a: number; b: number; pos: number; len: number } | null;
  x: number;
  y: number;
  sides: Side[];
  startedAt: number;
  endedAt: number | null;
  winner: Owner | null;
  /** Largest number of troops each owner had in the fight (for the end summary). */
  peak: Record<number, number>;
}

export interface GameEvent {
  kind: 'battle' | 'captured' | 'lost' | 'won' | 'held' | 'intercept' | 'qte';
  text: string;
  owner: Owner;
  x: number;
  y: number;
  t: number;
  battleId?: number;
}

export interface PlayerStats {
  battlesFought: number;
  battlesWon: number;
  qtePlayed: number;
  qteHit: number;
  troopsSent: number;
  nodesTaken: number;
}

export interface Game {
  map: GraphMap;
  nodes: NodeState[];
  columns: Column[];
  battles: Battle[];
  time: number;
  nextId: number;
  winner: Player | null;
  winReason: string;
  /** Which battle each commander is personally in (null when watching the map). */
  presence: [number | null, number | null];
  events: GameEvent[];
  stats: [PlayerStats, PlayerStats];
}

const emptyStats = (): PlayerStats => ({ battlesFought: 0, battlesWon: 0, qtePlayed: 0, qteHit: 0, troopsSent: 0, nodesTaken: 0 });

export function createGame(map: GraphMap): Game {
  const rng = mulberry32(map.seed ^ 0x51ed);
  const nodes: NodeState[] = map.nodes.map((n) => ({ id: n.id, owner: 2, troops: 0, battleId: null }));
  const [c0, c1] = map.capitals;
  nodes[c0].owner = 0;
  nodes[c1].owner = 1;
  nodes[c0].troops = nodes[c1].troops = 30;
  // Neutral garrisons, identical for mirrored nodes.
  for (const n of map.nodes) {
    if (n.kind === 'capital' || map.mirror[n.id] < n.id) continue;
    const t = Math.round(n.kind === 'fort' ? 14 + rng() * 6 : 7 + rng() * 6);
    nodes[n.id].troops = t;
    nodes[map.mirror[n.id]].troops = t;
  }
  return {
    map,
    nodes,
    columns: [],
    battles: [],
    time: 0,
    nextId: 1,
    winner: null,
    winReason: '',
    presence: [null, null],
    events: [],
    stats: [emptyStats(), emptyStats()],
  };
}

export const activeBattles = (g: Game) => g.battles.filter((b) => b.endedAt === null);
export const getBattle = (g: Game, id: number | null) => (id === null ? undefined : g.battles.find((b) => b.id === id));

export function battleName(g: Game, b: Battle): string {
  if (b.nodeId !== null) return `Battle of ${g.map.nodes[b.nodeId].name}`;
  const r = b.road!;
  return `Ambush on the ${g.map.nodes[r.a].name}–${g.map.nodes[r.b].name} road`;
}

export function sideOf(b: Battle, owner: Owner): Side | undefined {
  return b.sides.find((s) => s.owner === owner);
}

/** Defence multiplier for a side: the holder of a node fights from its walls. */
export function sideDefense(g: Game, b: Battle, s: Side): number {
  if (b.nodeId === null) return 1;
  return g.nodes[b.nodeId].owner === s.owner ? NODE_STATS[g.map.nodes[b.nodeId].kind].defense : 1;
}

/** Current loss rate per second of every side, keyed by owner. */
export function lossRates(g: Game, b: Battle): Map<Owner, number> {
  const rates = new Map<Owner, number>();
  for (const s of b.sides) rates.set(s.owner, 0);
  for (const o of b.sides) {
    if (o.troops <= 0) continue;
    const enemies = b.sides.filter((e) => e.owner !== o.owner && e.troops > 0);
    const enemyTotal = enemies.reduce((t, e) => t + e.troops, 0);
    if (!enemyTotal) continue;
    const out = (BASE_LOSS + PER_TROOP_LOSS * o.troops) * o.momentum * sideDefense(g, b, o);
    // Spread this side's damage over its enemies by size.
    for (const e of enemies) rates.set(e.owner, rates.get(e.owner)! + (out * e.troops) / enemyTotal);
  }
  return rates;
}

/** Shortest road route, avoiding nodes you do not own along the way where possible. */
export function route(g: Game, owner: Player, from: number, to: number): number[] | null {
  const m = g.map;
  const n = m.nodes.length;
  const dist = new Array(n).fill(Infinity);
  const prev = new Array(n).fill(-1);
  const done = new Array(n).fill(false);
  dist[from] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || u === to) break;
    done[u] = true;
    for (const v of m.adj[u]) {
      const e = edgeBetween(m, u, v)!;
      // Passing through a node you do not hold means a fight there, so prefer friendly ground.
      const toll = v !== to && g.nodes[v].owner !== owner ? 600 : 0;
      if (dist[u] + e.len + toll < dist[v]) {
        dist[v] = dist[u] + e.len + toll;
        prev[v] = u;
      }
    }
  }
  if (dist[to] === Infinity) return null;
  const path: number[] = [];
  for (let v = to; v !== from; v = prev[v]) path.unshift(v);
  return path;
}

/** Send `amount` troops from a node you hold. Returns the column, or null if nothing was sent. */
export function sendTroops(g: Game, owner: Player, from: number, to: number, amount: number): Column | null {
  const node = g.nodes[from];
  if (g.winner !== null || node.owner !== owner || node.battleId !== null || from === to) return null;
  const n = Math.min(Math.floor(amount), Math.floor(node.troops));
  if (n < 1) return null;
  const path = route(g, owner, from, to);
  if (!path || !path.length) return null;
  node.troops -= n;
  const col: Column = {
    id: g.nextId++,
    owner,
    troops: n,
    from,
    path,
    progress: 0,
    edgeLen: edgeBetween(g.map, from, path[0])!.len,
    battleId: null,
  };
  g.columns.push(col);
  g.stats[owner].troopsSent += n;
  return col;
}

export function columnPos(g: Game, c: Column): { x: number; y: number } {
  const a = g.map.nodes[c.from];
  const b = g.map.nodes[c.path[0]];
  const t = Math.min(1, c.progress / c.edgeLen);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Position of a column measured from the road's `a` end. */
function posOnRoad(c: Column, a: number): number {
  return c.from === a ? c.progress : c.edgeLen - c.progress;
}

function startBattle(g: Game, nodeId: number | null, road: Battle['road'], x: number, y: number, sides: Side[]): Battle {
  const b: Battle = { id: g.nextId++, nodeId, road, x, y, sides, startedAt: g.time, endedAt: null, winner: null, peak: {} };
  for (const s of sides) b.peak[s.owner] = s.troops;
  g.battles.push(b);
  for (const s of sides) if (s.owner !== 2) g.stats[s.owner].battlesFought++;
  return b;
}

function joinBattle(g: Game, b: Battle, owner: Owner, troops: number, march?: Side['march']) {
  let s = sideOf(b, owner);
  if (!s) {
    s = { owner, troops: 0, momentum: 1, march };
    b.sides.push(s);
    if (owner !== 2) g.stats[owner].battlesFought++;
  }
  s.troops += troops;
  if (march && !s.march) s.march = march;
  b.peak[owner] = Math.max(b.peak[owner] ?? 0, s.troops);
}

function event(g: Game, e: Omit<GameEvent, 't'>) {
  g.events.push({ ...e, t: g.time });
}

/** A column reaches the node at the end of its current road. */
function arrive(g: Game, c: Column): boolean {
  const at = c.path[0];
  const node = g.nodes[at];
  const mn = g.map.nodes[at];
  if (node.battleId !== null) {
    joinBattle(g, getBattle(g, node.battleId)!, c.owner, c.troops);
    return true;
  }
  if (node.owner === c.owner) {
    if (c.path.length === 1) {
      node.troops += c.troops;
      return true;
    }
    // Pass through and take the next road.
    c.from = at;
    c.path.shift();
    c.progress = 0;
    c.edgeLen = edgeBetween(g.map, at, c.path[0])!.len;
    return false;
  }
  const defender: Side = { owner: node.owner, troops: node.troops, momentum: 1 };
  node.troops = 0;
  const b = startBattle(g, at, null, mn.x, mn.y, [defender, { owner: c.owner, troops: c.troops, momentum: 1 }]);
  node.battleId = b.id;
  event(g, { kind: 'battle', text: `${c.owner === 0 ? 'You attack' : 'Enemy attacks'} ${mn.name}`, owner: c.owner, x: mn.x, y: mn.y, battleId: b.id });
  return true;
}

function endBattle(g: Game, b: Battle) {
  const alive = b.sides.filter((s) => s.troops > 0.5);
  const win = alive[0];
  b.endedAt = g.time;
  b.winner = win ? win.owner : null;
  for (const s of b.sides) if (s.owner !== 2 && win && s.owner === win.owner) g.stats[s.owner].battlesWon++;
  if (b.nodeId !== null) {
    const node = g.nodes[b.nodeId];
    const mn = g.map.nodes[b.nodeId];
    node.battleId = null;
    if (!win) {
      node.troops = 0;
      return;
    }
    const prevOwner = node.owner;
    node.owner = win.owner;
    node.troops = win.troops;
    if (prevOwner !== win.owner) {
      if (win.owner !== 2) g.stats[win.owner].nodesTaken++;
      if (win.owner === 0) event(g, { kind: 'captured', text: `You took ${mn.name}`, owner: 0, x: mn.x, y: mn.y });
      else if (prevOwner === 0) event(g, { kind: 'lost', text: `${mn.name} has fallen`, owner: 1, x: mn.x, y: mn.y });
      else event(g, { kind: 'captured', text: `Enemy took ${mn.name}`, owner: win.owner, x: mn.x, y: mn.y });
    } else if (win.owner === 0) event(g, { kind: 'held', text: `${mn.name} held`, owner: 0, x: mn.x, y: mn.y });
    return;
  }
  // Road battle: the survivors march on.
  if (win && win.march && win.owner !== 2) {
    g.columns.push({ id: g.nextId++, owner: win.owner, troops: win.troops, from: win.march.from, path: win.march.path, progress: win.march.progress, edgeLen: win.march.edgeLen, battleId: null });
    if (win.owner === 0) event(g, { kind: 'won', text: 'Your column broke through', owner: 0, x: b.x, y: b.y });
  }
}

/** Apply a quick-time event result for `owner` in battle `battleId`. Shared by the player and the AI. */
export function applyQte(g: Game, battleId: number, owner: Player, kind: QteKind, success: boolean): string {
  const b = getBattle(g, battleId);
  const me = b && sideOf(b, owner);
  g.stats[owner].qtePlayed++;
  if (success) g.stats[owner].qteHit++;
  if (!b || !me || b.endedAt !== null) return '';
  const enemies = b.sides.filter((s) => s.owner !== owner && s.troops > 0);
  const enemyTotal = enemies.reduce((t, s) => t + s.troops, 0);
  const kill = (frac: number) => {
    const k = (enemyTotal * frac + 1) * QTE_POWER;
    for (const e of enemies) e.troops -= (k * e.troops) / Math.max(1, enemyTotal);
    return Math.round(k);
  };
  const bump = (d: number) => (me.momentum = Math.max(MOMENTUM_MIN, Math.min(MOMENTUM_MAX, me.momentum + d)));
  switch (kind) {
    case 'volley':
      return success ? `Volley! ${kill(0.07)} down` : 'Volley missed';
    case 'parry':
      if (success) {
        bump(0.15 * QTE_POWER);
        return 'Charge parried';
      } else {
        const lost = me.troops * 0.07 + 1;
        me.troops -= lost;
        return `Charge broke through: −${Math.round(lost)}`;
      }
    case 'slash':
      bump(success ? 0.3 * QTE_POWER : -0.1);
      return success ? 'Line broken: momentum up' : 'Slash fumbled';
    case 'banner':
      if (!success) return 'Banner lost';
      bump(0.15 * QTE_POWER);
      return `Rallied to the banner: ${kill(0.04)} down`;
  }
}

/** Every troop a player has: garrisons, columns and soldiers in battles. */
export function totalTroops(g: Game, p: Player): number {
  let t = 0;
  for (const n of g.nodes) if (n.owner === p) t += n.troops;
  for (const c of g.columns) if (c.owner === p) t += c.troops;
  for (const b of activeBattles(g)) t += Math.max(0, sideOf(b, p)?.troops ?? 0);
  return t;
}

export function step(g: Game, dt: number) {
  if (g.winner !== null) return;
  g.time += dt;
  const m = g.map;

  // Garrisons grow while not under attack.
  for (const n of g.nodes) {
    if (n.owner === 2 || n.battleId !== null) continue;
    const st = NODE_STATS[m.nodes[n.id].kind];
    if (n.troops < st.cap) n.troops = Math.min(st.cap, n.troops + st.growth * dt);
    // Overfull garrisons desert: the excess drains off by 6% per second.
    else n.troops = Math.max(st.cap, n.troops - (n.troops - st.cap) * 0.06 * dt - 0.2 * dt);
  }

  // Columns march. Opposing columns meeting on a road fight there; columns reaching a road
  // battle join it.
  const roadBattles = activeBattles(g).filter((b) => b.road);
  for (const c of [...g.columns]) {
    if (c.battleId !== null) continue;
    const a = Math.min(c.from, c.path[0]);
    const before = posOnRoad(c, a);
    c.progress += COLUMN_SPEED * dt;
    const after = posOnRoad(c, a);
    const rb = roadBattles.find((b) => b.road!.a === a && b.road!.b === Math.max(c.from, c.path[0]) && (before - b.road!.pos) * (after - b.road!.pos) <= 0);
    if (rb) {
      joinBattle(g, rb, c.owner, c.troops, { from: c.from, path: c.path, progress: Math.min(c.progress, c.edgeLen), edgeLen: c.edgeLen });
      g.columns.splice(g.columns.indexOf(c), 1);
      continue;
    }
    if (c.progress >= c.edgeLen && arrive(g, c)) g.columns.splice(g.columns.indexOf(c), 1);
  }
  // Interceptions: two enemy columns on the same road walking toward each other.
  for (let i = 0; i < g.columns.length; i++) {
    for (let j = i + 1; j < g.columns.length; j++) {
      const p = g.columns[i];
      const q = g.columns[j];
      if (p.owner === q.owner || p.from !== q.path[0] || q.from !== p.path[0]) continue;
      if (p.progress + q.progress < p.edgeLen) continue;
      const a = Math.min(p.from, q.from);
      const pos = Math.min(p.edgeLen, posOnRoad(p, a));
      const at = columnPos(g, p);
      const march = (c: Column) => ({ from: c.from, path: c.path, progress: Math.min(c.progress, c.edgeLen), edgeLen: c.edgeLen });
      const b = startBattle(g, null, { a, b: Math.max(p.from, q.from), pos, len: p.edgeLen }, at.x, at.y, [
        { owner: p.owner, troops: p.troops, momentum: 1, march: march(p) },
        { owner: q.owner, troops: q.troops, momentum: 1, march: march(q) },
      ]);
      event(g, { kind: 'intercept', text: 'Columns clash on the road', owner: 2, x: at.x, y: at.y, battleId: b.id });
      g.columns.splice(j, 1);
      g.columns.splice(i, 1);
      i--;
      break;
    }
  }

  // Battles.
  for (const b of activeBattles(g)) {
    const rates = lossRates(g, b);
    for (const s of b.sides) {
      s.troops -= rates.get(s.owner)! * dt;
      s.momentum += (1 - s.momentum) * Math.min(1, MOMENTUM_DECAY * dt);
    }
    if (b.sides.filter((s) => s.troops > 0.5).length <= 1) endBattle(g, b);
  }

  // Victory: take the enemy capital, or leave them with nothing.
  const [c0, c1] = m.capitals;
  if (g.nodes[c1].owner === 0) {
    g.winner = 0;
    g.winReason = 'You took the enemy capital';
  } else if (g.nodes[c0].owner === 1) {
    g.winner = 1;
    g.winReason = 'Your capital fell';
  } else if (g.time >= MATCH_TIME) {
    const held = (p: Player) => g.nodes.filter((n) => n.owner === p).length;
    const troops = (p: Player) => totalTroops(g, p);
    const [h0, h1] = [held(0), held(1)];
    g.winner = h0 !== h1 ? (h0 > h1 ? 0 : 1) : troops(0) >= troops(1) ? 0 : 1;
    g.winReason = h0 !== h1 ? `Time: ${g.winner === 0 ? 'you' : 'the enemy'} held more strongholds (${Math.max(h0, h1)} to ${Math.min(h0, h1)})` : `Time: strongholds even, ${g.winner === 0 ? 'you' : 'the enemy'} had more troops`;
  } else {
    for (const p of [0, 1] as Player[]) {
      const hasNode = g.nodes.some((n) => n.owner === p);
      const hasCol = g.columns.some((c) => c.owner === p) || activeBattles(g).some((b) => (sideOf(b, p)?.troops ?? 0) > 0.5);
      if (!hasNode && !hasCol) {
        g.winner = (1 - p) as Player;
        g.winReason = p === 0 ? 'Your realm was wiped out' : 'The enemy realm was wiped out';
      }
    }
  }
  g.events = g.events.filter((e) => g.time - e.t < 8);
}
