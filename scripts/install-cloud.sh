#!/usr/bin/env bash
# dsh-cloud-handoff — 云端 DSH 执行端一键部署（幂等；Debian 12/13、Ubuntu 22.04/24.04，x86_64/arm64）
#
# 用法:
#   curl -fsSL <本仓库>/scripts/install-cloud.sh | sudo bash -s -- [选项]
#   或先下载审阅再执行：sudo bash install-cloud.sh [选项]
#
# 选项:
#   --port <n>            云端 web 端口（默认随机高位端口；仅绑定 127.0.0.1，无需开放公网端口）
#   --dsh-version <v>     锁定 dsh 版本（默认与插件验证版本一致）
#   --key-file <f>        DeepSeek API Key 文件（一次性读取后删除；缺省稍后自行配置）
#   --ssh-pubkey <f>      本机 SSH 公钥文件（写入 dshcloud authorized_keys，用于插件免密通道）
#   --ssh-pubkey-url <u>  从 URL 取公钥（如 https://github.com/<user>.keys）
#   --mirror cn           国内网络：apt 换国内源（清华 TUNA）+ npm 换 npmmirror（国内服务器推荐）
#
# 脚本结束会打印「对接码」（DSHCP1:…），粘贴到插件的「设置 → 云接力 → 云端接入」即完成对接。
set -euo pipefail

DSH_VERSION="${DSH_VERSION:-0.2.0-rc.2}"
if [ -n "${WEB_PORT:-}" ]; then :; else WEB_PORT=$((20000 + RANDOM % 15000)); fi
DSH_USER="dshcloud"
BASE="/srv/dsh-cloud"
DSH_HOME_DIR="${BASE}/home"
KEY_FILE=""
SSH_PUBKEY=""
SSH_PUBKEY_URL=""
MIRROR_CN=""
PORT_FORCED=0
REPO_URL=""
PLUGIN_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --port) WEB_PORT="$2"; PORT_FORCED=1; shift 2 ;;
    --dsh-version) DSH_VERSION="$2"; shift 2 ;;
    --key-file) KEY_FILE="$2"; shift 2 ;;
    --ssh-pubkey) SSH_PUBKEY="$2"; shift 2 ;;
    --ssh-pubkey-url) SSH_PUBKEY_URL="$2"; shift 2 ;;
    --mirror) MIRROR_CN="$2"; shift 2 ;;
    --registry) MIRROR_CN="$2"; shift 2 ;;   # 兼容旧参数名
    --repo) REPO_URL="$2"; shift 2 ;;
    --plugin-dir) PLUGIN_DIR="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then echo "请以 root 运行（sudo）" >&2; exit 1; fi

NPM_REG="https://registry.npmjs.org"
[ "$MIRROR_CN" = "cn" ] && NPM_REG="https://registry.npmmirror.com"

# 发行版探测（只支持 Debian 12/13 与 Ubuntu 22.04/24.04）
DISTRO_ID=""; DISTRO_VER=""
if [ -f /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  DISTRO_ID="${ID:-}"; DISTRO_VER="${VERSION_ID:-}"
  echo "检测到发行版: ${PRETTY_NAME:-$DISTRO_ID $DISTRO_VER}"
fi
case "$DISTRO_ID:$DISTRO_VER" in
  debian:12|debian:13|ubuntu:22.04|ubuntu:24.04) : ;;
  *)
    echo "✗ 仅支持 Debian 12/13 与 Ubuntu 22.04/24.04（当前: ${DISTRO_ID:-未知} ${DISTRO_VER:-}）。" >&2
    echo "  其它发行版未适配；如确需使用请提 issue（附 /etc/os-release）。" >&2
    exit 1
    ;;
esac

# Ubuntu 加固：apt 期间不弹 needrestart 交互、配置文件冲突取默认值
export NEEDRESTART_MODE=a
# DPkg::Lock::Timeout：apt 自己在锁上排队（全新云镜像首次开机的 unattended-upgrades 可能占用数分钟），
# 比轮询进程更可靠，Debian 12+ / Ubuntu 22.04+ 均支持。
APT_OPTS="-o DPkg::Lock::Timeout=900 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"

echo "== 0/8 等待系统初始化 =="
# 全新服务器首次开机时 cloud-init / unattended-upgrades 可能在跑 apt，
# 直接装包会撞 /var/lib/apt/lists/lock 失败——先等它们结束。
if command -v cloud-init >/dev/null 2>&1; then
  cloud-init status --wait >/dev/null 2>&1 || true
