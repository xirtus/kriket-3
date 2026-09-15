import * as THREE from 'three';
import { BOWLER_STUMPS_Z, STRIKER_STUMPS_Z } from '../world/Pitch';

export type CamState = 'tv' | 'follow' | 'wicket' | 'replay' | 'behindBatter' | 'helmet';

/**
 * Broadcast camera work: the classic high behind-the-bowler TV frame, a panning
 * follow once the ball is hit, a cut to the stumps for wickets, and a side-on
 * replay position. For batting there are two player-centric frames — an
 * over-the-off-shoulder 3rd person and a helmet cam — both composed so the
 * stumps the batter is protecting are part of the picture. Transitions are
 * critically damped so moves feel like a truck, not a teleport (except
 * deliberate hard cuts).
 */
export class CameraDirector {
  frozen = false;
  /** World-space eye position of the striker (helmet cam anchor). */
  helmetEye: ((out: THREE.Vector3) => void) | null = null;
  /** What the batter watches before the ball is live (the bowler, usually). */
  watchPoint: ((out: THREE.Vector3) => void) | null = null;
  private state: CamState = 'tv';
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3(0, 1, STRIKER_STUMPS_Z);
  private stateT = 0;
  private readonly sA = new THREE.Vector3();
  private readonly sB = new THREE.Vector3();
  private readonly sC = new THREE.Vector3();
  private readonly sD = new THREE.Vector3();

  /**
   * Behind-batter frame geometry (right-hander at x≈0.42, stumps at x=0):
   * parked over the off-side shoulder so the stumps sit just left of the
   * batter in frame — the pins he's defending are always visible down to the
   * bails — while the keeper drops out of the bottom edge and the look rests
   * on a good length so bowler, pitch and batter share the screen.
   */
  private static readonly BEHIND_POS = new THREE.Vector3(2.15, 2.95, STRIKER_STUMPS_Z + 4.3);
  private static readonly BEHIND_LOOK = new THREE.Vector3(0.1, 0.55, STRIKER_STUMPS_Z - 5.2);
  private static readonly HELMET_FALLBACK_EYE = new THREE.Vector3(0.42, 1.62, STRIKER_STUMPS_Z - 0.7);

  constructor(private readonly camera: THREE.PerspectiveCamera) {
    this.toTV();
  }

  get current(): CamState {
    return this.state;
  }

  toTV(): void {
    this.state = 'tv';
    this.stateT = 0;
    this.pos.set(-2.4, 9.4, BOWLER_STUMPS_Z - 24.5);
    this.camera.position.copy(this.pos);
    this.camera.fov = 33;
    this.camera.updateProjectionMatrix();
    this.look.set(0.3, 1.35, STRIKER_STUMPS_Z - 2);
  }

  toFollow(): void {
    if (this.state !== 'follow') {
      this.state = 'follow';
      this.stateT = 0;
    }
  }

  toBehindBatter(): void {
    this.state = 'behindBatter';
    this.stateT = 0;
    this.pos.copy(CameraDirector.BEHIND_POS);
    this.camera.position.copy(this.pos);
    this.camera.fov = 41;
    this.camera.updateProjectionMatrix();
    this.look.copy(CameraDirector.BEHIND_LOOK);
  }

  toHelmet(): void {
    this.state = 'helmet';
    this.stateT = 0;
    this.camera.fov = 56;
    this.camera.updateProjectionMatrix();
    // Snap straight to the eye so the cut never swoops through the skull.
    const eye = this.helmetEyePos(this.sA);
    this.helmetTargets(eye, null, this.sB, this.sC);
    this.camera.position.copy(this.sB);
    this.look.copy(this.sC);
  }

  toWicket(): void {
    this.state = 'wicket';
    this.stateT = 0;
    this.pos.set(2.4, 1.6, STRIKER_STUMPS_Z + 3.2);
    this.camera.fov = 33;
    this.camera.updateProjectionMatrix();
  }

  toReplay(): void {
    this.state = 'replay';
    this.stateT = 0;
    this.pos.set(19, 2.6, 1.6);
    this.camera.fov = 27;
    this.camera.updateProjectionMatrix();
    this.look.set(0, 0.8, 2);
    this.camera.position.copy(this.pos);
  }

  /** Striker's eye position, world space (fallback if no anchor wired). */
  private helmetEyePos(out: THREE.Vector3): THREE.Vector3 {
    if (this.helmetEye) this.helmetEye(out);
    else out.copy(CameraDirector.HELMET_FALLBACK_EYE);
    return out;
  }

