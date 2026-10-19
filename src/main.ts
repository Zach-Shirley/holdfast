import './style.css';
import { PERSONALITIES, aiStep, createAi, duelReaction, type AiState, type Difficulty, type Personality } from './ai';
import { BattleView } from './battleview';
import { NODE_STATS, ROAD_SPEED, SPECIALS, WORLD_H, WORLD_W, generateMap, type GraphMap } from './map';
import { MapRenderer, OWNER_COLOR, applyPalette, nodeRadius, paintBackground } from './render';
import { prefs, savePrefs } from './prefs';
import { applyVolume, audioSettings, audioState, initAudio, setIntensity, setMusic, sfx } from './sound';
import {
  ABILITIES,
  COMMANDERS,
  MATCH_TIME,
  type CommanderId,
  STANCES,
  canSee,
  columnPos,
  knownNode,
  setRally,
  useAbility,
  type Ability,
  activeBattles,
  applyDuel,
  applyPursuit,
  applyQte,
  battleName,
  createGame,
  getBattle,
  inDuel,
  retreat,
  retreatTarget,
  sendTroops,
  sideOf,
  step,
  useFinisher,
  type Game,
  type Stance,
} from './sim';

const STEP = 1 / 20;

interface Settings {
  nodes: number;
  difficulty: Difficulty;
  seed: number;
  fog: 'off' | 'on';
  commander: CommanderId;
  rival: Personality | 'random';
}
const settings: Settings = { nodes: 8, difficulty: 'normal', seed: randomSeed(), fog: 'off', commander: 'archer', rival: 'random' };
/** The rival actually facing you this war (Random resolves at start). */
let rival: Personality = 'aggressor';
const RIVALS: Personality[] = ['aggressor', 'turtle', 'opportunist', 'gambler'];
const PLAYABLE: CommanderId[] = ['archer', 'duelist', 'ironwall', 'raider', 'herald'];
/** Strongholds picked with the selection box, for sending from several at once. */
const selected = new Set<number>();
let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
let rallyDrag: { from: number; x: number; y: number; target: number | null } | null = null;
let targeting: 'march' | 'inspire' | null = null;
let ratio = 0.5;
let stance: Stance = 'assault';

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
      <button id="btn-mute" title="Mute (M)">Sound</button>
      <button id="btn-pause">Pause</button>
      <button id="btn-settings" title="Settings">⚙</button>
      <button id="btn-help">?</button>
    </div>
  </header>
  <div class="dock hidden" id="dock">
    <span class="dock-lbl">Send</span>
    <div class="seg" id="ratio">
      <button data-r="0.25">25%</button><button data-r="0.5">50%</button><button data-r="0.75">75%</button><button data-r="1">All</button>
    </div>
    <span class="dock-lbl">Stance</span>
    <div class="seg" id="stance">${(Object.keys(STANCES) as Stance[]).map((k) => `<button data-s="${k}" title="${STANCES[k].desc}">${STANCES[k].label}</button>`).join('')}</div>
    <span class="dock-lbl">Orders</span>
    <div class="seg" id="abilities">${(Object.keys(ABILITIES) as Ability[]).map((k) => `<button data-a="${k}" title="${ABILITIES[k].desc}">${ABILITIES[k].label}<small></small></button>`).join('')}</div>
    <div class="battles" id="battle-list"></div>
  </div>
  <div class="tip hidden" id="tip"></div>
  <div class="toasts" id="toasts"></div>
  <div class="paused hidden" id="paused">Paused</div>
  <div class="edge-flash" id="edge-flash"></div>
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
          <h3 class="gap">Rival</h3>
          <div class="seg" data-key="rival"><button data-v="random">Random</button>${RIVALS.map((p) => `<button data-v="${p}" title="${PERSONALITIES[p].desc}">${PERSONALITIES[p].label}</button>`).join('')}</div>
          <h3 class="gap">Fog of war</h3>
          <div class="seg" data-key="fog"><button data-v="off">Off</button><button data-v="on">On</button></div>
          <h3 class="gap">Map</h3>
          <div class="seed-row"><label>Seed <input id="seed" type="number" min="1" max="99999" /></label><button id="reroll">New map</button></div>
        </div>
        <div class="preview-wrap"><canvas id="preview"></canvas></div>
      </div>
      <h3 class="gap">Your commander</h3>
      <div class="commanders" id="commanders">${PLAYABLE.map((c) => `<button data-c="${c}"><b>${COMMANDERS[c].label}</b><i>${COMMANDERS[c].title}</i><span>${COMMANDERS[c].desc}</span></button>`).join('')}</div>
      <div class="actions"><button class="primary" id="start">Start war</button><button id="training">Training: learn the quick-time events</button><button id="setup-help">How to play</button><button id="setup-settings">Settings</button></div>
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
          <p>The enemy has a commander too, and it can only be in one battle. Its flag shows where it is: strike somewhere else, or go there and <b>duel</b> it.</p>
          <h3>Battle tools</h3>
          <p><b>Rally &amp; Charge:</b> every hit fills your rally meter (4 hits). When full, click <b>CHARGE!</b> to cut down a quarter of the enemy.</p>
          <p><b>Retreat:</b> pull your troops back to the nearest stronghold you hold, keeping 85%. It pulses when your side is routing.</p>
          <p><b>Rout:</b> a side below a quarter of its peak breaks and takes 25% extra losses. Chase a routing enemy with <b>Pursuit</b>.</p>
          <p><b>Stances</b> (dock): Assault +20% damage, Hold −20% damage taken, Skirmish +25% march speed. Each brings more of one event type.</p>
          <p>Red arrows at the screen edge point to your other battles that are going badly. Click one to jump there.</p>
          <h3>Commanders and rivals</h3>
          <p>Pick a <b>commander</b> before each war: the Archer (stronger, easier Volleys), the Duelist (Slash kills, duel edge), the Iron Wall (free Parry misses, stronger walls), the Raider (fast columns, ambush momentum) or the Herald (faster rally meter).</p>
          <p>Your <b>rival</b> has a personality and a commander of their own: Varric the Relentless (Aggressor), Lady Morwen of the Wall (Turtle), Silas Quickfinger (Opportunist) or Captain Rook (Gambler). Expect them to talk.</p>
          <h3>The map</h3>
          <p><b>Special strongholds</b> (gold badge): <b>B</b>arracks +50% growth · <b>W</b>atchtower sees far · <b>F</b>orge: your nearby battles start with +0.3 momentum · <b>S</b>hrine: +25% quick-time power nearby.</p>
          <p>Roads: green dashed <b>marsh</b> is slow (×0.65), pale <b>paved</b> roads are fast (×1.3).</p>
          <p><b>Rally routes:</b> right-drag from one of your strongholds to another to forward new troops there automatically. Right-click it to clear.</p>
          <p><b>Multi-send:</b> drag a box around several strongholds, then drag from any of them to send from all.</p>
          <p><b>Orders</b> (dock): Forced March (click a column: 2× speed for 15 s), Inspire (click a battle: +momentum and rally), Spy (20 s: see everything and where enemy columns are heading).</p>
          <p><b>Fog of war</b> (optional): you only see near your strongholds and columns. Elsewhere you see the last sighting, marked "?".</p>
        </div>
        <div>
          <h3>Quick-time events (mouse only)</h3>
          <p><span class="ic volley"></span><b>Volley</b>: click the target when the closing ring meets it. Kills a big chunk of enemy troops.</p>
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

  <section class="overlay hidden" id="settings">
    <div class="panel settings">
      <h2>Settings</h2>
      <div class="set-row"><label for="vol">Volume</label><input id="vol" type="range" min="0" max="1" step="0.05" /><label class="chk"><input id="mute" type="checkbox" /> Mute</label></div>
      <div class="set-row"><span>Quick-time speed</span><div class="seg" id="qspeed"><button data-v="0.8">Slower (80%)</button><button data-v="1">Normal</button><button data-v="1.2">Faster (120%)</button></div></div>
      <div class="set-row"><span>Team colours</span><div class="seg" id="palette"><button data-v="classic">Red vs blue</button><button data-v="contrast">High contrast (orange vs blue)</button></div></div>
      <p class="muted">Slower quick-time events give you more time to react. Their effects stay the same.</p>
      <div class="actions"><button class="primary" id="settings-close">Done</button></div>
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
  onFinisher: (id) => (game ? useFinisher(game, id, 0) : ''),
  onRetreat: (id) => !!(game && retreat(game, id, 0)),
  canRetreat: (id) => {
    const b = game && getBattle(game, id);
    return !!(game && b && retreatTarget(game, b, 0) !== null);
  },
  onDuel: (id, won) => (game ? applyDuel(game, id, won ? 0 : 1) : ''),
  onPursuit: (id, hits) => (game ? applyPursuit(game, id, 0, hits) : ''),
  duelReaction: () => (ai ? duelReaction(ai) : 0.5),
  onPracticeExit: () => $("setup").classList.remove("hidden"),
});

