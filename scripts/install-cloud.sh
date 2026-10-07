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
#   --proxy-config <f>    mihomo 配置文件（可选；提供后自动下载兼容构建并部署出站代理）
#   --registry cn         国内网络：npm 改用 npmmirror 镜像
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
PROXY_CONFIG=""
REGISTRY_CN=""
MIHOMO_BINARY=""
REPO_URL=""
PLUGIN_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --port) WEB_PORT="$2"; shift 2 ;;
    --dsh-version) DSH_VERSION="$2"; shift 2 ;;
    --key-file) KEY_FILE="$2"; shift 2 ;;
    --ssh-pubkey) SSH_PUBKEY="$2"; shift 2 ;;
    --ssh-pubkey-url) SSH_PUBKEY_URL="$2"; shift 2 ;;
    --proxy-config) PROXY_CONFIG="$2"; shift 2 ;;
    --mihomo-binary) MIHOMO_BINARY="$2"; shift 2 ;;
    --registry) REGISTRY_CN="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --plugin-dir) PLUGIN_DIR="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then echo "请以 root 运行（sudo）" >&2; exit 1; fi

NPM_REG="https://registry.npmjs.org"
[ "$REGISTRY_CN" = "cn" ] && NPM_REG="https://registry.npmmirror.com"

# 发行版探测
if [ -f /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "检测到发行版: $PRETTY_NAME"
fi

echo "== 1/9 系统包 =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git python3 openssl

echo "== 2/9 Node.js 22 =="
if ! command -v node >/dev/null 2>&1 || ! node -v 2>/dev/null | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
node -v
npm config set registry "$NPM_REG" || true

echo "== 3/9 pnpm + DSH CLI ($DSH_VERSION) =="
npm install -g pnpm >/dev/null 2>&1 || true
npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" >/dev/null 2>&1 || true
command -v dsh && dsh --version || true

echo "== 4/9 目录、用户与凭据 =="
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
if [ -z "${TOKEN:-}" ]; then
  TOKEN="$(openssl rand -hex 24)"
  printf '{"role": "cloud", "token": "%s", "retentionDays": 7}\n' "$TOKEN" > "$PLUGIN_CFG_DIR/config.json"
  chown "$DSH_USER:$DSH_USER" "$PLUGIN_CFG_DIR/config.json"
  chmod 600 "$PLUGIN_CFG_DIR/config.json"
fi

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

echo "== 5/9 cloud profile 初始化 =="
PROFILE_JSON="$DSH_HOME_DIR/profiles/cloud/package.json"
if [ ! -f "$PROFILE_JSON" ]; then
  sudo -u "$DSH_USER" env DSH_HOME="$DSH_HOME_DIR" \
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
(cd "$DSH_HOME_DIR/profiles/cloud" && pnpm install >/dev/null 2>&1 || true)

echo "== 6/9 systemd 服务（dsh-cloud）=="
PROXY_ENV=""
if [ -n "$PROXY_CONFIG" ]; then PROXY_ENV=$'Environment=http_proxy=http://127.0.0.1:7890\nEnvironment=https_proxy=http://127.0.0.1:7890\nEnvironment=no_proxy=localhost,127.0.0.1,::1,192.168.0.0/16,10.0.0.0/8'; fi
cat > /etc/systemd/system/dsh-cloud.service <<EOF
[Unit]
Description=DSH Cloud Handoff — 云端常驻执行端
After=network-online.target
Wants=network-online.target

[Service]
${PROXY_ENV}
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

echo "== 7/9 mihomo 出站代理（可选）=="
if [ -n "$PROXY_CONFIG" ] && [ -f "$PROXY_CONFIG" ]; then
  install -d /etc/mihomo
  install -m 0644 "$PROXY_CONFIG" /etc/mihomo/config.yaml
  if [ -z "$MIHOMO_BINARY" ] || [ ! -f "$MIHOMO_BINARY" ]; then
    ARCH="amd64"
    case "$(uname -m)" in
      aarch64|arm64) ARCH="arm64" ;;
    esac
    MIHOMO_VER="v1.19.32"
    MIHOMO_URL="https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VER}/mihomo-linux-${ARCH}-compatible-${MIHOMO_VER}.gz"
    echo "下载 mihomo（compatible 构建，$ARCH）…"
    curl -fsSL -o /tmp/mihomo.gz "$MIHOMO_URL"
    MIHOMO_BINARY="/tmp/mihomo.gz"
  fi
  gunzip -c "$MIHOMO_BINARY" > /tmp/mihomo 2>/dev/null || cp "$MIHOMO_BINARY" /tmp/mihomo
  install -m 0755 /tmp/mihomo /usr/local/bin/mihomo
  cat > /etc/systemd/system/mihomo.service <<'EOF'
[Unit]
Description=mihomo (Clash Meta core) — 云端出站代理
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/mihomo -d /etc/mihomo -f /etc/mihomo/config.yaml
Restart=always
RestartSec=3
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now mihomo
  echo "mihomo 已部署；dsh-cloud 服务走 127.0.0.1:7890"
else
  echo "未提供 --proxy-config，跳过代理部署（云端直连）"
fi

echo "== 8/9 DeepSeek API Key =="
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

echo "== 9/9 云端插件与完成 =="
# 插件 bundle：若服务器已放置本仓库则 link，否则提示安装方式
PLUGIN_DIR="${PLUGIN_DIR:-/srv/dsh-cloud-handoff}"
if [ -n "$REPO_URL" ]; then
  rm -rf "$PLUGIN_DIR"
  git clone --depth 1 "$REPO_URL" "$PLUGIN_DIR"
fi
if [ -d "$PLUGIN_DIR" ]; then
  chown -R "$DSH_USER:$DSH_USER" "$PLUGIN_DIR"
  sudo -u "$DSH_USER" env DSH_HOME="$DSH_HOME_DIR" dsh plugin --profile cloud link "$PLUGIN_DIR" >/dev/null 2>&1 || true
else
  echo "提示：请把插件 bundle 放到 $PLUGIN_DIR，或重跑脚本加 --repo <git地址> 自动克隆，然后执行："
  echo "  sudo -u $DSH_USER env DSH_HOME=$DSH_HOME_DIR dsh plugin --profile cloud link $PLUGIN_DIR"
fi
systemctl restart dsh-cloud || true

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

if [ -z "$PUBKEY_ADDED" ]; then
  cat <<EOF
⚠ 尚未写入本机 SSH 公钥（插件免密通道需要）。请补一步：
  1. 本机执行:  cat ~/.ssh/id_ed25519.pub   （没有就先 ssh-keygen -t ed25519）
  2. 服务器执行:
     echo '粘贴公钥内容' | sudo tee -a /home/${DSH_USER}/.ssh/authorized_keys
  3. 重跑本脚本并加 --ssh-pubkey 参数，或在插件里配置带密码/密钥的 SSH 登录
EOF
fi
