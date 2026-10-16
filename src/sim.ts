import { DEFENSE, SPEED, floodFrom, nearestPassable, passableAt, terrainAt, type GameMap, type Pt } from './map';
import { findPath } from './path';

export type Team = 0 | 1;
export type Kind = 'melee' | 'ranged';
export type Composition = 'mixed' | 'melee' | 'ranged';

export const UNIT_STATS: Record<Kind, { hp: number; dps: number; range: number; meleeDps: number; speed: number }> = {
  melee: { hp: 100, dps: 5, range: 1.9, meleeDps: 5, speed: 2.6 },
  ranged: { hp: 70, dps: 3.4, range: 7.5, meleeDps: 2.2, speed: 2.6 },
};

/** Centre-to-centre distance at which two units are in melee contact. */
export const CONTACT = 1.9;
/** Enemy units inside this radius slow movement (zone of control). */
export const ZOC = 3.6;
export const ZOC_SLOW = 0.5;
export const CONTACT_SLOW = 0.35;
/** Cells within this radius of an enemy unit block supply. */
export const SUPPLY_BLOCK = 2.6;
/** A unit is supplied when a supplied cell lies within this radius. */
export const SUPPLY_REACH = 3.2;
export const HQ_RADIUS = 3.4;
export const HQ_HEAL_RADIUS = 9;
export const CAPTURE_TIME = 12;
/** The stronghold's own garrison shoots the nearest attacker on or near its grounds. */
export const GARRISON_DPS = 4;
export const GARRISON_RANGE = HQ_RADIUS + 1.5;
export const STRIKE_CD = 12;
export const RALLY_CD = 14;
export const STRIKE_DURATION = 8;
const SEPARATION = 1.5;

export interface Unit {
  id: number;
  team: Team;
  kind: Kind;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  path: Pt[];
  targetId: number | null;
  contact: boolean;
  inZoc: boolean;
  supplied: boolean;
  buffMul: number;
  buffUntil: number;
  strikeReadyAt: number;
  rallyReadyAt: number;
  lastHitAt: number;
  shotCd: number;
  stall: number;
  alive: boolean;
}

export interface GameEvent {
  kind: 'shot' | 'death' | 'strike' | 'rally' | 'cut';
  team: Team;
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  t: number;
  value?: number;
}

export interface TeamStats {
  minigames: number;
  perfect: number;
  good: number;
  miss: number;
  healed: number;
  lost: number;
}

export interface Game {
  map: GameMap;
  units: Unit[];
  time: number;
  nextId: number;
  winner: Team | null;
  winReason: string;
  /** Capture progress (seconds) against each team's stronghold. */
  capture: [number, number];
  supply: [Uint8Array, Uint8Array];
  supplyTimer: number;
  garrisonCd: [number, number];
  events: GameEvent[];
  stats: [TeamStats, TeamStats];
}

export interface GameOptions {
  armySize: number;
  composition: Composition;
}

const emptyStats = (): TeamStats => ({ minigames: 0, perfect: 0, good: 0, miss: 0, healed: 0, lost: 0 });

function makeUnit(id: number, team: Team, kind: Kind, p: Pt): Unit {
  const s = UNIT_STATS[kind];
  return {
    id,
    team,
    kind,
    x: p.x,
    y: p.y,
    hp: s.hp,
    maxHp: s.hp,
    path: [],
    targetId: null,
    contact: false,
    inZoc: false,
    supplied: true,
    buffMul: 1,
    buffUntil: -1,
    strikeReadyAt: 0,
    rallyReadyAt: 0,
    lastHitAt: -99,
    shotCd: 0,
    stall: 0,
    alive: true,
  };
}

