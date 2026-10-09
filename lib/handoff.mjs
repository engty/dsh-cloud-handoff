/**
 * lib/handoff.mjs — handoff bundle 打包与校验（本地侧）
 *
 * bundle 布局见 docs/DESIGN.md 第 4 节。
 * 安全：凭据/私钥永不进包（写盘前按 SECRET_PATTERNS 与 FILE_DENY 过滤扫描）。
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { statSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, sep, resolve } from "node:path";
import { zstdCompress } from "node:zlib";
import { promisify } from "node:util";

const zstdCompressAsync = promisify(zstdCompress);

/** 单包上限（对齐 Blaxel 边界） */
export const LIMITS = { maxSnapshotBytes: 512 * 1024 * 1024, maxEntries: 100_000, maxChildSessions: 32, maxChildBytes: 16 * 1024 * 1024 };

/** 疑似密钥模式（沿用 dsh-config-backup 的扫描口径） */
export const SECRET_PATTERNS = [
  /gho_[A-Za-z0-9]{20,}/iu,
  /ghp_[A-Za-z0-9]{20,}/iu,
  /github_pat_/iu,
  /sk-[A-Za-z0-9]{20,}/iu,
  /BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY/iu,
  /Bearer [A-Za-z0-9._-]{24,}/iu,
];

/** 直接排除的文件/目录（相对工作区根，支持目录名与后缀） */
export const FILE_DENY = [
  ".git", ".dsh-cloud-handoff", "node_modules/.cache",
  ".env", ".env.*", ".npmrc", ".pypirc", ".netrc",
  "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "id_rsa*", "id_ed25519*",
  ".credentials.yaml", "*.sqlite3-wal", "*.sqlite3-shm",
];

export function pathDenied(rel) {
  const parts = rel.split("/");
  for (const part of parts) {
    for (const rule of FILE_DENY) {
      if (rule.includes(".") && !rule.includes("*")) {
        if (part === rule) return true;
      } else if (rule.endsWith(".*")) {
        if (part.startsWith(rule.slice(0, -2))) return true;
      } else if (rule.includes("*")) {
        const re = new RegExp("^" + rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
        if (re.test(part) || re.test(rel)) return true;
      } else if (rel === rule) {
        return true;
      }
    }
  }
  return false;
}

/** git 列出工作区应打包的文件（跟踪 + 未忽略的未跟踪），返回相对路径数组（/ 分隔）。 */
export function listWorktreeFiles(cwd) {
  const r = spawnSync("git", ["-c", "core.quotepath=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd, maxBuffer: 64 * 1024 * 1024, encoding: "buffer",
  });
  if (r.status !== 0) throw new Error(`git ls-files 失败（exit ${r.status}）：${String(r.stderr).trim()}`);
  return r.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((p) => p.replaceAll(sep, "/"))
    .filter((rel) => !pathDenied(rel));
}

/** 非 git 工作区兜底：跳过这些目录（依赖/构建产物/缓存/VCS 内部）。 */
export const WALK_SKIP_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache",
  ".gradle", ".terraform", "DerivedData", "Pods", ".next", ".nuxt", ".turbo",
  ".cache", ".dart_tool", ".build", ".dsh-cloud-handoff", ".dsh",
  ".dsh-conversation-manager", ".dsh-vision-toolkit",
]);

/**
 * 扫描工作区应打包的文件：
 *   - git 仓库（且仓库根 == cwd）：沿用 git 清单（跟踪 + 未忽略未跟踪）
 *   - 其余（无仓库 / 嵌套仓库 / 仓库根在别处）：文件系统遍历 + 排除表
 * 返回 { files, mode, bytes, skipped }；超限抛友好错误（供预检在打断任务前使用）。
 * 永不触碰任何远程仓库：这里只用 git 的本地清单能力，不读取 remote。
 */
