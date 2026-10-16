import type { Pt } from './map';
import { findCellPath } from './path';
import { mulberry32, type Rng } from './rng';
import {
  applyRally,
  applyStrike,
  beginMinigame,
  canSee,
  canRally,
  canStrike,
  dist,
  getUnit,
  orderMove,
  type Game,
  type Team,
  type Unit,
} from './sim';

export type Difficulty = 'easy' | 'normal' | 'hard';

/** How often the AI "plays" a mini-game and how well. It has one pair of hands, like the player. */
export const AI_SKILL: Record<Difficulty, { microEvery: number; perfect: number; good: number; think: number }> = {
  easy: { microEvery: 6.0, perfect: 0.2, good: 0.5, think: 2.4 },
  normal: { microEvery: 3.6, perfect: 0.35, good: 0.5, think: 1.6 },
  hard: { microEvery: 2.4, perfect: 0.5, good: 0.42, think: 1.0 },
};

interface Group {
  ids: number[];
  route: Pt[];
  wp: number;
  mode: 'advance' | 'retreat' | 'assault';
  lastTarget: Pt | null;
  /** Flankers back off from even fights; the main army only from clearly losing ones. */
  cautious: boolean;
}

export interface AiState {
  team: Team;
  difficulty: Difficulty;
  groups: Group[];
  defenders: number[];
  thinkTimer: number;
  microTimer: number;
  rng: Rng;
}

/** Up to three routes between the strongholds that avoid each other where the map allows. */
export function distinctRoutes(g: Game, from: Pt, to: Pt, count = 3): Pt[][] {
  const m = g.map;
  const extra = new Float32Array(m.w * m.h);
  const routes: Pt[][] = [];
  for (let k = 0; k < count; k++) {
    const r = findCellPath(m, from, to, extra);
    if (!r) break;
    const overlap = routes.length
      ? r.filter((p) => routes.some((q) => q.some((s) => Math.abs(s.x - p.x) + Math.abs(s.y - p.y) < 4))).length / r.length
      : 0;
    if (overlap < 0.7) routes.push(r);
    for (const p of r) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = Math.floor(p.x) + dx;
          const y = Math.floor(p.y) + dy;
          if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
          extra[y * m.w + x] += 6;
        }
      }
    }
  }
  // Sample every few cells so groups advance in bounded steps.
  return routes.map((r) => r.filter((_, i) => i % 7 === 0 || i === r.length - 1));
}

export function createAi(g: Game, team: Team, difficulty: Difficulty, seed = 1): AiState {
  const own = g.units.filter((u) => u.team === team && u.alive);
  const hq = g.map.hq[team];
  const enemyHq = g.map.hq[1 - team];
  own.sort((a, b) => dist(a, hq) - dist(b, hq));
  const nDef = Math.max(2, Math.round(own.length * 0.15));
  const defenders = own.slice(0, nDef).map((u) => u.id);
  const rest = own.slice(nDef);
  const found = distinctRoutes(g, hq, enemyHq);
  const routes = found.length ? found : [[hq, enemyHq]];
  // One main army on the shortest route, plus a smaller flanking group when the army is big enough.
  const flank = rest.length >= 12 && routes.length > 1 ? Math.round(rest.length * 0.3) : 0;
  const groups: Group[] = [{ ids: [], route: routes[0], wp: 1, mode: 'advance', lastTarget: null, cautious: false }];
  if (flank) groups.push({ ids: [], route: routes[1], wp: 1, mode: 'advance', lastTarget: null, cautious: true });
  // The flankers are the units already closest to the flanking route.
  const side = flank ? routes[1][Math.min(3, routes[1].length - 1)] : null;
  if (side) rest.sort((p, q) => dist(p, side) - dist(q, side));
  rest.forEach((u, k) => groups[k < flank ? 1 : 0].ids.push(u.id));
  return { team, difficulty, groups, defenders, thinkTimer: 0.5, microTimer: AI_SKILL[difficulty].microEvery, rng: mulberry32(seed) };
}

const centroid = (us: Unit[]): Pt => ({
  x: us.reduce((s, u) => s + u.x, 0) / us.length,
  y: us.reduce((s, u) => s + u.y, 0) / us.length,
});

function moveIfChanged(g: Game, gr: Group, units: Unit[], target: Pt) {
  const idle = units.filter((u) => !u.contact);
  const changed = !gr.lastTarget || dist(gr.lastTarget, target) > 1.5;
  const stragglers = idle.filter((u) => !u.path.length && dist(u, target) > 6);
  if (changed) orderMove(g, idle.map((u) => u.id), target);
  else if (stragglers.length) orderMove(g, stragglers.map((u) => u.id), target);
  gr.lastTarget = target;
}

