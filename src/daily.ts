import type { Difficulty, Personality } from './ai';
import { mulberry32 } from './rng';

/** The Daily War: the same map, rival and conditions for everyone on a given (local) date. */
export interface DailySpec {
  date: string;
  seed: number;
  nodes: number;
  rival: Personality;
  fog: boolean;
  difficulty: Difficulty;
}

const RIVALS: Personality[] = ['aggressor', 'turtle', 'opportunist', 'gambler'];

export function dateKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function todaysWar(d = new Date()): DailySpec {
  const date = dateKey(d);
  // A stable number from the date, then a seeded generator for everything else.
  let h = 2166136261;
  for (const ch of date) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const rng = mulberry32(h >>> 0);
  return {
    date,
    seed: Math.floor(rng() * 99999) + 1,
    nodes: [8, 9, 10, 12, 14][Math.floor(rng() * 5)],
    rival: RIVALS[Math.floor(rng() * RIVALS.length)],
    fog: rng() < 0.35,
    difficulty: rng() < 0.3 ? 'hard' : 'normal',
  };
}
