/**
 * lib/remote.mjs — SSH 通道（本地 ↔ 云端）
 *
 * 所有远程操作走 ssh 子进程：
 *   - sshExec(host, user, key, cmd)  执行单条命令（BatchMode，免交互）
 *   - rsyncPush / rsyncPull          目录上传/下载（tar-over-ssh 实现，无 rsync 依赖）
 * 云端 DSH 的 RPC 经 ssh exec curl http://127.0.0.1:<port>/… 调用（带 token）。
 *
 * 兼容性：只用系统自带的 ssh/tar/curl/bash——macOS、Linux、Windows(OpenSSH) 均可，
 * 不依赖 rsync / zstd 等额外二进制（本地机器无需安装任何东西）。
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

export function sshArgs(cfg) {
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=accept-new"];
  if (cfg.sshKey) args.push("-i", cfg.sshKey);
  if (cfg.sshPort) args.push("-p", String(cfg.sshPort));
  const user = cfg.sshUser ? `${cfg.sshUser}@` : "";
  return { args, target: `${user}${cfg.host}` };
}

/** 把字符串安全地放进单引号 shell 片段（处理内嵌单引号）。 */
function shq(s) {
  return `'${String(s).replaceAll("'", "'\\''")}'`;
}

/** 拼接出完整的 ssh 目标（user@host），供命令行使用。 */
function sshTarget(cfg) {
  return `${cfg.sshUser ? `${cfg.sshUser}@` : ""}${cfg.host}`;
}

/** 执行一条远程命令；返回 {code, stdout, stderr}。 */
export function sshExec(cfg, cmd, { timeoutMs = 120_000 } = {}) {
  const { args, target } = sshArgs(cfg);
  return new Promise((resolve) => {
    const child = spawn("ssh", [...args, target, cmd], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: -1, stdout: out, stderr: err + "\n[timeout]" });
    }, timeoutMs);
    child.stdout.on("data", (c) => { out += c.toString(); });
    child.stderr.on("data", (c) => { err += c.toString(); });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: out, stderr: String(e?.message ?? e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: out, stderr: err });
    });
  });
}

/** 通过 ssh 跑一个带管道的 shell 命令（本地 pipefail 保证远端失败也报错）。 */
function pipeExec(cmd, { timeoutMs = 600_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", `set -o pipefail; ${cmd}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: -1, stdout: out, stderr: err + "\n[timeout]" });
    }, timeoutMs);
    child.stdout.on("data", (c) => { out += c.toString(); });
    child.stderr.on("data", (c) => { err += c.toString(); });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: out, stderr: String(e?.message ?? e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: out, stderr: err });
    });
  });
}

/** 上传目录内容到远端（tar-over-ssh；远端目录先清空重建，等价 rsync --delete 语义）。 */
export function rsyncPush(localDir, cfg, remoteDir, { timeoutMs = 600_000 } = {}) {
  const { args } = sshArgs(cfg);
  const sshCmd = ["ssh", ...args, sshTarget(cfg), `rm -rf ${shq(remoteDir)} && mkdir -p ${shq(remoteDir)} && tar -C ${shq(remoteDir)} -xf -`].map(shq).join(" ");
  const tarCmd = `tar --no-xattrs -C ${shq(localDir)} -cf - .`;
  return pipeExec(`${tarCmd} | ${sshCmd}`, { timeoutMs });
}

/** 从远端下载目录内容到本地（tar-over-ssh；本地目录先清空重建）。 */
export function rsyncPull(cfg, remoteDir, localDir, { timeoutMs = 600_000 } = {}) {
  const { args } = sshArgs(cfg);
  try { rmSync(localDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  try { mkdirSync(localDir, { recursive: true }); } catch { /* 忽略 */ }
  const sshCmd = ["ssh", ...args, sshTarget(cfg), `tar -C ${shq(remoteDir)} -cf - .`].map(shq).join(" ");
  const tarCmd = `tar -C ${shq(localDir)} -xf -`;
  return pipeExec(`${sshCmd} | ${tarCmd}`, { timeoutMs });
}

/** 调用云端插件的 RPC（ssh exec curl）。返回解析后的 JSON 或 {ok:false,error}。 */
export async function cloudRpc(cfg, method, body = {}, { timeoutMs = 120_000 } = {}) {
  const payload = JSON.stringify(body).replaceAll("'", "'\\''");
  const curl = `curl -s --max-time 60 -X POST "http://127.0.0.1:${cfg.remotePort}/_dsh/dsh-cloud-handoff/${method}" -H 'content-type: application/json' -d '${payload}'`;
  const r = await sshExec(cfg, curl, { timeoutMs });
  if (r.code !== 0) return { ok: false, error: `SSH 失败: ${r.stderr.trim() || `exit ${r.code}`}` };
  try {
    return JSON.parse(r.stdout.trim());
  } catch {
    return { ok: false, error: `云端返回不可解析: ${r.stdout.trim().slice(0, 200)}` };
  }
}
