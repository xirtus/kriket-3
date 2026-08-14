import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto('http://localhost:5199/?qa=1&sim=1&seed=42', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__kriket !== undefined, null, { timeout: 20000 });
const shots = [
  ['wd_preball', 0.15, [6, 2.5, 16, 0.4, 1.0, 9.0]],
  ['wd_delivery', 1.7, [8, 3, 2, 0, 1.0, 5.0]],
  ['wd_bowler_end', 1.7, [4, 2.2, -14, 0.4, 1.2, -9.5]],
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
  console.log('saved', name);
}
await browser.close();
