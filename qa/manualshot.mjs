import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
// 1. game title screen with the new MANUAL button
await page.goto('http://localhost:5199/', { waitUntil: 'networkidle' });
await page.waitForSelector('#kplay', { timeout: 20000 });
await page.screenshot({ path: 'qa/shots/manual_titlebtn.png' });
// 2. manual delivery lab mid-flight
await page.goto('http://localhost:5199/manual.html', { waitUntil: 'networkidle' });
await page.evaluate(() => document.querySelector('#deliveries').scrollIntoView({ block: 'start' }));
await page.waitForTimeout(1600); // let the ball be mid-flight
await page.screenshot({ path: 'qa/shots/manual_lab.png' });
// 3. leg-spin selected, caught right after the bounce
await page.evaluate(() => {
  const btns = document.querySelectorAll('#vizbtns button');
  btns[4].click();
});
await page.waitForTimeout(1500);
await page.screenshot({ path: 'qa/shots/manual_lab_legspin.png' });
console.log('pageerrors:', errs.length ? errs : 'none');
await browser.close();
