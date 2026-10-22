import { PERSONALITIES, type Difficulty, type Personality } from './ai';
import { generateMap, type Edge, type GraphMap, type MapNode, type RoadKind, type Special } from './map';
import { activeBattles, createGame, sendTroops, type CommanderId, type Game, type Owner, type QteKind, type Stance } from './sim';

/**
 * The campaign: "The Border War". Ten missions against the four rivals, each on a hand-made map
 * with its own objective, scripted moments and two bonus stars.
 */

type NodeSpec = [name: string, x: number, y: number, kind: MapNode['kind'], owner: Owner, troops: number, special?: Special];
type EdgeSpec = [a: number, b: number, road?: RoadKind];

/** Build a hand-made map. Capitals are the first capital owned by each side. */
function build(seed: number, nodes: NodeSpec[], edges: EdgeSpec[]): { map: GraphMap; owners: [Owner, number][] } {
  const ns: MapNode[] = nodes.map(([name, x, y, kind, , , special], id) => ({ id, name, x, y, kind, special: special ?? null }));
  const es: Edge[] = edges.map(([a, b, road]) => ({ a, b, len: Math.hypot(ns[a].x - ns[b].x, ns[a].y - ns[b].y), road: road ?? 'road' }));
  const adj: number[][] = ns.map(() => []);
  for (const e of es) {
    adj[e.a].push(e.b);
    adj[e.b].push(e.a);
  }
  const c0 = nodes.findIndex((n) => n[3] === 'capital' && n[4] === 0);
  const c1 = nodes.findIndex((n) => n[3] === 'capital' && n[4] === 1);
  const mirror = ns.map((n) => n.id);
  mirror[c0] = c1;
  mirror[c1] = c0;
  return { map: { nodes: ns, edges: es, adj, mirror, capitals: [c0, c1], seed }, owners: nodes.map((n) => [n[4], n[5]]) };
}

export type Objective =
  | { kind: 'capital' }
  | { kind: 'capture'; nodes: number[]; within?: number }
  | { kind: 'hold'; node: number; until: number }
  | { kind: 'survive'; until: number };

/** What the campaign tracks during a mission, for objectives and stars. */
export interface MissionStats {
  lost: number;
  /** Strongholds you have lost at least once. */
  lostIds: number[];
  battlesLost: number;
  roadWins: number;
  hits: Partial<Record<QteKind, number>>;
  takenFromEnemy: number;
}

interface Star {
  text: string;
  test: (g: Game, s: MissionStats) => boolean;
  /** For goals you keep rather than earn (time limits, no losses): already out of reach? */
  failed?: (g: Game, s: MissionStats) => boolean;
}

interface Scripted {
  at: number;
  text?: string;
  /** An enemy column: troops appear at `from` (if the enemy still holds it) and march on `to`. */
  wave?: { from: number; to: number; troops: number; stance?: Stance };
  /** Extra troops for whoever holds a node. */
  reinforce?: { node: number; troops: number };
}

export interface Mission {
  id: string;
  act: string;
  title: string;
  rival: Personality;
  difficulty: Difficulty;
  fog?: boolean;
  /** The enemy defends only for this many seconds (Infinity: the whole mission). */
  passiveFor?: number;
  story: string;
  objectiveText: string;
  objective: Objective;
  stars: [Star, Star];
  script?: Scripted[];
  /** A short tip shown in the briefing. */
  tip: string;
  make: () => { map: GraphMap; owners: [Owner, number][] };
}

const mins = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const within = (secs: number): Star => ({ text: `Win within ${mins(secs)}`, test: (g) => g.time <= secs, failed: (g) => g.time > secs });
const noLosses: Star = { text: 'Lose no stronghold', test: (_g, s) => s.lost === 0, failed: (_g, s) => s.lost > 0 };

