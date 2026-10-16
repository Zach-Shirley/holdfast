export type MgKind = 'strike' | 'rally';

export interface MgResult {
  kind: MgKind;
  /** 0 miss, 1 good, 2 perfect. */
  quality: 0 | 1 | 2;
  /** Rally only: share of max HP restored. */
  fraction: number;
}

const STRIKE_TIME = 2.6;
const RALLY_TIME = 3.2;
const RALLY_LEN = 4;
const ARROWS = ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'] as const;
const ARROW_GLYPH: Record<string, string> = { ArrowUp: '↑', ArrowRight: '→', ArrowDown: '↓', ArrowLeft: '←' };
const WASD: Record<string, string> = { w: 'ArrowUp', d: 'ArrowRight', s: 'ArrowDown', a: 'ArrowLeft' };

interface StrikeState {
  kind: 'strike';
  t: number;
  speed: number;
  zone: [number, number];
  perfect: [number, number];
  needle: number;
}

interface RallyState {
  kind: 'rally';
  t: number;
  seq: string[];
  done: number;
  failed: boolean;
}

/**
 * Hosts one mini-game at a time in a small panel. The battle keeps running underneath:
 * the time you spend here is time you are not watching the rest of the map.
 */
export class MinigameHost {
  private state: StrikeState | RallyState | null = null;
  private result: { r: MgResult; t: number; text: string } | null = null;
  private onDone: ((r: MgResult) => void) | null = null;
  private canvas: HTMLCanvasElement;
  private title: HTMLElement;
  private hint: HTMLElement;
  private seqEl: HTMLElement;
  private timerEl: HTMLElement;
  private resultEl: HTMLElement;

