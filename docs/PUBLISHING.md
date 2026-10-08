# 发布清单（维护者用）

面向仓库维护者。用户侧安装说明见 [README](../README.md)。

## 0. 发布前检查

```bash
node --test test/                      # 单测（会话帧迁移 / 状态机 / 工作区扫描）
bash -n scripts/install-cloud.sh       # 一键脚本语法
node -e "import('./lib/index.js').then(()=>console.log('host ok'))"
node -e "import('./lib/client.js').then(()=>console.log('client ok'))"
npm pack --dry-run                     # 确认发布内容（lib/ scripts/ docs/ cordis.patch.yml README LICENSE CHANGELOG）
```

## 1. 首次建仓（一次性）

```bash
# 在 GitHub 上创建空仓库 engty/dsh-cloud-handoff（不要勾选 README/LICENSE，避免冲突）
git remote add origin git@github.com:engty/dsh-cloud-handoff.git
git branch -M main
git push -u origin main
```

## 2. 版本发布

```bash
# 1) 改版本号（package.json）并更新 CHANGELOG.md
# 2) 提交
git add -A && git commit -m "release: v0.2.4"
git tag -a v0.2.4 -m "v0.2.4"
git push origin main --tags

# 3) 发布到 npm（需要 npm 登录，包名 dsh-cloud-handoff）
npm login
npm publish --access public

# 4) GitHub 上基于 tag 创建 Release，正文复制 CHANGELOG 对应小节
```

## 3. 兼容性验证（每次 DSH 版本变化时）

DSH 升级后必须重跑，因为插件依赖宿主的 `sessionController` / `tools` / `webServer` 接口：

1. 本机装新 DSH，链接插件，冷启动后确认：
   - 工具列表出现 `dsh_cloud_status/send/pull/abort/apply_result`
   - 「设置 → 云接力」页可打开、云朵图标出现在输入区
2. 云端（任意 Debian/Ubuntu 机器）跑 `scripts/install-cloud.sh`，确认自检通过
3. 跑一次真实任务：发送 → 云端完成 → 角标 → 审阅 → 交给会话落盘 → 确认清理
4. 更新 `package.json` 的 `engines.dsh` 与 README 兼容性表

## 4. 脚本改动的回归验证

一键脚本必须在**全新机器**上验证（云镜像最佳，能覆盖 apt 锁与 cloud-init 时序），至少覆盖：

| 场景 | 期望 |
|---|---|
| 全新 Debian 12/13 | 8 阶段跑完、自检通过、打印对接码 |
| 全新 Ubuntu 22.04/24.04 | 同上（含 deb822 源切换、needrestart 非交互） |
| 重复执行脚本 | 幂等；**端口与 token 不变**（沿用云端 config） |
| 非支持发行版（如 CentOS） | 明确提示并退出，不做半途修改 |
| 缺少插件目录 | 明确报错退出，不产出"可用"假象 |

## 5. 安全检查

```bash
# 确认仓库内没有真实 IP / 主机名 / 密钥 / 个人路径
grep -rInE "192\.168\.|10\.[0-9]+\.|sk-[A-Za-z0-9]{20}|/Users/[a-z]+|BEGIN .*PRIVATE KEY" \
  --exclude-dir=.git --exclude-dir=node_modules .
```

发布物中**不得**包含：token、API Key、真实内网地址、个人目录路径、会话日志。
