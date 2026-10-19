import { NODE_STATS, edgeBetween, hops } from './map';
import { mulberry32, type Rng } from './rng';
import {
  COLUMN_SPEED,
  canSee,
  columnPos,
  knownNode,
  setRally,
  useAbility,
  MATCH_TIME,
  activeBattles,
  applyQte,
  getBattle,
  isRouting,
  redirectColumn,
  retreat,
  retreatTarget,
  sendTroops,
  sideOf,
  useFinisher,
  type Battle,
  type Game,
  type Player,
  type QteKind,
} from './sim';

export type Difficulty = 'easy' | 'normal' | 'hard';

/**
 * The AI commander has one pair of hands, like the player: it can be in one battle at a time,
 * takes time to switch, and plays quick-time events at a set pace and success rate.
 */
export const AI_LEVELS: Record<Difficulty, { think: number; qteEvery: number; success: number; margin: number; attacks: number; switchTime: number; duelReaction: number }> = {
  easy: { think: 2.2, qteEvery: 2.4, success: 0.55, margin: 1.45, attacks: 1, switchTime: 3, duelReaction: 0.7 },
  normal: { think: 1.5, qteEvery: 1.8, success: 0.7, margin: 1.25, attacks: 1, switchTime: 2, duelReaction: 0.5 },
  hard: { think: 1.0, qteEvery: 1.4, success: 0.82, margin: 1.12, attacks: 2, switchTime: 1.5, duelReaction: 0.38 },
};

/** Seconds the AI commander takes to react in a duel (with a little randomness). */
export function duelReaction(ai: AiState): number {
  return AI_LEVELS[ai.level].duelReaction * (0.85 + ai.rng() * 0.3);
}

export interface AiState {
  me: Player;
  level: Difficulty;
  thinkT: number;
  focusT: number;
  qteT: number;
  /** Time left before the commander is effective in the battle it just joined. */
  arriveT: number;
  rng: Rng;
  /** Set false to run an AI with no commander (for tests that measure the commander's value). */
  commander: boolean;
  musterAt: number;
  /** Last time we gained ground; boldness grows the longer we go without. */
  lastGainAt: number;
  held: number;
  /** Nodes we just retreated from, and until when we stay away. */
  abandoned: Map<number, number>;
}

export function createAi(me: Player, level: Difficulty, seed = 1, commander = true): AiState {
  return { me, level, thinkT: 1, focusT: 0, qteT: 0, arriveT: 0, rng: mulberry32(seed), commander, musterAt: 0, lastGainAt: 0, held: 1, abandoned: new Map() };
}

const VALUE = { capital: 6, fort: 2.4, village: 3 };
/** Extra value of special strongholds (a Watchtower matters more under fog). */
function specialValue(g: Game, node: number): number {
  const sp = g.map.nodes[node].special;
  if (sp === 'barracks') return 1.5;
  if (sp === 'forge' || sp === 'shrine') return 1;
  if (sp === 'watchtower') return g.fog ? 1.4 : 0.6;
  return 0;
}
const QTE_KINDS: QteKind[] = ['volley', 'parry', 'slash', 'banner'];

/** Enemy troops currently marching at a node (next stop or destination). */
function incoming(g: Game, node: number, enemyOf: Player): number {
  // Under fog the AI only reacts to enemy columns it can actually see.
  return g.columns
    .filter((c) => c.owner !== enemyOf && c.path[0] === node && canSee(g, enemyOf, columnPos(g, c).x, columnPos(g, c).y))
    .reduce((t, c) => t + c.troops, 0);
}

function friendlyIncoming(g: Game, node: number, me: Player): number {
  return g.columns.filter((c) => c.owner === me && c.path[c.path.length - 1] === node).reduce((t, c) => t + c.troops, 0);
}

function reserve(g: Game, node: number): number {
  return g.map.nodes[node].kind === 'capital' ? 12 : 4;
}

function available(g: Game, node: number, me: Player): number {
  const n = g.nodes[node];
  if (n.owner !== me || n.battleId !== null) return 0;
  const threat = incoming(g, node, me) * NODE_STATS[g.map.nodes[node].kind].defense ** -1;
  return Math.max(0, n.troops - reserve(g, node) - threat * 1.2);
}

