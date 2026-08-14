import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.goto('http://localhost:5199/?qa=1&sim=1&seed=42&format=T20', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__kriket !== undefined, null, { timeout: 20000 });
const r = await page.evaluate(() => {
  const k = window.__kriket;
  const c = k.getController();
  const out = [];
  for (let step = 0; step < 8; step++) {
    k.fastForward(0.45);
    const V = c['strikerEnt'].root.position.constructor;
    for (const h of c['humanEnts']) {
      const v = new V();
      h.human.bone('foot_l').updateWorldMatrix(true, false);
      h.human.bone('foot_l').updateWorldMatrix(true, false);
      const fl = v.setFromMatrixPosition(h.human.bone('foot_l').matrixWorld).y;
      h.human.bone('foot_r').updateWorldMatrix(true, false);
      const fr = v.setFromMatrixPosition(h.human.bone('foot_r').matrixWorld).y;
      const min = Math.min(fl, fr);
      out.push(min);
    }
  }
  out.sort((a, b) => a - b);
  return { min: out[0].toFixed(3), p50: out[Math.floor(out.length / 2)].toFixed(3), max: out[out.length - 1].toFixed(3), n: out.length };
});
console.log('lowest-foot height (m, ground=0):', JSON.stringify(r));
await browser.close();
