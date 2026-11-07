#!/usr/bin/env bash
# 为每台设备生成进程上报 token（不改证书、不动 devices.json）
# 产物: /etc/exam-monitor/tokens.json  { "<deviceId>": "<token>" }
#       /srv/exam-deploy/by-ip/<IP>/token  （学生机装机时下载）
set -euo pipefail
BASE=${EXAM_MONITOR_CONF_DIR:-/etc/exam-monitor}
OUT=${EXAM_MONITOR_DEPLOY:-/srv/exam-deploy}
[[ -f $BASE/devices.json ]] || { echo "缺少 $BASE/devices.json" >&2; exit 1; }

python3 - "$BASE/devices.json" "$BASE/tokens.json" "$OUT" <<'PY'
import json, secrets, sys, os
dev_file, tok_file, out_dir = sys.argv[1:4]
devices = json.load(open(dev_file))
old = {}
if os.path.exists(tok_file):
    old = json.load(open(tok_file))
tokens = {}
for d in devices:
    did = d['id']
    tokens[did] = old.get(did) or secrets.token_hex(16)
json.dump(tokens, open(tok_file, 'w'), indent=1)
os.chmod(tok_file, 0o600)
n = 0
for d in devices:
    ip = d['id'].replace('ip-', '').replace('-', '.')
    p = os.path.join(out_dir, 'by-ip', ip, 'token')
    with open(p, 'w') as f:
        f.write(tokens[d['id']] + '\n')
    os.chmod(p, 0o644)
    n += 1
print(f'{n} tokens written to {tok_file} and {out_dir}/by-ip/*/token')
PY
