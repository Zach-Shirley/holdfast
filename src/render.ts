import { NODE_STATS, SPECIALS, WORLD_H, WORLD_W, type GraphMap, type MapNode } from './map';
import { fbm, makeNoise, mulberry32 } from './rng';
import { VISION_BATTLE, VISION_COLUMN, VISION_NODE, VISION_TOWER, activeBattles, canSee, columnPos, inDuel, knownNode, sideOf, type Battle, type Game, type Owner } from './sim';

export const OWNER_COLOR: Record<Owner, string> = { 0: '#e2364d', 1: '#4aa3d8', 2: '#a89a7c' };
export const OWNER_LIGHT: Record<Owner, string> = { 0: '#ff8a98', 1: '#a8dcff', 2: '#d8ccb0' };
export const OWNER_DARK: Record<Owner, string> = { 0: '#3d0d16', 1: '#0f2a3d', 2: '#2b261c' };

const PALETTES = {
  classic: { c: ['#e2364d', '#4aa3d8'], l: ['#ff8a98', '#a8dcff'], d: ['#3d0d16', '#0f2a3d'] },
  // Orange vs. strong blue: distinct for the common forms of colour blindness.
  contrast: { c: ['#ff9f1c', '#3a6dff'], l: ['#ffd29a', '#a9c1ff'], d: ['#3d2405', '#0b1844'] },
};

/** Switch team colours everywhere (canvas and CSS). */
export function applyPalette(name: keyof typeof PALETTES) {
  const p = PALETTES[name];
  for (const i of [0, 1] as const) {
    OWNER_COLOR[i] = p.c[i];
    OWNER_LIGHT[i] = p.l[i];
    OWNER_DARK[i] = p.d[i];
  }
  const root = document.documentElement.style;
  root.setProperty('--p0', p.c[0]);
  root.setProperty('--p0-light', p.l[0]);
  root.setProperty('--p1', p.c[1]);
  root.setProperty('--p1-light', p.l[1]);
}

export function nodeRadius(n: MapNode) {
  return n.kind === 'capital' ? 44 : n.kind === 'fort' ? 38 : 33;
}

/** Painted, dark map backdrop at world resolution. */
export function paintBackground(m: GraphMap): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const S = 0.5; // paint at half resolution; scaling up softens it nicely
  c.width = WORLD_W * S;
  c.height = WORLD_H * S;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(c.width, c.height);
  const rng = mulberry32(m.seed ^ 0xbeef);
  const n1 = makeNoise(rng);
  const n2 = makeNoise(rng);
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const wx = x / c.width;
      const wy = y / c.height;
      const e = fbm(n1, wx * 6, wy * 3.4, 5);
      const f = fbm(n2, wx * 14, wy * 8, 3);
      // Contour lines on the elevation field.
      const contour = Math.abs(((e * 14) % 1) - 0.5) < 0.04 ? 9 : 0;
      const i = (y * c.width + x) * 4;
      img.data[i] = 22 + e * 26 + f * 8 + contour;
      img.data[i + 1] = 22 + e * 22 + f * 10 + contour * 0.8;
      img.data[i + 2] = 20 + e * 14 + f * 6 + contour * 0.6;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const v = ctx.createRadialGradient(c.width / 2, c.height / 2, c.height * 0.3, c.width / 2, c.height / 2, c.width * 0.62);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.6)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

export interface MapUi {
  hover: number | null;
  drag: { from: number; x: number; y: number; target: number | null; amount: number } | null;
  now: number;
  /** Strongholds picked with the selection box (multi-send). */
  selected: Set<number>;
  /** Selection box in screen pixels. */
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Right-drag preview for a rally route. */
  rallyDrag: { from: number; x: number; y: number; target: number | null } | null;
  /** Ability waiting for a target click. */
  targeting: 'march' | 'inspire' | null;
  /** Watch mode: both sides are AIs; flags use their names. */
  spectate?: boolean;
  names?: [string, string];
}

