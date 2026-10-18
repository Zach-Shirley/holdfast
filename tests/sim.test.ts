import { describe, expect, it } from 'vitest';
import { aiStep, createAi, type Difficulty } from '../src/ai';
import { WORLD_H, WORLD_W, generateMap, hops } from '../src/map';
import { applyQte, createGame, getBattle, lossRates, sendTroops, step, type Game } from '../src/sim';

function run(g: Game, seconds: number, ais: ReturnType<typeof createAi>[] = []) {
  for (let t = 0; t < seconds && g.winner === null; t += 0.05) {
    for (const a of ais) aiStep(g, a, 0.05);
    step(g, 0.05);
  }
}

describe('map generation', () => {
  for (const n of [6, 7, 8, 9, 10]) {
    it(`${n} nodes: connected, symmetric, capitals apart`, () => {
      for (const seed of [1, 2, 3, 4, 5, 99, 1234]) {
        const m = generateMap(seed, n);
        expect(m.nodes.length).toBe(n);
        for (const node of m.nodes) {
          expect(hops(m, m.capitals[0], node.id)).toBeGreaterThanOrEqual(0);
          expect(m.adj[node.id].length).toBeGreaterThanOrEqual(2);
          const o = m.nodes[m.mirror[node.id]];
          expect(o.x).toBeCloseTo(WORLD_W - node.x);
          expect(o.y).toBeCloseTo(WORLD_H - node.y);
          expect(o.kind).toBe(node.kind);
        }
        expect(hops(m, m.capitals[0], m.capitals[1])).toBeGreaterThanOrEqual(3);
      }
    });
  }
  it('is deterministic', () => {
    expect(JSON.stringify(generateMap(42, 8))).toBe(JSON.stringify(generateMap(42, 8)));
  });
});

describe('troops and battles', () => {
  it('garrisons grow up to their cap', () => {
    const g = createGame(generateMap(3, 8));
    const cap = g.nodes[g.map.capitals[0]];
    run(g, 20);
    expect(cap.troops).toBeGreaterThan(45);
    run(g, 200);
    expect(cap.troops).toBeCloseTo(70, 0);
  });

  it('a strong column takes a neutral node; a weak one fails', () => {
    const g = createGame(generateMap(3, 8));
    const c0 = g.map.capitals[0];
    const target = g.map.adj[c0].find((k) => g.nodes[k].owner === 2)!;
    g.nodes[c0].troops = 80;
    sendTroops(g, 0, c0, target, 60);
    run(g, 40);
    expect(g.nodes[target].owner).toBe(0);
    const g2 = createGame(generateMap(3, 8));
    sendTroops(g2, 0, c0, target, 2);
    run(g2, 40);
    expect(g2.nodes[target].owner).toBe(2);
  });

  it('even battles take long enough to matter (10-30 s)', () => {
    const g = createGame(generateMap(3, 8));
    const c0 = g.map.capitals[0];
    const target = g.map.adj[c0].find((k) => g.nodes[k].owner === 2)!;
    g.nodes[target].troops = 30;
    g.nodes[c0].troops = 90;
    sendTroops(g, 0, c0, target, 48);
    let started = -1;
    let ended = -1;
    for (let t = 0; t < 120 && ended < 0; t += 0.05) {
      step(g, 0.05);
      const b = g.battles[0];
      if (b && started < 0) started = g.time;
      if (b && b.endedAt !== null) ended = b.endedAt;
    }
    expect(ended - started).toBeGreaterThan(10);
    expect(ended - started).toBeLessThan(30);
  });

  it('defenders fight harder from a fort', () => {
    const g = createGame(generateMap(3, 8));
    const fort = g.map.nodes.find((n) => n.kind === 'fort')!.id;
    const b = { id: 1, nodeId: fort, road: null, x: 0, y: 0, sides: [{ owner: 2 as const, troops: 20, momentum: 1 }, { owner: 0 as const, troops: 20, momentum: 1 }], startedAt: 0, endedAt: null, winner: null, peak: {} };
    const r = lossRates(g, b);
    expect(r.get(0)!).toBeGreaterThan(r.get(2)! * 1.35);
  });

  it('opposing columns meeting on a road fight there', () => {
    const g = createGame(generateMap(3, 8));
    const [c0] = g.map.capitals;
    const mid = g.map.adj[c0][0];
    g.nodes[mid].owner = 1;
    g.nodes[mid].troops = 30;
    g.nodes[c0].troops = 60;
    sendTroops(g, 0, c0, mid, 25);
    sendTroops(g, 1, mid, c0, 20);
    run(g, 6);
    expect(g.battles.some((b) => b.road !== null)).toBe(true);
  });

  it('quick-time successes swing an even battle', () => {
    const make = () => {
      const g = createGame(generateMap(3, 8));
      const c0 = g.map.capitals[0];
      const target = g.map.adj[c0].find((k) => g.nodes[k].owner === 2)!;
      g.nodes[target].troops = 30;
      g.nodes[c0].troops = 90;
      sendTroops(g, 0, c0, target, 26);
      while (!g.battles.length) step(g, 0.05);
      return { g, target };
    };
    const plain = make();
    run(plain.g, 60);
    expect(plain.g.nodes[plain.target].owner).toBe(2);
    const boosted = make();
    const kinds = ['volley', 'parry', 'slash', 'banner'] as const;
    for (let i = 0; i < 60 * 20 && boosted.g.battles[0].endedAt === null; i++) {
      if (i % 34 === 0) applyQte(boosted.g, boosted.g.battles[0].id, 0, kinds[(i / 34) % 4], true);
      step(boosted.g, 0.05);
    }
    expect(boosted.g.nodes[boosted.target].owner).toBe(0);
    expect(getBattle(boosted.g, boosted.g.battles[0].id)!.winner).toBe(0);
  });
});

