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
- **Quick-time power:** every success effect is multiplied by 2.5 (`QTE_POWER = 2.5`, after Zach's 2026-10-19 playtest); miss penalties are unchanged. Momentum is capped at 4×.
- **Battle view** (click the crossed swords or a battle in the dock): full screen, and the war keeps running. Quick-time events come one after another, mouse only:
  - **Volley:** click the target as the closing ring meets it. Kills about 18% of the enemy, plus 2–3.
  - **Parry:** click the incoming spear before it reaches your shield. A hit gives +0.375 momentum; a miss costs you about 7%.
  - **Slash:** drag from the start mark to the ring along the line. +0.75 momentum.
  - **Banner:** hold the mouse on the moving banner for 1 s. Kills about 10%, plus 2–3, and +0.375 momentum.
  - Leave with Esc, right-click or the button, or jump straight to another battle from the side list.
  - Misses explain themselves (for example "Too early: wait until the white ring touches the target"), and a click in the wrong place gives a hint instead of a miss.
- **Battle decisions (Phase 1, 2026-10-19):**
  - **Rally & Charge:** each hit fills a rally meter (4 hits). A full meter enables **CHARGE!**, which kills 25% of the enemy plus 3. Misses drain the meter.
  - **Retreat:** pull your side out to the nearest friendly stronghold, keeping 85%. A defender who retreats hands the node to the attacker.
  - **Stances** (dock, per column): Assault +20% damage dealt, Hold −20% damage taken, Skirmish +25% march speed. Each also makes one event type more common. Columns show ▲ ■ » on the map.
  - **Rout:** a side below 25% of its peak takes +25% losses. A routing enemy triggers **Pursuit** (click 3 fleeing soldiers); your own rout makes Retreat pulse.
  - **Commander duels:** when both commanders are in one battle, a duel breaks out about every 6 s. Wait for the signal, then click NOW! faster than the enemy (Normal: about 0.5 s). The winner kills 15% + 3 of the loser and surges.
  - **Pressure cues:** battles you are losing pulse red on the map. Inside a battle, red edge arrows point toward them; click one to jump there.
- **Feel and feedback (Phase 2, 2026-10-19):**
  - **Sound,** all synthesized with Web Audio (no audio files):
    - a tone that rises as the Volley ring closes, peaking at the hit moment, so it can be timed by ear
    - a whoosh that sweeps up as the spear comes in
    - hit and miss stingers, a duel signal, a charge horn, Banner ticks while holding, and Pursuit catches
    - a battle rumble with sword clangs in the battle view
    - an enemy-attack horn when one of your strongholds is hit, and capture and loss stingers
    - victory and defeat themes
    - war drums whose tempo and layers grow with the number of battles you are in
  - Audio starts on your first click, as browsers require. Press **M** or the HUD button to mute.
  - **Visible kills:** soldiers drop out of the front ranks and tumble back as troops die.
  - **Map:** dust trails behind marching columns, a ring-and-flag burst when a stronghold changes hands, and a red flash at the screen edge when you lose one.
  - **Settings** (start screen or ⚙ in the HUD, remembered in the browser): volume and mute, quick-time speed (80/100/120%; timing only, effects unchanged), and team colours (red vs blue, or high-contrast orange vs blue).
- **A map worth fighting over (Phase 3, 2026-10-19):**
  - **Special strongholds** (gold badge; about two thirds of the mirrored pairs, plus the centre node):
    - **Barracks:** +50% growth.
    - **Watchtower:** vision 580 instead of 300.
    - **Forge:** your battles at or next to it start with +0.3 momentum.
    - **Shrine:** +25% quick-time power at or next to it.
  - **Road types:** marsh ×0.65 speed (green dashes) and paved ×1.3 (pale stone). Specials and roads are always identical on both halves of the map.
  - **Rally routes:** right-drag from one of your strongholds to another and it forwards its surplus (above 5, or 10 at a capital) every second. Right-click to clear. Routes clear themselves if either end is lost.
  - **Multi-send:** drag a box around several strongholds, then drag from any of them to send the chosen share from all.
  - **Orders** (dock, on cooldowns):
    - **March:** click a column; it moves 2× faster for 15 s; 45 s cooldown.
    - **Inspire:** click a battle; +0.6 momentum and +50% rally; 60 s cooldown.
    - **Spy:** 20 s of full vision plus the destinations of enemy columns; 75 s cooldown.
  - **Fog of war** (setup option, off by default):
    - You see 300 around your strongholds (580 for a Watchtower), 220 around your columns and 200 around your battles.
    - Out of view, nodes show your last sighting, dimmed and marked "?".
    - Enemy columns, battles, alerts and the enemy totals in the HUD are hidden.
    - The AI plays under the same rules: it estimates from what it has seen and reacts only to columns it can see.
  - **AI:** values special strongholds, runs rally routes from its interior to the front, uses March on big attacks (Normal and Hard), Inspire on fights that are slipping away, and Spy under fog.
- **Commanders and rivals (Phase 4, 2026-10-19):**
  - **Your commander** (picked on the start screen):
    - **The Archer:** Volleys kill 60% more, and the Volley ring eases in and pauses briefly at the perfect moment (see below).
    - **The Duelist:** a successful Slash also kills 5% (scaled by quick-time power), and you win duels within 0.1 s.
    - **The Iron Wall:** missed Parries cost nothing, and your walls are +0.2.
    - **The Raider:** columns march 25% faster, and your road ambushes start at +0.5 momentum.
    - **The Herald:** the rally meter fills 40% faster.
  - **Rival personalities** (pick one or Random), each with its own commander and taunts shown as toasts:
    - **Varric the Relentless** (Aggressor, Raider): more and bolder attacks, thin reserves.
    - **Lady Morwen of the Wall** (Turtle, Iron Wall): cautious against your walls, but claims neutral ground. Holding off a real assault triggers a 12 s counterattack.
    - **Silas Quickfinger** (Opportunist, Archer): favours and presses targets away from where your commander is fighting.
    - **Captain Rook** (Gambler, Herald): unpredictable odds, sometimes throws everything at one target.
  - **Balance check** (AI vs AI, 48 games each, Normal): every personality won between 37% and 63%. The Aggressor starts about 1.5× as many attacks as the Turtle. The Opportunist ranks lowest against other AIs, because its edge (punishing a busy commander) mostly applies to a human spending time in battles.
- **After Zach's first Phase 4 playtest (2026-10-19):**
  - **Pursuit is more common.** It now appears once any enemy side is below half its peak strength (40% of event picks), and against a rout (60%). Each caught runner kills 3.5% of the enemy, or 5% against a rout, times quick-time power. The AI commander gets Pursuits under the same rule, so it stays fair.
  - **The Archer's Volley ring is eased** instead of slowed: it starts faster, slows as it nears the target, and holds for 0.14 s at the perfect moment; the total time is unchanged. This only helps a human's timing. A timing-error model suggests about +5 to +20 points of Volley hit rate (roughly +1 to +5 points of overall quick-time success), on the commander that was already weakest in AI tests, so it was kept. That is modelled, not playtested.
  - **Watch AI vs AI** (start screen): choose the left AI (or Random) against the Rival. Fog is off while watching. Speed is 1×, 2× or 4×. Click any battle to watch inside it, where each commander's quick-time results float over their own army. The end screen names the winner.
- **Tweaks after more playtesting (2026-10-19):**
  - **Fights last 20% longer** (base losses 0.6 → 0.5, per-troop 0.045 → 0.0375). In the 20-war sweep, charges used rose from 48 to 95, and the median war went from about 3¼ to 4½ minutes.
  - **Map sizes 12, 14 and 16** are added (strongholds pack slightly closer on big maps).
  - **Turn a column around:** click one of your marching columns and it heads back to the node it left. A click counts for the column if it is nearer the column than the stronghold.
  - **Fog of war hides more:** vision drops to 260 around strongholds and 190 around columns. Enemy counts you can see but are not within 150 of show rounded to the nearest 5 ("~25"), and the AI gets the same rough numbers. **Watchtowers** only show, and only count for the AI, in fog matches.
- **Tutorial level** (gold **Tutorial** button on the start screen): a hand-made 7-stronghold map with a coach panel and gold pointers, 15 short steps:
  1. welcome and the goal
  2. send troops (drag)
  3. enter a battle
  4. quick-time events
  5. fill the rally meter (it starts half full here)
  6. Charge!, and banking the meter
  7. what strongholds do
  8. attacking walls: send amount, Assault stance, multi-send
  9. rally routes (right-drag)
  10. orders (March)
  11. turning a column back
  12. a scripted enemy attack: briefing
  13. hold the line
  14. final assault briefing
  15. take the enemy capital, with a commander duel

  **Reading steps freeze the war** (a gold PAUSED tag) until you click their button, and the Charge! step stays frozen until you charge. **The first time each quick-time event comes up, the battle freezes** and a ghost cursor demonstrates it beside a short card (what to do, what it does). Then **Try it** hands it to you. In the final assault the enemy commander stays in the battle for Ironmere, so you meet it in a **duel**.

  The enemy (Morwen, the Turtle, on Easy) stays passive until its scripted attack and only defends until the final assault. There is no war clock. Steps that need an action advance by themselves, and you can skip at any time. Winning shows "Tutorial complete".
- **Training** (start screen): pick any of the six events (including Duel and Pursuit), read the steps, **watch a demo** where a ghost cursor performs it, then **practise** it on repeat with hits, misses and a streak counter.
- **Enemy commander:** the AI plays the same quick-time events, one battle at a time, with a switching delay and a success rate set by difficulty (easy 55%, normal 70%, hard 82%). It deliberately attacks where your commander is not.
- **Winning:** take the enemy capital. A 12-minute war clock breaks deadlocks: at zero, whoever holds more strongholds wins, with total troops as the tiebreak.

## Online-ready design note

Every player action is a plain function on the simulation: `sendTroops` (with stance), `applyQte`, `useFinisher`, `retreat`, `applyDuel` and `applyPursuit`. The simulation is deterministic given those calls, so a future online 1v1 can sync the list of actions between peers (lockstep) instead of syncing state. Duels between two humans will need both reaction times compared by an agreed rule; that is still to design.

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

- `npm test`: 43 passing (Phase 4 added `tests/phase4.test.ts`: each commander effect, every personality finishing against every other, and the Aggressor starting more attacks than the Turtle. Phase 3 added `tests/phase3.test.ts`: symmetric specials and roads, barracks/forge/shrine effects, road and Forced March speeds, rally routes, ability cooldowns, fog visibility and memory, and AI wars finishing with fog on). Phase 1 added tests for rally/finisher, retreat (attacker and defender), stances, rout and duel/pursuit, plus checks that both AIs use finishers and retreats in the 20-map sweep. Covers:
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
