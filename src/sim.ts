import { NODE_STATS, ROAD_SPEED, edgeBetween, type GraphMap, type Special } from './map';
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
/** Multiplier on every quick-time success (2.5x after playtest feedback, 2026-10-19). */
export const QTE_POWER = 2.5;
/** Momentum drifts back toward 1 at this rate per second. */
export const MOMENTUM_DECAY = 0.06;
/** War clock: when it runs out, whoever holds more strongholds wins (troops break ties). */
export const MATCH_TIME = 720;

export type QteKind = 'volley' | 'parry' | 'slash' | 'banner';

/** How a column fights. Chosen when sending troops; garrisons have no stance. */
export type Stance = 'assault' | 'hold' | 'skirmish';
export const STANCES: Record<Stance, { dmgOut: number; dmgIn: number; speed: number; label: string; desc: string }> = {
  assault: { dmgOut: 1.2, dmgIn: 1, speed: 1, label: 'Assault', desc: '+20% damage dealt. More Slash events.' },
  hold: { dmgOut: 1, dmgIn: 0.8, speed: 1, label: 'Hold', desc: '−20% damage taken. More Parry events.' },
  skirmish: { dmgOut: 1, dmgIn: 1, speed: 1.25, label: 'Skirmish', desc: '+25% march speed. More Volley events.' },
};

/** Rally meter gained per quick-time hit (four hits fill it) and lost per miss. */
export const RALLY_PER_HIT = 0.25;
export const RALLY_PER_MISS = 0.15;
/** The finisher ("Charge!") kills this share of the enemy, plus 3. */
export const FINISHER_KILL = 0.25;
/** Retreating troops lose this share on the way out. */
export const RETREAT_LOSS = 0.15;
/** A side below this share of its peak strength is routing: it takes extra damage. */
export const ROUT_AT = 0.25;
export const ROUT_DAMAGE = 1.25;

/** Vision ranges (world units) when fog of war is on. */
export const VISION_NODE = 300;
export const VISION_TOWER = 580;
export const VISION_COLUMN = 220;
export const VISION_BATTLE = 200;
/** Barracks growth multiplier, Forge starting momentum, Shrine quick-time multiplier. */
export const BARRACKS_GROWTH = 1.5;
export const FORGE_MOMENTUM = 0.3;
export const SHRINE_POWER = 1.25;
/** A rally route forwards everything above this reserve once at least 6 troops are spare. */
export const RALLY_RESERVE = 5;

/** Commanders: chosen before a war, each with a passive and a quick-time twist. */
export type CommanderId = 'none' | 'archer' | 'duelist' | 'ironwall' | 'raider' | 'herald';
export const COMMANDERS: Record<CommanderId, { label: string; title: string; desc: string }> = {
  none: { label: 'No commander', title: '', desc: 'Plain rules.' },
  archer: { label: 'The Archer', title: 'Master of the volley', desc: 'Volleys kill 60% more. Your Volley ring eases in as it nears the target and holds for a split second at the perfect moment.' },
  duelist: { label: 'The Duelist', title: 'Blade in hand', desc: 'A successful Slash also cuts down troops. You win duels by a 0.1 s margin.' },
  ironwall: { label: 'The Iron Wall', title: 'Unbreakable', desc: 'A missed Parry costs nothing. Your walls are 0.2 stronger.' },
  raider: { label: 'The Raider', title: 'Fast and hungry', desc: 'Your columns march 25% faster, and your road ambushes start with +0.5 momentum.' },
  herald: { label: 'The Herald', title: 'Voice of the host', desc: 'Your rally meter fills 40% faster (Charge! comes sooner).' },
};

/** Commander abilities, used from the map on cooldowns. */
export type Ability = 'march' | 'inspire' | 'spy';
export const ABILITIES: Record<Ability, { label: string; desc: string; cooldown: number; duration: number }> = {
  march: { label: 'March', desc: 'Pick one of your columns: it moves twice as fast for 15 s.', cooldown: 45, duration: 15 },
  inspire: { label: 'Inspire', desc: 'Pick one of your battles: +0.6 momentum and +50% rally.', cooldown: 60, duration: 0 },
  spy: { label: 'Spy', desc: 'For 20 s: see the whole map and where enemy columns are heading.', cooldown: 75, duration: 20 },
};

