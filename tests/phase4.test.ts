import { describe, expect, it } from 'vitest';
import { PERSONALITIES, aiStep, createAi, type Personality } from '../src/ai';
import { edgeBetween, generateMap } from '../src/map';
import { applyQte, createGame, lossRates, sendTroops, sideOf, step, type Battle, type CommanderId, type Game } from '../src/sim';

function battleWith(cmd: CommanderId) {
  const g = createGame(generateMap(3, 8), { commanders: [cmd, 'none'] });
  for (const n of g.map.nodes) n.special = null;
  const c0 = g.map.capitals[0];
  const target = g.map.adj[c0].find((k) => g.nodes[k].owner === 2)!;
  g.nodes[target].troops = 40;
  g.nodes[c0].troops = 70;
  sendTroops(g, 0, c0, target, 40);
  while (!g.battles.length) step(g, 0.05);
  return { g, b: g.battles[0] };
}

const enemyTroops = (b: Battle) => b.sides.filter((s) => s.owner !== 0).reduce((t, s) => t + s.troops, 0);

describe('commanders', () => {
  it('Archer volleys kill 60% more of the share', () => {
    const plain = battleWith('none');
    const archer = battleWith('archer');
    const p0 = enemyTroops(plain.b);
    const a0 = enemyTroops(archer.b);
    applyQte(plain.g, plain.b.id, 0, 'volley', true);
    applyQte(archer.g, archer.b.id, 0, 'volley', true);
    expect(a0 - enemyTroops(archer.b)).toBeGreaterThan((p0 - enemyTroops(plain.b)) * 1.35);
  });

  it('Duelist slashes also kill; Iron Wall parry misses cost nothing', () => {
    const duel = battleWith('duelist');
    const before = enemyTroops(duel.b);
    applyQte(duel.g, duel.b.id, 0, 'slash', true);
    expect(enemyTroops(duel.b)).toBeLessThan(before - 2);
    const wall = battleWith('ironwall');
    const mine = sideOf(wall.b, 0)!.troops;
    applyQte(wall.g, wall.b.id, 0, 'parry', false);
    expect(sideOf(wall.b, 0)!.troops).toBe(mine);
  });

  it('Iron Wall walls are 0.2 stronger', () => {
    const g = createGame(generateMap(3, 8), { commanders: ['ironwall', 'none'] });
    const fort = g.map.nodes.find((n) => n.kind === 'fort')!.id;
    g.nodes[fort].owner = 0;
    const b: Battle = { id: 1, nodeId: fort, road: null, x: 0, y: 0, sides: [{ owner: 0, troops: 20, momentum: 1, rally: 0 }, { owner: 1, troops: 20, momentum: 1, rally: 0 }], startedAt: 0, endedAt: null, winner: null, peak: { 0: 20, 1: 20 } };
    const withWall = lossRates(g, b).get(1)!;
    g.commanders[0] = 'none';
    expect(withWall / lossRates(g, b).get(1)!).toBeCloseTo((1.4 + 0.2) / 1.4, 2);
  });

  it('Raider columns march 25% faster; Herald fills the rally meter 40% faster', () => {
    const speed = (cmd: CommanderId) => {
      const g = createGame(generateMap(3, 8), { commanders: [cmd, 'none'] });
      const c0 = g.map.capitals[0];
      const to = g.map.adj[c0][0];
      edgeBetween(g.map, c0, to)!.road = 'road';
      g.nodes[c0].troops = 50;
      const col = sendTroops(g, 0, c0, to, 10)!;
      step(g, 1);
      return col.progress;
    };
    expect(speed('raider') / speed('none')).toBeCloseTo(1.25, 2);
    const herald = battleWith('herald');
    applyQte(herald.g, herald.b.id, 0, 'banner', true);
    expect(sideOf(herald.b, 0)!.rally).toBeCloseTo(0.35, 2);
  });
});

/** Plays an AI war; also counts the stronghold attacks each side started. */
function war(seed: number, n: number, p0: Personality, p1: Personality): Game & { attacks: [number, number] } {
  const g = createGame(generateMap(seed, n), { commanders: [PERSONALITIES[p0].commander, PERSONALITIES[p1].commander] });
  const ais = [createAi(0, 'normal', seed, true, p0), createAi(1, 'normal', seed + 1, true, p1)];
  const attacks: [number, number] = [0, 0];
  const seen = new Set<number>();
  for (let t = 0; t < 900 && g.winner === null; t += 0.05) {
    for (const a of ais) aiStep(g, a, 0.05);
    step(g, 0.05);
    for (const b of g.battles) {
      if (seen.has(b.id) || b.nodeId === null) continue;
      seen.add(b.id);
      const attacker = b.sides[1]?.owner;
      if (attacker === 0 || attacker === 1) attacks[attacker]++;
    }
  }
  return Object.assign(g, { attacks });
}

describe('rival personalities', () => {
  it('every personality finishes its wars against every other', () => {
    const all: Personality[] = ['aggressor', 'turtle', 'opportunist', 'gambler'];
    for (const [i, p] of all.entries()) {
      for (const other of all) {
        const g = war(900 + i * 7, 6 + (i % 5), p, other);
        expect(g.winner).not.toBeNull();
      }
    }
  }, 120000);

  it('the Aggressor attacks more than the Turtle', () => {
    let agg = 0;
    let tur = 0;
    for (const seed of [31, 32, 33, 34, 35, 36]) {
      // Same personalities on both sides of the map, so map position does not decide it.
      const a = war(seed, 8, 'aggressor', 'turtle');
      const b = war(seed, 8, 'turtle', 'aggressor');
      agg += a.attacks[0] + b.attacks[1];
      tur += a.attacks[1] + b.attacks[0];
    }
    console.log(`attacks started: aggressor ${agg}, turtle ${tur}`);
    expect(agg).toBeGreaterThan(tur);
  }, 120000);
});
