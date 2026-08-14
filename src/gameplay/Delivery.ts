import * as THREE from 'three';
import { Ball } from '../entities/Ball';
import type { ShotKind } from '../entities/Cricketer';
import type { HumanCricketer } from '../entities/HumanCricketer';
import { stepBall } from '../physics/Integrator';
import { planRelease } from '../physics/Release';
import { resolveBatContact, type BatSwing, type ContactResult } from '../physics/BatContact';
import type { PitchProperties } from '../physics/PitchSurface';
import type { AeroEnv } from '../physics/Aerodynamics';
import type { DeliveryType } from '../physics/BallState';
import { BOWLER_STUMPS_Z, STRIKER_STUMPS_Z } from '../world/Pitch';
import { STRIKER_CREASE_Z, BOWLER_CREASE_Z, RunningSim } from './Running';
import { FieldingSim, type FielderEnt } from './Fielding';
import { lbwVerdict, isWide } from '../cricket/Rules';
import type { BallResolution, Dismissal } from '../cricket/Types';
import { GRAVITY, KMH_TO_MS } from '../core/Constants';
import type { Rng } from '../core/Rng';
import { gaussian, clamp01 } from '../core/Rng';

const RUNUP_LENGTH = 14;
const OUTFIELD_PITCH: PitchProperties = { restitution: 0.42, friction: 0.55, seamCatchiness: 0.05, hardness: 0.6, rollDrag: 0.16, rollLin: 2.5, label: 'Outfield' };
const HALF_STUMP_W = 0.114 + 0.036; // half stumps width + ball radius
const STUMP_TOP = 0.71 + 0.036;

/** Swept test: did the ball cross the stumps plane within the wicket this step? */
function crossesStumps(pos: THREE.Vector3, prevPos: THREE.Vector3, stumpZ: number): boolean {
  const z0 = prevPos.z;
  const z1 = pos.z;
  if ((z0 - stumpZ) * (z1 - stumpZ) > 0) return false; // same side: no crossing
  const t = Math.abs(z1 - z0) > 1e-6 ? (stumpZ - z0) / (z1 - z0) : 0;
  const x = prevPos.x + (pos.x - prevPos.x) * t;
  const y = prevPos.y + (pos.y - prevPos.y) * t;
  return Math.abs(x) <= HALF_STUMP_W && y <= STUMP_TOP && y >= -0.05;
}
const PAD_PLANE_Z = STRIKER_CREASE_Z - 0.15; // pads are just in front of the crease
const KEEPER_Z = STRIKER_STUMPS_Z + 1.9;

export interface DeliveryPlan {
  type: DeliveryType;
  speedKmh: number;
  lengthFromStumps: number; // metres in front of striker's stumps where it lands (0 = yorker, 8+ = short)
  lineOffset: number; // + off side / - leg side, metres from centre stump at the bounce
  spinRpm: number;
}

export interface ShotCommand {
  kind: ShotKind;
  aimDeg: number; // where the face points (placement), +off / -leg
  readAimDeg?: number; // where the FEET/bat move (the line read); defaults to aimDeg
  charge: boolean;
}

/** What a batting controller (human or AI) sees each physics step. */
export interface BattingView {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  tSinceRelease: number;
  timeToPlane: number;
  predictedX: number;
  predictedY: number;
  hasBounced: boolean;
  swung: boolean;
  noBall: boolean;
}

export interface BattingController {
  onFlight(view: BattingView, dt: number): ShotCommand | null;
  /** Called while ball is live in the field: running intent. */
  onInPlay(running: RunningSim, ballPos: THREE.Vector3): void;
}

export interface DeliveryHooks {
  onRelease?(speedKmh: number, plan: DeliveryPlan): void;
  onBounce?(point: THREE.Vector3, lateralDeviation: number): void;
  onSwing?(cmd: ShotCommand): void;
  onContact?(result: ContactResult, cmd: ShotCommand): void;
  onPad?(): void;
  onAppeal?(kind: 'lbw' | 'catch' | 'stumped' | 'runout' | 'none'): void;
  onBoundary?(runs: 4 | 6): void;
  onWicket?(d: Dismissal): void;
  onCatchTaken?(fielder: FielderEnt): void;
  onDropped?(fielder: FielderEnt): void;
  onRunCompleted?(total: number): void;
  onBallStep?(pos: THREE.Vector3): void;
  onDead?(res: BallResolution): void;
  onThrow?(): void;
}

export type DeliveryPhase = 'setup' | 'runup' | 'action' | 'flight' | 'inplay' | 'dead';

export interface DeliveryContext {
  rng: Rng;
  pitch: PitchProperties;
  env: AeroEnv;
  plan: DeliveryPlan;
  noBall: boolean;
  freeHit: boolean;
  boundary: number;
  ball: Ball;
  ballWear: number;
  bowler: HumanCricketer;
  strikerEnt: HumanCricketer;
  nonStrikerEnt: HumanCricketer;
  fielding: FieldingSim;
  keeper: FielderEnt;
  bowlerEnt: FielderEnt;
  batting: BattingController;
  strikerId: string;
  nonStrikerId: string;
  bowlerId: string;
  strikerBatting: number; // 40..95 rating, drives footwork/line adjustment
  /** Difficulty: scales the contact/miss windows for THIS batter (human only). */
  batForgiveness?: number;
  hooks: DeliveryHooks;
}

