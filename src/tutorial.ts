import type { GraphMap, MapNode, Edge } from './map';
import { activeBattles, sendTroops, sideOf, type Game } from './sim';

/** A small hand-made map for the tutorial: your capital in the west, the enemy in the east. */
export function tutorialMap(): GraphMap {
  const n = (id: number, x: number, y: number, kind: MapNode['kind'], name: string): MapNode => ({ id, x, y, kind, name, special: null });
  const nodes: MapNode[] = [
    n(0, 190, 450, 'capital', 'Westhold'),
    n(1, 520, 300, 'village', 'Eastbrook'),
    n(2, 520, 620, 'village', 'Millbrook'),
    n(3, 830, 450, 'fort', 'Stonegate'),
    n(4, 1130, 300, 'village', 'Rookfield'),
    n(5, 1430, 450, 'capital', 'Ironmere'),
    n(6, 1130, 620, 'village', 'Ashwater'),
  ];
  const pairs: [number, number][] = [
    [0, 1],
    [0, 2],
    [1, 2],
    [1, 3],
    [2, 3],
    [3, 4],
    [3, 6],
    [4, 5],
    [6, 5],
    [4, 6],
  ];
  const edges: Edge[] = pairs.map(([a, b]) => ({ a, b, len: Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y), road: 'road' }));
  const adj: number[][] = nodes.map(() => []);
  for (const e of edges) {
    adj[e.a].push(e.b);
    adj[e.b].push(e.a);
  }
  const mirror = nodes.map((x) => x.id);
  mirror[0] = 5;
  mirror[5] = 0;
  return { nodes, edges, adj, mirror, capitals: [0, 5], seed: 7 };
}

/** Starting garrisons for the tutorial. */
export function setupTutorialGame(g: Game) {
  const t: Record<number, [0 | 1 | 2, number]> = { 0: [0, 60], 1: [2, 24], 2: [2, 12], 3: [2, 18], 4: [1, 14], 5: [1, 34], 6: [2, 12] };
  for (const [id, [owner, troops]] of Object.entries(t)) {
    g.nodes[Number(id)].owner = owner;
    g.nodes[Number(id)].troops = troops;
  }
  for (const m of g.memory) for (const [id, [owner, troops]] of Object.entries(t)) m[Number(id)] = { owner, troops, t: 0 };
}

export interface TutorialView {
  bvOpen: boolean;
  bvBattleId: number | null;
}

interface Step {
  title: string;
  /** Text shown in the coach panel (can depend on the game). */
  text: (g: Game, t: Tutorial) => string;
  /** Show a "Next" button instead of waiting for an action. */
  next?: boolean;
  /** The step is complete when this returns true (checked every frame). */
  done?: (g: Game, v: TutorialView, t: Tutorial) => boolean;
  /** Strongholds to highlight on the map. */
  highlight?: (g: Game, t: Tutorial) => number[];
  /** Runs once when the step starts. */
  enter?: (g: Game, t: Tutorial) => void;
}

const playerColumnTo = (g: Game, node: number) => g.columns.some((c) => c.owner === 0 && c.path[c.path.length - 1] === node);
const battleAt = (g: Game, node: number) => activeBattles(g).find((b) => b.nodeId === node);

