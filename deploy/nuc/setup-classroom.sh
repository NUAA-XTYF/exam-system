#!/usr/bin/env bash
# 一键生成整个机房的 Veyon 凭据、devices.json 与分发目录
#   - 一张共享 TLS 证书，覆盖指定网段内的所有 IP（学生机共用）
#   - 每个 IP 一对独立的 AuthKeys 密钥（插件要求每台唯一）
#   - devices.json 按 IP 生成，不依赖机器名
#
# 用法: setup-classroom.sh <网段前缀> <起始末位> <结束末位> [端口]
# 示例: setup-classroom.sh 10.10.10 101 200 11080
set -euo pipefail

PREFIX=${1:-}
FROM=${2:-}
TO=${3:-}
PORT=${4:-11080}
# http 或 https；临时规避 Veyon 4.11.4 HTTPS WebAPI 握手失败时用 EXAM_MONITOR_SCHEME=http
SCHEME=${EXAM_MONITOR_SCHEME:-https}

if [[ -z $PREFIX || -z $FROM || -z $TO ]]; then
  cat >&2 <<'EOF'
用法: setup-classroom.sh <网段前缀> <起始末位> <结束末位> [端口]
示例: setup-classroom.sh 10.10.10 101 200 11080
      （生成 10.10.10.101 ~ 10.10.10.200 共 100 台的凭据）
EOF
  exit 2
fi
[[ $PREFIX =~ ^[0-9]{1,3}(\.[0-9]{1,3}){2}$ ]] || { echo "网段前缀格式错误，应为 a.b.c" >&2; exit 2; }
[[ $FROM =~ ^[0-9]+$ && $TO =~ ^[0-9]+$ ]] || { echo "起始/结束末位必须是数字" >&2; exit 2; }
(( FROM >= 1 && TO <= 254 && FROM <= TO )) || { echo "末位范围必须在 1..254 且起始 <= 结束" >&2; exit 2; }
[[ $PORT =~ ^[0-9]+$ ]] || { echo "端口必须是数字" >&2; exit 2; }

BASE=${EXAM_MONITOR_CONF_DIR:-/etc/exam-monitor}
OUT=${EXAM_DEPLOY_DIR:-/srv/exam-deploy}

mkdir -p "$BASE/keys" "$OUT/tls" "$OUT/by-ip"
chmod 750 "$BASE" "$BASE/keys" 2>/dev/null || true