export class Delivery {
  phase: DeliveryPhase = 'setup';
  result: BallResolution | null = null;

  private t = 0;
  private flightT = 0;
  private inPlayT = 0;
  private swung = false;
  private swungCmd: ShotCommand | null = null;
  private contactDone = false;
  private padStruck = false;
  /** Rolled once per ball: does the ball find pad, or thread the bat-pad gate? */
  private padGate: boolean | null = null;
  private bounced = false;
  private bounceX: number | null = null;
  private crossedStrikerPlane = false;
  private wideCalled = false;
  private keeperHasBall = false;
  private bowlerHasBall = false;
  private returnThrow = false;
  private byesMode = false;
  private groundedSinceContact = false;
  private dismissal: Dismissal | null = null;
  private boundaryRuns: 4 | 6 | null = null;
  private legByesMode = false;
  private contact: ContactResult | null = null;
  private runCheckAt = -1;
  private appealFired = false;
  private shotAnimT = -1;
  private deadTimer = -1;
  private releasedSpeedKmh = 0;
  private pressTimingError = 0;
  private static readonly BAT_TRAVEL_S = 0.135;
  private runupDur: number;
  private actionDur = 0.26;
  readonly running = new RunningSim();

  constructor(private readonly ctx: DeliveryContext) {
    this.runupDur = 1.45 + ctx.rng() * 0.25;
    this.running.reset();
    ctx.bowler.setPosition(0.4, BOWLER_STUMPS_Z - RUNUP_LENGTH);
    ctx.bowler.root.rotation.y = 0;
    ctx.strikerEnt.setPosition(0.42, STRIKER_CREASE_Z + 0.55);
    ctx.strikerEnt.root.rotation.y = Math.PI;
    ctx.nonStrikerEnt.setPosition(-0.75, BOWLER_CREASE_Z - 0.6);
    ctx.nonStrikerEnt.root.rotation.y = 0;
    ctx.fielding.reset();
    ctx.fielding.throwAim = null;
  }

  beginRunup(): void {
    if (this.phase === 'setup') {
      this.phase = 'runup';
      this.t = 0;
    }
  }

  update(dt: number): void {
    this.t += dt;
    switch (this.phase) {
      case 'setup':
        this.ctx.strikerEnt.battingStance(this.t);
        this.ctx.nonStrikerEnt.battingStance(this.t);
        this.ctx.bowler.applyRun(this.t * 0.2, 0.12);
        return;
      case 'runup': {
        const p = Math.min(1, this.t / this.runupDur);
        const eased = p * p;
        const z = THREE.MathUtils.lerp(BOWLER_STUMPS_Z - RUNUP_LENGTH, BOWLER_STUMPS_Z + 1.15, eased);
        this.ctx.bowler.setPosition(0.4, z);
        this.ctx.bowler.applyRun(p * 7.5, 0.4 + p * 0.6);
        this.ctx.strikerEnt.battingStance(this.t);
        // Non-striker backs up with the bowler's approach.
        const ns = this.ctx.nonStrikerEnt.root.position;
        ns.z = BOWLER_CREASE_Z - 0.6 - p * 1.4;
        this.ctx.nonStrikerEnt.battingStance(this.t);
        if (p >= 1) {
          this.phase = 'action';
          this.t = 0;
        }
        return;
      }
      case 'action': {
        const p = Math.min(1, this.t / this.actionDur);
        this.ctx.bowler.playBowlAction(p);
        this.ctx.strikerEnt.battingStance(this.t);
        if (p >= 0.8 && this.ballNotReleased()) {
          this.release();
        }
        if (p >= 1) {
          this.phase = 'flight';
        }
        return;
      }
      case 'flight':
        this.updateFlight(dt);
        return;
      case 'inplay':
        this.updateInPlay(dt);
        return;
      case 'dead':
        this.updateDead(dt);
        return;
    }
  }

  private ballNotReleased(): boolean {
    return this.ctx.ball.state.isDead && this.flightT === 0;
  }

  private release(): void {
    const { plan, rng } = this.ctx;
    const bp = this.ctx.bowler.root.position;
    const releasePoint = new THREE.Vector3(bp.x + 0.28, 2.3, bp.z + 0.35);
    const targetPoint = new THREE.Vector3(plan.lineOffset, 0, STRIKER_STUMPS_Z - plan.lengthFromStumps);
    this.ctx.ball.state = planRelease({
      type: plan.type,
      speedKmh: plan.speedKmh,
      releasePoint,
      targetPoint,
      spinRpm: plan.spinRpm,
    });
    this.ctx.ball.state.isDead = false;
    this.ctx.ball.state.wear = this.ctx.ballWear;
    this.releasedSpeedKmh = plan.speedKmh;
    this.ctx.hooks.onRelease?.(plan.speedKmh, plan);
    void rng;
  }

  // ─── Flight: release → bat/pad/keeper ───────────────────────────────────

  private prevBallPos = new THREE.Vector3();