  constructor(private root: HTMLElement) {
    root.innerHTML = `
      <div class="mg-head"><span class="mg-title"></span><span class="mg-hint"></span></div>
      <canvas class="mg-canvas" width="320" height="38"></canvas>
      <div class="mg-seq"></div>
      <div class="mg-timer"><div></div></div>
      <div class="mg-result"></div>`;
    this.canvas = root.querySelector('.mg-canvas')!;
    this.title = root.querySelector('.mg-title')!;
    this.hint = root.querySelector('.mg-hint')!;
    this.seqEl = root.querySelector('.mg-seq')!;
    this.timerEl = root.querySelector('.mg-timer div')!;
    this.resultEl = root.querySelector('.mg-result')!;
    root.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.state?.kind === 'strike') this.resolveStrike();
    });
  }

  get busy() {
    return this.state !== null;
  }

  open(kind: MgKind, label: string, onDone: (r: MgResult) => void) {
    this.onDone = onDone;
    this.result = null;
    this.root.classList.remove('hidden', 'mg-strike', 'mg-rally');
    this.root.classList.add(kind === 'strike' ? 'mg-strike' : 'mg-rally');
    this.resultEl.textContent = '';
    if (kind === 'strike') {
      const w = 0.2;
      const start = 0.12 + Math.random() * (0.76 - w);
      const mid = start + w / 2;
      this.state = { kind, t: 0, speed: 1.5 + Math.random() * 0.5, zone: [start, start + w], perfect: [mid - 0.035, mid + 0.035], needle: 0 };
      this.title.textContent = `Strike · ${label}`;
      this.hint.textContent = 'Space or click in the zone';
      this.canvas.style.display = '';
      this.seqEl.style.display = 'none';
    } else {
      const seq = Array.from({ length: RALLY_LEN }, () => ARROWS[Math.floor(Math.random() * 4)]);
      this.state = { kind, t: 0, seq, done: 0, failed: false };
      this.title.textContent = `Rally · ${label}`;
      this.hint.textContent = 'Type the arrows (or WASD)';
      this.canvas.style.display = 'none';
      this.seqEl.style.display = '';
    }
    this.paint();
  }

  /** Returns true when the key was consumed by the mini-game. */
  key(e: KeyboardEvent): boolean {
    if (!this.state) return false;
    if (e.key === 'Escape') {
      this.finish({ kind: this.state.kind, quality: 0, fraction: 0 }, 'Abandoned');
      return true;
    }
    if (this.state.kind === 'strike') {
      if (e.key === ' ' || e.key === 'Enter') {
        this.resolveStrike();
        return true;
      }
      return true;
    }
    const k = WASD[e.key.toLowerCase()] ?? e.key;
    if (!ARROWS.includes(k as (typeof ARROWS)[number])) return true;
    const st = this.state;
    if (k === st.seq[st.done]) {
      st.done++;
      if (st.done === st.seq.length) this.resolveRally();
    } else {
      st.failed = true;
      this.resolveRally();
    }
    this.paint();
    return true;
  }

  update(dt: number) {
    if (this.result) {
      this.result.t += dt;
      if (this.result.t > 0.55) {
        this.result = null;
        this.root.classList.add('hidden');
      }
      return;
    }
    const st = this.state;
    if (!st) return;
    st.t += dt;
    if (st.kind === 'strike') {
      const phase = (st.t * st.speed) % 2;
      st.needle = phase < 1 ? phase : 2 - phase;
      if (st.t >= STRIKE_TIME) this.finish({ kind: 'strike', quality: 0, fraction: 0 }, 'Too slow');
    } else if (st.t >= RALLY_TIME) {
      this.resolveRally();
    }
    this.paint();
  }

  private resolveStrike() {
    const st = this.state;
    if (!st || st.kind !== 'strike') return;
    const n = st.needle;
    const q: 0 | 1 | 2 = n >= st.perfect[0] && n <= st.perfect[1] ? 2 : n >= st.zone[0] && n <= st.zone[1] ? 1 : 0;
    this.finish({ kind: 'strike', quality: q, fraction: 0 }, q === 2 ? 'Perfect! +70% damage' : q === 1 ? 'Good: +35% damage' : 'Missed');
  }

  private resolveRally() {
    const st = this.state;
    if (!st || st.kind !== 'rally') return;
    const full = st.done === st.seq.length;
    const fraction = full ? 0.3 : st.done * 0.06;
    const q: 0 | 1 | 2 = full ? 2 : st.done > 0 ? 1 : 0;
    this.finish({ kind: 'rally', quality: q, fraction }, full ? 'Rallied! +30% health' : st.done ? `Partial: +${Math.round(fraction * 100)}% health` : 'Failed');
  }

  private finish(r: MgResult, text: string) {
    this.state = null;
    this.result = { r, t: 0, text };
    this.resultEl.textContent = text;
    this.resultEl.className = `mg-result q${r.quality}`;
    const cb = this.onDone;
    this.onDone = null;
    cb?.(r);
  }

  private paint() {
    const st = this.state;
    if (!st) return;
    const limit = st.kind === 'strike' ? STRIKE_TIME : RALLY_TIME;
    this.timerEl.style.width = `${Math.max(0, 100 * (1 - st.t / limit))}%`;
    if (st.kind === 'rally') {
      this.seqEl.innerHTML = st.seq
        .map((k, i) => `<span class="${i < st.done ? 'ok' : i === st.done && st.failed ? 'bad' : i === st.done ? 'next' : ''}">${ARROW_GLYPH[k]}</span>`)
        .join('');
      return;
    }
    const c = this.canvas;
    const ctx = c.getContext('2d')!;
    const W = c.width;
    const H = c.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#16171d';
    ctx.beginPath();
    ctx.roundRect(0, 6, W, H - 12, 8);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,169,77,0.35)';
    ctx.fillRect(st.zone[0] * W, 6, (st.zone[1] - st.zone[0]) * W, H - 12);
    ctx.fillStyle = '#ffa94d';
    ctx.fillRect(st.perfect[0] * W, 6, (st.perfect[1] - st.perfect[0]) * W, H - 12);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#ff3b55';
    ctx.shadowBlur = 10;
    ctx.fillRect(st.needle * W - 2, 0, 4, H);
    ctx.shadowBlur = 0;
  }
}