export interface NodeState {
  id: number;
  owner: Owner;
  troops: number;
  battleId: number | null;
  /** Rally route: surplus troops are forwarded here automatically. */
  rallyTo: number | null;
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
  stance: Stance;
  /** Forced March: moves twice as fast until this time. */
  forcedUntil: number;
}

export interface Side {
  owner: Owner;
  troops: number;
  momentum: number;
  /** Rally meter 0..1, filled by quick-time hits; full enables the finisher. */
  rally: number;
  stance?: Stance;
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
  kind: 'battle' | 'captured' | 'lost' | 'won' | 'held' | 'intercept' | 'qte' | 'retreat' | 'finisher' | 'duel' | 'taunt';
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
  finishers: number;
  retreats: number;
  duels: number;
  duelsWon: number;
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
  fog: boolean;
  /** What each player last saw of every node (used under fog of war). */
  memory: [Record<number, { owner: Owner; troops: number; t: number }>, Record<number, { owner: Owner; troops: number; t: number }>];
  /** When each player's abilities are ready again. */
  abilityReady: [Record<Ability, number>, Record<Ability, number>];
  spyUntil: [number, number];
  rallyTimer: number;
  visionTimer: number;
  /** Each player's chosen commander. */
  commanders: [CommanderId, CommanderId];
}

export interface GameOptions {
  fog?: boolean;
  commanders?: [CommanderId, CommanderId];
}

export const commanderOf = (g: Game, owner: Owner): CommanderId => (owner === 2 ? 'none' : g.commanders[owner]);

const emptyStats = (): PlayerStats => ({ battlesFought: 0, battlesWon: 0, qtePlayed: 0, qteHit: 0, troopsSent: 0, nodesTaken: 0, finishers: 0, retreats: 0, duels: 0, duelsWon: 0 });

export function createGame(map: GraphMap, opts: GameOptions = {}): Game {
  const rng = mulberry32(map.seed ^ 0x51ed);
  const nodes: NodeState[] = map.nodes.map((n) => ({ id: n.id, owner: 2, troops: 0, battleId: null, rallyTo: null }));
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
    fog: !!opts.fog,
    // The starting layout is common knowledge.
    memory: [
      Object.fromEntries(nodes.map((n) => [n.id, { owner: n.owner, troops: n.troops, t: 0 }])),
      Object.fromEntries(nodes.map((n) => [n.id, { owner: n.owner, troops: n.troops, t: 0 }])),
    ],
    abilityReady: [
      { march: 0, inspire: 0, spy: 0 },
      { march: 0, inspire: 0, spy: 0 },
    ],
    spyUntil: [-1, -1],
    rallyTimer: 1,
    visionTimer: 0,
    commanders: opts.commanders ?? ['none', 'none'],
  };
}

/** Does `owner` hold a stronghold of this special kind at, or next to, any of these nodes? */
export function specialNear(g: Game, owner: Owner, nodes: number[], kind: Special): boolean {
  if (owner === 2) return false;
  for (const id of nodes) {
    for (const k of [id, ...g.map.adj[id]]) {
      if (g.map.nodes[k].special === kind && g.nodes[k].owner === owner) return true;
    }
  }
  return false;
}

/** The nodes a battle touches: its node, or both ends of its road. */
export function battleNodes(b: Battle): number[] {
  return b.nodeId !== null ? [b.nodeId] : [b.road!.a, b.road!.b];
}