export function scanWorkspace(cwd) {
  if (!existsSync(cwd)) throw new Error(`工作区目录不存在：${cwd}`);
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let isRepoRoot = false;
  if (top.status === 0 && top.stdout.trim()) {
    try { isRepoRoot = realpathSync(top.stdout.trim()) === realpathSync(cwd); } catch { isRepoRoot = false; }
  }

  let files, mode, skipped = 0;
  if (isRepoRoot) {
    files = listWorktreeFiles(cwd);
    mode = "git";
  } else {
    const out = [];
    const walk = (dir, rel) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isSymbolicLink()) { skipped += 1; continue; }
        const childRel = rel ? rel + "/" + e.name : e.name;
        if (e.isDirectory()) {
          if (WALK_SKIP_DIRS.has(e.name) || pathDenied(childRel)) { skipped += 1; continue; }
          walk(join(dir, e.name), childRel);
        } else if (e.isFile()) {
          if (e.name === ".DS_Store" || pathDenied(childRel)) { skipped += 1; continue; }
          out.push(childRel);
        }
      }
    };
    walk(cwd, "");
    files = out.sort();
    mode = "walk";
  }

  let bytes = 0;
  for (const rel of files) {
    try { bytes += statSync(join(cwd, rel)).size; } catch { /* 竞态消失 */ }
  }
  if (files.length > LIMITS.maxEntries) {
    throw new Error(`工作区文件数过多（${files.length} > ${LIMITS.maxEntries} 个），请把大文件/缓存移出工作区`);
  }
  if (bytes > LIMITS.maxSnapshotBytes) {
    const mb = Math.round(bytes / 1048576), cap = Math.round(LIMITS.maxSnapshotBytes / 1048576);
    throw new Error(`工作区体积过大（${mb} MB > 上限 ${cap} MB），请把大文件移出工作区`);
  }
  return { files, mode, bytes, skipped };
}

/** 构建工作区 tar（未压缩，随后 zstd）文件内容 Buffer；超过限额抛错。 */
export function buildWorkspaceTar(cwd, fileList) {
  let total = 0;
  const stats = [];
  for (const rel of fileList) {
    try {
      const st = statSync(join(cwd, rel));
      total += st.size;
      stats.push({ rel, size: st.size });
    } catch { /* 忽略竞态消失的文件 */ }
  }
  if (stats.length > LIMITS.maxEntries) throw new Error(`文件数超限（${stats.length} > ${LIMITS.maxEntries}）`);
  if (total > LIMITS.maxSnapshotBytes) throw new Error(`工作区快照超限（${total} > ${LIMITS.maxSnapshotBytes} 字节）`);
  const listFile = join(cwd, ".dsh-handoff-files.tmp");
  writeFileSync(listFile, stats.map((s) => s.rel).join("\n") + "\n");
  const r = spawnSync("tar", ["-cf", "-", "-C", cwd, "-T", listFile], { maxBuffer: LIMITS.maxSnapshotBytes * 2 });
  try { spawnSync("rm", ["-f", listFile]); } catch {}
  if (r.status !== 0) throw new Error(`tar 失败（exit ${r.status}）：${String(r.stderr).trim()}`);
  return r.stdout;
}

/** 扫描文本内容里的疑似密钥（JSON/文本文件），命中返回首条命中的路径。 */
export function scanSecrets(files) {
  for (const [rel, text] of Object.entries(files)) {
    for (const re of SECRET_PATTERNS) {
      if (re.test(text)) return rel;
    }
  }
  return null;
}

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * 打包一个 handoff job 到 staging 目录。
 * @param {{cwd:string, sessionLogs:{id:string,path:string,role:"root"|"child"}[], memoryFiles:{rel:string,path:string}[],
 *          attachments:string[], title:string, taskSummary:string, agentPreset:string, sandboxMode:string,
 *          model:{provider:string,model:string}|null, localCwd:string, stagingDir:string}} input
 * @returns {{ jobId:string, manifest:object, dir:string }}
 */
