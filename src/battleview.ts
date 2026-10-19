import { NODE_STATS } from './map';
import { OWNER_COLOR, OWNER_DARK, OWNER_LIGHT } from './render';
import { activeBattles, battleName, getBattle, sideDefense, sideOf, type Battle, type Game, type Owner, type QteKind } from './sim';

/** Volley: click the target when the closing ring meets it. */
const VOLLEY_HIT = 1.0;
const VOLLEY_WINDOW = 0.3;
const VOLLEY_LIFE = VOLLEY_HIT + VOLLEY_WINDOW + 0.05;
const VOLLEY_R = 38;
/** Parry: click the incoming spear before it reaches your shield. */
const PARRY_TIME = 1.55;
const PARRY_HIT_R = 52;
/** Slash: press on the start mark and drag to the end mark along the line. */
const SLASH_TIME = 2.2;
const SLASH_GRAB = 46;
const SLASH_TOLERANCE = 58;
/** Banner: hold the mouse button on the moving banner. */
const BANNER_TIME = 2.6;
const BANNER_NEED = 1.0;
const BANNER_R = 60;
const GAP = 0.45;
const FIRST = 0.8;

type Qte =
  | { kind: 'volley'; t: number; x: number; y: number }
  | { kind: 'parry'; t: number; ang: number }
  | { kind: 'slash'; t: number; ax: number; ay: number; bx: number; by: number; grabbed: boolean; trail: { x: number; y: number }[] }
  | { kind: 'banner'; t: number; held: number; phase: number };

interface Floater {
  text: string;
  x: number;
  y: number;
  t: number;
  good: boolean;
  /** Smaller explanatory line (why a miss happened, or a hint). */
  small?: boolean;
  hint?: boolean;
}

/** How each quick-time event works, shown on the Training screen. */
export const DRILLS: Record<QteKind, { name: string; color: string; steps: string[]; effect: string; tip: string }> = {
  volley: {
    name: 'Volley',
    color: '#ffa94d',
    steps: [
      'A target appears with a white ring shrinking toward it.',
      'Click the target the moment the white ring touches its orange edge.',
      'Clicking too early or too late is a miss. Clicks off the target are ignored.',
    ],
    effect: 'Kills about 18% of the enemy troops in the battle (plus 2–3).',
    tip: 'Watch the ring, not the target. The target glows brighter while you are inside the timing window.',
  },
  parry: {
    name: 'Parry',
    color: '#cfe8ff',
    steps: [
      'An enemy spear flies in from the edge toward your shield in the centre.',
      'Click the spear head (inside the flashing circle) any time before it reaches the shield.',
      'There is no "too early": click it as soon as you see it.',
    ],
    effect: 'Hit: a momentum boost (your side fights about 38% harder, fading over time). Miss: the charge kills about 7% of your troops.',
    tip: 'The spear comes from a random direction. Move your mouse toward it straight away.',
  },
  slash: {
    name: 'Slash',
    color: '#ff8a98',
    steps: [
      'A dashed line appears with a filled dot at one end and an empty ring at the other.',
      'Press and hold the mouse on the filled dot.',
      'Keep holding and drag along the dashes into the ring. Letting go early or straying far off the line is a miss.',
    ],
    effect: 'Your side fights about 75% harder, fading over time (momentum).',
    tip: 'You have over 2 seconds: a steady drag beats a fast flick.',
  },
  banner: {
    name: 'Banner',
    color: '#ffd166',
    steps: [
      'A red banner drifts slowly around the screen.',
      'Press and hold the mouse button with the cursor on the banner.',
      'Follow it while holding until the gold ring around it fills (about 1 second in total).',
    ],
    effect: 'Kills about 10% of the enemy (plus 2–3) and adds a momentum boost.',
    tip: 'Time only counts while the button is down and the cursor is on the banner. Slipping off just pauses the ring.',
  },
};

/** Stand-in battle drawn behind the Training screen. */
const FAKE_BATTLE: Battle = {
  id: -1,
  nodeId: null,
  road: null,
  x: 0,
  y: 0,
  sides: [
    { owner: 0, troops: 40, momentum: 1 },
    { owner: 1, troops: 40, momentum: 1 },
  ],
  startedAt: 0,
  endedAt: null,
  winner: null,
  peak: {},
};

export interface BattleViewHooks {
  onQte: (battleId: number, kind: QteKind, success: boolean) => string;
  onLeave: () => void;
  onSwitch: (battleId: number) => void;
  onPracticeExit?: () => void;
}

/**
 * Full-screen view of one battle. It hides the map entirely: while you fight here, the rest of the
 * war carries on without you.
 */