/** Can `viewer` see this point? Always true without fog, or while their Spy is active. */
export function canSee(g: Game, viewer: Player, x: number, y: number): boolean {
  if (!g.fog || g.spyUntil[viewer] > g.time) return true;
  for (const n of g.nodes) {
    if (n.owner !== viewer) continue;
    const mn = g.map.nodes[n.id];
    const r = mn.special === 'watchtower' ? VISION_TOWER : VISION_NODE;
    if (Math.hypot(mn.x - x, mn.y - y) <= r) return true;
  }
  for (const c of g.columns) {
    if (c.owner !== viewer) continue;
    const p = columnPos(g, c);
    if (Math.hypot(p.x - x, p.y - y) <= VISION_COLUMN) return true;
  }
  for (const b of g.battles) {
    if (b.endedAt !== null || (sideOf(b, viewer)?.troops ?? 0) <= 0.5) continue;
    if (Math.hypot(b.x - x, b.y - y) <= VISION_BATTLE) return true;
  }
  return false;
}

/** What `viewer` knows about a node: live if visible, otherwise their last sighting. */
export function knownNode(g: Game, viewer: Player, id: number): { owner: Owner; troops: number; live: boolean } {
  const mn = g.map.nodes[id];
  if (canSee(g, viewer, mn.x, mn.y)) return { owner: g.nodes[id].owner, troops: g.nodes[id].troops, live: true };
  const m = g.memory[viewer][id];
  return { owner: m.owner, troops: m.troops, live: false };
}

/** Set (or clear, with `to` null) a rally route from one of your strongholds to another. */
export function setRally(g: Game, owner: Player, from: number, to: number | null): boolean {
  const n = g.nodes[from];
  if (n.owner !== owner) return false;
  if (to === null || to === from) {
    n.rallyTo = null;
    return true;
  }
  if (g.nodes[to].owner !== owner) return false;
  n.rallyTo = to;
  return true;
}

/** Use a commander ability. `target` is a column id (march) or a battle id (inspire). */
export function useAbility(g: Game, owner: Player, ability: Ability, target?: number): boolean {
  if (g.winner !== null || g.abilityReady[owner][ability] > g.time) return false;
  if (ability === 'march') {
    const c = g.columns.find((x) => x.id === target && x.owner === owner);
    if (!c) return false;
    c.forcedUntil = g.time + ABILITIES.march.duration;
  } else if (ability === 'inspire') {
    const b = getBattle(g, target ?? null);
    const me = b && sideOf(b, owner);
    if (!b || !me || b.endedAt !== null || me.troops <= 0.5) return false;
    me.momentum = Math.min(MOMENTUM_MAX, me.momentum + 0.6);
    me.rally = Math.min(1, me.rally + 0.5);
  } else {
    g.spyUntil[owner] = g.time + ABILITIES.spy.duration;
  }
  g.abilityReady[owner][ability] = g.time + ABILITIES[ability].cooldown;
  return true;
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
  if (b.nodeId === null || g.nodes[b.nodeId].owner !== s.owner) return 1;
  return NODE_STATS[g.map.nodes[b.nodeId].kind].defense + (commanderOf(g, s.owner) === 'ironwall' ? 0.2 : 0);
}

/** A side that has fallen below a quarter of its peak strength breaks and takes extra losses. */
export function isRouting(b: Battle, s: Side): boolean {
  const alive = b.sides.filter((x) => x.troops > 0.5).length;
  const peak = b.peak[s.owner] ?? 0;
  return alive >= 2 && peak >= 8 && s.troops > 0.5 && s.troops < peak * ROUT_AT;
}

/** Both commanders are personally in this battle: duels break out. */
export const inDuel = (g: Game, b: Battle) => g.presence[0] === b.id && g.presence[1] === b.id;

