// Generates browser-like load on the OJ while the capture pipeline runs.
// usage: node web-load.js <seconds> <concurrency>
const http = require('node:http');
const SECONDS = Number(process.argv[2] || 180);
const CONC = Number(process.argv[3] || 20);
const TID = '6aef75791f63314b1cbf8b43';
const URLS = ['/', '/contest/' + TID, '/contest', '/'];
const agent = new http.Agent({ keepAlive: true, maxSockets: CONC });
const lat = []; const codes = {};
let done = 0;
const start = Date.now();
function one(i) {
  return new Promise((resolve) => {
    const path = URLS[i % URLS.length];
    const t0 = performance.now();
    const req = http.get({ host: '127.0.0.1', port: 80, path, agent, headers: { 'User-Agent': 'stress-web-load' } }, (res) => {
      res.resume();
      res.on('end', () => { lat.push(performance.now() - t0); codes[res.statusCode] = (codes[res.statusCode] || 0) + 1; done++; resolve(); });
    });
    req.on('error', () => { codes.err = (codes.err || 0) + 1; resolve(); });
    req.setTimeout(10000, () => { req.destroy(); codes.timeout = (codes.timeout || 0) + 1; resolve(); });
  });
}
(async () => {
  const workers = Array.from({ length: CONC }, async (_, w) => {
    let i = w;
    while (Date.now() - start < SECONDS * 1000) { await one(i); i += CONC; }
  });
  const timer = setInterval(() => {
    const s = [...lat].sort((a, b) => a - b);
    console.log(JSON.stringify({ t: Math.round((Date.now() - start) / 1000), done, rps: +(done / ((Date.now() - start) / 1000)).toFixed(1), p50: Math.round(s[Math.floor(s.length * .5)] || 0), p95: Math.round(s[Math.floor(s.length * .95)] || 0), codes }));
  }, 20000);
  await Promise.all(workers);
  clearInterval(timer);
  const s = [...lat].sort((a, b) => a - b);
  console.log(JSON.stringify({ final: true, seconds: SECONDS, concurrency: CONC, requests: done, rps: +(done / SECONDS).toFixed(1), p50: Math.round(s[Math.floor(s.length * .5)]), p95: Math.round(s[Math.floor(s.length * .95)]), p99: Math.round(s[Math.floor(s.length * .99)]), max: Math.round(s[s.length - 1]), codes }));
})();
