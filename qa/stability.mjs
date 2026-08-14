import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:5199/?qa=1&sim=1&seed=42&format=T20', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__kriket !== undefined, null, { timeout: 20000 });
const r = await page.evaluate(() => {
  const k = window.__kriket;
  const c = k.getController();
  const e = k.engine;
  for (let i = 0; i < 120 * 60 * 12; i++) e.stepOnce(1 / 120); // 12 sim-minutes
  const inn = c['match'].current();
  return { runs: inn.runs, wickets: inn.wickets, balls: inn.legalBalls, phase: c.phase };
});
console.log('after 12 sim-min:', JSON.stringify(r), 'pageerrors:', errs.length ? errs : 'none');
await page.screenshot({ path: 'qa/shots/stability_end.png' });
await browser.close();