const STEPS: Step[] = [
  {
    title: 'Welcome to Holdfast',
    text: () =>
      'This is <b>Westhold</b>, your capital (the glowing red stronghold). The number is its garrison: troops grow there over time.<br><br>Your goal is to take <b>Ironmere</b>, the enemy capital far to the east. Battles are where you win it, and you will learn to fight them yourself.',
    next: true,
    highlight: () => [0, 5],
  },
  {
    title: 'Send troops',
    text: () =>
      'Press and hold on <b>Westhold</b>, drag to <b>Eastbrook</b> and let go. A column of half your troops (the <b>Send</b> setting at the bottom) marches down the road.',
    done: (g) => playerColumnTo(g, 1) || !!battleAt(g, 1) || g.nodes[1].owner === 0,
    highlight: () => [0, 1],
  },
  {
    title: 'Enter the battle',
    text: (g) =>
      battleAt(g, 1)
        ? 'The battle has started. <b>Click the crossed swords</b> above Eastbrook to fight in it yourself. Left alone, numbers decide a battle. Inside, you can swing it.'
        : 'Your column is marching. When it reaches Eastbrook a battle starts, marked by <b>crossed swords</b>. Click them to step inside.',
    done: (g, v) => v.bvOpen || g.nodes[1].owner === 0,
    highlight: () => [1],
  },
  {
    title: 'Quick-time events',
    text: () =>
      'Events pop up one after another: each one says what to do (click the target when the rings meet, click the incoming spear, drag along the line, hold on the banner, chase the runners).<br><br>Hits kill enemies or raise your <b>momentum</b> (the bar under your number). Misses explain what went wrong. Every hit also fills the <b>Rally</b> meter at the bottom.',
    done: (g, v) => {
      const b = activeBattles(g).find((x) => x.id === v.bvBattleId);
      return !b || (sideOf(b, 0)?.rally ?? 0) >= 1 || g.stats[0].qteHit >= 5;
    },
  },
  {
    title: 'Charge!',
    text: () => 'Your rally meter is full: click <b>CHARGE!</b> at the bottom to cut down a quarter of the enemy at once. The meter belongs to your commander, not this battle: if you leave, it comes with you, so later you can save a full meter for a fight that matters.',
    done: (g, v) => g.stats[0].finishers > 0 || !activeBattles(g).some((x) => x.id === v.bvBattleId && (sideOf(x, 0)?.rally ?? 0) >= 1),
  },
  {
    title: 'Strongholds',
    text: (g) =>
      g.nodes[1].owner === 0
        ? 'You took <b>Eastbrook</b>! Every stronghold you hold grows troops for you: <b>capitals</b> fast, <b>villages</b> steadily, <b>forts</b> slowly but with walls (defenders fight ×1.4). Hover any stronghold for its details.<br><br>Leave the battle screen (Esc or Back to map) when you are ready.'
        : 'Eastbrook is still holding out. Send more troops from Westhold and finish it. Strongholds you hold grow troops for you.',
    next: true,
    done: (g) => g.nodes[1].owner === 0,
    highlight: (g) => (g.nodes[1].owner === 0 ? [1] : [0, 1]),
  },
  {
    title: 'Attacking walls',
    text: () =>
      '<b>Stonegate</b> is a fort: its walls make defenders fight harder, so bring more. In the bottom bar, set <b>Send</b> to 75% and <b>Stance</b> to <b>Assault</b> (+20% damage), then send troops to Stonegate.<br><br>Tip: drag a box around several of your strongholds first to send from all of them at once.',
    done: (g) => playerColumnTo(g, 3) || !!battleAt(g, 3) || g.nodes[3].owner === 0,
    highlight: () => [3],
  },
  {
    title: 'Rally routes',
    text: () =>
      'Moving every reinforcement by hand gets busy. <b>Right-drag</b> from Westhold to Eastbrook to set a <b>rally route</b>: Westhold will forward its new troops there automatically (a green dashed arrow). Right-click a stronghold to clear its route.',
    done: (g) => g.nodes.some((n) => n.owner === 0 && n.rallyTo !== null),
    highlight: () => [0, 1],
  },
  {
    title: 'Orders',
    text: (g) =>
      (g.columns.some((c) => c.owner === 0) ? '' : 'Send a column somewhere first. ') +
      'Click <b>March</b> in the bottom bar, then click one of your marching columns: it moves twice as fast for 15 seconds. <b>Inspire</b> boosts a battle and <b>Spy</b> reveals the map; each order has a cooldown.',
    done: (g) => g.abilityReady[0].march > g.time,
  },
  {
    title: 'Turning back',
    text: (g) =>
      (g.columns.some((c) => c.owner === 0) ? '' : 'Send a column somewhere first. ') + 'Changed your mind? <b>Click one of your marching columns</b> to turn it around. It heads back to the stronghold it left.',
    done: (_g, _v, t) => t.flags.has('reverse'),
  },
  {
    title: 'The enemy strikes',
    enter: (g, t) => {
      // A scripted enemy attack on whichever of your strongholds is nearest to them.
      const mine = g.nodes.filter((n) => n.owner === 0).sort((a, b) => g.map.nodes[b.id].x - g.map.nodes[a.id].x);
      const target = mine[0]?.id ?? 0;
      t.attackTarget = target;
      g.nodes[5].troops = Math.max(g.nodes[5].troops, 40);
      sendTroops(g, 1, 5, target, 30, 'assault');
      t.aiActive = true;
      t.attackAt = g.time;
    },
    text: (g, t) =>
      `The enemy is marching on <b>${g.map.nodes[t.attackTarget].name}</b>! When its column arrives, a battle starts. The enemy has a commander too: its <b>flag</b> shows which battle it is boosting, and you can only be in one battle at a time.<br><br>Defend: send reinforcements, step into the battle, or press <b>Retreat</b> inside it to save 85% of your troops if it is hopeless. Red arrows inside a battle point to your other battles that are going badly.`,
    // Done once the attack is over, however it ended (even if the columns met on a road).
    done: (g, _v, t) => g.time - t.attackAt > 4 && !battleAt(g, t.attackTarget) && !g.columns.some((c) => c.owner === 1 && c.path[c.path.length - 1] === t.attackTarget),
    highlight: (_g, t) => [t.attackTarget],
  },
  {
    title: 'Finish it',
    enter: (_g, t) => {
      // From here on the enemy plays properly (an easy, cautious opponent).
      t.enemyFree = true;
    },
    text: () =>
      'You know everything you need. Now take <b>Ironmere</b>, the enemy capital, to win.<br><br>When you start a real war you can also pick a <b>commander</b> and a <b>rival</b>, play bigger maps with special strongholds, and turn on fog of war. <b>Training</b> on the start screen lets you practise each event, and <b>?</b> explains everything else.',
    next: true,
    highlight: () => [5],
  },
];

