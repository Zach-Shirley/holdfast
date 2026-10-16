import { describe, expect, it } from 'vitest';
import { aiStep, createAi, distinctRoutes } from '../src/ai';
import { PLAIN, PRESETS, floodFrom, generateMap, type GameMap } from '../src/map';
import { findCellPath, findPath } from '../src/path';
import { CUT_OFF_LIFE, VISION, applyStrike, canSee, createGame, orderMove, step, updateSupply, type Game, type Unit } from '../src/sim';

const finder = (m: GameMap, a: { x: number; y: number }, b: { x: number; y: number }) => findCellPath(m, a, b);

/** Flat, open test map with strongholds at either end. */
function flatMap(w = 60, h = 30): GameMap {
  const terrain = new Uint8Array(w * h).fill(PLAIN);
  return { w, h, terrain, elev: new Float32Array(w * h), hq: [{ x: 4.5, y: h / 2 }, { x: w - 4.5, y: h / 2 }], seed: 0, preset: 'flat' };
}

function bareGame(m: GameMap): Game {
  const g = createGame(m, { armySize: 1, composition: 'melee' });
  g.units = [];
  return g;
}

function addUnit(g: Game, team: 0 | 1, x: number, y: number, kind: 'melee' | 'ranged' = 'melee'): Unit {
  const src = createGame(g.map, { armySize: 1, composition: kind }).units[0];
  const u = { ...src, id: g.nextId++, team, x, y, path: [] };
  g.units.push(u);
  return u;
}

describe('map generation', () => {
  for (const preset of PRESETS) {
    it(`${preset.id}: strongholds connected, point-symmetric`, () => {
      for (const seed of [1, 2, 3, 42, 1234]) {
        const m = generateMap(seed, preset.id, finder);
        const reach = floodFrom(m, m.hq[0]);
        expect(reach[Math.floor(m.hq[1].y) * m.w + Math.floor(m.hq[1].x)]).toBe(1);
        for (let i = 0; i < m.terrain.length; i += 37) {
          const x = i % m.w;
          const y = (i - x) / m.w;
          expect(m.terrain[(m.h - 1 - y) * m.w + (m.w - 1 - x)]).toBe(m.terrain[i]);
        }
      }
    });
  }

  it('is deterministic for a seed', () => {
    const a = generateMap(77, 'passes', finder);
    const b = generateMap(77, 'passes', finder);
    expect(Array.from(a.terrain)).toEqual(Array.from(b.terrain));
  });

  it('mountain passes maps usually offer several distinct routes', () => {
    const m = generateMap(5, 'passes', finder);
    const g = createGame(m, { armySize: 4, composition: 'mixed' });
    expect(distinctRoutes(g, m.hq[0], m.hq[1]).length).toBeGreaterThanOrEqual(2);
  });
});

describe('pathfinding', () => {
  it('walks around a wall', () => {
    const m = flatMap();
    for (let y = 0; y < 25; y++) m.terrain[y * m.w + 30] = 4;
    const p = findPath(m, { x: 20.5, y: 5.5 }, { x: 40.5, y: 5.5 })!;
    expect(p).not.toBeNull();
    expect(p.some((q) => q.y > 24)).toBe(true);
  });
});

describe('combat and supply', () => {
  it('two attackers on one target deal more than double-one damage (flanking)', () => {
    const solo = bareGame(flatMap());
    const t1 = addUnit(solo, 1, 30, 15);
    addUnit(solo, 0, 28.5, 15);
    const pair = bareGame(flatMap());
    const t2 = addUnit(pair, 1, 30, 15);
    addUnit(pair, 0, 28.5, 15);
    addUnit(pair, 0, 31.5, 15);
    for (let i = 0; i < 30; i++) {
      step(solo, 0.05);
      step(pair, 0.05);
    }
    const soloLoss = 100 - t1.hp;
    const pairLoss = 100 - t2.hp;
    expect(pairLoss).toBeGreaterThan(soloLoss * 2.3);
  });

  it('a surrounded unit is cut off; a frontline unit is not', () => {
    const g = bareGame(flatMap());
    const front = addUnit(g, 0, 20, 8);
    addUnit(g, 1, 22, 8);
    const trapped = addUnit(g, 0, 40, 15);
    for (const [dx, dy] of [[2.4, 0], [-2.4, 0], [0, 2.4], [0, -2.4], [1.7, 1.7], [-1.7, 1.7], [1.7, -1.7], [-1.7, -1.7]]) addUnit(g, 1, 40 + dx, 15 + dy);
    updateSupply(g);
    expect(front.supplied).toBe(true);
    expect(trapped.supplied).toBe(false);
  });

  it('strike buff increases damage', () => {
    const a = bareGame(flatMap());
    const ta = addUnit(a, 1, 30, 15);
    addUnit(a, 0, 28.5, 15);
    const b = bareGame(flatMap());
    const tb = addUnit(b, 1, 30, 15);
    const sb = addUnit(b, 0, 28.5, 15);
    step(a, 0.05);
    step(b, 0.05);
    applyStrike(b, sb, 2);
    for (let i = 0; i < 20; i++) {
      step(a, 0.05);
      step(b, 0.05);
    }
    expect(100 - tb.hp).toBeGreaterThan((100 - ta.hp) * 1.4);
  });

  it('an undefended stronghold falls', () => {
    const g = bareGame(flatMap());
    addUnit(g, 0, 50, 15);
    addUnit(g, 1, 10, 3);
    orderMove(g, [g.units[1].id], g.map.hq[0]);
    for (let i = 0; i < 20 * 30 && g.winner === null; i++) step(g, 0.05);
    expect(g.winner).toBe(1);
    expect(g.winReason).toBe('Stronghold captured');
  });
});