  private updateFlight(dt: number): void {
    this.flightT += dt;
    const s = this.ctx.ball.state;
    this.prevBallPos.copy(s.position);
    const step = stepBall(s, dt, this.ctx.pitch, this.ctx.rng, this.ctx.env);
    if (step.bounce && !this.bounced) {
      this.bounced = true;
      this.bounceX = step.bounce.point.x;
      this.ctx.hooks.onBounce?.(step.bounce.point, step.bounce.lateralDeviation);
    }
    this.ctx.ball.syncVisual();
    this.ctx.hooks.onBallStep?.(s.position);

    const pos = s.position;

    // Batting controller lookahead.
    if (!this.contactDone && !this.padStruck) {
      const planeZ = this.contactPlaneZ();
      const timeToPlane = s.velocity.z > 0.1 ? (planeZ - pos.z) / s.velocity.z : 0;
      const predictedX = pos.x + s.velocity.x * Math.max(0, timeToPlane);
      const predictedY = Math.max(0.04, pos.y + s.velocity.y * Math.max(0, timeToPlane) - 0.5 * GRAVITY * Math.max(0, timeToPlane) ** 2);
      const view: BattingView = {
        pos: s.position,
        vel: s.velocity,
        tSinceRelease: this.flightT,
        timeToPlane,
        predictedX,
        predictedY,
        hasBounced: this.bounced,
        swung: this.swung,
        noBall: this.ctx.noBall,
      };
      const cmdOut = this.ctx.batting.onFlight(view, dt);
      if (cmdOut && !this.swung) {
        this.swung = true;
        this.swungCmd = cmdOut;
        this.shotAnimT = 0;
        // Timing is committed NOW: how far is the ball from the contact plane
        // versus the bat's travel time? That error is locked in at the press —
        // exactly like a real batter committing to a swing.
        this.pressTimingError = view.timeToPlane - Delivery.BAT_TRAVEL_S;
        this.ctx.hooks.onSwing?.(cmdOut);
      }
    }

    // Swing animation; contact resolves as the ball crosses the contact plane.
    const planeZNow = this.contactPlaneZ();
    if (this.swung && this.shotAnimT >= 0) {
      this.shotAnimT += dt;
      const aimRad = ((this.swungCmd?.aimDeg ?? 0) * Math.PI) / 180;
      this.ctx.strikerEnt.playShot(this.swungCmd?.kind ?? 'drive', this.shotAnimT / 0.42, -aimRad * 0.6);
      // Footwork made visible: the body slides toward the line read.
      const readRad = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(this.swungCmd?.readAimDeg ?? this.swungCmd?.aimDeg ?? 0, -36, 36));
      const targetX = 0.42 - Math.tan(readRad) * 0.55;
      const st = this.ctx.strikerEnt.root.position;
      st.x += (targetX - st.x) * Math.min(1, dt * 9);
      if (!this.swungCmd?.charge) {
        st.z += (STRIKER_CREASE_Z + 0.55 - st.z) * Math.min(1, dt * 6);
      }
      if (!this.contactDone && this.prevBallPos.z < planeZNow && pos.z >= planeZNow) {
        this.resolveContactAtPlane();
      }
    }
    // Charging down the track: the batsman visibly advances through the shot.
    if (this.swungCmd?.charge && this.shotAnimT >= 0) {
      const st = this.ctx.strikerEnt.root.position;
      const targetZ = STRIKER_CREASE_Z - 2.2;
      if (st.z > targetZ) st.z -= dt * 4.5;
    }

