# 运维手册（OPERATIONS）

## 状态在哪里

| 内容 | 位置 |
|---|---|
| 本机任务状态 | `~/.dsh/dsh-cloud-handoff/jobs.json`（active=当前任务，jobs=历史） |
| 本机插件配置 | `~/.dsh/dsh-cloud-handoff/config.json`（0600；token 不回显） |
| 本机打包/回传暂存 | `~/.dsh/dsh-cloud-handoff/work/{staging,pulled,conflicts,pending-tails}/` |
| 云端任务状态 | `/srv/dsh-cloud/jobs/<jobId>.json`（baseline/状态/receipt） |
| 云端 bundle 进出 | `/srv/dsh-cloud/staging/{incoming,outgoing}/<jobId>/` |
| 云端会话/工作区 | `/srv/dsh-cloud/home/sessions/…`、`/srv/dsh-cloud/workspaces/<jobId>/` |

## 常用命令

```bash
# 云端
ssh dsh-cloud 'systemctl status dsh-cloud mihomo'
ssh dsh-cloud 'journalctl -u dsh-cloud -n 50 --no-pager'
ssh dsh-cloud 'curl -s -X POST http://127.0.0.1:39127/_dsh/dsh-cloud-handoff/ping'
ssh dsh-cloud 'cat /srv/dsh-cloud/jobs/<jobId>.json'

# 本机
cat ~/.dsh/dsh-cloud-handoff/jobs.json
```

## 清理

- **确认/丢弃即清**：本地点「确认完成」或「丢弃」→ 云端工作区、进出 bundle、会话副本、job 记录立即删除。
- **保留期兜底**：终态任务（DONE/ABORTED/FAILED）超 `retentionDays`（默认 7 天）由云端自动清扫（启动 30s 一次 + 每 12h 一次）；改 `/home/dshcloud/.dsh/dsh-cloud-handoff/config.json` 的 `retentionDays` 后重启云端服务生效。
- **本地缓存**：`~/.dsh/dsh-cloud-handoff/work/pulled/<jobId>`（下载的回传包）在确认/丢弃后删除；`jobs.json` 保留最近 20 条。
- **手动应急清理**（云端）：`ssh dsh-cloud 'rm -rf /srv/dsh-cloud/{jobs,staging/incoming,staging/outgoing,workspaces,home/sessions}/*'`。

## 故障处理

- **本机显示「云端执行中」但迟迟不完成**：查云端任务状态；若 agent 卡死 → 设置页「中止云端任务」（云端会话 cancel + 状态 FAILED，本机仍可拉取已产出部分）。
- **回拉后文件冲突**：冲突文件保留为 `*.cloud-<jobId前缀>`，人工合并后删除副本。
- **会话历史未合并（提示下次重启合并）**：尾部帧暂存在 `work/pending-tails/`，重启 DSH 后自动追加（启动钩子做）。
- **云端重启/断电**：systemd 拉起 dsh-cloud；任务靠 goal 机制跨轮续跑；job 状态落盘可恢复。
- **token 泄露/轮换**：改云端 `/home/dshcloud/.dsh/dsh-cloud-handoff/config.json` 的 token 并同步到本机高级设置，重启云端服务。

## 备份

- 云端数据在 Ceph RBD（3 副本）；会话日志另可通过任务回传自然落地本机。
- 如需全量备份云端：`tar czf - /srv/dsh-cloud`（不含 workspaces 的 .git 时体积小）。
