import { FOREST, HILL, MOUNTAIN, PLAIN, WATER, type GameMap, type Pt } from './map';
import { makeNoise, mulberry32 } from './rng';
import { CAPTURE_TIME, CUT_OFF_LIFE, HQ_RADIUS, VISION, canRally, canSee, canStrike, isBuffed, type Game, type Unit } from './sim';

export const TEAM_COLOR = ['#e2364d', '#4aa3d8'];
const TEAM_DARK = ['#5c1220', '#123a55'];
const TEAM_LIGHT = ['#ff8a98', '#a8dcff'];

const PX = 6; // terrain texture pixels per cell

type RGB = [number, number, number];
const BASE: Record<number, RGB> = {
  [WATER]: [12, 19, 33],
  [PLAIN]: [44, 50, 36],
  [FOREST]: [24, 40, 28],
  [HILL]: [62, 57, 42],
  [MOUNTAIN]: [92, 88, 82],
};

/** Paint the terrain once into an offscreen canvas. Edges are jittered with noise so they read as land, not tiles. */
export function renderTerrain(m: GameMap): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = m.w * PX;
  c.height = m.h * PX;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(c.width, c.height);
  const rng = mulberry32(m.seed ^ 0x9e3779b9);
  const jx = makeNoise(rng);
  const jy = makeNoise(rng);
  const grain = makeNoise(rng);
  const tAt = (x: number, y: number) => {
    const cx = Math.min(m.w - 1, Math.max(0, Math.floor(x)));
    const cy = Math.min(m.h - 1, Math.max(0, Math.floor(y)));
    return m.terrain[cy * m.w + cx];
  };
  const eAt = (x: number, y: number) => {
    const cx = Math.min(m.w - 1, Math.max(0, Math.floor(x)));
    const cy = Math.min(m.h - 1, Math.max(0, Math.floor(y)));
    return m.elev[cy * m.w + cx];
  };
  // Distance-to-land approximation for shallow water.
  const nearLand = new Uint8Array(m.w * m.h);
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (m.terrain[y * m.w + x] !== WATER) continue;
      let best = 9;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          if (tAt(x + dx, y + dy) !== WATER) best = Math.min(best, Math.max(Math.abs(dx), Math.abs(dy)));
        }
      }
      nearLand[y * m.w + x] = best;
    }
  }
  for (let py = 0; py < c.height; py++) {
    for (let px = 0; px < c.width; px++) {
      const wx = px / PX;
      const wy = py / PX;
      const sx = wx + (jx(wx * 0.9, wy * 0.9) - 0.5) * 0.9;
      const sy = wy + (jy(wx * 0.9, wy * 0.9) - 0.5) * 0.9;
      const t = tAt(sx, sy);
      let [r, g, b] = BASE[t];
      const gr = grain(wx * 3, wy * 3) - 0.5;
      if (t === WATER) {
        const nl = nearLand[Math.floor(sy) * m.w + Math.floor(sx)] ?? 9;
        const shallow = Math.max(0, 1 - (nl - 1) / 3);
        r += 10 * shallow;
        g += 22 * shallow;
        b += 34 * shallow;
        r += gr * 6;
        g += gr * 8;
        b += gr * 12;
      } else {
        // Hillshade from the elevation field (light from the north-west).
        const e = eAt(sx, sy);
        const shade = (e - eAt(sx - 1, sy - 1)) * 160;
        const k = 1 + Math.max(-0.35, Math.min(0.35, shade * 0.02)) + gr * 0.12;
        r *= k;
        g *= k;
        b *= k;
        if (t === MOUNTAIN && e > 0.8) {
          r += 30;
          g += 30;
          b += 30;
        }
        if (t === FOREST) {
          // Canopy speckle.
          const s = grain(wx * 11, wy * 11);
          if (s > 0.62) {
            r *= 0.7;
            g *= 0.75;
            b *= 0.7;
          }
        }
        if (t === HILL) {
          const s = grain(wx * 2.2 + 40, wy * 2.2);
          const band = Math.abs(((s * 8) % 1) - 0.5) < 0.06 ? 1.12 : 1;
          r *= band;
          g *= band;
          b *= band;
        }
        // Light coastline rim.
        if (tAt(sx + 0.5, sy) === WATER || tAt(sx - 0.5, sy) === WATER || tAt(sx, sy + 0.5) === WATER || tAt(sx, sy - 0.5) === WATER) {
          r += 22;
          g += 22;
          b += 18;
        }
      }
      const i = (py * c.width + px) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export interface Badge {
  x: number;
  y: number;
  r: number;
  unitId: number;
  kind: 'strike' | 'rally';
}

export interface UiState {
  selected: Set<number>;
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  showSupply: boolean;
  activeUnit: number | null;
  marks: { x: number; y: number; t: number }[];
  now: number;
}

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  private terrain: HTMLCanvasElement | null = null;
  private map: GameMap | null = null;
  private supplyCanvas: HTMLCanvasElement | null = null;
  private supplySrc: Uint8Array | null = null;
  private fogCanvas: HTMLCanvasElement | null = null;
  scale = 10;
  ox = 0;
  oy = 0;
  width = 0;
  height = 0;
  private dpr = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  setMap(m: GameMap) {
    this.map = m;
    this.terrain = renderTerrain(m);
    this.supplySrc = null;
  }

  resize(w: number, h: number) {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = w;
    this.height = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
  }

  /** Fit the whole map in view, leaving room for the HUD bars. */
  fit(top = 64, bottom = 24) {
    if (!this.map) return;
    const pad = 20;
    const s = Math.min((this.width - pad * 2) / this.map.w, (this.height - top - bottom - pad) / this.map.h);
    this.scale = s;
    this.ox = (this.width - this.map.w * s) / 2;
    this.oy = top + (this.height - top - bottom - this.map.h * s) / 2;
  }

  w2s(p: Pt): Pt {
    return { x: p.x * this.scale + this.ox, y: p.y * this.scale + this.oy };
  }

  s2w(x: number, y: number): Pt {
    return { x: (x - this.ox) / this.scale, y: (y - this.oy) / this.scale };
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const before = this.s2w(sx, sy);
    this.scale = Math.max(4, Math.min(40, this.scale * factor));
    this.ox = sx - before.x * this.scale;
    this.oy = sy - before.y * this.scale;
  }

  pan(dx: number, dy: number) {
    this.ox += dx;
    this.oy += dy;
  }

  private supplyLayer(mask: Uint8Array): HTMLCanvasElement {
    const m = this.map!;
    if (this.supplyCanvas && this.supplySrc === mask) return this.supplyCanvas;
    const c = this.supplyCanvas ?? document.createElement('canvas');
    c.width = m.w;
    c.height = m.h;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(m.w, m.h);
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      img.data[i * 4] = 226;
      img.data[i * 4 + 1] = 54;
      img.data[i * 4 + 2] = 77;
      img.data[i * 4 + 3] = 46;
    }
    ctx.putImageData(img, 0, 0);
    this.supplyCanvas = c;
    this.supplySrc = mask;
    return c;
  }

  /** Low-resolution fog mask, scaled up so vision edges come out soft. */
  private fogLayer(g: Game): HTMLCanvasElement {
    const m = g.map;
    const k = 3;
    const c = this.fogCanvas ?? document.createElement('canvas');
    c.width = m.w * k;
    c.height = m.h * k;
    const ctx = c.getContext('2d')!;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = 'rgba(3,4,8,0.74)';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.globalCompositeOperation = 'destination-out';
    const eyes = [m.hq[0], ...g.units.filter((u) => u.alive && u.team === 0)];
    for (const e of eyes) {
      const grad = ctx.createRadialGradient(e.x * k, e.y * k, VISION * k * 0.75, e.x * k, e.y * k, VISION * k);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(e.x * k, e.y * k, VISION * k, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    this.fogCanvas = c;
    return c;
  }

  draw(g: Game, ui: UiState): Badge[] {
    const { ctx } = this;
    const m = g.map;
    const s = this.scale;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#07080c';
    ctx.fillRect(0, 0, this.width, this.height);

    // Terrain, then optional supply tint.
    if (this.terrain) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.terrain, this.ox, this.oy, m.w * s, m.h * s);
    }
    if (ui.showSupply) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.supplyLayer(g.supply[0]), this.ox, this.oy, m.w * s, m.h * s);
    }

    if (g.fog) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.fogLayer(g), this.ox, this.oy, m.w * s, m.h * s);
    }
    const seen = (p: { x: number; y: number }) => canSee(g, 0, p);

    // Strongholds (their location is always known).
    for (const team of [0, 1] as const) {
      const p = this.w2s(m.hq[team]);
      const r = HQ_RADIUS * s;
      ctx.save();
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = TEAM_COLOR[team] + '88';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      const prog = g.capture[team] / CAPTURE_TIME;
      if (prog > 0) {
        ctx.strokeStyle = TEAM_COLOR[1 - team];
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 4, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2);
        ctx.stroke();
      }
      const k = Math.max(8, s * 1.5);
      ctx.fillStyle = TEAM_DARK[team];
      ctx.strokeStyle = TEAM_COLOR[team];
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + (i * Math.PI) / 3;
        const x = p.x + Math.cos(a) * k;
        const y = p.y + Math.sin(a) * k;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = TEAM_LIGHT[team];
      ctx.beginPath();
      ctx.arc(p.x, p.y, k * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }

    const living = g.units.filter((u) => u.alive && (u.team === 0 || seen(u)));
    // Planned paths of selected units.
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,220,225,0.35)';
    for (const u of living) {
      if (!ui.selected.has(u.id) || !u.path.length) continue;
      const a = this.w2s(u);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      for (const p of u.path) {
        const q = this.w2s(p);
        ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
    }
    ctx.restore();

    // Move markers.
    for (const mk of ui.marks) {
      const age = ui.now - mk.t;
      if (age > 0.6) continue;
      const p = this.w2s(mk);
      ctx.strokeStyle = `rgba(255,140,155,${1 - age / 0.6})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4 + age * 18, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Ranged tracers.
    for (const e of g.events) {
      if (e.kind !== 'shot' || e.x2 === undefined || e.y2 === undefined) continue;
      if (!seen(e) && !seen({ x: e.x2, y: e.y2 })) continue;
      const age = g.time - e.t;
      if (age > 0.25) continue;
      const f = age / 0.25;
      const a = this.w2s({ x: e.x + (e.x2 - e.x) * f, y: e.y + (e.y2 - e.y) * f });
      const b = this.w2s({ x: e.x + (e.x2 - e.x) * Math.min(1, f + 0.25), y: e.y + (e.y2 - e.y) * Math.min(1, f + 0.25) });
      ctx.strokeStyle = TEAM_LIGHT[e.team];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    const badges: Badge[] = [];
    const r = Math.max(5, s * 0.78);
    for (const u of living) this.drawUnit(g, u, r, ui);
    for (const u of living) {
      if (u.team !== 0) continue;
      const p = this.w2s(u);
      const br = Math.max(6, r * 0.62);
      // One badge per unit keeps crowded fights clickable: rally when badly hurt, otherwise strike.
      const strike = canStrike(g, u);
      const rally = canRally(g, u);
      const kind = rally && (!strike || u.hp < u.maxHp * 0.6) ? 'rally' : strike ? 'strike' : null;
      if (kind) {
        const b: Badge = { x: p.x + r * 0.8, y: p.y - r * 1.15, r: br, unitId: u.id, kind };
        this.drawBadge(b, ui.now);
        badges.push(b);
      }
    }

    // One-shot effects.
    for (const e of g.events) {
      const age = g.time - e.t;
      const p = this.w2s(e);
      if (!seen(e)) continue;
      if (e.kind === 'death') {
        ctx.strokeStyle = `rgba(255,255,255,${0.7 * (1 - age / 1.6)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + age * 20, 0, Math.PI * 2);
        ctx.stroke();
      } else if (e.kind === 'strike' && age < 0.8) {
        ctx.strokeStyle = `rgba(255,170,60,${1 - age / 0.8})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + age * 26, 0, Math.PI * 2);
        ctx.stroke();
      } else if (e.kind === 'rally' && age < 1.2) {
        ctx.fillStyle = `rgba(120,240,160,${1 - age / 1.2})`;
        ctx.font = `700 ${Math.round(11 + r * 0.4)}px "Chakra Petch", sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(`+${Math.round(e.value ?? 0)}`, p.x, p.y - r - 10 - age * 18);
      }
    }

    if (ui.box) {
      const { x0, y0, x1, y1 } = ui.box;
      ctx.fillStyle = 'rgba(226,54,77,0.08)';
      ctx.strokeStyle = 'rgba(255,138,152,0.8)';
      ctx.lineWidth = 1;
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    }

    // Vignette.
    const v = ctx.createRadialGradient(this.width / 2, this.height / 2, Math.min(this.width, this.height) * 0.35, this.width / 2, this.height / 2, Math.max(this.width, this.height) * 0.75);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, this.width, this.height);
    return badges;
  }

  private drawUnit(g: Game, u: Unit, r: number, ui: UiState) {
    const { ctx } = this;
    const p = this.w2s(u);
    const t = u.team;
    if (isBuffed(g, u)) {
      const glow = ctx.createRadialGradient(p.x, p.y, r * 0.5, p.x, p.y, r * 2.1);
      glow.addColorStop(0, 'rgba(255,160,60,0.55)');
      glow.addColorStop(1, 'rgba(255,160,60,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 2.1, 0, Math.PI * 2);
      ctx.fill();
    }
    if (ui.activeUnit === u.id) {
      ctx.strokeStyle = `rgba(255,255,255,${0.5 + 0.5 * Math.sin(ui.now * 10)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 7, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Shadow, body.
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.arc(p.x + 1.5, p.y + 2, r, 0, Math.PI * 2);
    ctx.fill();
    const body = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.4, r * 0.1, p.x, p.y, r);
    body.addColorStop(0, TEAM_LIGHT[t]);
    body.addColorStop(1, TEAM_COLOR[t]);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    if (u.kind === 'ranged') {
      // Ranged: hollow core with a sight dot.
      ctx.fillStyle = TEAM_DARK[t];
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 0.55, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = TEAM_LIGHT[t];
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 0.18, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Melee: a blade chevron.
      ctx.strokeStyle = TEAM_DARK[t];
      ctx.lineWidth = Math.max(1.5, r * 0.22);
      ctx.beginPath();
      ctx.moveTo(p.x - r * 0.4, p.y + r * 0.15);
      ctx.lineTo(p.x, p.y - r * 0.35);
      ctx.lineTo(p.x + r * 0.4, p.y + r * 0.15);
      ctx.stroke();
    }
    // Health ring.
    const f = Math.max(0, u.hp / u.maxHp);
    ctx.lineWidth = Math.max(2, r * 0.26);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 2.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = f > 0.6 ? '#9ff0b5' : f > 0.3 ? '#ffd166' : '#ff5a5a';
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 2.5, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2);
    ctx.stroke();
    if (ui.selected.has(u.id)) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 5.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (u.cutTime > 0) {
      // Supply clock: the yellow arc is the time left to reconnect before the unit dies.
      const left = Math.max(0, 1 - u.cutTime / CUT_OFF_LIFE);
      const urgent = left < 0.35;
      ctx.save();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 8.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = urgent ? (Math.sin(ui.now * 14) > 0 ? '#ff5a5a' : '#ffd166') : u.supplied ? 'rgba(255,209,102,0.5)' : '#ffd166';
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 8.5, -Math.PI / 2, -Math.PI / 2 + left * Math.PI * 2);
      ctx.stroke();
      if (!u.supplied && t === 0) {
        ctx.fillStyle = urgent ? '#ff8a8a' : '#ffd166';
        ctx.font = `700 ${Math.round(10 + r * 0.35)}px "Chakra Petch", sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(`${Math.ceil(CUT_OFF_LIFE - u.cutTime)}s`, p.x, p.y + r + 22);
      }
      ctx.restore();
    }
    if (u.contact) {
      // Clash sparks.
      for (let i = 0; i < 2; i++) {
        const a = ui.now * 7 + u.id * 1.7 + i * 3.1;
        ctx.fillStyle = 'rgba(255,230,180,0.85)';
        ctx.fillRect(p.x + Math.cos(a) * r * 1.2 - 1, p.y + Math.sin(a * 1.3) * r * 1.2 - 1, 2, 2);
      }
    }
  }

  private drawBadge(b: Badge, now: number) {
    const { ctx } = this;
    const pulse = 1 + 0.08 * Math.sin(now * 6 + b.unitId);
    const r = b.r * pulse;
    ctx.fillStyle = b.kind === 'strike' ? '#2a1408' : '#0b2416';
    ctx.strokeStyle = b.kind === 'strike' ? '#ffa94d' : '#6ee7a0';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = b.kind === 'strike' ? '#ffd8a8' : '#b9f6cf';
    ctx.lineWidth = Math.max(1.5, r * 0.22);
    ctx.beginPath();
    if (b.kind === 'strike') {
      ctx.moveTo(b.x - r * 0.45, b.y + r * 0.45);
      ctx.lineTo(b.x + r * 0.45, b.y - r * 0.45);
      ctx.moveTo(b.x - r * 0.35, b.y - r * 0.05);
      ctx.lineTo(b.x + r * 0.05, b.y + r * 0.35);
    } else {
      ctx.moveTo(b.x - r * 0.5, b.y);
      ctx.lineTo(b.x + r * 0.5, b.y);
      ctx.moveTo(b.x, b.y - r * 0.5);
      ctx.lineTo(b.x, b.y + r * 0.5);
    }
    ctx.stroke();
  }
}
