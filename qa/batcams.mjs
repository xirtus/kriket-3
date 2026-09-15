// Batting-camera QA: frame the behind-batter and helmet cams at key beats
// (run-up, ball in flight, contact) and screenshot each.
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto('http://localhost:5199/?qa=1&seed=99&format=T20&difficulty=club', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__kriket !== undefined, null, { timeout: 20000 });

// helper: run until predicate or timeout (game-seconds)
const runUntil = async (pred, maxS) => await page.evaluate(([p, m]) => {
  const k = window.__kriket;
  const c = k.getController();
  const fn = eval('(' + p + ')');
  let t = 0;
  while (t < m) {
    k.fastForward(1 / 60);
    t += 1 / 60;
    if (fn(c)) return { hit: true, t };
  }
  return { hit: false, t };
}, [pred.toString(), maxS]);

// wait for first delivery to reach runup
console.log('phase:', await page.evaluate(() => {
  const k = window.__kriket;
  k.fastForward(0.3);
  return k.getController().phase + ' / ' + k.getController().delivery?.phase;
}));

const shot = (name) => page.evaluate(() => window.__kriket.engine.renderFrame()).then(() => page.screenshot({ path: `qa/shots/batcam_${name}.png` }));

// 1. behindBatter during run-up (default cam since player bats)
await runUntil(function (c) { return c.delivery && c.delivery.phase === 'runup'; }, 20).then(r => console.log('runup', JSON.stringify(r)));
await page.evaluate(() => { const k = window.__kriket; k.fastForward(0.4); });
console.log('cam:', await page.evaluate(() => window.__kriket.getController().deps.cameras.current));
await shot('behind_runup');

// 2. behindBatter mid-flight
await runUntil(function (c) { return c.delivery && c.delivery.phase === 'flight' && !c.ballPosition().z > 0; }, 5).then(r => console.log('flight', JSON.stringify(r)));
await shot('behind_flight');

// 3. helmet cam next ball: cycle V twice (behindBatter -> helmet is one press? default is behindBatter -> press once = helmet... order tv->behind->helmet; current pref behind, so one press => helmet)
await runUntil(function (c) { return c.phase === 'betweenBalls'; }, 30).then(r => console.log('between', JSON.stringify(r)));
await page.evaluate(() => { window.__kriket.press('KeyV'); window.__kriket.fastForward(0.1); });
console.log('after V:', await page.evaluate(() => window.__kriket.getController().deps.cameras.current));
await runUntil(function (c) { return c.delivery && c.delivery.phase === 'runup'; }, 20);
await page.evaluate(() => { const k = window.__kriket; k.fastForward(0.6); });
await shot('helmet_runup');
await runUntil(function (c) { return c.delivery && c.delivery.phase === 'flight'; }, 5);
await shot('helmet_flight');

// 4. broadcast for comparison at runup
await runUntil(function (c) { return c.phase === 'betweenBalls'; }, 30);
await page.evaluate(() => { window.__kriket.press('KeyV'); window.__kriket.fastForward(0.1); });
console.log('after V2:', await page.evaluate(() => window.__kriket.getController().deps.cameras.current));
await runUntil(function (c) { return c.delivery && c.delivery.phase === 'runup'; }, 20);
await page.evaluate(() => { window.__kriket.fastForward(0.4); });
await shot('tv_runup');

await browser.close();
console.log('done');
