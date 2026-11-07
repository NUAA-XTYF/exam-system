# 100 台容量压测（不接真机）

用来在没有 100 台真机的情况下验证调度器、带宽预算和页面表现。

| 文件 | 作用 |
|---|---|
| `mock-server.js` | 假的 Veyon WebAPI：任何认证都放行，按固定 72 KB 返回 JPEG，暴露 `/_stats` 统计。**只能在实验网段跑，绝不能在真实考场网启动**（它不校验任何密钥） |
| `sampler.js` | 每分钟把压测指标追加到 `/var/log/exam-stress.log`：取图速率、错误分布、hydrooj 内存、截图目录占用 |
| `stop.sh` | 停压测：把该场考试置为停止、恢复真实的 `devices.json`、重启 HydroOJ、停掉 mock 和采样器 |

## 用法

```bash
# 1. 起 mock（19080）
node tools/stress/mock-server.js

# 2. 造一份指向 mock 的 devices.json（100 台，origin=http://127.0.0.1:19080），
#    备份真实清单后替换，并用 tools/restart.sh 重启

# 3. 在监考页导入 100 条映射、开始监考

# 4. 采样
nohup node tools/stress/sampler.js >/dev/null 2>&1 &

# 5. 收尾
sudo tools/stress/stop.sh
```

`sampler.js` / `stop.sh` 里的 `EXAM` 常量写死为某一场测试比赛，换比赛要改这一行。
Mongo 连接串从 `/root/.hydro/config.json` 读取，不落盘明文密码。
