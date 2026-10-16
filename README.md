# Holdfast

A small real-time territory game inspired by the War of Dots genre (original name, art and maps). Two armies of dots on a generated landmass. Each side defends **one stronghold**. The twist: any unit in combat or wounded can be boosted with a 2–3 second mini-game, and the battle **does not pause** while you play it. The skill is boosting fast without losing sight of the rest of the map.

Status: v0.2 (2026-10-16), single player vs AI, desktop browser. v0.2 adds fog of war, slower fights, a 20 s supply clock, mouse-only centred mini-games and pass-jam fixes after Zach's first playtest.

## Run

```bash
npm install
npm run dev     # http://127.0.0.1:5360
npm test        # simulation tests, incl. AI-vs-AI matches
npm run build
```

## How it plays

- **Win:** stand inside the enemy stronghold ring with no defenders inside for 12 s, or destroy their army. The stronghold's garrison shoots the nearest attacker.
- **Units:** melee (sturdy, must touch) and ranged (fragile, 7.5-cell range, weak in melee). Setup lets you pick Mixed, All melee or All ranged so each can be compared.
- **Flanking:** each extra attacker on the same target adds +25% damage (up to +75%).
- **Zone of control:** units move at half speed within 3.6 cells of an enemy. Slipping through a gap is slow and draws fire, so you don't need an unbroken line.
- **Encirclement / supply:** every unit needs a clear line back to its stronghold. Supply floods out from the stronghold; it is blocked near enemy units, and a unit's own body keeps its ground connected. A cut-off unit gets a yellow clock and dies after **20 s** unless reconnected (the clock winds back twice as fast once reconnected). Cut-off units also deal −20% and take +20% damage. Press **V** to see your supply area.
- **Fog of war** (setup option, on by default): you only see 10 cells around your units and stronghold. The AI plays under the same fog.
- **Terrain:** mountains and water block movement. Forest (−38% speed, −25% damage taken) and hills (−25% speed, −15% damage taken).
- **Maps:** four generated types (Mountain Passes, Lake Country, Highlands, Open Steppe) from a seed. Every map is point-symmetric, so both sides get the same ground.
- **Mini-games (mouse only):** they take over the middle of the screen and hide the battle, which keeps running. *Strike*: click while the needle is in the zone (30% wide; the bright 10% centre is a perfect hit). +35% or +70% damage for 8 s, 12 s cooldown. *Rally*: click three pulses before they fade, +10% health each, 14 s cooldown. Starting one commits the cooldown. The AI gets the same boosts on a timer, one at a time, with a success rate set by difficulty.

Controls: left-click/drag to select, right-click to move in formation, click a unit's badge to boost it. Optional keys: A selects all, X stops, Ctrl+1–9 / 1–9 for groups, Q/E boosts the selected unit that needs it most, wheel zooms, middle-drag/arrows pan, C recenters, P pauses, H opens help.

## Code map

| File | Role |
| --- | --- |
| `src/map.ts` | Seeded symmetric map generator, terrain tables, flood fill |
| `src/path.ts` | A* on the terrain grid plus path smoothing |
| `src/sim.ts` | Units, combat, flanking, zone of control, supply, healing, capture |
| `src/ai.ts` | AI commander: main army + flank group, home defence, mini-game timer |
| `src/minigames.ts` | Strike and Rally panels |
| `src/render.ts` | Canvas renderer: painted terrain, units, badges, effects |
| `src/main.ts` | Setup/end screens, input, HUD, game loop |

## Verification (2026-10-16)

- `npm test`: 19 passing. Covers map connectivity and symmetry on all presets, determinism, pathfinding, flanking damage, encirclement detection, the strike buff, stronghold capture, the 20 s supply clock, a 10-unit group clearing a 2-cell gap, fog visibility, AI-vs-AI matches finishing on all four map types, and a guard that Normal AI beats a no-micro deathball on at least 3 of 8 maps.
- Driven in the browser: setup screen, map previews, battle start, formation moves, combat, both mini-games through real key events (buff, heal and cooldowns confirmed), badge click hit-test, and the end screen with stats. No console errors.
- Not yet verified: a human playtest for feel and pacing. A real-mouse click on a moving badge wasn't confirmed because the automated browser pane was hidden; the same hit-test passed with dispatched mouse events.

## Known limitations

- **Blobbing is strong.** Under these rules, one concentrated army often beats a split one (it wins 5 of 8 test maps against Normal AI with zero mini-games). This is the main design question for the next version.
- Matches run about 1–5 minutes, which is short.
- No fog of war, no rivers, no online multiplayer.
- `window.__holdfast` exposes a debug hook for automated browser checks.

## Authorship

Directed by Zach Shirley (concept: troops plus speed mini-games under real-time pressure, a single stronghold, no economy, no single continuous front, encirclement). Design details, code, tests and tuning were produced by Claude (Anthropic) in a Claude Code session, with Zach to review and playtest.
