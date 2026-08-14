import * as THREE from 'three';
import type { HumanCricketer } from '../entities/HumanCricketer';
import type { PlayerSpec } from '../cricket/Types';
import type { BallState } from '../physics/BallState';
import type { PitchProperties } from '../physics/PitchSurface';
import type { AeroEnv } from '../physics/Aerodynamics';
import { predictTrajectory } from '../physics/Trajectory';
import { GRAVITY } from '../core/Constants';
import type { Rng } from '../core/Rng';
import { clamp01 } from '../core/Rng';
import { BOWLER_STUMPS_Z, STRIKER_STUMPS_Z } from '../world/Pitch';

export type FielderState = 'idle' | 'chase' | 'collect' | 'throwing' | 'dive' | 'celebrate' | 'appeal';

export interface FielderEnt {
  spec: PlayerSpec;
  cricketer: HumanCricketer;
  slotName: string;
  home: THREE.Vector3;
  state: FielderState;
  reactAt: number; // seconds after ball hit when movement starts
  intercept: THREE.Vector3 | null;
  interceptT: number;
  speed: number; // m/s, from fielding rating
  hasBall: boolean;
  timer: number;
  runPhase: number;
  catchPlan: CatchPlan | null;
  diveSide: 1 | -1;
}

export interface CatchPlan {
  point: THREE.Vector3;
  t: number;
  needsDive: boolean;
  prob: number;
  resolved?: boolean;
}

export interface FieldingEvents {
  onCatch: (f: FielderEnt) => void;
  onDrop: (f: FielderEnt) => void;
  onThrowReleased: (f: FielderEnt, towardEnd: 'striker' | 'bowler') => void;
  onCollect: (f: FielderEnt) => void;
}

const OUTFIELD: PitchProperties = { restitution: 0.42, friction: 0.75, seamCatchiness: 0.05, hardness: 0.6, label: 'outfield' };

export function makeFielder(spec: PlayerSpec, cricketer: HumanCricketer, slotName: string, x: number, z: number): FielderEnt {
  const rating = spec.ratings.fielding;
  return {
    spec,
    cricketer,
    slotName,
    home: new THREE.Vector3(x, 0, z),
    state: 'idle',
    reactAt: 0,
    intercept: null,
    interceptT: 0,
    speed: 6.3 + (rating / 100) * 2.6,
    hasBall: false,
    timer: 0,
    runPhase: 0,
    catchPlan: null,
    diveSide: 1,
  };
}

export class FieldingSim {
  private timeSinceHit = -1;
  bestInterceptT = Infinity;
  private retargetT = 0;

  constructor(
    private readonly fielders: FielderEnt[],
    private readonly keeper: FielderEnt,
    private readonly bowler: FielderEnt,
    private readonly events: FieldingEvents,
    private readonly rng: Rng,
  ) {}

  reset(): void {
    this.timeSinceHit = -1;
    for (const f of this.all()) {
      f.state = 'idle';
      f.hasBall = false;
      f.intercept = null;
      f.catchPlan = null;
      f.timer = 0;
      f.cricketer.recoverFromDive();
    }
  }

  all(): FielderEnt[] {
    return [this.keeper, this.bowler, ...this.fielders];
  }

  /** Called the moment the ball comes off the bat. */
  onBallHit(ball: BallState, env: AeroEnv): void {
    this.timeSinceHit = 0;
    this.bestInterceptT = Infinity;
    const traj = predictTrajectory(ball, OUTFIELD, env, 3.2, 1 / 60);

    // Find the best interceptor — where the ball first becomes COLLECTABLE
    // (slowed below pickup speed, or stopped) near a fielder.
    let best: FielderEnt | null = null;
    let bestT = Infinity;
    for (const f of this.all()) {
      const react = this.reactionTime(f);
      f.reactAt = react;
      const hit = this.interceptFor(f, traj, react);
      if (hit && hit.t < bestT) {
        bestT = hit.t;
        best = f;
        f.intercept = hit.point;
        f.interceptT = hit.t;
      }
      // Catch evaluation: does the ball pass catchably near this fielder?
      f.catchPlan = this.evalCatch(f, traj, react);
    }

    this.bestInterceptT = bestT;
    if (best && best.intercept) {
      best.state = 'chase';
    }
    // A second fielder trails for backup on long chases.
    if (best && best.intercept && best.intercept.length() > 25) {
      let second: FielderEnt | null = null;
      let secondD = Infinity;
      for (const f of this.fielders) {
        if (f === best) continue;
        const d = f.cricketer.root.position.distanceTo(best.intercept);
        if (d < secondD) {
          secondD = d;
          second = f;
        }
      }
      if (second && second.state === 'idle') {
        second.state = 'chase';
        second.intercept = best.intercept.clone();
        second.interceptT = bestT + 0.5;
      }
    }
    // Keeper and bowler hold their ends, ready to take returns.
    this.keeper.state = 'chase';
    this.keeper.intercept = new THREE.Vector3(0, 0, STRIKER_STUMPS_Z - 0.3);
    this.keeper.interceptT = 1;
    if (this.bowler.state === 'idle') {
      this.bowler.state = 'chase';
      this.bowler.intercept = new THREE.Vector3(0, 0, BOWLER_STUMPS_Z + 0.3);
      this.bowler.interceptT = 1;
    }
  }

