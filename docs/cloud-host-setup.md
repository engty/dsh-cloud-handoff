# 云端执行端部署手册（cloud-host-setup）

面向"自己有一台 Linux 服务器"的用户。**推荐直接用一键脚本**（见 README 快速开始）；本文解释脚本做了什么、以及想让云端更贴合自己环境时怎么调。

## 1. 拓扑

```
你的服务器（Debian 12/13 或 Ubuntu 22.04/24.04，2C/4G 起）
  ├─ dsh-cloud.service：无头 dsh web @127.0.0.1:<随机端口>（用户 dshcloud，DSH_HOME=/srv/dsh-cloud/home）
  └─ 目录：/srv/dsh-cloud/{home,workspaces,staging/incoming,staging/outgoing,jobs,logs}

你的本机
  ~/.ssh/config（可选）: Host <你的别名> → <服务器IP>（dshcloud 免密通道）
  ~/.dsh/dsh-cloud-handoff/config.json（role=local, host, sshUser, remotePort, token）
```

要点：云端 DSH **只监听回环地址**，不开放任何公网端口；插件通过你自己的 SSH 通道调用它。

## 2. 一键部署

```bash
curl -fsSL https://raw.githubusercontent.com/engty/dsh-cloud-handoff/main/scripts/install-cloud.sh -o install-cloud.sh
sudo bash install-cloud.sh --ssh-pubkey ~/.ssh/id_ed25519.pub --key-file ~/deepseek-key.txt --mirror cn
```

脚本按顺序做 8 件事（幂等，可重复执行）：

| 阶段 | 内容 |
|---|---|
| 0 | 等 cloud-init/unattended-upgrades 结束（避免 apt 撞锁；配合 `DPkg::Lock::Timeout`） |
| 1 | 换软件源（`--mirror cn` 时用清华 TUNA，原 `sources.list` 备份为 `*.dsh-bak`）并装基础包 |
| 2 | 装 Node 22（nodesource；不通时回退官方二进制镜像） |
| 3 | 装 pnpm 与 `@deepseek-ai/dsh`（版本钉定，见下表） |
| 4 | 建 `dshcloud` 用户与 `/srv/dsh-cloud/*` 目录；**生成 token 与随机端口并持久化**；写入 SSH 公钥与 sudoers 重启授权 |
| 5 | 初始化 cloud profile（`dsh --from-default-profile web --profile cloud`）并装依赖 |
| 6 | 注册 `dsh-cloud.service`（systemd，仅回环绑定） |
| 7 | 注入 DeepSeek API Key 到云端凭据库（读入后删除 key 文件） |
| 8 | 链接插件、**注册 `dsh.profile.bundles`**、重启服务、**RPC 自检（90 秒轮询）**，最后打印对接码 `DSHCP1:…` |

> ⚠️ 脚本**不会**安装任何代理软件，也不会改动你的其他服务。

## 3. 服务器侧建议

- 2C/4G 起步；磁盘 20G 够用（一次任务 ≈ 工作区快照 + 回传包）
- 静态 IP 或固定 DHCP 绑定（本机 SSH 配置才不会漂移）
- `dshcloud` 是插件通道账号；你日常仍可用自己的管理账号登录
- 目录与属主：`/srv/dsh-cloud` 与 `~dshcloud` 归 `dshcloud`；脚本已纠正属主（root 误操作会导致 pnpm 无权写）

## 4. 部署后自检

```bash
systemctl is-active dsh-cloud                 # active
sudo -u dshcloud curl -s -X POST http://127.0.0.1:<端口>/_dsh/dsh-cloud-handoff/ping
# → {"ok":true,"role":"cloud","name":"dsh-cloud-handoff"}
```

把脚本输出的对接码粘贴到插件「设置 → 云接力 → 云端接入」→「解析并接入」→「测试连通」（应显示 SSH 免密 + 云端 RPC 在线）。

## 5. 关键参数

| 项 | 值 |
|---|---|
| DSH 版本（双端钉定） | 0.2.0-rc.2（见 package.json `engines.dsh`） |
| Node（服务器） | 22 LTS（nodesource 或官方二进制） |
| 端口 / 绑定 | 脚本随机生成并持久化在云端 `config.json`；仅 127.0.0.1 |
| DeepSeek Key | 云端凭据库 `/srv/dsh-cloud/home/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY` |
| 插件配置 | 云端 `/home/dshcloud/.dsh/dsh-cloud-handoff/config.json`（role=cloud, token, webPort, retentionDays） |

## 6. 可选：自备出站代理

云端默认直连 DeepSeek API。如果你要用需要出站代理的模型，且**自己**在服务器上装了代理（例如 mihomo/clash 内核），把 systemd 服务加上环境变量即可（脚本不会替你装）：

```ini
[Service]
Environment=http_proxy=http://127.0.0.1:7890
Environment=https_proxy=http://127.0.0.1:7890
Environment=no_proxy=localhost,127.0.0.1,::1
```

改完 `systemctl daemon-reload && systemctl restart dsh-cloud`。注意：虚拟机 CPU 若较老（无 AVX2），mihomo 需用 `compatible` 构建。

## 7. 踩坑记录（实机）

- `dsh --profile cloud web …` 报 `too many arguments: web`——`--profile` 后不要再跟位置参数 `web`
- profile 首次初始化：`dsh --from-default-profile web --profile cloud --help`（已存在时去掉 `--from-default-profile`）
- **`dsh plugin link/add` 只写 `dependencies`，不会写 `dsh.profile.bundles`**——插件装了也不会加载，必须显式注册（脚本已处理，手动操作时注意）
- 全新云镜像首次开机会跑 cloud-init 与 unattended-upgrades，apt 被锁数分钟——用 `DPkg::Lock::Timeout` 排队而不是重试
- npm 直连慢时给 root 与 `dshcloud` 都配镜像源（脚本 `--mirror cn` 已含）
- cephfs 不支持 content-type `images`（cloud-init 盘）→ cloud-init 盘放 `local`，数据盘可留在 RBD
- 会话 id 在云端 DSH_HOME 内全局唯一；重复导入前先移除旧目录（插件已内置处理）
