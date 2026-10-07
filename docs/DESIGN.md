# dsh-cloud-handoff 交接契约（DESIGN）

本地 DSH → 家里 PVE 云端 DSH 的**手动**任务迁移与结果回拉插件。本文档记录已实测验证的底层机制与两端的交接契约。

## 1. 目标与范围（2026-10-07 定稿）

- 用户在会话输入区点「转为云端运行」按钮 → 当前执行**暂停**在安全边界 → 全部打包 → 云端 DSH 接力继续执行 → 本地重开自动拉回结果。
- **只做手动迁移**。不做关盖/断电等突发事件的自动检测与触发（用户明确：突发事件来不及处理，先不做）。
- 云端执行端：家里 PVE 虚拟机（VMID 120 `dsh-cloud`，2C/4G/30G，磁盘在 Ceph RBD 冗余池），SSH 直连（内网），不暴露公网端口。

## 2. 架构

```
本地 DSH（dsh-cloud-handoff 插件）
  输入区按钮 [转为云端运行]
  ① 暂停：拦截新输入；等当前轮在工具边界停稳（默认 60s），超时 cancel() 强制结束本轮
  ② 打包：根会话日志(+子会话历史) + 工作区快照 + 记忆文件 + manifest → staging
  ③ 传输：rsync/scp over SSH → 云端 /srv/dsh-cloud/staging/incoming/<jobId>/
  ④ 触发：ssh exec curl 调云端插件 receive RPC（带一次性 job token）
  ⑤ 冻结：本地会话标记为只读（云端执行期间拦截本地写入）
云端 DSH（同一插件，headless systemd）
  ⑥ 导入：校验 sha → 工作区还原 /srv/dsh-cloud/workspaces/<jobId>/
          → 会话日志 cwd 重写 → 放入 $DSH_HOME/sessions/<projectKey>/<sessionId>/
  ⑦ 续跑：sessionController.resolveAgent(sessionId) → followup(续跑指令)
          续跑指令要求 agent 用 create_goal 建立目标（崩溃/重启后 goal 机制自动延续）
  ⑧ 执行中写心跳 jobs/<jobId>.json；完成时 agent 调 dsh_cloud_finish 工具
  ⑨ 产物：return bundle（git patch + 会话尾部增量 + receipt）→ staging/outgoing/
本地 DSH 启动钩子（60s 延迟）+ 运行中轮询
  ⑩ 云端 DONE → 拉回 → git apply（冲突双保留+补丁）→ 会话尾部追加回本地日志 → 解冻
```

## 3. 已实测验证的底层机制（2026-10-07 spike，全部通过）

### 3.1 会话日志格式（`sessions/<projectKey>/<sessionId>/session.v4.jsonl.zstd`）

- 文件 = 多个 zstd 帧拼接；每帧独立压缩且开校验和（`ZSTD_c_checksumFlag=1`）。
- **第 1 帧 = 恰好一行 session header**（`{"type":"session","version":4,"id","createdAt","cwd","agentPreset",...}` + "\n"）；读取端逐帧扫描校验，帧 1 必须是单行 header。
- 后续帧 = 事件批次（官方按 200ms 窗口自然分批；我们导入时每帧 ≤500 事件）。
- node:zlib 的 `zstdDecompress` 只解第一帧——必须移植官方 `scanZstdFrames` 逐帧解码。
- 实现：`lib/import.mjs`（`scanZstdFrames` / `decompressSessionLog` / `buildSessionLog` / `rewriteSessionCwd`），已有单测覆盖。

### 3.2 工作区目录名编码（projectKey）

与官方 `dsh-session-persistence-jsonl` 的 `projectKey()` 逐字节一致：
- 分隔符 `/ \ :` → `-`（连续合并为一个）；安全字符 `[A-Za-z0-9._-]`（不含 `~`）原样；其余按 **UTF-16 码元** → `~XXXX`（大写 4 位 hex，无闭合波浪号）；去掉开头 `-` 后包成 `--…--`，截断 251 字符，空则 `root`。
- 6 组真实目录名 + 中文用例均已断言一致。

### 3.3 续跑触发（spike 实测：独立 DSH 实例成功加载导入会话并执行）

```js
const resolved = await ctx.sessionController.resolveAgent(sessionId);
if ("error" in resolved) throw resolved.error;
const message = { id: "msg_" + randomUUID(), role: "user",
  content: [{ type: "text", text: 续跑指令 }],
  source: { kind: "user", rpcId: randomUUID() } };
resolved.agent.followup(message);
await ctx.sessions.flush(resolved.agent.session);
```

- 这是 DSH 自带 schedule（定时提醒）使用的同一路径；`ctx.inject(["sessionController","sessions"])` 即可拿到。
- 实测：导入会话在云端实例续跑，agent 正确报告新 cwd（`/tmp/spike-ws`）并在云端工作区执行 bash 工具，turn 正常完结。
- 备选：wire 级 `sessionController.prompt({requestId, sessionId, mode:"queue", content:[{type:"text",text}], clientTimeZone})`（`invocation: direct`，返回 `{accepted:true}`）。

### 3.4 约束（实测踩坑）