  reactionTime(f: FielderEnt): number {
    const isKeeper = f.slotName === 'keeper';
    const base = isKeeper ? 0.04 + this.rng() * 0.03 : 0.18 + (1 - f.spec.ratings.fielding / 100) * 0.35 + this.rng() * 0.12;
    return base * this.reactScale;
  }

  /** Difficulty multipliers, set per-innings by the controller (default 1). */
  reactScale = 1;
  catchScale = 1;

  /** First moment the ball is collectable by this fielder (slow enough to pick up). */
  private interceptFor(f: FielderEnt, traj: THREE.Vector3[], react: number): { point: THREE.Vector3; t: number } | null {
    const pos = f.cricketer.root.position;
    for (let i = 2; i < traj.length; i++) {
      const t = i / 60;
      if (t < react) continue;
      const pt = traj[i];
      const ballSpeed = traj[i].distanceTo(traj[i - 1]) * 60;
      if (ballSpeed > 8.5) continue; // can't be collected yet
      const dist = Math.hypot(pt.x - pos.x, pt.z - pos.z);
      const diveReach = 2.2;
      if (dist <= f.speed * (t - react) + diveReach) {
        return { point: pt.clone(), t };
      }
    }
    return null;
  }

  /** Seconds until the ball could be collected and returned to an end — the
   *  honest currency of running between wickets. Always finite: falls back to
   *  the ball's predicted stopping point. */
  estimateCollectableReturn(ball: BallState, env: AeroEnv): number {
    if (ball.isDead) return 0.4;
    const traj = predictTrajectory(ball, OUTFIELD, env, 7.0, 1 / 60);
    if (traj.length === 0) return 1.2;
    // Ball's effective stopping point (first slow sample, else end of horizon).
    let stopIdx = traj.length - 1;
    for (let i = 2; i < traj.length; i++) {
      if (traj[i].distanceTo(traj[i - 1]) * 60 < 1.4) {
        stopIdx = i;
        break;
      }
    }
    const stopPt = traj[stopIdx];
    const stopT = stopIdx / 60;

    // A ball already flying toward the keeper/bowler will be TAKEN there — the
    // prediction must see the take, not imagine it rolling to a stop beyond.
    let takeT = Infinity;
    for (const taker of [this.keeper, this.bowler]) {
      const tp = taker.cricketer.root.position;
      for (let i = 1; i < traj.length; i++) {
        const d = Math.hypot(traj[i].x - tp.x, traj[i].z - tp.z);
        if (d < 2.2 && traj[i].y < 2.4) {
          takeT = Math.min(takeT, i / 60 + 0.12);
          break;
        }
      }
    }

    let best = Infinity;
    for (const f of this.all()) {
      if (f === this.keeper || f === this.bowler) continue;
      const fp = f.cricketer.root.position;
      // Earliest collection: intercept while rolling, else meet at the stop point.
      const hit = this.interceptFor(f, traj, 0.15);
      let collectT: number;
      let collectPt: THREE.Vector3;
      if (hit) {
        collectT = hit.t;
        collectPt = hit.point;
      } else {
        const travel = Math.hypot(fp.x - stopPt.x, fp.z - stopPt.z) / Math.max(4.5, f.speed);
        collectT = Math.max(stopT, travel + 0.15);
        collectPt = stopPt;
      }
      const throwD = Math.hypot(collectPt.x, collectPt.z - STRIKER_STUMPS_Z);
      best = Math.min(best, collectT + 0.55 + throwD / 21 + 0.12);
    }
    return Math.min(best, takeT);
  }

