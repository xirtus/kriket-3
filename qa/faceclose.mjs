import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto('http://localhost:5199/?qa=1&sim=1&seed=42', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__kriket !== undefined, null, { timeout: 20000 });
const shots = [
  ['face_batter', 0.3, [1.1, 1.6, 7.6, 0.42, 1.45, 9.35]],
  ['face_keeper_close', 0.4, [1.9, 1.35, 13.9, 0.4, 1.05, 11.9]],
];
for (const [name, ff, cam] of shots) {
  await page.evaluate(({ ff, cam }) => {
    const k = window.__kriket;
    k.unfreezeCam();
    k.fastForward(ff);
    k.freeCam(...cam.slice(0, 3), ...cam.slice(3));
  }, { ff, cam });
  await page.waitForTimeout(120);
  await page.screenshot({ path: `qa/shots/${name}.png` });
}
await browser.close();
console.log('done');
