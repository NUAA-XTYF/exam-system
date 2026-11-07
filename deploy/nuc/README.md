# NUC / 考场部署脚本

这些脚本是 **HydroOJ 主机（NUC）侧和 Windows 学生机侧的一次性部署工具**，不属于插件本体。
插件本身见 `addon/`；本目录只在考场部署、换网段、加机器时需要。

## 文件

| 文件 | 运行位置 | 作用 |
|---|---|---|
| `setup-classroom.sh` | NUC（root） | 按网段批量生成凭据、`devices.json`、分发目录、`ips.txt`、`scheme.txt`；支持 `EXAM_MONITOR_SCHEME=http` |
| `student-setup.ps1` | 学生机（管理员） | 自动识别本机 IP、拉取公钥、按 `scheme.txt` 配 HTTP/HTTPS、**写注册表开启 KeyFile 认证**、加防火墙、重启服务、WebAPI 自检 |
| `一键配置.cmd` | 学生机（双击） | 提权入口；每次从分发服务器重新下载 `student-setup.ps1` 再执行（所以服务器上换新版立刻生效） |
| `probe-device.sh` | NUC（root） | 对单台设备真实取一张图，输出 JSON（`bytes`/`path`/`error`），用于逐台自检 |
| `make-mappings.sh` | NUC（root） | 按 `devices.json` + HydroOJ 用户表生成监考映射 JSON |
| `make-device-creds.sh` | NUC（root） | 只给单台设备生成凭据（零散加机器用） |
| `diag.ps1` / `diag.cmd` | 学生机 | 诊断：版本、配置、监听端口、文件、ACL、本机自测、日志 |
| `watch.ps1` | 学生机 | 前台进程上报代理：1 Hz 采样有窗口的进程，30 s 报一次，进程启动/退出立即上报；上报走 `/exam-report`，按设备 token 鉴权 |
| `make-report-tokens.sh` | NUC（root） | 为每台设备生成上报 token，写到 `/srv/exam-deploy/by-ip/<IP>/token` |
| `make-mappings-from-login.sh` | NUC（root） | 按"学生最近一次登录 OJ 的 IP"生成映射（自带笔记本场景，不用绑 MAC） |

## 两份拷贝的关系

- `/opt/exam-system/tools/` 是**运行位置**（`setup-classroom.sh` 从这里取文件发布到 `/srv/exam-deploy/`）；
- `deploy/nuc/` 是**提交进 git 的快照**，内容必须和 `tools/` 一致。

现场直接改了 `tools/` 里的脚本时，提交前同步回来：



## 安装到 NUC

脚本的默认运行位置是 `/opt/exam-system/tools/`（`setup-classroom.sh` 会从那里把
`student-setup.ps1` 发布到 `/srv/exam-deploy/`）。把本目录同步过去：

```bash
sudo ./install.sh                 # 默认目标 /opt/exam-system/tools
sudo ./install.sh /other/path     # 或指定
```

## 典型流程

```bash
# 1. 生成整个网段的凭据与设备清单（http 模式）
sudo env EXAM_MONITOR_SCHEME=http deploy/nuc/setup-classroom.sh 192.168.3 101 200 11080

# 2. 起临时分发服务，让学生在浏览器打开 http://<NUC>:8080/setup.cmd 双击
cd /srv/exam-deploy && sudo python3 -m http.server 8080 --bind 0.0.0.0

# 3. 逐台自检（期望 bytes > 0 且有 path）
sudo deploy/nuc/probe-device.sh ip-192-168-3-101

# 4. 生成映射，粘到监考页
sudo deploy/nuc/make-mappings.sh seat /root/考场映射.json
```

## 约定（重要）

- **所有 `.ps1` / `.cmd` 必须是纯 ASCII**：Windows PowerShell 5.1 会按 GBK 解析无 BOM 文件，
  出现中文就会报“缺少右括号”。不要往这些脚本里加中文。
- `setup-classroom.sh` 每次运行都会**重签共享 TLS 证书**并覆盖 `/srv/exam-deploy/student-setup.ps1`，
  所以改动 `student-setup.ps1` 必须改这里（或改完立刻同步到 `tools/`），否则下次生成会被覆盖。
- 认证方式是枚举，**`veyon-cli config set Authentication/Method 1` 无效**（存成字符串读不回来），
  脚本直接写 `HKLM\SOFTWARE\Veyon Solutions\Veyon\Authentication` 的 `Method` = `DWORD 1`。

## 依赖

- NUC：`bash`、`node`（≥20）、`openssl`、`python3`（分发服务）
- 学生机：Veyon 4.11.x、Windows PowerShell 5.1、管理员权限