/** Current loss rate per second of every side, keyed by owner. */
export function lossRates(g: Game, b: Battle): Map<Owner, number> {
  const rates = new Map<Owner, number>();
  for (const s of b.sides) rates.set(s.owner, 0);
  for (const o of b.sides) {
    if (o.troops <= 0) continue;
    const enemies = b.sides.filter((e) => e.owner !== o.owner && e.troops > 0);
    const enemyTotal = enemies.reduce((t, e) => t + e.troops, 0);
    if (!enemyTotal) continue;
    const stanceOut = o.stance ? STANCES[o.stance].dmgOut : 1;
    const out = (BASE_LOSS + PER_TROOP_LOSS * o.troops) * o.momentum * sideDefense(g, b, o) * stanceOut;
    // Spread this side's damage over its enemies by size.
    for (const e of enemies) {
      const taken = (e.stance ? STANCES[e.stance].dmgIn : 1) * (isRouting(b, e) ? ROUT_DAMAGE : 1);
      rates.set(e.owner, rates.get(e.owner)! + ((out * e.troops) / enemyTotal) * taken);
    }
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
export function sendTroops(g: Game, owner: Player, from: number, to: number, amount: number, stance: Stance = 'assault'): Column | null {
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
    stance,
    forcedUntil: 0,
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
  for (const s of sides) {
    if (specialNear(g, s.owner, battleNodes(b), 'forge')) s.momentum += FORGE_MOMENTUM;
    if (road && commanderOf(g, s.owner) === 'raider') s.momentum += 0.5;
  }
  for (const s of sides) b.peak[s.owner] = s.troops;
  g.battles.push(b);
  for (const s of sides) if (s.owner !== 2) g.stats[s.owner].battlesFought++;
  return b;
}

function joinBattle(g: Game, b: Battle, owner: Owner, troops: number, march?: Side['march'], stance?: Stance) {
  let s = sideOf(b, owner);
  if (!s) {
    s = { owner, troops: 0, momentum: 1 + (specialNear(g, owner, battleNodes(b), 'forge') ? FORGE_MOMENTUM : 0), rally: 0, march, stance };
    b.sides.push(s);
    if (owner !== 2) g.stats[owner].battlesFought++;
  }
  s.troops += troops;
  if (march && !s.march) s.march = march;
  b.peak[owner] = Math.max(b.peak[owner] ?? 0, s.troops);
}

export function event(g: Game, e: Omit<GameEvent, 't'>) {
  g.events.push({ ...e, t: g.time });
}

/** A column reaches the node at the end of its current road. */
function arrive(g: Game, c: Column): boolean {
  const at = c.path[0];
  const node = g.nodes[at];
  const mn = g.map.nodes[at];
  if (node.battleId !== null) {
    joinBattle(g, getBattle(g, node.battleId)!, c.owner, c.troops, undefined, c.stance);
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
  const defender: Side = { owner: node.owner, troops: node.troops, momentum: 1, rally: 0 };
  node.troops = 0;
  const b = startBattle(g, at, null, mn.x, mn.y, [defender, { owner: c.owner, troops: c.troops, momentum: 1, rally: 0, stance: c.stance }]);
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
    if (prevOwner !== win.owner) node.rallyTo = null;
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
    g.columns.push({ id: g.nextId++, owner: win.owner, troops: win.troops, from: win.march.from, path: win.march.path, progress: win.march.progress, edgeLen: win.march.edgeLen, battleId: null, stance: win.stance ?? 'assault', forcedUntil: 0 });
    if (win.owner === 0) event(g, { kind: 'won', text: 'Your column broke through', owner: 0, x: b.x, y: b.y });
  }
}

/** Apply a quick-time event result for `owner` in battle `battleId`. Shared by the player and the AI. */
function logQte(g: Game, b: Battle, owner: Player, text: string) {
  if (text) event(g, { kind: 'qte', text, owner, x: b.x, y: b.y, battleId: b.id });
}

/** Apply a quick-time event result for `owner` in battle `battleId`. Shared by the player and the AI. */
export function applyQte(g: Game, battleId: number, owner: Player, kind: QteKind, success: boolean): string {
  const text = qteEffect(g, battleId, owner, kind, success);
  const b = getBattle(g, battleId);
  if (b) logQte(g, b, owner, text);
  return text;
}

function qteEffect(g: Game, battleId: number, owner: Player, kind: QteKind, success: boolean): string {
  const b = getBattle(g, battleId);
  const me = b && sideOf(b, owner);
  g.stats[owner].qtePlayed++;
  if (success) g.stats[owner].qteHit++;
  if (!b || !me || b.endedAt !== null) return '';
  const cmd = commanderOf(g, owner);
  me.rally = Math.max(0, Math.min(1, me.rally + (success ? RALLY_PER_HIT * (cmd === 'herald' ? 1.4 : 1) : -RALLY_PER_MISS)));
  const shrine = specialNear(g, owner, battleNodes(b), 'shrine') ? SHRINE_POWER : 1;
  const kill = (frac: number) => killEnemies(b, owner, frac, QTE_POWER * shrine);
  const bump = (d: number) => bumpMomentum(me, d * shrine);
  switch (kind) {
    case 'volley':
      return success ? `Volley! ${kill(cmd === 'archer' ? 0.07 * 1.6 : 0.07)} down` : 'Volley missed';
    case 'parry':
      if (success) {
        bump(0.15 * QTE_POWER);
        return 'Charge parried';
      } else {
        if (cmd === 'ironwall') return 'The Iron Wall holds: no losses';
        const lost = me.troops * 0.07 + 1;
        me.troops -= lost;
        return `Charge broke through: −${Math.round(lost)}`;
      }
    case 'slash':
      bump(success ? 0.3 * QTE_POWER : -0.1);
      if (success && cmd === 'duelist') return `Line broken: ${kill(0.05)} down`;
      return success ? 'Line broken: momentum up' : 'Slash fumbled';
    case 'banner':
      if (!success) return 'Banner lost';
      bump(0.15 * QTE_POWER);
      return `Rallied to the banner: ${kill(0.04)} down`;
  }
}

/** Kill `frac` of all enemies of `owner` (plus `flat`), times `power`, spread by size. Returns the number killed. */
function killEnemies(b: Battle, owner: Owner, frac: number, power: number, flat = 1): number {
  const enemies = b.sides.filter((s) => s.owner !== owner && s.troops > 0);
  const total = enemies.reduce((t, s) => t + s.troops, 0);
  const k = Math.min(total, (total * frac + flat) * power);
  for (const e of enemies) e.troops -= (k * e.troops) / Math.max(1, total);
  return Math.round(k);
}

function bumpMomentum(s: Side, d: number) {
  s.momentum = Math.max(MOMENTUM_MIN, Math.min(MOMENTUM_MAX, s.momentum + d));
}

/** The finisher: with a full rally meter, one charge kills a quarter of the enemy (plus 3). */
export function useFinisher(g: Game, battleId: number, owner: Player): string {
  const b = getBattle(g, battleId);
  const me = b && sideOf(b, owner);
  if (!b || !me || b.endedAt !== null || me.rally < 1) return '';
  me.rally = 0;
  const k = killEnemies(b, owner, FINISHER_KILL, 1, 3);
  g.stats[owner].finishers++;
  event(g, { kind: 'finisher', text: owner === 0 ? 'Your charge breaks their line' : 'The enemy charges!', owner, x: b.x, y: b.y, battleId });
  return `CHARGE! ${k} down`;
}

/** Nearest node `owner` holds (not `exclude`), by road hops, preferring ones not under attack. */
function nearestFriendly(g: Game, owner: Player, start: number, exclude: number | null): number | null {
  const m = g.map;
  const seen = new Set([start]);
  let frontier = [start];
  let fallback: number | null = null;
  if (start !== exclude && g.nodes[start].owner === owner) {
    if (g.nodes[start].battleId === null) return start;
    fallback = start;
  }
  while (frontier.length) {
    const next: number[] = [];
    for (const n of frontier) {
      for (const k of m.adj[n]) {
        if (seen.has(k)) continue;
        seen.add(k);
        next.push(k);
        if (k === exclude || g.nodes[k].owner !== owner) continue;
        if (g.nodes[k].battleId === null) return k;
        fallback ??= k;
      }
    }
    frontier = next;
  }
  return fallback;
}

/** Where a retreat from this battle would go, or null if there is nowhere to fall back to. */
export function retreatTarget(g: Game, b: Battle, owner: Player): number | null {
  if (b.nodeId !== null) return nearestFriendly(g, owner, b.nodeId, b.nodeId);
  const side = sideOf(b, owner);
  if (!side?.march) return null;
  return nearestFriendly(g, owner, side.march.from, null);
}

/** Pull `owner`'s troops out of a battle to the nearest friendly node, losing RETREAT_LOSS on the way. */
export function retreat(g: Game, battleId: number, owner: Player): Column | null {
  const b = getBattle(g, battleId);
  const side = b && sideOf(b, owner);
  if (!b || !side || b.endedAt !== null || side.troops <= 0.5) return null;
  const dest = retreatTarget(g, b, owner);
  if (dest === null) return null;
  let col: Column;
  const troops = side.troops * (1 - RETREAT_LOSS);
  if (b.nodeId !== null) {
    const path = route(g, owner, b.nodeId, dest);
    if (!path || !path.length) return null;
    col = { id: g.nextId++, owner, troops, from: b.nodeId, path, progress: 0, edgeLen: edgeBetween(g.map, b.nodeId, path[0])!.len, battleId: null, stance: 'skirmish', forcedUntil: 0 };
  } else {
    // Turn around on the road and head back the way we came.
    const mch = side.march!;
    const back = mch.from;
    const tail = back === dest ? [] : route(g, owner, back, dest) ?? [];
    col = { id: g.nextId++, owner, troops, from: mch.path[0], path: [back, ...tail], progress: Math.max(0, mch.edgeLen - mch.progress), edgeLen: mch.edgeLen, battleId: null, stance: 'skirmish', forcedUntil: 0 };
  }
  b.sides = b.sides.filter((s) => s !== side);
  g.columns.push(col);
  g.stats[owner].retreats++;
  if (g.presence[owner] === battleId) g.presence[owner] = null;
  event(g, { kind: 'retreat', text: owner === 0 ? 'Your troops fall back' : 'The enemy falls back', owner, x: b.x, y: b.y, battleId });
  if (b.sides.filter((s) => s.troops > 0.5).length <= 1) endBattle(g, b);
  return col;
}

/** Send a marching column somewhere else; if its next stop is the place it is avoiding, it turns around. */
export function redirectColumn(g: Game, c: Column, dest: number, avoid: number) {
  if (c.path[0] === avoid) {
    const back = c.from;
    const tail = back === dest ? [] : route(g, c.owner, back, dest) ?? [];
    c.from = c.path[0];
    c.path = [back, ...tail];
    c.progress = Math.max(0, c.edgeLen - c.progress);
  } else {
    const next = c.path[0];
    const tail = next === dest ? [] : route(g, c.owner, next, dest);
    if (tail) c.path = [next, ...tail];
  }
}

/** A commander duel: the winner's side surges, the loser's side reels. */
export function applyDuel(g: Game, battleId: number, winner: Player): string {
  const b = getBattle(g, battleId);
  const win = b && sideOf(b, winner);
  const lose = b && sideOf(b, (1 - winner) as Player);
  if (!b || !win || !lose || b.endedAt !== null) return '';
  const k = lose.troops * 0.15 + 3;
  lose.troops -= k;
  bumpMomentum(win, 0.5);
  bumpMomentum(lose, -0.3);
  g.stats[0].duels++;
  g.stats[1].duels++;
  g.stats[winner].duelsWon++;
  event(g, { kind: 'duel', text: winner === 0 ? 'You won the duel' : 'The enemy commander won the duel', owner: winner, x: b.x, y: b.y, battleId });
  return winner === 0 ? `Duel won! ${Math.round(k)} down` : `Duel lost: −${Math.round(k)}`;
}

/** Pursuit of a routing enemy: each fleeing soldier caught kills a slice of them. */
/** A Pursuit is on once any enemy side has fallen below half its peak strength. */
export function pursuitReady(b: Battle, owner: Owner): boolean {
  return b.sides.some((s) => s.owner !== owner && s.troops > 0.5 && (b.peak[s.owner] ?? 0) >= 8 && s.troops < (b.peak[s.owner] ?? 0) * 0.5);
}

export function applyPursuit(g: Game, battleId: number, owner: Player, hits: number): string {
  const b = getBattle(g, battleId);
  const me = b && sideOf(b, owner);
  g.stats[owner].qtePlayed++;
  if (hits > 0) g.stats[owner].qteHit++;
  if (!b || !me || b.endedAt !== null || hits <= 0) return hits <= 0 ? 'They got away' : '';
  me.rally = Math.min(1, me.rally + RALLY_PER_HIT);
  const shrine = specialNear(g, owner, battleNodes(b), 'shrine') ? SHRINE_POWER : 1;
  // Each caught runner is worth more when the enemy is truly routing.
  const per = b.sides.some((x) => x.owner !== owner && isRouting(b, x)) ? 0.05 : 0.035;
  const text = `Pursuit: ${killEnemies(b, owner, per * hits, QTE_POWER * shrine)} cut down`;
  logQte(g, b, owner, text);
  return text;
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
    const growth = st.growth * (m.nodes[n.id].special === 'barracks' ? BARRACKS_GROWTH : 1);
    if (n.troops < st.cap) n.troops = Math.min(st.cap, n.troops + growth * dt);
    // Overfull garrisons desert: the excess drains off by 6% per second.
    else n.troops = Math.max(st.cap, n.troops - (n.troops - st.cap) * 0.06 * dt - 0.2 * dt);
  }

  // Rally routes forward surplus troops once a second.
  g.rallyTimer -= dt;
  if (g.rallyTimer <= 0) {
    g.rallyTimer = 1;
    for (const n of g.nodes) {
      if (n.rallyTo === null) continue;
      if (n.owner === 2 || g.nodes[n.rallyTo].owner !== n.owner) {
        n.rallyTo = null;
        continue;
      }
      if (n.battleId !== null) continue;
      const reserve = m.nodes[n.id].kind === 'capital' ? RALLY_RESERVE * 2 : RALLY_RESERVE;
      const spare = Math.floor(n.troops - reserve);
      if (spare >= 6) sendTroops(g, n.owner as Player, n.id, n.rallyTo, spare, 'hold');
    }
  }
  // Each player remembers the last thing they saw of every node.
  g.visionTimer -= dt;
  if (g.fog && g.visionTimer <= 0) {
    g.visionTimer = 0.5;
    for (const p of [0, 1] as Player[]) {
      for (const n of g.nodes) {
        const mn = m.nodes[n.id];
        if (canSee(g, p, mn.x, mn.y)) g.memory[p][n.id] = { owner: n.owner, troops: n.troops, t: g.time };
      }
    }
  }

  // Columns march. Opposing columns meeting on a road fight there; columns reaching a road
  // battle join it.
  const roadBattles = activeBattles(g).filter((b) => b.road);
  for (const c of [...g.columns]) {
    if (c.battleId !== null) continue;
    const a = Math.min(c.from, c.path[0]);
    const before = posOnRoad(c, a);
    const road = edgeBetween(m, c.from, c.path[0])!.road;
    const raider = commanderOf(g, c.owner) === 'raider' ? 1.25 : 1;
    c.progress += COLUMN_SPEED * STANCES[c.stance].speed * ROAD_SPEED[road] * (c.forcedUntil > g.time ? 2 : 1) * raider * dt;
    const after = posOnRoad(c, a);
    const rb = roadBattles.find((b) => b.road!.a === a && b.road!.b === Math.max(c.from, c.path[0]) && (before - b.road!.pos) * (after - b.road!.pos) <= 0);
    if (rb) {
      joinBattle(g, rb, c.owner, c.troops, { from: c.from, path: c.path, progress: Math.min(c.progress, c.edgeLen), edgeLen: c.edgeLen }, c.stance);
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
        { owner: p.owner, troops: p.troops, momentum: 1, rally: 0, stance: p.stance, march: march(p) },
        { owner: q.owner, troops: q.troops, momentum: 1, rally: 0, stance: q.stance, march: march(q) },
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