    if (!this.contactDone && !this.padStruck && this.prevBallPos.z < PAD_PLANE_Z && pos.z >= PAD_PLANE_Z) {
      (this.ctx.hooks as { __dbgCross?: unknown }).__dbgCross = { x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), ck: this.swung ? 'swung' : 'no-swing' };
    }
    // Pad strike. Box tracks the batter's LIVE position (footwork moves the body
    // across the crease). But pads are not a wall: a beaten bat often leaves the
    // gate open and the ball threads through to the stumps — rolled ONCE per ball.
    if (!this.contactDone && !this.padStruck && pos.z >= PAD_PLANE_Z && pos.z < STRIKER_STUMPS_Z + 0.3) {
      if (this.padGate === null) this.padGate = this.ctx.rng() < 0.55;
      const batterX = this.ctx.strikerEnt.root.position.x;
      if (this.padGate && pos.x > batterX - 0.34 && pos.x < batterX + 0.3 && pos.y < 1.0) {
        this.handlePadStrike();
      }
    }

    // Stumps at striker end (bowled): swept plane test — a 140kph ball covers
    // ~25cm per physics step, far more than the stump depth.
    if (!this.contactDone && !this.padStruck && crossesStumps(pos, this.prevBallPos, STRIKER_STUMPS_Z)) {
      if (this.ctx.noBall || this.ctx.freeHit) {
        // Can't be bowled off a no-ball/free hit: ball deflects off stumps, play on.
        this.ctx.ball.state.velocity.multiplyScalar(0.4);
        this.enterInPlay(true);
        return;
      }
      this.dismissal = { kind: 'bowled', batsmanId: this.ctx.strikerId, bowlerId: this.ctx.bowlerId };
      this.ctx.hooks.onWicket?.(this.dismissal);
      this.ctx.hooks.onAppeal?.('none');
      this.finishBall();
      return;
    }

    // Wide / keeper plane.
    if (!this.crossedStrikerPlane && pos.z >= STRIKER_STUMPS_Z) {
      this.crossedStrikerPlane = true;
      if (!this.contactDone && !this.padStruck) {
        if (isWide(pos.x, pos.y)) {
          this.wideCalled = true;
        }
      }
    }

    // Keeper take.
    if (!this.contactDone && !this.padStruck && pos.z >= KEEPER_Z - 0.35) {
      const keeperX = this.ctx.keeper.cricketer.root.position.x;
      const reach = 1.35 + this.ctx.keeper.spec.ratings.fielding / 250;
      if (Math.abs(pos.x - keeperX) < reach && pos.y < 2.3) {
        this.keeperTake();
        return;
      }
      // Past the keeper: byes territory — batsmen scamper if it's running away.
      this.byesMode = true;
      this.enterInPlay(false);
      const returnT = this.ctx.fielding.estimateCollectableReturn(s, this.ctx.env);
      if (returnT > 3.0) this.running.startRun();
      return;
    }

    // Safety: dead if ball somehow stops.
    if (s.velocity.length() < 0.4 && this.flightT > 1.2) {
      this.enterInPlay(false);
    }
  }

  private contactPlaneZ(): number {
    return STRIKER_CREASE_Z - (this.swungCmd?.charge ? 2.3 : 0.9);
  }

  private resolveContactAtPlane(): void {
    const s = this.ctx.ball.state;
    const cmd = this.swungCmd;
    if (!cmd) return;
    if (s.velocity.z < 0.1) return;
    const pos = s.position;

    const timingError = this.pressTimingError; // committed at the press
    const predictedY = pos.y;

    // The bat goes where the batter READ the ball — line judgment is the game.
    const aimRad0 = (cmd.aimDeg * Math.PI) / 180;
    const readRad = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(cmd.readAimDeg ?? cmd.aimDeg, -36, 36));
    const batX = 0.42 - Math.tan(readRad) * 1.35;
    const ballX = pos.x;
    const rawLine = Math.abs(ballX - batX);
    // Feet cover a fixed budget of misalignment; movement after the read eats
    // into it — that's how great bowling beats good batters.
    const footworkBudget = 0.1 + (this.ctx.strikerBatting / 100) * 0.22;
    const lineOffset = Math.max(0, rawLine - footworkBudget);
    const heightPenalty = heightPenaltyFor(predictedY) * 0.28;
    const sweetSpotOffset = Math.hypot(lineOffset, heightPenalty);

    const aimRad = aimRad0;
    let baseDir = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), aimRad);
    let batSpeed = 19;
    switch (cmd.kind) {
      case 'defend':
        batSpeed = 4;
        break;
      case 'loft':
        batSpeed = 21;
        baseDir = baseDir.clone().lerp(new THREE.Vector3(0, 1, 0), 0.5).normalize();
        break;
      case 'cut':
      case 'pull': {
        batSpeed = 15;
        const sign = cmd.kind === 'pull' ? 1 : -1;
        const squareDir = new THREE.Vector3(sign, 0, 0.15 * sign).normalize();
        baseDir = squareDir.lerp(baseDir, 0.25).normalize();
        break;
      }
      case 'sweep': {
        batSpeed = 12.5;
        baseDir = new THREE.Vector3(0.85, 0.12, -0.5).normalize();
        break;
      }
      case 'drive':
      default:
        break;
    }
    if (cmd.charge) batSpeed *= 1.06;

    const swing: BatSwing = {
      velocity: baseDir.multiplyScalar(batSpeed),
      faceNormal: baseDir.clone().normalize(),
      sweetSpotOffset,
      timingError,
    };
    this.contact = resolveBatContact(s, swing, this.ctx.batForgiveness ?? 1);
    this.contactDone = true;
    (this.ctx.hooks as { __dbgContact?: unknown }).__dbgContact = {
      ballX: +ballX.toFixed(2), batX: +batX.toFixed(2), rawLine: +rawLine.toFixed(2),
      off: +sweetSpotOffset.toFixed(2), tim: +timingError.toFixed(3), py: +predictedY.toFixed(2),
      out: this.contact.outcome, q: +this.contact.quality.toFixed(2),
    };

    // Re-aim along the intended shot geometry with the collision's exit speed.
    if (this.contact.outcome !== 'missed') {
      const exit = s.velocity.length();
      const q = this.contact.quality;
      const desired = baseDir.clone().normalize();
      if (cmd.kind === 'loft') {
        desired.y += 0.62;
      } else if (cmd.kind === 'cut' || cmd.kind === 'pull') {
        desired.y += 0.10 + (1 - q) * 0.25; // mistimed cuts balloon
      } else if (cmd.kind === 'sweep') {
        desired.y += 0.18;
      } else {
        desired.y += 0.05 + (1 - q) * 0.3; // mistimed drives skew upward
      }
      if (this.contact.outcome === 'edge') {
        // Edges fly fine off the face — most bite the turf or fly wide of the cordon.
        const drops = this.ctx.rng() < 0.55;
        const fine = new THREE.Vector3(
          (this.ctx.rng() - 0.5) * 1.6,
          drops ? 0.1 + this.ctx.rng() * 0.12 : 0.4 + this.ctx.rng() * 0.55,
          0.85 + this.ctx.rng() * 0.45,
        ).normalize();
        desired.lerp(fine, 0.78);
      }
      desired.normalize();
      s.velocity.copy(desired.multiplyScalar(exit));
      s.position.y = Math.max(s.position.y, 0.35);
    }
    this.ctx.hooks.onContact?.(this.contact, cmd);

    if (this.contact.outcome === 'missed') {
      // Swung through it: pad/bowled/keeper outcomes continue to apply.
      this.contactDone = false; // allow pad/stumps checks to still fire
      this.swung = true;
      return;
    }
    this.enterInPlay(false);
  }

  private handlePadStrike(): void {
    this.padStruck = true;
    (this.ctx.hooks as { __dbgPad?: unknown }).__dbgPad = { x: +this.ctx.ball.state.position.x.toFixed(2), y: +this.ctx.ball.state.position.y.toFixed(2), swung: this.swung };
    const s = this.ctx.ball.state;
    this.ctx.hooks.onPad?.();

    // Project to stumps plane for the LBW verdict.
    const dz = STRIKER_STUMPS_Z - s.position.z;
    const tHit = s.velocity.z > 0.1 ? dz / s.velocity.z : 0;
    const projX = s.position.x + s.velocity.x * tHit;
    const projY = s.position.y + s.velocity.y * tHit - 0.5 * GRAVITY * tHit * tHit;
    const verdict = lbwVerdict({
      bounceX: this.bounceX,
      // Impact is judged against the STUMP LINE (x=0), not the batter's body:
      // hit in front of off stump while shuffled across is still out.
      impactX: s.position.x,
      projectedXAtStumps: projX,
      projectedYAtStumps: projY,
      shotOffered: this.swung,
      noBall: this.ctx.noBall,
    });

    if (verdict.out && !this.ctx.freeHit) {
      this.dismissal = { kind: 'lbw', batsmanId: this.ctx.strikerId, bowlerId: this.ctx.bowlerId };
      if (!this.appealFired) {
        this.appealFired = true;
        this.ctx.hooks.onAppeal?.('lbw');
      }
      this.ctx.hooks.onWicket?.(this.dismissal);
      s.velocity.multiplyScalar(0.15);
      this.finishBall();
      return;
    }
    // Not out: ball squirts away; leg-byes may follow.
    s.velocity.multiplyScalar(0.28);
    s.velocity.x += (this.ctx.rng() - 0.3) * 3.5;
    s.velocity.y = Math.abs(s.velocity.y) * 0.3;
    this.legByesMode = true;
    if (Math.abs(this.bounceX ?? 0) < 0.4 && Math.abs(projX) < 0.5) {
      if (!this.appealFired && !this.swung) {
        this.appealFired = true;
        this.ctx.hooks.onAppeal?.('lbw');
      }
    }
    this.enterInPlay(false);
  }

  private keeperTake(): void {
    const s = this.ctx.ball.state;
    s.velocity.set(0, 0, 0);
    s.isDead = true;
    this.keeperHasBall = true;
    this.ctx.keeper.hasBall = true;
    // Stumping: batsman charged down and missed.
    if (this.swungCmd?.charge && !this.contactDone && !this.ctx.noBall && !this.ctx.freeHit) {
      this.dismissal = { kind: 'stumped', batsmanId: this.ctx.strikerId, bowlerId: this.ctx.bowlerId, fielderId: this.ctx.keeper.spec.id };
      if (!this.appealFired) {
        this.appealFired = true;
        this.ctx.hooks.onAppeal?.('stumped');
      }
      this.ctx.hooks.onWicket?.(this.dismissal);
      this.finishBall();
      return;
    }
    this.finishBall();
  }

  // ─── In play: off the bat (or pad) into the field ───────────────────────

  private enterInPlay(fromDeflection: boolean): void {
    this.phase = 'inplay';
    this.inPlayT = 0;
    const s = this.ctx.ball.state;
    s.isDead = false;
    this.ctx.fielding.onBallHit(s, this.ctx.env);
    if (!fromDeflection && this.contactDone) {
      // Batsmen watch the ball off the bat before committing: decide a beat later,
      // when the trajectory has revealed itself.
      this.runCheckAt = 0.45;
    }
  }

  private decideInitialRun(): void {
    // A single exists when the ball can't be returned to the stumps before the
    // batsmen cross (~2.9s). Edges breed hesitation; clean contact runs sooner.
    if (this.contact?.outcome === 'missed' || !this.contact) return;
    const returnT = this.ctx.fielding.estimateCollectableReturn(this.ctx.ball.state, this.ctx.env);
    this.runGateAdj = this.ctx.rng() * 0.4; // batters only ever add caution, not recklessness
    // ...except the occasional misjudged hairy single (that's where run-outs live).
    if (this.ctx.rng() < 0.045) this.runGateAdj = -0.9;
    const need = (this.contact.outcome === 'edge' ? 3.5 : this.contact.outcome === 'mistimed' ? 3.3 : 3.15) + this.runGateAdj;
    (this.ctx.hooks as { __dbgRetT?: number }).__dbgRetT = returnT;
    (this.ctx.hooks as { __dbgStarted?: boolean }).__dbgStarted = returnT > need;
    if (returnT > need) this.running.startRun();
  }

  /** After each completed run: is there time for another? Live estimate. */
  private runGateAdj = 0;

  private evaluateAnotherRun(): void {
    if (this.running.runsCompleted >= 3) return;
    const s = this.ctx.ball.state;
    if (s.isDead || this.keeperHasBall || this.bowlerHasBall) return;
    for (const f of this.ctx.fielding.all()) {
      if (f.hasBall) return; // ball about to be thrown: no more runs
    }
    // Another run is on only if a fresh return to the stumps would still arrive
    // after the batsmen complete the next crossing.
    const returnT = this.ctx.fielding.estimateCollectableReturn(s, this.ctx.env);
    let gate = (this.running.runsCompleted === 1 ? 3.6 : 6.4) + this.runGateAdj;
    if (this.running.runsCompleted >= 2) {
      // Third runs exist only when the ball is nearly on the rope.
      const ballDeep = Math.hypot(s.position.x, s.position.z) > this.ctx.boundary - 9;
      if (!ballDeep) gate = Infinity;
    }
    let nearestF = Infinity;
    for (const f of this.ctx.fielding.all()) {
      nearestF = Math.min(nearestF, Math.hypot(f.cricketer.root.position.x - s.position.x, f.cricketer.root.position.z - s.position.z));
    }
    (this.ctx.hooks as { __dbgRuns?: unknown[] }).__dbgRuns ??= [];
    (this.ctx.hooks as { __dbgRuns?: unknown[] }).__dbgRuns!.push({
      runs: this.running.runsCompleted, returnT: +returnT.toFixed(2), gate: +gate.toFixed(2),
      ballX: +s.position.x.toFixed(0), ballZ: +s.position.z.toFixed(0), ballV: +s.velocity.length().toFixed(1), nearF: +nearestF.toFixed(0),
    });
    if (returnT > gate) {
      this.running.continueRunning();
    }
  }

  private updateInPlay(dt: number): void {
    this.inPlayT += dt;
    const s = this.ctx.ball.state;

    if (!s.isDead) {
      this.prevBallPos.copy(s.position);
      const surface = this.onPitchSquare(s.position) ? this.ctx.pitch : OUTFIELD_PITCH;
      stepBall(s, dt, surface, this.ctx.rng, this.ctx.env);
      if (s.position.y <= 0.06 && Math.abs(s.velocity.y) < 0.6) this.groundedSinceContact = true;
      this.ctx.ball.syncVisual();
      this.ctx.hooks.onBallStep?.(s.position);
    }

    this.ctx.fielding.update(dt, s, this.ctx.env);
    if (this.runCheckAt > 0 && this.inPlayT >= this.runCheckAt) {
      this.runCheckAt = -1;
      this.decideInitialRun();
    }
    this.ctx.batting.onInPlay(this.running, s.position);
    const runsBefore = this.running.runsCompleted;
    this.running.update(dt);
    if (this.running.runsCompleted !== runsBefore) {
      this.ctx.hooks.onRunCompleted?.(this.running.runsCompleted);
      this.evaluateAnotherRun();
    }
    this.updateRunnerVisuals(dt);

    if (this.shotAnimT >= 0 && this.swungCmd) {
      this.shotAnimT += dt;
      const aimRad = (this.swungCmd.aimDeg * Math.PI) / 180;
      this.ctx.strikerEnt.playShot(this.swungCmd.kind, Math.min(1, this.shotAnimT / 0.42), -aimRad * 0.6);
    }

    const pos = s.position;

    // Boundary.
    if (!this.dismissal && this.boundaryRuns === null && Math.hypot(pos.x, pos.z) > this.ctx.boundary) {
      if (s.isDead || this.keeperHasBall) {
        // held ball carried over — treat as completed catch location; ignore
      } else {
        this.boundaryRuns = this.groundedSinceContact ? 4 : 6;
        this.ctx.hooks.onBoundary?.(this.boundaryRuns);
        this.finishBall();
        return;
      }
    }

    // Direct hit on either set of stumps → run-out check (swept).
    if (!s.isDead && !this.dismissal) {
      if (crossesStumps(pos, this.prevBallPos, STRIKER_STUMPS_Z) && this.inPlayT > 0.1) {
        this.tryRunOut('striker', true);
        if (!this.dismissal) this.running.regroundNearest();
        s.velocity.multiplyScalar(0.25);
        s.isDead = true;
        return;
      }
      if (crossesStumps(pos, this.prevBallPos, BOWLER_STUMPS_Z) && this.inPlayT > 0.1) {
        this.tryRunOut('bowler', true);
        if (!this.dismissal) this.running.regroundNearest();
        s.velocity.multiplyScalar(0.25);
        s.isDead = true;
        return;
      }
    }

    // Keeper/bowler takes at the stumps → run-out check or settle.
    if (!s.isDead && s.velocity.length() > 0.5) {
      this.checkEndTake(this.ctx.keeper, 'striker');
      if (!s.isDead) this.checkEndTake(this.ctx.bowlerEnt, 'bowler');
    }

    // Dead ball detection: the ball is only dead once the batsmen are home —
    // a stopped ball with runners mid-pitch is still very much alive.
    if (!this.dismissal && this.boundaryRuns === null) {
      const ballSlow = s.velocity.length() < 0.7 && pos.y < 0.1;
      const runnersHome = !this.running.strikerRunning && !this.running.nonStrikerRunning;
      if ((this.keeperHasBall || this.bowlerHasBall) && runnersHome) {
        this.finishBall();
        return;
      }
      if (ballSlow && runnersHome) {
        this.finishBall();
        return;
      }
      if (this.inPlayT > 12) {
        this.finishBall();
        return;
      }
    }
  }

  /** FieldingSim reports a thrown return released toward the stumps. */
  markReturnThrow(): void {
    this.returnThrow = true;
  }

  private checkEndTake(taker: FielderEnt, end: 'striker' | 'bowler'): void {
    const s = this.ctx.ball.state;
    // Only controlled balls get "taken": thrown returns, or slow dribblers.
    if (!this.returnThrow && s.velocity.length() > 6) return;
    const tp = taker.cricketer.root.position;
    const d = Math.hypot(s.position.x - tp.x, s.position.z - tp.z, (s.position.y - 1) * 0.5);
    if (d < 1.7 && s.position.y < 2.4) {
      s.velocity.set(0, 0, 0);
      s.isDead = true;
      taker.hasBall = true;
      if (end === 'striker') this.keeperHasBall = true;
      else this.bowlerHasBall = true;
      this.tryRunOut(end, false);
      if (!this.dismissal) this.running.regroundNearest();
    }
  }

  private tryRunOut(end: 'striker' | 'bowler', directHit: boolean): void {
    const check = this.running.isShortOf(end);
    (this.ctx.hooks as { __dbgRO?: unknown }).__dbgRO = {
      end, who: check.who, margin: +check.margin.toFixed(2), runs: this.running.runsCompleted, short: check.short, dh: directHit,
      inPlayT: +this.inPlayT.toFixed(2), ballV: +this.ctx.ball.state.velocity.length().toFixed(1),
      rt: this.returnThrow, kh: this.keeperHasBall, phase: this.phase,
      sd: this.running.strikerDir, sz: +this.running.strikerZ.toFixed(1),
    };
    if (check.short && check.who) {
      const batsmanId = check.who === 'striker' ? this.currentStrikerRunningId() : this.currentNonStrikerRunningId();
      this.dismissal = {
        kind: 'runout',
        batsmanId,
        fielderId: undefined,
      };
      if (!this.appealFired) {
        this.appealFired = true;
        this.ctx.hooks.onAppeal?.('runout');
      }
      this.ctx.hooks.onWicket?.(this.dismissal);
      this.finishBall();
      void directHit;
    }
  }

  /** During running, "striker" in world terms swaps each run; track by z-lane. */
  private currentStrikerRunningId(): string {
    // If the original striker is heading to the bowler end, they're still the striker.
    return this.ctx.strikerId;
  }

  private currentNonStrikerRunningId(): string {
    return this.ctx.nonStrikerId;
  }

  private updateRunnerVisuals(_dt: number): void {
    const st = this.ctx.strikerEnt;
    const ns = this.ctx.nonStrikerEnt;
    st.root.position.z = this.running.strikerZ + 0.55 * Math.sign(this.running.strikerZ >= 0 ? 1 : -1) * 0; // exact z
    st.root.position.x = 0.55;
    ns.root.position.z = this.running.nonStrikerZ - 0.55 * 0;
    ns.root.position.x = -0.75;
    if (this.running.strikerRunning) {
      st.root.rotation.y = this.running.strikerZ > 0 && this.running.strikerDir === 1 ? 0 : Math.PI;
      st.faceToward(0.55, this.running.strikerZ - this.running.strikerDir * 5);
      st.applyRun(this.inPlayT * 3.1, 1);
    } else if (this.phase === 'inplay' && this.shotAnimT < 0) {
      st.battingStance(this.t);
    }
    if (this.running.nonStrikerRunning) {
      ns.faceToward(-0.75, this.running.nonStrikerZ - this.running.nonStrikerDirV * 5);
      ns.applyRun(this.inPlayT * 3.1, 1);
    } else {
      ns.battingStance(this.t);
    }
  }

  private onPitchSquare(p: THREE.Vector3): boolean {
    return Math.abs(p.x) < 2.6 && Math.abs(p.z) < 14;
  }

  // ─── Resolution ─────────────────────────────────────────────────────────

  private finishBall(): void {
    if (this.phase === 'dead') return;
    this.phase = 'dead';
    this.deadTimer = 0;
    this.running.stopAll();
    this.assemble();
  }

  private assemble(): void {
    const runs = this.running.runsCompleted;
    let runsOffBat = 0;
    let byes = 0;
    let legByes = 0;
    const wides = this.wideCalled ? 1 + (this.boundaryRuns ? this.boundaryRuns - 1 : 0) : 0;
    const noBalls = this.ctx.noBall ? 1 : 0;

    if (this.dismissal) {
      if (this.dismissal.kind === 'runout') {
        if (this.legByesMode) legByes = runs;
        else runsOffBat = runs;
      }
      // caught/bowled/lbw/stumped: no runs
    } else if (this.boundaryRuns !== null && !this.wideCalled) {
      if (this.legByesMode || this.byesMode) legByes = 0;
      if (this.legByesMode) legByes = this.boundaryRuns;
      else if (this.byesMode) byes = this.boundaryRuns;
      else if (this.padStruck && this.contact === null) legByes = this.boundaryRuns;
      else runsOffBat = this.boundaryRuns;
    } else if (this.wideCalled) {
      byes = runs; // additional runs off a wide are byes in the book (wides+byes)
    } else if (this.byesMode) {
      if (this.boundaryRuns !== null) byes = this.boundaryRuns;
      else byes = runs;
      runsOffBat = 0;
    } else if (this.legByesMode) {
      legByes = runs;
    } else if (this.padStruck) {
      legByes = runs;
    } else {
      runsOffBat = runs;
    }

    const label = buildLabel(this.dismissal, this.boundaryRuns, runsOffBat, byes, legByes, wides, noBalls, this.contact);
    this.result = {
      runsOffBat,
      extras: { wides, noBalls, byes, legByes },
      dismissal: this.dismissal,
      boundary: this.wideCalled ? null : this.boundaryRuns,
      legal: !this.wideCalled && !this.ctx.noBall,
      label,
      speedKmh: this.releasedSpeedKmh,
      contactQuality: this.contact?.quality ?? 0,
      contactKind: this.contact?.outcome ?? 'none',
      shotX: this.ctx.ball.state.position.x,
      shotZ: this.ctx.ball.state.position.z,
    };
  }


  /** Replace the plan before release (human bowling UI bakes aim at run-up start). */
  setPlan(plan: DeliveryPlan): void {
    if (this.phase === 'setup' || this.phase === 'runup') this.ctx.plan = plan;
  }

  /** Human-bowling release quality: nudges line/length by skill-scaled error. */
  applyPlanError(scale: number, rng: Rng): void {
    if (this.phase !== 'runup' && this.phase !== 'action') return;
    this.ctx.plan.lineOffset += gaussian(rng) * 0.3 * scale;
    this.ctx.plan.lengthFromStumps = Math.max(0.1, this.ctx.plan.lengthFromStumps + gaussian(rng) * 1.0 * scale);
  }

  /** FieldingSim reports a completed catch off the bat. */
  notifyCaught(fielderId: string): void {
    if (this.phase !== 'inplay') return;
    if (!this.contact || this.contact.outcome === 'missed') return; // must be off the bat
    if (this.ctx.noBall || this.ctx.freeHit) return; // not out off a no-ball / free hit
    this.dismissal = { kind: 'caught', batsmanId: this.ctx.strikerId, bowlerId: this.ctx.bowlerId, fielderId };
    this.ctx.hooks.onWicket?.(this.dismissal);
    this.finishBall();
  }

  private updateDead(dt: number): void {
    this.deadTimer += dt;
    // Keep visuals alive: fielders settle, batsmen reset.
    this.ctx.fielding.update(dt, this.ctx.ball.state, this.ctx.env);
    if (this.deadTimer > 0.4 && this.result) {
      this.ctx.hooks.onDead?.(this.result);
      this.deadTimer = -999; // fire once
    }
  }
}