fi
for i in $(seq 1 60); do
  if ! pgrep -x apt-get >/dev/null 2>&1 && ! pgrep -x apt >/dev/null 2>&1 \
     && ! pgrep -x dpkg >/dev/null 2>&1 && ! pgrep -x unattended-upgr >/dev/null 2>&1; then
    break
  fi
  [ "$i" = "1" ] && echo "系统正在初始化（cloud-init/unattended-upgrades 占用 apt），等待其完成…"
  sleep 5
done
# 即使仍在占用，下面 apt 也会用 DPkg::Lock::Timeout 继续排队等待
echo "== 1/8 软件源与系统包 =="
if [ "$MIRROR_CN" = "cn" ]; then
  DEB_MIRROR="https://mirrors.tuna.tsinghua.edu.cn/debian"
  DEB_SEC="https://mirrors.tuna.tsinghua.edu.cn/debian-security"
  if [ -f /etc/apt/sources.list.d/debian.sources ]; then
    sed -i -E "s#^URIs: https?://deb\.debian\.org/debian#URIs: ${DEB_MIRROR}#" /etc/apt/sources.list.d/debian.sources
    sed -i -E "s#^URIs: https?://security\.debian\.org/debian-security#URIs: ${DEB_SEC}#" /etc/apt/sources.list.d/debian.sources
  fi
  if [ -f /etc/apt/sources.list ]; then
    [ -f /etc/apt/sources.list.dsh-bak ] || cp /etc/apt/sources.list /etc/apt/sources.list.dsh-bak
    sed -i -E "s#https?://deb\.debian\.org/debian#${DEB_MIRROR}#g; s#https?://security\.debian\.org/debian-security#${DEB_SEC}#g; s#https?://deb\.debian\.org/debian-security#${DEB_SEC}#g" /etc/apt/sources.list
  fi
  if [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then
    sed -i -E "s#^URIs: https?://(archive|security)\.ubuntu\.com/ubuntu#URIs: https://mirrors.tuna.tsinghua.edu.cn/ubuntu#" /etc/apt/sources.list.d/ubuntu.sources
  fi
  if [ -f /etc/apt/sources.list ] && grep -qi ubuntu /etc/apt/sources.list 2>/dev/null; then
    sed -i -E "s#https?://(archive|security)\.ubuntu\.com/ubuntu#https://mirrors.tuna.tsinghua.edu.cn/ubuntu#g" /etc/apt/sources.list
  fi
  echo "apt 源已切换为清华 TUNA 镜像（原文件备份为 *.dsh-bak）"
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq $APT_OPTS ca-certificates curl gnupg git python3 openssl

echo "== 2/8 Node.js 22 =="
if ! command -v node >/dev/null 2>&1 || ! node -v 2>/dev/null | grep -q '^v22'; then
  if ! (curl -fsSL https://deb.nodesource.com/setup_22.x | bash -) || ! apt-get install -y -qq $APT_OPTS nodejs; then
    echo "nodesource 不可用，改用 Node 官方二进制镜像…"
    NARCH="x64"; case "$(uname -m)" in aarch64|arm64) NARCH="arm64" ;; esac
    NODE_VER="${NODE_VER:-v22.19.0}"
    curl -fsSL -o /tmp/node.tar.xz "https://npmmirror.com/mirrors/node/${NODE_VER}/node-${NODE_VER}-linux-${NARCH}.tar.xz"
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md
    rm -f /tmp/node.tar.xz
  fi
fi
node -v
npm config set registry "$NPM_REG" || true

echo "== 3/8 pnpm + DSH CLI ($DSH_VERSION) =="
npm install -g pnpm >/dev/null 2>&1 || true
npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" >/dev/null 2>&1 || true
command -v dsh && dsh --version || true

echo "== 4/8 目录、用户与凭据 =="
id -u "$DSH_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$DSH_USER"
install -d -o "$DSH_USER" -g "$DSH_USER" \
  "$DSH_HOME_DIR" \
  "$BASE/workspaces" \
  "$BASE/staging/incoming" \
  "$BASE/staging/outgoing" \
  "$BASE/jobs" \
  "$BASE/logs"

# 对接 Token：随机生成并预写云端插件配置（角色=cloud），脚本结尾打印进对接码
PLUGIN_CFG_DIR="/home/$DSH_USER/.dsh/dsh-cloud-handoff"
install -d -o "$DSH_USER" -g "$DSH_USER" "$PLUGIN_CFG_DIR"
if [ -f "$PLUGIN_CFG_DIR/config.json" ]; then
  TOKEN="$(python3 -c "import json,sys; print(json.load(open('$PLUGIN_CFG_DIR/config.json')).get('token',''))" 2>/dev/null || true)"
fi
# 端口持久化：重跑脚本时沿用首次生成的端口，避免破坏已配对客户端的配置（除非显式 --port）
if [ "$PORT_FORCED" = "0" ] && [ -f "$PLUGIN_CFG_DIR/config.json" ]; then
  SAVED_PORT="$(python3 -c "import json;print(json.load(open('$PLUGIN_CFG_DIR/config.json')).get('webPort',''))" 2>/dev/null || true)"
  case "$SAVED_PORT" in
    ''|*[!0-9]*) : ;;
    *) [ "$SAVED_PORT" != "$WEB_PORT" ] && echo "沿用已保存的云端端口：$SAVED_PORT（--port 可覆盖）"; WEB_PORT="$SAVED_PORT" ;;
  esac