export async function packBundle(input) {
  const jobId = input.jobId ?? randomUUID();
  const dir = join(input.stagingDir, jobId);
  mkdirSync(join(dir, "files", "sessions"), { recursive: true });
  mkdirSync(join(dir, "files", "attachments"), { recursive: true });
  mkdirSync(join(dir, "files", "memory"), { recursive: true });

  const manifest = {
    version: 1,
    jobId,
    sessionId: input.sessionLogs.find((s) => s.role === "root")?.id ?? null,
    title: input.title,
    createdAt: new Date().toISOString(),
    localCwd: input.localCwd,
    agentPreset: input.agentPreset ?? null,
    sandboxMode: input.sandboxMode ?? null,
    model: input.model,
    taskSummary: input.taskSummary,
    files: {},
    sessionLogs: [],
    limits: LIMITS,
  };

  // 任务简报（替代整段会话历史：日志动辄几十 MB，云端据此构造的请求必然超限）
  if (!input.brief?.text) throw new Error("缺少任务简报（本地未生成 brief）");
  const briefBuf = Buffer.from(input.brief.text, "utf8");
  writeFileSync(join(dir, "files", "brief.md"), briefBuf);
  manifest.brief = { path: "brief.md", bytes: briefBuf.length, sha256: sha256(briefBuf), stats: input.brief.stats ?? null };
  manifest.originSessionId = input.originSessionId ?? null;
  manifest.files["brief.md"] = { bytes: briefBuf.length, sha256: sha256(briefBuf) };
  manifest.sessionLogs = [];

  // 记忆文件
  for (const m of input.memoryFiles) {
    const buf = readFileSync(m.path);
    const rel = `memory/${m.rel}`;
    writeFileSync(join(dir, "files", rel), buf);
    manifest.files[rel] = { bytes: buf.length, sha256: sha256(buf) };
  }

  // 附件
  for (const a of input.attachments) {
    if (!existsSync(a)) continue;
    const buf = readFileSync(a);
    const rel = `attachments/${relative(input.cwd, a).replaceAll(sep, "/")}`;
    mkdirSync(join(dir, "files", rel, ".."), { recursive: true });
    writeFileSync(join(dir, "files", rel), buf);
    manifest.files[rel] = { bytes: buf.length, sha256: sha256(buf) };
  }

  // 工作区快照（优先用预检时扫好的清单，避免重复扫描）
  const scan = input.fileList
    ? { files: input.fileList, mode: input.listingMode ?? "provided", skipped: input.skipped ?? 0 }
    : scanWorkspace(input.cwd);
  const tarBuf = buildWorkspaceTar(input.cwd, scan.files);
  const zst = await zstdCompressAsync(tarBuf);
  const rel = "workspace.tar.zst";
  writeFileSync(join(dir, "files", rel), zst);
  manifest.files[rel] = { bytes: zst.length, sha256: sha256(zst), workspaceEntries: scan.files.length };
  manifest.listing = { mode: scan.mode, entries: scan.files.length, skipped: scan.skipped ?? 0 };

  manifest.totalBytes = Object.values(manifest.files).reduce((a, f) => a + f.bytes, 0);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { jobId, manifest, dir };
}

/** 云端/本地通用：校验 bundle 完整性（sha256 逐文件比对）。 */
export function verifyBundle(dir, manifest) {
  const errors = [];
  for (const [rel, meta] of Object.entries(manifest.files ?? {})) {
    const p = join(dir, "files", rel);
    if (!existsSync(p)) { errors.push(`${rel} 缺失`); continue; }
    const buf = readFileSync(p);
    if (buf.length !== meta.bytes) errors.push(`${rel} 大小不符`);
    else if (sha256(buf) !== meta.sha256) errors.push(`${rel} sha256 不符`);
  }
  return { ok: errors.length === 0, errors };
}