  private evalCatch(f: FielderEnt, traj: THREE.Vector3[], react: number): CatchPlan | null {
    const pos = f.cricketer.root.position;
    const baseReach = f.slotName === 'keeper' ? 1.7 : 1.25;
    for (let i = 0; i < traj.length; i++) {
      const t = i / 60;
      const pt = traj[i];
      if (t < react || pt.y < 0.25 || pt.y > 3.1) continue;
      const dist = Math.hypot(pt.x - pos.x, pt.z - pos.z);
      const reach = baseReach + f.speed * Math.max(0, t - react);
      const needsDive = dist > 1.25 + f.speed * Math.max(0, t - react) * 0.92;
      if (dist <= reach + (needsDive ? 1.3 : 0)) {
        const ballSpeed = i > 1 ? traj[i].distanceTo(traj[i - 1]) * 60 : 10;
        const difficulty = clamp01(
          0.12 + (ballSpeed / 40) * 0.45 + (dist / Math.max(0.6, t)) * 0.03 + (needsDive ? 0.28 : 0) + (pt.y > 2.2 ? 0.1 : 0),
        );
        const skill = f.spec.ratings.fielding / 100;
        const prob = THREE.MathUtils.clamp((0.28 + skill * 0.85 - difficulty) * 0.88 * this.catchScale, 0.03, 0.96);
        return { point: pt.clone(), t, needsDive, prob };
      }
    }
    return null;
  }

