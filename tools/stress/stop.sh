#!/usr/bin/env bash
# 停止 100 台模拟压力测试并恢复真实设备清单
set -euo pipefail
EXAM='system/6aef911678e8ecc7fca9fb2c'
echo '[*] stopping monitoring'
sudo node -e '
const {MongoClient}=require("/usr/local/share/.config/yarn/global/node_modules/mongodb");
(async()=>{const fs=require("node:fs");const URI=JSON.parse(fs.readFileSync("/root/.hydro/config.json","utf8")).uri;const c=new MongoClient(URI);await c.connect();
await c.db("hydro").collection("exam.monitor.sessions").updateOne({_id:process.argv[1]},{$set:{active:false}});
console.log("   session set to active=false");await c.close();})()' "$EXAM"

echo '[*] restoring devices.json'
BAK=$(ls -t /etc/exam-monitor/devices.json.bak.stress.* | head -1)
sudo cp -a "$BAK" /etc/exam-monitor/devices.json
echo "   restored from $BAK ($(sudo python3 -c 'import json;print(len(json.load(open("/etc/exam-monitor/devices.json"))))') devices)"

echo '[*] restarting hydrooj with real devices'
sudo /opt/exam-system/tools/restart.sh >/dev/null

echo '[*] stopping mock server and sampler'
sudo systemctl stop veyon-mock || true
sudo pkill -f "tools/stress/sampler[.]js" || true

echo '[*] done. summary:'
tail -3 /var/log/exam-stress.log || true
