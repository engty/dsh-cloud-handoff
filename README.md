# dsh-cloud-handoff · 云接力

把本地 DSH 会话**手动**一键迁到云端 DSH（家里 PVE 虚拟机）继续执行：点「转为云端运行」→ 当前轮停稳 → 打包会话+工作区+记忆 → 传输 → 云端接力；回本地重开 DSH 自动同步云端结果。

- 不做关盖/断电等突发事件自动触发（按用户要求，只做手动迁移）。
- 云端执行端：家里 PVE VM `dsh-cloud`（192.168.1.40，2C/4G/30G，磁盘在 Ceph RBD 冗余池），SSH 直连，不暴露公网端口。
- 已验证：会话日志帧级迁移（cwd 重写）、`resolveAgent + followup` 续跑、云端完成回传（工作区 diff + 会话尾部）、启动钩子自动拉取。

## 使用

1. 在会话输入区点 **「☁ 转为云端运行」**（可选填一句话任务说明）→ 确认转云端。
2. 按钮变成「云端执行中」；笔记本可以合盖/关机。
3. 回到本地重开 DSH（60 秒内）自动拉取结果，或点「同步结果」手动拉取；有冲突的文件保留为 `*.cloud-<jobId>` 副本。
4. 「设置 → 云接力」页可测试连通、中止云端任务、查看详情（出错自动展开）。

## 安装

- 本机（desktop/web profile）与云端（cloud profile）安装**同一个 bundle**；
- 云端把插件配置 `role` 设为 `cloud`（见 docs/cloud-host-setup.md）；
- 本机 `role` 保持 `local`，高级设置里填云端 token（与云端 config.json 一致，云端自动生成，在 `/home/dshcloud/.dsh/dsh-cloud-handoff/config.json`）。

## 版本兼容

| 插件版本 | 适配 dsh 版本 | 备注 |
|---|---|---|
| 0.1.0 | 0.2.0-rc.2 | 2026-10-07 全链路验证（本机桌面版 + 云端无头 web） |

## 文档

- [docs/DESIGN.md](docs/DESIGN.md) — 交接契约与已验证的底层机制
- [docs/cloud-host-setup.md](docs/cloud-host-setup.md) — 云端 PVE VM + DSH 部署手册
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — 日常运维与排障
- [docs/TESTING.md](docs/TESTING.md) — 验收用例（G1–G4）