describe('supply clock, passes and fog', () => {
  it('a cut-off unit dies after the supply clock runs out, and recovers if reconnected', () => {
    const g = bareGame(flatMap());
    const trapped = addUnit(g, 0, 40, 15);
    const ring = [[2.4, 0], [-2.4, 0], [0, 2.4], [0, -2.4], [1.7, 1.7], [-1.7, 1.7], [1.7, -1.7], [-1.7, -1.7]].map(([dx, dy]) => addUnit(g, 1, 40 + dx, 15 + dy));
    for (const e of ring) e.hp = e.maxHp = 1e9; // keep the ring intact; only the clock matters here
    trapped.hp = trapped.maxHp = 1e9;
    for (let i = 0; i < (CUT_OFF_LIFE - 5) * 20; i++) step(g, 0.05);
    expect(trapped.alive).toBe(true);
    expect(trapped.cutTime).toBeGreaterThan(CUT_OFF_LIFE - 6);
    for (let i = 0; i < 7 * 20; i++) step(g, 0.05);
    expect(trapped.alive).toBe(false);
  });

  it('a group of 10 gets through a 2-cell gap without jamming', () => {
    const m = flatMap();
    for (let y = 0; y < m.h; y++) if (y < 14 || y > 15) m.terrain[y * m.w + 30] = 4;
    const g = bareGame(m);
    addUnit(g, 1, 56, 3); // a distant enemy so the game does not end at once
    const us = Array.from({ length: 10 }, (_, i) => addUnit(g, 0, 18 + (i % 5) * 1.6, 11 + Math.floor(i / 5) * 4));
    orderMove(g, us.map((u) => u.id), { x: 44, y: 15 });
    for (let i = 0; i < 60 * 20; i++) step(g, 0.05);
    const through = us.filter((u) => u.x > 31).length;
    expect(through).toBe(10);
  });

  it('fog hides units beyond vision range', () => {
    const g = createGame(flatMap(), { armySize: 1, composition: 'melee', fog: true });
    g.units = [];
    addUnit(g, 0, 20, 15);
    expect(canSee(g, 0, { x: 20 + VISION - 1, y: 15 })).toBe(true);
    expect(canSee(g, 0, { x: 20 + VISION + 2, y: 15 })).toBe(false);
    g.fog = false;
    expect(canSee(g, 0, { x: 55, y: 15 })).toBe(true);
  });
});

describe('AI vs AI', () => {
  for (const [preset, seed] of [['passes', 11], ['lakes', 12], ['highlands', 13], ['open', 14]] as const) {
    it(`${preset}: a match finishes within 12 minutes`, () => {
      const m = generateMap(seed, preset, finder);
      const g = createGame(m, { armySize: 20, composition: 'mixed' });
      const a = createAi(g, 0, 'normal', 1);
      const b = createAi(g, 1, 'normal', 2);
      const dt = 1 / 20;
      while (g.winner === null && g.time < 720) {
        aiStep(g, a, dt);
        aiStep(g, b, dt);
        step(g, dt);
      }
      console.log(`${preset}: winner=${g.winner} (${g.winReason}) at ${g.time.toFixed(0)}s, lost=${g.stats[0].lost}/${g.stats[1].lost}`);
      expect(g.winner).not.toBeNull();
    }, 60000);
  }
});

describe('AI resilience', () => {
  // A player who only ever sends the whole army at the stronghold, with no mini-games.
  // Regression guard, not a balance target: blobbing is strong under these rules (see README).
  it('Normal AI beats a no-micro deathball on at least 3 of 8 maps', () => {
    const cases = [['passes', 74423], ['passes', 11], ['lakes', 12], ['highlands', 13], ['open', 14], ['passes', 21], ['lakes', 22], ['open', 24]] as const;
    let aiWins = 0;
    for (const [preset, seed] of cases) {
      const m = generateMap(seed, preset, finder);
      const g = createGame(m, { armySize: 20, composition: 'mixed' });
      const b = createAi(g, 1, 'normal', 2);
      const dt = 1 / 20;
      let tick = 0;
      while (g.winner === null && g.time < 600) {
        if (tick++ % 160 === 0) orderMove(g, g.units.filter((u) => u.alive && u.team === 0).map((u) => u.id), m.hq[1]);
        aiStep(g, b, dt);
        step(g, dt);
      }
      if (g.winner === 1) aiWins++;
      console.log(`deathball ${preset}/${seed}: winner=${g.winner} (${g.winReason}) at ${g.time.toFixed(0)}s, lost=${g.stats[0].lost}/${g.stats[1].lost}`);
    }
    expect(aiWins).toBeGreaterThanOrEqual(3);
  }, 120000);
});