fi
if [ -z "${TOKEN:-}" ]; then
  TOKEN="$(openssl rand -hex 24)"
fi
python3 - "$PLUGIN_CFG_DIR/config.json" "$TOKEN" "$WEB_PORT" <<'PYCFG'
import json, os, sys
path, token, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
cfg = {}
if os.path.exists(path):
    try: cfg = json.load(open(path))
    except Exception: cfg = {}
cfg.update({"role": "cloud", "token": token, "webPort": port})
cfg.setdefault("retentionDays", 7)
json.dump(cfg, open(path, "w"), indent=2, ensure_ascii=False)
PYCFG
chown "$DSH_USER:$DSH_USER" "$PLUGIN_CFG_DIR/config.json"
chmod 600 "$PLUGIN_CFG_DIR/config.json"

# SSH 免密（插件通道）：写入 dshcloud authorized_keys
install -d -o "$DSH_USER" -g "$DSH_USER" -m 700 /home/$DSH_USER/.ssh
touch /home/$DSH_USER/.ssh/authorized_keys
chown "$DSH_USER:$DSH_USER" /home/$DSH_USER/.ssh/authorized_keys
chmod 600 /home/$DSH_USER/.ssh/authorized_keys
PUBKEY_ADDED=""
if [ -n "$SSH_PUBKEY" ] && [ -f "$SSH_PUBKEY" ]; then
  grep -qxF "$(cat "$SSH_PUBKEY")" /home/$DSH_USER/.ssh/authorized_keys 2>/dev/null || cat "$SSH_PUBKEY" >> /home/$DSH_USER/.ssh/authorized_keys
  PUBKEY_ADDED="yes"
elif [ -n "$SSH_PUBKEY_URL" ]; then
  curl -fsSL "$SSH_PUBKEY_URL" | while IFS= read -r line; do
    [ -n "$line" ] && grep -qxF "$line" /home/$DSH_USER/.ssh/authorized_keys 2>/dev/null || echo "$line" >> /home/$DSH_USER/.ssh/authorized_keys
  done
  PUBKEY_ADDED="yes"
fi

# dshcloud 免密 sudo 重启服务（同会话二次迁移自动重启需要）
echo "$DSH_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart dsh-cloud" > /etc/sudoers.d/dshcloud-restart
chmod 440 /etc/sudoers.d/dshcloud-restart

# 给 dshcloud 用户也配镜像源
sudo -u "$DSH_USER" npm config set registry "$NPM_REG" || true

echo "== 5/8 cloud profile 初始化 =="
PROFILE_JSON="$DSH_HOME_DIR/profiles/cloud/package.json"
if [ ! -f "$PROFILE_JSON" ]; then
  sudo -u "$DSH_USER" env HOME="/home/$DSH_USER" DSH_HOME="$DSH_HOME_DIR" \
    dsh --from-default-profile web --profile cloud --help >/dev/null 2>&1 || true
fi
if [ -f "$DSH_HOME_DIR/profiles/cloud/pnpm-workspace.yaml" ]; then
  python3 - <<'EOF'