function think(g: Game, ai: AiState) {
  const me = ai.me;
  const L = AI_LEVELS[ai.level];
  const m = g.map;
  const mine = g.nodes.filter((n) => n.owner === me);
  if (mine.length > ai.held) ai.lastGainAt = g.time;
  ai.held = mine.length;

  const avoid = (n: number) => (ai.abandoned.get(n) ?? 0) > g.time;

  // 0. Cut losses: pull out of hopeless fights (never abandon our own capital).
  for (const b of activeBattles(g)) {
    const own = sideOf(b, me);
    if (!own || own.troops < 4) continue;
    if (b.nodeId === m.capitals[me]) continue;
    const enemy = b.sides.filter((s) => s.owner !== me).reduce((t, s) => t + Math.max(0, s.troops), 0);
    // Give every fight a couple of seconds (the commander may swing it) before giving up.
    if (g.time - b.startedAt < 2) continue;
    const hopeless = enemy > own.troops * 2.5 || (isRouting(b, own) && enemy > own.troops * 1.5);
    const dest = retreatTarget(g, b, me);
    if (!hopeless || dest === null || !retreat(g, b.id, me) || b.nodeId === null) continue;
    ai.abandoned.set(b.nodeId, g.time + 20);
    // Columns already on their way to this fight turn back too.
    for (const c of g.columns) if (c.owner === me && c.path[c.path.length - 1] === b.nodeId) redirectColumn(g, c, dest, b.nodeId);
  }

  // 1. Defence: reinforce nodes that are about to be hit or are losing a fight.
  for (const n of mine) {
    const def = NODE_STATS[m.nodes[n.id].kind].defense;
    let need = 0;
    if (n.battleId !== null) {
      const b = getBattle(g, n.battleId)!;
      const own = sideOf(b, me)?.troops ?? 0;
      const enemy = b.sides.filter((s) => s.owner !== me).reduce((t, s) => t + s.troops, 0);
      need = enemy * 1.1 - own * def - friendlyIncoming(g, n.id, me);
    } else {
      need = incoming(g, n.id, me) * 1.15 - n.troops * def - friendlyIncoming(g, n.id, me);
    }
    if (need <= 1 || (n.battleId !== null && avoid(n.id))) continue;
    for (const k of [...m.adj[n.id]].sort((p, q) => available(g, q, me) - available(g, p, me))) {
      const av = available(g, k, me);
      if (av < 3 || need <= 0) continue;
      const amt = Math.min(av, need + 3);
      if (sendTroops(g, me, k, n.id, amt, 'hold')) need -= amt;
    }
  }

  // 2. Offence: hit the weakest valuable node next to our territory, preferring places the
  // enemy commander is not watching.
  const enemyFocus = getBattle(g, g.presence[1 - me]);
  const focusNode = enemyFocus?.nodeId ?? null;
  const targets: { t: number; score: number; needed: number; sources: number[] }[] = [];
  const frontier = new Set<number>();
  for (const n of mine) for (const k of m.adj[n.id]) if (g.nodes[k].owner !== me) frontier.add(k);
  for (const t of frontier) {
    if (avoid(t)) continue;
    const tn = g.nodes[t];
    const kind = m.nodes[t].kind;
    const known = knownNode(g, me, t);
    let est: number;
    if (tn.battleId !== null && canSee(g, me, m.nodes[t].x, m.nodes[t].y)) {
      const b = getBattle(g, tn.battleId)!;
      const foes = b.sides.filter((s) => s.owner !== me).reduce((s2, s) => s2 + s.troops, 0);
      const own = sideOf(b, me)?.troops ?? 0;
      // Already winning this fight: leave it alone.
      if (own > foes * 1.1) continue;
      est = foes - own;
    } else {
      const sources0 = m.adj[t].filter((k) => g.nodes[k].owner === me);
      const travel = Math.min(...sources0.map((k) => edgeBetween(m, k, t)!.len)) / COLUMN_SPEED;
      // Walls multiply the defenders' damage; in a slugging match that is worth about sqrt(defence) in numbers.
      // Under fog this is the last sighting, plus growth since then.
      const since = known.live ? 0 : g.time - (g.memory[me][t]?.t ?? 0);
      est = (known.troops + (known.owner !== 2 ? NODE_STATS[kind].growth * (travel + since) : 0)) * Math.sqrt(NODE_STATS[kind].defense);
    }
    // The longer we sit idle, the readier we are to take an even fight and let the commander swing it.
    let margin = Math.max(0.6, L.margin - ((g.time - ai.lastGainAt) / 60) * 0.3);
    // Behind on strongholds with the war clock running down: take risks.
    if (g.time > MATCH_TIME - 240 && mine.length <= g.nodes.filter((x) => x.owner === 1 - me).length) margin = Math.min(margin, 0.7);
    const needed = est * margin + 3 - friendlyIncoming(g, t, me);
    // Never trickle: small top-ups are not worth a column.
    if (needed < 6) continue;
    const sources = m.adj[t].filter((k) => available(g, k, me) >= 3).sort((p, q) => available(g, q, me) - available(g, p, me)).slice(0, 2);
    const pool = sources.reduce((s, k) => s + available(g, k, me), 0);
    let score = (VALUE[kind] + specialValue(g, t) + (known.owner === 2 ? 0.6 : 0)) / needed;
    if (focusNode !== null && hops(m, focusNode, t) >= 2) score *= 1.4;
    targets.push({ t, score, needed, sources, pool } as { t: number; score: number; needed: number; sources: number[]; pool: number });
  }
  targets.sort((p, q) => q.score - p.score);
  const ready = targets.filter((tg) => (tg as unknown as { pool: number }).pool >= tg.needed);
  // Nothing within reach: muster troops from across our territory at the node next to the best target.
  if (!ready.length && targets.length && g.time >= ai.musterAt) {
    ai.musterAt = g.time + 6;
    const tg = targets[0];
    const staging = m.adj[tg.t].filter((k) => g.nodes[k].owner === me && g.nodes[k].battleId === null).sort((p, q) => g.nodes[q].troops - g.nodes[p].troops)[0];
    if (staging !== undefined) {
      for (const n of mine) {
        if (n.id === staging || n.battleId !== null) continue;
        const d = hops(m, n.id, staging);
        const av = available(g, n.id, me);
        if (d > 0 && d <= 3 && av >= 5) sendTroops(g, me, n.id, staging, av * 0.85, 'skirmish');
      }
    }
  }
  for (const tg of ready.slice(0, L.attacks)) {
    let left = tg.needed;
    for (const k of tg.sources) {
      const amt = Math.min(available(g, k, me), left);
      // Walls call for an assault; open villages for speed.
      const stance = m.nodes[tg.t].kind === 'village' ? 'skirmish' : 'assault';
      const col = amt >= 1 ? sendTroops(g, me, k, tg.t, amt, stance) : null;
      if (!col) continue;
      left -= amt;
      // Big attacks get a Forced March (not on Easy).
      if (ai.level !== 'easy' && col.troops >= 12) useAbility(g, me, 'march', col.id);
    }
  }
  if (g.fog && ai.level !== 'easy' && g.time > 20) useAbility(g, me, 'spy');

  // 3. Rally routes: safe interior nodes forward their growth to the nearest front-line node.
  for (const n of mine) {
    const exposed = m.adj[n.id].some((k) => g.nodes[k].owner !== me);
    if (exposed) {
      if (n.rallyTo !== null) setRally(g, me, n.id, null);
      continue;
    }
    let best = -1;
    let bestD = Infinity;
    for (const f of mine) {
      if (!m.adj[f.id].some((k) => g.nodes[k].owner !== me)) continue;
      const d = hops(m, n.id, f.id);
      if (d > 0 && d < bestD) {
        bestD = d;
        best = f.id;
      }
    }
    if (best >= 0 && n.rallyTo !== best) setRally(g, me, n.id, best);
  }
}

