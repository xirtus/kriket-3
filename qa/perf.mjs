import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto('http://localhost:5199/?qa=1&sim=1&seed=42', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__kriket !== undefined, null, { timeout: 20000 });
const r = await page.evaluate(() => {
  const k = window.__kriket;
  const e = k.engine;
  // measure full render+sim frame cost over 240 frames of live play
  k.fastForward(2.0);
  const t0 = performance.now();
  for (let i = 0; i < 240; i++) e.stepOnce(1 / 120);
  const simMs = (performance.now() - t0) / 240;
  const t1 = performance.now();
  for (let i = 0; i < 120; i++) e.renderFrame();
  const renderMs = (performance.now() - t1) / 120;
  const info = e.renderer.info;
  return { simMs: simMs.toFixed(2), renderMs: renderMs.toFixed(2), calls: info.render.calls, tris: info.render.triangles };
});
console.log(JSON.stringify(r));
await browser.close();