/** Deployment slots in front of the west stronghold, farthest first. */
function deploySlots(map: GameMap, n: number): Pt[] {
  const hq = map.hq[0];
  let dx = map.w / 2 - hq.x;
  let dy = map.h / 2 - hq.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const px = -dy;
  const py = dx;
  const perRow = 6;
  const rows = Math.ceil(n / perRow);
  const taken = new Set<string>();
  const out: Pt[] = [];
  for (let r = rows - 1; r >= 0; r--) {
    const inRow = Math.min(perRow, n - r * perRow);
    for (let c = 0; c < inRow; c++) {
      const col = c - (inRow - 1) / 2;
      const dist = 5 + 2.2 * r;
      const raw = { x: hq.x + dx * dist + px * col * 2.2, y: hq.y + dy * dist + py * col * 2.2 };
      let p = nearestPassable(map, raw.x, raw.y) ?? { x: hq.x, y: hq.y };
      // Avoid stacking two units on one cell.
      let guard = 0;
      while (taken.has(`${Math.floor(p.x)},${Math.floor(p.y)}`) && guard++ < 12) {
        p = nearestPassable(map, p.x + (guard % 3) - 1, p.y + Math.floor(guard / 3) - 1) ?? p;
      }
      taken.add(`${Math.floor(p.x)},${Math.floor(p.y)}`);
      out.push(p);
    }
  }
  return out;
}

export function createGame(map: GameMap, opts: GameOptions): Game {
  const g: Game = {
    map,
    units: [],
    time: 0,
    nextId: 1,
    winner: null,
    winReason: '',
    capture: [0, 0],
    supply: [new Uint8Array(map.w * map.h), new Uint8Array(map.w * map.h)],
    supplyTimer: 0,
    garrisonCd: [0, 0],
    events: [],
    stats: [emptyStats(), emptyStats()],
  };
  const n = opts.armySize;
  const ranged = opts.composition === 'ranged' ? n : opts.composition === 'melee' ? 0 : Math.round(n * 0.4);
  const slots = deploySlots(map, n);
  for (let k = 0; k < n; k++) {
    // Melee take the forward slots, ranged fill in behind.
    const kind: Kind = k < n - ranged ? 'melee' : 'ranged';
    const p = slots[k];
    g.units.push(makeUnit(g.nextId++, 0, kind, p));
    // Mirror for team 1 so deployments are identical under the map's point symmetry.
    g.units.push(makeUnit(g.nextId++, 1, kind, { x: map.w - p.x, y: map.h - p.y }));
  }
  updateSupply(g);
  return g;
}

export const getUnit = (g: Game, id: number) => g.units.find((u) => u.id === id && u.alive);
export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
export const isBuffed = (g: Game, u: Unit) => u.buffUntil > g.time;

export function updateSupply(g: Game) {
  const m = g.map;
  for (const team of [0, 1] as Team[]) {
    const blocked = new Uint8Array(m.w * m.h);
    const hq = m.hq[team];
    const r = Math.ceil(SUPPLY_BLOCK);
    for (const e of g.units) {
      if (!e.alive || e.team === team) continue;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const cx = Math.floor(e.x) + dx;
          const cy = Math.floor(e.y) + dy;
          if (cx < 0 || cy < 0 || cx >= m.w || cy >= m.h) continue;
          if (Math.hypot(cx + 0.5 - e.x, cy + 0.5 - e.y) > SUPPLY_BLOCK) continue;
          // The stronghold always supplies its own grounds.
          if (Math.hypot(cx + 0.5 - hq.x, cy + 0.5 - hq.y) < HQ_RADIUS) continue;
          blocked[cy * m.w + cx] = 1;
        }
      }
    }
    const reach = floodFrom(m, hq, blocked);
    g.supply[team] = reach;
    const rr = Math.ceil(SUPPLY_REACH);
    for (const u of g.units) {
      if (!u.alive || u.team !== team) continue;
      let ok = false;
      for (let dy = -rr; dy <= rr && !ok; dy++) {
        for (let dx = -rr; dx <= rr && !ok; dx++) {
          const cx = Math.floor(u.x) + dx;
          const cy = Math.floor(u.y) + dy;
          if (cx < 0 || cy < 0 || cx >= m.w || cy >= m.h) continue;
          if (Math.hypot(cx + 0.5 - u.x, cy + 0.5 - u.y) > SUPPLY_REACH) continue;
          if (reach[cy * m.w + cx]) ok = true;
        }
      }
      if (u.supplied && !ok) g.events.push({ kind: 'cut', team, x: u.x, y: u.y, t: g.time });
      u.supplied = ok;
    }
  }
}

