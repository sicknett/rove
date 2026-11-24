// Scroll benchmark inside the real app (WebView2). Connects to ROVE's debugging port, scrolls the
// active screen smoothly for a few seconds, and reports frames per second and slow frames.
// Usage: node tools/scroll-bench.mjs [port] [seconds]

const port = Number(process.argv[2] ?? 9333);
const seconds = Number(process.argv[3] ?? 6);

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('rove.localhost'));
if (!page) throw new Error('ROVE page not found on the debugging port');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) pending.get(m.id)(m), pending.delete(m.id);
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;

const script = `(async () => {
  const el = document.querySelector('.screen.is-active');
  if (!el) return { error: 'no active screen' };
  el.scrollTop = 0;
  await new Promise((r) => setTimeout(r, 800));
  const max = el.scrollHeight - el.clientHeight;
  const frames = [];
  let last = performance.now();
  const start = last;
  const duration = ${seconds} * 1000;
  await new Promise((resolve) => {
    const step = (t) => {
      frames.push(t - last);
      last = t;
      const p = (t - start) / duration;
      // Down and back up, like someone browsing with the wheel.
      el.scrollTop = (p < 0.5 ? p * 2 : (1 - p) * 2) * Math.min(max, 6000);
      if (t - start < duration) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  frames.shift();
  const total = frames.reduce((a, b) => a + b, 0);
  const sorted = [...frames].sort((a, b) => a - b);
  return {
    screen: el.dataset.route,
    scrollable: max,
    rows: document.querySelectorAll('.screen.is-active .row').length,
    fps: Math.round((frames.length / total) * 1000 * 10) / 10,
    p50ms: Math.round(sorted[Math.floor(sorted.length * 0.5)] * 10) / 10,
    p95ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10,
    worstMs: Math.round(sorted[sorted.length - 1]),
    slowFrames: frames.filter((f) => f > 25).length,
    frames: frames.length,
    refreshHz: Math.round(1000 / sorted[Math.floor(sorted.length * 0.1)]),
  };
})()`;
console.log(JSON.stringify(await evaluate(script), null, 1));
ws.close();