  /** Advance fielders; the Delivery owns the ball but we can stop/launch it. */
  update(dt: number, ball: BallState, env?: AeroEnv): void {
    if (this.timeSinceHit < 0) return;
    this.timeSinceHit += dt;

    // Re-point chasing fielders at where the ball will actually be collectable
    // (it slows, curls and gets cut off — a stale intercept reads as robotic).
    this.retargetT += dt;
    if (env && this.retargetT > 0.4) {
      this.retargetT = 0;
      const traj = predictTrajectory(ball, OUTFIELD, env, 3.5, 1 / 60);
      let bestChaser: FielderEnt | null = null;
      let bestHit: { point: THREE.Vector3; t: number } | null = null;
      for (const f of this.all()) {
        if (f.hasBall || f === this.keeper || f === this.bowler) continue;
        if (f.state !== 'chase' && f.state !== 'collect' && f.state !== 'idle') continue;
        const hit = this.interceptFor(f, traj, 0.05);
        if (hit && (!bestHit || hit.t < bestHit.t)) {
          bestHit = hit;
          bestChaser = f;
        }
      }
      if (bestChaser && bestHit) {
        for (const f of this.all()) {
          if (f.state === 'chase' && f !== bestChaser && f !== this.keeper && f !== this.bowler) {
            f.state = 'idle'; // stand down the stale pursuit
          }
        }
        bestChaser.state = 'chase';
        bestChaser.intercept = bestHit.point;
        bestChaser.interceptT = bestHit.t;
      }
    }

    for (const f of this.all()) {
      const root = f.cricketer.root;
      switch (f.state) {
        case 'idle':
          break;
        case 'chase': {
          if (this.timeSinceHit < f.reactAt || !f.intercept) break;
          const target = f.intercept;
          const dx = target.x - root.position.x;
          const dz = target.z - root.position.z;
          const dist = Math.hypot(dx, dz);
          const step = f.speed * dt;
          f.runPhase += dt * (f.speed / 3.2);
          if (dist > Math.max(0.15, step)) {
            root.position.x += (dx / dist) * step;
            root.position.z += (dz / dist) * step;
            f.cricketer.faceToward(target.x, target.z);
            f.cricketer.applyRun(f.runPhase, 1);
          } else {
            // Arrived at intercept.
            if (f === this.keeper || f === this.bowler) {
              f.state = 'idle';
              f.cricketer.fieldingReady(this.timeSinceHit);
            } else {
              f.state = 'collect';
              f.timer = 0;
            }
          }
          break;
        }
        case 'collect': {
          f.timer += dt;
          const dx = ball.position.x - root.position.x;
          const dz = ball.position.z - root.position.z;
          const dist = Math.hypot(dx, dz);
          if (dist > 1.2) {
            // Ball still moving: keep chasing it down.
            f.intercept = ball.position.clone();
            f.state = 'chase';
            break;
          }
          if (ball.position.y > 0.4) break; // wait for it to come down / arrive
          const ballSpeed = ball.velocity.length();
          if (ballSpeed > 8) {
            // Hard-hit ball reaching him: a genuine stop attempt, not a magic scoop.
            const stopProb = 0.4 + (f.spec.ratings.fielding / 100) * 0.5;
            if (this.rng() < stopProb) {
              ball.velocity.multiplyScalar(0.12); // smothered
              ball.velocity.y = 0;
            } else {
              // Through the hands/legs: spills past, chase resumes.
              ball.velocity.multiplyScalar(0.82);
              ball.velocity.x += (this.rng() - 0.5) * 2.5;
              f.state = 'dive';
              f.timer = 0;
              f.diveSide = ball.position.x >= root.position.x ? 1 : -1;
            }
            break;
          }
          // Pick up.
          ball.velocity.set(0, 0, 0);
          ball.angularVelocity.set(0, 0, 0);
          ball.position.y = 0.5;
          f.hasBall = true;
          f.state = 'throwing';
          f.timer = 0;
          this.events.onCollect(f);
          break;
        }
        case 'throwing': {
          f.timer += dt;
          ball.position.set(root.position.x, 1.4, root.position.z);
          f.cricketer.faceToward(0, STRIKER_STUMPS_Z);
          f.cricketer.playThrow(Math.min(1, f.timer / 0.38));
          if (f.timer >= 0.38) {
            const toStrikerEnd = true; // Delivery overrides target by setting throwAim
            const aim = this.throwAim ?? new THREE.Vector3(0, 0.9, toStrikerEnd ? STRIKER_STUMPS_Z : BOWLER_STUMPS_Z);
            const flat = Math.hypot(aim.x - root.position.x, aim.z - root.position.z);
            const throwSpeed = Math.min(23, 11 + flat * 0.4); // strong flat throw
            const t = Math.max(0.25, flat / throwSpeed);
            const vy = (aim.y - 1.4 + 0.5 * GRAVITY * t * t) / t;
            ball.velocity.set((aim.x - root.position.x) / t, vy, (aim.z - root.position.z) / t);
            // Arm error scaled by fielding rating: wild throws = overthrow risk.
            const err = (1 - f.spec.ratings.fielding / 100) * 1.6;
            ball.velocity.x += (this.rng() - 0.5) * err * 3;
            ball.velocity.z += (this.rng() - 0.5) * err * 3;
            f.hasBall = false;
            f.state = 'idle';
            this.events.onThrowReleased(f, aim.z > 0 ? 'striker' : 'bowler');
          }
          break;
        }
        case 'dive': {
          f.timer += dt;
          f.cricketer.playDive(Math.min(1, f.timer / 0.55), f.diveSide);
          if (f.timer > 0.9) {
            f.state = 'idle';
            f.cricketer.recoverFromDive();
          }
          break;
        }
        case 'celebrate': {
          f.timer += dt;
          f.cricketer.playCelebrate(f.hasBall ? 'arms' : f.timer % 1.4 < 0.7 ? 'jump' : 'fist', f.timer);
          break;
        }
        case 'appeal':
          f.cricketer.playAppeal((f.timer += dt));
          break;
      }
    }

    // Catch resolution: ball near a fielder with a live catch plan.
    if (ball.velocity.lengthSq() > 1 && ball.position.y > 0.2) {
      for (const f of this.all()) {
        const plan = f.catchPlan;
        if (!plan || plan.resolved) continue;
        const d = Math.hypot(ball.position.x - plan.point.x, ball.position.z - plan.point.z);
        const dy = Math.abs(ball.position.y - plan.point.y);
        if (d < 1.1 && dy < 1.0) {
          const caught = this.rng() < plan.prob;
          if (plan.needsDive) {
            f.state = 'dive';
            f.timer = 0;
            f.diveSide = ball.position.x >= f.cricketer.root.position.x ? 1 : -1;
          }
          if (caught) {
            ball.velocity.set(0, 0, 0);
            ball.position.y = Math.max(0.5, ball.position.y);
            f.hasBall = true;
            this.events.onCatch(f);
          } else {
            // Parried/dropped: ball spills downward with a deflection.
            ball.velocity.multiplyScalar(0.35);
            ball.velocity.y = Math.min(ball.velocity.y, 0);
            ball.velocity.x += (this.rng() - 0.5) * 4;
            ball.velocity.z += (this.rng() - 0.5) * 4;
            this.events.onDrop(f);
          }
          plan.resolved = true;
          break;
        }
      }
    }
  }

  /** Delivery sets where the next throw should be aimed (end with a runner short). */
  throwAim: THREE.Vector3 | null = null;



  celebrateAll(catcher?: FielderEnt): void {
    for (const f of this.all()) {
      if (f === catcher) {
        f.state = 'celebrate';
        f.timer = 0;
        continue;
      }
      if (f.state === 'idle' || f.state === 'chase' || f.state === 'collect') {
        f.state = 'celebrate';
        f.timer = this.rng() * 0.3;
      }
    }
  }

  appealAll(): void {
    for (const f of this.all()) {
      if (f.state === 'idle' || f.state === 'chase') {
        f.state = 'appeal';
        f.timer = 0;
      }
    }
  }
}
