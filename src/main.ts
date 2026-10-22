import './style.css';
import { PERSONALITIES, aiStep, createAi, duelReaction, type AiState, type Difficulty, type Personality } from './ai';
import { BattleView } from './battleview';
import { NODE_STATS, ROAD_SPEED, SPECIALS, WORLD_H, WORLD_W, generateMap, type GraphMap } from './map';
import { MapRenderer, OWNER_COLOR, applyPalette, nodeRadius, paintBackground } from './render';
import { prefs, savePrefs } from './prefs';
import { Tutorial, setupTutorialGame, tutorialMap } from './tutorial';
import { CampaignRun, MISSIONS, createMissionGame, starsFor, type Mission } from './campaign';
import { campaignStars, saveStars } from './records';
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
  reverseColumn,
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
  resign,
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
  /** Watch mode: the AI on your (left/red) side. */
  watchLeft: Personality | 'random';
}
const settings: Settings = { nodes: 8, difficulty: 'normal', seed: randomSeed(), fog: 'off', commander: 'archer', rival: 'random', watchLeft: 'random' };
/** Watch mode: two AIs fight and you observe. */
let spectating = false;
/** The tutorial level, when it is running. */
let tutorial: Tutorial | null = null;
/** The campaign mission being played, if any. */
let campaign: CampaignRun | null = null;
/** The mission picked on the campaign screen. */
let campaignPick = 0;
let ai0: AiState | null = null;
let leftRival: Personality = 'turtle';
let watchSpeed = 1;
const names = (): [string, string] => (spectating ? [PERSONALITIES[leftRival].short, PERSONALITIES[rival].short] : ['You', PERSONALITIES[rival].short]);
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
      <button id="btn-resign" class="resign hidden" title="Concede this war (only offered while you are behind)">Resign</button>
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
    <div class="dock-rally" id="dock-rally" title="Your rally meter. It stays with your commander between battles, so you can bank a full meter and spend the Charge where it matters."><span>Rally</span><div class="bar"><div id="dock-rally-fill"></div></div></div>
    <div class="battles" id="battle-list"></div>
  </div>
  <div class="spectator hidden" id="spectator">
    <span class="lbl">Watching</span><b id="spec-names"></b>
    <span class="lbl">Speed</span>
    <div class="seg" id="spec-speed"><button data-x="1">1×</button><button data-x="2">2×</button><button data-x="4">4×</button></div>
    <span class="muted">Click any battle to watch it</span>
    <button id="spec-stop">Stop watching</button>
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
          <div class="seg" data-key="nodes">${[6, 7, 8, 9, 10, 12, 14, 16].map((n) => `<button data-v="${n}">${n}</button>`).join('')}</div>
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
      <div class="actions"><button class="primary" id="start">Start war</button><button class="primary alt" id="campaign-open">Campaign</button><button class="primary alt" id="tutorial">Tutorial</button><button id="training">Training: learn the quick-time events</button><button id="setup-help">How to play</button><button id="setup-settings">Settings</button></div>
      <div class="watch-row"><span>Watch two AIs fight (you observe):</span><div class="seg" data-key="watchLeft"><button data-v="random">Random</button>${RIVALS.map((p) => `<button data-v="${p}">${PERSONALITIES[p].label}</button>`).join('')}</div><span class="muted">vs the Rival above</span><button id="watch">Watch AI vs AI</button></div>
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
          <p><b>Rally &amp; Charge:</b> every hit fills your rally meter (4 hits). When full, click <b>CHARGE!</b> to cut down a quarter of the enemy. The meter belongs to your commander, not the battle: it carries over, so you can bank a full meter for the fight that matters (shown in the dock).</p>
          <p><b>Retreat:</b> pull your troops back to the nearest stronghold you hold, keeping 85%. It pulses when your side is routing.</p>
          <p><b>Rout:</b> a side below a quarter of its peak breaks and takes 25% extra losses. Chase a routing enemy with <b>Pursuit</b>.</p>
          <p><b>Stances</b> (dock): Assault +20% damage, Hold −20% damage taken, Skirmish +25% march speed. Each brings more of one event type.</p>
          <p>Red arrows at the screen edge point to your other battles that are going badly. Click one to jump there.</p>
          <p><b>Sieges:</b> storming a fort or capital brings the <b>Battering Ram</b> (click the gate on three beats: the walls drop for 15 s). Holding one brings <b>Boiling Oil</b> (hold on the wall and sweep over every ladder).</p>
          <h3>Modes</h3>
          <p><b>Campaign:</b> ten missions against the four rivals, each with its own map, objective and two bonus stars. Winning a mission opens the next. <b>Training</b> drills any event; its <b>Gauntlet</b> throws every event at you faster and faster until you miss three, for a high score.</p>
          <h3>Commanders and rivals</h3>
          <p>Pick a <b>commander</b> before each war: the Archer (stronger, easier Volleys), the Duelist (Slash kills, duel edge), the Iron Wall (free Parry misses, stronger walls), the Raider (fast columns, ambush momentum) or the Herald (faster rally meter).</p>
          <p>Your <b>rival</b> has a personality and a commander of their own: Varric the Relentless (Aggressor), Lady Morwen of the Wall (Turtle), Silas Quickfinger (Opportunist) or Captain Rook (Gambler). Expect them to talk.</p>
          <h3>The map</h3>
          <p><b>Special strongholds</b> (gold badge): <b>B</b>arracks +50% growth · <b>W</b>atchtower sees far · <b>F</b>orge: your nearby battles start with +0.3 momentum · <b>S</b>hrine: +25% quick-time power nearby.</p>
          <p>Roads: green dashed <b>marsh</b> is slow (×0.65), pale <b>paved</b> roads are fast (×1.3).</p>
          <p><b>Rally routes:</b> right-drag from one of your strongholds to another to forward new troops there automatically. Right-click it to clear.</p>
          <p><b>Multi-send:</b> drag a box around several strongholds, then drag from any of them to send from all.</p>
          <p><b>Turn back:</b> click one of your marching columns to send it back where it came from.</p>
          <p><b>Orders</b> (dock): Forced March (click a column: 2× speed for 15 s), Inspire (click a battle: +momentum and rally), Spy (20 s: see everything and where enemy columns are heading).</p>
          <p><b>Fog of war</b> (optional): you only see near your strongholds and columns. Enemy counts seen from afar are rough ("~25"). Elsewhere you see the last sighting, marked "?". Watchtowers only appear in fog matches.</p>
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
      <div class="end-stars hidden" id="end-stars"></div>
      <div class="actions"><button class="primary hidden" id="next-mission">Next mission</button><button class="primary" id="rematch">Rematch (same map)</button><button id="newgame">New war</button></div>
    </div>
  </section>

  <section class="overlay hidden" id="campaign">
    <div class="panel campaign">
      <div class="camp-side">
        <div class="title">CAMPAIGN</div>
        <p class="sub">The Border War · <span id="camp-total"></span></p>
        <div class="camp-list" id="camp-list"></div>
        <button id="camp-back">Back</button>
      </div>
      <div class="camp-brief" id="camp-brief"></div>
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
  onQte: (battleId, kind, success) => {
    campaign?.noteQte(kind, success);
    return game ? applyQte(game, battleId, 0, kind, success) : '';
  },
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
  $('start').addEventListener('click', () => startGame(false));
  $('tutorial').addEventListener('click', startTutorial);
  $('campaign-open').addEventListener('click', openCampaign);
  $('camp-back').addEventListener('click', () => {
    $('campaign').classList.add('hidden');
    refreshSetup(false);
    $('setup').classList.remove('hidden');
  });
  $('campaign').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const mi = t.closest<HTMLElement>('[data-mi]')?.dataset.mi;
    const cc = t.closest<HTMLElement>('[data-cc]')?.dataset.cc;
    if (mi !== undefined) {
      campaignPick = Number(mi);
      renderCampaign();
    } else if (cc) {
      settings.commander = cc as CommanderId;
      renderCampaign();
    } else if (t.id === 'camp-start') {
      $('campaign').classList.add('hidden');
      startGame(false, false, MISSIONS[campaignPick]);
    }
  });
  $('watch').addEventListener('click', () => startGame(true));
  document.querySelectorAll<HTMLElement>('#spec-speed button').forEach((b) => b.addEventListener('click', () => setWatchSpeed(Number(b.dataset.x))));
  $('spec-stop').addEventListener('click', () => {
    bv.hide();
    game = null;
    spectating = false;
    document.querySelector('.hud-top')!.classList.add('hidden');
    $('spectator').classList.add('hidden');
    setMusic(false);
    refreshSetup(false);
    $('setup').classList.remove('hidden');
  });
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

