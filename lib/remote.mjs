/**
 * lib/remote.mjs — SSH 通道（本地 ↔ 云端）
 *
 * 所有远程操作走 ssh 子进程：
 *   - sshExec(host, user, key, cmd)  执行单条命令（BatchMode，免交互）
 *   - rsyncPush(src, host, user, key, remotePath)  上传目录
 *   - rsyncPull(remotePath, dst, ...)              下载目录
 * 云端 DSH 的 RPC 经 ssh exec curl http://127.0.0.1:<port>/… 调用（带 token）。
 */
import { spawn } from "node:child_process";

export function sshArgs(cfg) {
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=accept-new"];
  if (cfg.sshKey) args.push("-i", cfg.sshKey);
  if (cfg.sshPort) args.push("-p", String(cfg.sshPort));
  const user = cfg.sshUser ? `${cfg.sshUser}@` : "";
  return { args, target: `${user}${cfg.host}` };
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

/** rsync 上传目录内容到远端。 */
export function rsyncPush(localDir, cfg, remoteDir, { timeoutMs = 600_000 } = {}) {
  return new Promise((resolve) => {
    const args = [
      "-a", "--delete", "-e",
      `ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new${cfg.sshKey ? ` -i ${cfg.sshKey}` : ""}${cfg.sshPort ? ` -p ${cfg.sshPort}` : ""}`,
      `${localDir}/`, `${cfg.sshUser ? `${cfg.sshUser}@` : ""}${cfg.host}:${remoteDir}/`,
    ];
    const child = spawn("rsync", args, { stdio: ["ignore", "pipe", "pipe"] });
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

/** rsync 从远端下载目录内容。 */
export function rsyncPull(cfg, remoteDir, localDir, { timeoutMs = 600_000 } = {}) {
  return new Promise((resolve) => {
    const args = [
      "-a", "-e",
      `ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new${cfg.sshKey ? ` -i ${cfg.sshKey}` : ""}${cfg.sshPort ? ` -p ${cfg.sshPort}` : ""}`,
      `${cfg.sshUser ? `${cfg.sshUser}@` : ""}${cfg.host}:${remoteDir}/`, `${localDir}/`,
    ];
    const child = spawn("rsync", args, { stdio: ["ignore", "pipe", "pipe"] });
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
