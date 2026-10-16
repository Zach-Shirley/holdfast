import './style.css';
import { aiStep, createAi, type AiState, type Difficulty } from './ai';
import { PRESETS, generateMap, type GameMap, type Pt } from './map';
import { findCellPath } from './path';
import { Renderer, renderTerrain, type Badge } from './render';
import { MinigameHost, type MgKind } from './minigames';
import {
  CAPTURE_TIME,
  applyRally,
  applyStrike,
  beginMinigame,
  canRally,
  canStrike,
  createGame,
  getUnit,
  orderMove,
  step,
  stopUnits,
  type Composition,
  type Game,
} from './sim';

const STEP = 1 / 30;

interface Settings {
  preset: string;
  seed: number;
  armySize: number;
  composition: Composition;
  difficulty: Difficulty;
  fog: 'on' | 'off';
}

const settings: Settings = { preset: 'passes', seed: randomSeed(), armySize: 20, composition: 'mixed', difficulty: 'normal', fog: 'on' };

function randomSeed() {
  return Math.floor(Math.random() * 99999) + 1;
}

const finder = (m: GameMap, a: Pt, b: Pt) => findCellPath(m, a, b);

const app = document.getElementById('app')!;
app.innerHTML = `
  <canvas id="map"></canvas>
  <header class="hud-top hidden">
    <div class="brand">HOLDFAST</div>
    <div class="forces">
      <div class="force you"><span class="lbl">You</span><span class="count" id="c0"></span><div class="bar"><div id="b0"></div></div></div>
      <div class="vs">vs</div>
      <div class="force foe"><div class="bar"><div id="b1"></div></div><span class="count" id="c1"></span><span class="lbl">AI</span></div>
    </div>
    <div class="right">
      <span class="clock" id="clock">0:00</span>
      <button id="btn-supply" title="Show your supply area (V)">Supply</button>
      <button id="btn-pause" title="Pause (P)">Pause</button>
      <button id="btn-help" title="Controls (H)">?</button>
    </div>
  </header>
  <div class="alert hidden" id="alert"></div>
  <div class="sel hidden" id="sel"></div>
  <div id="mg" class="mg hidden"></div>
  <div class="toasts" id="toasts"></div>

  <section class="overlay" id="setup">
    <div class="panel setup">
      <div class="title">HOLDFAST</div>
      <p class="sub">Hold your stronghold. Take theirs. Boost your troops with quick mini-games while the war keeps moving, so never stare at one fight for too long.</p>
      <div class="setup-grid">
        <div>
          <h3>Map</h3>
          <div class="presets" id="presets"></div>
          <div class="seed-row">
            <label>Seed <input id="seed" type="number" min="1" max="99999" /></label>
            <button id="reroll" title="New random seed">New map</button>
          </div>
        </div>
        <div class="preview-wrap"><canvas id="preview"></canvas></div>
      </div>
      <div class="opts">
        <div class="opt"><h3>Army</h3><div class="seg" data-key="composition">
          <button data-v="mixed">Mixed</button><button data-v="melee">All melee</button><button data-v="ranged">All ranged</button></div></div>
        <div class="opt"><h3>Size</h3><div class="seg" data-key="armySize">
          <button data-v="12">12</button><button data-v="20">20</button><button data-v="28">28</button></div></div>
        <div class="opt"><h3>AI</h3><div class="seg" data-key="difficulty">
          <button data-v="easy">Easy</button><button data-v="normal">Normal</button><button data-v="hard">Hard</button></div></div>
        <div class="opt"><h3>Fog of war</h3><div class="seg" data-key="fog">
          <button data-v="on">On</button><button data-v="off">Off</button></div></div>
      </div>
      <div class="actions"><button class="primary" id="start">Start battle</button><button id="setup-help">How to play</button></div>
    </div>
  </section>

  <section class="overlay hidden" id="help">
    <div class="panel help">
      <h2>How to play</h2>
      <div class="help-grid">
        <div>
          <h3>Goal</h3>
          <p>Stand in the enemy stronghold ring with no defenders inside for ${CAPTURE_TIME} seconds, or wipe out their army.</p>
          <h3>Commands</h3>
          <ul>
            <li><b>Left-click / drag</b> select units (Shift adds)</li>
            <li><b>Right-click</b> move in formation</li>
            <li><b>A</b> select all · <b>X</b> stop</li>
            <li><b>Ctrl+1–9</b> save group · <b>1–9</b> recall</li>
            <li><b>Wheel</b> zoom · <b>Middle-drag / arrows</b> pan · <b>C</b> recenter</li>
            <li><b>V</b> supply view · <b>P</b> pause</li>
          </ul>
        </div>
        <div>
          <h3>Mini-game boosts</h3>
          <p><span class="ic strike"></span><b>Strike</b> (units in combat): click while the needle is in the zone. +35% damage, or +70% on the bright centre, for 8s.</p>
          <p><span class="ic rally"></span><b>Rally</b> (wounded units): click the three pulses before they fade. +10% health each.</p>
          <p>Click the badge above a unit to start one (or Q / E for the selected unit that needs it most). The mini-game covers the battlefield and the battle does <i>not</i> pause: while you play it, you are not watching your army.</p>
          <h3>Fighting</h3>
          <p>Several units on one target hit much harder (flanking). Units slow down near enemies, so gaps are hard to slip through. Every unit needs a clear line back to your stronghold. A unit that is <b>cut off</b> gets a yellow clock: reconnect within 20 seconds or it dies. Forests and hills protect. With fog of war on, you only see near your own units.</p>
        </div>
      </div>
      <div class="actions"><button class="primary" id="help-close">Got it</button></div>
    </div>
  </section>

  <section class="overlay hidden" id="end">
    <div class="panel end">
      <div class="title" id="end-title"></div>
      <p class="sub" id="end-reason"></p>
      <table class="stats" id="end-stats"></table>
      <div class="actions"><button class="primary" id="rematch">Rematch (same map)</button><button id="newgame">New battle</button></div>
    </div>
  </section>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('map');
const renderer = new Renderer(canvas);
const mg = new MinigameHost($('mg'));

let game: Game | null = null;
let ai: AiState | null = null;
let map: GameMap | null = null;
let paused = false;
let showSupply = false;
let acc = 0;
let now = 0;
let endShownAt = -1;
let activeUnit: number | null = null;
let badges: Badge[] = [];
const selected = new Set<number>();
const groups = new Map<string, number[]>();
const marks: { x: number; y: number; t: number }[] = [];
let lastToast = new Map<string, number>();

// ---------- Setup screen ----------

function buildSetup() {
  const presets = $('presets');
  presets.innerHTML = PRESETS.map((p) => `<button data-id="${p.id}"><b>${p.name}</b><span>${p.desc}</span></button>`).join('');
  presets.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      settings.preset = b.dataset.id!;
      refreshSetup();
    }),
  );
  document.querySelectorAll<HTMLElement>('.seg').forEach((seg) => {
    seg.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
      b.addEventListener('click', () => {
        const key = seg.dataset.key as keyof Settings;
        const v = b.dataset.v!;
        (settings as unknown as Record<string, unknown>)[key] = key === 'armySize' ? Number(v) : v;
        refreshSetup(false);
      }),
    );
  });
  const seed = $<HTMLInputElement>('seed');
  seed.addEventListener('change', () => {
    settings.seed = Math.max(1, Math.min(99999, Number(seed.value) || 1));
    refreshSetup();
  });
  $('reroll').addEventListener('click', () => {
    settings.seed = randomSeed();
    refreshSetup();
  });
  $('start').addEventListener('click', () => startGame());
  $('setup-help').addEventListener('click', () => $('help').classList.remove('hidden'));
  refreshSetup();
}

function refreshSetup(regen = true) {
  document.querySelectorAll<HTMLElement>('#presets button').forEach((b) => b.classList.toggle('on', b.dataset.id === settings.preset));
  document.querySelectorAll<HTMLElement>('.seg').forEach((seg) => {
    const v = String((settings as unknown as Record<string, unknown>)[seg.dataset.key!]);
    seg.querySelectorAll<HTMLElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  });
  $<HTMLInputElement>('seed').value = String(settings.seed);
  if (!regen && map) return;
  map = generateMap(settings.seed, settings.preset, finder);
  const pv = $<HTMLCanvasElement>('preview');
  const tex = renderTerrain(map);
  pv.width = tex.width;
  pv.height = tex.height;
  const ctx = pv.getContext('2d')!;
  ctx.drawImage(tex, 0, 0);
  for (const [i, c] of ['#e2364d', '#4aa3d8'].entries()) {
    const h = map.hq[i];
    ctx.fillStyle = c;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(h.x * 6, h.y * 6, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

// ---------- Game lifecycle ----------

function startGame() {
  if (!map) map = generateMap(settings.seed, settings.preset, finder);
  game = createGame(map, { armySize: settings.armySize, composition: settings.composition, fog: settings.fog === 'on' });
  ai = createAi(game, 1, settings.difficulty, settings.seed);
  renderer.setMap(map);
  onResize();
  selected.clear();
  groups.clear();
  lastToast = new Map();
  paused = false;
  acc = 0;
  endShownAt = -1;
  activeUnit = null;
  $('setup').classList.add('hidden');
  $('end').classList.add('hidden');
  document.querySelector('.hud-top')!.classList.remove('hidden');
  $('btn-pause').textContent = 'Pause';
}

function showEnd() {
  if (!game) return;
  const won = game.winner === 0;
  $('end-title').textContent = won ? 'VICTORY' : 'DEFEAT';
  $('end-title').className = `title ${won ? 'win' : 'loss'}`;
  const t = Math.floor(game.time);
  $('end-reason').textContent = `${game.winReason} after ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}.`;
  const [a, b] = game.stats;
  const row = (label: string, x: string | number, y: string | number) => `<tr><td>${label}</td><td>${x}</td><td>${y}</td></tr>`;
  $('end-stats').innerHTML =
    `<tr><th></th><th>You</th><th>AI</th></tr>` +
    row('Mini-games played', a.minigames, b.minigames) +
    row('Perfect / good / miss', `${a.perfect} / ${a.good} / ${a.miss}`, `${b.perfect} / ${b.good} / ${b.miss}`) +
    row('Health rallied', Math.round(a.healed), Math.round(b.healed)) +
    row('Units lost', a.lost, b.lost);
  $('end').classList.remove('hidden');
}

// ---------- Mini-games ----------

function launchMinigame(unitId: number, kind: MgKind) {
  if (!game || mg.busy || paused || game.winner !== null) return;
  const u = getUnit(game, unitId);
  if (!u || u.team !== 0) return;
  if (kind === 'strike' ? !canStrike(game, u) : !canRally(game, u)) return;
  beginMinigame(game, u, kind);
  activeUnit = u.id;
  const label = `${u.kind === 'melee' ? 'Melee' : 'Ranged'} #${u.id}`;
  mg.open(kind, label, (r) => {
    activeUnit = null;
    if (!game) return;
    const target = getUnit(game, unitId);
    if (!target) {
      game.stats[0].minigames++;
      return;
    }
    if (r.kind === 'strike') applyStrike(game, target, r.quality);
    else applyRally(game, target, r.fraction);
  });
}

