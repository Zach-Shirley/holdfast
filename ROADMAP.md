# Holdfast: Depth and Engagement Plan

Written 2026-10-19 after Zach's playtest of v0.3 ("I prefer this much more… overall it's balanced"). Status: Phase 1 built 2026-10-19 (see README); later phases are proposals. Zach's answers: online 1v1 is an eventual goal (keep every action a simulation command), synthesized sound effects are fine, and a campaign is possible later.

## Where the game is now

The core works: a node-and-road war where battles are settled by numbers unless you step in, and stepping in hides the map. Quick-time events (QTEs) are strong enough to matter (2.5× power). The enemy commander shares your one-battle limit.

What is thin today:

1. **Few decisions per battle.** You enter, play QTEs, leave. There is no choice about *how* to fight.
2. **A generic map layer.** Every stronghold is a troop counter, so the map plays like other "send troops between bases" games.
3. **One loop only.** Each match is the same experience; nothing carries over between wars.
4. **Low feedback.** No sound, and kills are not visible in the battle scene.

## Design pillars (what every feature should serve)

1. **Attention is the main resource.** Each feature should make "where am I looking, and why?" a sharper choice, never add busywork.
2. **Skill expression in battle.** Mastery of QTEs should feel great and visibly change outcomes.
3. **Readable at a glance.** The map must stay legible with 10 nodes and 4 simultaneous battles.
4. **Short wars (4–8 min).** Depth comes from decisions, not length.

## The engagement loops we are building

| Timescale | Loop | Today | Target |
| --- | --- | --- | --- |
| Seconds | Hit QTEs | 4 event types | Combos, contested duels, siege events, a "finisher" |
| Tens of seconds | Pick which battle to fight | Implicit | Stances, retreat, commander abilities, visible pressure |
| Minutes | Win territory | Generic nodes | Node specialties, rally routes, fog, chokepoints |
| Across matches | Get better / unlock | None | Commanders, campaign, mastery stats, challenges |

## Phase 1: Make every battle a decision (BUILT 2026-10-19)

*About 1.5–2 days of agent work. Confidence: high.*

| Feature | What it does | Why it adds depth |
| --- | --- | --- |
| **Rally meter and finisher** | Consecutive QTE hits fill a meter in that battle. When it is full, a big "Charge!" button appears; one click kills about 25% of the enemy. A miss drains part of the meter. | Rewards staying focused, creates a "one more hit" pull, and makes leaving a battle a real cost. |
| **Retreat** | A button in the battle view (and on the map marker) pulls your surviving troops back to the nearest friendly node, losing 15% on the way. | Losing battles become a decision (cut losses vs. fight on) instead of a slow drain. |
| **Commander duels** | When both commanders are in the same battle, some QTEs become contested. A "DUEL" prompt appears and whoever completes it faster wins a large swing; the AI's speed depends on difficulty. | Gives the game its most dramatic moments, and makes "go where the enemy commander is" a real tactical choice. |
| **Battle stances** | When sending a column, pick a stance with one extra click (or a dock toggle): **Assault** (more damage, more Slash events), **Hold** (less damage taken, more Parry events) or **Skirmish** (more Volley events, columns move 20% faster). | One pre-battle decision that shapes the fight and which QTEs you face. |
| **Rout phase** | When a side drops below 25% of its peak, the battle enters "rout". The winning side gets a "Pursuit" QTE for bonus kills, and the losing side gets a "Rearguard" QTE to save troops. | Gives every battle a climax, and makes ending battles fast feel good. |
| **Battle pressure on the map** | Battle markers pulse faster and turn red when you are losing. In the battle view, an edge arrow flashes toward any other battle you are about to lose. | Sharper attention cues without unhiding the map. |

Verification: unit tests for each mechanic; extend the AI-vs-AI sweep; a "commander with finisher beats one without" test; browser checks with real mouse input.

## Phase 2: Feel and feedback (BUILT 2026-10-19)

*About 1–1.5 days. Confidence: high. Can be interleaved with any phase.*

- **Sound,** synthesized with Web Audio so no asset licensing is needed:
  - a rising tone as the Volley ring closes, so you can time it by ear
  - a whoosh for the incoming spear, and clash and hit stingers
  - a horn when a new battle starts elsewhere
  - music that intensifies with the number of active battles
- **Visible kills:** soldiers in the battle scene fall when troops die (a Volley visibly drops a row), with a light camera punch on big hits.
- **Map juice:** columns leave dust trails, a captured node does a flag-raise animation, and losing a node flashes the screen edge.
- **Settings:** QTE speed (80/100/120%), sound volume and a colorblind-safe palette.

## Phase 3: A map worth fighting over