function think(g: Game, ai: AiState) {
  const m = g.map;
  const team = ai.team;
  const hq = m.hq[team];
  const enemyHq = m.hq[1 - team];
  // Under fog of war the AI only reacts to what its own units can see.
  const enemies = g.units.filter((u) => u.alive && u.team !== team && canSee(g, team, u));

  // Home defence: pull in extra units when the stronghold is threatened.
  ai.defenders = ai.defenders.filter((id) => getUnit(g, id));
  const threats = enemies.filter((e) => dist(e, hq) < 16).sort((a, b) => dist(a, hq) - dist(b, hq));
  while (ai.defenders.length < threats.length + 1) {
    let best: { gr: Group; u: Unit } | null = null;
    for (const gr of ai.groups) {
      for (const id of gr.ids) {
        const u = getUnit(g, id);
        if (u && (!best || dist(u, hq) < dist(best.u, hq))) best = { gr, u };
      }
    }
    if (!best || dist(best.u, hq) > 22) break;
    best.gr.ids = best.gr.ids.filter((id) => id !== best!.u.id);
    ai.defenders.push(best.u.id);
  }
  const defs = ai.defenders.map((id) => getUnit(g, id)!).filter(Boolean);
  if (threats.length) {
    // Hold the ring edge facing the threat; chasing out of the ring hands over the capture.
    defs.forEach((u, i) => {
      if (u.contact) return;
      const t = threats[i % threats.length];
      const d = dist(t, hq) || 1;
      const spot = d < 2.5 ? { x: t.x, y: t.y } : { x: hq.x + ((t.x - hq.x) / d) * 2, y: hq.y + ((t.y - hq.y) / d) * 2 };
      if (!u.path.length ? dist(u, spot) > 1.2 : dist(u.path[u.path.length - 1], spot) > 1.5) orderMove(g, [u.id], spot);
    });
  } else {
    // Hold a small ring on the side facing the enemy.
    const ang = Math.atan2(enemyHq.y - hq.y, enemyHq.x - hq.x);
    defs.forEach((u, i) => {
      const a = ang + (i - (defs.length - 1) / 2) * 0.7;
      // Inside the capture ring: defenders outside it do not block a capture.
      const spot = { x: hq.x + Math.cos(a) * 2.2, y: hq.y + Math.sin(a) * 2.2 };
      if (!u.contact && !u.path.length && dist(u, spot) > 1.2) orderMove(g, [u.id], spot);
    });
  }

  // Field groups advance along their routes, regroup, retreat to heal, then assault.
  ai.groups = ai.groups.filter((gr) => gr.ids.some((id) => getUnit(g, id)));
  // The field force has dwindled: fold the home guard and the stragglers into one attack group,
  // so the AI never just turtles and trickles single units into a defended stronghold.
  const fieldCount = ai.groups.reduce((s, gr) => s + gr.ids.length, 0);
  if (fieldCount < 3 && !threats.length && ai.defenders.length >= 1) {
    const routes = distinctRoutes(g, hq, enemyHq, 2);
    const total = fieldCount + ai.defenders.length;
    const keep = total > 4 ? 1 : 0;
    const ids = [...ai.groups.flatMap((gr) => gr.ids), ...ai.defenders.slice(keep)];
    ai.defenders = ai.defenders.slice(0, keep);
    ai.groups = [{ ids, route: routes[Math.floor(ai.rng() * routes.length)] ?? [hq, enemyHq], wp: 1, mode: 'advance', lastTarget: null, cautious: false }];
  }
  // A large push toward home pulls every field group back to meet it.
  const push = enemies.filter((e) => dist(e, hq) < 60);
  const pushCenter = push.length >= Math.max(3, enemies.length * 0.4) ? centroid(push) : null;
  // Fights in progress, so idle groups nearby can join them instead of marching past.
  const fights = ai.groups
    .map((gr) => gr.ids.map((id) => getUnit(g, id)).filter((u): u is Unit => !!u))
    .filter((us) => us.some((u) => u.targetId !== null))
    .map((us) => centroid(us));

  for (const gr of ai.groups) {
    const units = gr.ids.map((id) => getUnit(g, id)).filter((u): u is Unit => !!u);
    gr.ids = units.map((u) => u.id);
    const c = centroid(units);
    if (pushCenter && gr.mode !== 'retreat' && dist(c, enemyHq) > 20) {
      gr.mode = 'advance';
      // Bypassed: the push is between this group and home, so race home instead of chasing.
      moveIfChanged(g, gr, units, dist(pushCenter, hq) < dist(c, hq) - 5 ? hq : pushCenter);
      continue;
    }
    const fight = units.some((u) => u.targetId !== null) ? null : fights.find((f) => dist(f, c) < 28);
    if (fight && gr.mode === 'advance') {
      const near = enemies.filter((e) => dist(e, fight) < 12).sort((a, b) => dist(a, c) - dist(b, c))[0];
      if (near) {
        moveIfChanged(g, gr, units, { x: near.x, y: near.y });
        continue;
      }
    }
    const hpFrac = units.reduce((s, u) => s + u.hp / u.maxHp, 0) / units.length;
    const engaged = units.some((u) => u.targetId !== null);
    const local = enemies.filter((e) => dist(e, c) < 12);
    const localHp = local.reduce((s, e) => s + e.hp, 0);
    const ownHp = units.reduce((s, u) => s + u.hp, 0);

    if (gr.mode !== 'assault' && dist(c, enemyHq) < 16 && localHp < ownHp * 1.2) gr.mode = 'assault';
    // With three or fewer units left there is nothing to regroup for: all in.
    const allIn = g.units.filter((u) => u.alive && u.team === team).length <= 3;
    if (allIn && gr.mode === 'retreat') gr.mode = 'advance';
    if (!allIn && gr.mode !== 'retreat' && (hpFrac < 0.35 || localHp > ownHp * (gr.cautious ? 1.2 : 1.7))) gr.mode = 'retreat';
    if (gr.mode === 'retreat' && hpFrac > 0.8) {
      gr.mode = 'advance';
      let bi = 0;
      gr.route.forEach((p, i) => {
        if (dist(p, c) < dist(gr.route[bi], c)) bi = i;
      });
      gr.wp = bi;
    }

    if (gr.mode === 'retreat') {
      moveIfChanged(g, gr, units, hq);
    } else if (gr.mode === 'assault') {
      moveIfChanged(g, gr, units, enemyHq);
    } else if (engaged) {
      // Pile in on the nearest enemy: more attackers on one target means flanking damage.
      const near = local.sort((a, b) => dist(a, c) - dist(b, c))[0];
      if (near) moveIfChanged(g, gr, units, { x: near.x, y: near.y });
    } else {
      const target = gr.route[Math.min(gr.wp, gr.route.length - 1)];
      const spread = Math.max(...units.map((u) => dist(u, c)));
      const arrived = units.every((u) => !u.path.length);
      if ((dist(c, target) < 6 && spread < 10) || (arrived && dist(c, target) < 12)) gr.wp = Math.min(gr.wp + 1, gr.route.length - 1);
      moveIfChanged(g, gr, units, gr.route[Math.min(gr.wp, gr.route.length - 1)]);
    }
  }
}