p = "/srv/dsh-cloud/home/profiles/cloud/pnpm-workspace.yaml"
try:
    s = open(p).read()
    if "allowBuilds" not in s:
        s += "allowBuilds:\n  '@deepseek-ai/dsh-subprocess-local': true\n  '@google/genai': true\n  koffi: true\n  node-pty: true\n  protobufjs: true\n"
        open(p, "w").write(s)
    print("allowBuilds 已配置")
except FileNotFoundError:
    print("pnpm-workspace.yaml 不存在，跳过")
EOF
fi
# 统一属主：profile 目录可能被 root 操作过，pnpm 以 dshcloud 身份运行才不会再撞权限
chown -R "$DSH_USER:$DSH_USER" "$DSH_HOME_DIR"
sudo -u "$DSH_USER" env HOME="/home/$DSH_USER" DSH_HOME="$DSH_HOME_DIR" \
  bash -c "cd '$DSH_HOME_DIR/profiles/cloud' && pnpm install" >/dev/null 2>&1 || true
chown -R "$DSH_USER:$DSH_USER" "$DSH_HOME_DIR"

echo "== 6/8 systemd 服务（dsh-cloud）=="
cat > /etc/systemd/system/dsh-cloud.service <<EOF
[Unit]
Description=DSH Cloud Handoff — 云端常驻执行端
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${DSH_USER}
Environment=HOME=/home/${DSH_USER}
Environment=DSH_HOME=${DSH_HOME_DIR}
Environment=DSH_PROFILE=cloud
ExecStart=/usr/bin/env dsh --profile cloud --port ${WEB_PORT} --host 127.0.0.1 --no-open
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now dsh-cloud

echo "== 7/8 DeepSeek API Key =="
if [ -n "$KEY_FILE" ] && [ -f "$KEY_FILE" ]; then
  KEY="$(cat "$KEY_FILE")"
  CRED="$DSH_HOME_DIR/.credentials.yaml"
  if [ -f "$CRED" ] && ! grep -q "DEEPSEEK_API_KEY" "$CRED"; then
    if grep -q "^refs:" "$CRED"; then
      python3 - "$CRED" "$KEY" <<'EOF'
import sys
path, key = sys.argv[1], sys.argv[2]
s = open(path).read()
idx = s.index("refs:")
insert_at = s.index("\n", idx) + 1
s = s[:insert_at] + f"  DEEPSEEK_API_KEY: {key}\n" + s[insert_at:]
open(path, "w").write(s)
EOF
    else
      printf "refs:\n  DEEPSEEK_API_KEY: %s\n" "$KEY" >> "$CRED"
    fi
    chown "$DSH_USER:$DSH_USER" "$CRED"; chmod 600 "$CRED"
    echo "API Key 已写入 refs.DEEPSEEK_API_KEY"
  elif [ ! -f "$CRED" ]; then
    printf "version: 1\nrecords: {}\nrefs:\n  DEEPSEEK_API_KEY: %s\n" "$KEY" > "$CRED"
    chown "$DSH_USER:$DSH_USER" "$CRED"; chmod 600 "$CRED"
    echo "凭据库新建并写入 refs.DEEPSEEK_API_KEY"
  else
    echo "凭据库已含 DEEPSEEK_API_KEY，跳过"
  fi
  rm -f "$KEY_FILE"
else
  echo "未提供 --key-file，稍后自行配置 API Key（可参考文档用 SSH 隧道打开云端设置页）"
fi

echo "== 8/8 云端插件与完成 =="
# 插件 bundle：若服务器已放置本仓库则 link，否则提示安装方式
PLUGIN_DIR="${PLUGIN_DIR:-/srv/dsh-cloud-handoff}"
LINK_LOG="/tmp/dsh-cloud-link.log"
if [ -n "$REPO_URL" ]; then
  rm -rf "$PLUGIN_DIR"
  git clone --depth 1 "$REPO_URL" "$PLUGIN_DIR"
fi
if [ ! -d "$PLUGIN_DIR" ]; then
  echo "✗ 未找到插件 bundle：$PLUGIN_DIR" >&2
  echo "  请 git clone 本仓库到该路径，或重跑脚本加 --repo <git地址> / --plugin-dir <路径>。" >&2
  exit 1
