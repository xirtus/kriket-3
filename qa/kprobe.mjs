import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.goto('http://localhost:5199/?qa=1&sim=1&seed=42', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__kriket !== undefined, null, { timeout: 20000 });
const r = await page.evaluate(() => {
  const k = window.__kriket;
  k.fastForward(0.4);
  const c = k.getController();
  const keeper = c['keeper'].cricketer;
  const batter = c['strikerEnt'];
  return {
    keeperRotY: keeper.root.rotation.y.toFixed(2),
    keeperPos: [keeper.root.position.x.toFixed(1), keeper.root.position.z.toFixed(1)],
    batterRotY: batter.root.rotation.y.toFixed(2),
    batterPos: [batter.root.position.x.toFixed(1), batter.root.position.z.toFixed(1)],
  };
});
console.log(JSON.stringify(r));
await browser.close();
