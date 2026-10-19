/** Player preferences, remembered in this browser when storage is available. */
export interface Prefs {
  volume: number;
  muted: boolean;
  /** Quick-time event speed: 0.8 slower, 1 normal, 1.2 faster. */
  qteSpeed: number;
  palette: 'classic' | 'contrast';
}

const KEY = 'holdfast.prefs.v1';
const DEFAULTS: Prefs = { volume: 0.7, muted: false, qteSpeed: 1, palette: 'classic' };

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // Storage can be blocked (private windows, previews); defaults are fine.
  }
  return { ...DEFAULTS };
}

export const prefs: Prefs = load();

export function savePrefs() {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Not fatal: preferences just won't persist.
  }
}
