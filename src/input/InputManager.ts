export type ShotInputKind = 'drive' | 'loft' | 'defend' | 'cut' | 'pull' | 'sweep';

/**
 * Keyboard map
 *  Batting:  ←/→ aim (hold to move)  SPACE drive  SHIFT+SPACE loft
 *            Z defend  X cut/pull (sign of aim)  C sweep  ↑ charge (hold)
 *            R run / take another   F send back
 *  Bowling:  1-7 delivery type  ←/→/↑/↓ aim target  SPACE start run-up,
 *            SPACE again at the crease for release quality
 *  General:  V cycle batting camera   ENTER skip pause / continue   ESC pause
 */
export class InputManager {
  aimDeg = 0;
  private left = false;
  private right = false;
  chargeHeld = false;
  private pendingShot: { kind: ShotInputKind; at: number } | null = null;
  private runPressed = false;
  private backPressed = false;
  private enterPressed = false;
  private releasePressed = false;
  private bowlType: string | null = null;
  private camCycle = false;
  aimLength = 5; // metres in front of stumps (bowling target)
  private up = false;
  private down = false;
  pauseRequested = false;

  constructor() {
    window.addEventListener('keydown', (e) => this.key(e, true));
    window.addEventListener('keyup', (e) => this.key(e, false));
  }

  private key(e: KeyboardEvent, down: boolean): void {
    switch (e.code) {
      case 'ArrowLeft':
        this.left = down;
        e.preventDefault();
        break;
      case 'ArrowRight':
        this.right = down;
        e.preventDefault();
        break;
      case 'ArrowUp':
        this.up = down;
        this.chargeHeld = down;
        e.preventDefault();
        break;
      case 'ArrowDown':
        this.down = down;
        e.preventDefault();
        break;
      case 'Space':
        if (down && !e.repeat) {
          this.pendingShot = { kind: e.shiftKey ? 'loft' : 'drive', at: performance.now() / 1000 };
          this.releasePressed = true;
        }
        e.preventDefault();
        break;
      case 'KeyZ':
        if (down) this.pendingShot = { kind: 'defend', at: performance.now() / 1000 };
        break;
      case 'KeyX':
        if (down) this.pendingShot = { kind: this.aimDeg < 0 ? 'pull' : 'cut', at: performance.now() / 1000 };
        break;
      case 'KeyC':
        if (down) this.pendingShot = { kind: 'sweep', at: performance.now() / 1000 };
        break;
      case 'KeyR':
        if (down) this.runPressed = true;
        break;
      case 'KeyF':
        if (down) this.backPressed = true;
        break;
      case 'KeyV':
        if (down && !e.repeat) this.camCycle = true;
        break;
      case 'Enter':
        if (down) this.enterPressed = true;
        break;
      case 'Escape':
        if (down) this.pauseRequested = !this.pauseRequested;
        break;
      case 'Digit1':
        if (down) this.bowlType = 'seam-up';
        break;
      case 'Digit2':
        if (down) this.bowlType = 'outswing';
        break;
      case 'Digit3':
        if (down) this.bowlType = 'inswing';
        break;
      case 'Digit4':
        if (down) this.bowlType = 'offspin';
        break;
      case 'Digit5':
        if (down) this.bowlType = 'legspin';
        break;
      case 'Digit6':
        if (down) this.bowlType = 'googly';
        break;
      case 'Digit7':
        if (down) this.bowlType = 'slower';
        break;
    }
  }

  /** Per-frame aim drift while arrows held. */
  update(dt: number, mode: 'bat' | 'bowl'): void {
    const speed = mode === 'bat' ? 130 : 60;
    if (this.left) this.aimDeg = Math.max(mode === 'bat' ? -85 : -2.2, this.aimDeg - speed * dt);
    if (this.right) this.aimDeg = Math.min(mode === 'bat' ? 85 : 2.2, this.aimDeg + speed * dt);
    if (mode === 'bowl') {
      if (this.up) this.aimLength = Math.min(11.5, this.aimLength + 5 * dt);
      if (this.down) this.aimLength = Math.max(0.2, this.aimLength - 5 * dt);
    }
  }

  consumeShot(): { kind: ShotInputKind; at: number } | null {
    const s = this.pendingShot;
    this.pendingShot = null;
    return s;
  }

  peekShot(): { kind: ShotInputKind; at: number } | null {
    return this.pendingShot;
  }

  consumeRun(): boolean {
    const r = this.runPressed;
    this.runPressed = false;
    return r;
  }

  consumeBack(): boolean {
    const b = this.backPressed;
    this.backPressed = false;
    return b;
  }

  consumeEnter(): boolean {
    const v = this.enterPressed;
    this.enterPressed = false;
    return v;
  }

  consumeRelease(): boolean {
    const v = this.releasePressed;
    this.releasePressed = false;
    return v;
  }

  consumeBowlType(): string | null {
    const t = this.bowlType;
    this.bowlType = null;
    return t;
  }

  consumeCamCycle(): boolean {
    const v = this.camCycle;
    this.camCycle = false;
    return v;
  }
}
