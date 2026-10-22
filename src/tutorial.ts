import type { GraphMap, MapNode, Edge } from './map';
import { activeBattles, sendTroops, type Game } from './sim';

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
  /** Show a "Next" button (with this label) instead of waiting for an action. */
  next?: string;
  /** Freeze the war while this step is up, so the player can read. */
  pause?: boolean;
  /** The step is complete when this returns true (checked every frame). */
  done?: (g: Game, v: TutorialView, t: Tutorial) => boolean;
  /** Strongholds to highlight on the map. */
  highlight?: (g: Game, t: Tutorial) => number[];
  /** Runs once when the step starts. */
  enter?: (g: Game, t: Tutorial) => void;
}

const playerColumnTo = (g: Game, node: number) => g.columns.some((c) => c.owner === 0 && c.path[c.path.length - 1] === node);
const battleAt = (g: Game, node: number) => activeBattles(g).find((b) => b.nodeId === node);
const marching = (g: Game) => g.columns.some((c) => c.owner === 0);

const STEPS: Step[] = [
  {
    title: 'Welcome to Holdfast',
    text: () => 'This is <b>Westhold</b>, your capital. The number is its garrison, and it grows over time.<br><br>You win by taking <b>Ironmere</b>, the enemy capital in the east.',
    next: 'Next',
    pause: true,
    highlight: () => [0, 5],
  },
  {
    title: 'Send troops',
    text: () => 'Drag from <b>Westhold</b> to <b>Eastbrook</b>. Half your troops march out (the <b>Send</b> setting in the bottom bar).',
    done: (g) => playerColumnTo(g, 1) || !!battleAt(g, 1) || g.nodes[1].owner === 0,
    highlight: () => [0, 1],
  },
  {
    title: 'Enter the battle',
    text: (g) =>
      battleAt(g, 1)
        ? 'Battle! <b>Click the crossed swords</b> over Eastbrook to fight in it yourself.'
        : 'When your column reaches Eastbrook, a battle starts. Click its <b>crossed swords</b> to step in.',
    done: (g, v) => v.bvOpen || g.nodes[1].owner === 0,
    highlight: () => [1],
  },
  {
    title: 'Quick-time events',
    text: () =>
      'Events pop up during the battle. Hits kill enemies or raise your <b>momentum</b> (the bar under your number).<br><br>Each new event is demonstrated first.',
    next: 'Fight!',
    pause: true,
  },
  {
    title: 'Fill the rally meter',
    // A head start, so the first battle reliably lasts long enough to fill it.
    enter: (g) => {
      g.meter[0] = Math.max(g.meter[0], 0.5);
    },
    text: () => 'Every hit fills the <b>Rally</b> meter at the bottom (yours starts half full). Misses drain it.',
    done: (g, v) => {
      const b = activeBattles(g).find((x) => x.id === v.bvBattleId);
      return !b || g.meter[0] >= 1 || g.stats[0].qteHit >= 6;
    },
  },
  {
    title: 'Charge!',
    text: () =>
      'Meter full! Click <b>CHARGE!</b> to cut down a quarter of the enemy.<br><br>The meter stays with your commander between battles, so you can also save it for later.',
    pause: true,
    done: (g, v) => g.stats[0].finishers > 0 || !activeBattles(g).some((x) => x.id === v.bvBattleId && g.meter[0] >= 1),
  },
  {
    title: 'Strongholds',
    text: (g) =>
      g.nodes[1].owner === 0
        ? 'You took <b>Eastbrook</b>! Strongholds grow troops for you: <b>capitals</b> fast, <b>villages</b> steadily, <b>forts</b> slowly but behind walls (defenders ×1.4).<br><br>Hover any stronghold for details.'
        : battleAt(g, 1)
          ? 'Win the battle for <b>Eastbrook</b>.'
          : 'Eastbrook is holding out. Send more troops from Westhold.',
    next: 'Next',
    pause: true,
    done: (g) => g.nodes[1].owner === 0,
    highlight: (g) => (g.nodes[1].owner === 0 ? [1] : [0, 1]),
  },
  {
    title: 'Attacking walls',
    text: () =>
      '<b>Stonegate</b> is a fort, so bring more. Set <b>Send</b> to 75% and <b>Stance</b> to <b>Assault</b> (+20% damage), then attack it.<br><br>Tip: box-drag over several strongholds to send from all of them.',
    done: (g) => playerColumnTo(g, 3) || !!battleAt(g, 3) || g.nodes[3].owner === 0,
    highlight: () => [3],
  },
  {
    title: 'Rally routes',
    text: () => '<b>Right-drag</b> from Westhold to Eastbrook. New troops will flow there by themselves (green arrow). Right-click to clear it.',
    done: (g) => g.nodes.some((n) => n.owner === 0 && n.rallyTo !== null),
    highlight: () => [0, 1],
  },
  {
    title: 'Orders',
    text: (g) =>
      (marching(g) ? '' : 'Send a column somewhere first. ') +
      'Click <b>March</b> in the bottom bar, then one of your marching columns: double speed for 15 s.<br><br><b>Inspire</b> boosts a battle; <b>Spy</b> reveals the map.',
    done: (g) => g.abilityReady[0].march > g.time,
  },
  {
    title: 'Turning back',
    text: (g) => (marching(g) ? '' : 'Send a column somewhere first. ') + '<b>Click one of your marching columns</b> to turn it back.',
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
      `30 enemy troops are coming for <b>${g.map.nodes[t.attackTarget].name}</b>! Its <b>flag</b> marks the battle the enemy commander is in.<br><br>Defend: send reinforcements, step into the battle, or press <b>Retreat</b> inside it to save 85% of your troops.`,
    next: 'Defend!',
    pause: true,
    highlight: (_g, t) => [t.attackTarget],
  },
  {
    title: 'Hold the line',
    text: (g, t) => `Defend <b>${g.map.nodes[t.attackTarget].name}</b>. Inside a battle, red arrows point to your other battles that are going badly.`,
    // Done once the attack is over, however it ended (even if the columns met on a road).
    done: (g, _v, t) => g.time - t.attackAt > 4 && !battleAt(g, t.attackTarget) && !g.columns.some((c) => c.owner === 1 && c.path[c.path.length - 1] === t.attackTarget),
    highlight: (_g, t) => [t.attackTarget],
  },
  {
    title: 'Final assault',
    text: () =>
      'Take <b>Ironmere</b> to win. The enemy commander will defend it in person, so expect a <b>duel</b> when you join that battle.<br><br>From now on the enemy fights back.',
    next: 'Attack!',
    pause: true,
    highlight: () => [5],
  },
  {
    title: 'Finish it',
    enter: (_g, t) => {
      // From here on the enemy plays properly (an easy, cautious opponent).
      t.enemyFree = true;
    },
    text: () =>
      'Capture <b>Ironmere</b>. Join the battle there to face its commander.<br><br>Afterwards: pick a commander and rival in a real war, try bigger maps or fog, or practise in <b>Training</b>.',
    next: 'Hide',
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
  /** The enemy only defends until the last step. */
  enemyFree = false;
  /** One-off things the game reports (e.g. "reverse"). */
  flags = new Set<string>();
  /** The battle the enemy commander must stay in (the final assault on Ironmere), for a duel. */
  duelBattle: number | null = null;
  private dismissed = false;
  private panel: HTMLElement;
  private lastHtml = '';
  private ok = false;

  constructor(
    root: HTMLElement,
    private onSkip: () => void,
  ) {
    this.panel = document.createElement('div');
    this.panel.className = 'coach';
    root.appendChild(this.panel);
    this.panel.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'next' && this.ok) this.advance();
      else if (act === 'skip') this.skip();
    });
  }

  get step(): Step | undefined {
    return STEPS[this.index];
  }

  notify(flag: string) {
    this.flags.add(flag);
  }

  /** The war is frozen while a reading step is up. */
  get frozen(): boolean {
    // A Next step pauses once its condition is met; an action step (Charge!) pauses until it is done.
    const st = this.step;
    return !this.dismissed && !!st?.pause && (st.next ? this.ok : !this.ok);
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
    // Final assault: the enemy commander holds Ironmere in person once you join that battle.
    const last = battleAt(g, 5);
    this.duelBattle = this.enemyFree && last && g.presence[0] === last.id ? last.id : null;
    // Steps that need an action move on by themselves; "Next" steps wait for the button
    // (and for their condition, if they have one).
    const ok = step.done ? step.done(g, v, this) : true;
    this.ok = ok;
    if (!step.next && ok) return this.advance();
    const html = `
      <div class="coach-head"><span>Tutorial · ${this.index + 1}/${STEPS.length}</span><button data-act="skip">Skip tutorial</button></div>
      <h3>${step.title}</h3>
      <p>${step.text(g, this)}</p>
      ${this.frozen ? '<span class="coach-paused">Paused</span>' : ''}${step.next ? `<button class="primary" data-act="next" ${ok ? '' : 'disabled'}>${step.next}</button>` : step.pause ? '' : '<div class="coach-wait">Do it to continue…</div>'}`;
    if (html !== this.lastHtml) {
      this.panel.innerHTML = html;
      this.lastHtml = html;
    }
    this.panel.classList.toggle('in-battle', v.bvOpen);
  }
}