fi
chown -R "$DSH_USER:$DSH_USER" "$PLUGIN_DIR"
chown -R "$DSH_USER:$DSH_USER" "$DSH_HOME_DIR"
if ! sudo -u "$DSH_USER" env HOME="/home/$DSH_USER" DSH_HOME="$DSH_HOME_DIR" \
     dsh plugin --profile cloud link "$PLUGIN_DIR" >"$LINK_LOG" 2>&1; then
  echo "✗ 插件链接失败（云端将无法工作）。日志尾部：" >&2
  tail -15 "$LINK_LOG" >&2
  exit 1
fi
# dsh plugin link/add 只写 dependencies，不会写 dsh.profile.bundles —— 必须显式注册，否则云端不会加载插件
python3 - "$PROFILE_JSON" <<'PYJSON'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
b = d.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])
if "dsh-cloud-handoff" not in b:
    b.append("dsh-cloud-handoff")
    json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
    print("已注册 bundle: dsh-cloud-handoff")
else:
    print("bundle 注册已存在")
PYJSON
chown "$DSH_USER:$DSH_USER" "$PROFILE_JSON"
if ! python3 - "$PROFILE_JSON" <<'PYCHECK'
import json, sys
d = json.load(open(sys.argv[1]))
deps = d.get("dependencies") or {}
assert "dsh-cloud-handoff" in deps, "依赖缺失"
assert "dsh-cloud-handoff" in d["dsh"]["profile"]["bundles"], "bundle 未注册"
PYCHECK
then
  echo "✗ 插件注册校验失败（依赖或 bundles 缺失）" >&2
  exit 1
fi
echo "插件已链接并注册到 cloud profile ✓"
systemctl restart dsh-cloud || true

# 启动后自检：云端插件 RPC 是否真的在线（DSH 冷启动约 20~30 秒，这里轮询最多 90 秒）
echo "等待云端 DSH 启动并自检…"
SELFCHECK_FAILED=1
for i in $(seq 1 18); do
  if curl -s --max-time 6 -X POST "http://127.0.0.1:${WEB_PORT}/_dsh/dsh-cloud-handoff/ping" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    SELFCHECK_FAILED=0
    echo "云端插件自检通过 ✓（第 $((i * 5)) 秒）"
    break
  fi
  sleep 5
done
if [ "$SELFCHECK_FAILED" = "1" ]; then
  echo "⚠ 云端插件自检失败（90 秒内无响应）：journalctl -u dsh-cloud -n 50 查看原因" >&2
fi

# ---- 对接信息 ----
HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -z "$HOST" ] && HOST="$(curl -fsSL --max-time 8 ifconfig.me 2>/dev/null || echo '<服务器IP或域名>')"
PAIRING_JSON="{\"host\":\"$HOST\",\"sshUser\":\"$DSH_USER\",\"sshPort\":22,\"webPort\":$WEB_PORT,\"remoteBase\":\"$BASE\",\"token\":\"$TOKEN\"}"
PAIRING_CODE="$(printf '%s' "$PAIRING_JSON" | base64 | tr -d '\n')"

cat <<EOF

============================================================
 ✅ 云端执行端部署完成
============================================================
 服务状态:   systemctl status dsh-cloud
 日志:       journalctl -u dsh-cloud -f
 健康检查:   curl -s http://127.0.0.1:${WEB_PORT}/ （服务器本机）

 —— 插件对接码（粘贴到插件「设置 → 云接力 → 云端接入」）——
 DSHCP1:${PAIRING_CODE}

 —— 手动配置（不想用对接码时）——
 主机:   ${HOST}
 SSH:    ${DSH_USER}@${HOST} （端口 22）
 RPC:    ${WEB_PORT}（仅服务器本机回环，经 SSH 访问）
 Token:  ${TOKEN}
============================================================
EOF

if [ "${SELFCHECK_FAILED:-0}" = "1" ]; then
  echo "⚠ 注意：云端插件自检未通过，请先排查再使用插件对接。" >&2
fi

if [ -z "$PUBKEY_ADDED" ]; then
  cat <<EOF
⚠ 尚未写入本机 SSH 公钥（插件免密通道需要）。请补一步：
  1. 本机执行:  cat ~/.ssh/id_ed25519.pub   （没有就先 ssh-keygen -t ed25519）
  2. 服务器执行:
     echo '粘贴公钥内容' | sudo tee -a /home/${DSH_USER}/.ssh/authorized_keys
  3. 重跑本脚本并加 --ssh-pubkey 参数，或在插件里配置带密码/密钥的 SSH 登录
EOF
fi