// ---------- Settings and sound ----------

function applyPrefs() {
  audioSettings.volume = prefs.volume;
  audioSettings.muted = prefs.muted;
  applyVolume();
  bv.timeScale = prefs.qteSpeed;
  applyPalette(prefs.palette);
  $<HTMLInputElement>('vol').value = String(prefs.volume);
  $<HTMLInputElement>('mute').checked = prefs.muted;
  $('btn-mute').textContent = prefs.muted ? 'Muted' : 'Sound';
  document.querySelectorAll<HTMLElement>('#qspeed button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === prefs.qteSpeed));
  document.querySelectorAll<HTMLElement>('#palette button').forEach((b) => b.classList.toggle('on', b.dataset.v === prefs.palette));
  if (map) drawPreview(map);
}

function setPref<K extends keyof typeof prefs>(k: K, v: (typeof prefs)[K]) {
  prefs[k] = v;
  savePrefs();
  applyPrefs();
}

$<HTMLInputElement>('vol').addEventListener('input', (e) => setPref('volume', Number((e.target as HTMLInputElement).value)));
$<HTMLInputElement>('mute').addEventListener('change', (e) => setPref('muted', (e.target as HTMLInputElement).checked));
document.querySelectorAll<HTMLElement>('#qspeed button').forEach((b) => b.addEventListener('click', () => setPref('qteSpeed', Number(b.dataset.v))));
document.querySelectorAll<HTMLElement>('#palette button').forEach((b) => b.addEventListener('click', () => setPref('palette', b.dataset.v as 'classic' | 'contrast')));
$('settings-close').addEventListener('click', () => $('settings').classList.add('hidden'));
$('setup-settings').addEventListener('click', () => $('settings').classList.remove('hidden'));
$('btn-settings').addEventListener('click', () => $('settings').classList.remove('hidden'));
$('btn-mute').addEventListener('click', () => setPref('muted', !prefs.muted));
// Browsers only start audio after a user gesture.
window.addEventListener('pointerdown', () => initAudio(), { capture: true });

function flashEdge() {
  const el = $('edge-flash');
  el.classList.remove('on');
  void el.offsetWidth;
  el.classList.add('on');
}

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
  document.querySelectorAll<HTMLElement>('#commanders button').forEach((b) =>
    b.addEventListener('click', () => {
      settings.commander = b.dataset.c as CommanderId;
      refreshSetup(false);
    }),
  );
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
  document.querySelectorAll<HTMLElement>('#commanders button').forEach((b) => b.classList.toggle('on', b.dataset.c === settings.commander));
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
  rival = settings.rival === 'random' ? RIVALS[Math.floor(Math.random() * RIVALS.length)] : settings.rival;
  game = createGame(map, { fog: settings.fog === 'on', commanders: [settings.commander, PERSONALITIES[rival].commander] });
  bv.perks = { volleySlow: settings.commander === 'archer', duelGrace: settings.commander === 'duelist' ? 0.1 : 0 };
  document.querySelector('.force.foe .lbl')!.textContent = PERSONALITIES[rival].short;
  document.querySelector('.force.foe .lbl')!.setAttribute('title', `${PERSONALITIES[rival].name} (${PERSONALITIES[rival].label})`);
  selected.clear();
  targeting = null;
  ai = createAi(1, settings.difficulty, settings.seed, true, rival);
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
  setMusic(true);
}

