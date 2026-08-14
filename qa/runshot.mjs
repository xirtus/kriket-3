import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto('http://localhost:5199/?qa=1&sim=1&seed=7&format=T20', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__kriket !== undefined, null, { timeout: 20000 });
const ok = await page.evaluate(() => {
  const k = window.__kriket;
  const c = k.getController();
  const e = k.engine;
  outer: for (let i = 0; i < 120 * 600; i++) {
    e.stepOnce(1 / 120);
    const d = c['delivery'];
    if (d && d.phase === 'inplay' && d.running && d.running.strikerRunning) {
      for (let j = 0; j < 55; j++) e.stepOnce(1 / 120);
      // side-on view of the pitch mid-run
      k.unfreezeCam();
      k.freeCam(8, 2.2, 0, 0, 1.0, 2);
      e.renderFrame();
      return true;
    }
  }
  return false;
});
console.log('run shot:', ok);
await page.screenshot({ path: 'qa/shots/running_mid.png' });
await browser.close();
