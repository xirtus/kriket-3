# KRIKET — a next-generation cricket simulation

A full cricket match — bat, bowl, field, run — built on real physics, running in the
browser on Three.js (WebGPU, WebGL2 fallback). Every delivery is a live physical
event: seam presentation, swing (conventional and reverse), spin, pitch interaction,
bat–ball collision, fielding, throwing and running between wickets are all simulated,
not scripted.

## Humans — powered by Xirtus HumanKit

Every player on the field is a **Xirtus HumanKit** human (`@xirtus/humankit`, sibling
package at `../xirtus-humankit`): a seeded, parametric, fully rigged character on the
canonical `XIRTUS_HUMANOID_V1` skeleton — skinned body, face with real eyes, hair,
team kit printed with actual names and numbers, pads/gloves/helmets/caps as
socket-mounted equipment, and a 74-clip animation vault (locomotion, sports,
cricket-specific shots/bowling/keeping/umpiring). Identities are deterministic per
player id, batters render at HERO tier, and ball-tracking IK keeps heads and eyes
on the play.

```
Mixamo / MetaHuman / MakeHuman / BVH mocap ──► XIRTUS_HUMANOID_V1 ──► HumanKit ──► this game
```

The same package drops into any Three.js game: `import { createAthlete, PRESETS } from '@xirtus/humankit'`.
See `../xirtus-humankit/README.md`, the Character Lab (`cd ../xirtus-humankit && npm run lab`),
and `../xirtus-humankit/ASSET_ACQUISITION.md` for mocap enrichment.

## Play

```bash
npm install
npm run dev     # http://localhost:5173
```

The full manual — controls, the physics, strategy, and the roadmap to the
perfect cricket simulator — lives at **`/manual.html`** (linked from the title
screen, and copied into production builds from `public/`).

Title → match setup (format, teams, difficulty, pitch, conditions, time of day) →
toss → play. Or hit **WATCH AI v AI** on the title screen for a self-playing
broadcast — 1/2/3 set playback speed (live / 2× / 4×), ENTER skips the pause.

### Difficulty

| Setting | Effect |
|---|---|
| Rookie | +35% batting contact windows, AI bowlers stray, AI fielders slower to react |
| Club | The intended tuning |
| Pro | −15% batting windows, sharper AI execution and fielding, smarter AI batting |

Difficulty applies asymmetrically: it tunes the AI and the human's windows, never
the AI's own contests (watch mode is always pure club-level AI vs AI).

### Batting
| Input | Action |
|---|---|
| ← / → | Aim the shot (yellow wedge) |
| SPACE | Drive |
| SHIFT + SPACE | Loft |
| Z | Defend |
| X | Cut / pull (follows aim) |
| C | Sweep |
| ↑ (hold) | Charge down the track |
| R / F | Take a run / send back |
| V | Cycle batting camera: broadcast → behind-batter → helmet cam |

The behind-batter frame sits over the off-side shoulder with the stumps in
shot — the picture is the batter defending his wicket; the helmet cam rides
the striker's head and watches the bowler's hand until the ball is live.

Timing is committed at the press: the ball arrives when physics says it arrives.
Line reading matters — the bat goes where you aim it, and the corridor punishes a
wrong read.

### Bowling
| Input | Action |
|---|---|
| 1–7 | Seam-up, outswing, inswing, off-spin, leg-spin, googly, slower ball |
| ← / → / ↑ / ↓ | Move the target marker (line / length) |
| SPACE ×2 | Start run-up, then hit the release point — release timing sets accuracy |

ENTER skips the between-ball pause. ESC pauses.

## What's simulated

- **Aerodynamics**: quadratic drag, Magnus lift from seam/spin, conventional swing
  that fades with the shine, reverse swing with a worn ball at pace, weather
  (overcast/humid) amplifying swing.
- **Pitch**: restitution, Coulomb friction, seam catch deviation, spin grip,
  uneven bounce (shooters that stay low, the odd riser — livelier on worn/dry
  surfaces), linear+proportional rolling resistance; four surfaces (green seamer,
  dry turner, flat deck, damp overcast) with baked textures, footmarks and cracks.
- **Contact**: timing committed at the press; the bat intercepts along the batter's
  line read; edges, mistimed chips and middled drives emerge from a real collision.
- **Fielding**: reaction times, trajectory prediction, cut-off angles, dive stops,
  fumbles, catches with difficulty-scaled drops, flat throws, overthrows.
- **Running**: return-time estimation vs crossing time; dives buy you 1.8m;
  direct hits; byes, leg-byes, wides, no-balls, free hits.
- **Dismissals**: bowled (swept collision — no tunneling, and the bat–pad gate can
  let a beaten ball through), caught, LBW (pitched / impact / would-hit projection
  against the stump line), run out, stumped.
- **AI**: phase-aware bowling plans (new-ball swing, death yorkers), batter brains
  (sector discipline, gap-finding, resource management), reactive captaincy that
  posts sweepers where you're scoring.
- **Presentation**: broadcast camera director (TV frame, behind-batter and helmet
  batting cams, ball-follow, wicket zoom, side-on replays), animated crowd that
  surges on events, procedural stadium audio,
  day / twilight / night lighting with glowing floodlights, live big-screen score,
  full scorebug with recent-balls, wagon-ready ball log.
- **Formats**: T20, ODI, Test (4 innings), eight fictional international squads with
  role-based ratings.

## QA harness

`qa/` contains the headless Playwright loop used to build the game:
`shoot.mjs` (screenshots), `sim.mjs`/`sim2.mjs` (full-match AI-vs-AI balance
sweeps with dismissal/scoring breakdowns), `play.mjs`/`playfull.mjs` (scripted
human input), `physicslab.ts` (offline physics tuning).

## License

Code: MIT (`LICENSE`). Original procedural assets: CC BY 4.0
(`ASSET-LICENSE.md`). Third-party components: `THIRD_PARTY.md`.