*About 2–3 days. Confidence: medium-high (needs AI updates and balance passes).*

| Feature | Detail |
| --- | --- |
| **Node specialties** | Each map rolls a few special strongholds: **Barracks** (+50% growth), **Watchtower** (reveals nearby fog, shows incoming enemy columns early), **Forge** (your battles adjacent to it start with +0.3 momentum), **Shrine** (+25% QTE power in adjacent battles), **Bridge** (only crossing between halves, a natural chokepoint). |
| **Rally routes** | Set a node to automatically forward its growth to another node, shown as a dashed arrow on the map. Removes repetitive dragging, so attention goes to battles, not logistics. |
| **Fog of war (setting)** | You see only near your nodes and columns. Enemy columns appear when they come into view; the enemy commander flag shows only if you can see that battle. Watchtowers matter. |
| **Commander map abilities** | Three cooldown abilities used from the map: **Forced March** (one column moves 2× faster), **Inspire** (the next battle starts with +0.5 momentum), **Spy** (reveals the enemy commander's next target for 20 s). Using them costs map time, which is attention again. |
| **Multi-send** | Drag a box around several nodes and send from all of them to one target. |
| **Road terrain** | Some roads are marshes (slow) or passes (only one column at a time), shown visually. |

The AI needs to value specialties, use rally routes and abilities, and play under fog (as an honest opponent, not a cheater).

## Phase 4: Commanders and rival personalities (replayability)

*About 2 days. Confidence: medium-high.*

- **Choose your commander** before a war. Each has a passive and a signature QTE twist:
  - **The Archer:** Volley kills +30% and the ring shrinks slower.
  - **The Duelist:** Slash also kills troops, and wins duel ties.
  - **The Iron Wall:** Parry misses cost nothing, and walls are +0.2.
  - **The Raider:** columns move 25% faster, and road ambushes start with +0.5 momentum.
  - **The Herald:** the rally meter fills 40% faster.
- **AI personalities** with names and short taunts:
  - **Aggressor:** constant pressure.
  - **Turtle:** fortifies and counterattacks.
  - **Opportunist:** strikes wherever your commander isn't.
  - **Gambler:** all-in pushes.
- These combine with difficulty into a ladder.

## Phase 5: Long-term goals (campaign, mastery, modes)

*About 3–5 days. Confidence: medium (content-heavy).*

- **Campaign of 10–12 scenarios** that teaches as it goes:
  - The first missions introduce one QTE at a time, which replaces "I don't know what to do".
  - Later ones bring set pieces: hold a fort for 3 minutes, a two-front war against two AIs, an asymmetric start, defending a bridge.
  - Completing them unlocks commanders and new QTE types.
- **New QTE types** to unlock. All mouse-only, all distinct from the old healing pulses:
  - **Shield Wall:** hold the button and release when a gauge is in the zone.
  - **Battering Ram:** click three beats in rhythm. Siege attackers only.
  - **Boiling Oil:** drag across a wall section. Siege defenders only.
  - **Cavalry Charge:** draw a curved path through an enemy cluster.
  - **Arrow Storm:** click three incoming arrows before they land.
- **Mastery:**
  - per-QTE accuracy history, with a "best streak" for each
  - a **Gauntlet** mode in Training: QTEs speed up until you miss three, with a personal best
- **Daily war:** a fixed seed and AI each day, with a local best time and score.

## Phase 6: Online 1v1 (optional, biggest)

*About 1 week. Confidence: medium. Needs Zach's go-ahead for hosting and deployment.*

The attention game is at its best against a human who is also juggling. The approach:
- A peer-to-peer connection (PeerJS, as Hex Balance uses) with a lockstep simulation. The sim is already deterministic apart from the QTE inputs, which would be sent as events.
- Room codes.
- Reconnect handling.

This is the biggest step toward a public, portfolio-grade game.

## Recommended order

1. **Phase 1** (the battle decisions): rally meter, finisher and retreat first, then duels, stances and rout.
2. **Phase 2** (sound and visible kills), right after or alongside Phase 1.
3. Playtest with Zach, then tune.
4. **Phase 3** (map depth): specialties and rally routes first.
5. **Phase 4** (commanders), then **Phase 5** (campaign and mastery).
6. **Phase 6** (online) only if Zach wants a public multiplayer release.

Each phase ends with tests, an AI-vs-AI balance sweep, browser checks and a short playtest note for Zach. Any public repo, license or deployment still needs Zach's direct approval.

## Decisions for Zach

1. Confirm the order above, or pick a different phase to start with.
2. Is online 1v1 a goal, or is single-player against AI the focus?
3. Art direction: stay fully procedural (as now), or allow free (CC0) sound and art assets?
4. Campaign or skirmish: which matters more to you long-term?