function showEnd() {
  if (!game) return;
  bv.hide();
  game.presence[0] = null;
  const won = game.winner === 0;
  setMusic(false);
  sfx(won ? 'victory' : 'defeat');
  $('end-title').textContent = won ? 'VICTORY' : 'DEFEAT';
  $('end-title').className = `title ${won ? 'win' : 'loss'}`;
  const t = Math.floor(game.time);
  $('end-reason').textContent = `${game.winReason} after ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}. You led as ${COMMANDERS[settings.commander].label} against ${PERSONALITIES[rival].name} (${PERSONALITIES[rival].label}, ${COMMANDERS[PERSONALITIES[rival].commander].label}).`;
  const [a, b] = game.stats;
  const pct = (h: number, p: number) => (p ? `${Math.round((100 * h) / p)}%` : '–');
  const row = (l: string, x: string | number, y: string | number) => `<tr><td>${l}</td><td>${x}</td><td>${y}</td></tr>`;
  $('end-stats').innerHTML =
    '<tr><th></th><th>You</th><th>Enemy</th></tr>' +
    row('Battles fought / won', `${a.battlesFought} / ${a.battlesWon}`, `${b.battlesFought} / ${b.battlesWon}`) +
    row('Quick-time events', `${a.qteHit} / ${a.qtePlayed} (${pct(a.qteHit, a.qtePlayed)})`, `${b.qteHit} / ${b.qtePlayed} (${pct(b.qteHit, b.qtePlayed)})`) +
    row('Charges / retreats', `${a.finishers} / ${a.retreats}`, `${b.finishers} / ${b.retreats}`) +
    row('Duels won', `${a.duelsWon} / ${a.duels}`, `${b.duelsWon} / ${b.duels}`) +
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

/** Troops a drag would send: from every selected stronghold if the drag starts on one of them. */
function dragSources(from: number): number[] {
  if (!game) return [];
  const multi = selected.has(from) && selected.size > 1;
  return (multi ? [...selected] : [from]).filter((id) => game!.nodes[id].owner === 0 && game!.nodes[id].battleId === null);
}

function dragAmount(from: number): number {
  return dragSources(from).reduce((t, id) => t + Math.floor(game!.nodes[id].troops * ratio), 0);
}

/** Clicking a target for an ability that needs one. */
function useTargeted(sx: number, sy: number) {
  if (!game || !targeting) return;
  if (targeting === 'march') {
    const w = renderer.s2w(sx, sy);
    const col = game.columns.filter((c) => c.owner === 0).sort((a, b) => Math.hypot(columnPos(game!, a).x - w.x, columnPos(game!, a).y - w.y) - Math.hypot(columnPos(game!, b).x - w.x, columnPos(game!, b).y - w.y))[0];
    if (col && Math.hypot(columnPos(game, col).x - w.x, columnPos(game, col).y - w.y) < 60 && useAbility(game, 0, 'march', col.id)) sfx('send');
    else toast('Click one of your marching columns', 'tgt');
  } else {
    const n = renderer.nodeAt(game, sx, sy);
    const bid = renderer.battleAt(game, sx, sy) ?? (n !== null ? game.nodes[n].battleId : null);
    if (bid !== null && useAbility(game, 0, 'inspire', bid)) sfx('charge');
    else toast('Click one of your battles', 'tgt');
  }
  targeting = null;
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
  if (!game || game.winner !== null) return;
  const x = e.offsetX;
  const y = e.offsetY;
  if (targeting) {
    if (e.button === 0) useTargeted(x, y);
    else targeting = null;
    return;
  }
  const n = renderer.nodeAt(game, x, y);
  if (e.button === 2) {
    // Right-drag between your strongholds sets a rally route; right-click clears it.
    if (n !== null && game.nodes[n].owner === 0) rallyDrag = { from: n, x, y, target: null };
    return;
  }
  if (e.button !== 0) return;
  const bid = renderer.battleAt(game, x, y);
  if (bid !== null) {
    enterBattle(bid);
    return;
  }
  if (n === null) {
    box = { x0: x, y0: y, x1: x, y1: y };
    return;
  }
  const node = game.nodes[n];
  if (node.battleId !== null) {
    enterBattle(node.battleId);
    return;
  }
  if (node.owner !== 0) return;
  if (!selected.has(n)) selected.clear();
  drag = { from: n, x, y, target: null, amount: dragAmount(n) };
});
canvas.addEventListener('mousemove', (e) => {
  if (!game) return;
  hover = renderer.nodeAt(game, e.offsetX, e.offsetY);
  if (drag) {
    drag.x = e.offsetX;
    drag.y = e.offsetY;
    drag.target = hover !== null && hover !== drag.from ? hover : null;
    drag.amount = dragAmount(drag.from);
  }
  if (rallyDrag) {
    rallyDrag.x = e.offsetX;
    rallyDrag.y = e.offsetY;
    rallyDrag.target = hover !== null && hover !== rallyDrag.from && game.nodes[hover].owner === 0 ? hover : null;
  }
  if (box) {
    box.x1 = e.offsetX;
    box.y1 = e.offsetY;
  }
  updateTip(e.offsetX, e.offsetY);
});
window.addEventListener('mouseup', () => {
  if (!game) {
    drag = rallyDrag = box = null;
    return;
  }
  if (drag && drag.target !== null) {
    let sent = 0;
    for (const id of dragSources(drag.from)) {
      if (id === drag.target) continue;
      if (sendTroops(game, 0, id, drag.target, Math.floor(game.nodes[id].troops * ratio), stance)) sent++;
    }
    if (!sent) toast('Not enough troops to send', 'nosend');
    else sfx('send');
  }
  if (rallyDrag) {
    const same = hover === rallyDrag.from;
    if (rallyDrag.target !== null) {
      setRally(game, 0, rallyDrag.from, rallyDrag.target);
      toast(`Rally route set: ${game.map.nodes[rallyDrag.from].name} → ${game.map.nodes[rallyDrag.target].name}`, 'rally', true);
    } else if (same && game.nodes[rallyDrag.from].rallyTo !== null) {
      setRally(game, 0, rallyDrag.from, null);
      toast('Rally route cleared', 'rally');
    }
  }
  if (box) {
    const moved = Math.hypot(box.x1 - box.x0, box.y1 - box.y0) > 6;
    selected.clear();
    if (moved) {
      const [x0, x1] = [Math.min(box.x0, box.x1), Math.max(box.x0, box.x1)];
      const [y0, y1] = [Math.min(box.y0, box.y1), Math.max(box.y0, box.y1)];
      for (const n of game.map.nodes) {
        const p = renderer.w2s(n.x, n.y);
        if (game.nodes[n.id].owner === 0 && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) selected.add(n.id);
      }
      if (selected.size > 1) toast(`${selected.size} strongholds selected: drag from any of them to send from all`, 'sel', true);
    }
  }
  drag = rallyDrag = box = null;
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
  const known = knownNode(game, 0, hover);
  const owner = known.owner === 0 ? 'Yours' : known.owner === 1 ? 'Enemy' : 'Neutral';
  const troops = known.live ? `${Math.floor(ns.troops)} troops` : `about ${Math.floor(known.troops)} troops when last seen`;
  const growth = st.growth * (n.special === 'barracks' ? 1.5 : 1);
  const special = n.special ? `<br><b class="sp">${SPECIALS[n.special].label}:</b> ${SPECIALS[n.special].desc}` : '';
  const roads = game.map.adj[hover].map((k) => game!.map.edges.find((e) => (e.a === hover && e.b === k) || (e.b === hover && e.a === k))!.road).filter((r) => r !== 'road');
  const roadNote = roads.length ? `<br>Roads here: ${[...new Set(roads)].map((r) => `${r} (×${ROAD_SPEED[r]} speed)`).join(', ')}` : '';
  const rally = ns.owner === 0 && ns.rallyTo !== null ? `<br>Rally route → ${game.map.nodes[ns.rallyTo].name} (right-click to clear)` : '';
  const hint = ns.battleId !== null && known.live ? '<br><i>Battle in progress: click to enter</i>' : ns.owner === 0 ? '<br><i>Drag to send troops · right-drag to set a rally route</i>' : '';
  tip.innerHTML = `<b>${n.name}</b> · ${st.label}<br>${owner} · ${troops}${known.owner !== 2 ? ` · +${growth}/s` : ''}<br>Walls ×${st.defense}${special}${roadNote}${rally}${hint}`;
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
function setStance(s: Stance) {
  stance = s;
  document.querySelectorAll<HTMLElement>('#stance button').forEach((b) => b.classList.toggle('on', b.dataset.s === s));
}
document.querySelectorAll<HTMLElement>('#stance button').forEach((b) => b.addEventListener('click', () => setStance(b.dataset.s as Stance)));
setStance('assault');
document.querySelectorAll<HTMLElement>('#abilities button').forEach((b) =>
  b.addEventListener('click', () => {
    if (!game) return;
    const a = b.dataset.a as Ability;
    if (game.abilityReady[0][a] > game.time) return;
    if (a === 'spy') {
      if (useAbility(game, 0, 'spy')) sfx('horn');
      return;
    }
    targeting = targeting === a ? null : a;
    if (targeting) toast(a === 'march' ? 'Forced March: click one of your marching columns' : 'Inspire: click one of your battles', 'tgt');
  }),
);
$('battle-list').addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('[data-bid]')?.dataset.bid;
  if (id) enterBattle(Number(id));
});

