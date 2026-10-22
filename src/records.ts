/** Things worth remembering between sessions: event mastery, Gauntlet bests and campaign progress. */

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return { ...fallback, ...JSON.parse(raw) };
  } catch {
    // Storage can be blocked (private windows, previews); start fresh.
  }
  return fallback;
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not fatal: the record just won't persist.
  }
}

/** Per quick-time event: hits, misses and the best run of hits in a row (battles, Training and the Gauntlet). */
export interface EventRecord {
  hit: number;
  miss: number;
  streak: number;
  best: number;
}

const MASTERY_KEY = 'holdfast.mastery.v1';
export const mastery: Record<string, EventRecord> = load(MASTERY_KEY, {});

export function recordEvent(kind: string, success: boolean) {
  const r = (mastery[kind] ??= { hit: 0, miss: 0, streak: 0, best: 0 });
  if (success) {
    r.hit++;
    r.streak++;
    r.best = Math.max(r.best, r.streak);
  } else {
    r.miss++;
    r.streak = 0;
  }
  save(MASTERY_KEY, mastery);
}

/** Gauntlet personal bests. */
export interface GauntletBest {
  score: number;
  hits: number;
  speed: number;
}

const GAUNTLET_KEY = 'holdfast.gauntlet.v1';
export const gauntletBest: GauntletBest = load(GAUNTLET_KEY, { score: 0, hits: 0, speed: 1 });

export function saveGauntlet(score: number, hits: number, speed: number): boolean {
  const record = score > gauntletBest.score;
  if (record) Object.assign(gauntletBest, { score, hits, speed });
  save(GAUNTLET_KEY, gauntletBest);
  return record;
}

/** Campaign: stars earned per mission id (0 = not yet won). */
const CAMPAIGN_KEY = 'holdfast.campaign.v1';
export const campaignStars: Record<string, number> = load(CAMPAIGN_KEY, {});

export function saveStars(id: string, stars: number) {
  campaignStars[id] = Math.max(campaignStars[id] ?? 0, stars);
  save(CAMPAIGN_KEY, campaignStars);
}

/** Daily War results, by date: fastest win (seconds) and attempts. */
export interface DailyResult {
  best: number | null;
  tries: number;
}

const DAILY_KEY = 'holdfast.daily.v1';
export const dailyResults: Record<string, DailyResult> = load(DAILY_KEY, {});

export function saveDaily(date: string, won: boolean, time: number): boolean {
  const d = (dailyResults[date] ??= { best: null, tries: 0 });
  d.tries++;
  const record = won && (d.best === null || time < d.best);
  if (record) d.best = time;
  save(DAILY_KEY, dailyResults);
  return record;
}

/** Days in a row (ending today or yesterday) with a Daily War won. */
export function dailyStreak(today: Date): number {
  let n = 0;
  const d = new Date(today);
  const key = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  // Today not won yet does not break the streak.
  if (dailyResults[key(d)]?.best == null) d.setDate(d.getDate() - 1);
  while (dailyResults[key(d)]?.best != null) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}
