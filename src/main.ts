import './style.css';
import { aiStep, createAi, type AiState, type Difficulty } from './ai';
import { BattleView } from './battleview';
import { NODE_STATS, WORLD_H, WORLD_W, generateMap, type GraphMap } from './map';
import { MapRenderer, OWNER_COLOR, nodeRadius, paintBackground } from './render';
import { MATCH_TIME, activeBattles, applyQte, battleName, createGame, getBattle, sendTroops, sideOf, step, type Game } from './sim';

const STEP = 1 / 20;

interface Settings {
  nodes: number;
  difficulty: Difficulty;
  seed: number;
}
const settings: Settings = { nodes: 8, difficulty: 'normal', seed: randomSeed() };
let ratio = 0.5;

function randomSeed() {
  return Math.floor(Math.random() * 99999) + 1;
}

const app = document.getElementById('app')!;
app.innerHTML = `
  <canvas id="map"></canvas>
  <header class="hud-top hidden">
    <div class="brand">HOLDFAST</div>
    <div class="forces">
      <div class="force you"><span class="lbl">You</span><span class="count" id="t0"></span><span class="nodes" id="n0"></span></div>
      <div class="power"><div id="p0"></div></div>
      <div class="force foe"><span class="nodes" id="n1"></span><span class="count" id="t1"></span><span class="lbl">Enemy</span></div>
    </div>
    <div class="right">
      <span class="clock" id="clock">0:00</span>
      <button id="btn-pause">Pause</button>
      <button id="btn-help">?</button>
    </div>
  </header>
  <div class="dock hidden" id="dock">
    <span class="dock-lbl">Send</span>
    <div class="seg" id="ratio">
      <button data-r="0.25">25%</button><button data-r="0.5">50%</button><button data-r="0.75">75%</button><button data-r="1">All</button>
    </div>
    <div class="battles" id="battle-list"></div>
  </div>
  <div class="tip hidden" id="tip"></div>
  <div class="toasts" id="toasts"></div>
  <div class="paused hidden" id="paused">Paused</div>
  <section id="bv" class="bv hidden"></section>

  <section class="overlay" id="setup">
    <div class="panel setup">
      <div class="title">HOLDFAST</div>
      <p class="sub">A real-time war over a handful of strongholds. Send columns down the roads. When armies meet, a battle starts, and you can only fight in one of them at a time.</p>
      <div class="setup-grid">
        <div>
          <h3>Strongholds</h3>
          <div class="seg" data-key="nodes">${[6, 7, 8, 9, 10].map((n) => `<button data-v="${n}">${n}</button>`).join('')}</div>
          <h3 class="gap">Enemy</h3>
          <div class="seg" data-key="difficulty"><button data-v="easy">Easy</button><button data-v="normal">Normal</button><button data-v="hard">Hard</button></div>
          <h3 class="gap">Map</h3>
          <div class="seed-row"><label>Seed <input id="seed" type="number" min="1" max="99999" /></label><button id="reroll">New map</button></div>
        </div>
        <div class="preview-wrap"><canvas id="preview"></canvas></div>
      </div>
      <div class="actions"><button class="primary" id="start">Start war</button><button id="training">Training: learn the quick-time events</button><button id="setup-help">How to play</button></div>
    </div>
  </section>

  <section class="overlay hidden" id="help">
    <div class="panel help">
      <h2>How to play</h2>
      <div class="help-grid">
        <div>
          <h3>The war</h3>
          <p>Take the enemy <b>capital</b> to win. Every stronghold you hold grows troops: capitals fast, villages steadily, forts slowly but with strong walls.</p>
          <p><b>Drag</b> from one of your strongholds to any other to send a column down the roads (the dock sets how much). Columns that meet on a road fight there.</p>
          <p>Defenders fight from their walls: forts ×1.4, capitals ×1.5. Troops over a stronghold's limit slowly desert.</p>
          <p>The war clock runs 12 minutes. If no capital falls, whoever holds more strongholds wins.</p>
          <h3>Battles</h3>
          <p>Click a battle (the crossed swords) to <b>enter it</b>. Left alone, numbers decide it. Inside, quick-time events swing the fight, but the map is hidden and the war goes on without you.</p>
          <p>The enemy has a commander too, and it can only be in one battle. Its flag shows where it is: strike somewhere else.</p>
        </div>
        <div>
          <h3>Quick-time events (mouse only)</h3>
          <p><span class="ic volley"></span><b>Volley</b>: click the target when the closing ring meets it. Kills enemy troops.</p>
          <p><span class="ic parry"></span><b>Parry</b>: click the incoming spear before it reaches your shield. Miss and you lose troops.</p>
          <p><span class="ic slash"></span><b>Slash</b>: press on the filled mark and drag to the ring along the line. Boosts momentum.</p>
          <p><span class="ic banner"></span><b>Banner</b>: hold the mouse on the moving banner until the ring fills. Kills and boosts.</p>
          <p>New to them? Use <b>Training</b> on the start screen to watch a demo of each and practise.</p>
          <p>Leave a battle with <b>Esc</b>, <b>right-click</b> or the button, or jump straight to another battle from the list on the right.</p>
          <p class="muted">Optional keys: 1–4 send ratio, P pause.</p>
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
      <div class="actions"><button class="primary" id="rematch">Rematch (same map)</button><button id="newgame">New war</button></div>
    </div>
  </section>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('map');
const renderer = new MapRenderer(canvas);

let game: Game | null = null;
let ai: AiState | null = null;
let map: GraphMap | null = null;
let paused = false;
let acc = 0;
let now = 0;
let endShownAt = -1;
let hover: number | null = null;
let drag: { from: number; x: number; y: number; target: number | null; amount: number } | null = null;
const seenEvents = new Set<string>();

const bv = new BattleView($('bv'), {
  onQte: (battleId, kind, success) => (game ? applyQte(game, battleId, 0, kind, success) : ''),
  onLeave: () => leaveBattle(),
  onSwitch: (id) => enterBattle(id),
  onPracticeExit: () => $("setup").classList.remove("hidden"),
});

// ---------- Setup ----------

function buildSetup() {
  document.querySelectorAll<HTMLElement>('#setup .seg').forEach((seg) =>
    seg.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
      b.addEventListener('click', () => {
        const key = seg.dataset.key as keyof Settings;
        (settings as unknown as Record<string, unknown>)[key] = key === 'nodes' ? Number(b.dataset.v) : b.dataset.v;
        refreshSetup(key === 'nodes');
      }),
    ),
  );
  const seed = $<HTMLInputElement>('seed');
  seed.addEventListener('change', () => {
    settings.seed = Math.max(1, Math.min(99999, Number(seed.value) || 1));
    refreshSetup(true);
  });
  $('reroll').addEventListener('click', () => {
    settings.seed = randomSeed();
    refreshSetup(true);
  });
  $('start').addEventListener('click', startGame);
  $('setup-help').addEventListener('click', () => $('help').classList.remove('hidden'));
  $('training').addEventListener('click', () => {
    $('setup').classList.add('hidden');
    bv.showPractice('volley', true);
  });
  refreshSetup(true);
}

function refreshSetup(regen: boolean) {
  document.querySelectorAll<HTMLElement>('#setup .seg').forEach((seg) => {
    const v = String((settings as unknown as Record<string, unknown>)[seg.dataset.key!]);
    seg.querySelectorAll<HTMLElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  });
  $<HTMLInputElement>('seed').value = String(settings.seed);
  if (!regen && map) return;
  map = generateMap(settings.seed, settings.nodes);
  drawPreview(map);
}

function drawPreview(m: GraphMap) {
  const pv = $<HTMLCanvasElement>('preview');
  const S = 0.4;
  pv.width = WORLD_W * S;
  pv.height = WORLD_H * S;
  const ctx = pv.getContext('2d')!;
  ctx.drawImage(paintBackground(m), 0, 0, pv.width, pv.height);
  ctx.scale(S, S);
  ctx.strokeStyle = '#4a3f36';
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  for (const e of m.edges) {
    ctx.beginPath();
    ctx.moveTo(m.nodes[e.a].x, m.nodes[e.a].y);
    ctx.lineTo(m.nodes[e.b].x, m.nodes[e.b].y);
    ctx.stroke();
  }
  for (const n of m.nodes) {
    const owner = n.id === m.capitals[0] ? 0 : n.id === m.capitals[1] ? 1 : 2;
    ctx.fillStyle = '#141114';
    ctx.strokeStyle = OWNER_COLOR[owner];
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(n.x, n.y, nodeRadius(n), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ddd';
    ctx.font = '700 30px "Chakra Petch", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(n.kind === 'capital' ? '♛' : n.kind === 'fort' ? '▲' : '●', n.x, n.y);
  }
}

// ---------- Lifecycle ----------

function startGame() {
  if (!map) map = generateMap(settings.seed, settings.nodes);
  game = createGame(map);
  ai = createAi(1, settings.difficulty, settings.seed);
  renderer.setMap(map);
  onResize();
  paused = false;
  acc = 0;
  endShownAt = -1;
  drag = null;
  seenEvents.clear();
  bv.hide();
  $('setup').classList.add('hidden');
  $('end').classList.add('hidden');
  $('paused').classList.add('hidden');
  document.querySelector('.hud-top')!.classList.remove('hidden');
  $('dock').classList.remove('hidden');
}

function showEnd() {
  if (!game) return;
  bv.hide();
  game.presence[0] = null;
  const won = game.winner === 0;
  $('end-title').textContent = won ? 'VICTORY' : 'DEFEAT';
  $('end-title').className = `title ${won ? 'win' : 'loss'}`;
  const t = Math.floor(game.time);
  $('end-reason').textContent = `${game.winReason} after ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}.`;
  const [a, b] = game.stats;
  const pct = (h: number, p: number) => (p ? `${Math.round((100 * h) / p)}%` : '–');
  const row = (l: string, x: string | number, y: string | number) => `<tr><td>${l}</td><td>${x}</td><td>${y}</td></tr>`;
  $('end-stats').innerHTML =
    '<tr><th></th><th>You</th><th>Enemy</th></tr>' +
    row('Battles fought / won', `${a.battlesFought} / ${a.battlesWon}`, `${b.battlesFought} / ${b.battlesWon}`) +
    row('Quick-time events', `${a.qteHit} / ${a.qtePlayed} (${pct(a.qteHit, a.qtePlayed)})`, `${b.qteHit} / ${b.qtePlayed} (${pct(b.qteHit, b.qtePlayed)})`) +
    row('Strongholds taken', a.nodesTaken, b.nodesTaken) +
    row('Troops sent', a.troopsSent, b.troopsSent);
  $('end').classList.remove('hidden');
}

function enterBattle(id: number) {
  if (!game || game.winner !== null) return;
  const b = getBattle(game, id);
  if (!b || b.endedAt !== null || (sideOf(b, 0)?.troops ?? 0) <= 0.5) {
    toast('You have no troops in that battle', 'notin');
    return;
  }
  drag = null;
  game.presence[0] = id;
  bv.show(id);
}

function leaveBattle() {
  if (game) game.presence[0] = null;
  bv.hide();
}

// ---------- Map input ----------

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
  if (!game || game.winner !== null || e.button !== 0) return;
  const bid = renderer.battleAt(game, e.offsetX, e.offsetY);
  if (bid !== null) {
    enterBattle(bid);
    return;
  }
  const n = renderer.nodeAt(game, e.offsetX, e.offsetY);
  if (n === null) return;
  const node = game.nodes[n];
  if (node.battleId !== null) {
    enterBattle(node.battleId);
    return;
  }
  if (node.owner !== 0) return;
  drag = { from: n, x: e.offsetX, y: e.offsetY, target: null, amount: Math.floor(node.troops * ratio) };
});
canvas.addEventListener('mousemove', (e) => {
  if (!game) return;
  hover = renderer.nodeAt(game, e.offsetX, e.offsetY);
  if (drag) {
    drag.x = e.offsetX;
    drag.y = e.offsetY;
    drag.target = hover !== null && hover !== drag.from ? hover : null;
    drag.amount = Math.floor(game.nodes[drag.from].troops * ratio);
  }
  updateTip(e.offsetX, e.offsetY);
});
window.addEventListener('mouseup', () => {
  if (!drag || !game) {
    drag = null;
    return;
  }
  if (drag.target !== null) {
    const col = sendTroops(game, 0, drag.from, drag.target, drag.amount);
    if (!col) toast('Not enough troops to send', 'nosend');
  }
  drag = null;
});
canvas.addEventListener('mouseleave', () => {
  hover = null;
  $('tip').classList.add('hidden');
});

function updateTip(sx: number, sy: number) {
  const tip = $('tip');
  if (!game || hover === null || drag) {
    tip.classList.add('hidden');
    return;
  }
  const n = game.map.nodes[hover];
  const st = NODE_STATS[n.kind];
  const ns = game.nodes[hover];
  const owner = ns.owner === 0 ? 'Yours' : ns.owner === 1 ? 'Enemy' : 'Neutral';
  tip.innerHTML = `<b>${n.name}</b> · ${st.label}<br>${owner} · ${Math.floor(ns.troops)} troops${ns.owner !== 2 ? ` · +${st.growth}/s` : ''}<br>Walls ×${st.defense}${ns.battleId !== null ? '<br><i>Battle in progress: click to enter</i>' : ns.owner === 0 ? '<br><i>Drag to send troops</i>' : ''}`;
  tip.style.left = `${sx + 18}px`;
  tip.style.top = `${sy + 18}px`;
  tip.classList.remove('hidden');
}

// ---------- Dock, keys, buttons ----------

function setRatio(r: number) {
  ratio = r;
  document.querySelectorAll<HTMLElement>('#ratio button').forEach((b) => b.classList.toggle('on', Number(b.dataset.r) === r));
}
document.querySelectorAll<HTMLElement>('#ratio button').forEach((b) => b.addEventListener('click', () => setRatio(Number(b.dataset.r))));
setRatio(0.5);
$('battle-list').addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('[data-bid]')?.dataset.bid;
  if (id) enterBattle(Number(id));
});

window.addEventListener('keydown', (e) => {
  if (!game || !$('setup').classList.contains('hidden')) return;
  if (e.key === 'Escape' && bv.open) return leaveBattle();
  if (e.key === 'p' || e.key === 'P' || (e.key === 'Escape' && !bv.open)) return togglePause();
  if (['1', '2', '3', '4'].includes(e.key)) setRatio([0.25, 0.5, 0.75, 1][Number(e.key) - 1]);
});

function togglePause() {
  if (!game || game.winner !== null) return;
  paused = !paused;
  $('btn-pause').textContent = paused ? 'Resume' : 'Pause';
  $('paused').classList.toggle('hidden', !paused);
}

$('btn-pause').addEventListener('click', togglePause);
$('btn-help').addEventListener('click', () => $('help').classList.toggle('hidden'));
$('help-close').addEventListener('click', () => $('help').classList.add('hidden'));
$('rematch').addEventListener('click', startGame);
$('newgame').addEventListener('click', () => {
  $('end').classList.add('hidden');
  document.querySelector('.hud-top')!.classList.add('hidden');
  $('dock').classList.add('hidden');
  game = null;
  settings.seed = randomSeed();
  refreshSetup(true);
  $('setup').classList.remove('hidden');
});

function toast(text: string, key: string, good = false) {
  const k = `toast:${key}:${Math.floor(now / 2)}`;
  if (seenEvents.has(k)) return;
  seenEvents.add(k);
  const el = document.createElement('div');
  el.className = `toast${good ? ' good' : ''}`;
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function updateHud(g: Game) {
  let t0 = 0;
  let t1 = 0;
  for (const n of g.nodes) {
    if (n.owner === 0) t0 += n.troops;
    if (n.owner === 1) t1 += n.troops;
  }
  for (const c of g.columns) {
    if (c.owner === 0) t0 += c.troops;
    else t1 += c.troops;
  }
  for (const b of activeBattles(g)) {
    t0 += Math.max(0, sideOf(b, 0)?.troops ?? 0);
    t1 += Math.max(0, sideOf(b, 1)?.troops ?? 0);
  }
  $('t0').textContent = String(Math.floor(t0));
  $('t1').textContent = String(Math.floor(t1));
  $('n0').textContent = `${g.nodes.filter((n) => n.owner === 0).length} held`;
  $('n1').textContent = `${g.nodes.filter((n) => n.owner === 1).length} held`;
  $('p0').style.width = `${(100 * t0) / (t0 + t1 || 1)}%`;
  // War clock counts down; at zero, whoever holds more strongholds wins.
  const s = Math.max(0, Math.ceil(MATCH_TIME - g.time));
  $('clock').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left`;
  $('clock').classList.toggle('urgent', s <= 120);
  // Battle list in the dock: every battle you are part of, most urgent first.
  const mine = activeBattles(g)
    .filter((b) => (sideOf(b, 0)?.troops ?? 0) > 0.5)
    .map((b) => {
      const me = sideOf(b, 0)!.troops;
      const foe = b.sides.filter((x) => x.owner !== 0).reduce((t, x) => t + Math.max(0, x.troops), 0);
      return { b, me, foe, r: me / (me + foe || 1) };
    })
    .sort((p, q) => p.r - q.r);
  $('battle-list').innerHTML = mine
    .map(
      ({ b, me, foe, r }) =>
        `<button data-bid="${b.id}" class="${r < 0.4 ? 'losing' : ''}"><span>${battleName(g, b).replace('Battle of ', '').replace('Ambush on the ', '')}${g.presence[1] === b.id ? ' <i>· enemy cmdr</i>' : ''}</span><div class="bar"><div style="width:${r * 100}%"></div></div><small>${Math.ceil(me)} vs ${Math.ceil(foe)}</small></button>`,
    )
    .join('');
  // Toasts for new events.
  for (const e of g.events) {
    const key = `${e.kind}:${e.t.toFixed(2)}:${e.text}`;
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    if (e.kind === 'battle' && e.owner === 1) toast(`⚔ ${e.text}`, key);
    else if (e.kind === 'lost') toast(e.text, key);
    else if (e.kind === 'captured' && e.owner === 0) toast(e.text, key, true);
    else if (e.kind === 'intercept') toast('⚔ Columns clash on a road', key);
  }
}