window.addEventListener('keydown', (e) => {
  if (!game || !$('setup').classList.contains('hidden')) return;
  if (e.key === 'Escape' && bv.open) return leaveBattle();
  if (e.key === 'Escape' && (targeting || selected.size)) {
    targeting = null;
    selected.clear();
    return;
  }
  if (e.key === 'p' || e.key === 'P' || (e.key === 'Escape' && !bv.open)) return togglePause();
  if (['1', '2', '3', '4'].includes(e.key)) setRatio([0.25, 0.5, 0.75, 1][Number(e.key) - 1]);
  if (e.key === 'm' || e.key === 'M') setPref('muted', !prefs.muted);
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

function toast(text: string, key: string, good = false, taunt = false) {
  const k = `toast:${key}:${Math.floor(now / 2)}`;
  if (seenEvents.has(k)) return;
  seenEvents.add(k);
  const el = document.createElement('div');
  el.className = `toast${good ? ' good' : ''}${taunt ? ' taunt' : ''}`;
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
  // Under fog you only know what you have seen of the enemy.
  const hidden = g.fog && g.spyUntil[0] <= g.time;
  if (hidden) {
    t1 = 0;
    for (const n of g.nodes) {
      const k = knownNode(g, 0, n.id);
      if (k.owner === 1) t1 += k.troops;
    }
    for (const c of g.columns) if (c.owner === 1 && canSee(g, 0, columnPos(g, c).x, columnPos(g, c).y)) t1 += c.troops;
  }
  $('t1').textContent = hidden ? `~${Math.floor(t1)}` : String(Math.floor(t1));
  $('n0').textContent = `${g.nodes.filter((n) => n.owner === 0).length} held`;
  $('n1').textContent = `${g.nodes.filter((n) => (hidden ? knownNode(g, 0, n.id).owner : n.owner) === 1).length}${hidden ? '?' : ''} held`;
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
  setIntensity(mine.length);
  document.querySelectorAll<HTMLButtonElement>('#abilities button').forEach((b) => {
    const a = b.dataset.a as Ability;
    const wait = Math.ceil(g.abilityReady[0][a] - g.time);
    b.disabled = wait > 0;
    b.classList.toggle('on', targeting === a);
    b.querySelector('small')!.textContent = wait > 0 ? ` ${wait}s` : a === 'spy' && g.spyUntil[0] > g.time ? ` ${Math.ceil(g.spyUntil[0] - g.time)}s` : '';
  });
  $('battle-list').innerHTML = mine
    .map(
      ({ b, me, foe, r }) =>
        `<button data-bid="${b.id}" class="${r < 0.4 ? 'losing' : ''}"><span>${battleName(g, b).replace('Battle of ', '').replace('Ambush on the ', '')}${inDuel(g, b) ? ' <i>· DUEL</i>' : g.presence[1] === b.id ? ' <i>· enemy cmdr</i>' : ''}</span><div class="bar"><div style="width:${r * 100}%"></div></div><small>${Math.ceil(me)} vs ${Math.ceil(foe)}</small></button>`,
    )
    .join('');
  // Toasts for new events.
  for (const e of g.events) {
    const key = `${e.kind}:${e.t.toFixed(2)}:${e.text}`;
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    // The rival speaks to you directly.
    if (e.kind === 'taunt') {
      toast(e.text, key, false, true);
      continue;
    }
    // Under fog, news only reaches you from places you can see.
    if (g.fog && !canSee(g, 0, e.x, e.y)) continue;
    if (e.kind === 'battle' && e.owner === 1) {
      toast(`⚔ ${e.text}`, key);
      // A horn when the enemy hits one of your strongholds.
      const b = getBattle(g, e.battleId ?? null);
      if (b && b.nodeId !== null && g.nodes[b.nodeId].owner === 0) sfx('horn');
    } else if (e.kind === 'lost') {
      toast(e.text, key);
      sfx('lost');
      flashEdge();
    } else if (e.kind === 'captured' && e.owner === 0) {
      toast(e.text, key, true);
      sfx('captured');
    }
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
  else {
    const ui = { hover, drag, now, selected, box, rallyDrag, targeting };
    renderer.draw(game, ui);
    renderer.drawOverlay(ui);
  }
  updateHud(game);
  if (game.winner !== null) {
    if (endShownAt < 0) endShownAt = now;
    if (now - endShownAt > 1.5 && $('end').classList.contains('hidden')) showEnd();
  }
}

buildSetup();
applyPrefs();
onResize();
requestAnimationFrame(frame);

// Debug hook for automated browser checks. advance(seconds) runs without requestAnimationFrame.
(window as unknown as { __holdfast: unknown }).__holdfast = {
  get game() {
    return game;
  },
  bv,
  audioState,
  renderer,
  settings,
  enterBattle,
  advance(seconds: number) {
    for (let s = 0; s < seconds; s += 0.05) tick(0.05);
    tick(0);
  },
};
