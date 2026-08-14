// HumanKit in-game visual QA
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5199/?qa=1&sim=1&seed=42', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__kriket !== undefined, null, { timeout: 20000 });
const shots = [
  ['hk_stance', 0.3, [2.6, 1.5, 12.6, 0.3, 1.1, 8.6]],
  ['hk_action', 1.75, [-2.2, 1.6, -12.5, 0.4, 1.3, -9.5]],
  ['hk_bowl_release', 1.95, [2.5, 1.8, -6.5, 0.4, 1.2, -9.8]],
  ['hk_keeper', 0.4, [2.2, 1.4, 14.6, 0.4, 0.9, 11.5]],
  ['hk_bat_face', 0.3, [1.2, 1.7, 10.6, 0.42, 1.5, 9.4]],
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
