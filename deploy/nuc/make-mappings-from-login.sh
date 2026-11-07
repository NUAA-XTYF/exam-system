#!/usr/bin/env bash
# 按"学生最近一次登录 OJ 的 IP"自动生成考场映射（适合学生自带笔记本，不用绑 MAC）
#
# 用法:
#   make-mappings-from-login.sh [输出文件] [--minutes N] [--prefix seat]
#   make-mappings-from-login.sh /root/考场映射.json --minutes 30
#
# 逻辑: 账号名以 prefix 开头（默认 seat）的用户，取其最近一次登录 IP；
#       该 IP 必须在 devices.json 里有对应设备，且登录时间在 N 分钟内（默认 120）。
#       同一 IP 被多个账号占用时保留最近登录的那个并告警。
set -euo pipefail

OUT=${1:-/root/考场映射.json}
shift || true
MINUTES=120
PREFIX=seat
while [[ $# -gt 0 ]]; do
  case "$1" in
    --minutes) MINUTES=${2:-120}; shift 2 ;;
    --prefix)  PREFIX=${2:-seat}; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
BASE=${EXAM_MONITOR_CONF_DIR:-/etc/exam-monitor}
[[ -f $BASE/devices.json ]] || { echo "找不到 $BASE/devices.json" >&2; exit 1; }

node - "$BASE/devices.json" "$OUT" "$MINUTES" "$PREFIX" <<'JS'
const fs = require('fs');
const [devFile, out, minutesArg, prefix] = process.argv.slice(2);
const minutes = Number(minutesArg) || 120;
const cfg = JSON.parse(fs.readFileSync('/root/.hydro/config.json', 'utf8'));
const { MongoClient } = require('/usr/local/share/.config/yarn/global/node_modules/mongodb');

(async () => {
  const devices = JSON.parse(fs.readFileSync(devFile, 'utf8'));
  const byId = new Map(devices.map((d) => [d.id, d]));
  const client = new MongoClient(cfg.uri);
  await client.connect();
  const users = await client.db().collection('user')
    .find({ uname: { $regex: '^' + prefix + '\\d+$' } })
    .project({ uname: 1, loginip: 1, loginat: 1 })
    .toArray();

  const os = require('os');
  const localIps = new Set(Object.values(os.networkInterfaces()).flat().filter(Boolean).map((i) => i.address));
  const now = Date.now();
  const rows = [];
  const skipped = [];
  for (const u of users) {
    const ip = u.loginip;
    if (!ip) { skipped.push([u.uname, '从未登录']); continue; }
    if (localIps.has(ip) || ip.endsWith('.1')) { skipped.push([u.uname, 'IP ' + ip + ' 是本机/网关闭']); continue; }
    const deviceId = 'ip-' + String(ip).replace(/\./g, '-');
    if (!byId.has(deviceId)) { skipped.push([u.uname, 'IP ' + ip + ' 不在设备清单']); continue; }
    const at = u.loginat ? new Date(u.loginat).getTime() : 0;
    if (now - at > minutes * 60000) { skipped.push([u.uname, '最后登录 ' + new Date(at).toLocaleString() + '（超过 ' + minutes + ' 分钟）']); continue; }
    rows.push({ uid: u._id, uname: u.uname, ip, deviceId, at });
  }

  // 同一台机器只能对应一个账号：保留最近登录的那条
  const byIp = new Map();
  for (const r of rows.sort((a, b) => b.at - a.at)) {
    if (byIp.has(r.ip)) {
      const prev = byIp.get(r.ip);
      console.error('  [!] 冲突: ' + r.ip + ' 同时被 ' + prev.uname + ' 和 ' + r.uname + ' 登录，保留 ' + prev.uname + '（最近登录）');
      continue;
    }
    byIp.set(r.ip, r);
  }
  const picked = [...byIp.values()].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));

  console.log('账号      IP               设备 ID                    最后登录');
  for (const r of picked) {
    const bad = r.uname.replace(prefix, '') !== r.ip.split('.').pop() ? '  ← 账号与 IP 末位不一致' : '';
    console.log(
      r.uname.padEnd(9), r.ip.padEnd(16), r.deviceId.padEnd(26),
      new Date(r.at).toLocaleTimeString(), bad,
    );
  }
  if (skipped.length) {
    console.log('\n未纳入 ' + skipped.length + ' 个账号：');
    for (const [n, why] of skipped.slice(0, 15)) console.log('  ' + n.padEnd(9), why);
    if (skipped.length > 15) console.log('  ... 其余 ' + (skipped.length - 15) + ' 个');
  }
  const mappings = picked.map((r) => ({ studentId: r.uid, deviceId: r.deviceId }));
  fs.writeFileSync(out, JSON.stringify(mappings) + '\n');
  console.log('\n已生成 ' + out + '，共 ' + mappings.length + ' 条映射。');
  if (!mappings.length) console.log('提示：先让学生用 seat 账号登录一次 OJ，再重跑本脚本。');
  await client.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
JS
