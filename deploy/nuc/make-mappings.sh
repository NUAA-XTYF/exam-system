#!/usr/bin/env bash
# 按 devices.json + 用户表生成考场映射 JSON（可直接粘到监考页的导入框）
# 规则：设备 id 形如 ip-10-10-10-101，取最后一段作为座位号，
#       用户名 = <用户名前缀> + 座位号，例如 seat101
#
# 用法: make-mappings.sh <用户名前缀> [输出文件]
# 示例: make-mappings.sh seat /root/考场映射.json
set -euo pipefail

PREFIX=${1:-}
if [[ -z $PREFIX ]]; then
  echo "用法: $0 <用户名前缀> [输出文件]" >&2
  echo "示例: $0 seat /root/考场映射.json" >&2
  exit 2
fi
OUT=${2:-/root/考场映射.json}
BASE=${EXAM_MONITOR_CONF_DIR:-/etc/exam-monitor}

[[ -f $BASE/devices.json ]] || { echo "找不到 $BASE/devices.json" >&2; exit 1; }

node - "$BASE/devices.json" "$PREFIX" "$OUT" <<'JS'
const fs = require('fs');
const [devFile, prefix, out] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync('/root/.hydro/config.json', 'utf8'));
const { MongoClient } = require('/usr/local/share/.config/yarn/global/node_modules/mongodb');

(async () => {
  const devices = JSON.parse(fs.readFileSync(devFile, 'utf8'));
  const client = new MongoClient(cfg.uri);
  await client.connect();
  const users = await client.db().collection('user')
    .find({}).project({ _id: 1, uname: 1 }).toArray();
  const byName = new Map(users.map((u) => [u.uname, u._id]));

  const mappings = [];
  const missing = [];
  for (const d of devices) {
    const seat = String(d.id).split('-').pop();
    const uname = prefix + seat;
    const uid = byName.get(uname);
    if (uid === undefined) missing.push(uname);
    else mappings.push({ studentId: uid, deviceId: d.id });
  }

  fs.writeFileSync(out, JSON.stringify(mappings) + '\n');
  console.log(`已生成 ${out}，共 ${mappings.length} 条映射（设备 ${devices.length} 台）`);
  if (missing.length) {
    console.log(`缺少账号 ${missing.length} 个：${missing.slice(0, 15).join(' ')}${missing.length > 15 ? ' ...' : ''}`);
    console.log('请先在 HydroOJ 里创建这些账号，或换一个用户名前缀后重试。');
  }
  await client.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
JS