/** Move a group in formation: melee in front, ranged behind, slots kept left-to-right. */
export function orderMove(g: Game, ids: number[], target: Pt) {
  const us = ids.map((id) => getUnit(g, id)).filter((u): u is Unit => !!u);
  if (!us.length) return;
  const c = { x: 0, y: 0 };
  for (const u of us) {
    c.x += u.x / us.length;
    c.y += u.y / us.length;
  }
  let dx = target.x - c.x;
  let dy = target.y - c.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.01) {
    dx = 1;
    dy = 0;
  } else {
    dx /= len;
    dy /= len;
  }
  const px = -dy;
  const py = dx;
  const n = us.length;
  const perRow = Math.min(n, Math.max(4, Math.ceil(Math.sqrt(n * 2.5))));
  const spacing = 2.0;
  const ordered = [...us.filter((u) => u.kind === 'melee'), ...us.filter((u) => u.kind === 'ranged')];
  for (let row = 0; row * perRow < n; row++) {
    const rowUnits = ordered.slice(row * perRow, row * perRow + perRow);
    rowUnits.sort((a, b) => (a.x * px + a.y * py) - (b.x * px + b.y * py));
    rowUnits.forEach((u, k) => {
      const col = k - (rowUnits.length - 1) / 2;
      const raw = { x: target.x + px * col * spacing - dx * row * spacing, y: target.y + py * col * spacing - dy * row * spacing };
      const slot = n === 1 ? target : nearestPassable(g.map, raw.x, raw.y) ?? target;
      u.path = findPath(g.map, u, slot) ?? findPath(g.map, u, target) ?? [];
      u.stall = 0;
    });
  }
}

export function stopUnits(g: Game, ids: number[]) {
  for (const id of ids) {
    const u = getUnit(g, id);
    if (u) u.path = [];
  }
}

export const canStrike = (g: Game, u: Unit) => u.alive && u.targetId !== null && g.time >= u.strikeReadyAt;
export const canRally = (g: Game, u: Unit) => u.alive && u.hp < u.maxHp * 0.85 && g.time >= u.rallyReadyAt;

/** Starting a mini-game commits the cooldown, so a bad roll cannot simply be retried. */
export function beginMinigame(g: Game, u: Unit, kind: 'strike' | 'rally') {
  if (kind === 'strike') u.strikeReadyAt = g.time + STRIKE_CD;
  else u.rallyReadyAt = g.time + RALLY_CD;
}

/** quality: 0 miss, 1 good, 2 perfect. */
export function applyStrike(g: Game, u: Unit, quality: 0 | 1 | 2) {
  const s = g.stats[u.team];
  s.minigames++;
  if (quality === 2) s.perfect++;
  else if (quality === 1) s.good++;
  else s.miss++;
  if (!u.alive || quality === 0) return;
  u.buffMul = quality === 2 ? 1.7 : 1.35;
  u.buffUntil = g.time + STRIKE_DURATION;
  g.events.push({ kind: 'strike', team: u.team, x: u.x, y: u.y, t: g.time, value: quality });
}

/** fraction: share of max HP restored (0 to 0.3). */
export function applyRally(g: Game, u: Unit, fraction: number) {
  const s = g.stats[u.team];
  s.minigames++;
  if (fraction >= 0.3) s.perfect++;
  else if (fraction > 0) s.good++;
  else s.miss++;
  if (!u.alive || fraction <= 0) return;
  const before = u.hp;
  u.hp = Math.min(u.maxHp, u.hp + u.maxHp * fraction);
  s.healed += u.hp - before;
  g.events.push({ kind: 'rally', team: u.team, x: u.x, y: u.y, t: g.time, value: u.hp - before });
}

