import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto('http://localhost:5199/?qa=1&sim=1&seed=99&format=T20', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__kriket !== undefined, null, { timeout: 20000 });
const shots = [
  ['fc_tv_delivery', 1.55, null], // TV camera default
  ['fc_batting_close', 0.35, [2.2, 1.6, 6.8, 0.42, 1.25, 9.5]],
  ['fc_midwicket', 0.5, [-6, 2.5, 6, 0, 1.0, 9.5]],
];
for (const [name, ff, cam] of shots) {
  await page.evaluate(({ ff, cam }) => {
    const k = window.__kriket;
    if (cam) { k.unfreezeCam(); k.freeCam(...cam.slice(0, 3), ...cam.slice(3)); }
    k.fastForward(ff);
    if (cam) { k.unfreezeCam(); k.freeCam(...cam.slice(0, 3), ...cam.slice(3)); }
    else k.engine.renderFrame();
  }, { ff, cam });
  await page.waitForTimeout(150);
  await page.screenshot({ path: `qa/shots/${name}.png` });
}
await browser.close();
console.log('done');
