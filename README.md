# dsh-cloud-handoff · 云接力

把本地 DeepSeek Harness 会话**手动**一键迁到你自己的一台 Linux 服务器上继续跑：合盖、关机、断网都不中断；回到本地点一下，云端成果经**审阅**后由子智能体合并落盘。

> **不提供服务器**。你只需要一台自己的 Linux 机器（家里的 PVE 虚拟机、VPS、旧笔记本都行）和一条一键配置脚本。

```
本机 DSH ──打包会话+工作区+记忆──▶ SSH 直连你的服务器 ──▶ 云端 DSH 继续执行
   ▲                                                              │
   └──── 回传包（工作区 diff + 迁移前基线 + 云端会话尾部）◀────────┘
              │
              ▼  审阅卡 →「交给当前会话落盘」→ 子智能体消费回传包 → 写入本地工作区 → 确认清理
```

## 能做什么 / 不做什么

| ✅ 做 | ❌ 不做 |
|---|---|
| 手动点按钮迁移（当前轮停稳后打包） | 关盖/断电/崩溃等突发事件自动触发 |
| 会话历史 + 工作区 + 记忆文件一起带过去 | 往 GitHub 或任何远程仓库推送 |
| 云端完成后亮角标提示，**不自动写本地文件** | 未审阅就静默覆盖你的工作区 |
| 云端成果以 `.cloud-<jobId>` 副本保留冲突 | 把云端会话事件拼进你当前会话（避免 seq 撞号） |
| 确认/丢弃后自动清理云端副本 | 常驻你的公网端口（云端只绑 127.0.0.1） |

## 快速开始（4 步）

### 1. 在你的服务器上跑一键配置脚本

```bash
# 先下载审阅，再执行（推荐）
curl -fsSL https://raw.githubusercontent.com/engty/dsh-cloud-handoff/main/scripts/install-cloud.sh -o install-cloud.sh
sudo bash install-cloud.sh --ssh-pubkey ~/.ssh/id_ed25519.pub
```

脚本会（幂等，可重复执行）：等待 cloud-init 初始化完成（避免 apt 撞锁）→ 装 Node 22 + dsh → 建 `dshcloud` 用户与目录 → 生成**专属 Token 与随机端口** → 配 systemd 常驻 → 写 SSH 免密与重启授权 → 最后打印**对接码**。

> 脚本**不会**在你的服务器上安装任何代理/额外常驻软件；国内服务器加 `--mirror cn` 即可用国内源快速装依赖。

常用参数：

| 参数 | 说明 |
|---|---|
| `--ssh-pubkey <文件>` | 写入你的公钥，插件免密通道必需 |
| `--ssh-pubkey-url <URL>` | 从 URL 取公钥（如 `https://github.com/<user>.keys`） |
| `--key-file <文件>` | DeepSeek API Key（读取后删除该文件） |
| `--repo <git地址>` | 自动克隆插件 bundle 到服务器 |
| `--mirror cn` | 国内服务器推荐：apt 换清华 TUNA 源 + npm 换 npmmirror（装依赖快且稳） |
| `--port <n>` / `--dsh-version <v>` | 指定端口 / 锁定 dsh 版本 |

### 2. 复制脚本最后打印的「对接码」

```
DSHCP1:eyJob3N0IjoiMTkyLjE2OC4xLjQxIiwic3NoVXNlciI6...
```

### 3. 在本机 DSH 安装插件并粘贴对接码

```bash
# 二选一：命令行，或在 DSH 的插件管理界面安装/启用 dsh-cloud-handoff
dsh plugin --profile desktop add dsh-cloud-handoff
```

打开 **设置 → 云接力 → 云端接入** → 粘贴对接码 → 「解析并接入」→「测试连通」。看到绿色「已接入」即可。

### 4. 用起来

在会话输入区点云朵图标 → 填一句任务说明（可选）→「发送」→ 本地当前轮停稳打包，云端继续跑。你随时可以合盖走人。

回来时云朵亮绿点 = 云端有结果待取回 → 点开看**变更文件清单** → 「交给当前会话落盘」→ 子智能体读取回传包并把最终产物写进工作区（本地也改过的文件不覆盖，冲突另存 `.cloud-<jobId>`）→ 完成后点「确认完成·清理云端」。

