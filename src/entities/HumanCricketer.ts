import * as THREE from 'three';
import {
  Human, createAthlete, SKIN_TONES, type TeamKit,
} from '@xirtus/humankit';
import { makeCricketBat, makeHelmet, makeCap, makePads, makeGloves } from '@xirtus/humankit/equipment';
import type { CricketerOptions, ShotKind, CelebrateKind } from './Cricketer';

/**
 * HumanCricketer — drop-in replacement for the legacy capsule Cricketer,
 * backed by Xirtus HumanKit. Same public API so gameplay code is untouched;
 * internally everything is scrubbed canonical-rig clips + IK.
 */

const nearestSkinIndex = (hex: number): number => {
  const c = new THREE.Color(hex);
  let best = 0, bd = Infinity;
  SKIN_TONES.forEach((t, i) => {
    const o = new THREE.Color(t);
    const d = Math.abs(c.r - o.r) + Math.abs(c.g - o.g) + Math.abs(c.b - o.b);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
};

export function kitFrom(shirt: number, trousers: number, accent = 0xf5f5f0): TeamKit {
  return { primary: shirt, secondary: trousers, accent };
}

export class HumanCricketer {
  readonly human: Human;
  readonly root: THREE.Group;
  readonly height: number;
  static tierOverride: 'hero' | 'gameplay' | null = null;
  private celebrateMode = '';
  private ballTarget: THREE.Vector3 | null = null;
  private batObj: THREE.Group | null = null;
  private aimYaw = 0;

  constructor(opts: CricketerOptions & { seed?: number; surname?: string; number?: number; longSleeve?: boolean }) {
    const seed = opts.seed ?? 1;
    const kit: TeamKit = {
      primary: opts.shirt, secondary: opts.trousers, accent: 0xf5f5f0,
      surname: opts.surname, number: opts.number,
    };
    const skinIdx = nearestSkinIndex(opts.skin);
    this.human = createAthlete(seed, {
      tier: HumanCricketer.tierOverride ?? (opts.withBat ? 'hero' : 'gameplay'),
      sleeve: opts.longSleeve ? 'long' : 'short',
    });
    this.human.dna.skinTone = skinIdx; // note: DNA skinTone is baked at build; kept for report fidelity
    this.human.setTeamKit(kit);
    // height parity with the old scale option
    const targetH = 1.82 * (opts.scale ?? 1);
    const s = targetH / this.human.dna.body.height;
    this.human.root.scale.setScalar(s);
    this.height = targetH;
    this.root = this.human.root;

    if (opts.withBat) this.equipBat();
    if (opts.pads) {
      const pads = makePads();
      this.human.equip(pads.left, 'calf_l', { pos: new THREE.Vector3(0, -0.17, 0.05) });
      this.human.equip(pads.right, 'calf_r', { pos: new THREE.Vector3(0, -0.17, 0.05) });
      const gloves = makeGloves();
      this.human.equip(gloves.left, 'hand_l', { pos: new THREE.Vector3(0.03, -0.035, 0), rot: new THREE.Euler(0, 0, 0.785) });
      this.human.equip(gloves.right, 'hand_r', { pos: new THREE.Vector3(-0.03, -0.035, 0), rot: new THREE.Euler(0, 0, -0.785) });
    }
    if (opts.helmet != null) {
      this.human.equip(makeHelmet(opts.helmet), 'socket_head', { pos: new THREE.Vector3(0, 0.012, 0.004) });
    } else if (opts.cap != null) {
      this.human.equip(makeCap(opts.cap), 'socket_head', { pos: new THREE.Vector3(0, 0.030, 0.004) });
    }
    this.human.enableGroundAlign(() => 0);
  }

  // ── ball tracking (head + eyes) ────────────────────────────────────────
  trackBall(pos: THREE.Vector3 | null): void { this.ballTarget = pos; }

  private applyBatIK(): void {
    if (!this.batObj) return;
    // left hand to the handle, just below the right hand
    const grip = new THREE.Vector3(0, 0.085, 0);
    this.batObj.updateWorldMatrix(true, false);
    grip.applyMatrix4(this.batObj.matrixWorld);
    const pole = grip.clone().add(new THREE.Vector3(0, -0.35, -0.3).applyQuaternion(this.root.quaternion));
    this.human.ikLimb('arm_l', grip, pole);
  }

  private batAligned = false;

  private equipBat(): void {
    this.batObj = makeCricketBat();
    this.human.equip(this.batObj, 'socket_weapon', {
      pos: new THREE.Vector3(0, -0.03, 0.015),
      rot: new THREE.Euler(-1.25, 0, -0.12), // provisional; alignBat() solves exactly
    });
  }

  /**
   * Solve the bat mount rotation so that, in the stance pose, the blade lies
   * along the classic stance direction (down, slightly across, face open).
   * The grip is rigid — one solve is correct for the whole innings.
   */
  private alignBat(): void {
    if (!this.batObj || this.batAligned) return;
    this.batAligned = true;
    this.scrubNow('cricket_stance', 0.5);
    this.root.updateWorldMatrix(true, true);
    const sock = this.human.socket('socket_weapon');
    // desired bat direction in ROOT-local space (character faces +Z):
    const D = new THREE.Vector3(0.10, -0.95, 0.30).normalize();
    const N = new THREE.Vector3(0.85, 0.10, 0.51).normalize(); // blade face toward cover
    const rootQ = this.root.getWorldQuaternion(new THREE.Quaternion());
    const Dw = D.applyQuaternion(rootQ);
    const Nw = N.applyQuaternion(rootQ);
    const Y = Dw.clone().negate();
    const Z = Nw.clone().sub(Y.clone().multiplyScalar(Nw.dot(Y))).normalize();
    const X = new THREE.Vector3().crossVectors(Y, Z).normalize();
    const m = new THREE.Matrix4().makeBasis(X, Y, Z);
    const qBatWorld = new THREE.Quaternion().setFromRotationMatrix(m);
    const qSockWorld = sock.getWorldQuaternion(new THREE.Quaternion());
    this.batObj.quaternion.copy(qSockWorld.invert().multiply(qBatWorld));
  }

  private scrubNow(name: string, progress: number): void {
    this.human.scrub(name, progress);
    this.human.update(0);
    if (this.aimYaw !== 0 && name.startsWith('cricket_shot')) {
      this.human.bone('spine_02').rotation.y += this.aimYaw * 0.5;
      this.human.bone('spine_03').rotation.y += this.aimYaw * 0.25;
      this.human.bone('hips').rotation.y += this.aimYaw * 0.3;
    }
    // two-handed grip only in the stance/quiet phases; shots animate both arms free
    if (name === 'cricket_stance' || name === 'cricket_leave') this.applyBatIK();
  }

  // ── legacy API ─────────────────────────────────────────────────────────
  setPosition(x: number, z: number): void {
    this.root.position.x = x;
    this.root.position.z = z;
  }

  faceToward(x: number, z: number): void {
    this.root.rotation.y = Math.atan2(x - this.root.position.x, z - this.root.position.z);
  }

  applyRun(phase: number, intensity: number): void {
    const clip = intensity > 0.85 ? 'sprint' : intensity > 0.45 ? 'jog' : 'walk';
    this.scrubNow(clip, ((phase % 1) + 1) % 1);
  }

  battingStance(t: number): void {
    this.celebrateMode = '';
    if (!this.batAligned && this.batObj) this.alignBat();
    this.scrubNow('cricket_stance', ((t / 2.2) % 1 + 1) % 1);
  }

  playShot(kind: ShotKind, progress: number, aimYaw = 0): void {
    if (!this.batAligned && this.batObj) this.alignBat();
    this.aimYaw = aimYaw;
    this.scrubNow(`cricket_shot_${kind}`, Math.min(1, progress));
    this.aimYaw = 0;
  }

  playBowlAction(progress: number): void {
    this.scrubNow('cricket_bowl_action', Math.min(1, progress));
  }

  fieldingReady(t: number): void {
    this.celebrateMode = '';
    this.scrubNow('cricket_field_ready', ((t / 2.4) % 1 + 1) % 1);
  }

  keeperStance(t: number): void {
    this.scrubNow('cricket_keeper_stance', ((t / 2.4) % 1 + 1) % 1);
  }

  playThrow(progress: number): void {
    this.scrubNow('throw_overarm', Math.min(1, progress));
  }

  playDive(progress: number, side: 1 | -1): void {
    this.scrubNow(side === 1 ? 'catch_dive_r' : 'catch_dive_l', Math.min(1, progress));
  }

  recoverFromDive(): void {
    this.human.endScrub();
    this.scrubNow('cricket_field_ready', 0.2);
  }

  playCelebrate(kind: CelebrateKind, t: number): void {
    if (this.celebrateMode === kind) return; // let it play
    this.celebrateMode = kind;
    this.human.endScrub();
    if (kind === 'arms') this.human.play('cheer', { fade: 0.15 });
    else if (kind === 'jump') this.human.play('victory', { fade: 0.15 });
    else this.human.play('cricket_celebrate_fist', { fade: 0.15 });
    void t;
  }

  playAppeal(t: number): void {
    this.scrubNow('cricket_appeal', Math.min(1, t / 1.6));
  }

  /** relaxed neutral stand (umpires between signals, anyone idling) */
  idleStand(t: number): void {
    this.scrubNow('idle', ((t / 4.0) % 1 + 1) % 1);
  }

  umpireSignal(kind: 'out' | 'four' | 'six' | 'wide' | 'legbye' | 'dead', t: number): void {
    const clip = kind === 'dead' ? 'cricket_umpire_deadball' : `cricket_umpire_${kind}`;
    this.scrubNow(clip, Math.min(1, t / 1.6));
  }

  update(dt: number): void {
    // ball tracking: batters/keeper watch the ball
    if (this.ballTarget) this.human.lookAt(this.ballTarget, 0.85);
    this.human.update(dt);

  }
}
