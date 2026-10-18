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
}

export interface BattleViewHooks {
  onQte: (battleId: number, kind: QteKind, success: boolean) => string;
  onLeave: () => void;
  onSwitch: (battleId: number) => void;
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
      <button class="bv-leave" data-el="leave">Back to map <span>Esc · right-click</span></button>`;
    root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.els[e.dataset.el!] = e));
    this.canvas = root.querySelector('.bv-canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.els.leave.addEventListener('click', () => this.hooks.onLeave());
    this.els.others.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-bid]')?.dataset.bid;
      if (id) this.hooks.onSwitch(Number(id));
    });
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.hooks.onLeave();
    });
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      this.mouse = { x: e.offsetX, y: e.offsetY, down: true };
      this.press();
    });
    this.canvas.addEventListener('mousemove', (e) => {
      this.mouse.x = e.offsetX;
      this.mouse.y = e.offsetY;
      this.drag();
    });
    window.addEventListener('mouseup', () => {
      if (!this.mouse.down) return;
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
    this.qte = null;
    this.root.classList.add('hidden');
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
    return { x0: this.w * 0.2, x1: this.w * 0.75, y0: this.h * 0.3, y1: this.h * 0.8 };
  }

  private center() {
    const a = this.area();
    return { x: (a.x0 + a.x1) / 2, y: (a.y0 + a.y1) / 2 };
  }

  private spawn() {
    const kinds: QteKind[] = ['volley', 'parry', 'slash', 'banner'];
    const pool = kinds.filter((k) => k !== this.last);
    const kind = pool[Math.floor(Math.random() * pool.length)];
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

  private resolve(success: boolean, x: number, y: number) {
    if (!this.qte || this.battleId === null) return;
    const text = this.hooks.onQte(this.battleId, this.qte.kind, success);
    this.floaters.push({ text: text || (success ? 'Hit' : 'Miss'), x, y, t: 0, good: success });
    if (!success && this.qte.kind === 'parry') this.shake = 0.35;
    this.qte = null;
    this.gap = GAP;
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
      if (Math.hypot(x - q.x, y - q.y) > VOLLEY_R + 24) return; // clicks off the target are ignored
      this.resolve(Math.abs(q.t - VOLLEY_HIT) <= VOLLEY_WINDOW, q.x, q.y);
    } else if (q.kind === 'parry') {
      const p = this.parryPos(q);
      if (Math.hypot(x - p.x, y - p.y) <= PARRY_HIT_R) this.resolve(true, p.x, p.y);
    } else if (q.kind === 'slash') {
      if (Math.hypot(x - q.ax, y - q.ay) <= SLASH_GRAB) {
        q.grabbed = true;
        q.trail = [{ x, y }];
      }
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
    if (off > SLASH_TOLERANCE) this.resolve(false, x, y);
    else if (Math.hypot(x - q.bx, y - q.by) <= SLASH_GRAB) this.resolve(true, q.bx, q.by);
  }

  private release() {
    const q = this.qte;
    if (q && q.kind === 'slash' && q.grabbed) this.resolve(false, this.mouse.x, this.mouse.y);
  }

  update(g: Game, dt: number) {
    if (this.battleId === null) return;
    this.now += dt;
    this.shake = Math.max(0, this.shake - dt);
    for (const f of this.floaters) f.t += dt;
    this.floaters = this.floaters.filter((f) => f.t < 1.3);
    const b = getBattle(g, this.battleId);
    if (!b) return this.hooks.onLeave();
    if (b.endedAt !== null || !sideOf(b, 0) || sideOf(b, 0)!.troops <= 0.5) {
      // Battle over (or our side is gone): show the result briefly, then go back to the map.
      this.qte = null;
      this.endShownAt ??= this.now;
      if (this.now - this.endShownAt > 1.6) this.hooks.onLeave();
      return;
    }
    if (!this.qte) {
      this.gap -= dt;
      if (this.gap <= 0) this.spawn();
      return;
    }
    const q = this.qte;
    q.t += dt;
    if (q.kind === 'volley' && q.t > VOLLEY_LIFE) this.resolve(false, q.x, q.y);
    else if (q.kind === 'parry' && q.t >= PARRY_TIME) {
      const c = this.center();
      this.resolve(false, c.x, c.y);
    } else if (q.kind === 'slash' && q.t >= SLASH_TIME) this.resolve(false, q.bx, q.by);
    else if (q.kind === 'banner') {
      const p = this.bannerPos(q);
      if (this.mouse.down && Math.hypot(this.mouse.x - p.x, this.mouse.y - p.y) <= BANNER_R) q.held += dt;
      if (q.held >= BANNER_NEED) this.resolve(true, p.x, p.y);
      else if (q.t >= BANNER_TIME) this.resolve(false, p.x, p.y);
    }
  }

  render(g: Game) {
    if (this.battleId === null) return;
    const b = getBattle(g, this.battleId);
    if (!b) return;
    const { ctx } = this;
    const sx = this.shake > 0 ? (Math.random() - 0.5) * 14 * (this.shake / 0.35) : 0;
    const sy = this.shake > 0 ? (Math.random() - 0.5) * 10 * (this.shake / 0.35) : 0;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, this.dpr * sx, this.dpr * sy);
    this.drawScene(g, b);
    this.drawQte();
    for (const f of this.floaters) {
      ctx.globalAlpha = Math.max(0, 1 - f.t / 1.3);
      ctx.fillStyle = f.good ? '#ffd27a' : '#ff8a8a';
      ctx.font = '700 24px "Chakra Petch", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(f.text, f.x, f.y - 40 - f.t * 40);
      ctx.globalAlpha = 1;
    }
    this.updateDom(g, b);
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

  private drawScene(g: Game, b: Battle) {
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
    if (b.nodeId !== null) {
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
    const front = w * 0.5 + ((left.troops - right.troops) / total) * w * 0.14;
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
    const pct = (m: number) => `${Math.max(0, Math.min(100, ((m - 0.5) / 1.7) * 100))}%`;
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
