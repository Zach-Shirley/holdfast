export type MgKind = 'strike' | 'rally';

export interface MgResult {
  kind: MgKind;
  /** 0 miss, 1 good, 2 perfect. */
  quality: 0 | 1 | 2;
  /** Rally only: share of max HP restored. */
  fraction: number;
}

const STRIKE_TIME = 3.0;
const STRIKE_ZONE = 0.3;
const STRIKE_PERFECT = 0.1;
/** Rally: three pulses appear one after another; click each before it shrinks away. */
const PULSES = 3;
const PULSE_LIFE = 1.3;
const PULSE_R = 34;
const HEAL_PER_PULSE = 0.1;

const W = 440;
const H = 220;

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
  pulse: { x: number; y: number; age: number } | null;
  shown: number;
  hits: number;
  pops: { x: number; y: number; age: number; hit: boolean }[];
}

/**
 * Hosts one mini-game at a time in the middle of the screen, over a dark backdrop that hides the
 * battle. The battle keeps running underneath: time spent here is time you are not commanding.
 * Mouse only.
 */
export class MinigameHost {
  private state: StrikeState | RallyState | null = null;
  private result: { r: MgResult; t: number } | null = null;
  private onDone: ((r: MgResult) => void) | null = null;
  private canvas: HTMLCanvasElement;
  private title: HTMLElement;
  private hint: HTMLElement;
  private timerEl: HTMLElement;
  private resultEl: HTMLElement;