/** Drives the tutorial level: shows the coach panel and advances when each step is done. */
export class Tutorial {
  index = 0;
  /** The enemy AI stays passive until the scripted attack. */
  aiActive = false;
  attackTarget = 0;
  attackAt = 0;
  sawAttack = false;
  /** The enemy only defends until the last step. */
  enemyFree = false;
  /** One-off things the game reports (e.g. "reverse"). */
  flags = new Set<string>();
  private dismissed = false;
  private panel: HTMLElement;
  private lastHtml = '';

  constructor(
    root: HTMLElement,
    private onSkip: () => void,
  ) {
    this.panel = document.createElement('div');
    this.panel.className = 'coach';
    root.appendChild(this.panel);
    this.panel.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'next') this.advance();
      else if (act === 'skip') this.skip();
    });
  }

  get step(): Step | undefined {
    return STEPS[this.index];
  }

  notify(flag: string) {
    this.flags.add(flag);
  }

  highlight(g: Game): number[] {
    if (this.dismissed) return [];
    return this.step?.highlight?.(g, this) ?? [];
  }

  private advance() {
    if (this.index >= STEPS.length - 1) {
      this.dismissed = true;
      this.panel.classList.add('hidden');
      return;
    }
    this.index++;
    this.entered = false;
  }

  private entered = false;

  skip() {
    this.aiActive = true;
    this.enemyFree = true;
    this.dismissed = true;
    this.panel.classList.add('hidden');
    this.onSkip();
  }

  destroy() {
    this.panel.remove();
  }

  update(g: Game, v: TutorialView) {
    const step = this.step;
    if (!step || this.dismissed) return;
    if (!this.entered) {
      this.entered = true;
      step.enter?.(g, this);
    }
    if (this.index === STEPS.findIndex((s) => s.title === 'The enemy strikes') && battleAt(g, this.attackTarget)) this.sawAttack = true;
    // Steps that need an action move on by themselves; "Next" steps wait for the button
    // (and for their condition, if they have one).
    const ok = step.done ? step.done(g, v, this) : true;
    if (!step.next && ok) this.advance();
    const html = `
      <div class="coach-head"><span>Tutorial · ${this.index + 1}/${STEPS.length}</span><button data-act="skip">Skip tutorial</button></div>
      <h3>${step.title}</h3>
      <p>${step.text(g, this)}</p>
      ${step.next ? `<button class="primary" data-act="next" ${ok ? '' : 'disabled'}>${this.index === STEPS.length - 1 ? 'Got it' : 'Next'}</button>` : '<div class="coach-wait">Do it to continue…</div>'}`;
    if (html !== this.lastHtml) {
      this.panel.innerHTML = html;
      this.lastHtml = html;
    }
    this.panel.classList.toggle('in-battle', v.bvOpen);
  }
}
