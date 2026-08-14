import * as THREE from 'three';
import { skinToneFor } from '../entities/Cricketer';
import { HumanCricketer } from '../entities/HumanCricketer';
import { Ball } from '../entities/Ball';
import { buildStumps } from '../world/Stumps';
import { BOWLER_STUMPS_Z, STRIKER_STUMPS_Z } from '../world/Pitch';
import { PITCH_PRESETS } from '../physics/PitchSurface';
import type { AeroEnv } from '../physics/Aerodynamics';
import { MatchState } from '../cricket/MatchState';
import type { BallResolution, MatchSetup, PlayerSpec } from '../cricket/Types';
import { chooseField } from '../ai/Captain';
import { planDelivery, chooseNextBowler } from '../ai/BowlerBrain';
import { BatterBrain } from '../ai/BatterBrain';
import { FIELD_PRESETS, slotToWorld, type FieldPlacement } from '../cricket/Field';
import { FieldingSim, makeFielder, type FielderEnt } from './Fielding';
import { Delivery, type DeliveryPlan, type BattingController, type BattingView, type ShotCommand } from './Delivery';
import { isNoBallOverstep } from '../cricket/Rules';
import type { RunningSim } from './Running';
import { mulberry32, gaussian, type Rng } from '../core/Rng';
import type { InputManager } from '../input/InputManager';
import type { HUD } from '../ui/HUD';
import type { AudioDirector } from '../audio/AudioDirector';
import type { CameraDirector } from '../render/CameraDirector';
import type { Crowd } from '../world/Crowd';
import type { Stadium } from '../world/Stadium';
import type { BallTrail, DustPuffs, BailPhysics } from '../render/Effects';
import type { DeliveryType } from '../physics/BallState';

export type ControllerMode = 'play' | 'watch' | 'sim';

/** Difficulty tuning: how the AI and the physics treat the HUMAN player. */
interface DifficultyScales {
  batWindows: number; // human batting contact/miss window multiplier
  bowlerErr: number; // AI bowler execution-error multiplier when human bats
  aiBatBias: number; // AI batting-rating shift when human bowls
  fieldReact: number; // AI fielder reaction-time multiplier when human bats
  fieldCatch: number; // AI catch-chance multiplier when human bats
  humanBowlErr: number; // human bowling release-error multiplier
}

const DIFFICULTY: Record<string, DifficultyScales> = {
  rookie: { batWindows: 1.35, bowlerErr: 1.3, aiBatBias: -8, fieldReact: 1.25, fieldCatch: 0.85, humanBowlErr: 0.75 },
  club: { batWindows: 1.0, bowlerErr: 1.0, aiBatBias: 0, fieldReact: 1.0, fieldCatch: 1.0, humanBowlErr: 1.0 },
  pro: { batWindows: 0.85, bowlerErr: 0.9, aiBatBias: 5, fieldReact: 0.95, fieldCatch: 1.05, humanBowlErr: 1.2 },
};

interface Deps {
  input: InputManager;
  hud: HUD;
  audio: AudioDirector;
  cameras: CameraDirector;
  crowd: Crowd;
  stadium: Stadium;
  trail: BallTrail;
  dust: DustPuffs;
  bails: BailPhysics;
}

type Phase =
  | 'preBall'
  | 'bowlingUI'
  | 'delivering'
  | 'betweenBalls'
  | 'replay'
  | 'inningsDone'
  | 'matchDone';

const BOWL_TYPE_LABELS: Record<string, string> = {
  'seam-up': 'Seam-up (1)',
  outswing: 'Outswing (2)',
  inswing: 'Inswing (3)',
  offspin: 'Off-spin (4)',
  legspin: 'Leg-spin (5)',
  googly: 'Googly (6)',
  slower: 'Slower ball (7)',
};

class HumanBatting implements BattingController {
  constructor(private readonly input: InputManager) {}
  onFlight(_view: BattingView, _dt: number): ShotCommand | null {
    const shot = this.input.consumeShot();
    if (!shot) return null;
    let kind = shot.kind;
    if (kind === 'cut' && this.input.aimDeg < -8) kind = 'pull';
    if (kind === 'pull' && this.input.aimDeg > 8) kind = 'cut';
    return { kind, aimDeg: this.input.aimDeg, charge: this.input.chargeHeld };
  }
  onInPlay(running: RunningSim, _ballPos: THREE.Vector3): void {
    if (this.input.consumeRun()) {
      if (running.runsCompleted === 0 && !running.strikerRunning) running.startRun();
      else running.continueRunning();
    }
    if (this.input.consumeBack()) running.sendBack();
  }
}

export class MatchController {
  readonly match: MatchState;
  phase: Phase = 'preBall';
  paused = false;

