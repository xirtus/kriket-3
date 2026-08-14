import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 700, height: 500 } });
await page.goto('http://localhost:5199/?qa=1&sim=1&seed=99&format=T20', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__kriket !== undefined, null, { timeout: 20000 });
const r = await page.evaluate(() => {
  const k = window.__kriket;
  const c = k.getController();
  k.fastForward(0.5);
  const st = c['strikerEnt'];
  const an = st.human.animator;
  const active = [];
  for (const [name, en] of an['active']) active.push(`${name}:t=${en.action.time.toFixed(2)}:w=${en.action.getEffectiveWeight().toFixed(2)}:paused=${en.action.paused}`);
  const scrub = an['scrubAction'];
  const e = (n) => { const r = st.human.bone(n).rotation; return [r.x.toFixed(2), r.y.toFixed(2), r.z.toFixed(2)].join(','); };
  const a = scrub;
  const pbInfo = [];
  if (a) {
    const bindings = a._propertyBindings ?? [];
    for (const pb of bindings) {
      const b = pb.binding;
      pbInfo.push(`${b.trackName ?? b.path}:node=${b.node ? b.node.name : 'NULL'}:${b.node ? b.node.type : ''}`);
    }
  }
  const headBinding = pbInfo.filter((x) => x.startsWith('head') || x.includes('neck'));
  const before = { head: e('head'), neck: e('neck_01'), weight: a?.getEffectiveWeight().toFixed(2), enabled: a?.enabled, running: a?.isRunning(), totalBindings: pbInfo.length };
  before.clipHeadQuat = (() => { const clip = an['clips'].get('cricket_stance'); const tr = clip.tracks.find((t) => t.name === 'head.quaternion'); if (!tr) return 'no track'; const i = Math.round(0.77 / clip.duration * (tr.times.length - 1)); return [...tr.values.slice(i * 4, i * 4 + 4)].map((v) => v.toFixed(2)).join(','); })();
  before.ballPos = (() => { const b = c.ballPosition(); return b ? [b.x.toFixed(1), b.y.toFixed(1), b.z.toFixed(1)] : null; })();
  before.headPos = (() => { const V = st.root.position.constructor; const v = new V(); st.human.bone('head').updateWorldMatrix(true, false); v.setFromMatrixPosition(st.human.bone('head').matrixWorld); return [v.x.toFixed(1), v.y.toFixed(1), v.z.toFixed(1)]; })();
  // isolate: mixer only, no lookAt (temporarily strip target)
  st.human.lookAt(null, 0);
  an.mixer.update(0);
  const mixerOnly = { head: e('head'), neck: e('neck_01') };
  st.human.update(0);
  const afterUpdate0 = { head: e('head'), neck: e('neck_01') };
  st.human.update(1 / 60);
  const afterDt = { head: e('head'), neck: e('neck_01') };
  return {
    active, scrub: scrub ? `${scrub.getClip().name}@${scrub.time.toFixed(2)}` : 'none',
    before, mixerOnly, afterUpdate0, afterDt,
  };
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
