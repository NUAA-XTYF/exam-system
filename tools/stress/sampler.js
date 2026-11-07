// Long-run sampler for the 100-device stress test. Appends one JSON line per minute
// to /var/log/exam-stress.log and prints the same line to stdout.
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const { MongoClient } = require('/usr/local/share/.config/yarn/global/node_modules/mongodb');
const LOG = '/var/log/exam-stress.log';
const EXAM = 'system/6aef911678e8ecc7fca9fb2c';
const URI = JSON.parse(fs.readFileSync('/root/.hydro/config.json', 'utf8')).uri;

async function mockStats() {
  try {
    const r = await fetch('http://127.0.0.1:19080/_stats');
    return await r.json();
  } catch { return null; }
}

function hydroRss() {
  try {
    const list = JSON.parse(execSync('/root/.nix-profile/bin/pm2 jlist', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    const p = list.find((x) => x.name === 'hydrooj');
    return p ? { rssMB: Math.round(p.monit.memory / 1048576), cpu: p.monit.cpu } : null;
  } catch { return null; }
}

function dirBytes(p) {
  try { return Number(execSync(`du -sb ${p} | cut -f1`, { encoding: 'utf8' }).trim()); } catch { return null; }
}

(async () => {
  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db('hydro');
  const sample = async () => {
    const now = new Date();
    const rows = db.collection('exam.monitor.results');
    const total = await rows.countDocuments({ examId: EXAM });
    const lastMin = await rows.countDocuments({ examId: EXAM, completedAt: { $gte: now.getTime() - 60000 } });
    const errs = await rows.aggregate([
      { $match: { examId: EXAM, completedAt: { $gte: now.getTime() - 60000 } } },
      { $group: { _id: '$error', n: { $sum: 1 } } },
    ]).toArray();
    const agg = await rows.aggregate([
      { $match: { examId: EXAM, path: { $exists: true } } },
      { $group: { _id: null, n: { $sum: 1 }, bytes: { $sum: '$bytes' }, max: { $max: '$completedAt' } } },
    ]).toArray();
    const delays = await rows.find({ examId: EXAM, completedAt: { $gte: now.getTime() - 300000 } })
      .project({ queueDelayMs: 1 }).limit(500).toArray();
    delays.sort((a, b) => a.queueDelayMs - b.queueDelayMs);
    const m = await mockStats();
    const line = {
      at: now.toISOString(),
      lastMinImages: lastMin,
      totalImages: total,
      okImages: agg[0]?.n ?? 0,
      okMB: Math.round((agg[0]?.bytes ?? 0) / 1048576 * 10) / 10,
      lastImageAt: agg[0]?.max ? new Date(agg[0].max).toISOString() : null,
      errorsLastMin: Object.fromEntries(errs.filter((e) => e._id).map((e) => [e._id, e.n])),
      queueP95ms: delays.length ? Math.round(delays[Math.floor(delays.length * 0.95)].queueDelayMs) : null,
      hydro: hydroRss(),
      dataDirMB: Math.round((dirBytes('/var/lib/exam-monitor') ?? 0) / 1048576),
      mock: m ? { frames: m.frames, peakConcurrent: m.peak, active: m.active } : null,
    };
    const text = JSON.stringify(line);
    fs.appendFileSync(LOG, text + '\n');
    console.log(text);
  };
  for (;;) { try { await sample(); } catch (e) { console.error('sample error', e.message); } await new Promise((r) => setTimeout(r, 60000)); }
})();