/** How much the commander's presence matters in a battle: close fights over valuable ground. */
function importance(g: Game, b: Battle, me: Player): number {
  const own = sideOf(b, me)?.troops ?? 0;
  if (own <= 0.5) return -1;
  const enemy = b.sides.filter((s) => s.owner !== me).reduce((t, s) => t + s.troops, 0);
  const ratio = own / (own + enemy);
  const close = 1 - Math.abs(ratio - 0.5) * 2;
  const value = b.nodeId !== null ? VALUE[g.map.nodes[b.nodeId].kind] : 2;
  return (0.3 + close) * value * Math.sqrt(own + enemy);
}

function commander(g: Game, ai: AiState, dt: number) {
  const me = ai.me;
  const L = AI_LEVELS[ai.level];
  ai.focusT -= dt;
  const cur = getBattle(g, g.presence[me]);
  if (cur && (cur.endedAt !== null || (sideOf(cur, me)?.troops ?? 0) <= 0.5)) g.presence[me] = null;
  if (ai.focusT <= 0) {
    ai.focusT = 0.5;
    let best: Battle | null = null;
    let bestScore = 0;
    for (const b of activeBattles(g)) {
      const s = importance(g, b, me) * (b.id === g.presence[me] ? 1.3 : 1);
      if (s > bestScore) {
        bestScore = s;
        best = b;
      }
    }
    if (best && best.id !== g.presence[me]) {
      g.presence[me] = best.id;
      ai.arriveT = L.switchTime;
      ai.qteT = L.qteEvery;
    }
  }
  if (g.presence[me] === null) return;
  if (ai.arriveT > 0) {
    ai.arriveT -= dt;
    return;
  }
  ai.qteT -= dt;
  if (ai.qteT <= 0) {
    ai.qteT = L.qteEvery * (0.8 + ai.rng() * 0.4);
    const kind = QTE_KINDS[Math.floor(ai.rng() * QTE_KINDS.length)];
    applyQte(g, g.presence[me]!, me, kind, ai.rng() < L.success);
    const b = getBattle(g, g.presence[me]);
    if (b && (sideOf(b, me)?.rally ?? 0) >= 1) useFinisher(g, b.id, me);
    // Inspire a close fight that is slipping away.
    const own = b ? sideOf(b, me)?.troops ?? 0 : 0;
    const foe = b ? b.sides.filter((x) => x.owner !== me).reduce((t, x) => t + Math.max(0, x.troops), 0) : 0;
    if (b && own > 5 && own / (own + foe) < 0.55) useAbility(g, me, 'inspire', b.id);
  }
}

export function aiStep(g: Game, ai: AiState, dt: number) {
  if (g.winner !== null) return;
  ai.thinkT -= dt;
  if (ai.thinkT <= 0) {
    think(g, ai);
    ai.thinkT = AI_LEVELS[ai.level].think;
  }
  if (ai.commander) commander(g, ai, dt);
}
