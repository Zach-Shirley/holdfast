import { describe, expect, it } from 'vitest';
import { aiStep, createAi } from '../src/ai';
import { ROAD_SPEED, edgeBetween, generateMap } from '../src/map';
import {
  ABILITIES,
  BARRACKS_GROWTH,
  FORGE_MOMENTUM,
  applyQte,
  canSee,
  createGame,
  knownNode,
  sendTroops,
  setRally,
  sideOf,
  step,
  useAbility,
  type Game,
} from '../src/sim';

function run(g: Game, seconds: number, ais: ReturnType<typeof createAi>[] = []) {
  for (let t = 0; t < seconds && g.winner === null; t += 0.05) {
    for (const a of ais) aiStep(g, a, 0.05);
    step(g, 0.05);
  }
}

describe('map decoration', () => {
  it('every map has symmetric specials and road types', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      for (const n of [6, 8, 10]) {
        const m = generateMap(seed, n);
        expect(m.nodes.filter((x) => x.special).length).toBeGreaterThanOrEqual(2);
        for (const node of m.nodes) expect(m.nodes[m.mirror[node.id]].special).toBe(node.special);
        for (const e of m.edges) expect(edgeBetween(m, m.mirror[e.a], m.mirror[e.b])!.road).toBe(e.road);
        expect(m.nodes[m.capitals[0]].special).toBeNull();
      }
    }
  });
});

describe('special strongholds', () => {
  it('a barracks grows 50% faster', () => {
    const g = createGame(generateMap(3, 8));
    const node = g.map.nodes.find((n) => n.kind === 'village')!;
    const twin = g.map.nodes.find((n) => n.kind === 'village' && n.id !== node.id)!;
    node.special = 'barracks';
    twin.special = null;
    for (const id of [node.id, twin.id]) {
      g.nodes[id].owner = 0;
      g.nodes[id].troops = 0;
    }
    run(g, 10);
    expect(g.nodes[node.id].troops / g.nodes[twin.id].troops).toBeCloseTo(BARRACKS_GROWTH, 1);
  });

  it('a forge next door gives your battles starting momentum; a shrine strengthens quick-time events', () => {
    const make = (special: 'forge' | 'shrine' | null) => {
      const g = createGame(generateMap(3, 8));
      const c0 = g.map.capitals[0];
      const target = g.map.adj[c0].find((k) => g.nodes[k].owner === 2)!;
      for (const n of g.map.nodes) n.special = null;
      g.map.nodes[c0].special = special;
      g.nodes[target].troops = 30;
      g.nodes[c0].troops = 70;
      sendTroops(g, 0, c0, target, 30);
      while (!g.battles.length) step(g, 0.05);
      return { g, b: g.battles[0] };
    };
    expect(sideOf(make('forge').b, 0)!.momentum).toBeCloseTo(1 + FORGE_MOMENTUM, 2);
    expect(sideOf(make(null).b, 0)!.momentum).toBeCloseTo(1, 2);
    const plain = make(null);
    const shrine = make('shrine');
    const p0 = sideOf(plain.b, 2)!.troops;
    const s0 = sideOf(shrine.b, 2)!.troops;
    applyQte(plain.g, plain.b.id, 0, 'volley', true);
    applyQte(shrine.g, shrine.b.id, 0, 'volley', true);
    expect((s0 - sideOf(shrine.b, 2)!.troops) / (p0 - sideOf(plain.b, 2)!.troops)).toBeCloseTo(1.25, 2);
  });
});

describe('roads, rally routes and abilities', () => {
  it('marsh roads are slow, paved roads fast, forced march doubles speed', () => {
    const progressOn = (road: 'road' | 'marsh' | 'paved', forced = false) => {
      const g = createGame(generateMap(3, 8));
      const c0 = g.map.capitals[0];
      const to = g.map.adj[c0][0];
      edgeBetween(g.map, c0, to)!.road = road;
      g.nodes[c0].troops = 50;
      const col = sendTroops(g, 0, c0, to, 10)!;
      if (forced) useAbility(g, 0, 'march', col.id);
      step(g, 1);
      return col.progress;
    };
    const base = progressOn('road');
    expect(progressOn('marsh') / base).toBeCloseTo(ROAD_SPEED.marsh, 2);
    expect(progressOn('paved') / base).toBeCloseTo(ROAD_SPEED.paved, 2);
    expect(progressOn('road', true) / base).toBeCloseTo(2, 2);
  });

  it('a rally route forwards surplus troops automatically and clears when the node is lost', () => {
    const g = createGame(generateMap(3, 8));
    const c0 = g.map.capitals[0];
    const mine = g.map.adj[c0][0];
    g.nodes[mine].owner = 0;
    g.nodes[mine].troops = 5;
    g.nodes[c0].troops = 40;
    expect(setRally(g, 0, c0, mine)).toBe(true);
    run(g, 20);
    expect(g.nodes[mine].troops).toBeGreaterThan(30);
    expect(g.nodes[c0].troops).toBeLessThan(20);
    g.nodes[mine].owner = 1;
    run(g, 2);
    expect(g.nodes[c0].rallyTo).toBeNull();
  });

  it('abilities respect cooldowns; inspire lifts a battle', () => {
    const g = createGame(generateMap(3, 8));
    const c0 = g.map.capitals[0];
    const target = g.map.adj[c0].find((k) => g.nodes[k].owner === 2)!;
    g.nodes[c0].troops = 70;
    sendTroops(g, 0, c0, target, 30);
    while (!g.battles.length) step(g, 0.05);
    const b = g.battles[0];
    const m0 = sideOf(b, 0)!.momentum;
    expect(useAbility(g, 0, 'inspire', b.id)).toBe(true);
    expect(sideOf(b, 0)!.momentum).toBeCloseTo(m0 + 0.6, 2);
    expect(useAbility(g, 0, 'inspire', b.id)).toBe(false);
    run(g, ABILITIES.inspire.cooldown + 1);
    expect(g.abilityReady[0].inspire).toBeLessThanOrEqual(g.time);
  });
});

describe('fog of war', () => {
  it('you only see near your own strongholds and columns, remember the rest, and Spy reveals everything', () => {
    const g = createGame(generateMap(3, 8), { fog: true });
    for (const n of g.map.nodes) n.special = null;
    const far = g.map.nodes[g.map.capitals[1]];
    const home = g.map.nodes[g.map.capitals[0]];
    expect(canSee(g, 0, home.x, home.y)).toBe(true);
    expect(canSee(g, 0, far.x, far.y)).toBe(false);
    run(g, 30);
    const k = knownNode(g, 0, far.id);
    expect(k.live).toBe(false);
    expect(k.troops).toBe(30);
    expect(g.nodes[far.id].troops).toBeGreaterThan(50);
    useAbility(g, 0, 'spy');
    expect(canSee(g, 0, far.x, far.y)).toBe(true);
    expect(knownNode(g, 0, far.id).live).toBe(true);
  });

  it('AI wars still finish with fog on', () => {
    let stuck = 0;
    for (let i = 0; i < 8; i++) {
      const g = createGame(generateMap(700 + i * 13, 6 + (i % 5)), { fog: true });
      run(g, 900, [createAi(0, 'normal', i), createAi(1, 'normal', i + 50)]);
      if (g.winner === null) stuck++;
    }
    expect(stuck).toBe(0);
  }, 120000);
});