/** Hotkey: boost the selected unit that needs it most. */
function hotkeyMinigame(kind: MgKind) {
  if (!game) return;
  const pool = [...selected].map((id) => getUnit(game!, id)).filter((u) => u && (kind === 'strike' ? canStrike(game!, u) : canRally(game!, u)));
  if (!pool.length) {
    toast(kind === 'strike' ? 'No selected unit is in combat with Strike ready' : 'No selected unit needs a Rally', 'nokey');
    return;
  }
  pool.sort((a, b) => a!.hp / a!.maxHp - b!.hp / b!.maxHp);
  launchMinigame(pool[0]!.id, kind);
}

// ---------- Input ----------

let drag: { x0: number; y0: number; x1: number; y1: number; button: number; moved: boolean } | null = null;

function unitAt(sx: number, sy: number) {
  if (!game) return null;
  const r = Math.max(8, renderer.scale * 0.95);
  let best = null;
  let bd = Infinity;
  for (const u of game.units) {
    if (!u.alive || u.team !== 0) continue;
    const p = renderer.w2s(u);
    const d = Math.hypot(p.x - sx, p.y - sy);
    if (d < r && d < bd) {
      bd = d;
      best = u;
    }
  }
  return best;
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
  if (!game) return;
  const x = e.offsetX;
  const y = e.offsetY;
  if (e.button === 0) {
    const b = badges.find((b) => Math.hypot(b.x - x, b.y - y) <= b.r + 6);
    if (b) {
      launchMinigame(b.unitId, b.kind);
      return;
    }
  }
  if (e.button === 2 && selected.size && game.winner === null) {
    const w = renderer.s2w(x, y);
    orderMove(game, [...selected], w);
    marks.push({ x: w.x, y: w.y, t: now });
    return;
  }
  drag = { x0: x, y0: y, x1: x, y1: y, button: e.button, moved: false };
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  if (drag.button === 1) {
    renderer.pan(x - drag.x1, y - drag.y1);
  }
  drag.x1 = x;
  drag.y1 = y;
  if (Math.hypot(drag.x1 - drag.x0, drag.y1 - drag.y0) > 5) drag.moved = true;
});
window.addEventListener('mouseup', (e) => {
  if (!drag || !game) {
    drag = null;
    return;
  }
  if (drag.button === 0) {
    if (!e.shiftKey) selected.clear();
    if (drag.moved) {
      const x0 = Math.min(drag.x0, drag.x1);
      const x1 = Math.max(drag.x0, drag.x1);
      const y0 = Math.min(drag.y0, drag.y1);
      const y1 = Math.max(drag.y0, drag.y1);
      for (const u of game.units) {
        if (!u.alive || u.team !== 0) continue;
        const p = renderer.w2s(u);
        if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) selected.add(u.id);
      }
    } else {
      const u = unitAt(drag.x0, drag.y0);
      if (u) {
        if (e.shiftKey && selected.has(u.id)) selected.delete(u.id);
        else selected.add(u.id);
      }
    }
  }
  drag = null;
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    renderer.zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  },
  { passive: false },
);