function heightPenaltyFor(h: number): number {
  if (h < 0.25) return clamp01((0.25 - h) / 0.2);
  if (h > 1.35) return clamp01((h - 1.35) / 0.65);
  return 0;
}

function buildLabel(
  d: Dismissal | null,
  boundary: 4 | 6 | null,
  runs: number,
  byes: number,
  legByes: number,
  wides: number,
  noBalls: number,
  contact: ContactResult | null,
): string {
  if (d) {
    switch (d.kind) {
      case 'bowled':
        return 'BOWLED HIM!';
      case 'caught':
        return 'CAUGHT!';
      case 'lbw':
        return 'LBW!';
      case 'runout':
        return 'RUN OUT!';
      case 'stumped':
        return 'STUMPED!';
      case 'hitwicket':
        return 'HIT WICKET!';
    }
  }
  if (boundary === 6) return 'SIX! That is enormous!';
  if (boundary === 4) return contact?.outcome === 'edge' ? 'Edged... and away for FOUR!' : 'FOUR! Glorious shot!';
  if (wides > 0) return 'Wide called.';
  if (noBalls > 0) return 'No-ball! Free hit coming.';
  if (legByes > 0) return `${legByes} leg bye${legByes > 1 ? 's' : ''}.`;
  if (byes > 0) return `${byes} bye${byes > 1 ? 's' : ''}.`;
  if (runs === 0) return contact?.outcome === 'edge' ? 'Beaten past the edge!' : 'Dot ball.';
  if (runs === 1) return 'Worked away for a single.';
  if (runs === 2) return 'Two runs, good running.';
  return `${runs} runs!`;
}

/** Small helper: gaussian error for AI/human release and shot dispersion. */
export function skillError(rng: Rng, scale: number): number {
  return gaussian(rng) * scale;
}

export { KMH_TO_MS };