export function step(g: Game, dt: number) {
  if (g.winner !== null) return;
  g.time += dt;
  const m = g.map;
  g.supplyTimer -= dt;
  if (g.supplyTimer <= 0) {
    updateSupply(g);
    g.supplyTimer = 0.5;
  }

  const alive = g.units.filter((u) => u.alive);
  const byId = new Map(alive.map((u) => [u.id, u] as const));
  const nearest = new Map<number, { u: Unit; d: number }>();

  // 1. Contact, zone of control and target selection.
  for (const u of alive) {
    u.contact = false;
    u.inZoc = false;
    const range = UNIT_STATS[u.kind].range;
    let near: Unit | null = null;
    let nd = Infinity;
    for (const v of alive) {
      if (v.team === u.team) continue;
      const d = dist(u, v);
      if (d < nd) {
        nd = d;
        near = v;
      }
      if (d <= CONTACT) u.contact = true;
      if (d <= ZOC) u.inZoc = true;
    }
    if (near) nearest.set(u.id, { u: near, d: nd });
    const cur = u.targetId !== null ? byId.get(u.targetId) : undefined;
    // Ranged units in melee contact must fight what is touching them.
    const effRange = u.kind === 'ranged' && u.contact ? CONTACT : range;
    if (cur && dist(u, cur) <= effRange + 0.3) continue;
    u.targetId = near && nd <= effRange ? near.id : null;
  }

  // 2. Damage. Each extra attacker on the same target adds a flanking bonus.
  const attackers = new Map<number, number>();
  for (const u of alive) if (u.targetId !== null) attackers.set(u.targetId, (attackers.get(u.targetId) ?? 0) + 1);
  const dmg = new Map<number, number>();
  for (const u of alive) {
    if (u.targetId === null) continue;
    const t = byId.get(u.targetId)!;
    const s = UNIT_STATS[u.kind];
    const base = u.kind === 'ranged' && u.contact ? s.meleeDps : s.dps;
    const mult = (isBuffed(g, u) ? u.buffMul : 1) * (u.supplied ? 1 : 0.8);
    const flank = 1 + 0.25 * (Math.min(attackers.get(t.id) ?? 1, 4) - 1);
    const def = DEFENSE[terrainAt(m, t.x, t.y)];
    const cut = t.supplied ? 1 : 1.2;
    dmg.set(t.id, (dmg.get(t.id) ?? 0) + base * dt * mult * flank * def * cut);
    t.lastHitAt = g.time;
    if (u.kind === 'ranged' && !u.contact) {
      u.shotCd -= dt;
      if (u.shotCd <= 0) {
        u.shotCd = 0.45 + (u.id % 5) * 0.04;
        g.events.push({ kind: 'shot', team: u.team, x: u.x, y: u.y, x2: t.x, y2: t.y, t: g.time });
      }
    }
  }
  for (const team of [0, 1] as Team[]) {
    const hq = m.hq[team];
    let near: Unit | null = null;
    for (const u of alive) if (u.team !== team && dist(u, hq) <= GARRISON_RANGE && (!near || dist(u, hq) < dist(near, hq))) near = u;
    if (!near) continue;
    dmg.set(near.id, (dmg.get(near.id) ?? 0) + GARRISON_DPS * dt);
    near.lastHitAt = g.time;
    g.garrisonCd[team] -= dt;
    if (g.garrisonCd[team] <= 0) {
      g.garrisonCd[team] = 0.6;
      g.events.push({ kind: 'shot', team, x: hq.x, y: hq.y, x2: near.x, y2: near.y, t: g.time });
    }
  }
  for (const [id, d] of dmg) byId.get(id)!.hp -= d;

  // 3. Recovery: supplied units out of combat heal, faster near the stronghold. Cut-off units wither.
  for (const u of alive) {
    if (dmg.has(u.id) || u.targetId !== null || g.time - u.lastHitAt < 3) continue;
    if (!u.supplied) {
      u.hp -= 0.6 * dt;
      continue;
    }
    const nearHq = dist(u, m.hq[u.team]) < HQ_HEAL_RADIUS;
    u.hp = Math.min(u.maxHp, u.hp + (nearHq ? 5 : 1.2) * dt);
  }

  for (const u of alive) {
    if (u.hp > 0) continue;
    u.alive = false;
    u.path = [];
    g.stats[u.team].lost++;
    g.events.push({ kind: 'death', team: u.team, x: u.x, y: u.y, t: g.time });
  }
  const living = alive.filter((u) => u.alive);

  // 4. Movement.
  for (const u of living) {
    const s = UNIT_STATS[u.kind];
    const terrainSpeed = Math.max(0.4, SPEED[terrainAt(m, u.x, u.y)]);
    const speed = s.speed * terrainSpeed * (u.inZoc ? ZOC_SLOW : 1) * (u.contact ? CONTACT_SLOW : 1);
    if (u.path.length) {
      const wp = u.path[0];
      const d = dist(u, wp);
      const stepLen = speed * dt;
      const ox = u.x;
      const oy = u.y;
      if (d <= stepLen) {
        u.x = wp.x;
        u.y = wp.y;
        u.path.shift();
      } else {
        u.x += ((wp.x - u.x) / d) * stepLen;
        u.y += ((wp.y - u.y) / d) * stepLen;
      }
      // Arrive early if a friend already holds the final spot.
      if (u.path.length === 1) {
        const last = u.path[0];
        if (living.some((v) => v !== u && v.team === u.team && !v.path.length && dist(v, last) < 1.2) && dist(u, last) < 2.5) u.path = [];
      }
      u.stall = Math.hypot(u.x - ox, u.y - oy) < stepLen * 0.2 && !u.contact ? u.stall + dt : 0;
      if (u.stall > 1.5) {
        u.path = [];
        u.stall = 0;
      }
    } else if (u.kind === 'melee' && !u.contact) {
      // Idle melee step into enemies that come close: holding a line needs no clicks.
      const n = nearest.get(u.id);
      if (n && n.u.alive && n.d < 3.4) {
        const nx = u.x + ((n.u.x - u.x) / n.d) * speed * 0.6 * dt;
        const ny = u.y + ((n.u.y - u.y) / n.d) * speed * 0.6 * dt;
        if (passableAt(m, nx, ny)) {
          u.x = nx;
          u.y = ny;
        }
      }
    }
  }

  // 5. Separation: units are bodies and cannot stack or walk through enemies.
  for (let i = 0; i < living.length; i++) {
    for (let j = i + 1; j < living.length; j++) {
      const a = living[i];
      const b = living[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d = Math.hypot(dx, dy);
      if (d >= SEPARATION) continue;
      if (d < 1e-4) {
        dx = ((a.id * 7) % 3) - 1 || 1;
        dy = ((b.id * 5) % 3) - 1;
        d = Math.hypot(dx, dy);
      }
      const push = (SEPARATION - d) / 2;
      const nx = dx / d;
      const ny = dy / d;
      // A moving unit yields to a unit holding position.
      const aw = a.path.length && !b.path.length ? 1.6 : !a.path.length && b.path.length ? 0.4 : 1;
      const ax = a.x - nx * push * aw;
      const ay = a.y - ny * push * aw;
      const bx = b.x + nx * push * (2 - aw);
      const by = b.y + ny * push * (2 - aw);
      if (passableAt(m, ax, ay)) {
        a.x = ax;
        a.y = ay;
      }
      if (passableAt(m, bx, by)) {
        b.x = bx;
        b.y = by;
      }
    }
  }

  // 6. Stronghold capture: enemies on the grounds with no defenders present.
  for (const team of [0, 1] as Team[]) {
    const hq = m.hq[team];
    let att = 0;
    let def = 0;
    for (const u of living) {
      if (dist(u, hq) > HQ_RADIUS) continue;
      if (u.team === team) def++;
      else att++;
    }
    if (att > 0 && def === 0) g.capture[team] += dt * (1 + 0.25 * (Math.min(att, 3) - 1));
    else g.capture[team] = Math.max(0, g.capture[team] - dt * 2);
    if (g.capture[team] >= CAPTURE_TIME) {
      g.winner = (1 - team) as Team;
      g.winReason = 'Stronghold captured';
    }
  }
  if (g.winner === null) {
    for (const team of [0, 1] as Team[]) {
      if (!living.some((u) => u.team === team)) {
        g.winner = (1 - team) as Team;
        g.winReason = 'Army destroyed';
      }
    }
  }

  g.events = g.events.filter((e) => g.time - e.t < 1.6);
}