- **子会话不可直接续跑**：header 含 `parentSession` / `origin:"subagent"` 的会话被父会话路由持有（`session "…" is owned by subagent routing`）。→ 只迁移根会话并对其续跑；子会话仅作为历史导入（≤32 个后代、合计 ≤16MiB，对齐 Blaxel 边界）。
- `dsh web` 参数：`--profile web` 后**不要**再跟 `web` 位置参数；`--host/--port/--trusted-host/--no-open` 是 web app 的透传参数。

## 4. handoff bundle 格式

```
staging/incoming/<jobId>/
  manifest.json          # version/jobId/sessionId/标题/createdAt/本地cwd/agentPreset/
                         # 沙箱模式/模型/任务说明/技能清单/记忆文件列表/会话日志列表/附件清单/逐文件sha256
  files/session-<id>.v4.jsonl.zstd     # 根会话（已含全部历史，暂不重写 cwd，云端导入时重写）
  files/child-<id>.v4.jsonl.zstd       # 子会话历史（可选）
  files/attachments/…                  # 会话引用的图片等
  files/memory/…                       # MEMORY.md / USER.md 等项目记忆
  files/workspace.tar.zst              # 工作区快照
```

- 上限：512MiB 快照 / 100k 条目（对齐 Blaxel）；超限拒绝并提示。
- 工作区快照 = git 跟踪文件 + 未忽略的未跟踪文件；**排除**：`.git/`、凭据与私钥（复用 dsh-config-backup 的扫描清单：`.env`、`.npmrc`、`*.pem`、`*key*`、`gho_/ghp_/github_pat_/sk-`、`BEGIN …PRIVATE KEY` 等）。

## 5. 云端目录布局与状态机

```
/srv/dsh-cloud/{home, workspaces/<jobId>/, staging/incoming|outgoing/<jobId>/, jobs/<jobId>.json, logs/}
```

- 云端 job 状态：`PENDING → RUNNING → DONE | ABORTED | FAILED | CONFLICT`；本地：`LOCAL_ACTIVE → FROZEN → REMOTE_RUNNING → SYNCED | MERGE_NEEDED | ABORTED | FAILED`。
- **中止（ABORTED）**：云端中止时同样构建真实回传（工作区 diff + 会话尾部帧），状态置 ABORTED；本地中止后保留 active，界面提供「回收进度」手动拉回（ABORTED 不自动回收，避免把用户已否决的半成品静默合并）。
- **同会话二次迁移（SESSION_LIVE）**：同一会话 id 在云端仍有活体实例时，云端 receive 返回 SESSION_LIVE；本地自动重启云端服务（sudoers 授权 `systemctl restart dsh-cloud`）并重试同 jobId。重启会中断云端其他任务（v1 已知边界）。
- **取回三段式（v0.2）**：① `downloadResult` 只下载回传包（不落盘）→ 本地状态 RETURNED（待取回）；② 落盘二选一：**子智能体取回**（默认，向原会话注入取回指令，父 agent 派子智能体用 `dsh_cloud_apply_result` 消费回传包并合并落盘，先报清单再动手）或**机械应用**（逐文件三路判断兜底）；③ 落盘确认或丢弃后本地调云端 `/ack` 清全部云端副本。会话尾部**永不拼回当前会话**（seq 撞号风险），只供子智能体经 transcript 模式读取。
- **回传包 v2**：workspace-diff.tar.zst（云端最终内容）+ base.tar.zst（被改文件的迁移前基线，三路合并用）+ deleted.json + session-tail.v4.jsonl.zstd + receipt（含 summary/startedAt/finishedAt/finalState/tailEvents/listing）。
- **清理策略（用户明确要求）**：云端副本在本地 ack（确认完成/丢弃）后立即清除；未确认的终态任务按 `retentionDays`（默认 7 天）由云端定时清扫（启动 30s + 每 12h）。本地下载缓存与回传包在确认/丢弃后删除；本地 jobs.json 保留最近 20 条记录。云端产生的对话永不进入本地会话历史 → 上下文零污染。
- 全部状态落盘 + receipt 防重复导入；云端 systemd 崩溃重启后按 job 状态与 goal 恢复。

## 6. RPC 与工具

云端（仅 127.0.0.1，经 SSH 调用，校验 job token）：`/receive`（解包+导入+续跑）、`/status`、`/finish`（agent 完成时调用，产出 return bundle）、`/heartbeat`。
本地（浏览器同源，沿用 connection.requestRejection 鉴权）：`/state`、`/send`、`/pull`、`/abort`、`/test-connection`、`/config.set`。
模型工具：`dsh_cloud_status` / `dsh_cloud_send`（confirm="SEND"）/ `dsh_cloud_pull`（apply=true + confirm="PULL"）/ `dsh_cloud_abort`。

## 7. 安全

- 凭据/密钥永不进 bundle（写盘前扫描）；DeepSeek API Key 只写云端 DSH 凭据库，不回传浏览器。
- SSH 通道复用本机 `id_ed25519`；云端服务仅绑定 127.0.0.1。
- 云端执行期间本地会话冻结（只读）；回拉冲突双保留，不静默覆盖。

## 8. 版本与兼容

- 双方 DSH 钉 `0.2.0-rc.2`（本机桌面版版本）；插件每次发版记录验证过的 dsh 版本（学 weibaohui 惯例）。
- 依赖 Node ≥22.15（node:zlib 原生 zstd）。