export class BattleView {
  battleId: number | null = null;
  private qte: Qte | null = null;
  private gap = FIRST;
  private last: QteKind | null = null;
  private floaters: Floater[] = [];
  private shake = 0;
  private endShownAt: number | null = null;
  private mouse = { x: 0, y: 0, down: false };
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private now = 0;
  private els: Record<string, HTMLElement> = {};
  /** Training mode: the drill being practised (null in a real battle). */
  private practice: QteKind | null = null;
  /** Demo mode: a ghost cursor performs the drill. */
  private demo = false;
  private pstats = { hit: 0, miss: 0, streak: 0 };
  private clicks: { x: number; y: number; t: number }[] = [];
  private lastHint = -9;

  constructor(private root: HTMLElement, private hooks: BattleViewHooks) {
    root.innerHTML = `
      <canvas class="bv-canvas"></canvas>
      <div class="bv-top">
        <div class="bv-side left"><div class="bv-count" data-el="lc"></div><div class="bv-meta" data-el="lm"></div><div class="bv-mom"><div data-el="lb"></div></div></div>
        <div class="bv-title"><div data-el="title"></div><div class="bv-sub" data-el="sub"></div></div>
        <div class="bv-side right"><div class="bv-count" data-el="rc"></div><div class="bv-meta" data-el="rm"></div><div class="bv-mom"><div data-el="rb"></div></div></div>
      </div>
      <div class="bv-cmdr hidden" data-el="cmdr">Enemy commander is here</div>
      <div class="bv-result hidden" data-el="result"></div>
      <aside class="bv-others"><h4>Other battles</h4><div data-el="others"></div><div class="bv-ticker" data-el="ticker"></div></aside>
      <button class="bv-leave" data-el="leave">Back to map <span>Esc · right-click</span></button>
      <aside class="bv-practice" data-el="practice"></aside>`;
    root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.els[e.dataset.el!] = e));
    this.canvas = root.querySelector('.bv-canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.els.leave.addEventListener('click', () => this.hooks.onLeave());
    this.els.others.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-bid]')?.dataset.bid;
      if (id) this.hooks.onSwitch(Number(id));
    });
    this.els.practice.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-kind],[data-act]');
      if (!el || !this.practice) return;
      if (el.dataset.kind) this.showPractice(el.dataset.kind as QteKind, true);
      else if (el.dataset.act === 'demo') this.showPractice(this.practice, true);
      else if (el.dataset.act === 'try') this.showPractice(this.practice, false);
      else if (el.dataset.act === 'back') this.exitPractice();
    });
    window.addEventListener('keydown', (e) => {
      if (this.practice && e.key === 'Escape') this.exitPractice();
    });
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!this.practice) this.hooks.onLeave();
    });
    // Real mouse input is ignored while the demo's ghost cursor is playing.
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || this.demo) return;
      this.mouse = { x: e.offsetX, y: e.offsetY, down: true };
      this.press();
    });
    this.canvas.addEventListener('mousemove', (e) => {
      if (this.demo) return;
      this.mouse.x = e.offsetX;
      this.mouse.y = e.offsetY;
      this.drag();
    });
    window.addEventListener('mouseup', () => {
      if (!this.mouse.down || this.demo) return;
      this.mouse.down = false;
      this.release();
    });
  }

  get open() {
    return this.battleId !== null;
  }

  show(id: number) {
    this.battleId = id;
    this.qte = null;
    this.gap = FIRST;
    this.endShownAt = null;
    this.floaters = [];
    this.root.classList.remove('hidden');
    this.resize();
  }

  hide() {
    this.battleId = null;
    this.practice = null;
    this.demo = false;
    this.qte = null;
    this.root.classList.remove('practicing');
    this.root.classList.add('hidden');
  }

  get practicing() {
    return this.practice !== null;
  }

  /** Training screen: practise one quick-time event on repeat, or watch a ghost cursor do it. */
  showPractice(kind: QteKind, demo = false) {
    if (kind !== this.practice || demo !== this.demo) this.pstats = { hit: 0, miss: 0, streak: 0 };
    this.battleId = null;
    this.practice = kind;
    this.demo = demo;
    this.qte = null;
    this.gap = 0.6;
    this.floaters = [];
    this.mouse.down = false;
    this.root.classList.remove('hidden');
    this.root.classList.add('practicing');
    this.resize();
    this.renderPracticePanel();
  }

  exitPractice() {
    this.hide();
    this.hooks.onPracticeExit?.();
  }

  private renderPracticePanel() {
    const kind = this.practice;
    if (!kind) return;
    const d = DRILLS[kind];
    const tabs = (Object.keys(DRILLS) as QteKind[])
      .map((k) => `<button data-kind="${k}" class="${k === kind ? 'on' : ''}" style="--c:${DRILLS[k].color}">${DRILLS[k].name}</button>`)
      .join('');
    const total = this.pstats.hit + this.pstats.miss;
    const status = this.demo
      ? '<p class="pr-status">Watching: the ghost cursor shows exactly when and where to click.</p>'
      : `<p class="pr-status">Hits <b>${this.pstats.hit}</b> · Misses <b>${this.pstats.miss}</b>${total ? ` · ${Math.round((100 * this.pstats.hit) / total)}%` : ''} · Streak <b>${this.pstats.streak}</b></p>`;
    this.els.practice.innerHTML = `
      <div class="pr-head">TRAINING</div>
      <div class="pr-tabs">${tabs}</div>
      <h2 style="color:${d.color}">${d.name}</h2>
      <h4>What to do</h4>
      <ol>${d.steps.map((x) => `<li>${x}</li>`).join('')}</ol>
      <h4>In battle</h4>
      <p>${d.effect}</p>
      <p class="pr-tip">${d.tip}</p>
      <div class="pr-mode">
        <button data-act="demo" class="${this.demo ? 'on' : ''}">Watch demo</button>
        <button data-act="try" class="${!this.demo ? 'on' : ''}">Try it yourself</button>
      </div>
      ${status}
      <button class="pr-back" data-act="back">Back to menu <span>Esc</span></button>`;
  }

  resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  /** Play area for quick-time events: the middle of the screen, clear of the HUD. */
  private area() {
    if (this.practice) return { x0: this.w * 0.06, x1: this.w - 420, y0: this.h * 0.16, y1: this.h * 0.86 };
    return { x0: this.w * 0.2, x1: this.w * 0.75, y0: this.h * 0.3, y1: this.h * 0.8 };
  }

  private center() {
    const a = this.area();
    return { x: (a.x0 + a.x1) / 2, y: (a.y0 + a.y1) / 2 };
  }

  private spawn() {
    const kinds: QteKind[] = ['volley', 'parry', 'slash', 'banner'];
    const pool = kinds.filter((k) => k !== this.last);
    const kind = this.practice ?? pool[Math.floor(Math.random() * pool.length)];
    this.last = kind;
    const a = this.area();
    const rx = () => a.x0 + 60 + Math.random() * (a.x1 - a.x0 - 120);
    const ry = () => a.y0 + 60 + Math.random() * (a.y1 - a.y0 - 120);
    if (kind === 'volley') this.qte = { kind, t: 0, x: rx(), y: ry() };
    else if (kind === 'parry') this.qte = { kind, t: 0, ang: Math.random() * Math.PI * 2 };
    else if (kind === 'banner') this.qte = { kind, t: 0, held: 0, phase: Math.random() * 10 };
    else {
      const c = this.center();
      const ang = Math.random() * Math.PI * 2;
      const len = 120 + Math.random() * 60;
      this.qte = { kind, t: 0, ax: c.x - Math.cos(ang) * len, ay: c.y - Math.sin(ang) * len, bx: c.x + Math.cos(ang) * len, by: c.y + Math.sin(ang) * len, grabbed: false, trail: [] };
    }
  }

  /** Finish the current event. `reason` explains a miss, so players learn what went wrong. */
  private resolve(success: boolean, x: number, y: number, reason?: string) {
    if (!this.qte) return;
    const kind = this.qte.kind;
    if (this.practice) {
      if (!this.demo) {
        this.pstats[success ? 'hit' : 'miss']++;
        this.pstats.streak = success ? this.pstats.streak + 1 : 0;
      }
      this.floaters.push({ text: success ? 'Hit!' : 'Miss', x, y, t: 0, good: success });
      this.renderPracticePanel();
    } else {
      if (this.battleId === null) return;
      const text = this.hooks.onQte(this.battleId, kind, success);
      this.floaters.push({ text: text || (success ? 'Hit' : 'Miss'), x, y, t: 0, good: success });
    }
    if (!success && reason) this.floaters.push({ text: reason, x, y: y + 34, t: 0, good: false, small: true });
    if (!success && kind === 'parry') this.shake = 0.35;
    this.qte = null;
    this.gap = this.practice ? 0.7 : GAP;
  }

  /** Non-failing nudge for a click in the wrong place. */
  private hint(text: string) {
    if (this.now - this.lastHint < 0.8) return;
    this.lastHint = this.now;
    this.floaters.push({ text, x: this.mouse.x, y: this.mouse.y + 10, t: 0, good: true, small: true, hint: true });
  }

  private parryPos(q: Extract<Qte, { kind: 'parry' }>) {
    const c = this.center();
    const D = Math.min(this.w, this.h) * 0.42;
    const d = D * (1 - q.t / PARRY_TIME) + 46;
    return { x: c.x + Math.cos(q.ang) * d, y: c.y + Math.sin(q.ang) * d };
  }

  private bannerPos(q: Extract<Qte, { kind: 'banner' }>) {
    const a = this.area();
    const cx = (a.x0 + a.x1) / 2;
    const cy = (a.y0 + a.y1) / 2;
    const t = q.t * 0.9 + q.phase;
    return { x: cx + Math.sin(t * 1.1) * (a.x1 - a.x0) * 0.32, y: cy + Math.sin(t * 1.7 + 1) * (a.y1 - a.y0) * 0.3 };
  }

  private press() {
    const q = this.qte;
    const { x, y } = this.mouse;
    if (!q) return;
    if (q.kind === 'volley') {
      // Clicks off the target are ignored (with a hint), so a stray click never costs you.
      if (Math.hypot(x - q.x, y - q.y) > VOLLEY_R + 24) return this.hint('Click on the target itself');
      const early = q.t < VOLLEY_HIT - VOLLEY_WINDOW;
      const ok = Math.abs(q.t - VOLLEY_HIT) <= VOLLEY_WINDOW;
      this.resolve(ok, q.x, q.y, early ? 'Too early: wait until the white ring touches the target' : 'Too late: click as the rings meet');
    } else if (q.kind === 'parry') {
      const p = this.parryPos(q);
      if (Math.hypot(x - p.x, y - p.y) <= PARRY_HIT_R) this.resolve(true, p.x, p.y);
      else this.hint('Click the spear head');
    } else if (q.kind === 'slash') {
      if (Math.hypot(x - q.ax, y - q.ay) <= SLASH_GRAB) {
        q.grabbed = true;
        q.trail = [{ x, y }];
      } else this.hint('Press on the filled dot first');
    } else {
      const p = this.bannerPos(q);
      if (Math.hypot(x - p.x, y - p.y) > BANNER_R) this.hint('Hold the button down on the banner');
    }
  }

  private drag() {
    const q = this.qte;
    if (!q || q.kind !== 'slash' || !q.grabbed || !this.mouse.down) return;
    const { x, y } = this.mouse;
    q.trail.push({ x, y });
    const dx = q.bx - q.ax;
    const dy = q.by - q.ay;
    const t = Math.max(0, Math.min(1, ((x - q.ax) * dx + (y - q.ay) * dy) / (dx * dx + dy * dy)));
    const off = Math.hypot(x - (q.ax + dx * t), y - (q.ay + dy * t));
    if (off > SLASH_TOLERANCE) this.resolve(false, x, y, 'Strayed off the line: follow the dashes');
    else if (Math.hypot(x - q.bx, y - q.by) <= SLASH_GRAB) this.resolve(true, q.bx, q.by);
  }

  private release() {
    const q = this.qte;
    if (q && q.kind === 'slash' && q.grabbed) this.resolve(false, this.mouse.x, this.mouse.y, 'Let go too early: keep holding until the ring');
  }

  update(g: Game | null, dt: number) {
    if (this.practice) {
      this.tickCommon(dt);
      this.tickQte(dt);
      return;
    }
    if (this.battleId === null || !g) return;
    this.tickCommon(dt);
    const b = getBattle(g, this.battleId);
    if (!b) return this.hooks.onLeave();
    if (b.endedAt !== null || !sideOf(b, 0) || sideOf(b, 0)!.troops <= 0.5) {
      // Battle over (or our side is gone): show the result briefly, then go back to the map.
      this.qte = null;
      this.endShownAt ??= this.now;
      if (this.now - this.endShownAt > 1.6) this.hooks.onLeave();
      return;
    }
    this.tickQte(dt);
  }

  private tickCommon(dt: number) {
    this.now += dt;
    this.shake = Math.max(0, this.shake - dt);
    for (const f of this.floaters) f.t += dt;
    this.floaters = this.floaters.filter((f) => f.t < (f.small ? 2.2 : 1.3));
    for (const c of this.clicks) c.t += dt;
    this.clicks = this.clicks.filter((c) => c.t < 0.5);
  }

  private tickQte(dt: number) {
    if (!this.qte) {
      if (this.demo) this.mouse.down = false;
      this.gap -= dt;
      if (this.gap <= 0) this.spawn();
      return;
    }
    const q = this.qte;
    q.t += dt;
    if (this.demo) {
      this.demoStep(dt);
      if (!this.qte) return;
    }
    if (q.kind === 'volley' && q.t > VOLLEY_LIFE) this.resolve(false, q.x, q.y, 'Missed: click the target as the rings meet');
    else if (q.kind === 'parry' && q.t >= PARRY_TIME) {
      const c = this.center();
      this.resolve(false, c.x, c.y, 'Too slow: click the spear before it hits your shield');
    } else if (q.kind === 'slash' && q.t >= SLASH_TIME) this.resolve(false, q.bx, q.by, 'Too slow: press the dot, then drag to the ring');
    else if (q.kind === 'banner') {
      const p = this.bannerPos(q);
      if (this.mouse.down && Math.hypot(this.mouse.x - p.x, this.mouse.y - p.y) <= BANNER_R) q.held += dt;
      if (q.held >= BANNER_NEED) this.resolve(true, p.x, p.y);
      else if (q.t >= BANNER_TIME) this.resolve(false, p.x, p.y, 'Hold the button down with the cursor on the banner');
    }
  }

  /** Ghost cursor for the demo: performs each event the way a player should. */
  private demoStep(dt: number) {
    const q = this.qte!;
    const glide = (tx: number, ty: number, speed = 9) => {
      const k = Math.min(1, dt * speed);
      this.mouse.x += (tx - this.mouse.x) * k;
      this.mouse.y += (ty - this.mouse.y) * k;
    };
    const click = (x: number, y: number) => {
      this.mouse.x = x;
      this.mouse.y = y;
      this.clicks.push({ x, y, t: 0 });
    };
    if (q.kind === 'volley') {
      glide(q.x, q.y);
      if (q.t >= VOLLEY_HIT - 0.03) {
        click(q.x, q.y);
        this.press();
      }
    } else if (q.kind === 'parry') {
      const p = this.parryPos(q);
      glide(p.x, p.y, 12);
      if (q.t >= 0.8) {
        click(p.x, p.y);
        this.press();
      }
    } else if (q.kind === 'slash') {
      if (q.t < 0.6) glide(q.ax, q.ay, 10);
      else if (!q.grabbed) {
        click(q.ax, q.ay);
        this.mouse.down = true;
        this.press();
      } else {
        const f = Math.min(1, (q.t - 0.6) / 0.75);
        this.mouse.x = q.ax + (q.bx - q.ax) * f;
        this.mouse.y = q.ay + (q.by - q.ay) * f;
        this.drag();
      }
    } else {
      const p = this.bannerPos(q);
      glide(p.x, p.y, 14);
      if (q.t > 0.35 && !this.mouse.down) {
        this.mouse.down = true;
        this.clicks.push({ x: this.mouse.x, y: this.mouse.y, t: 0 });
      }
    }
  }

  private drawCursor() {
    const { ctx } = this;
    const { x, y, down } = this.mouse;
    for (const c of this.clicks) {
      ctx.strokeStyle = `rgba(255,255,255,${1 - c.t / 0.5})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 10 + c.t * 70, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (down) {
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath();
      ctx.arc(x, y, 16, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + 26);
    ctx.lineTo(x + 7, y + 20);
    ctx.lineTo(x + 12, y + 31);
    ctx.lineTo(x + 16, y + 29);
    ctx.lineTo(x + 11, y + 18);
    ctx.lineTo(x + 20, y + 18);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.font = '700 13px "Chakra Petch", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(down ? 'holding' : 'demo', x + 22, y + 34);
  }

  render(g: Game | null) {
    const b = this.practice ? FAKE_BATTLE : g && this.battleId !== null ? getBattle(g, this.battleId) : undefined;
    if (!b) return;
    const { ctx } = this;
    const sx = this.shake > 0 ? (Math.random() - 0.5) * 14 * (this.shake / 0.35) : 0;
    const sy = this.shake > 0 ? (Math.random() - 0.5) * 10 * (this.shake / 0.35) : 0;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, this.dpr * sx, this.dpr * sy);
    this.drawScene(this.practice ? null : g, b);
    this.drawQte();
    for (const f of this.floaters) {
      const life = f.small ? 2.2 : 1.3;
      ctx.globalAlpha = Math.max(0, 1 - f.t / life);
      ctx.textAlign = 'center';
      if (f.small) {
        ctx.font = '600 17px "Chakra Petch", sans-serif';
        const w = ctx.measureText(f.text).width + 20;
        const y = f.y - 40 - f.t * 12;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.beginPath();
        ctx.roundRect(f.x - w / 2, y - 19, w, 27, 13);
        ctx.fill();
        ctx.fillStyle = f.hint ? '#e9d7c9' : '#ff9a9a';
        ctx.fillText(f.text, f.x, y);
      } else {
        ctx.font = '700 24px "Chakra Petch", sans-serif';
        ctx.fillStyle = f.good ? '#ffd27a' : '#ff8a8a';
        ctx.fillText(f.text, f.x, f.y - 40 - f.t * 40);
      }
      ctx.globalAlpha = 1;
    }
    if (this.demo) this.drawCursor();
    if (!this.practice && g) this.updateDom(g, b);
  }

  private sides(b: Battle): { left: { owner: Owner; troops: number; momentum: number }; right: { owner: Owner; troops: number; momentum: number } } {
    const me = sideOf(b, 0) ?? { owner: 0 as Owner, troops: 0, momentum: 1 };
    const foes = b.sides.filter((s) => s.owner !== 0);
    const top = foes.slice().sort((p, q) => q.troops - p.troops)[0];
    return {
      left: { owner: 0, troops: Math.max(0, me.troops), momentum: me.momentum },
      right: { owner: top?.owner ?? 1, troops: foes.reduce((t, s) => t + Math.max(0, s.troops), 0), momentum: top?.momentum ?? 1 },
    };
  }

  private drawScene(g: Game | null, b: Battle) {
    const { ctx, w, h } = this;
    const { left, right } = this.sides(b);
    // Dusk sky and ground.
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#12070b');
    sky.addColorStop(0.45, '#2a0c12');
    sky.addColorStop(0.46, '#17110e');
    sky.addColorStop(1, '#0b0908');
    ctx.fillStyle = sky;
    ctx.fillRect(-20, -20, w + 40, h + 40);
    const horizon = h * 0.46;
    // Moon and distant ridgelines.
    const moon = ctx.createRadialGradient(w * 0.78, h * 0.16, 10, w * 0.78, h * 0.16, 120);
    moon.addColorStop(0, 'rgba(255,214,190,0.55)');
    moon.addColorStop(0.25, 'rgba(255,170,150,0.18)');
    moon.addColorStop(1, 'rgba(255,150,140,0)');
    ctx.fillStyle = moon;
    ctx.fillRect(w * 0.78 - 120, h * 0.16 - 120, 240, 240);
    for (const [k, col, amp] of [[0.7, '#1c0a0f', 40], [1.3, '#150a0c', 26]] as const) {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(-20, horizon + 2);
      for (let x = -20; x <= w + 20; x += 20) ctx.lineTo(x, horizon - 30 * k - Math.sin(x * 0.006 * k + k * 3) * amp - Math.sin(x * 0.017) * amp * 0.3);
      ctx.lineTo(w + 20, horizon + 2);
      ctx.closePath();
      ctx.fill();
    }
    // Walls behind the holder of a fort or capital.
    if (b.nodeId !== null && g) {
      const kind = g.map.nodes[b.nodeId].kind;
      const holder = g.nodes[b.nodeId].owner;
      if (kind !== 'village') {
        const onLeft = holder === 0;
        const x0 = onLeft ? 0 : w * 0.72;
        const x1 = onLeft ? w * 0.28 : w;
        ctx.fillStyle = '#1d1515';
        ctx.fillRect(x0, horizon - 90, x1 - x0, 90);
        for (let x = x0; x < x1; x += 34) ctx.fillRect(x, horizon - 108, 20, 18);
        ctx.fillStyle = OWNER_COLOR[holder] + '55';
        ctx.fillRect(x0 + (x1 - x0) / 2 - 3, horizon - 170, 6, 80);
        ctx.fillRect(x0 + (x1 - x0) / 2 + 3, horizon - 170, 40, 24);
      }
    }
    const total = left.troops + right.troops || 1;
    const mid = this.practice ? (this.area().x0 + this.area().x1) / 2 : w * 0.5;
    const front = mid + ((left.troops - right.troops) / total) * w * 0.14;
    this.drawArmy(left.troops, front, horizon, -1, left.owner, left.momentum);
    this.drawArmy(right.troops, front, horizon, 1, right.owner, right.momentum);
    // Dust and sparks on the clash line.
    for (let i = 0; i < 26; i++) {
      const t = this.now * (0.6 + (i % 5) * 0.2) + i * 1.37;
      const y = horizon + 30 + ((i * 53) % Math.max(1, h - horizon - 60));
      const x = front + Math.sin(t * 2.3 + i) * 26;
      ctx.fillStyle = i % 3 === 0 ? 'rgba(255,220,170,0.75)' : 'rgba(150,120,100,0.18)';
      const s = i % 3 === 0 ? 2.5 : 14 + (i % 4) * 6;
      ctx.beginPath();
      ctx.arc(x, y + Math.sin(t) * 8, s, 0, Math.PI * 2);
      ctx.fill();
    }
    // Darken the play area slightly so quick-time events read clearly.
    const a = this.area();
    const vg = ctx.createRadialGradient((a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2, 40, (a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2, Math.max(a.x1 - a.x0, a.y1 - a.y0) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0.35)');
    vg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  }

  /** Rows of soldiers marching toward the clash line from one side. */
  private drawArmy(troops: number, front: number, horizon: number, dir: -1 | 1, owner: Owner, momentum: number) {
    const { ctx, h } = this;
    const n = Math.min(90, Math.ceil(troops));
    const rows = 5;
    const depth = h - horizon - 40;
    for (let i = 0; i < n; i++) {
      const row = i % rows;
      const file = Math.floor(i / rows);
      const y = horizon + 34 + (row / (rows - 1)) * depth * 0.9;
      const persp = 0.6 + (y - horizon) / depth * 0.7;
      const x = front + dir * (26 + file * 44 * persp + (row % 2) * 16);
      const bob = Math.sin(this.now * (6 + momentum * 3) + i * 1.3) * 2.5 * persp;
      const s = 9 * persp;
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.beginPath();
      ctx.ellipse(x, y + s * 2.1, s * 1.3, s * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = OWNER_DARK[owner];
      ctx.strokeStyle = OWNER_COLOR[owner];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(x - s * 0.8, y - s * 0.6 + bob, s * 1.6, s * 2.4, s * 0.5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = OWNER_LIGHT[owner];
      ctx.beginPath();
      ctx.arc(x, y - s * 1.2 + bob, s * 0.62, 0, Math.PI * 2);
      ctx.fill();
      // Spear.
      ctx.strokeStyle = 'rgba(230,220,200,0.6)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x - dir * s * 0.6, y + s + bob);
      ctx.lineTo(x - dir * s * 2.6, y - s * 2.2 + bob);
      ctx.stroke();
    }
    if (momentum > 1.15) {
      const g2 = ctx.createRadialGradient(front, horizon + depth / 2, 20, front, horizon + depth / 2, 300);
      g2.addColorStop(0, OWNER_COLOR[owner] + '40');
      g2.addColorStop(1, OWNER_COLOR[owner] + '00');
      ctx.fillStyle = g2;
      ctx.fillRect(dir < 0 ? front - 300 : front, horizon, 300, depth + 40);
    }
  }

  private drawQte() {
    const q = this.qte;
    if (!q) return;
    const { ctx } = this;
    ctx.lineCap = 'round';
    if (q.kind === 'volley') {
      const ring = VOLLEY_R * (1 + 2.4 * Math.max(-0.4, 1 - q.t / VOLLEY_HIT));
      const inWindow = Math.abs(q.t - VOLLEY_HIT) <= VOLLEY_WINDOW;
      ctx.fillStyle = inWindow ? 'rgba(255,169,77,0.35)' : 'rgba(255,169,77,0.15)';
      ctx.strokeStyle = '#ffa94d';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(q.x, q.y, VOLLEY_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = inWindow ? '#fff' : 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(q.x, q.y, Math.max(4, ring), 0, Math.PI * 2);
      ctx.stroke();
      // Arrow icon.
      ctx.strokeStyle = '#ffe1c2';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(q.x - 12, q.y + 12);
      ctx.lineTo(q.x + 12, q.y - 12);
      ctx.moveTo(q.x + 12, q.y - 12);
      ctx.lineTo(q.x + 2, q.y - 11);
      ctx.moveTo(q.x + 12, q.y - 12);
      ctx.lineTo(q.x + 11, q.y - 2);
      ctx.stroke();
      this.label('VOLLEY · click when the rings meet', q.x, q.y + VOLLEY_R + 34);
    } else if (q.kind === 'parry') {
      const c = this.center();
      const p = this.parryPos(q);
      // Your shield.
      ctx.fillStyle = 'rgba(226,54,77,0.18)';
      ctx.strokeStyle = '#ff8a98';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 40, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Incoming spear.
      const tail = { x: p.x + Math.cos(q.ang) * 90, y: p.y + Math.sin(q.ang) * 90 };
      ctx.strokeStyle = '#cfe8ff';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(tail.x, tail.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(p.x - Math.cos(q.ang) * 4, p.y - Math.sin(q.ang) * 4);
      ctx.lineTo(p.x + Math.cos(q.ang + 0.5) * 22, p.y + Math.sin(q.ang + 0.5) * 22);
      ctx.lineTo(p.x + Math.cos(q.ang - 0.5) * 22, p.y + Math.sin(q.ang - 0.5) * 22);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = `rgba(255,90,110,${0.5 + 0.5 * Math.sin(this.now * 20)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, PARRY_HIT_R - 10, 0, Math.PI * 2);
      ctx.stroke();
      this.label('PARRY · click the spear', c.x, c.y + 80);
    } else if (q.kind === 'slash') {
      const left = 1 - q.t / SLASH_TIME;
      ctx.setLineDash([14, 10]);
      ctx.strokeStyle = 'rgba(255,225,194,0.6)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(q.ax, q.ay);
      ctx.lineTo(q.bx, q.by);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = q.grabbed ? '#ffa94d' : 'rgba(255,169,77,0.85)';
      ctx.beginPath();
      ctx.arc(q.ax, q.ay, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffa94d';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(q.bx, q.by, 22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(q.bx, q.by, 22 + 18 * left, 0, Math.PI * 2);
      ctx.stroke();
      if (q.trail.length > 1) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 5;
        ctx.beginPath();
        q.trail.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.stroke();
      }
      this.label('SLASH · drag from the filled mark to the ring', (q.ax + q.bx) / 2, Math.max(q.ay, q.by) + 60);
    } else {
      const p = this.bannerPos(q);
      const prog = q.held / BANNER_NEED;
      ctx.fillStyle = 'rgba(255,209,102,0.12)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, BANNER_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, BANNER_R, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2);
      ctx.stroke();
      // Banner.
      ctx.strokeStyle = '#e8e0d0';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(p.x - 10, p.y + 26);
      ctx.lineTo(p.x - 10, p.y - 28);
      ctx.stroke();
      const wave = Math.sin(this.now * 8) * 4;
      ctx.fillStyle = '#e2364d';
      ctx.beginPath();
      ctx.moveTo(p.x - 10, p.y - 28);
      ctx.quadraticCurveTo(p.x + 8, p.y - 30 + wave, p.x + 26, p.y - 24);
      ctx.lineTo(p.x + 26, p.y - 4);
      ctx.quadraticCurveTo(p.x + 8, p.y - 10 + wave, p.x - 10, p.y - 6);
      ctx.closePath();
      ctx.fill();
      this.label('BANNER · hold the mouse on it', p.x, p.y + BANNER_R + 26);
    }
  }

  private label(text: string, x: number, y: number) {
    const { ctx } = this;
    ctx.font = '700 14px "Chakra Petch", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    const w = ctx.measureText(text).width + 20;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 16, w, 24, 12);
    ctx.fill();
    ctx.fillStyle = '#f1e6e8';
    ctx.fillText(text, x, y + 1);
  }

  private updateDom(g: Game, b: Battle) {
    const { left, right } = this.sides(b);
    const e = this.els;
    e.title.textContent = battleName(g, b);
    const holder = b.nodeId !== null ? g.nodes[b.nodeId].owner : null;
    e.sub.textContent =
      b.nodeId !== null
        ? `${NODE_STATS[g.map.nodes[b.nodeId].kind].label} · ${holder === 0 ? 'you hold the walls' : holder === 2 ? 'neutral garrison' : 'enemy holds the walls'}`
        : 'Open road · no walls';
    e.lc.textContent = String(Math.ceil(left.troops));
    e.rc.textContent = String(Math.ceil(right.troops));
    const me = sideOf(b, 0);
    e.lm.textContent = `You${me && sideDefense(g, b, me) > 1 ? ` · walls ×${sideDefense(g, b, me)}` : ''}`;
    const foe = b.sides.find((s) => s.owner === right.owner);
    e.rm.textContent = `${right.owner === 2 ? 'Neutral' : 'Enemy'}${foe && sideDefense(g, b, foe) > 1 ? ` · walls ×${sideDefense(g, b, foe)}` : ''}`;
    const pct = (m: number) => `${Math.max(0, Math.min(100, ((m - 0.5) / 3.5) * 100))}%`;
    e.lb.style.width = pct(left.momentum);
    e.rb.style.width = pct(right.momentum);
    e.cmdr.classList.toggle('hidden', g.presence[1] !== b.id);
    const over = b.endedAt !== null || !me || me.troops <= 0.5;
    e.result.classList.toggle('hidden', !over);
    if (over) {
      const won = b.winner === 0;
      e.result.textContent = won ? 'Victory' : b.nodeId !== null && g.nodes[b.nodeId].owner === 0 && b.winner === null ? 'Held' : 'Defeat';
      e.result.className = `bv-result ${won ? 'win' : 'loss'}`;
    }
    // Other battles involving you.
    const others = activeBattles(g).filter((o) => o.id !== b.id && (sideOf(o, 0)?.troops ?? 0) > 0.5);
    e.others.innerHTML = others.length
      ? others
          .map((o) => {
            const s = this.sides(o);
            const r = s.left.troops / (s.left.troops + s.right.troops || 1);
            return `<button data-bid="${o.id}"><span>${battleName(g, o).replace('Battle of ', '')}${g.presence[1] === o.id ? ' · <i>enemy cmdr</i>' : ''}</span><div class="bar"><div style="width:${r * 100}%"></div></div><small>${Math.ceil(s.left.troops)} vs ${Math.ceil(s.right.troops)}</small></button>`;
          })
          .join('')
      : '<p class="none">None right now</p>';
    const recent = g.events.filter((ev) => ev.kind !== 'qte' && g.time - ev.t < 6).slice(-3).reverse();
    e.ticker.innerHTML = recent.map((ev) => `<div class="${ev.kind === 'lost' ? 'bad' : ''}">${ev.text}</div>`).join('');
  }
}
