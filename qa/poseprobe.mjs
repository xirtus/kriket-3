import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.goto('http://localhost:5199/?qa=1&sim=1&seed=99&format=T20', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__kriket !== undefined, null, { timeout: 20000 });
const r = await page.evaluate(() => {
  const k = window.__kriket;
  k.fastForward(0.35);
  const c = k.getController();
  const st = c['strikerEnt'];
  const kp = c['keeper'].cricketer;
  const e = (b) => { const r = st.human.bone(b).rotation; return [r.x.toFixed(2), r.y.toFixed(2), r.z.toFixed(2)].join(','); };
  return {
    phase: c.phase,
    striker_ua_r: e('upperarm_r'),
    striker_ua_l: e('upperarm_l'),
    striker_hipsY: st.human.bone('hips').rotation.y.toFixed(2),
    keeper_thigh_l: (() => { const r = kp.human.bone('thigh_l').rotation; return r.x.toFixed(2); })(),
    batPos: (() => { const b = st['batObj']; if (!b) return 'none'; const THREE_V = st.root.position.constructor; const v = new THREE_V(); b.updateWorldMatrix(true, false); v.setFromMatrixPosition(b.matrixWorld); return [v.x.toFixed(2), v.y.toFixed(2), v.z.toFixed(2)].join(','); })(),
    handRPos: (() => { const THREE_V = st.root.position.constructor; const v = new THREE_V(); st.human.bone('hand_r').updateWorldMatrix(true, false); v.setFromMatrixPosition(st.human.bone('hand_r').matrixWorld); return [v.x.toFixed(2), v.y.toFixed(2), v.z.toFixed(2)].join(','); })(),
    handLPos: (() => { const THREE_V = st.root.position.constructor; const v = new THREE_V(); st.human.bone('hand_l').updateWorldMatrix(true, false); v.setFromMatrixPosition(st.human.bone('hand_l').matrixWorld); return [v.x.toFixed(2), v.y.toFixed(2), v.z.toFixed(2)].join(','); })(),
    rootY: st.root.position.y.toFixed(3),
    gripTarget: (() => { const b = st['batObj']; const THREE_V = st.root.position.constructor; const v = new THREE_V(0, 0.085, 0); b.updateWorldMatrix(true, false); v.applyMatrix4(b.matrixWorld); return [v.x.toFixed(2), v.y.toFixed(2), v.z.toFixed(2)].join(','); })(),
    shoulderL: (() => { const THREE_V = st.root.position.constructor; const v = new THREE_V(); st.human.bone('upperarm_l').updateWorldMatrix(true, false); v.setFromMatrixPosition(st.human.bone('upperarm_l').matrixWorld); return [v.x.toFixed(2), v.y.toFixed(2), v.z.toFixed(2)].join(','); })(),
    batAligned: st['batAligned'],
  };
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