export const MISSIONS: Mission[] = [
  {
    id: 'm1',
    act: 'Act I · The Wall',
    title: 'The Border Villages',
    rival: 'turtle',
    difficulty: 'easy',
    passiveFor: Infinity,
    story:
      'Lady Morwen has walled off the eastern valley and claims the border villages as hers. They have no garrison worth the name yet. Ride out from Westmarch and plant your banner before her wardens arrive.',
    objectiveText: 'Capture Aldbrook, Fenwick and Harrowgate within 5:00.',
    objective: { kind: 'capture', nodes: [1, 2, 3], within: 300 },
    stars: [within(90), { text: 'Win every battle you fight', test: (_g, s) => s.battlesLost === 0, failed: (_g, s) => s.battlesLost > 0 }],
    tip: 'Split your troops: two columns at once take ground twice as fast. Harrowgate has a Forge: battles next to it start with extra momentum.',
    make: () =>
      build(
        101,
        [
          ['Westmarch', 200, 450, 'capital', 0, 45],
          ['Aldbrook', 480, 260, 'village', 2, 10],
          ['Fenwick', 500, 640, 'village', 2, 12],
          ['Harrowgate', 780, 450, 'village', 2, 18, 'forge'],
          ['Coldwater', 1060, 290, 'village', 1, 14],
          ['Wallmere', 1400, 450, 'capital', 1, 40],
          ['Bramblefield', 1060, 640, 'village', 2, 12],
        ],
        [[0, 1], [0, 2], [1, 2], [1, 3], [2, 3], [3, 4], [3, 6], [4, 5], [6, 5], [4, 6]],
      ),
  },
  {
    id: 'm2',
    act: 'Act I · The Wall',
    title: 'Greywall',
    rival: 'turtle',
    difficulty: 'easy',
    story:
      'Morwen answered with stone. Greywall, a fort astride the valley road, now shelters her wardens. Its walls make every defender fight harder, so bring the ram: a cracked gate brings the walls down.',
    objectiveText: 'Capture the fort of Greywall.',
    objective: { kind: 'capture', nodes: [3] },
    stars: [{ text: 'Breach the gate twice (Battering Ram)', test: (_g, s) => (s.hits.ram ?? 0) >= 2 }, within(240)],
    tip: 'Attack forts with the Assault stance and a big column. Inside the battle, the Battering Ram appears: click the gate on three beats.',
    make: () =>
      build(
        102,
        [
          ['Westmarch', 180, 450, 'capital', 0, 55],
          ['Millrace', 430, 280, 'village', 0, 15],
          ['Sedgeford', 430, 640, 'village', 0, 12],
          ['Greywall', 770, 450, 'fort', 1, 38],
          ['Ashby', 1060, 250, 'village', 1, 12],
          ['Wallmere', 1420, 450, 'capital', 1, 45],
          ['Thornby', 1060, 660, 'village', 2, 12],
        ],
        [[0, 1], [0, 2], [1, 2], [1, 3], [2, 3], [3, 4], [3, 6], [4, 5], [6, 5]],
      ),
  },
  {
    id: 'm3',
    act: 'Act I · The Wall',
    title: 'Hold Greywall',
    rival: 'turtle',
    difficulty: 'normal',
    passiveFor: 20,
    story:
      'Greywall is yours, and Morwen wants it back. Her scouts report four assaults coming in waves. Hold the fort for three minutes and she will sue for peace. From the battlements, boiling oil is your friend.',
    objectiveText: 'Hold Greywall until 3:00. If it falls, the mission is lost.',
    objective: { kind: 'hold', node: 3, until: 180 },
    stars: [noLosses, { text: 'Pour Boiling Oil 3 times', test: (_g, s) => (s.hits.oil ?? 0) >= 3 }],
    tip: 'Step into the defence when a wave hits: Boiling Oil only appears for defenders on walls. Set a rally route from Westmarch to Greywall.',
    script: [
      { at: 20, text: "Morwen's banners on the horizon!", wave: { from: 4, to: 3, troops: 22, stance: 'assault' } },
      { at: 65, wave: { from: 6, to: 3, troops: 26, stance: 'assault' } },
      { at: 110, text: 'A larger host marches from Wallmere.', wave: { from: 5, to: 3, troops: 34, stance: 'assault' } },
      { at: 150, text: 'The final assault!', wave: { from: 4, to: 3, troops: 40, stance: 'assault' } },
    ],
    make: () =>
      build(
        103,
        [
          ['Westmarch', 180, 450, 'capital', 0, 45],
          ['Millrace', 430, 280, 'village', 0, 14],
          ['Sedgeford', 430, 640, 'village', 0, 14],
          ['Greywall', 770, 450, 'fort', 0, 40],
          ['Ashby', 1060, 250, 'village', 1, 16],
          ['Wallmere', 1420, 450, 'capital', 1, 50],
          ['Thornby', 1060, 660, 'village', 1, 16],
        ],
        [[0, 1], [0, 2], [1, 2], [1, 3], [2, 3], [3, 4], [3, 6], [4, 5], [6, 5]],
      ),
  },
  {
    id: 'm4',
    act: 'Act II · The Fox',
    title: 'Marsh of Whispers',
    rival: 'opportunist',
    difficulty: 'easy',
    fog: true,
    story:
      'With Morwen quiet, Silas Quickfinger strikes from the fens. He fights where you are not looking, and in this mist you cannot see much. The Hollow Tower in the middle of the marsh sees far.',
    objectiveText: "Take Quickmere, Silas's capital.",
    objective: { kind: 'capital' },
    stars: [{ text: 'Win without using Spy', test: (g) => g.abilityReady[0].spy === 0, failed: (g) => g.abilityReady[0].spy > 0 }, within(420)],
    tip: 'Marsh roads (green) are slow. Take the Hollow Tower (a Watchtower) early: its long sight lifts the fog for you.',
    make: () =>
      build(
        104,
        [
          ['Westmarch', 160, 450, 'capital', 0, 50],
          ['Reedholm', 400, 250, 'village', 2, 10],
          ['Mirefield', 400, 660, 'village', 2, 10],
          ['Hollow Tower', 720, 450, 'village', 2, 14, 'watchtower'],
          ['Bogsend', 990, 200, 'village', 2, 10],
          ['Silverfen', 990, 700, 'fort', 2, 18],
          ['Gloamwood', 1190, 450, 'village', 1, 12],
          ['Quickmere', 1450, 450, 'capital', 1, 40],
        ],
        [[0, 1, 'marsh'], [0, 2], [1, 2, 'marsh'], [1, 3, 'marsh'], [2, 3], [1, 4], [3, 4, 'marsh'], [3, 5], [2, 5, 'marsh'], [4, 6], [5, 6, 'marsh'], [4, 7], [6, 7], [5, 7]],
      ),
  },
  {
    id: 'm5',
    act: 'Act II · The Fox',
    title: 'Two Fronts',
    rival: 'opportunist',
    difficulty: 'easy',
    story:
      'Silas has built twin forts, Northwatch and Southwatch, to pin you between them. You cannot be in both places at once, and he knows it. Take both forts and his trap becomes your gate.',
    objectiveText: 'Capture Northwatch and Southwatch within 8:00.',
    objective: { kind: 'capture', nodes: [3, 4], within: 480 },
    stars: [noLosses, { text: 'Win a commander duel', test: (g) => g.stats[0].duelsWon > 0 }],
    tip: 'Watch the enemy flag: Silas attacks where your commander is not. Midmoor holds a Shrine, which strengthens quick-time events next to it.',
    make: () =>
      build(
        105,
        [
          ['Westmarch', 300, 450, 'capital', 0, 55],
          ['Northgate', 560, 220, 'village', 0, 15],
          ['Southgate', 560, 680, 'village', 0, 15],
          ['Northwatch', 900, 180, 'fort', 1, 22],
          ['Southwatch', 900, 720, 'fort', 1, 22],
          ['Midmoor', 830, 450, 'village', 2, 14, 'shrine'],
          ['Quickmere', 1400, 450, 'capital', 1, 35],
          ['Highfold', 1180, 250, 'village', 1, 8],
          ['Lowfold', 1180, 650, 'village', 1, 8],
        ],
        [[0, 1], [0, 2], [0, 5], [1, 3], [2, 4], [1, 5], [2, 5], [3, 7], [4, 8], [5, 6], [7, 6], [8, 6]],
      ),
  },
  {
    id: 'm6',
    act: 'Act III · The Gambler',
    title: "The Gambler's Bridge",
    rival: 'gambler',
    difficulty: 'normal',
    story:
      'Captain Rook bets everything, often. His lands lie across the Saltwash, joined to yours by one paved bridge and a long marsh trail. Whoever holds the bridgeheads holds the war.',
    objectiveText: "Take Fortune's Rest, Rook's capital.",
    objective: { kind: 'capital' },
    stars: [{ text: 'Never lose the West Bridgehead', test: (_g, s) => !s.lostIds.includes(3), failed: (_g, s) => s.lostIds.includes(3) }, within(480)],
    tip: 'Rook sometimes throws everything at one target. Keep a reserve, and let him break himself on your fort before you counter.',
    make: () =>
      build(
        106,
        [
          ['Westmarch', 180, 450, 'capital', 0, 40],
          ['Ferrow', 420, 250, 'village', 0, 10],
          ['Dunmore', 420, 670, 'village', 0, 10, 'barracks'],
          ['West Bridgehead', 680, 450, 'fort', 0, 18],
          ['East Bridgehead', 940, 450, 'fort', 1, 18],
          ['Crowhill', 1180, 250, 'village', 1, 10],
          ['Saltmarsh', 1180, 670, 'village', 1, 10],
          ["Fortune's Rest", 1420, 450, 'capital', 1, 40],
          ['Fogbottom', 800, 800, 'village', 2, 10],
        ],
        [[0, 1], [0, 2], [1, 2], [1, 3], [2, 3], [3, 4, 'paved'], [4, 5], [4, 6], [5, 7], [6, 7], [2, 8, 'marsh'], [8, 6, 'marsh']],
      ),
  },
  {
    id: 'm7',
    act: 'Act III · The Gambler',
    title: 'Outnumbered',
    rival: 'gambler',
    difficulty: 'hard',
    story:
      'Rook has raised a host twice your size and rolled the dice on one great push. You cannot match him in the field. Keep Westmarch standing for three minutes, until the levies from the west arrive.',
    objectiveText: 'Keep Westmarch until 3:00 (or take his capital).',
    objective: { kind: 'survive', until: 180 },
    stars: [{ text: 'Never lose Kingsrest', test: (_g, s) => !s.lostIds.includes(3), failed: (_g, s) => s.lostIds.includes(3) }, { text: 'Take any enemy stronghold', test: (_g, s) => s.takenFromEnemy > 0 }],
    tip: 'Kingsrest is your shield: defenders on its walls fight ×1.4 and get Boiling Oil. Bank your Charge for the big assaults.',
    script: [
      { at: 5, text: 'Rook: "Let the dice decide."', wave: { from: 6, to: 3, troops: 20, stance: 'assault' } },
      { at: 60, text: "More of Rook's mercenaries arrive at Graves.", reinforce: { node: 6, troops: 30 } },
      { at: 110, text: 'Rook doubles down: a fresh host marches on Kingsrest.', wave: { from: 7, to: 3, troops: 45, stance: 'assault' } },
      { at: 150, text: 'The western levies are close. Hold!' },
    ],
    make: () =>
      build(
        107,
        [
          ['Westmarch', 180, 450, 'capital', 0, 50],
          ['Lastlight', 430, 280, 'village', 0, 12],
          ['Emberfield', 430, 640, 'village', 0, 12, 'forge'],
          ['Kingsrest', 720, 450, 'fort', 0, 20],
          ['Highcliff', 1000, 230, 'village', 1, 14],
          ['Redwater', 1000, 680, 'village', 1, 14],
          ['Graves', 1200, 450, 'fort', 1, 24],
          ["Fortune's Rest", 1450, 450, 'capital', 1, 60],
        ],
        [[0, 1], [0, 2], [1, 2], [1, 3], [2, 3], [3, 4], [3, 5], [3, 6], [4, 6], [5, 6], [4, 7], [6, 7], [5, 7]],
      ),
  },
  {
    id: 'm8',
    act: 'Act IV · The Relentless',
    title: "Raider's Roads",
    rival: 'aggressor',
    difficulty: 'normal',
    story:
      'Varric the Relentless has paved every road from Blackspur to your border, the better to raid you. His columns are fast and he never stops coming. Meet them on the roads and break them there.',
    objectiveText: "Take Blackspur, Varric's capital.",
    objective: { kind: 'capital' },
    stars: [{ text: 'Win a battle on an open road', test: (_g, s) => s.roadWins > 0 }, within(480)],
    tip: 'Enemy columns that meet yours on a road fight there, with no walls for anyone. Intercept his raids instead of waiting for them.',
    make: () =>
      build(
        108,
        [
          ['Westmarch', 180, 450, 'capital', 0, 55],
          ['Wayford', 420, 220, 'village', 2, 10],
          ['Coppergate', 420, 680, 'village', 2, 10],
          ['Crossway', 700, 450, 'village', 2, 14, 'forge'],
          ['Dustmere', 980, 200, 'village', 2, 12],
          ['Ironford', 980, 700, 'fort', 2, 18],
          ['Gallows Hill', 1200, 450, 'village', 1, 14],
          ['Blackspur', 1450, 450, 'capital', 1, 40],
        ],
        [[0, 1, 'paved'], [0, 2, 'paved'], [1, 3, 'paved'], [2, 3, 'paved'], [1, 4, 'paved'], [3, 4, 'paved'], [3, 5, 'paved'], [2, 5, 'paved'], [4, 6, 'paved'], [5, 6, 'paved'], [4, 7, 'paved'], [6, 7, 'paved'], [5, 7, 'paved']],
      ),
  },
  {
    id: 'm9',
    act: 'Act IV · The Relentless',
    title: 'The Iron Ring',
    rival: 'aggressor',
    difficulty: 'normal',
    story:
      'Beaten on the roads, Varric has pulled back behind the Iron Ring: two forts that guard every way into Blackspur. There is no way around. Bring rams.',
    objectiveText: 'Take Blackspur. The only roads in run through Northspur and Southspur.',
    objective: { kind: 'capital' },
    stars: [{ text: 'Breach 3 gates (Battering Ram)', test: (_g, s) => (s.hits.ram ?? 0) >= 3 }, within(540)],
    tip: 'Ashgrove is a Barracks: it grows troops 50% faster. Feed it into one fort at a time with a rally route.',
    make: () =>
      build(
        109,
        [
          ['Westmarch', 160, 450, 'capital', 0, 45],
          ['Ashgrove', 380, 230, 'village', 0, 12, 'barracks'],
          ['Larkspur', 380, 670, 'village', 0, 12],
          ['Stonebridge', 650, 450, 'village', 2, 14],
          ['Northspur', 1000, 250, 'fort', 1, 30],
          ['Southspur', 1000, 650, 'fort', 1, 30],
          ['Blackspur', 1400, 450, 'capital', 1, 50],
          ['Cinderfield', 720, 150, 'village', 2, 12, 'shrine'],
          ['Hollowmere', 720, 780, 'village', 2, 12],
        ],
        [[0, 1], [0, 2], [1, 3], [2, 3], [1, 7], [2, 8], [7, 4], [8, 5], [3, 4], [3, 5], [4, 6, 'paved'], [5, 6, 'paved'], [4, 5, 'paved']],
      ),
  },
  {
    id: 'm10',
    act: 'Finale',
    title: 'Holdfast',
    rival: 'aggressor',
    difficulty: 'hard',
    fog: true,
    story:
      'Varric has called in every debt: the fox, the gambler and the lady of the wall have all lent him men. A full war in the fog, on wide country, against the best of them. Win this and the border is yours for a generation.',
    objectiveText: "Take Varric's capital.",
    objective: { kind: 'capital' },
    stars: [{ text: 'Lose no more than 2 strongholds', test: (_g, s) => s.lost <= 2, failed: (_g, s) => s.lost > 2 }, within(720)],
    tip: 'Everything you have learned matters here: rally routes, banked Charges, breaching gates and reading the enemy flag.',
    make: () => {
      const map = generateMap(2610, 12);
      // A veteran realm by now: your capital starts with 50 (the enemy keeps the usual 30).
      const owners: [Owner, number][] = map.nodes.map((n) => [n.id === map.capitals[0] ? 0 : n.id === map.capitals[1] ? 1 : 2, n.id === map.capitals[0] ? 50 : 0]);
      return { map, owners };
    },
  },
];

