import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto('http://localhost:5199/?qa=1&sim=1&seed=99&format=T20', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__kriket !== undefined, null, { timeout: 20000 });
await page.evaluate(() => {
  const k = window.__kriket;
  k.fastForward(0.5);
  k.unfreezeCam();
  k.freeCam(1.7, 1.5, 7.2, 0.45, 1.45, 9.5);   // front-side on the striker
  k.engine.renderFrame();
});
await page.screenshot({ path: 'qa/shots/stance_check.png' });
await browser.close();
console.log('done');
