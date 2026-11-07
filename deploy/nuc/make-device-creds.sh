#!/usr/bin/env bash
# 为单台学生机生成 Veyon AuthKeys 密钥对 + WebAPI TLS 自签证书
# 用法: make-device-creds.sh <设备ID> <主机名或IP> [端口] [--append]
#   --append  同时把该设备追加到 devices.json（重复 ID 会拒绝）
set -euo pipefail

ID=${1:-}
HOST=${2:-}
PORT=${3:-11080}
APPEND=${4:-}

if [[ -z $ID || -z $HOST ]]; then
  echo "用法: $0 <设备ID> <主机名或IP> [端口] [--append]" >&2
  exit 2
fi
[[ $ID =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "设备ID 只能包含字母、数字、下划线、横线" >&2; exit 2; }
[[ $PORT =~ ^[0-9]+$ ]] || { echo "端口必须是数字" >&2; exit 2; }

BASE=${EXAM_MONITOR_CONF_DIR:-/etc/exam-monitor}
KEYDIR=$BASE/keys
CERTDIR=$BASE/certs
mkdir -p "$KEYDIR" "$CERTDIR"
chmod 750 "$BASE" "$KEYDIR" 2>/dev/null || true

PRIV=$KEYDIR/$ID-private.pem
PUB=$KEYDIR/$ID-public.pem
CERTKEY=$CERTDIR/$ID-tls.key
CERT=$CERTDIR/$ID-tls.crt
KEYNAME=exam-$ID

for f in "$PRIV" "$PUB" "$CERTKEY" "$CERT"; do
  if [[ -e $f ]]; then echo "已存在，拒绝覆盖: $f" >&2; exit 1; fi
done

# 1) 认证密钥对（Veyon AuthKeys 用，RSA 2048 PEM）
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$PRIV" 2>/dev/null
openssl pkey -in "$PRIV" -pubout -out "$PUB" 2>/dev/null

# 2) TLS 证书（SAN 必须与 devices.json 里 origin 的主机一致）
if [[ $HOST =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  SAN="IP:$HOST"
else
  SAN="DNS:$HOST"
fi
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 \
  -subj "/CN=$HOST" -addext "subjectAltName=$SAN" \
  -keyout "$CERTKEY" -out "$CERT" 2>/dev/null

chmod 600 "$PRIV" "$CERTKEY"
chmod 644 "$PUB" "$CERT"

ORIGIN="https://$HOST:$PORT"

cat <<EOF

已生成（设备 $ID）：
  认证私钥（只留在本机 NUC） : $PRIV
  认证公钥（拷到学生机）     : $PUB
  TLS 私钥（配到学生机 WebAPI）: $CERTKEY
  TLS 证书（配到学生机 WebAPI）: $CERT

学生机 Veyon 配置（Veyon Configurator -> 高级视图）：
  1. 服务 -> WebAPI：启用 WebAPI，端口 $PORT，勾选 HTTPS(TLS 1.3)，
     TLS 证书文件 = $CERT，TLS 私钥文件 = $CERTKEY
  2. 认证密钥：导入上述公钥，密钥名称填 $KEYNAME
  3. 访问控制：选择「授予所有已认证用户访问权限」
  4. 防火墙仅放行 NUC -> 学生机 $PORT/tcp

devices.json 条目：
EOF
printf '  {"id":"%s","origin":"%s","caFile":"%s","keyFile":"%s","keyName":"%s"}\n' \
  "$ID" "$ORIGIN" "$CERT" "$PRIV" "$KEYNAME"

if [[ $APPEND == "--append" ]]; then
  node -e '
const fs = require("fs");
const [file, id, origin, ca, key, keyname] = process.argv.slice(1);
const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8") || "[]") : [];
if (list.some((d) => d.id === id)) { console.error("devices.json 中已存在设备 " + id); process.exit(1); }
list.push({ id, origin, caFile: ca, keyFile: key, keyName: keyname });
fs.writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
console.log("已追加到 " + file);
' "$BASE/devices.json" "$ID" "$ORIGIN" "$CERT" "$PRIV" "$KEYNAME"
  chown root:root "$BASE/devices.json"
  chmod 640 "$BASE/devices.json"
  echo "记得重启: pm2 restart hydrooj"
fi
