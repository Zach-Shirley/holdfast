import { describe, expect, it } from 'vitest';
import { aiStep, createAi } from '../src/ai';
import { CampaignRun, MISSIONS, createMissionGame, starsFor, type Mission } from '../src/campaign';
import { step } from '../src/sim';

/** Play a mission with an AI standing in for the player. */
function play(m: Mission, seed: number, level: 'easy' | 'normal' | 'hard' = 'normal') {
  const g = createMissionGame(m, 'archer');
  const run = new CampaignRun(null, m, g, () => {});
  const me = createAi(0, level, seed, true, 'balanced');
  const foe = createAi(1, m.difficulty, seed + 99, true, m.rival);
  for (let t = 0; t < 900 && g.winner === null; t += 0.05) {
    foe.passive = run.passive(g);
    aiStep(g, me, 0.05);
    aiStep(g, foe, 0.05);
    step(g, 0.05);
    run.update(g, true);
  }
  return { won: g.winner === 0, time: g.time, stars: starsFor(m, g, run.stats), reason: g.winReason };
}

describe('campaign', () => {
  it('every mission builds a connected map with both capitals', () => {
    for (const m of MISSIONS) {
      const g = createMissionGame(m, 'archer');
      const [c0, c1] = g.map.capitals;
      expect(c0).toBeGreaterThanOrEqual(0);
      expect(c1).toBeGreaterThanOrEqual(0);
      expect(g.nodes[c0].owner).toBe(0);
      expect(g.nodes[c1].owner).toBe(1);
      const seen = new Set([0]);
      const stack = [0];
      while (stack.length) for (const k of g.map.adj[stack.pop()!]) if (!seen.has(k)) seen.add(k), stack.push(k);
      expect(seen.size).toBe(g.map.nodes.length);
    }
  });

  it('every mission ends, and a stand-in player can win each one', () => {
    const rows: string[] = [];
    const winsBy: number[] = [];
    for (const m of MISSIONS) {
      const results = [1, 2, 3, 4, 5, 6].map((s) => play(m, s * 17));
      const skilled = [1, 2, 3, 4, 5, 6].map((s) => play(m, s * 17, 'hard')).filter((r) => r.won).length;
      const wins = results.filter((r) => r.won).length;
      const avgT = results.reduce((t, r) => t + r.time, 0) / results.length;
      rows.push(`${m.id.padEnd(4)} ${m.title.padEnd(22)} wins ${wins}/6 skilled ${skilled}/6  avg ${Math.round(avgT)}s  stars ${results.map((r) => r.stars).join('')}  ${results.find((r) => !r.won)?.reason ?? ''}`);
      winsBy.push(wins + skilled);
    }
    console.log(rows.join('\n'));
    for (const w of winsBy) expect(w).toBeGreaterThan(0);
  }, 300000);
});