const panKeys = new Set<string>();
window.addEventListener('keydown', (e) => {
  if (!game || !$('setup').classList.contains('hidden')) return;
  if (mg.key(e)) {
    e.preventDefault();
    return;
  }
  const k = e.key.toLowerCase();
  if (e.key.startsWith('Arrow')) {
    panKeys.add(e.key);
    e.preventDefault();
    return;
  }
  if (/^[1-9]$/.test(e.key)) {
    if (e.ctrlKey || e.metaKey) {
      groups.set(e.key, [...selected]);
      toast(`Group ${e.key} saved (${selected.size})`, 'grp');
    } else {
      selected.clear();
      for (const id of groups.get(e.key) ?? []) if (getUnit(game, id)) selected.add(id);
    }
    e.preventDefault();
    return;
  }
  if (k === 'a' && !e.ctrlKey) {
    selected.clear();
    for (const u of game.units) if (u.alive && u.team === 0) selected.add(u.id);
  } else if (k === 'x') stopUnits(game, [...selected]);
  else if (k === 'q') hotkeyMinigame('strike');
  else if (k === 'e') hotkeyMinigame('rally');
  else if (k === 'v') toggleSupply();
  else if (k === 'c') renderer.fit();
  else if (k === 'p' || e.key === 'Escape') togglePause();
  else if (k === 'h' || e.key === '?') $('help').classList.toggle('hidden');
});
window.addEventListener('keyup', (e) => panKeys.delete(e.key));