  private readonly rng: Rng;
  private readonly ents = new THREE.Group();
  private ball = new Ball();
  private stumpsA = buildStumps();
  private stumpsB = buildStumps();
  private keeper!: FielderEnt;
  private bowlerEnt!: FielderEnt;
  private fielders: FielderEnt[] = [];
  private fielding!: FieldingSim;
  private strikerEnt!: HumanCricketer;
  private nonStrikerEnt!: HumanCricketer;
  private bowlerCricketer!: HumanCricketer;
  private umpireMain!: HumanCricketer;
  private umpireSquare!: HumanCricketer;
  private humanEnts: HumanCricketer[] = [];
  private delivery: Delivery | null = null;
  private currentBowler: PlayerSpec | null = null;
  private field: FieldPlacement = FIELD_PRESETS.odiStandard;
  private batterBrain: BatterBrain | null = null;
  private humanBat: HumanBatting;
  private betweenTimer = 0;
  private replayTimer = 0;
  private replayBuf: THREE.Vector3[] = [];
  private replayIdx = 0;
  private replayReason: 'wicket' | 'boundary' | null = null;
  private ballWear = 0;
  private env: AeroEnv;
  private umpireSignal: { kind: 'out' | 'four' | 'six' | 'wide' | 'legbye' | 'dead'; t: number } | null = null;
  private aimWedge: THREE.Mesh;
  private bowlMarker: THREE.Mesh;
  private bowlTypeSel = 'seam-up';
  private runupT = 0;
  allowReplays = false;
  private onMatchEnd: (() => void) | null = null;
  private playerBatting = true;
  private readonly diff: DifficultyScales;
  private deliveryCount = 0;
  private ballSteps = 0;
  runTimeline: { t: number; n: number }[] = [];
  readonly ballLog: { runs: number; dismissal: string | null; boundary: number | null; timeline: { t: number; n: number }[] }[] = [];