/** A fresh game for a mission: its map, garrisons and rival commander; no war clock (missions keep their own time). */
export function createMissionGame(m: Mission, commander: CommanderId): Game {
  const made = m.make();
  const g = createGame(made.map, { fog: !!m.fog, noClock: true, commanders: [commander, PERSONALITIES[m.rival].commander] });
  made.owners.forEach(([owner, troops], id) => {
    if (!troops) return;
    g.nodes[id].owner = owner;
    g.nodes[id].troops = troops;
  });
  for (const mem of g.memory) for (const n of g.nodes) mem[n.id] = { owner: n.owner, troops: n.troops, t: 0 };
  return g;
}

/** Stars won for a finished mission: the win itself plus each bonus goal. */
export function starsFor(m: Mission, g: Game, s: MissionStats): number {
  if (g.winner !== 0) return 0;
  return 1 + m.stars.filter((st) => st.test(g, s)).length;
}

/** Runs one mission: scripted moments, the objective, the stats behind the stars, and the objective panel. */
export class CampaignRun {
  stats: MissionStats = { lost: 0, lostIds: [], battlesLost: 0, roadWins: 0, hits: {}, takenFromEnemy: 0 };
  private fired = new Set<number>();
  private owned = new Set<number>();
  private enemyStart = new Set<number>();
  private seenEnded = new Set<number>();
  private panel: HTMLElement | null = null;
  private lastHtml = '';