describe('AI', () => {
  for (const [n, seed, level] of [[6, 11, 'normal'], [8, 12, 'normal'], [10, 13, 'normal'], [8, 14, 'hard'], [7, 15, 'easy'], [9, 16, 'normal']] as const) {
    it(`AI vs AI finishes (${n} nodes, ${level})`, () => {
      const g = createGame(generateMap(seed, n));
      const ais = [createAi(0, level as Difficulty, 1), createAi(1, level as Difficulty, 2)];
      run(g, 900, ais);
      console.log(`AIvAI n=${n} ${level}: winner=${g.winner} (${g.winReason}) at ${g.time.toFixed(0)}s, battles=${g.battles.length}`);
      expect(g.winner).not.toBeNull();
    }, 60000);
  }

  it('wars end decisively: most of 20 random maps end by capture before the clock', () => {
    const times: number[] = [];
    let stuck = 0;
    let timeouts = 0;
    for (let i = 0; i < 20; i++) {
      const g = createGame(generateMap(500 + i * 37, 6 + (i % 5)));
      run(g, 900, [createAi(0, 'normal', i), createAi(1, 'normal', i + 99)]);
      if (g.winner === null) stuck++;
      else times.push(g.time);
      if (g.winReason.startsWith('Time')) timeouts++;
    }
    times.sort((a, b) => a - b);
    console.log(`sweep: stuck=${stuck}, timeouts=${timeouts}, median=${times[times.length >> 1]?.toFixed(0)}s, range=${times[0]?.toFixed(0)}-${times[times.length - 1]?.toFixed(0)}s`);
    expect(stuck).toBe(0);
    expect(timeouts).toBeLessThanOrEqual(5);
  }, 120000);

  it('a commander who plays quick-time events beats one who never does', () => {
    let wins = 0;
    const seeds = [21, 22, 23, 24, 25, 26];
    for (const seed of seeds) {
      for (const side of [0, 1] as const) {
        const g = createGame(generateMap(seed, 8));
        const withCmd = createAi(side, 'normal', seed, true);
        const without = createAi((1 - side) as 0 | 1, 'normal', seed + 1, false);
        run(g, 900, [withCmd, without]);
        if (g.winner === side) wins++;
      }
    }
    console.log(`commander wins ${wins}/${seeds.length * 2}`);
    expect(wins).toBeGreaterThanOrEqual(Math.ceil(seeds.length * 2 * 0.75));
  }, 120000);
});