// ---------- Loop ----------

function onResize() {
  renderer.resize(window.innerWidth, window.innerHeight);
  if (bv.open) bv.resize();
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
  if (!game || !ai) {
    // Training runs from the lobby, with no war in progress.
    if (bv.practicing) {
      bv.update(null, dt);
      bv.render(null);
    }
    return;
  }
  if (!paused && game.winner === null) {
    acc += dt;
    while (acc >= STEP) {
      aiStep(game, ai, STEP);
      step(game, STEP);
      acc -= STEP;
    }
    bv.update(game, dt);
  }
  if (bv.open) bv.render(game);
  else renderer.draw(game, { hover, drag, now });
  updateHud(game);
  if (game.winner !== null) {
    if (endShownAt < 0) endShownAt = now;
    if (now - endShownAt > 1.5 && $('end').classList.contains('hidden')) showEnd();
  }
}

buildSetup();
onResize();
requestAnimationFrame(frame);

// Debug hook for automated browser checks. advance(seconds) runs without requestAnimationFrame.
(window as unknown as { __holdfast: unknown }).__holdfast = {
  get game() {
    return game;
  },
  bv,
  renderer,
  settings,
  enterBattle,
  advance(seconds: number) {
    for (let s = 0; s < seconds; s += 0.05) tick(0.05);
    tick(0);
  },
};
