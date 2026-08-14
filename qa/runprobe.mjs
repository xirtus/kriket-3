import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.goto('http://localhost:5199/?qa=1&sim=1&seed=7&format=T20', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__kriket !== undefined, null, { timeout: 20000 });
const r = await page.evaluate(() => {
  const k = window.__kriket;
  const c = k.getController();
  const e = k.engine;
  const phases = {};
  let runSeen = 0;
  for (let i = 0; i < 120 * 300; i++) {
    e.stepOnce(1 / 120);
    const d = c['delivery'];
    if (d) {
      phases[d.phase] = (phases[d.phase] || 0) + 1;
      if (d.running?.strikerRunning) runSeen++;
    }
  }
  return { phases, runSeen, score: (() => { const inn = c['match'].current(); return `${inn.runs}/${inn.wickets} ${inn.legalBalls}b`; })() };
});
console.log(JSON.stringify(r));
await browser.close();