  constructor(
    scene: THREE.Scene,
    private readonly setup: MatchSetup,
    private readonly deps: Deps,
    private readonly mode: ControllerMode = 'play',
  ) {
    this.rng = mulberry32(setup.seed);
    this.diff = DIFFICULTY[setup.difficulty ?? 'club'] ?? DIFFICULTY.club;
    this.match = new MatchState(
      setup.format,
      setup.playerTeam === 'home' ? setup.home : setup.away,
      setup.playerTeam === 'home' ? setup.away : setup.home,
    );
    // Random-ish toss, but the human's team bats first for immediate fun.
    this.env = { swingScale: setup.venue.weather === 'humid' ? 1.5 : setup.venue.weather === 'overcast' ? 1.25 : 0.85 };
    this.humanBat = new HumanBatting(deps.input);
    this.stumpsA.position.set(0, 0, STRIKER_STUMPS_Z);
    this.stumpsB.position.set(0, 0, BOWLER_STUMPS_Z);

    // Aim wedge (batting) + bowling target marker.
    const wedgeGeo = new THREE.RingGeometry(2.4, 3.4, 24, 1, -0.1, 0.2);
    this.aimWedge = new THREE.Mesh(wedgeGeo, new THREE.MeshBasicMaterial({ color: 0xffd24b, transparent: true, opacity: 0.4, side: THREE.DoubleSide }));
    this.aimWedge.rotation.x = -Math.PI / 2;
    this.aimWedge.visible = false;
    const markGeo = new THREE.RingGeometry(0.28, 0.42, 24);
    this.bowlMarker = new THREE.Mesh(markGeo, new THREE.MeshBasicMaterial({ color: 0x4bafff, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
    this.bowlMarker.rotation.x = -Math.PI / 2;
    this.bowlMarker.position.y = 0.02;
    this.bowlMarker.visible = false;

    scene.add(this.ents, this.ball.mesh, this.stumpsA, this.stumpsB, this.aimWedge, this.bowlMarker);
    // White ball under lights / in coloured clothing; red for Test whites.
    this.ball.setColor(this.setup.format === 'TEST' && setup.venue.time === 'day' ? 0x9e1414 : 0xf2efe8);
    this.buildInningsEntities();
    this.updateScorebug();
    this.updateHint();
  }

  setOnMatchEnd(cb: () => void): void {
    this.onMatchEnd = cb;
  }

  setBails(bails: BailPhysics): void {
    this.deps.bails = bails;
  }

  ballPosition(): THREE.Vector3 | null {
    return this.ball?.mesh.position ?? null;
  }

  // ─── Entities ───────────────────────────────────────────────────────────

  private buildInningsEntities(): void {
    this.ents.clear();
    this.fielders = [];
    const inn = this.match.current();
    const batTeam = inn.batting;
    const bowlTeam = inn.bowling;
    const coloredKits = this.setup.format !== 'TEST';
    const batShirt = coloredKits ? batTeam.color : 0xf5f5f0;
    const batTrousers = coloredKits ? batTeam.color : 0xf5f5f0;
    const fieldShirt = coloredKits ? bowlTeam.color : 0xf5f5f0;
    const fieldTrousers = coloredKits ? bowlTeam.color : 0xf5f5f0;

    const mkBatter = (spec: PlayerSpec): HumanCricketer =>
      new HumanCricketer({
        shirt: batShirt,
        trousers: batTrousers,
        skin: skinToneFor(spec.id),
        helmet: batTeam.color,
        pads: true,
        withBat: true,
        scale: 0.97 + (Math.abs(hashCode(spec.id)) % 100) / 1400,
        seed: Math.abs(hashCode(spec.id)) || 7,
        surname: spec.shortName,
        number: (Math.abs(hashCode(spec.id)) % 97) + 1,
      });
    this.strikerEnt = mkBatter(inn.striker().spec);
    this.nonStrikerEnt = mkBatter(inn.nonStriker().spec);
    this.ents.add(this.strikerEnt.root, this.nonStrikerEnt.root);
    this.humanEnts = [this.strikerEnt, this.nonStrikerEnt];

    const keeperSpec = bowlTeam.players.find((p) => p.role === 'keeper')!;
    const keeperCricketer = new HumanCricketer({
      shirt: fieldShirt,
      trousers: fieldTrousers,
      skin: skinToneFor(keeperSpec.id),
      cap: bowlTeam.color,
      pads: true,
      scale: 0.99,
      seed: Math.abs(hashCode(keeperSpec.id)) || 11,
      surname: keeperSpec.shortName,
      number: (Math.abs(hashCode(keeperSpec.id)) % 97) + 1,
    });
    this.keeper = makeFielder(keeperSpec, keeperCricketer, 'keeper', 0.6, STRIKER_STUMPS_Z + 1.9);
    this.keeper.cricketer.root.position.copy(this.keeper.home);
    this.ents.add(keeperCricketer.root);
    this.humanEnts.push(keeperCricketer);

    const bowlerSpec = this.currentBowler ?? this.pickNextBowler();
    this.currentBowler = bowlerSpec;
    this.bowlerCricketer = new HumanCricketer({
      shirt: fieldShirt,
      trousers: fieldTrousers,
      skin: skinToneFor(bowlerSpec.id),
      cap: bowlTeam.color,
      scale: 1.0 + (Math.abs(hashCode(bowlerSpec.id)) % 100) / 2000,
      seed: Math.abs(hashCode(bowlerSpec.id)) || 13,
      surname: bowlerSpec.shortName,
      number: (Math.abs(hashCode(bowlerSpec.id)) % 97) + 1,
    });
    this.bowlerEnt = makeFielder(bowlerSpec, this.bowlerCricketer, 'bowler', 0.4, BOWLER_STUMPS_Z - 1.2);
    this.ents.add(this.bowlerCricketer.root);
    this.humanEnts.push(this.bowlerCricketer);

    // 9 outfielders from the remaining players.
    const remaining = bowlTeam.players.filter((p) => p.id !== keeperSpec.id && p.id !== bowlerSpec.id);
    this.field = chooseField(this.setup.format, inn, bowlerSpec, Math.floor(inn.legalBalls / 6), inn.striker().runs > 25);
    for (let i = 0; i < 9; i++) {
      const spec = remaining[i % remaining.length];
      const slot = this.field.slots[i];
      const w = slotToWorld(slot);
      const cr = new HumanCricketer({
        shirt: fieldShirt,
        trousers: fieldTrousers,
        skin: skinToneFor(spec.id),
        cap: bowlTeam.color,
        scale: 0.96 + (Math.abs(hashCode(spec.id)) % 100) / 1600,
        seed: Math.abs(hashCode(spec.id)) || 17,
        surname: spec.shortName,
        number: (Math.abs(hashCode(spec.id)) % 97) + 1,
      });
      const ent = makeFielder(spec, cr, slot.name, w.x, w.z);
      cr.root.position.set(w.x, 0, w.z);
      cr.faceToward(0.4, STRIKER_STUMPS_Z - 1);
      this.fielders.push(ent);
      this.ents.add(cr.root);
      this.humanEnts.push(cr);
    }

    this.fielding = new FieldingSim(
      this.fielders,
      this.keeper,
      this.bowlerEnt,
      {
        onCatch: (f) => {
          this.deps.audio.catchTaken();
          this.delivery?.notifyCaught(f.spec.id);
        },
        onDrop: (f) => {
          this.deps.hud.flash(`DROPPED! ${f.spec.shortName} puts it down`, '#ff9d4b', true);
          this.deps.crowd.setExcitement(0.5);
        },
        onThrowReleased: () => {
          this.deps.audio.ballBounce();
          this.delivery?.markReturnThrow();
        },
        onCollect: () => {},
      },
      this.rng,
    );

    // Umpires.
    this.umpireMain = new HumanCricketer({ shirt: 0x26303a, trousers: 0x26303a, skin: 0xd9a066, cap: 0x26303a, scale: 1.0, seed: 9201 });
    this.umpireMain.root.position.set(0.62, 0, BOWLER_STUMPS_Z - 1.35);
    this.umpireMain.root.rotation.y = 0;
    this.umpireSquare = new HumanCricketer({ shirt: 0x26303a, trousers: 0x26303a, skin: 0x8d5524, cap: 0x26303a, scale: 0.99, seed: 4177 });
    this.umpireSquare.root.position.set(14, 0, STRIKER_STUMPS_Z + 1.5);
    this.umpireSquare.faceToward(0, STRIKER_STUMPS_Z);
    this.ents.add(this.umpireMain.root, this.umpireSquare.root);
    this.humanEnts.push(this.umpireMain, this.umpireSquare);

    // Fresh batter brain for AI batting sides.
    this.batterBrain = null;
  }

  private pickNextBowler(): PlayerSpec {
    const inn = this.match.current();
    return chooseNextBowler(
      inn.bowling.players,
      inn,
      this.currentBowler?.id ?? null,
      Math.floor(inn.legalBalls / 6),
      this.setup.format,
    );
  }

  // ─── Ball lifecycle ─────────────────────────────────────────────────────

  private startDelivery(): void {
    const inn = this.match.current();
    if (inn.isComplete(this.setup.format)) {
      this.endInnings();
      return;
    }
    this.playerBatting = this.mode === 'play' && inn.batting.id === this.playerTeamId();
    this.ballWear = Math.min(1, inn.legalBalls / 85 + inn.runs / 900);
    this.ball.setWearVisual(this.ballWear);

    const strikerSpec = inn.striker().spec;
    if (!this.playerBatting) {
      if (!this.batterBrain) {
        this.batterBrain = new BatterBrain(strikerSpec, this.rng, this.setup.format, () => ({
          runsNeeded: inn.target !== null ? inn.target - inn.runs : null,
          ballsLeft: inn.oversLimit !== null ? inn.oversLimit * 6 - inn.legalBalls : null,
          wicketsDown: inn.wickets,
        }), () => this.field);
      }
      // Reset per-ball decision state via a fresh brain bound to the CURRENT striker.
      this.batterBrain = new BatterBrain(strikerSpec, this.rng, this.setup.format, () => ({
        runsNeeded: inn.target !== null ? inn.target - inn.runs : null,
        ballsLeft: inn.oversLimit !== null ? inn.oversLimit * 6 - inn.legalBalls : null,
        wicketsDown: inn.wickets,
      }), () => this.field, () => this.currentBowler?.ratings.bowling ?? 75,
        // Human is bowling: difficulty shifts how well the AI bats against them.
        this.mode === 'play' && inn.batting.id !== this.playerTeamId() ? this.diff.aiBatBias : 0);
    }

    // Difficulty also tunes the AI fielding effort while the HUMAN is batting.
    const humanAtBat = this.mode === 'play' && inn.batting.id === this.playerTeamId();
    if (this.fielding) {
      this.fielding.reactScale = humanAtBat ? this.diff.fieldReact : 1;
      this.fielding.catchScale = humanAtBat ? this.diff.fieldCatch : 1;
    }

    const useHumanBowling = this.mode === 'play' && !this.playerBatting;
    const plan = useHumanBowling
      ? this.humanPlanPreview()
      : planDelivery(this.currentBowler!, strikerSpec, inn, this.setup.venue.pitch, this.setup.venue.weather, this.ballWear, Math.floor(inn.legalBalls / 6), this.rng,
          humanAtBat ? this.diff.bowlerErr : 1);

    const noBall = isNoBallOverstep(this.rng, this.currentBowler!.ratings.bowling);

    const hooks = {
      onRelease: (speed: number) => {
        this.deps.hud.setBallInfo(this.ballInfoHtml(speed));
      },
      onBounce: (pt: THREE.Vector3) => {
        this.deps.dust.spawn(pt, 0.8);
        this.deps.audio.ballBounce();
      },
      onSwing: () => {},
      onContact: (result: { quality: number; outcome: string }) => {
        this.deps.audio.batHit(result.quality);
        this.timingFeedback(result.quality, result.outcome);
        this.deps.cameras.toFollow();
      },
      onPad: () => this.deps.audio.padThud(),
      onAppeal: (kind: string) => {
        if (kind !== 'none') {
          this.deps.audio.appeal();
          this.fielding.appealAll();
          this.deps.crowd.setExcitement(0.75);
        }
      },
      onBoundary: (n: 4 | 6) => {
        this.deps.audio.boundary();
        this.deps.crowd.setExcitement(n === 6 ? 1 : 0.85);
        this.umpireSignal = { kind: n === 4 ? 'four' : 'six', t: -0.7 };
        this.startReplay('boundary');
      },
      onWicket: () => {
        this.deps.bails.disturb(new THREE.Vector3(0, 0.75, STRIKER_STUMPS_Z), this.ball.state.velocity);
        this.deps.bails.disturb(new THREE.Vector3(0, 0.75, BOWLER_STUMPS_Z), this.ball.state.velocity);
        this.deps.audio.wicket();
        this.deps.crowd.setExcitement(1);
        const catcher = this.fielding.all().find((f) => f.hasBall);
        this.fielding.celebrateAll(catcher);
        this.umpireSignal = { kind: 'out', t: -0.9 };
        this.deps.cameras.toWicket();
        this.startReplay('wicket');
      },
      onCatchTaken: () => this.deps.audio.catchTaken(),
      onDropped: (f: FielderEnt) => {
        this.deps.hud.flash(`DROPPED! ${f.spec.shortName} puts it down`, '#ff9d4b', true);
        this.deps.crowd.setExcitement(0.5);
      },
      onRunCompleted: (n: number) => {
        this.runTimeline.push({ t: this.ballSteps / 120, n });
      },
      onBallStep: (pos: THREE.Vector3) => {
        this.ballSteps += 1;
        this.deps.trail.push(pos);
        if (this.replayBuf.length < 1200) this.replayBuf.push(pos.clone());
      },
      onDead: (res: BallResolution) => this.resolveBall(res),
      onThrow: () => {},
    };

    this.delivery = new Delivery({
      rng: this.rng,
      pitch: PITCH_PRESETS[this.setup.venue.pitch],
      env: this.env,
      plan,
      noBall,
      freeHit: inn.freeHitNext,
      boundary: this.setup.venue.boundary,
      ball: this.ball,
      ballWear: this.ballWear,
      bowler: this.bowlerCricketer,
      strikerEnt: this.strikerEnt,
      nonStrikerEnt: this.nonStrikerEnt,
      fielding: this.fielding,
      keeper: this.keeper,
      bowlerEnt: this.bowlerEnt,
      batting: this.playerBatting ? this.humanBat : this.batterBrain!,
      batForgiveness: this.playerBatting ? this.diff.batWindows : 1,
      strikerId: inn.striker().spec.id,
      nonStrikerId: inn.nonStriker().spec.id,
      bowlerId: this.currentBowler!.id,
      strikerBatting: strikerSpec.ratings.batting,
      hooks,
    });

    this.deps.bails.reset();
    this.deps.trail.reset();
    this.replayBuf = [];
    this.ballSteps = 0;
    this.runTimeline = [];
    this.umpireSignal = null;

    if (inn.freeHitNext) {
      this.deps.hud.setTag('FREE HIT', '#0b7a3d');
    } else {
      this.deps.hud.setTag(null);
    }

    if (useHumanBowling) {
      this.phase = 'bowlingUI';
      this.deps.input.aimDeg = 0;
      this.deps.input.aimLength = 4.5;
      this.bowlMarker.visible = true;
      this.deps.hud.showBowlPanel(this.bowlPanelHtml(), null);
    } else {
      this.phase = 'delivering';
      // Small realistic pause before the bowler turns in.
      this.delivery.beginRunup();
    }
    this.deliveryCount += 1;
  }

  private humanPlanPreview(): DeliveryPlan {
    // Placeholder plan for the human bowler: refined by the bowling UI each frame.
    return this.humanPlanFromUI(0.5);
  }

  private humanPlanFromUI(errorScale: number): DeliveryPlan {
    const spec = this.currentBowler!;
    const quick = spec.bowlStyle === 'fast' || spec.bowlStyle === 'medium';
    const spin = spec.bowlStyle === 'offspin' || spec.bowlStyle === 'legspin';
    let type = this.bowlTypeSel as DeliveryType | 'slower';
    if (type === 'googly' && spec.bowlStyle !== 'legspin') type = 'offspin';
    if ((type === 'offspin' || type === 'legspin' || type === 'googly') && !spin) type = 'seam-up';
    const base = quick ? 128 + spec.ratings.bowling * 0.14 : 84 + spec.ratings.bowling * 0.06;
    const speedKmh = type === 'slower' ? base - 16 : spin ? base : base + 2;
    const spinRpm = spin ? 1900 : type === 'slower' ? 350 : 200;
    const err = (1 - spec.ratings.bowling / 110) * errorScale * this.diff.humanBowlErr;
    return {
      type: type === 'slower' ? 'seam-up' : type,
      speedKmh,
      lengthFromStumps: Math.max(0.1, this.deps.input.aimLength + gaussian(this.rng) * 1.1 * err),
      lineOffset: THREE.MathUtils.clamp(this.deps.input.aimDeg, -2.2, 2.2) + gaussian(this.rng) * 0.28 * err,
      spinRpm,
    };
  }

  private bowlPanelHtml(): string {
    const spec = this.currentBowler!;
    return `<b>${spec.shortName}</b> — ${spec.bowlStyle}<br/>
      Delivery: <b>${BOWL_TYPE_LABELS[this.bowlTypeSel]}</b><br/>
      ←/→ line &nbsp; ↑/↓ length<br/>
      <span style="opacity:0.8">SPACE start run-up, SPACE again to release</span>`;
  }

  private timingFeedback(quality: number, outcome: string): void {
    const h = this.deps.hud;
    if (outcome === 'missed') h.timing('BEATEN', '#ff6a6a');
    else if (outcome === 'edge') h.timing('EDGED!', '#ff9d4b');
    else if (quality > 0.8) h.timing('PERFECT', '#36d17c');
    else if (quality > 0.55) h.timing('GOOD', '#a6ff4b');
    else h.timing('MISTIMED', '#ffd24b');
  }

  private resolveBall(res: BallResolution): void {
    const hk = this.delivery ? (this.delivery as unknown as { ctx: { hooks: Record<string, unknown> } }).ctx.hooks : {};
    this.ballLog.push({ runs: res.runsOffBat, dismissal: res.dismissal?.kind ?? null, boundary: res.boundary, timeline: [...this.runTimeline], dbg: hk as unknown } as never);
    if (this.ballLog.length > 30) this.ballLog.shift();
    const inn = this.match.current();
    inn.freeHitNext = this.ctx_noBallNext(res);
    inn.applyBall(res, this.currentBowler!);
    this.updateScorebug();
    this.deps.stadium.setScreenText(
      `${inn.batting.shortName} ${inn.runs}/${inn.wickets}`,
      `${inn.oversText} ov  •  ${inn.runRate.toFixed(1)} rpo`,
    );

    // Event presentation.
    const h = this.deps.hud;
    if (res.dismissal) {
      h.flash(res.label, '#ff4b4b');
    } else if (res.boundary === 6) {
      h.flash('SIX!', '#ffd24b');
    } else if (res.boundary === 4) {
      h.flash('FOUR!', '#4bafff');
    } else if (res.extras.wides > 0) {
      h.flash('WIDE', '#cccccc', true);
      this.umpireSignal = { kind: 'wide', t: 0 };
    } else if (res.extras.noBalls > 0) {
      h.flash('NO BALL — FREE HIT NEXT', '#ff9d4b', true);
    } else if (res.extras.legByes > 0) {
      this.umpireSignal = { kind: 'legbye', t: 0 };
    } else {
      h.flash(res.label, '#e8e8e8', true);
    }
    h.setRecentBalls(this.recentSymbols());

    // Post-ball excitement decay.
    this.deps.crowd.setExcitement(res.dismissal ? 0.9 : res.boundary ? 0.8 : 0.14);

    const willReplay = this.replayReason !== null && (this.mode !== 'sim' || this.allowReplays);
    this.phase = willReplay ? 'replay' : 'betweenBalls';
    this.replayTimer = 0;
    this.betweenTimer = res.dismissal ? 3.4 : res.boundary ? 2.8 : 1.7;
  }

  private ctx_noBallNext(res: BallResolution): boolean {
    return res.extras.noBalls > 0 && this.setup.format !== 'TEST';
  }

  private recentSymbols(): string[] {
    const hist = this.match.current().history.slice(-12);
    return hist.map((r) => {
      if (r.dismissal) return 'W';
      if (r.boundary === 6) return '6';
      if (r.boundary === 4) return '4';
      if (r.extras.wides > 0) return 'wd';
      if (r.extras.noBalls > 0) return 'nb';
      const total = r.runsOffBat + r.extras.byes + r.extras.legByes;
      return total === 0 ? '•' : String(total);
    });
  }

  private startReplay(reason: 'wicket' | 'boundary'): void {
    this.replayReason = reason;
  }

  // ─── Flow ───────────────────────────────────────────────────────────────

  private endOver(): void {
    const inn = this.match.current();
    inn.swapStrike();
    this.currentBowler = this.pickNextBowler();
    // Rebuild field for the new bowler/situation without recreating batsmen.
    this.refreshField();
  }

  private refreshField(): void {
    const inn = this.match.current();
    this.field = chooseField(this.setup.format, inn, this.currentBowler!, Math.floor(inn.legalBalls / 6), inn.striker().runs > 25);
    for (let i = 0; i < this.fielders.length; i++) {
      const slot = this.field.slots[i];
      const w = slotToWorld(slot);
      const f = this.fielders[i];
      f.home.set(w.x, 0, w.z);
      f.slotName = slot.name;
      f.cricketer.root.position.set(w.x, 0, w.z);
      f.cricketer.faceToward(0.4, STRIKER_STUMPS_Z - 1);
      f.state = 'idle';
    }
  }

  private endInnings(): void {
    if (this.match.isMatchComplete()) {
      this.phase = 'matchDone';
      this.onMatchEnd?.();
      return;
    }
    this.phase = 'inningsDone';
    this.onInningsEnd?.(this.inningsSummary(), () => this.resumeAfterBreak());
  }

  private onInningsEnd: ((summary: string, resume: () => void) => void) | null = null;

  setOnInningsEnd(cb: (summary: string, resume: () => void) => void): void {
    this.onInningsEnd = cb;
  }

  resumeAfterBreak(): void {
    this.match.beginNextInnings();
    this.currentBowler = null;
    this.buildInningsEntities();
    this.updateScorebug();
    this.syncBallVisual();
    this.phase = 'preBall';
    this.deps.cameras.toTV();
  }

  private inningsSummary(): string {
    const inn = this.match.current();
    const top = [...inn.batsmen].sort((a, b) => b.runs - a.runs).slice(0, 3);
    const bowlers = [...inn.bowlers].sort((a, b) => b.wickets - a.wickets).slice(0, 2);
    let s = `${inn.batting.name}: ${inn.runs}/${inn.wickets} (${inn.oversText} ov)\n\n`;
    for (const b of top) s += `${b.spec.shortName}  ${b.runs}${b.out ? '' : '*'} (${b.balls})\n`;
    if (bowlers.length) {
      s += `\n`;
      for (const b of bowlers) s += `${b.spec.shortName}  ${Math.floor(b.legalBalls / 6)}.${b.legalBalls % 6}-${b.runs}-${b.wickets}\n`;
    }
    if (this.match.currentIdx === 0 && this.setup.format !== 'TEST') {
      s += `\n${inn.bowling.shortName} need ${inn.runs + 1} to win.`;
    }
    return s;
  }

  private playerTeamId(): string {
    return this.setup.playerTeam === 'home' ? this.setup.home.id : this.setup.away.id;
  }

  update(dt: number): void {
    if (this.paused) return;
    const inn = this.match.current();

    // HumanKit: per-frame animation update + ball head-tracking
    const ballPos = this.ballPosition();
    for (const h of this.humanEnts) {
      h.trackBall(ballPos);
      h.update(dt);
    }

    if (this.umpireSignal) {
      this.umpireSignal.t += dt;
      if (this.umpireSignal.t > 0) {
        this.umpireMain.umpireSignal(this.umpireSignal.kind, this.umpireSignal.t);
      }
    }

    switch (this.phase) {
      case 'preBall': {
        this.startDelivery();
        break;
      }
      case 'bowlingUI': {
        this.deps.input.update(dt, 'bowl');
        const t = this.deps.input.consumeBowlType();
        if (t) {
          this.bowlTypeSel = t;
          this.deps.audio.uiClick();
        }
        this.bowlMarker.position.x = THREE.MathUtils.clamp(this.deps.input.aimDeg, -2.2, 2.2);
        this.bowlMarker.position.z = STRIKER_STUMPS_Z - this.deps.input.aimLength;
        this.deps.hud.showBowlPanel(this.bowlPanelHtml(), null);
        if (this.deps.input.consumeRelease()) {
          // SPACE #1: start the run-up. Delivery plan is re-baked at release.
          this.bowlMarker.visible = false;
          this.deps.hud.hideBowlPanel();
          this.phase = 'delivering';
          this.runupT = 0;
          this.delivery!.setPlan(this.humanPlanFromUI(0.3));
          this.delivery!.beginRunup();
        }
        break;
      }
      case 'delivering': {
        if (!this.delivery) {
          this.phase = 'preBall';
          break;
        }
        if (!this.playerBatting && this.mode === 'play' && this.delivery.phase === 'runup') {
          this.runupT += dt;
          const ideal = this.delivery['runupDur' as keyof Delivery] as unknown as number;
          const frac = Math.min(1, this.runupT / (ideal + 0.22));
          this.deps.hud.showBowlPanel('<b>Release!</b>', frac);
          if (this.deps.input.consumeRelease()) {
            const err = Math.abs(this.runupT - (ideal + 0.208));
            const scale = 0.25 + Math.min(1.4, err * 9);
            this.delivery!.applyPlanError(scale, this.rng);
          }
        }
        if (this.playerBatting) this.deps.input.update(dt, 'bat');
        this.delivery.update(dt);
        // Aim wedge while batting.
        if (this.playerBatting && (this.delivery.phase === 'setup' || this.delivery.phase === 'runup' || this.delivery.phase === 'flight')) {
          this.aimWedge.visible = true;
          this.aimWedge.position.set(0.4, 0.03, STRIKER_STUMPS_Z - 1.2);
          this.aimWedge.rotation.z = (this.deps.input.aimDeg * Math.PI) / 180;
        } else {
          this.aimWedge.visible = false;
        }
        break;
      }
      case 'replay': {
        this.replayTimer += dt;
        if (this.replayTimer < 0.5) break; // let the live moment land first
        if (this.replayIdx === 0) {
          this.deps.cameras.toReplay();
          this.deps.hud.setTag('REPLAY');
        }
        const stepEvery = 1 / 50;
        const targetIdx = Math.min(this.replayBuf.length - 1, Math.floor((this.replayTimer - 0.5) / stepEvery));
        if (targetIdx < this.replayBuf.length - 1) {
          this.replayIdx = targetIdx;
          const p = this.replayBuf[this.replayIdx];
          this.ball.mesh.position.copy(p);
          this.deps.cameras.update(dt, p);
        } else {
          this.deps.hud.setTag(null);
          this.replayReason = null;
          this.replayIdx = 0;
          this.phase = 'betweenBalls';
          this.deps.cameras.toTV();
          this.syncBallVisual();
        }
        break;
      }
      case 'betweenBalls': {
        this.betweenTimer -= dt;
        const skip = this.deps.input.consumeEnter() || this.mode === 'sim';
        if (this.betweenTimer <= 0 || skip) {
          const overComplete = inn.legalBalls > 0 && inn.legalBalls % 6 === 0;
          if (inn.isComplete(this.setup.format)) {
            this.endInnings();
          } else {
            if (overComplete) this.endOver();
            this.phase = 'preBall';
            this.deps.cameras.toTV();
            this.syncBallVisual();
          }
        }
        break;
      }
      case 'inningsDone':
      case 'matchDone':
        break;
    }

    // Idle animations between phases for life.
    if (this.phase !== 'delivering' && this.phase !== 'replay') {
      const t = performance.now() / 1000;
      this.strikerEnt?.battingStance(t);
      this.nonStrikerEnt?.battingStance(t * 0.9);
      this.keeper?.cricketer.keeperStance(t);
      // Bowler walks back to his mark.
      if (this.bowlerCricketer) {
        const target = new THREE.Vector3(0.4, 0, BOWLER_STUMPS_Z - 14);
        const bp = this.bowlerCricketer.root.position;
        const d = Math.hypot(target.x - bp.x, target.z - bp.z);
        if (d > 0.4) {
          const step = Math.min(d, dt * 2.4);
          bp.x += ((target.x - bp.x) / d) * step;
          bp.z += ((target.z - bp.z) / d) * step;
          this.bowlerCricketer.faceToward(target.x, target.z);
          this.bowlerCricketer.applyRun(t * 1.1, 0.35);
        } else {
          this.bowlerCricketer.faceToward(0.4, STRIKER_STUMPS_Z);
          this.bowlerCricketer.applyRun(t * 0.1, 0.08);
        }
      }
      const all = this.fielding ? [this.keeper, ...this.fielders] : this.fielders; // bowler has his own walk-back
      for (const f of all) {
        if (f.state === 'celebrate') {
          f.timer += dt;
          f.cricketer.playCelebrate(f.hasBall ? 'arms' : f.timer % 1.4 < 0.7 ? 'jump' : 'fist', f.timer);
          if (f.timer > 2.6) f.state = 'idle';
          continue;
        }
        if (f.state === 'appeal') {
          f.timer += dt;
          f.cricketer.playAppeal(f.timer);
          if (f.timer > 1.8) f.state = 'idle';
          continue;
        }
        if (f.state === 'dive') continue; // still getting up
        // Drift back to the fielding mark between deliveries.
        f.state = 'idle';
        const fp = f.cricketer.root.position;
        const dx = f.home.x - fp.x;
        const dz = f.home.z - fp.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.6) {
          const step = Math.min(d, dt * 3.4);
          fp.x += (dx / d) * step;
          fp.z += (dz / d) * step;
          f.cricketer.faceToward(f.home.x, f.home.z);
          f.cricketer.applyRun(t * 1.4 + i01(f.spec.id), 0.42);
        } else {
          f.cricketer.faceToward(0.4, STRIKER_STUMPS_Z - 1);
          if (f === this.keeper) f.cricketer.keeperStance(t);
          else f.cricketer.fieldingReady(t);
        }
      }
    }

    this.deps.hud.update(dt);
  }

  private syncBallVisual(): void {
    this.ball.state.reset();
    this.ball.state.isDead = true;
    this.ball.mesh.position.set(0.4, 0.5, BOWLER_STUMPS_Z - 1.0);
  }

  private ballInfoHtml(speed: number): string {
    const pitch = PITCH_PRESETS[this.setup.venue.pitch].label;
    return `${speed.toFixed(0)} km/h<br/><span style="opacity:0.75">${pitch} • ${this.setup.venue.weather}</span>`;
  }

  private updateScorebug(): void {
    const inn = this.match.current();
    const h = this.deps.hud;
    const color = `#${inn.batting.color.toString(16).padStart(6, '0')}`;
    let meta1 = `CRR ${inn.runRate.toFixed(1)}`;
    let meta2 = `OV ${inn.oversText}${inn.oversLimit ? '/' + inn.oversLimit : ''}`;
    if (inn.target !== null) {
      const need = inn.target - inn.runs;
      const balls = (inn.oversLimit ?? 50) * 6 - inn.legalBalls;
      meta1 = `NEED ${need} off ${balls}`;
      meta2 = `RRR ${inn.requiredRate?.toFixed(1) ?? '-'} • CRR ${inn.runRate.toFixed(1)}`;
    }
    h.setScore(color, inn.batting.shortName, inn.runs, inn.wickets, `${inn.oversText} ov`, meta1, meta2);

    const s = inn.striker();
    const ns = inn.nonStriker();
    const bowler = this.currentBowler;
    const bc = bowler ? inn.bowlerCard(bowler) : null;
    h.setStrip(
      `<b>${s.spec.shortName}</b>* ${s.runs} (${s.balls}) &nbsp;&nbsp; ${ns.spec.shortName} ${ns.runs} (${ns.balls})<br/>` +
        (bowler && bc ? `${bowler.shortName} ${Math.floor(bc.legalBalls / 6)}.${bc.legalBalls % 6}-${bc.runs}-${bc.wickets}` : ''),
    );
  }

  private updateHint(): void {
    if (this.mode === 'watch') {
      this.deps.hud.setHint('AI v AI BROADCAST — 1/2/3 playback speed • ENTER skip • ESC pause');
      return;
    }
    this.deps.hud.setHint(
      'BAT: ←/→ aim • SPACE drive • SHIFT+SPACE loft • Z defend • X cut/pull • C sweep • ↑ charge • R/F runs<br/>' +
        'BOWL: 1-7 type • arrows aim • SPACE ×2 • ENTER skip',
    );
  }

  /** Deterministic fast-forward helper for QA: simulate n deliveries AI-vs-AI. */
  get summaryText(): string {
    const inn = this.match.current();
    return `${inn.batting.shortName} ${inn.runs}/${inn.wickets} (${inn.oversText})`;
  }
}

function i01(id: string): number {
  return (Math.abs(hashCode(id)) % 100) / 100;
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
