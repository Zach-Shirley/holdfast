# Holdfast

A small real-time strategy game about **where to spend your attention**. Two realms fight over 6–10 strongholds joined by roads. You send troops as columns; when armies meet, a **battle** starts. Left alone, numbers decide it. Step inside and mouse-driven quick-time events swing the fight. But the battle view hides the map, and you can only be in one battle at a time. The enemy commander has the same limit, and its flag shows where it is.

Status: v0.3 (2026-10-18), a complete rebuild ("node battles") after Zach found v0.2 not fun. Single player vs AI, desktop browser. The v0.1/v0.2 dots game is in git history (`865fe5c`).

## Run

```bash
npm install
npm run dev     # http://127.0.0.1:5360
npm test        # map, battle and AI tests incl. AI-vs-AI wars
npm run build
```

## How it plays

- **Strongholds:** capital (grows 1.0/s, cap 70, walls ×1.5), fort (0.35/s, cap 60, walls ×1.4), village (0.75/s, cap 50, no walls). Troops above a cap slowly desert. Maps are point-symmetric, so both sides are equal.
- **Moving troops:** drag from your stronghold to any other. The dock sets 25/50/75/100%. Columns follow the roads and pass through your own strongholds. Two enemy columns meeting on a road fight there.
- **Battles:** each side loses `(0.6 + 0.045 × enemy troops) × enemy momentum × enemy walls` troops per second. An even fight lasts about 10–30 s. Reinforcements arriving at a battle join it.
- **Quick-time power:** every success effect is tripled (`QTE_POWER = 3`, after Zach's 2026-10-19 playtest); miss penalties are unchanged. Momentum is capped at 4×.
- **Battle view** (click the crossed swords or a battle in the dock): full screen, and the war keeps running. Quick-time events come one after another, mouse only:
  - **Volley:** click the target as the closing ring meets it. Kills about 21% of the enemy, plus 3.
  - **Parry:** click the incoming spear before it reaches your shield. A hit gives +0.45 momentum; a miss costs you about 7%.
  - **Slash:** drag from the start mark to the ring along the line. +0.9 momentum.
  - **Banner:** hold the mouse on the moving banner for 1 s. Kills about 12%, plus 3, and +0.45 momentum.
  - Leave with Esc, right-click or the button, or jump straight to another battle from the side list.
  - Misses explain themselves (for example "Too early: wait until the white ring touches the target"), and a click in the wrong place gives a hint instead of a miss.
- **Training** (start screen): pick any of the four events, read the steps, **watch a demo** where a ghost cursor performs it, then **practise** it on repeat with hits, misses and a streak counter.
- **Enemy commander:** the AI plays the same quick-time events, one battle at a time, with a switching delay and a success rate set by difficulty (easy 55%, normal 70%, hard 82%). It deliberately attacks where your commander is not.
- **Winning:** take the enemy capital. A 12-minute war clock breaks deadlocks: at zero, whoever holds more strongholds wins, with total troops as the tiebreak.

## Code map

| File | Role |
| --- | --- |
| `src/map.ts` | Seeded symmetric stronghold/road graph (6–10 nodes, planar roads, names) |
| `src/sim.ts` | Garrisons, columns, road interceptions, battle maths, quick-time effects, war clock |
| `src/ai.ts` | AI strategy (defend, attack, muster, push forward) and AI commander attention |
| `src/battleview.ts` | Full-screen battle scene and the four quick-time events |
| `src/render.ts` | Map renderer: painted backdrop, roads, strongholds, columns, battle markers |
| `src/main.ts` | Setup/end screens, map input, dock, HUD, game loop |

## Verification (2026-10-18)

- `npm test`: 20 passing. Covers:
  - map generation for every size (connected, symmetric, capitals at least 3 roads apart) and determinism
  - garrison growth and caps, capture, battle length, wall bonus and road interception
  - quick-time successes flipping a losing fight
  - AI-vs-AI wars finishing on all sizes and difficulties
  - a 20-map sweep with no stalemates (15 of 20 end by capture before the clock; median about 6 minutes)
  - **a commander who plays quick-time events beats one who never does in 12 of 12 games**
- Browser checks:
  - setup and map preview, a real mouse drag sending a column
  - Volley, Parry and Slash each completed with real mouse clicks and drags
  - Banner completed with dispatched mouse events (the automation can't hold a button down)
  - map battle markers with the enemy-commander flag, dock battle list, toasts, end screen and the war clock
  - no console errors
- Not yet verified: a human playtest for fun, pacing and difficulty.

## Known limitations

- The AI is decent, not clever. It reads only the nodes next to its territory and sometimes wins on the clock instead of finishing a capital.
- No sound, no fog of war, no multiplayer.
- `window.__holdfast` exposes a debug hook for automated browser checks.

## Authorship

Directed by Zach Shirley: a real-time strategy game whose fights are swung by quick-time events, the node-battles direction, 6–10 strongholds, mouse-only events, no reuse of the old healing game, and the feedback that drove the rebuild. Design details, code, tests and tuning were produced by Claude (Anthropic) in a Claude Code session.