/** A mission is open once the one before it has been won. */
const unlocked = (i: number) => i === 0 || (campaignStars[MISSIONS[i - 1].id] ?? 0) > 0;

function openCampaign() {
  $('setup').classList.add('hidden');
  $('campaign').classList.remove('hidden');
  if (!unlocked(campaignPick)) campaignPick = 0;
  renderCampaign();
}

function renderCampaign() {
  const total = MISSIONS.reduce((t, m) => t + (campaignStars[m.id] ?? 0), 0);
  $('camp-total').textContent = `${total} / ${MISSIONS.length * 3} ★`;
  let act = '';
  $('camp-list').innerHTML = MISSIONS.map((m, i) => {
    const head = m.act !== act ? `<h4>${(act = m.act)}</h4>` : '';
    const st = campaignStars[m.id] ?? 0;
    const open = unlocked(i);
    return `${head}<button data-mi="${i}" class="${i === campaignPick ? 'on' : ''} ${open ? '' : 'locked'}" ${open ? '' : 'disabled'}><span>${i + 1}. ${m.title}</span><b>${open ? [0, 1, 2].map((k) => (k < st ? '★' : '☆')).join('') : '🔒'}</b></button>`;
  }).join('');
  const m = MISSIONS[campaignPick];
  const p = PERSONALITIES[m.rival];
  const made = m.make();
  $('camp-brief').innerHTML = `
    <div class="camp-act">${m.act} · Mission ${campaignPick + 1}</div>
    <h2>${m.title}</h2>
    <p class="camp-rival">Against <b>${p.name}</b> (${p.label}, ${COMMANDERS[p.commander].label}) · ${m.difficulty[0].toUpperCase() + m.difficulty.slice(1)}${m.fog ? ' · Fog of war' : ''}</p>
    <p class="camp-story">${m.story}</p>
    <div class="camp-goal"><b>Objective:</b> ${m.objectiveText}</div>
    <ul class="camp-stars"><li>★ Complete the objective</li>${m.stars.map((x) => `<li>★ ${x.text}</li>`).join('')}</ul>
    <p class="camp-tip">${m.tip}</p>
    <canvas id="camp-preview"></canvas>
    <div class="camp-cmd"><span>Your commander</span>${(Object.keys(COMMANDERS) as CommanderId[]).filter((c) => c !== 'none').map((c) => `<button data-cc="${c}" class="${c === settings.commander ? 'on' : ''}" title="${COMMANDERS[c].desc}">${COMMANDERS[c].label.replace('The ', '')}</button>`).join('')}</div>
    <button class="primary" id="camp-start">Begin mission</button>`;
  drawPreview(made.map, $<HTMLCanvasElement>('camp-preview'), made.owners.map(([o], id) => (made.owners.some(([, t]) => t) ? o : id === made.map.capitals[0] ? 0 : id === made.map.capitals[1] ? 1 : 2)));
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

function drawPreview(m: GraphMap, pv = $<HTMLCanvasElement>('preview'), owners?: number[]) {
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
    const owner = (owners?.[n.id] ?? (n.id === m.capitals[0] ? 0 : n.id === m.capitals[1] ? 1 : 2)) as 0 | 1 | 2;
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

/** The tutorial: a hand-made map, a coach panel, a passive enemy until the scripted attack, no war clock. */
function startTutorial() {
  startGame(false, true);
}

function startGame(watch = false, tutorialMode = false, mission: Mission | null = null) {
  if (!map) map = generateMap(settings.seed, settings.nodes);
  spectating = watch;
  tutorial?.destroy();
  tutorial = null;
  campaign?.destroy();
  campaign = null;
  rival = settings.rival === 'random' ? RIVALS[Math.floor(Math.random() * RIVALS.length)] : settings.rival;
  if (watch) {
    leftRival = settings.watchLeft === 'random' ? RIVALS[Math.floor(Math.random() * RIVALS.length)] : settings.watchLeft;
    ai0 = createAi(0, settings.difficulty, settings.seed + 7, true, leftRival);
    watchSpeed = 1;
    setWatchSpeed(1);
  } else ai0 = null;
  const myCommander = watch ? PERSONALITIES[leftRival].commander : settings.commander;
  // No fog while watching: an observer sees the whole war.
  if (tutorialMode) {
    rival = 'turtle';
    game = createGame(tutorialMap(), { noClock: true, commanders: [settings.commander, 'none'] });
    setupTutorialGame(game);
    tutorial = new Tutorial(app, () => toast('Tutorial skipped: the war carries on', 'skip'));
    // The lessons assume the default send amount and stance.
    setRatio(0.5);
    setStance('assault');
  } else if (mission) {
    // A campaign mission: its own map, garrisons, rival and objective; no war clock.
    rival = mission.rival;
    game = createMissionGame(mission, settings.commander);
    campaign = new CampaignRun(app, mission, game, (text) => toast(text, `camp:${text}`, false, true));
  } else game = createGame(map, { fog: !watch && settings.fog === 'on', commanders: [myCommander, PERSONALITIES[rival].commander] });
  bv.spectating = watch;
  bv.teach = tutorialMode;
  // In the campaign, events you have never tried are demonstrated the first time they come up.
  bv.teachNew = !!mission;
  bv.names = names();
  document.querySelector('.force.you .lbl')!.textContent = names()[0];
  $('spec-names').textContent = `${PERSONALITIES[leftRival].name} (${PERSONALITIES[leftRival].label}) vs ${PERSONALITIES[rival].name} (${PERSONALITIES[rival].label})`;
  $('spectator').classList.toggle('hidden', !watch);
  bv.perks = { volleyEase: settings.commander === 'archer', duelGrace: settings.commander === 'duelist' ? 0.1 : 0 };
  document.querySelector('.force.foe .lbl')!.textContent = PERSONALITIES[rival].short;
  document.querySelector('.force.foe .lbl')!.setAttribute('title', `${PERSONALITIES[rival].name} (${PERSONALITIES[rival].label})`);
  selected.clear();
  targeting = null;
  ai = createAi(1, tutorialMode ? 'easy' : mission ? mission.difficulty : settings.difficulty, settings.seed, true, rival);
  renderer.setMap(game.map);
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
  $('dock').classList.toggle('hidden', watch);
  setMusic(true);
}

function setWatchSpeed(x: number) {
  watchSpeed = x;
  document.querySelectorAll<HTMLElement>('#spec-speed button').forEach((b) => b.classList.toggle('on', Number(b.dataset.x) === x));
}

function showEnd() {
  if (!game) return;
  bv.hide();
  game.presence[0] = null;
  const won = game.winner === 0;
  setMusic(false);
  sfx(won || spectating ? 'victory' : 'defeat');
  const [n0, n1] = names();
  $('end-title').textContent = campaign && won ? 'MISSION COMPLETE' : tutorial && won ? 'TUTORIAL COMPLETE' : spectating ? `${game.winner === 0 ? n0 : n1} wins`.toUpperCase() : won ? 'VICTORY' : 'DEFEAT';
  $('end-title').className = `title ${won || spectating ? 'win' : 'loss'}`;
  const t = Math.floor(game.time);
  if (spectating) {
    const loser = (1 - (game.winner ?? 0)) as 0 | 1;
    const how = game.nodes[game.map.capitals[loser]].owner === game.winner ? 'took the enemy capital' : game.time >= MATCH_TIME ? 'held more ground when the war clock ran out' : 'wiped out the enemy';
    $('end-reason').textContent = `${game.winner === 0 ? PERSONALITIES[leftRival].name : PERSONALITIES[rival].name} ${how} after ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}.`;
  } else $('end-reason').textContent = `${game.winReason} after ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}. You led as ${COMMANDERS[settings.commander].label} against ${PERSONALITIES[rival].name} (${PERSONALITIES[rival].label}, ${COMMANDERS[PERSONALITIES[rival].commander].label}).`;
  const [a, b] = game.stats;
  const pct = (h: number, p: number) => (p ? `${Math.round((100 * h) / p)}%` : '–');
  const row = (l: string, x: string | number, y: string | number) => `<tr><td>${l}</td><td>${x}</td><td>${y}</td></tr>`;
  $('end-stats').innerHTML =
    `<tr><th></th><th>${n0}</th><th>${n1}</th></tr>` +
    row('Battles fought / won', `${a.battlesFought} / ${a.battlesWon}`, `${b.battlesFought} / ${b.battlesWon}`) +
    row('Quick-time events', `${a.qteHit} / ${a.qtePlayed} (${pct(a.qteHit, a.qtePlayed)})`, `${b.qteHit} / ${b.qtePlayed} (${pct(b.qteHit, b.qtePlayed)})`) +
    row('Charges / retreats', `${a.finishers} / ${a.retreats}`, `${b.finishers} / ${b.retreats}`) +
    row('Duels won', `${a.duelsWon} / ${a.duels}`, `${b.duelsWon} / ${b.duels}`) +
    row('Strongholds taken', a.nodesTaken, b.nodesTaken) +
    row('Troops sent', a.troopsSent, b.troopsSent);
  // Campaign: stars, saved progress, and the way on.
  const endStars = $('end-stars');
  endStars.classList.toggle('hidden', !campaign);
  $('next-mission').classList.add('hidden');
  $('rematch').textContent = campaign ? 'Retry mission' : 'Rematch (same map)';
  $('newgame').textContent = campaign ? 'Campaign' : 'New war';
  if (campaign) {
    const m = campaign.mission;
    const got = starsFor(m, game, campaign.stats);
    const before = campaignStars[m.id] ?? 0;
    if (got) saveStars(m.id, got);
    const goals = [{ text: m.objectiveText, ok: won }, ...m.stars.map((st) => ({ text: st.text, ok: won && st.test(game!, campaign!.stats) }))];
    endStars.innerHTML = `<div class="big">${[0, 1, 2].map((i) => `<span class="${i < got ? 'on' : ''}">★</span>`).join('')}</div>` +
      `<ul>${goals.map((x) => `<li class="${x.ok ? 'ok' : ''}">${x.ok ? '★' : '☆'} ${x.text}</li>`).join('')}</ul>` +
      (got > before && before ? `<p class="sub">New best: ${got} stars (was ${before}).</p>` : '');
    const idx = MISSIONS.indexOf(m);
    if (won && idx < MISSIONS.length - 1) $('next-mission').classList.remove('hidden');
    if (won && idx === MISSIONS.length - 1) $('end-reason').textContent += ' The Border War is won.';
  }
  $('end').classList.remove('hidden');
}

function enterBattle(id: number) {
  if (!game || game.winner !== null) return;
  const b = getBattle(game, id);
  if (!b || b.endedAt !== null || (!spectating && (sideOf(b, 0)?.troops ?? 0) <= 0.5)) {
    toast('You have no troops in that battle', 'notin');
    return;
  }
  drag = null;
  if (!spectating) game.presence[0] = id;
  bv.show(id);
}

function leaveBattle() {
  if (game && !spectating) game.presence[0] = null;
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
  if (spectating) {
    if (e.button !== 0) return;
    const bid = renderer.battleAt(game, e.offsetX, e.offsetY);
    const n = renderer.nodeAt(game, e.offsetX, e.offsetY);
    const id = bid ?? (n !== null ? game.nodes[n].battleId : null);
    if (id !== null) enterBattle(id);
    return;
  }
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
  // Clicking one of your marching columns turns it around (if the click is nearer the column than any stronghold).
  const w = renderer.s2w(x, y);
  const col = game.columns
    .filter((c) => c.owner === 0)
    .map((c) => ({ c, d: Math.hypot(columnPos(game!, c).x - w.x, columnPos(game!, c).y - w.y) }))
    .sort((p, q) => p.d - q.d)[0];
  const nodeDist = n !== null ? Math.hypot(game.map.nodes[n].x - w.x, game.map.nodes[n].y - w.y) : Infinity;
  if (col && col.d < 34 && col.d < nodeDist && reverseColumn(game, 0, col.c.id)) {
    sfx('retreat');
    tutorial?.notify('reverse');
    toast(`Column turned back toward ${game.map.nodes[col.c.path[0]].name}`, 'reverse');
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
  const troops = !known.live ? `about ${Math.floor(known.troops)} troops when last seen` : known.exact ? `${Math.floor(ns.troops)} troops` : `roughly ${known.troops} troops (too far to count exactly)`;
  const growth = st.growth * (n.special === 'barracks' ? 1.5 : 1);
  // Watchtowers only matter under fog of war, so they stay hidden otherwise.
  const special = n.special && (n.special !== 'watchtower' || game.fog) ? `<br><b class="sp">${SPECIALS[n.special].label}:</b> ${SPECIALS[n.special].desc}` : '';
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
// Resign: offered only while you are behind; the first click asks, the second confirms.
let resignAsk = -1;
$('btn-resign').addEventListener('click', () => {
  if (!game || game.winner !== null) return;
  if (now - resignAsk > 3) {
    resignAsk = now;
    $('btn-resign').textContent = 'Really resign?';
    return;
  }
  resign(game, 0);
});
$('btn-help').addEventListener('click', () => $('help').classList.toggle('hidden'));
$('help-close').addEventListener('click', () => $('help').classList.add('hidden'));
$('rematch').addEventListener('click', () => (campaign ? startGame(false, false, campaign.mission) : tutorial ? startTutorial() : startGame(spectating)));
$('next-mission').addEventListener('click', () => {
  if (!campaign) return;
  campaignPick = MISSIONS.indexOf(campaign.mission) + 1;
  startGame(false, false, MISSIONS[campaignPick]);
});
$('newgame').addEventListener('click', () => {
  $('spectator').classList.add('hidden');
  tutorial?.destroy();
  tutorial = null;
  const fromCampaign = !!campaign;
  campaign?.destroy();
  campaign = null;
  if (fromCampaign) {
    $('end').classList.add('hidden');
    document.querySelector('.hud-top')!.classList.add('hidden');
    $('dock').classList.add('hidden');
    game = null;
    openCampaign();
    return;
  }
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
  // Resign is only offered when you are behind (by what you can see of the enemy).
  const held0 = g.nodes.filter((n) => n.owner === 0).length;
  const held1 = g.nodes.filter((n) => (hidden ? knownNode(g, 0, n.id).owner : n.owner) === 1).length;
  // Never in the opening 30 s: some campaign missions start you behind on purpose.
  const behind = g.time > 30 && (t0 < t1 * 0.8 || (held0 < held1 && t0 < t1));
  $('btn-resign').classList.toggle('hidden', !behind || spectating || !!tutorial || g.winner !== null);
  if (now - resignAsk > 3) $('btn-resign').textContent = 'Resign';
  // War clock counts down; at zero, whoever holds more strongholds wins.
  const s = Math.max(0, Math.ceil(MATCH_TIME - g.time));
  const mmss = (x: number) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
  const left = campaign?.timeLeft(g) ?? null;
  $('clock').textContent = campaign ? (left !== null ? `${mmss(left)} left` : mmss(g.time)) : g.noClock ? 'Tutorial' : `${mmss(s)} left`;
  $('clock').classList.toggle('urgent', campaign ? left !== null && left <= 30 : !g.noClock && s <= 120);
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
  // The rally meter is banked between battles.
  $('dock-rally-fill').style.width = `${g.meter[0] * 100}%`;
  $('dock-rally').classList.toggle('full', g.meter[0] >= 1);
  $('dock-rally').querySelector('span')!.textContent = g.meter[0] >= 1 ? 'Charge ready' : 'Rally';
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
    if (spectating) {
      const [n0, n1] = names();
      const place = /took (.+)$/.exec(e.text)?.[1] ?? /^(.+) has fallen$/.exec(e.text)?.[1];
      if ((e.kind === 'captured' || e.kind === 'lost') && place) toast(`${e.kind === 'lost' || e.owner === 1 ? n1 : n0} took ${place}`, key, e.owner === 0);
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
  // The tutorial freezes the war while you read, and while a new event is being demonstrated.
  const reading = !!tutorial?.frozen;
  if (!paused && game.winner === null) {
    if (!reading && !bv.lesson) {
      acc += dt * (spectating ? watchSpeed : 1);
      while (acc >= STEP) {
        if (ai0) aiStep(game, ai0, STEP);
        if (campaign) ai.passive = campaign.passive(game);
        if (tutorial) {
          ai.passive = !tutorial.enemyFree;
          ai.pinned = tutorial.duelBattle;
        }
        if (!tutorial || tutorial.aiActive) aiStep(game, ai, STEP);
        step(game, STEP);
        acc -= STEP;
      }
    }
    // While reading, a battle that is already over may still close itself.
    const over = bv.battleId !== null && getBattle(game, bv.battleId)?.endedAt != null;
    if (!reading || over) bv.update(game, dt);
  }
  if (bv.open) bv.render(game);
  else {
    const ui = { hover, drag, now, selected, box, rallyDrag, targeting, spectate: spectating, names: names(), highlight: tutorial?.highlight(game) ?? [] };
    renderer.draw(game, ui);
    renderer.drawOverlay(ui);
  }
  updateHud(game);
  tutorial?.update(game, { bvOpen: bv.open, bvBattleId: bv.battleId });
  campaign?.update(game, bv.open);
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
