#!/usr/bin/env bash
# dsh-cloud-handoff — 云端 DSH 执行端一键部署（幂等，可在 Debian 12/13 上重复执行）
#
# 用法:
#   sudo bash install-cloud.sh [--port 39127] [--key-file /path/deepseek-key.txt] \
#        [--ssh-pubkey /path/id_ed25519.pub] \
#        [--proxy-config /path/mihomo-config.yaml] [--mihomo-binary /path/mihomo.gz]
#
# 2026-10-07 实机验证版本（PVE VM dsh-cloud, Debian 13）：
#   - npm 镜像 npmmirror（国内）；Node 22 + pnpm + @deepseek-ai/dsh@0.2.0-rc.2
#   - cloud profile 从 web 模板初始化；systemd 常驻（--host 127.0.0.1，无位置参数）
#   - 可选 mihomo 出站代理（FlClash 同款内核 + 五节点配置的服务器安全版）
#   - DeepSeek API Key 注入凭据库（refs.DEEPSEEK_API_KEY）
set -euo pipefail

DSH_VERSION="${DSH_VERSION:-0.2.0-rc.2}"
WEB_PORT="${WEB_PORT:-39127}"
DSH_USER="dshcloud"
BASE="/srv/dsh-cloud"
DSH_HOME_DIR="${BASE}/home"
KEY_FILE=""
SSH_PUBKEY=""
PROXY_CONFIG=""
MIHOMO_BINARY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --port) WEB_PORT="$2"; shift 2 ;;
    --key-file) KEY_FILE="$2"; shift 2 ;;
    --ssh-pubkey) SSH_PUBKEY="$2"; shift 2 ;;
    --proxy-config) PROXY_CONFIG="$2"; shift 2 ;;
    --mihomo-binary) MIHOMO_BINARY="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then echo "请以 root 运行" >&2; exit 1; fi

echo "== 1/8 系统包与镜像源 =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git rsync zstd python3

echo "== 2/8 Node.js 22 =="
if ! command -v node >/dev/null 2>&1 || ! node -v 2>/dev/null | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
node -v
npm config set registry https://registry.npmmirror.com || true

echo "== 3/8 pnpm + DSH CLI ($DSH_VERSION) =="
npm install -g pnpm >/dev/null 2>&1 || true
npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" >/dev/null 2>&1 || true
command -v dsh && dsh --version || true

echo "== 4/8 目录与用户 =="
id -u "$DSH_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$DSH_USER"
install -d -o "$DSH_USER" -g "$DSH_USER" \
  "$DSH_HOME_DIR" \
  "$BASE/workspaces" \
  "$BASE/staging/incoming" \
  "$BASE/staging/outgoing" \
  "$BASE/jobs" \
  "$BASE/logs"
if [ -n "$SSH_PUBKEY" ] && [ -f "$SSH_PUBKEY" ]; then
  install -d -o "$DSH_USER" -g "$DSH_USER" -m 700 /home/$DSH_USER/.ssh
  grep -qxF "$(cat "$SSH_PUBKEY")" /home/$DSH_USER/.ssh/authorized_keys 2>/dev/null || \
    cat "$SSH_PUBKEY" >> /home/$DSH_USER/.ssh/authorized_keys
  chown "$DSH_USER:$DSH_USER" /home/$DSH_USER/.ssh/authorized_keys
  chmod 600 /home/$DSH_USER/.ssh/authorized_keys
  echo "SSH 公钥已写入 dshcloud authorized_keys"
fi
# 给 dshcloud 用户也配镜像源
sudo -u "$DSH_USER" npm config set registry https://registry.npmmirror.com || true

echo "== 5/8 cloud profile 初始化 =="
PROFILE_JSON="$DSH_HOME_DIR/profiles/cloud/package.json"
if [ ! -f "$PROFILE_JSON" ]; then
  # 首次：从 web 模板初始化 profile（--help 让 app 只完成初始化即退出）
  sudo -u "$DSH_USER" env DSH_HOME="$DSH_HOME_DIR" \
    dsh --from-default-profile web --profile cloud --help >/dev/null 2>&1 || true
fi
if [ -f "$DSH_HOME_DIR/profiles/cloud/pnpm-workspace.yaml" ]; then
  python3 - <<'EOF'
import re
p = "/srv/dsh-cloud/home/profiles/cloud/pnpm-workspace.yaml"
s = open(p).read()
if "allowBuilds" not in s:
    s += "allowBuilds:\n  '@deepseek-ai/dsh-subprocess-local': true\n  '@google/genai': true\n  koffi: true\n  node-pty: true\n  protobufjs: true\n"
    open(p, "w").write(s)
print("allowBuilds 已配置")
EOF
fi
(cd "$DSH_HOME_DIR/profiles/cloud" && pnpm install >/dev/null 2>&1 || true)

echo "== 6/8 systemd 服务（dsh-cloud）=="
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

echo "== 7/8 mihomo 出站代理（可选）=="
if [ -n "$MIHOMO_BINARY" ] && [ -f "$MIHOMO_BINARY" ] && [ -n "$PROXY_CONFIG" ] && [ -f "$PROXY_CONFIG" ]; then
  install -d /etc/mihomo
  gunzip -c "$MIHOMO_BINARY" > /tmp/mihomo 2>/dev/null || cp "$MIHOMO_BINARY" /tmp/mihomo
  install -m 0755 /tmp/mihomo /usr/local/bin/mihomo
  install -m 0644 "$PROXY_CONFIG" /etc/mihomo/config.yaml
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
  # 代理环境变量已在 dsh-cloud.service 中（PROXY_ENV）
  echo "mihomo 已部署；dsh-cloud 服务走 127.0.0.1:7890"
else
  echo "未提供 --proxy-config/--mihomo-binary，跳过代理部署（dsh-cloud 直连）"
fi

echo "== 8/8 DeepSeek API Key =="
if [ -n "$KEY_FILE" ] && [ -f "$KEY_FILE" ]; then
  KEY="$(cat "$KEY_FILE")"
  CRED="$DSH_HOME_DIR/.credentials.yaml"
  if [ -f "$CRED" ] && ! grep -q "DEEPSEEK_API_KEY" "$CRED"; then
    if grep -q "^refs:" "$CRED"; then
      # 在 refs: 之后插入（保留 records）
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
    install -o "$DSH_USER" -g "$DSH_USER" -m 600 /dev/null "$CRED"
    printf "version: 1\nrecords: {}\nrefs:\n  DEEPSEEK_API_KEY: %s\n" "$KEY" > "$CRED"
    chown "$DSH_USER:$DSH_USER" "$CRED"
    echo "凭据库新建并写入 refs.DEEPSEEK_API_KEY"
  else
    echo "凭据库已含 DEEPSEEK_API_KEY，跳过"
  fi
  rm -f "$KEY_FILE"
else
  echo "未提供 --key-file，稍后在云端 DSH 设置里手动填 API Key"
fi

echo "== 完成 =="
echo "  状态: systemctl status dsh-cloud mihomo"
echo "  健康: curl -s http://127.0.0.1:${WEB_PORT}/ (本机)"
echo "  日志: journalctl -u dsh-cloud -f"
