#!/usr/bin/env bash
# 重启 HydroOJ，并带上监考插件需要的环境变量。
#
# 手敲 `pm2 restart hydrooj` 很容易漏变量，漏了的后果：
#   - 没有 EXAM_MONITOR_DEVICES  → 插件读不到设备清单，启动即 Addon load fail
#   - 没有 EXAM_MONITOR_COLLECTOR → 后端起得来但不采集，页面一直"等待首次检测"
#   - 没有 EXAM_MONITOR_ALLOW_HTTP → http:// 的设备被当成非法 origin 拒掉
#
# 用法: sudo /opt/exam-system/tools/restart.sh
set -euo pipefail

SCHEME=$(tr -d '[:space:]' < /srv/exam-deploy/scheme.txt 2>/dev/null || true)
[[ $SCHEME == http ]] || SCHEME=https

ENV=(EXAM_MONITOR_DEVICES=/etc/exam-monitor/devices.json
     EXAM_MONITOR_DATA=/var/lib/exam-monitor
     EXAM_MONITOR_COLLECTOR=1)
[[ $SCHEME == http ]] && ENV+=(EXAM_MONITOR_ALLOW_HTTP=1)

echo "[*] scheme=$SCHEME, ${#ENV[@]} 个环境变量"
sudo -u root -H env "${ENV[@]}" bash -lc 'pm2 restart hydrooj --update-env' >/dev/null

for _ in $(seq 1 20); do
  sleep 1
  if ss -ltn 2>/dev/null | grep -q '127.0.0.1:8888'; then break; fi
done

if sudo tail -n 300 /root/.pm2/logs/hydrooj-out.log | grep -q 'Addon load fail'; then
  echo "[x] 插件加载失败，看日志： sudo pm2 logs hydrooj --lines 80" >&2
  exit 1
fi

echo "[+] 已重启：$(sudo grep 'apply plugin .*exam-system' /root/.pm2/logs/hydrooj-out.log | tail -1 | sed 's/^[0-9: ]*//')"
