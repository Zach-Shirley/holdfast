import { describe, expect, it } from 'vitest';
import { generateMap } from '../src/map';
import { BREACH, BREACH_TIME, applyQte, createGame, sendTroops, sideDefense, sideOf, siegeRole, step } from '../src/sim';

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
  it('attackers of a walled stronghold get the Ram; its holders get Boiling Oil', () => {
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

  it('Boiling Oil kills attackers; a miss does nothing', () => {
    const { g, b } = fortBattle();
    // Hand the walls to the AI so it is the one pouring.
    g.nodes[b.nodeId!].owner = 1;
    sideOf(b, 2)!.owner = 1;
    const before = sideOf(b, 0)!.troops;
    applyQte(g, b.id, 1, 'oil', false);
    expect(sideOf(b, 0)!.troops).toBe(before);
    applyQte(g, b.id, 1, 'oil', true);
    expect(sideOf(b, 0)!.troops).toBeLessThan(before * 0.85);
  });
});