# 清理不属于本次网段/范围的旧分发目录，避免学生机拉到过期公钥
PREFIX_RX=${PREFIX//./\\.}
for d in "$OUT"/by-ip/*/; do
  [[ -d $d ]] || continue
  ip=$(basename "$d")
  keep=0
  if [[ $ip =~ ^${PREFIX_RX}\.([0-9]+)$ ]]; then
    n=${BASH_REMATCH[1]}
    (( n >= FROM && n <= TO )) && keep=1
  fi
  if (( keep == 0 )); then
    rm -rf "$d"
    echo "清理过期分发目录: $ip"
  fi
done

STAMP=$(date +%Y%m%d-%H%M%S)
if [[ -s $BASE/devices.json ]]; then
  cp -a "$BASE/devices.json" "$BASE/devices.json.bak.$STAMP"
  echo "已备份旧清单: $BASE/devices.json.bak.$STAMP"
fi

# ---------- 1) 共享 TLS 证书：一张证书覆盖网段内全部 IP ----------
SANS=""
for i in $(seq "$FROM" "$TO"); do SANS+="IP:$PREFIX.$i,"; done
SANS=${SANS%,}
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 \
  -subj "/CN=exam-classroom" -addext "subjectAltName=$SANS" \
  -keyout "$OUT/tls/server.key" -out "$OUT/tls/server.crt" 2>/dev/null
chmod 600 "$OUT/tls/server.key"
chmod 644 "$OUT/tls/server.crt"

# ---------- 2) 每 IP 一对 AuthKeys 密钥 + 分发目录 ----------
ENTRIES=()
COUNT=0
for i in $(seq "$FROM" "$TO"); do
  IP="$PREFIX.$i"
  ID="ip-${IP//./-}"
  KEYNAME="exam-$ID"
  KEY="$BASE/keys/$ID-private.pem"
  PUB="$BASE/keys/$ID-public.pem"

  if [[ ! -s $KEY ]]; then
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$KEY" 2>/dev/null
    openssl pkey -in "$KEY" -pubout -out "$PUB" 2>/dev/null
    chmod 600 "$KEY"
    chmod 644 "$PUB"
  fi

  mkdir -p "$OUT/by-ip/$IP"
  # Veyon 要求公钥文件名为 key（<publicKeyBaseDir>/<keyName>/key）
  install -m 644 "$PUB" "$OUT/by-ip/$IP/key"

  ENTRIES+=("$(printf '  {"id":"%s","origin":"%s://%s:%s","caFile":"%s","keyFile":"%s","keyName":"%s"}' \
    "$ID" "$SCHEME" "$IP" "$PORT" "$OUT/tls/server.crt" "$KEY" "$KEYNAME")")
  COUNT=$((COUNT + 1))
done

{
  printf '[\n'
  first=1
  for e in "${ENTRIES[@]}"; do
    if (( first )); then first=0; else printf ',\n'; fi
    printf '%s' "$e"
  done
  printf '\n]\n'
} > "$BASE/devices.json"
chown root:root "$BASE/devices.json" 2>/dev/null || true
chmod 640 "$BASE/devices.json"

# 已生成凭据的 IP 清单，便于学生机侧排查 404
{
  for i in $(seq "$FROM" "$TO"); do echo "$PREFIX.$i"; done
} > "$OUT/ips.txt"
chmod 644 "$OUT/ips.txt"

# 学生机脚本据此决定用 https 还是 http（TLS 不可用时为 http）
printf '%s\n' "$SCHEME" > "$OUT/scheme.txt"
chmod 644 "$OUT/scheme.txt"

if [[ -f /opt/exam-system/tools/student-setup.ps1 ]]; then
  install -m 644 /opt/exam-system/tools/student-setup.ps1 "$OUT/student-setup.ps1"
fi
if [[ -f /opt/exam-system/tools/一键配置.cmd ]]; then
  install -m 644 /opt/exam-system/tools/一键配置.cmd "$OUT/一键配置.cmd"
  # ASCII 别名，方便用浏览器/URL 下载
  install -m 644 /opt/exam-system/tools/一键配置.cmd "$OUT/setup.cmd"
fi
if [[ -f /opt/exam-system/tools/probe-device.sh ]]; then
  install -m 755 /opt/exam-system/tools/probe-device.sh "$OUT/probe-device.sh"
fi

cat <<EOF

========== 生成完成 ==========
设备数量      : $COUNT 台（$PREFIX.$FROM ~ $PREFIX.$TO，端口 $PORT，协议 $SCHEME）
设备清单      : $BASE/devices.json
每台认证私钥  : $BASE/keys/ip-*-private.pem（仅本机保留）
共享 TLS 证书 : $OUT/tls/server.crt / server.key（所有学生机共用）
公钥分发目录  : $OUT/by-ip/<学生机IP>/key
学生机脚本    : $OUT/一键配置.cmd（拷到学生机双击运行）

接下来：
  1) 重启 HydroOJ 使新清单生效
       pm2 restart hydrooj            （以 root 执行）
  2) 在 ${OUT} 启动临时分发服务（学生机拉取用，考完可关）
       cd $OUT && python3 -m http.server 8080 --bind 0.0.0.0
  3) 学生机上双击 一键配置.cmd（默认连 http://192.168.3.2:8080，
     与 ${OUT} 所在机器 IP 不一致时，用记事本改 cmd 里 OJ_SERVER 那一行）
  4) 本机逐台自检
       /opt/exam-system/tools/probe-device.sh ip-$PREFIX-$FROM   （ID 把点换成横线）
================================
EOF
