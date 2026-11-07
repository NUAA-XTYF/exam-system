#!/usr/bin/env bash
# 单机联调：对 devices.json 中的某台设备做一次真实取图
# 用法: probe-device.sh <设备ID> [输出目录]
set -euo pipefail

ID=${1:-}
if [[ -z $ID ]]; then echo "用法: $0 <设备ID> [输出目录]" >&2; exit 2; fi

BASE=${EXAM_MONITOR_CONF_DIR:-/etc/exam-monitor}
OUT=${2:-/var/lib/exam-monitor/probe}
TMP=$(mktemp /tmp/exam-device-XXXXXX.json)
trap 'rm -f "$TMP"' EXIT

node -e '
const fs = require("fs");
const [file, id, out] = process.argv.slice(1);
const list = JSON.parse(fs.readFileSync(file, "utf8") || "[]");
const dev = list.find((d) => d.id === id);
if (!dev) { console.error("devices.json 中找不到设备 " + id); process.exit(2); }
fs.writeFileSync(out, JSON.stringify(dev));
' "$BASE/devices.json" "$ID" "$TMP"

mkdir -p "$OUT"
cd /opt/exam-system
if [[ -f /srv/exam-deploy/scheme.txt ]] && [[ $(cat /srv/exam-deploy/scheme.txt) == http ]]; then
  export EXAM_MONITOR_ALLOW_HTTP=1
fi
NODE_PATH=/usr/local/share/.config/yarn/global/node_modules \
  node -r @hydrooj/register tools/probe.ts "$TMP" "$OUT"