  /**
   * Helmet-cam eye + look: eyes sit a touch above the head pivot and nudged
   * toward the action so the helmet grille stays behind the near plane.
   * NB: eye/outPos/outLook must be distinct vectors (and not the shared sD).
   */
  private helmetTargets(eye: THREE.Vector3, ballPos: THREE.Vector3 | null, outPos: THREE.Vector3, outLook: THREE.Vector3): void {
    const watch = this.sD;
    if (ballPos) watch.copy(ballPos);
    else if (this.watchPoint) this.watchPoint(watch);
    else watch.set(0.4, 1.9, BOWLER_STUMPS_Z - 6);
    const fwd = outLook.copy(watch).sub(eye); // temp: direction, finalized below
    fwd.y = 0;
    if (fwd.lengthSq() > 1e-4) fwd.normalize();
    else fwd.set(0, 0, -1);
    outPos.copy(eye).addScaledVector(fwd, 0.17);
    outPos.y = eye.y + 0.07;
    outLook.copy(watch);
  }

  update(dt: number, ballPos: THREE.Vector3 | null): void {
    if (this.frozen) return;
    this.stateT += dt;
    const cam = this.camera;
    switch (this.state) {
      case 'tv': {
        // Subtle tracking: keep the striker framed, drift with the ball pre-hit.
        const target = ballPos ? ballPos : new THREE.Vector3(0.3, 1, STRIKER_STUMPS_Z - 2);
        this.look.lerp(new THREE.Vector3(target.x * 0.35, Math.max(0.6, target.y * 0.5), target.z), 1 - Math.pow(0.02, dt));
        cam.position.lerp(this.pos, 1 - Math.pow(0.001, dt));
        break;
      }
      case 'follow': {
        if (ballPos) {
          // Snap onto the ball like a real TV operator: fast pan, gentle dolly,
          // and widen as the shot travels.
          this.look.lerp(ballPos, 1 - Math.pow(0.000001, dt));
          const d = Math.hypot(ballPos.x, ballPos.z);
          const targetPos = new THREE.Vector3(
            THREE.MathUtils.clamp(ballPos.x * 0.22, -9, 9) - 2.4,
            9.4 + d * 0.16,
            BOWLER_STUMPS_Z - 24.5 + Math.max(0, ballPos.z) * 0.3,
          );
          cam.position.lerp(targetPos, 1 - Math.pow(0.01, dt));
          const targetFov = THREE.MathUtils.clamp(33 + d * 0.16, 33, 44);
          cam.fov += (targetFov - cam.fov) * Math.min(1, dt * 2.4);
          cam.updateProjectionMatrix();
        }
        break;
      }
      case 'behindBatter': {
        // Rest on a good length; once the ball is live, track it — clamped so
        // the pan never loses the stumps-and-batter foreground.
        if (ballPos) {
          this.sA.set(
            THREE.MathUtils.clamp(ballPos.x, -1.8, 2.2),
            THREE.MathUtils.clamp(ballPos.y, 0.15, 2.8),
            THREE.MathUtils.clamp(ballPos.z, BOWLER_STUMPS_Z - 1, STRIKER_STUMPS_Z - 0.4),
          );
          this.look.lerp(this.sA, 1 - Math.pow(0.001, dt));
        } else {
          this.look.lerp(CameraDirector.BEHIND_LOOK, 1 - Math.pow(0.005, dt));
        }
        cam.position.lerp(this.pos, 1 - Math.pow(0.0005, dt));
        break;
      }
      case 'helmet': {
        // Glued to the striker's head with a short spring so a solid drive
        // doesn't feel like a neck brace; watches the bowler until the ball
        // is live, then the ball itself.
        const eye = this.helmetEyePos(this.sA);
        this.helmetTargets(eye, ballPos, this.sB, this.sC);
        cam.position.lerp(this.sB, 1 - Math.pow(0.0001, dt));
        this.look.lerp(this.sC, 1 - Math.pow(0.00001, dt));
        break;
      }
      case 'wicket': {
        this.look.lerp(new THREE.Vector3(0, 0.7, STRIKER_STUMPS_Z), 1 - Math.pow(0.001, dt));
        cam.position.lerp(this.pos, 1 - Math.pow(0.005, dt));
        break;
      }
      case 'replay': {
        if (ballPos) this.look.lerp(ballPos, 1 - Math.pow(0.0005, dt));
        else this.look.lerp(new THREE.Vector3(0, 0.8, 2), 1 - Math.pow(0.005, dt));
        cam.position.lerp(this.pos, 1 - Math.pow(0.005, dt));
        break;
      }
    }
    cam.lookAt(this.look);
  }
}