export class MapRenderer {
  readonly ctx: CanvasRenderingContext2D;
  private bg: HTMLCanvasElement | null = null;
  scale = 1;
  ox = 0;
  oy = 0;
  width = 0;
  height = 0;
  private dpr = 1;
  /** Dust kicked up by marching columns. */
  private dust: { x: number; y: number; t: number; owner: Owner }[] = [];
  private lastNow = 0;
  private fogCanvas: HTMLCanvasElement | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  setMap(m: GraphMap) {
    this.dust = [];
    this.bg = paintBackground(m);
  }

  resize(w: number, h: number, top = 70, bottom = 84) {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = w;
    this.height = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    const pad = 24;
    this.scale = Math.min((w - pad * 2) / WORLD_W, (h - top - bottom - pad) / WORLD_H);
    this.ox = (w - WORLD_W * this.scale) / 2;
    this.oy = top + (h - top - bottom - WORLD_H * this.scale) / 2;
  }

  w2s(x: number, y: number) {
    return { x: x * this.scale + this.ox, y: y * this.scale + this.oy };
  }

  s2w(x: number, y: number) {
    return { x: (x - this.ox) / this.scale, y: (y - this.oy) / this.scale };
  }

  nodeAt(g: Game, sx: number, sy: number): number | null {
    const w = this.s2w(sx, sy);
    for (const n of g.map.nodes) if (Math.hypot(n.x - w.x, n.y - w.y) <= nodeRadius(n) + 10) return n.id;
    return null;
  }

  /** Battle marker hit test (road battles, and the swords badge above node battles). */
  battleAt(g: Game, sx: number, sy: number): number | null {
    const w = this.s2w(sx, sy);
    for (const b of activeBattles(g)) {
      const p = this.markerPos(g, b);
      if (Math.hypot(p.x - w.x, p.y - w.y) <= 42) return b.id;
    }
    return null;
  }

  private markerPos(g: Game, b: Battle) {
    if (b.nodeId === null) return { x: b.x, y: b.y };
    const n = g.map.nodes[b.nodeId];
    return { x: n.x, y: n.y - nodeRadius(n) - 44 };
  }