function micro(g: Game, ai: AiState) {
  const skill = AI_SKILL[ai.difficulty];
  let best: { u: Unit; kind: 'strike' | 'rally'; score: number } | null = null;
  for (const u of g.units) {
    if (!u.alive || u.team !== ai.team) continue;
    if (canRally(g, u)) {
      const score = 3 * (1 - u.hp / u.maxHp) + (u.targetId !== null ? 0.5 : 0);
      if (!best || score > best.score) best = { u, kind: 'rally', score };
    }
    if (canStrike(g, u)) {
      const score = 1.2 + (u.contact ? 0.3 : 0);
      if (!best || score > best.score) best = { u, kind: 'strike', score };
    }
  }
  if (!best) return false;
  beginMinigame(g, best.u, best.kind);
  const roll = ai.rng();
  const q: 0 | 1 | 2 = roll < skill.perfect ? 2 : roll < skill.perfect + skill.good ? 1 : 0;
  if (best.kind === 'strike') applyStrike(g, best.u, q);
  else applyRally(g, best.u, q === 2 ? 0.3 : q === 1 ? 0.15 : 0);
  return true;
}

export function aiStep(g: Game, ai: AiState, dt: number) {
  if (g.winner !== null) return;
  ai.thinkTimer -= dt;
  if (ai.thinkTimer <= 0) {
    think(g, ai);
    ai.thinkTimer = AI_SKILL[ai.difficulty].think;
  }
  ai.microTimer -= dt;
  if (ai.microTimer <= 0) {
    // When nothing is worth boosting, check again soon instead of banking the time.
    ai.microTimer = micro(g, ai) ? AI_SKILL[ai.difficulty].microEvery * (0.8 + ai.rng() * 0.4) : 0.5;
  }
}
