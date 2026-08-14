import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
await page.goto('http://localhost:5199/?qa=1&sim=1&seed=99&format=T20', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__kriket !== undefined, null, { timeout: 20000 });
await page.evaluate(() => {
  const k = window.__kriket;
  const c = k.getController();
  const st = c['strikerEnt'];
  st.trackBall = () => {}; // kill tracking on the striker
  st.human.lookAt(null, 0);
  k.fastForward(0.6);
  k.unfreezeCam();
  k.freeCam(1.7, 1.5, 7.2, 0.45, 1.45, 9.5);
  k.engine.renderFrame();
});
await page.screenshot({ path: 'qa/shots/head_off.png' });
await browser.close();
console.log('done');