  constructor(
    root: HTMLElement | null,
    readonly mission: Mission,
    g: Game,
    private toast: (text: string) => void,
  ) {
    if (root) {
      this.panel = document.createElement('div');
      this.panel.className = 'objective';
      root.appendChild(this.panel);
    }
    for (const n of g.nodes) {
      if (n.owner === 0) this.owned.add(n.id);
      if (n.owner === 1) this.enemyStart.add(n.id);
    }
  }

  /** The enemy is held back while the mission says so. */
  passive(g: Game): boolean {
    // Every mission gives you a few seconds to read the map before the enemy moves.
    return g.time < (this.mission.passiveFor ?? 10);
  }

  noteQte(kind: QteKind, success: boolean) {
    if (success) this.stats.hits[kind] = (this.stats.hits[kind] ?? 0) + 1;
  }

  destroy() {
    this.panel?.remove();
  }

  update(g: Game, hidden: boolean) {
    this.panel?.classList.toggle('hidden', hidden);
    if (g.winner === null) {
      this.track(g);
      this.runScript(g);
      this.checkObjective(g);
    }
    this.render(g);
  }

  private track(g: Game) {
    for (const n of g.nodes) {
      const mine = n.owner === 0;
      if (this.owned.has(n.id) && !mine) {
        this.owned.delete(n.id);
        this.stats.lost++;
        if (!this.stats.lostIds.includes(n.id)) this.stats.lostIds.push(n.id);
      } else if (!this.owned.has(n.id) && mine) {
        this.owned.add(n.id);
        if (this.enemyStart.has(n.id)) this.stats.takenFromEnemy++;
      }
    }
    for (const b of g.battles) {
      if (b.endedAt === null || this.seenEnded.has(b.id)) continue;
      this.seenEnded.add(b.id);
      if (!b.peak[0]) continue;
      if (b.winner === 0 && b.nodeId === null) this.stats.roadWins++;
      // A battle you were in and did not win (a held node counts as a win).
      const held = b.nodeId !== null && g.nodes[b.nodeId].owner === 0;
      if (b.winner !== 0 && !held) this.stats.battlesLost++;
    }
  }

