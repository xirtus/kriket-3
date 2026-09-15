import * as THREE from 'three';
import { Engine } from './render/Engine';
import { buildGround } from './world/Ground';
import { buildPitch } from './world/Pitch';
import { Sky, SKY_PRESETS } from './world/Sky';
import { buildLighting } from './world/Lighting';
import { Stadium } from './world/Stadium';
import { Crowd } from './world/Crowd';
import { BallTrail, DustPuffs, BailPhysics } from './render/Effects';
import { CameraDirector } from './render/CameraDirector';
import { AudioDirector } from './audio/AudioDirector';
import { InputManager } from './input/InputManager';
import { HUD } from './ui/HUD';
import { Menus, type SetupChoices } from './ui/Menus';
import { MatchController } from './gameplay/MatchController';
import { TEAMS } from './cricket/Teams';
import type { MatchSetup } from './cricket/Types';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = '';
const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:fixed; inset:0; width:100vw; height:100vh; display:block;';
document.body.appendChild(canvas);

interface World {
  sky: Sky;
  stadium: Stadium;
  crowd: Crowd;
  dust: DustPuffs;
  bails: BailPhysics;
  trail: BallTrail;
  group: THREE.Group;
}

async function main(): Promise<void> {
  const engine = await Engine.create(canvas);
  engine.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  engine.renderer.shadowMap.enabled = true;

  const menus = new Menus();
  const input = new InputManager();
  const audio = new AudioDirector();
  const hud = new HUD();
  const cameras = new CameraDirector(engine.camera);

  let world: World | null = null;
  let controller: MatchController | null = null;
  let paused = false;
  let spectating = false;

  const params = new URLSearchParams(location.search);
  const isQA = params.get('qa') === '1';
  const simMode = params.get('sim') === '1';

  function buildWorld(choices: SetupChoices, seed: number): MatchController {
    // Tear down any previous world.
    if (world) engine.scene.remove(world.group);

    const group = new THREE.Group();
    const time = choices.time;
    const sky = new Sky(SKY_PRESETS[time], choices.weather);
    group.add(sky.group);
    const lighting = buildLighting(group as unknown as THREE.Scene, time);
    engine.renderer.toneMappingExposure = lighting.exposure;
    group.add(buildGround(choices.boundary));
    group.add(buildPitch(choices.pitch));
    const stadium = new Stadium(time, choices.boundary);
    group.add(stadium.group);
    const crowd = new Crowd();
    group.add(crowd.mesh);
    const dust = new DustPuffs();
    group.add(dust.group);
    const trail = new BallTrail();
    group.add(trail.line);

    engine.scene.add(group);

    const setup: MatchSetup = {
      format: choices.format,
      home: choices.playerTeam,
      away: choices.opponent,
      venue: {
        name: choices.venueName,
        pitch: choices.pitch,
        weather: choices.weather,
        time: choices.time,
        boundary: choices.boundary,
      },
      // In spectate mode the "player team" only decides who bats first — flip a coin.
      playerTeam: choices.spectate ? (Math.random() < 0.5 ? 'home' : 'away') : 'home',
      seed,
      difficulty: choices.difficulty,
    };

    // Bails physics needs stumps that live in the controller's scene graph — build
    // it after the controller exists. (Controller owns stumps.)
    const bails = new BailPhysics([]);
    const ctl = new MatchController(engine.scene, setup, {
      input,
      hud,
      audio,
      cameras,
      crowd,
      stadium,
      trail,
      dust,
      bails,
    }, choices.spectate ? 'watch' : simMode ? 'sim' : 'play');
    // Now wire bails to the controller's actual stumps groups.
    const stumpsGroups: THREE.Group[] = [];
    engine.scene.traverse((o) => {
      if (o.name === 'stumps') stumpsGroups.push(o as THREE.Group);
    });
    void bails;
    const realBails = new BailPhysics(stumpsGroups);

    world = { sky, stadium, crowd, dust, bails: realBails, trail, group };
    // Replace the deps bails reference via re-wire: simplest is to expose setter.
    ctl.setBails(realBails);
    return ctl;
  }

  const showTitleScreen = (): void => {
    spectating = false;
    engine.timeScale = 1;
    menus.showTitle(
      () => menus.showSetup(startMatch),
      () => menus.showSetup(startMatch, true),
    );
  };

  function showResult(): void {
    if (!controller) return;
    const res = controller.match.result();
    const inn = controller.match.innings;
    let title = 'MATCH DRAWN';
    if (res.kind === 'tie') title = 'MATCH TIED!';
    else if (res.kind === 'win') title = `${res.winner.name.toUpperCase()} WIN by ${res.margin.toUpperCase()}`;
    const summary = inn
      .map((i) => {
        const top = [...i.batsmen].sort((a, b) => b.runs - a.runs).slice(0, 3)
          .map((b) => `   ${b.spec.shortName} ${b.runs}${b.out ? '' : '*'} (${b.balls})`).join('\n');
        const bowl = [...i.bowlers].sort((a, b) => b.wickets - a.wickets).slice(0, 2)
          .map((b) => `   ${b.spec.shortName} ${Math.floor(b.legalBalls / 6)}.${b.legalBalls % 6}-${b.runs}-${b.wickets}`).join('\n');
        return `${i.batting.shortName} ${i.runs}/${i.wickets} (${i.oversText} ov)\n${top}\n${bowl}`;
      })
      .join('\n\n');
    menus.showResult(title, summary, () => {
      controller = null;
      if (world) {
        engine.scene.remove(world.group);
        world = null;
      }
      showTitleScreen();
    });
  }

  function startMatch(choices: SetupChoices): void {
    audio.start();
    audio.uiClick();
    engine.timeScale = 1;
    spectating = choices.spectate;
    controller = buildWorld(choices, Math.floor(Math.random() * 1e9));
    controller.setOnMatchEnd(() => {
      window.setTimeout(showResult, 1500);
    });
    controller.setOnInningsEnd((summary, resume) => {
      if (simMode) {
        resume();
      } else {
        menus.showInningsBreak(summary, () => {
          menus.hide();
          resume();
        });
      }
    });
    const battingFirst = controller.match.current().batting.name;
    menus.showToss(
      `${battingFirst} win the toss and elect to BAT first.\n\n${choices.venueName} • ${choices.format} • ${choices.pitch.replace('_', ' ')} • ${choices.weather} • ${choices.time}`,
      () => {
        menus.hide();
        if (controller) controller.paused = false;
      },
    );
    if (controller) controller.paused = true;
  }

  // Spectate playback-speed keys: 1 = live, 2 = 2×, 3 = 4×.
  window.addEventListener('keydown', (e) => {
    if (!spectating || !controller) return;
    const speed = e.code === 'Digit1' ? 1 : e.code === 'Digit2' ? 2 : e.code === 'Digit3' ? 4 : 0;
    if (speed > 0) {
      engine.timeScale = speed;
      hud.flash(speed === 1 ? 'LIVE SPEED' : `PLAYBACK ${speed}×`, '#4bafff', false);
    }
  });

  // Pause handling.
  engine.onUpdate(() => {
    if (input.pauseRequested && controller && !paused && !simMode) {
      paused = true;
      controller.paused = true;
      menus.showPause(
        () => {
          paused = false;
          if (controller) controller.paused = false;
          menus.hide();
          input.pauseRequested = false;
        },
        () => {
          paused = false;
          input.pauseRequested = false;
          controller = null;
          if (world) {
            engine.scene.remove(world.group);
            world = null;
          }
          showTitleScreen();
        },
      );
    }
  });

  engine.onUpdate((dt, elapsed) => {
    if (world) {
      world.sky.update(dt);
      world.crowd.update(dt, elapsed);
      world.dust.update(dt);
      world.bails.update(dt);
    }
    audio.update(dt);
    if (controller && !paused) {
      controller.update(dt);
      cameras.update(dt, controller.cameraBall());
    }
  });

  // ─── Boot flow ────────────────────────────────────────────────────────────
  if (isQA || simMode) {
    const defaults: SetupChoices = {
      format: (params.get('format') as SetupChoices['format']) ?? 'T20',
      playerTeam: TEAMS[0],
      opponent: TEAMS[2],
      pitch: (params.get('pitch') as SetupChoices['pitch']) ?? 'flat_batting',
      weather: 'clear',
      time: (params.get('time') as SetupChoices['time']) ?? 'day',
      venueName: 'QA Park',
      boundary: 66,
      difficulty: (params.get('difficulty') as SetupChoices['difficulty']) ?? 'club',
      spectate: false,
    };
    audio.start();
    controller = buildWorld(defaults, Number(params.get('seed') ?? 42));
    controller.setOnMatchEnd(() => {
      (window as unknown as { __kriketResult?: unknown }).__kriketResult = controller?.match.result();
    });
    controller.setOnInningsEnd((_s, resume) => resume());
    controller.allowReplays = params.get('replays') === '1';
  } else {
    showTitleScreen();
  }

  // ─── QA hooks ─────────────────────────────────────────────────────────────
  (window as unknown as { __kriket: unknown }).__kriket = {
    fastForward: (seconds: number) => {
      const steps = Math.round(seconds * 120);
      for (let i = 0; i < steps; i++) engine.stepOnce(1 / 120);
      engine.renderFrame();
    },
    getController: () => controller,
    stats: () => {
      if (!controller) return null;
      return controller.match.innings.map((i) => ({
        team: i.batting.shortName,
        runs: i.runs,
        wickets: i.wickets,
        overs: i.oversText,
        dismissals: i.batsmen.filter((b) => b.out).map((b) => b.out!.kind),
        history: i.history.map((r) => ({
          rob: r.runsOffBat, wd: r.extras.wides, nb: r.extras.noBalls, b: r.extras.byes, lb: r.extras.legByes,
          dis: r.dismissal?.kind ?? null, bd: r.boundary, cq: Math.round(r.contactQuality * 100), ck: r.contactKind, kmh: Math.round(r.speedKmh),
        })),
      }));
    },
    press: (code: string, ms = 60) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code }));
      window.setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { code })), ms);
    },
    holdAim: (deg: number) => {
      input.aimDeg = deg;
    },
    engine,
    freeCam: (x: number, y: number, z: number, tx = 0, ty = 1, tz = 0) => {
      cameras.frozen = true;
      engine.camera.position.set(x, y, z);
      engine.camera.lookAt(tx, ty, tz);
      engine.renderFrame();
    },
    unfreezeCam: () => {
      cameras.frozen = false;
    },
  };

  engine.start();
}

main().catch((err) => {
  console.error('[main] failed to start', err);
  document.body.innerHTML = `<pre style="color:#fff;background:#900;padding:20px;font-size:14px;">${String(err?.stack ?? err)}</pre>`;
});
