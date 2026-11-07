#!/usr/bin/env bash
# 把本目录的部署脚本安装到 NUC 的 tools 目录（默认 /opt/exam-system/tools）。
set -euo pipefail
SRC=$(cd "$(dirname "$0")" && pwd)
DST=${1:-/opt/exam-system/tools}
mkdir -p "$DST"
install -m 755 "$SRC"/setup-classroom.sh "$SRC"/probe-device.sh \
              "$SRC"/make-mappings.sh "$SRC"/make-device-creds.sh "$DST"/
install -m 644 "$SRC"/student-setup.ps1 "$SRC"/diag.ps1 "$DST"/
install -m 644 "$SRC"/diag.cmd "$SRC"/"一键配置.cmd" "$DST"/
echo "installed -> $DST"
ls -l "$DST"