  private runScript(g: Game) {
    (this.mission.script ?? []).forEach((s, i) => {
      if (this.fired.has(i) || g.time < s.at) return;
      this.fired.add(i);
      if (s.text) this.toast(s.text);
      if (s.wave && g.nodes[s.wave.from].owner === 1) {
        g.nodes[s.wave.from].troops += s.wave.troops;
        sendTroops(g, 1, s.wave.from, s.wave.to, s.wave.troops, s.wave.stance ?? 'assault');
      }
      if (s.reinforce && g.nodes[s.reinforce.node].owner !== 2) g.nodes[s.reinforce.node].troops += s.reinforce.troops;
    });
  }

  private checkObjective(g: Game) {
    const o = this.mission.objective;
    const win = (why: string) => {
      g.winner = 0;
      g.winReason = why;
    };
    const lose = (why: string) => {
      g.winner = 1;
      g.winReason = why;
    };
    const name = (id: number) => g.map.nodes[id].name;
    if (o.kind === 'capture') {
      if (o.nodes.every((id) => g.nodes[id].owner === 0)) {
        const names = o.nodes.map(name);
        win(`You took ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]}`);
      }
      else if (o.within && g.time >= o.within) lose('Time ran out');
    } else if (o.kind === 'hold') {
      if (g.nodes[o.node].owner !== 0 && !activeBattles(g).some((b) => b.nodeId === o.node)) lose(`${name(o.node)} fell`);
      else if (g.time >= o.until && g.nodes[o.node].owner === 0) win(`You held ${name(o.node)}`);
    } else if (o.kind === 'survive') {
      if (g.time >= o.until && g.nodes[g.map.capitals[0]].owner === 0) win('The levies arrived: Westmarch stands');
    }
  }