function togglePause() {
  if (!game || game.winner !== null) return;
  paused = !paused;
  $('btn-pause').textContent = paused ? 'Resume' : 'Pause';
}

function toggleSupply() {
  showSupply = !showSupply;
  $('btn-supply').classList.toggle('on', showSupply);
}

$('btn-pause').addEventListener('click', togglePause);
$('btn-supply').addEventListener('click', toggleSupply);
$('btn-help').addEventListener('click', () => $('help').classList.toggle('hidden'));
$('help-close').addEventListener('click', () => $('help').classList.add('hidden'));
$('rematch').addEventListener('click', () => startGame());
$('newgame').addEventListener('click', () => {
  $('end').classList.add('hidden');
  document.querySelector('.hud-top')!.classList.add('hidden');
  game = null;
  settings.seed = randomSeed();
  refreshSetup();
  $('setup').classList.remove('hidden');
});

// ---------- HUD ----------

function toast(text: string, key: string, cooldown = 4) {
  const last = lastToast.get(key) ?? -99;
  if (now - last < cooldown) return;
  lastToast.set(key, now);
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function updateHud(g: Game) {
  for (const team of [0, 1] as const) {
    const us = g.units.filter((u) => u.alive && u.team === team);
    const total = g.units.filter((u) => u.team === team).reduce((s, u) => s + u.maxHp, 0);
    const hp = us.reduce((s, u) => s + u.hp, 0);
    $(`c${team}`).textContent = String(us.length);
    $(`b${team}`).style.width = `${(100 * hp) / total}%`;
  }
  const t = Math.floor(g.time);
  $('clock').textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  const alert = $('alert');
  if (g.capture[0] > 0) {
    alert.textContent = `Your stronghold is being captured: ${Math.ceil(CAPTURE_TIME - g.capture[0])}s`;
    alert.className = 'alert danger';
  } else if (g.capture[1] > 0) {
    alert.textContent = `Capturing enemy stronghold: ${Math.ceil(CAPTURE_TIME - g.capture[1])}s`;
    alert.className = 'alert good';
  } else if (paused) {
    alert.textContent = 'Paused';
    alert.className = 'alert';
  } else alert.className = 'alert hidden';
  for (const e of g.events) {
    if (e.kind === 'cut' && e.team === 0 && g.time - e.t < 0.05) toast('A unit is cut off: 20 seconds to reconnect it', 'cut', 6);
  }
  const sel = $('sel');
  const us = [...selected].map((id) => getUnit(g, id)).filter((u) => !!u);
  if (!us.length) {
    sel.className = 'sel hidden';
  } else {
    const melee = us.filter((u) => u!.kind === 'melee').length;
    const hpF = us.reduce((s, u) => s + u!.hp / u!.maxHp, 0) / us.length;
    const cut = us.filter((u) => !u!.supplied).length;
    sel.className = 'sel';
    sel.innerHTML = `<b>${us.length} selected</b> · ${melee} melee · ${us.length - melee} ranged · ${Math.round(hpF * 100)}% health${cut ? ` · <span class="warn">${cut} cut off</span>` : ''}`;
  }
}

// ---------- Main loop ----------

function onResize() {
  renderer.resize(window.innerWidth, window.innerHeight);
  if (game) renderer.fit();
}
window.addEventListener('resize', onResize);

let last = performance.now();
function frame(t: number) {
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  tick(dt);
  requestAnimationFrame(frame);
}

function tick(dt: number) {
  now += dt;
  if (game && ai) {
    if (!paused && game.winner === null) {
      acc += dt;
      while (acc >= STEP) {
        aiStep(game, ai, STEP);
        step(game, STEP);
        acc -= STEP;
      }
      mg.update(dt);
    } else if (!paused) mg.update(dt);
    for (const id of [...selected]) if (!getUnit(game, id)) selected.delete(id);
    const pan = 600 * dt;
    if (panKeys.has('ArrowLeft')) renderer.pan(pan, 0);
    if (panKeys.has('ArrowRight')) renderer.pan(-pan, 0);
    if (panKeys.has('ArrowUp')) renderer.pan(0, pan);
    if (panKeys.has('ArrowDown')) renderer.pan(0, -pan);
    while (marks.length && now - marks[0].t > 1) marks.shift();
    badges = renderer.draw(game, {
      selected,
      box: drag && drag.button === 0 && drag.moved ? drag : null,
      showSupply,
      activeUnit,
      marks,
      now,
    });
    updateHud(game);
    if (game.winner !== null) {
      if (endShownAt < 0) endShownAt = now;
      if (now - endShownAt > 1.4 && $('end').classList.contains('hidden')) showEnd();
    }
  }
}

buildSetup();
onResize();
requestAnimationFrame(frame);

// Exposed for automated browser checks only.
// advance(seconds) steps and draws without requestAnimationFrame, which stops in hidden tabs.
(window as unknown as { __holdfast: unknown }).__holdfast = {
  get game() {
    return game;
  },
  get badges() {
    return badges;
  },
  renderer,
  mg,
  settings,
  launchMinigame,
  advance(seconds: number) {
    for (let s = 0; s < seconds; s += 0.05) tick(0.05);
    tick(0);
  },
};
