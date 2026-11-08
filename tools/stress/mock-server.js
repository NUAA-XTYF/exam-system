// Mock Veyon WebAPI used only for load tests. No auth verification: it accepts
// any POST and returns a fixed-size JPEG. Never start this on a real exam LAN.
const http = require('node:http');
const PORT = Number(process.env.MOCK_PORT || 19080);
const FRAME = (() => {
  const head = Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex');
  const body = Buffer.alloc(72 * 1024 - head.length - 2, 0x41);
  return Buffer.concat([head, body, Buffer.from('ffd9', 'hex')]);
})();
const stats = { auth: 0, frames: 0, deletes: 0, bytes: 0, active: 0, peak: 0, startedAt: Date.now() };
const server = http.createServer((req, res) => {
  req.resume();
  if (req.url === '/_stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
    return;
  }
  stats.active++; stats.peak = Math.max(stats.peak, stats.active);
  const done = () => { stats.active--; };
  if (req.method === 'POST') {
    stats.auth++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 'connection-uid': 'mock-connection' }), done);
    return;
  }
  if (req.method === 'DELETE') { stats.deletes++; res.writeHead(200); res.end('{}', done); return; }
  if (req.headers['connection-uid'] !== 'mock-connection') { res.writeHead(401); res.end('{}', done); return; }
  const mode = process.env.MOCK_MODE || 'plain';
  if (mode === 'adversarial') {
    const r = Math.random();
    if (r < 0.03) { res.writeHead(503); res.end('{}', done); return; }               // frame unavailable
    if (r < 0.04) { setTimeout(() => { res.writeHead(503); res.end('{}', done); }, 12000); return; } // > 10 s timeout
    if (r < 0.045) { req.socket.destroy(); done(); return; }                          // connection reset
    const size = 30 * 1024 + Math.floor(Math.random() * 270 * 1024);                  // 30-300 KB
    const body = size === FRAME.length ? FRAME : Buffer.concat([Buffer.from('ffd8ff', 'hex'), Buffer.alloc(size - 5, 0x41), Buffer.from('ffd9', 'hex')]);
    const delay = 600 + Math.floor(Math.random() * 1900);                             // 0.6-2.5 s
    setTimeout(() => {
      stats.frames++; stats.bytes += body.length;
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(body.length) });
      res.end(body, done);
    }, delay);
    return;
  }
  setTimeout(() => {
    stats.frames++; stats.bytes += FRAME.length;
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(FRAME.length) });
    res.end(FRAME, done);
  }, Number(process.env.MOCK_DELAY_MS || 1200));
});
server.listen(PORT, '127.0.0.1', () => console.log('mock veyon webapi on 127.0.0.1:' + PORT));