  draw(g: Game, ui: MapUi) {
    const { ctx } = this;
    const m = g.map;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#060608';
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.setTransform(this.dpr * this.scale, 0, 0, this.dpr * this.scale, this.dpr * this.ox, this.dpr * this.oy);
    if (this.bg) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.bg, 0, 0, WORLD_W, WORLD_H);
    }

    // Roads: dirt, marsh (slow, green and broken) or paved (fast, pale stone).
    for (const e of m.edges) {
      const a = m.nodes[e.a];
      const b = m.nodes[e.b];
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = e.road === 'paved' ? 16 : 14;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.strokeStyle = e.road === 'marsh' ? '#2c3a2a' : e.road === 'paved' ? '#5b544a' : '#3a322b';
      ctx.lineWidth = e.road === 'paved' ? 10 : 8;
      ctx.stroke();
      ctx.save();
      if (e.road === 'marsh') {
        ctx.setLineDash([4, 9]);
        ctx.strokeStyle = 'rgba(120,170,110,0.45)';
        ctx.lineWidth = 3;
      } else if (e.road === 'paved') {
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(230,220,200,0.35)';
        ctx.lineWidth = 2;
      } else {
        ctx.setLineDash([10, 14]);
        ctx.strokeStyle = 'rgba(220,200,170,0.18)';
        ctx.lineWidth = 2;
      }
      ctx.stroke();
      ctx.restore();
    }

    // Fog of war over the land you cannot currently see.
    const fogged = g.fog && g.spyUntil[0] <= g.time;
    if (fogged) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.fogLayer(g), 0, 0, WORLD_W, WORLD_H);
    }
    const visible = (x: number, y: number) => canSee(g, 0, x, y);

    // Your rally routes.
    for (const n of g.nodes) {
      if (n.owner !== 0 || n.rallyTo === null) continue;
      this.routeArrow(m.nodes[n.id], m.nodes[n.rallyTo], ui.now, 'rgba(159,240,181,0.85)');
    }
    if (ui.rallyDrag) {
      const a = m.nodes[ui.rallyDrag.from];
      const t = ui.rallyDrag.target !== null ? m.nodes[ui.rallyDrag.target] : null;
      const to = t ?? { ...this.s2w(ui.rallyDrag.x, ui.rallyDrag.y), kind: 'village' as const };
      this.routeArrow(a, to as MapNode, ui.now, 'rgba(159,240,181,0.95)');
    }

    // Drag preview.
    if (ui.drag) {
      const a = m.nodes[ui.drag.from];
      const t = ui.drag.target !== null ? m.nodes[ui.drag.target] : null;
      const to = t ? { x: t.x, y: t.y } : this.s2w(ui.drag.x, ui.drag.y);
      const ang = Math.atan2(to.y - a.y, to.x - a.x);
      const end = t ? { x: to.x - Math.cos(ang) * (nodeRadius(t) + 8), y: to.y - Math.sin(ang) * (nodeRadius(t) + 8) } : to;
      ctx.strokeStyle = 'rgba(255,138,152,0.9)';
      ctx.lineWidth = 4;
      ctx.setLineDash([12, 8]);
      ctx.lineDashOffset = -ui.now * 40;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,138,152,0.95)';
      ctx.beginPath();
      ctx.moveTo(end.x, end.y);
      ctx.lineTo(end.x - Math.cos(ang - 0.45) * 18, end.y - Math.sin(ang - 0.45) * 18);
      ctx.lineTo(end.x - Math.cos(ang + 0.45) * 18, end.y - Math.sin(ang + 0.45) * 18);
      ctx.closePath();
      ctx.fill();
      this.pill(`${ui.drag.amount}`, (a.x + end.x) / 2, (a.y + end.y) / 2 - 16, 0);
    }

    // Dust trails behind marching columns.
    const dt = Math.min(0.1, Math.max(0, ui.now - this.lastNow));
    this.lastNow = ui.now;
    for (const d of this.dust) d.t += dt;
    this.dust = this.dust.filter((d) => d.t < 1.1);
    for (const c of g.columns) {
      if (c.owner !== 0 && !visible(columnPos(g, c).x, columnPos(g, c).y)) continue;
      if (Math.random() < dt * 14) {
        const p = columnPos(g, c);
        const a = m.nodes[c.from];
        const b = m.nodes[c.path[0]];
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        this.dust.push({ x: p.x - Math.cos(ang) * 22 + (Math.random() - 0.5) * 10, y: p.y - Math.sin(ang) * 22 + (Math.random() - 0.5) * 10, t: 0, owner: c.owner });
      }
    }
    for (const d of this.dust) {
      ctx.fillStyle = `rgba(190,170,140,${0.22 * (1 - d.t / 1.1)})`;
      ctx.beginPath();
      ctx.arc(d.x, d.y, 5 + d.t * 14, 0, Math.PI * 2);
      ctx.fill();
    }

    // Columns on the march.
    for (const c of g.columns) {
      const p = columnPos(g, c);
      if (c.owner !== 0 && !visible(p.x, p.y)) continue;
      const a = m.nodes[c.from];
      const b = m.nodes[c.path[0]];
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      // Spy: see where enemy columns are heading.
      if (c.owner !== 0 && g.spyUntil[0] > g.time) {
        const dest = m.nodes[c.path[c.path.length - 1]];
        ctx.save();
        ctx.setLineDash([6, 8]);
        ctx.strokeStyle = 'rgba(168,220,255,0.6)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(dest.x, dest.y);
        ctx.stroke();
        ctx.restore();
      }
      if (c.forcedUntil > g.time) {
        ctx.strokeStyle = 'rgba(255,230,180,0.6)';
        ctx.lineWidth = 2;
        for (let k = 0; k < 3; k++) {
          const off = (k - 1) * 7;
          ctx.beginPath();
          ctx.moveTo(p.x - Math.cos(ang) * 30 + Math.cos(ang + Math.PI / 2) * off, p.y - Math.sin(ang) * 30 + Math.sin(ang + Math.PI / 2) * off);
          ctx.lineTo(p.x - Math.cos(ang) * 55 + Math.cos(ang + Math.PI / 2) * off, p.y - Math.sin(ang) * 55 + Math.sin(ang + Math.PI / 2) * off);
          ctx.stroke();
        }
      }
      if (ui.targeting === 'march' && c.owner === 0) {
        ctx.strokeStyle = `rgba(255,209,102,${0.5 + 0.5 * Math.sin(ui.now * 10)})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 26, 0, Math.PI * 2);
        ctx.stroke();
      }
      const dots = Math.min(9, Math.max(2, Math.ceil(c.troops / 5)));
      for (let i = 0; i < dots; i++) {
        const row = Math.floor(i / 3);
        const col = (i % 3) - 1;
        const bob = Math.sin(ui.now * 9 + i) * 0.8;
        const x = p.x - Math.cos(ang) * row * 9 + Math.cos(ang + Math.PI / 2) * col * 8;
        const y = p.y - Math.sin(ang) * row * 9 + Math.sin(ang + Math.PI / 2) * col * 8 + bob;
        ctx.fillStyle = OWNER_COLOR[c.owner];
        ctx.beginPath();
        ctx.arc(x, y, 4.2, 0, Math.PI * 2);
        ctx.fill();
      }
      // Stance glyph: ▲ assault, ■ hold, » skirmish.
      const glyph = c.stance === 'assault' ? '▲' : c.stance === 'hold' ? '■' : '»';
      this.pill(`${glyph} ${Math.floor(c.troops)}`, p.x, p.y - 22, c.owner);
    }

    // Nodes.
    for (const n of m.nodes) this.drawNode(g, n, ui);

    // Battles: hidden in fog unless you can see them or are fighting in them.
    for (const b of activeBattles(g)) {
      const mine = (sideOf(b, 0)?.troops ?? 0) > 0.5;
      if (!mine && !visible(b.x, b.y)) continue;
      this.drawBattle(g, b, ui);
      if (ui.targeting === 'inspire' && mine) {
        const p = this.markerPos(g, b);
        ctx.strokeStyle = `rgba(255,209,102,${0.5 + 0.5 * Math.sin(ui.now * 10)})`;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 50, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // A stronghold changing hands: a burst ring and a flag raised on the spot.
    for (const e of g.events) {
      if (e.kind !== 'captured' && e.kind !== 'lost') continue;
      if (!visible(e.x, e.y)) continue;
      const age = g.time - e.t;
      if (age > 1.4) continue;
      const col = OWNER_COLOR[e.owner];
      ctx.strokeStyle = col;
      ctx.globalAlpha = 1 - age / 1.4;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(e.x, e.y, 40 + age * 90, 0, Math.PI * 2);
      ctx.stroke();
      const rise = Math.min(1, age / 0.5);
      ctx.strokeStyle = '#eee';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(e.x + 34, e.y - 20);
      ctx.lineTo(e.x + 34, e.y - 20 - 50 * rise);
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.fillRect(e.x + 34, e.y - 20 - 50 * rise, 30, 18);
      ctx.globalAlpha = 1;
    }

    // Event floaters.
    for (const e of g.events) {
      if (e.kind === 'battle' || e.kind === 'qte' || e.kind === 'taunt') continue;
      if (ui.spectate) continue;
      if (!visible(e.x, e.y)) continue;
      const age = g.time - e.t;
      if (age > 3) continue;
      ctx.globalAlpha = 1 - age / 3;
      ctx.fillStyle = e.kind === 'lost' ? '#ff8a8a' : e.owner === 0 ? '#ffd27a' : '#cfe8ff';
      ctx.font = '700 28px "Chakra Petch", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(e.text, e.x, e.y - 100 - age * 14);
      ctx.globalAlpha = 1;
    }
  }

  /** Draw the selection box (screen pixels) on top of everything. */
  drawOverlay(ui: MapUi) {
    if (!ui.box) return;
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const { x0, y0, x1, y1 } = ui.box;
    ctx.fillStyle = 'rgba(226,54,77,0.08)';
    ctx.strokeStyle = 'rgba(255,138,152,0.85)';
    ctx.lineWidth = 1;
    ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
  }

  /** Low-resolution fog mask: dark everywhere except what you can see. */
  private fogLayer(g: Game): HTMLCanvasElement {
    const k = 0.25;
    const c = this.fogCanvas ?? document.createElement('canvas');
    c.width = WORLD_W * k;
    c.height = WORLD_H * k;
    const ctx = c.getContext('2d')!;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = 'rgba(3,4,8,0.62)';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.globalCompositeOperation = 'destination-out';
    const hole = (x: number, y: number, r: number) => {
      const grad = ctx.createRadialGradient(x * k, y * k, r * k * 0.7, x * k, y * k, r * k);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x * k, y * k, r * k, 0, Math.PI * 2);
      ctx.fill();
    };
    for (const n of g.nodes) {
      if (n.owner !== 0) continue;
      const mn = g.map.nodes[n.id];
      hole(mn.x, mn.y, mn.special === 'watchtower' ? VISION_TOWER : VISION_NODE);
    }
    for (const col of g.columns) if (col.owner === 0) hole(columnPos(g, col).x, columnPos(g, col).y, VISION_COLUMN);
    for (const b of activeBattles(g)) if ((sideOf(b, 0)?.troops ?? 0) > 0.5) hole(b.x, b.y, VISION_BATTLE);
    ctx.globalCompositeOperation = 'source-over';
    this.fogCanvas = c;
    return c;
  }

  /** Animated dashed arrow for rally routes. */
  private routeArrow(a: { x: number; y: number }, b: MapNode | { x: number; y: number; kind: string }, now: number, color: string) {
    const { ctx } = this;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const r = 'id' in b ? nodeRadius(b as MapNode) + 10 : 0;
    const end = { x: b.x - Math.cos(ang) * r, y: b.y - Math.sin(ang) * r };
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.setLineDash([3, 9]);
    ctx.lineDashOffset = -now * 30;
    ctx.beginPath();
    ctx.moveTo(a.x + Math.cos(ang) * 44, a.y + Math.sin(ang) * 44);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(end.x - Math.cos(ang - 0.5) * 14, end.y - Math.sin(ang - 0.5) * 14);
    ctx.lineTo(end.x - Math.cos(ang + 0.5) * 14, end.y - Math.sin(ang + 0.5) * 14);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private pill(text: string, x: number, y: number, owner: Owner) {
    const { ctx } = this;
    ctx.font = '700 21px "Chakra Petch", sans-serif';
    const w = ctx.measureText(text).width + 18;
    ctx.fillStyle = 'rgba(8,8,10,0.85)';
    ctx.strokeStyle = OWNER_COLOR[owner];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 15, w, 30, 15);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 1);
    ctx.textBaseline = 'alphabetic';
  }

  private nodeShape(n: MapNode, r: number) {
    const { ctx } = this;
    ctx.beginPath();
    if (n.kind === 'village') {
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      return;
    }
    const sides = n.kind === 'capital' ? 8 : 6;
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2 + (n.kind === 'capital' ? Math.PI / 8 : Math.PI / 6);
      const x = n.x + Math.cos(a) * r;
      const y = n.y + Math.sin(a) * r;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.closePath();
  }

  private drawNode(g: Game, n: MapNode, ui: MapUi) {
    const { ctx } = this;
    const st = g.nodes[n.id];
    const r = nodeRadius(n);
    // Under fog you see your last sighting of nodes out of view, dimmed and marked "?".
    const known = knownNode(g, 0, n.id);
    const own = known.owner;
    if (!known.live) ctx.globalAlpha = 0.62;
    // Glow.
    const glow = ctx.createRadialGradient(n.x, n.y, r * 0.6, n.x, n.y, r * 1.9);
    glow.addColorStop(0, OWNER_COLOR[own] + '55');
    glow.addColorStop(1, OWNER_COLOR[own] + '00');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r * 1.9, 0, Math.PI * 2);
    ctx.fill();
    // Body.
    this.nodeShape(n, r);
    ctx.fillStyle = OWNER_DARK[own];
    ctx.fill();
    ctx.lineWidth = ui.hover === n.id ? 5 : 3.5;
    ctx.strokeStyle = ui.hover === n.id ? OWNER_LIGHT[own] : OWNER_COLOR[own];
    ctx.stroke();
    // Garrison fill arc against the cap.
    const cap = NODE_STATS[n.kind].cap;
    ctx.strokeStyle = OWNER_LIGHT[own] + 'aa';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r + 7, -Math.PI / 2, -Math.PI / 2 + Math.min(1, st.troops / cap) * Math.PI * 2);
    ctx.stroke();
    // Kind icon above the number.
    this.kindIcon(n, OWNER_LIGHT[own]);
    // Garrison number.
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${n.kind === 'capital' ? 32 : 28}px "Chakra Petch", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = !known.live ? `${Math.floor(known.troops)}?` : st.battleId !== null ? '⚔' : String(Math.floor(st.troops));
    ctx.fillText(label, n.x, n.y + 6);
    ctx.textBaseline = 'alphabetic';
    // Name.
    ctx.font = '700 20px "Chakra Petch", sans-serif';
    ctx.fillStyle = 'rgba(241,230,232,0.82)';
    ctx.fillText(n.name.toUpperCase(), n.x, n.y + r + 30);
    ctx.globalAlpha = 1;
    // Special stronghold badge.
    if (n.special) {
      const bx = n.x + r * 0.78;
      const by = n.y + r * 0.62;
      ctx.fillStyle = '#1a1408';
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(bx, by, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffd166';
      ctx.font = '700 16px "Chakra Petch", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(SPECIALS[n.special].glyph, bx, by + 1);
      ctx.textBaseline = 'alphabetic';
    }
    // Selected for multi-send.
    if (ui.selected.has(n.id)) {
      ctx.save();
      ctx.setLineDash([6, 6]);
      ctx.lineDashOffset = -ui.now * 20;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 15, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  private kindIcon(n: MapNode, color: string) {
    const { ctx } = this;
    const x = n.x;
    const y = n.y - (n.kind === 'capital' ? 22 : 18);
    ctx.fillStyle = color;
    ctx.beginPath();
    if (n.kind === 'capital') {
      // Crown.
      ctx.moveTo(x - 10, y + 4);
      ctx.lineTo(x - 10, y - 4);
      ctx.lineTo(x - 5, y);
      ctx.lineTo(x, y - 6);
      ctx.lineTo(x + 5, y);
      ctx.lineTo(x + 10, y - 4);
      ctx.lineTo(x + 10, y + 4);
    } else if (n.kind === 'fort') {
      // Tower with battlements.
      ctx.moveTo(x - 8, y + 5);
      ctx.lineTo(x - 8, y - 5);
      ctx.lineTo(x - 5, y - 5);
      ctx.lineTo(x - 5, y - 2);
      ctx.lineTo(x - 1.5, y - 2);
      ctx.lineTo(x - 1.5, y - 5);
      ctx.lineTo(x + 1.5, y - 5);
      ctx.lineTo(x + 1.5, y - 2);
      ctx.lineTo(x + 5, y - 2);
      ctx.lineTo(x + 5, y - 5);
      ctx.lineTo(x + 8, y - 5);
      ctx.lineTo(x + 8, y + 5);
    } else {
      // House.
      ctx.moveTo(x - 8, y + 5);
      ctx.lineTo(x - 8, y - 1);
      ctx.lineTo(x, y - 7);
      ctx.lineTo(x + 8, y - 1);
      ctx.lineTo(x + 8, y + 5);
    }
    ctx.closePath();
    ctx.fill();
  }

  private drawBattle(g: Game, b: Battle, ui: MapUi) {
    const { ctx } = this;
    const p = this.markerPos(g, b);
    const total = b.sides.reduce((t, s) => t + Math.max(0, s.troops), 0) || 1;
    // Battles you are losing pulse fast and red.
    const mine = Math.max(0, sideOf(b, 0)?.troops ?? 0);
    const losing = mine > 0.5 && mine / total < 0.4;
    const pulse = 1 + (losing ? 0.14 : 0.08) * Math.sin(ui.now * (losing ? 12 : 6) + b.id);
    const R = 32 * pulse;
    const halo = ctx.createRadialGradient(p.x, p.y, R * 0.8, p.x, p.y, R * 2.2);
    halo.addColorStop(0, losing ? 'rgba(255,60,70,0.55)' : 'rgba(255,200,150,0.35)');
    halo.addColorStop(1, losing ? 'rgba(255,60,70,0)' : 'rgba(255,200,150,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(p.x, p.y, R * 2, 0, Math.PI * 2);
    ctx.fill();
    // Ring split by side strength.
    let a0 = -Math.PI / 2;
    for (const s of b.sides) {
      const frac = Math.max(0, s.troops) / total;
      ctx.strokeStyle = OWNER_COLOR[s.owner];
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(p.x, p.y, R, a0, a0 + frac * Math.PI * 2);
      ctx.stroke();
      a0 += frac * Math.PI * 2;
    }
    ctx.fillStyle = 'rgba(10,8,10,0.92)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, R - 4, 0, Math.PI * 2);
    ctx.fill();
    // Crossed swords.
    ctx.strokeStyle = '#ffe1c2';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(p.x - 12, p.y + 12);
    ctx.lineTo(p.x + 12, p.y - 12);
    ctx.moveTo(p.x + 12, p.y + 12);
    ctx.lineTo(p.x - 12, p.y - 12);
    ctx.stroke();
    // Side counts.
    const parts = b.sides.filter((s) => s.troops > 0.5);
    // Counts sit beside the marker: yours on the left, the others on the right.
    const order = [...parts].sort((a, b2) => (a.owner === 0 ? -1 : b2.owner === 0 ? 1 : 0));
    order.forEach((s, i) => this.pill(String(Math.ceil(s.troops)), p.x + (i === 0 ? -1 : 1) * (R + 34) + (i > 1 ? 56 : 0), p.y, s.owner));
    // Commanders present.
    if (g.presence[0] === b.id) this.flag(p.x - 6, p.y - R - 10, 0, ui.spectate && ui.names ? ui.names[0].toUpperCase() : 'YOU');
    if (g.presence[1] === b.id && canSee(g, 0, b.x, b.y)) this.flag(p.x + 6, p.y - R - 10, 1, ui.spectate && ui.names ? ui.names[1].toUpperCase() : inDuel(g, b) ? 'DUEL!' : 'ENEMY CMDR');
  }

  private flag(x: number, y: number, owner: Owner, text: string) {
    const { ctx } = this;
    ctx.strokeStyle = '#ddd';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y + 24);
    ctx.lineTo(x, y - 20);
    ctx.stroke();
    ctx.font = '700 17px "Chakra Petch", sans-serif';
    const w = ctx.measureText(text).width + 16;
    const dir = owner === 0 ? -1 : 1;
    ctx.fillStyle = OWNER_COLOR[owner];
    ctx.beginPath();
    ctx.moveTo(x, y - 20);
    ctx.lineTo(x + dir * w, y - 20);
    ctx.lineTo(x + dir * (w - 8), y - 8);
    ctx.lineTo(x + dir * w, y + 4);
    ctx.lineTo(x, y + 4);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = owner === 0 ? 'right' : 'left';
    ctx.fillText(text, x + dir * 6, y - 2);
  }
}
