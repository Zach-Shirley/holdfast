import { describe, expect, it } from 'vitest';
import { generateMap } from '../src/map';
import { ARROW_LOSS, BREACH, BREACH_TIME, SHIELD_TAKEN, SHIELD_TIME, applyArrows, applyQte, createGame, lossRates, sendTroops, sideDefense, sideOf, siegeRole, step } from '../src/sim';

/** A battle at a neutral fort next to the player's capital. */
function fortBattle() {
  const g = createGame(generateMap(3, 8));
  const c0 = g.map.capitals[0];
  const fort = g.map.adj[c0].find((k) => g.nodes[k].owner === 2)!;
  g.map.nodes[fort].kind = 'fort';
  g.map.nodes[fort].special = null;
  g.nodes[fort].troops = 40;
  g.nodes[c0].troops = 70;
  sendTroops(g, 0, c0, fort, 40);
  while (!g.battles.length) step(g, 0.05);
  return { g, b: g.battles[0], fort };
}

describe('siege events', () => {
  it('attackers of a walled stronghold are the ones storming it (and get the Ram)', () => {
    const { g, b } = fortBattle();
    expect(siegeRole(g, b, 0)).toBe('attacker');
    expect(siegeRole(g, b, 2)).toBe('defender');
  });

  it('a Ram breach lowers the walls for a while', () => {
    const { g, b } = fortBattle();
    const defender = sideOf(b, 2)!;
    const walls = sideDefense(g, b, defender);
    expect(walls).toBeCloseTo(1.4, 5);
    applyQte(g, b.id, 0, 'ram', true);
    expect(sideDefense(g, b, defender)).toBeCloseTo(walls - BREACH, 5);
    for (let t = 0; t < BREACH_TIME + 0.5 && b.endedAt === null; t += 0.05) step(g, 0.05);
    if (b.endedAt === null) expect(sideDefense(g, b, defender)).toBeCloseTo(walls, 5);
  });

});

describe('Shield Wall and Arrow Storm', () => {
  it('a Shield Wall cuts the losses your side takes for a few seconds', () => {
    const { g, b } = fortBattle();
    const before = lossRates(g, b).get(0)!;
    applyQte(g, b.id, 0, 'shield', true);
    expect(lossRates(g, b).get(0)!).toBeCloseTo(before * SHIELD_TAKEN, 5);
    for (let t = 0; t < SHIELD_TIME + 0.2 && b.endedAt === null; t += 0.05) step(g, 0.05);
    if (b.endedAt === null) expect(sideOf(b, 0)!.guardUntil!).toBeLessThan(g.time);
  });

  it('every arrow that lands costs troops; stopping all three costs nothing', () => {
    const { g, b } = fortBattle();
    const me = sideOf(b, 0)!;
    const t0 = me.troops;
    applyArrows(g, b.id, 0, 3);
    expect(me.troops).toBe(t0);
    applyArrows(g, b.id, 0, 0);
    expect(me.troops).toBeCloseTo(t0 - 3 * (t0 * ARROW_LOSS + 0.5), 5);
  });
});