## 清理策略

| 时机 | 清理内容 |
|---|---|
| 点「确认完成」/「丢弃」 | 云端立即删除：工作区副本、进出回传包、**云端会话副本**、任务记录；本地回传包与解包缓存同步删除 |
| 忘记确认 | 终态任务超 `retentionDays`（默认 7 天）由云端定时清扫（启动后 30 秒 + 每 12 小时） |
| 本地历史 | `jobs.json` 只保留最近 20 条任务记录 |
| 上下文 | 云端会话**永不**并入本地会话；子智能体只读有界摘要（单文件 ≤200KB、会话流默认 60 行），父会话只收最终汇报 |

## 安全与隐私

- 云端只监听 `127.0.0.1`，**不需要开放任何公网端口**；全部流量走你自己的 SSH 通道
- Token 仅存本地 `~/.dsh/dsh-cloud-handoff/config.json`（0600），不回显、不进日志、不上传
- **无遥测**、无第三方服务器；插件永不接触 GitHub 或任何远程仓库
- 打包自动排除凭据与缓存：`.env*`、`*.pem`、`*.key`、`id_rsa*`、`.credentials.yaml`、`node_modules`、`.git`、构建产物等
- 脚本可先下载审阅再执行；所有改动都在你的机器与服务器之间

## 兼容性

| 维度 | 支持范围 | 状态 |
|---|---|---|
| DSH | 双端同版本 `0.2.0-rc.2`（`engines.dsh` 声明） | 已验证 |
| Node | 本机 ≥22.15（依赖 `node:zlib` zstd）；服务器 22 LTS | 已验证 |
| 服务器 OS | **仅** Debian 12/13、Ubuntu 22.04/24.04；x86_64 / arm64（其它发行版不支持，脚本会直接提示退出） | Debian 12/13 + Ubuntu 24.04 实测 |
| 本机 OS | macOS / Linux；Windows（OpenSSH + tar） | macOS 已验证，Windows 实验性 |
| 本机依赖 | 只需系统自带 `ssh`、`tar`、`bash`（**不需要** rsync/zstd） | 已验证 |
| 工作区 | git 仓库或**任意目录**（自动遍历 + 排除表），无需 GitHub | 已验证 |
| 网络 | 无需公网端口，云端只绑 127.0.0.1；DeepSeek API 直连 | 已验证 |

## 常见问题

**Q：一定要有 GitHub 仓库吗？**
不需要。插件从不推送任何远程仓库；工作区甚至不必是 git 仓库（非 git 目录走遍历模式打包）。

**Q：云端会占多少空间？**
一次任务 ≈ 工作区快照 + 回传包（通常几十 MB）。确认或丢弃后立即释放；忘记确认有 7 天保留期兜底。

**Q：能同时跑多个云端任务吗？**
v1 单任务串行。同一会话二次迁移会自动重启云端服务（可能打断该服务器上其他云端任务，见 docs/DESIGN.md 边界说明）。

**Q：没有服务器怎么办？**
任意一台能装 Linux 的机器都行：家里 PVE/群晖虚拟机、VPS、甚至 WSL。2 核 4G 即可。

**Q：脚本会动我的系统吗？**
只做四件事：换源（可选，会备份原 `sources.list`）、装 Node+dsh、建 `dshcloud` 用户与 `/srv/dsh-cloud` 目录、注册一个 systemd 服务。不装代理，不改动其他服务，可重复执行。

## 文档

- [docs/DESIGN.md](docs/DESIGN.md) — 交接契约、状态机、已验证的底层机制
- [docs/cloud-host-setup.md](docs/cloud-host-setup.md) — 云端部署细节与常见坑
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — 日常运维、清理、故障处理
- [docs/TESTING.md](docs/TESTING.md) — 测试与验收清单
- [CHANGELOG.md](CHANGELOG.md) — 版本记录

## 开发

```bash
git clone https://github.com/engty/dsh-cloud-handoff
cd dsh-cloud-handoff
node --test test/                         # 单测：会话帧迁移、状态机、工作区扫描
dsh plugin --profile desktop install .    # 本地联调
```

## License

[MIT](LICENSE) © 2026 engty
