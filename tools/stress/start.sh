#!/usr/bin/env bash
# 重新开启 100 台 mock 压力测试（可重复执行，幂等）
#   sudo /opt/exam-system/tools/stress/start.sh
# 之后在监考页导入 /root/stress-map.json 并点「开始监考」（取消自动停止）。
set -euo pipefail
DEV=/etc/exam-monitor/devices.json

echo '[*] starting mock Veyon WebAPI on 127.0.0.1:19080'
sudo systemctl start veyon-mock

echo '[*] ensuring 100 mock devices in devices.json'
sudo python3 - "$DEV" <<'PY'
import json, os, secrets, sys, time
dev = sys.argv[1]
data = json.load(open(dev))
have = {d['id'] for d in data}
if 'stress-001' in have:
    print('   mock devices already present, skip')
else:
    bak = f'{dev}.bak.stress.{time.strftime("%Y%m%d-%H%M%S")}'
    with open(bak, 'w') as f: json.dump(data, f)
    keys = '/etc/exam-monitor/keys'
    for i in range(1, 101):
        kid = f'stress-{i:03d}'
        kp = f'{keys}/mock-{kid}.pem'
        if not os.path.exists(kp):
            open(kp, 'w').write('-----BEGIN PRIVATE KEY-----\n' + secrets.token_hex(48) + '\n-----END PRIVATE KEY-----\n')
            os.chmod(kp, 0o600)
        data.append({'id': kid, 'origin': 'http://127.0.0.1:19080', 'caFile': '/srv/exam-deploy/tls/server.crt', 'keyFile': kp, 'keyName': f'exam-{kid}'})
    with open(dev, 'w') as f:
        f.write('[\n' + ',\n'.join('  ' + json.dumps(d, separators=(',', ':')) for d in data) + '\n]\n')
    print(f'   appended 100 mock devices (backup {bak}), total {len(data)}')
PY

echo '[*] writing /root/stress-map.json'
sudo python3 -c "
import json
m=[{'studentId':1000+i,'deviceId':'stress-%03d'%i} for i in range(1,101)]
json.dump(m,open('/root/stress-map.json','w'))
print('   100 mappings ->', '/root/stress-map.json')"

echo '[*] restarting hydrooj with the stress device list'
sudo -u root -H bash -lc 'EXAM_MONITOR_DEVICES=/etc/exam-monitor/devices.json EXAM_MONITOR_DATA=/var/lib/exam-monitor EXAM_MONITOR_COLLECTOR=1 EXAM_MONITOR_ALLOW_HTTP=1 pm2 restart hydrooj --update-env' >/dev/null

cat <<'TXT'

下一步（在浏览器里）：
  1. 打开  http://192.168.3.2/d/system/exam-monitor/<比赛ID>
  2. 粘贴 /root/stress-map.json 的内容 -> 导入映射
  3. 取消勾选「到比赛结束时间自动停止」-> 开始监考

可选：开采样器记录每分钟指标
  sudo bash -c 'setsid nohup node /opt/exam-system/tools/stress/sampler.js >/var/log/exam-stress-sampler.log 2>&1 </dev/null &'

收尾：
  sudo /opt/exam-system/tools/stress/stop.sh
TXT