  constructor(private root: HTMLElement) {
    root.innerHTML = `
      <div class="mg-card">
        <div class="mg-head"><span class="mg-title"></span><span class="mg-hint"></span></div>
        <canvas class="mg-canvas" width="${W}" height="${H}"></canvas>
        <div class="mg-timer"><div></div></div>
        <div class="mg-result"></div>
        <div class="mg-foot">The battle is still running · Esc to abandon</div>
      </div>`;
    this.canvas = root.querySelector('.mg-canvas')!;
    this.title = root.querySelector('.mg-title')!;
    this.hint = root.querySelector('.mg-hint')!;
    this.timerEl = root.querySelector('.mg-timer div')!;
    this.resultEl = root.querySelector('.mg-result')!;
    root.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.state?.kind === 'strike') this.resolveStrike();
      else if (this.state?.kind === 'rally') {
        const r = this.canvas.getBoundingClientRect();
        this.clickRally(((e.clientX - r.left) * W) / r.width, ((e.clientY - r.top) * H) / r.height);
      }
    });
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get busy() {
    return this.state !== null;
  }

  open(kind: MgKind, label: string, onDone: (r: MgResult) => void) {
    this.onDone = onDone;
    this.result = null;
    this.root.classList.remove('hidden', 'mg-strike', 'mg-rally', 'closing');
    this.root.classList.add(kind === 'strike' ? 'mg-strike' : 'mg-rally');
    this.resultEl.textContent = '';
    if (kind === 'strike') {
      const start = 0.1 + Math.random() * (0.8 - STRIKE_ZONE);
      const mid = start + STRIKE_ZONE / 2;
      this.state = {
        kind,
        t: 0,
        speed: 0.9 + Math.random() * 0.3,
        zone: [start, start + STRIKE_ZONE],
        perfect: [mid - STRIKE_PERFECT / 2, mid + STRIKE_PERFECT / 2],
        needle: 0,
      };
      this.title.textContent = `Strike · ${label}`;
      this.hint.textContent = 'Click anywhere while the needle is in the zone';
    } else {
      this.state = { kind, t: 0, pulse: null, shown: 0, hits: 0, pops: [] };
      this.nextPulse();
      this.title.textContent = `Rally · ${label}`;
      this.hint.textContent = 'Click each pulse before it fades';
    }
    this.paint();
  }

  /** Returns true when the key was consumed. Only Esc matters; everything else is mouse. */
  key(e: KeyboardEvent): boolean {
    if (!this.state) return false;
    if (e.key === 'Escape') this.finish({ kind: this.state.kind, quality: 0, fraction: 0 }, 'Abandoned');
    else if (this.state.kind === 'strike' && e.key === ' ') this.resolveStrike();
    return true;
  }

  update(dt: number) {
    if (this.result) {
      this.result.t += dt;
      if (this.result.t > 0.5) {
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
    } else {
      for (const p of st.pops) p.age += dt;
      st.pops = st.pops.filter((p) => p.age < 0.4);
      if (st.pulse) {
        st.pulse.age += dt;
        if (st.pulse.age >= PULSE_LIFE) {
          st.pops.push({ ...st.pulse, age: 0, hit: false });
          st.pulse = null;
          this.nextPulse();
        }
      }
    }
    this.paint();
  }

  private nextPulse() {
    const st = this.state;
    if (!st || st.kind !== 'rally') return;
    if (st.shown >= PULSES) {
      this.resolveRally();
      return;
    }
    st.shown++;
    const m = PULSE_R + 8;
    st.pulse = { x: m + Math.random() * (W - 2 * m), y: m + Math.random() * (H - 2 * m), age: 0 };
  }

  private clickRally(x: number, y: number) {
    const st = this.state;
    if (!st || st.kind !== 'rally' || !st.pulse) return;
    const r = this.pulseRadius(st.pulse.age);
    if (Math.hypot(x - st.pulse.x, y - st.pulse.y) > r + 6) return; // misses do not cost anything
    st.hits++;
    st.pops.push({ ...st.pulse, age: 0, hit: true });
    st.pulse = null;
    this.nextPulse();
  }

  private pulseRadius(age: number) {
    return PULSE_R * Math.max(0.15, 1 - age / PULSE_LIFE);
  }

  private resolveStrike() {
    const st = this.state;
    if (!st || st.kind !== 'strike') return;
    const n = st.needle;
    const q: 0 | 1 | 2 = n >= st.perfect[0] && n <= st.perfect[1] ? 2 : n >= st.zone[0] && n <= st.zone[1] ? 1 : 0;
    this.finish({ kind: 'strike', quality: q, fraction: 0 }, q === 2 ? 'Perfect! +70% damage' : q === 1 ? 'Hit: +35% damage' : 'Missed');
  }

  private resolveRally() {
    const st = this.state;
    if (!st || st.kind !== 'rally') return;
    const fraction = st.hits * HEAL_PER_PULSE;
    const q: 0 | 1 | 2 = st.hits === PULSES ? 2 : st.hits > 0 ? 1 : 0;
    this.finish({ kind: 'rally', quality: q, fraction }, st.hits ? `+${Math.round(fraction * 100)}% health` : 'Missed');
  }

  private finish(r: MgResult, text: string) {
    this.state = null;
    this.result = { r, t: 0 };
    this.resultEl.textContent = text;
    this.resultEl.className = `mg-result q${r.quality}`;
    this.root.classList.add('closing');
    const cb = this.onDone;
    this.onDone = null;
    cb?.(r);
  }

  private paint() {
    const st = this.state;
    if (!st) return;
    const limit = st.kind === 'strike' ? STRIKE_TIME : PULSES * PULSE_LIFE;
    const elapsed = st.kind === 'strike' ? st.t : (st.shown - 1) * PULSE_LIFE + (st.pulse?.age ?? 0);
    this.timerEl.style.width = `${Math.max(0, 100 * (1 - elapsed / limit))}%`;
    const ctx = this.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    if (st.kind === 'strike') {
      const y0 = H / 2 - 26;
      const bh = 52;
      ctx.fillStyle = '#16171d';
      ctx.beginPath();
      ctx.roundRect(0, y0, W, bh, 14);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,169,77,0.38)';
      ctx.fillRect(st.zone[0] * W, y0, (st.zone[1] - st.zone[0]) * W, bh);
      ctx.fillStyle = '#ffa94d';
      ctx.fillRect(st.perfect[0] * W, y0, (st.perfect[1] - st.perfect[0]) * W, bh);
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = '#ff3b55';
      ctx.shadowBlur = 14;
      ctx.fillRect(st.needle * W - 3, y0 - 14, 6, bh + 28);
      ctx.shadowBlur = 0;
      return;
    }
    // Rally pulses.
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.beginPath();
    ctx.roundRect(0, 0, W, H, 14);
    ctx.fill();
    for (const p of st.pops) {
      ctx.strokeStyle = p.hit ? `rgba(110,231,160,${1 - p.age / 0.4})` : `rgba(255,90,90,${1 - p.age / 0.4})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, PULSE_R * 0.6 + p.age * 60, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (st.pulse) {
      const r = this.pulseRadius(st.pulse.age);
      const glow = ctx.createRadialGradient(st.pulse.x, st.pulse.y, r * 0.2, st.pulse.x, st.pulse.y, r * 1.6);
      glow.addColorStop(0, 'rgba(110,231,160,0.5)');
      glow.addColorStop(1, 'rgba(110,231,160,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(st.pulse.x, st.pulse.y, r * 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1d5c3a';
      ctx.strokeStyle = '#6ee7a0';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(st.pulse.x, st.pulse.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = '#d6ffe6';
      ctx.lineWidth = Math.max(2, r * 0.16);
      ctx.beginPath();
      ctx.moveTo(st.pulse.x - r * 0.45, st.pulse.y);
      ctx.lineTo(st.pulse.x + r * 0.45, st.pulse.y);
      ctx.moveTo(st.pulse.x, st.pulse.y - r * 0.45);
      ctx.lineTo(st.pulse.x, st.pulse.y + r * 0.45);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(214,255,230,0.6)';
    ctx.font = '600 13px "Chakra Petch", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${st.hits} / ${PULSES}`, W - 12, H - 12);
  }
}
