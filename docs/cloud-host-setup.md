# 云端执行端部署手册（cloud-host-setup）

## 1. 拓扑

```
家里局域网
  PVE MS-01 (192.168.1.11) ── VM 120 dsh-cloud (192.168.1.40, Debian 13)
     ├─ mihomo 出站代理 127.0.0.1:7890（五节点配置的服务器安全版）
     ├─ dsh-cloud.service：无头 dsh web @127.0.0.1:39127（用户 dshcloud，DSH_HOME=/srv/dsh-cloud/home）
     └─ 目录：/srv/dsh-cloud/{home,workspaces,staging/incoming,staging/outgoing,jobs,logs}
本机 Mac
  ~/.ssh/config: Host dsh-cloud → 192.168.1.40（debian 管理员 / dshcloud 插件通道）
  插件配置 ~/.dsh/dsh-cloud-handoff/config.json（role=local, host=dsh-cloud, sshUser=dshcloud, token）
```

## 2. 一键部署（VM 已建好的前提下）

```bash
# 1) 在 Mac 上准备素材
#    - mihomo 兼容构建: https://github.com/MetaCubeX/mihomo/releases（linux-amd64-compatible，旧 CPU 用）
#    - 五节点配置的服务器安全版（只改两行）:
#      sed -e 's/^allow-lan: true$/allow-lan: false/' \
#          -e 's/^  listen: 0.0.0.0:53$/  listen: 127.0.0.1:5335/' 五节点.yaml > mihomo-config.yaml

# 2) 上传并执行（幂等）
scp scripts/install-cloud.sh mihomo-*.gz mihomo-config.yaml <vm>:/tmp/
ssh <vm> 'sudo bash /tmp/install-cloud.sh \
  --key-file <deepseek-key.txt> --ssh-pubkey ~/.ssh/id_ed25519.pub \
  --proxy-config /tmp/mihomo-config.yaml --mihomo-binary /tmp/mihomo-*.gz'
```

## 3. PVE VM 关键配置（VMID 120）

- 2C/4G；scsi0 30G 在 **RBD**（Ceph 3 副本）；scsihw virtio-scsi-single（iothread）；net0 bridge=lan；cloud-init 盘在 local。
- IP 静态 192.168.1.40（DHCP 池 192.168.1.49–249 之外，无冲突）。
- cloud-init：ciuser=debian + sshkeys=Mac 公钥；登录后 sudo 免密。

## 4. 部署后必做

1. `ssh dshcloud@<vm>` 确认免密；`ssh dsh-cloud` 别名可用。
2. `systemctl status dsh-cloud mihomo` 均 active。
3. 取云端 token：`ssh <vm> 'sudo cat /home/dshcloud/.dsh/dsh-cloud-handoff/config.json'`，写入本机插件高级设置。
4. 验证出站代理：`curl -x http://127.0.0.1:7890 https://www.google.com -o /dev/null -w '%{http_code}'` → 200。
5. 安装插件 bundle 到云端 profile：`sudo -u dshcloud env DSH_HOME=/srv/dsh-cloud/home dsh plugin --profile cloud link <插件目录>`，写 role=cloud 配置，重启服务，`curl -X POST http://127.0.0.1:39127/_dsh/dsh-cloud-handoff/ping` → `{"ok":true,"role":"cloud"}`。

## 5. 关键参数

| 项 | 值 |
|---|---|
| DSH 版本（双端钉定） | 0.2.0-rc.2 |
| Node（VM） | 22.23.3（nodesource），npm 镜像 npmmirror |
| dsh-cloud 端口/绑定 | 39127 / 127.0.0.1（仅回环，经 SSH 访问） |
| mihomo | v1.19.32 compatible（VM 虚拟 CPU 无 AVX2，标准构建跑不了） |
| 代理注入 | dsh-cloud.service 的 Environment（http_proxy/https_proxy/no_proxy=192.168.0.0/16 等） |
| DeepSeek Key | 云端凭据库 /srv/dsh-cloud/home/.credentials.yaml 的 refs.DEEPSEEK_API_KEY |

## 6. 踩坑记录（2026-10-07 实机）

- `dsh --profile cloud web …` 报 `too many arguments: web`——`--profile` 后不要再跟位置参数 `web`。
- profile 首次初始化：`dsh --from-default-profile web --profile cloud --help`（profile 已存在时去掉 `--from-default-profile`）。
- npm 直连太慢 → `npm config set registry https://registry.npmmirror.com`（root 与 dshcloud 都要配）。
- mihomo 标准构建报 `AMD64 v3` 不支持 → 用 `compatible` 构建。
- cephfs 不支持 content-type 'images'（cloud-init 盘）→ cloud-init 盘放 `local`；数据盘仍在 RBD。
- 会话 id 在云端 DSH_HOME 全局唯一：重复导入前先移除旧目录（插件已内置处理）。