  /** Seconds left on the objective's clock, if it has one. */
  timeLeft(g: Game): number | null {
    const o = this.mission.objective;
    const until = o.kind === 'hold' || o.kind === 'survive' ? o.until : o.kind === 'capture' ? o.within : undefined;
    return until === undefined ? null : Math.max(0, until - g.time);
  }

  private render(g: Game) {
    if (!this.panel) return;
    const left = this.timeLeft(g);
    const o = this.mission.objective;
    const progress =
      o.kind === 'capture'
        ? o.nodes.map((id) => `<span class="${g.nodes[id].owner === 0 ? 'done' : ''}">${g.map.nodes[id].name}</span>`).join(' · ')
        : '';
    const stars = this.mission.stars
      .map((s) => {
        const state = s.failed ? (s.failed(g, this.stats) ? 'failed' : '') : s.test(g, this.stats) ? 'done' : '';
        return `<li class="${state}">${state === 'done' ? '★' : '☆'} ${s.text}</li>`;
      })
      .join('');
    const html = `
      <div class="obj-head">${this.mission.title}${left !== null ? `<b class="${left < 30 ? 'urgent' : ''}">${mins(left)}</b>` : ''}</div>
      <p>${this.mission.objectiveText}</p>
      ${progress ? `<p class="obj-progress">${progress}</p>` : ''}
      <ul>${stars}</ul>`;
    if (html !== this.lastHtml) {
      this.panel.innerHTML = html;
      this.lastHtml = html;
    }
  }
}
