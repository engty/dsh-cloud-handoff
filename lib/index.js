/**
 * dsh-cloud-handoff — 宿主插件（本地 + 云端双角色，同一 bundle）
 *
 * 本地（role=local）：
 *   工具 dsh_cloud_status/send/pull/abort；RPC /config /state /send /pull /abort /test-connection /config.set
 *   启动钩子：有活跃云端任务时自动拉回结果（会话未打开，安全追加日志帧）
 * 云端（role=cloud，headless）：
 *   RPC /ping /receive /status /finish /abort（token 鉴权，仅回环，经 SSH curl 调用）
 *   工具 dsh_cloud_finish（agent 完成时调用，产出 return bundle）
 *
 * 已实测验证的机制见 docs/DESIGN.md。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompress, zstdDecompress, constants } from "node:zlib";
import { promisify } from "node:util";
import { spawnSync } from "node:child_process";
import {
  buildSessionLog, decompressSessionLog, encodeWorkspacePath, rewriteSessionCwd, scanZstdFrames,
} from "./import.mjs";
import { packBundle, verifyBundle, sha256, LIMITS, scanWorkspace } from "./handoff.mjs";
import { buildTaskBrief } from "./brief.mjs";
import { JobStore, CloudJobs, stateLabel, OpLog } from "./jobs.mjs";
import { cloudRpc, rsyncPull, rsyncPush, sshExec } from "./remote.mjs";

const zstdCompressAsync = promisify(zstdCompress);
const zstdDecompressAsync = promisify(zstdDecompress);
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

const name = "dsh-cloud-handoff";
const inject = ["tools"];

const HOME = homedir();
const CONFIG_DIR = join(HOME, ".dsh", name);
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const WORK_DIR = join(HOME, ".dsh", name, "work");
const LOCAL_JOBS_FILE = join(CONFIG_DIR, "jobs.json");

const DEFAULTS = {
  role: "local",           // local | cloud
  host: "",                // 云端主机（SSH 别名或地址）
  sshUser: "dshcloud",
  sshPort: 0,              // 0 = 默认 22
  sshKey: "",              // 留空 = 默认 ~/.ssh/id_ed25519
  remoteBase: "/srv/dsh-cloud",
  remotePort: 39127,
  cloudCwdRoot: "/srv/dsh-cloud/workspaces",
  token: "",               // 云端 receive 鉴权 token（云端自动生成；本地需配置同一值）
  pauseTimeoutMs: 30_000,  // 等待当前轮停稳的最长时间
  autoPull: true,
  retentionDays: 7,        // 云端终态任务保留天数
  cloudProvider: "deepseek-official",  // 云端只能用 API Key 通道（无头机器没有登录态）
  cloudModel: "deepseek-v4-pro",       // 云端使用的模型（官方 API 提供 deepseek-v4-pro / deepseek-flash）
  briefBudgetBytes: 300 * 1024,        // 交接简报上限（实测云端硬限制是 1M tokens 上下文，300KB 约占 5~7%），过期自动清扫（ack/丢弃后立即清除）
};

function readConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) return {};
    const p = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}
function writeConfig(patch) {
  const merged = { ...DEFAULTS, ...readConfig(), ...patch };
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  return merged;
}
/** 回显给浏览器/工具的配置视图：token 永不回显。 */
function publicConfig() {
  const c = { ...DEFAULTS, ...readConfig() };
  return { ...c, token: undefined, tokenConfigured: Boolean(c.token) };
}

const T = (v) => [{ type: "text", text: v }];
function respond(res, status, body) {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}
function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolvePromise, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) { reject(new Error("request body too large")); req.destroy(); }
    });
    req.on("end", () => resolvePromise(data));
    req.on("error", reject);
  });
}

function resolveDshHome() {
  return resolve(process.env.DSH_HOME || join(HOME, ".dsh"));
}

function findSessionLog(dshHome, sessionId) {
  const root = join(dshHome, "sessions");
  if (!existsSync(root)) return null;
  const walk = (dir, depth) => {
    if (depth > 3) return null;
    const r = spawnSync("find", [dir, "-maxdepth", "1", "-mindepth", "1"], { encoding: "utf8" });
    if (r.status !== 0) return null;
    for (const entry of r.stdout.split("\n").filter(Boolean)) {
      const target = join(entry, "session.v4.jsonl.zstd");
      if (existsSync(target)) {
        if (basename(entry) === sessionId) return target;
      } else {
        const hit = walk(entry, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(root, 0);
}

async function readSessionHeader(logPath) {
  const text = await decompressSessionLog(readFileSync(logPath));
  return JSON.parse(text.split("\n")[0]);
}

async function findChildLogs(dshHome, rootId) {
  const out = [];
  const root = join(dshHome, "sessions");
  if (!existsSync(root)) return out;
  const r = spawnSync("find", [root, "-name", "session.v4.jsonl.zstd"], { encoding: "utf8" });
  if (r.status !== 0) return out;
  for (const p of r.stdout.split("\n").filter(Boolean)) {
    try {
      // 不依赖 zstd 二进制：用 node:zlib 逐帧解压（跨平台）
      const text = await decompressSessionLog(readFileSync(p));
      const head = JSON.parse(text.split("\n")[0]);
      if (head.parentSession === rootId) out.push({ id: head.id, path: p });
    } catch { /* 跳过异常日志 */ }
  }
  return out.slice(0, LIMITS.maxChildSessions);
}

function memoryFileCandidates(dshHome) {
  const homes = [
    dshHome,
    join(HOME, ".dsh"),
    join(HOME, "Library", "Application Support", "com.harness.desktop.launcher", "data", "active", "dsh-home"),
  ];
  const out = [];
  for (const h of homes) {
    for (const f of ["MEMORY.md", "USER.md"]) {
      const p = join(h, "mnemon", "runtime", f);
      if (existsSync(p) && !out.some((m) => m.rel === f)) out.push({ rel: f, path: p });
    }
  }
  return out;
}

/** 目录内文件清单（相对路径 + sha256），用于云端基线与回传 diff。 */
function walkFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  const r = spawnSync("find", [dir, "-type", "f"], { encoding: "utf8" });
  if (r.status !== 0) return out;
  for (const p of r.stdout.split("\n").filter(Boolean)) {
    const rel = p.slice(dir.length + 1);
    if (rel.startsWith(".dsh-handoff") || rel.includes("/.git/")) continue;
    try {
      const buf = readFileSync(p);
      out.push({ rel, sha: sha256(buf), bytes: buf.length });
    } catch { /* 竞态消失 */ }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** 解包 zstd tar 到目录（优先 tar --zstd，失败退化为手动解压）。 */
async function extractZstTar(tarPath, dest) {
  mkdirSync(dest, { recursive: true });
  const r = spawnSync("tar", ["--zstd", "-xf", tarPath, "-C", dest], { stdio: "pipe" });
  if (r.status === 0) return null;
  const raw = await zstdDecompressAsync(readFileSync(tarPath));
  const tmpTar = join(dirname(dest), `.workspace.tmp.${basename(dest)}.tar`);
  writeFileSync(tmpTar, raw);
  const r2 = spawnSync("tar", ["-xf", tmpTar, "-C", dest], { stdio: "pipe" });
  rmSync(tmpTar, { force: true });
  if (r2.status !== 0) return new Error(`工作区解包失败: ${String(r2.stderr).trim()}`);
  return null;
}

function apply(ctx, config = {}) {
  const schemaDefaults = { ...DEFAULTS, ...config };
  const effective = () => ({ ...schemaDefaults, ...readConfig() });
  const cfg = effective();
  const role = cfg.role === "cloud" ? "cloud" : "local";
  const dshHome = resolveDshHome();
  const disposers = [];
  const ROUTE_PREFIX = "/_dsh/dsh-cloud-handoff";

  /** 注入的宿主服务（sessionController/sessions/…），工具与 RPC 共用。 */
  let services = null;

  const ensureToken = () => {
    const c = readConfig();
    if (c.token) return c.token;
    const token = randomUUID() + randomUUID();
    writeConfig({ token });
    return token;
  };

  // ================= 云端角色 =================
  if (role === "cloud") {
    const token = ensureToken();
    const cloudJobs = new CloudJobs(cfg.remoteBase);
    const incomingDir = join(cfg.remoteBase, "staging", "incoming");
    const outgoingDir = join(cfg.remoteBase, "staging", "outgoing");
    const workspaceRoot = cfg.cloudCwdRoot;
    const jobFor = (jobId) => cloudJobs.get(jobId);

    /**
     * 构建回传 bundle（finish 与 abort 共用）：
     * 真实工作区 diff（changed/deleted 对比迁移基线）+ 基线内容（三路合并用）
     * + 会话新增事件尾部帧 + receipt。
     * finalState: "DONE" | "ABORTED"
     */
    const buildReturnBundle = async (job, jobId, summary, finalState) => {
      const now = walkFiles(job.cloudCwd);
      const baseline = job.baseline ?? {};
      const nowMap = {};
      for (const f of now) nowMap[f.rel] = f.sha;
      const changed = now.filter((f) => baseline[f.rel] !== f.sha);
      const deleted = Object.keys(baseline).filter((rel) => nowMap[rel] === undefined);

      const outDir = join(outgoingDir, jobId);
      mkdirSync(outDir, { recursive: true });

      if (changed.length > 0) {
        const listFile = join(outDir, ".files.tmp");
        writeFileSync(listFile, changed.map((f) => f.rel).join("\n") + "\n");
        const tar = spawnSync("tar", ["-cf", "-", "-C", job.cloudCwd, "-T", listFile], { maxBuffer: LIMITS.maxSnapshotBytes * 2 });
        rmSync(listFile, { force: true });
        if (tar.status !== 0) throw new Error(`tar 失败: ${String(tar.stderr).trim()}`);
        writeFileSync(join(outDir, "workspace-diff.tar.zst"), await zstdCompressAsync(tar.stdout));
      }

      // 基线内容（三路合并的 base）：从迁移时的原始 tar 解出被改文件的原始版本
      const baseFiles = [];
      if (changed.length > 0) {
        const baseSrc = join(outDir, ".base-src");
        const extractErr = await extractZstTar(join(incomingDir, jobId, "files", "workspace.tar.zst"), baseSrc);
        if (extractErr) {
          console.warn(`[${name}] 基线解包失败（base 留空，三路合并将退化为双保留）: ${String(extractErr?.message ?? extractErr)}`);
        } else {
          const present = changed.filter((f) => existsSync(join(baseSrc, f.rel)));
          if (present.length > 0) {
            const listFile = join(outDir, ".base.tmp");
            writeFileSync(listFile, present.map((f) => f.rel).join("\n") + "\n");
            const baseTar = spawnSync("tar", ["-cf", "-", "-C", baseSrc, "-T", listFile], { maxBuffer: LIMITS.maxSnapshotBytes * 2 });
            rmSync(listFile, { force: true });
            if (baseTar.status === 0) {
              writeFileSync(join(outDir, "base.tar.zst"), await zstdCompressAsync(baseTar.stdout));
              baseFiles.push(...present.map((f) => f.rel));
            }
          }
        }
        rmSync(baseSrc, { recursive: true, force: true });
      }

      // 会话新增事件（seq > 基线）→ 单帧 zstd（带校验和）
      let tailEvents = 0;
      const logPath = findSessionLog(dshHome, job.sessionId);
      if (logPath && existsSync(logPath)) {
        const text = await decompressSessionLog(readFileSync(logPath));
        const tail = text.split("\n").filter((line) => {
          try {
            const o = JSON.parse(line);
            return typeof o.seq === "number" && o.seq > (job.baselineThroughSeq ?? -1);
          } catch { return false; }
        });
        tailEvents = tail.length;
        if (tail.length > 0) {
          const frame = await zstdCompressAsync(tail.join("\n") + "\n", CHECKSUM_OPTIONS);
          writeFileSync(join(outDir, "session-tail.v4.jsonl.zstd"), frame);
        }
      }

      writeFileSync(join(outDir, "deleted.json"), JSON.stringify(deleted, null, 2) + "\n");
      const receipt = {
        version: 2, jobId, sessionId: job.sessionId, summary: String(summary ?? ""),
        startedAt: job.createdAt ?? null,
        finishedAt: new Date().toISOString(),
        cloudCwd: job.cloudCwd,
        changed: changed.map((f) => f.rel),
        deleted,
        baseFiles,
        baseline,
        finalState,
        tailEvents,
        listing: job.manifest?.listing ?? null,
      };
      writeFileSync(join(outDir, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
      cloudJobs.patch(jobId, { state: finalState, receipt, finishedAt: receipt.finishedAt });
      return { ok: true, changed: changed.length, deleted: deleted.length, tailEvents, baseFiles: baseFiles.length };
    };

    /** 读取会话日志最后一条事件（判断云端回合是否已结束）。 */
    const lastSessionEvent = async (sessionId) => {
      const logPath = findSessionLog(dshHome, sessionId);
      if (!logPath || !existsSync(logPath)) return null;
      try {
        const st = statSync(logPath);
        const text = await decompressSessionLog(readFileSync(logPath));
        const lines = text.split("\n").filter(Boolean);
        const last = JSON.parse(lines[lines.length - 1]);
        return { type: last.type, seq: last.seq, data: last.data ?? {}, mtimeMs: st.mtimeMs };
      } catch { return null; }
    };

    /**
     * 收敛「卡死的 RUNNING」：云端回合已结束（日志静默 ≥90s 且最后事件是 turn/end）
     * 但 agent 没来得及调用 dsh_cloud_finish 时，自动打包回传并置为 STOPPED。
     * 否则本地会永远显示「云端仍在执行」，结果永远取不回来（2026-10-08 实测踩到）。
     */
    const reconcileJob = async (job) => {
      if (!job || job.state !== "RUNNING") return false;
      const last = await lastSessionEvent(job.sessionId);
      if (!last || !last.mtimeMs) return false;
      if (Date.now() - last.mtimeMs < 90_000) return false;   // 回合可能仍在进行
      if (last.type !== "turn/end") return false;             // 回合尚未结束
      const reason = last.data?.reason ?? {};
      const kind = String(reason.kind ?? "unknown");
      const detail = kind === "error"
        ? `云端回合异常结束：${String(reason.error?.message ?? "未知错误").slice(0, 200)}`
        : "云端回合已结束，但未报告完成（可能中途停止）";
      try {
        await buildReturnBundle(job, job.jobId, `（${detail}）`, "STOPPED");
      } catch (error) {
        console.warn(`[${name}] 卡死收敛打包失败: ${String(error?.message ?? error)}`);
        cloudJobs.patch(job.jobId, { state: "STOPPED", finishedAt: new Date().toISOString() });
      }
      cloudJobs.patch(job.jobId, { stopReason: detail, stopKind: kind });
      console.log(`[${name}] 卡死收敛：任务 ${job.jobId.slice(0, 8)} → STOPPED（${detail}）`);
      return true;
    };

    /**
     * 云端：为迁移任务新建一个干净会话，只下发「任务简报」（不再导入整段会话历史）。
     * 简报由本地提炼：主任务背景 + 依赖与注意事项 + 云端环境事实 + 交给云端的子任务。
     */
    const startCloudTask = async (svc, jobId, manifest) => {
      const cloudCwd = join(workspaceRoot, jobId);
      mkdirSync(cloudCwd, { recursive: true });

      // 1) 工作区还原 + 基线（回传 diff 的对照）
      const err = await extractZstTar(join(incomingDir, jobId, "files", "workspace.tar.zst"), cloudCwd);
      if (err) throw err;
      const baselineMap = {};
      for (const f of walkFiles(cloudCwd)) baselineMap[f.rel] = f.sha;

      // 2) 记忆文件 → 云端 mnemon 目录
      for (const rel of Object.keys(manifest.files ?? {})) {
        if (!rel.startsWith("memory/")) continue;
        const dest = join(dshHome, "mnemon", "runtime", rel.slice("memory/".length));
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, readFileSync(join(incomingDir, jobId, "files", rel)));
      }

      // 3) 任务简报（必须存在）
      const briefPath = join(incomingDir, jobId, "files", "brief.md");
      if (!existsSync(briefPath)) throw new Error("bundle 缺少 brief.md（本地未生成任务简报）");
      const brief = readFileSync(briefPath, "utf8");

      // 4) 新建云端会话（干净上下文）
      const created = await svc.sessionController.create({
        cwd: cloudCwd,
        ...(manifest.agentPreset ? { agentPreset: manifest.agentPreset } : {}),
      });
      const cloudSessionId = created?.sessionId;
      if (!cloudSessionId) throw new Error("云端会话创建失败");

      // 5) 固定走 API Key 通道（云端无登录态）
      const provider = String(effective().cloudProvider || "deepseek-official");
      const model = String(effective().cloudModel || "deepseek-v4-pro");
      try {
        await svc.sessionController.selectModel({ sessionId: cloudSessionId, provider, model });
        console.log(`[${name}] 云端模型固定为 ${provider}/${model}`);
      } catch (error) {
        console.warn(`[${name}] selectModel 失败（沿用云端默认）: ${String(error?.message ?? error)}`);
      }

      // 6) 下发简报 + 执行要求
      const instruction = [
        `[云端接力] 你在云端继续一个**从本地迁移过来的分支任务**（本地主任务已暂停）。`,
        `工作区：当前目录 ${cloudCwd}`,
        ``,
        `要求：`,
        `1. 先调用 create_goal 建立目标「完成云端分支任务 ${jobId.slice(0, 8)}」，保证跨轮次自动延续；`,
        `2. 按简报里的"子任务"推进；简报里的"依赖与注意事项""云端环境事实"必须遵守；`,
        `3. 只做这个分支任务范围内的改动，不要顺手重构无关代码；`,
        `4. 完成后**必须**调用工具 dsh_cloud_finish：jobId="${jobId}"，summary 用一句话总结结果并列出关键产出文件路径；`,
        `5. 中途受阻（缺信息/依赖不可用）也要调用 dsh_cloud_finish 说明卡点，不要静默停止。`,
        ``,
        `================ 任务简报 ================`,
        brief.slice(0, 60_000),
        `================ 简报结束 ================`,
      ].join("\n");

      const resolved = await svc.sessionController.resolveAgent(cloudSessionId);
      if (!resolved || "error" in resolved) throw new Error(`云端会话不可用: ${JSON.stringify(resolved?.error ?? resolved).slice(0, 200)}`);
      resolved.agent.followup({
        id: "msg_" + randomUUID(),
        role: "user",
        content: [{ type: "text", text: instruction }],
        source: { kind: "user", rpcId: randomUUID() },
      });
      await svc.sessions.flush(resolved.agent.session);

      cloudJobs.patch(jobId, {
        state: "RUNNING",
        sessionId: cloudSessionId,
        originSessionId: manifest.originSessionId ?? null,
        baseline: baselineMap,
        baselineThroughSeq: -1,      // 全新会话：所有事件都算云端新增
        cloudCwd,
        startedAt: new Date().toISOString(),
        briefBytes: Buffer.byteLength(brief),
      }, { force: true });
      console.log(`[${name}] 云端任务已启动：会话 ${cloudSessionId.slice(0, 12)}（简报 ${(Buffer.byteLength(brief) / 1024).toFixed(1)} KB）`);
      return { ok: true, phase: "running", sessionId: cloudSessionId };
    };

    /** 云端：导入会话（重写 cwd）并触发根会话续跑。 */
    const importAndContinue = async (svc, jobId, manifest) => {
      const cloudCwd = join(workspaceRoot, jobId);
      const rootLog = manifest.sessionLogs.find((s) => s.role === "root");
      if (!rootLog) throw new Error("manifest 缺少根会话");

      // 0) 活体检测：同一会话 id 若有云端活体实例，删除目录会撕裂其写句柄。
      //    必须先重启云端进程再导入（本地 receive 重试协议会处理）。
      let liveSession;
      try { liveSession = svc.sessions.get(rootLog.id); } catch { liveSession = undefined; }
      if (liveSession !== undefined) {
        return { ok: false, code: "SESSION_LIVE", error: `会话 ${rootLog.id} 在云端仍有活体实例，需先重启云端服务` };
      }

      // 1) 工作区还原
      const err = await extractZstTar(join(incomingDir, jobId, "files", "workspace.tar.zst"), cloudCwd);
      if (err) throw err;

      // 2) 基线（回传 diff 的对照）
      const baseline = walkFiles(cloudCwd);
      const baselineMap = {};
      for (const f of baseline) baselineMap[f.rel] = f.sha;

      // 3) 记忆文件 → 云端 mnemon 目录
      for (const [rel] of Object.entries(manifest.files)) {
        if (!rel.startsWith("memory/")) continue;
        const dest = join(dshHome, "mnemon", "runtime", rel.slice("memory/".length));
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, readFileSync(join(incomingDir, jobId, "files", rel)));
      }

      // 4) 会话日志导入（cwd 重写）；先移除同 id 的旧目录（DSH 要求会话 id 全局唯一）
      let baselineThroughSeq = -1;
      for (const s of manifest.sessionLogs) {
        const src = join(incomingDir, jobId, "files", s.path);
        const oldDirs = spawnSync("find", [join(dshHome, "sessions"), "-mindepth", "2", "-maxdepth", "2", "-name", s.id, "-type", "d"], { encoding: "utf8" });
        if (oldDirs.status === 0) {
          for (const old of oldDirs.stdout.split("\n").filter(Boolean)) rmSync(old, { recursive: true, force: true });
        }
        const destDir = join(dshHome, "sessions", encodeWorkspacePath(cloudCwd), s.id);
        const dest = join(destDir, "session.v4.jsonl.zstd");
        const providerRewrite = await rewriteSessionCwd(src, cloudCwd, dest, {
          modelProvider: effective().cloudProvider || "deepseek-official",
        });
        if (providerRewrite.modelRewrites > 0) {
          console.log(`[${name}] 已把 ${providerRewrite.modelRewrites} 处 model/selection 改写为 ${effective().cloudProvider || "deepseek-official"}（云端无登录态，必须走 API Key）`);
        }
        if (s.role === "root") {
          const text = await decompressSessionLog(readFileSync(dest));
          for (const line of text.split("\n").filter(Boolean)) {
            try {
              const o = JSON.parse(line);
              if (typeof o.seq === "number" && o.seq > baselineThroughSeq) baselineThroughSeq = o.seq;
            } catch { /* 非事件行 */ }
          }
        }
      }

      cloudJobs.patch(jobId, {
        state: "RUNNING",
        sessionId: rootLog.id,
        cloudCwd,
        baseline: baselineMap,
        baselineThroughSeq,
        lastEventAt: new Date().toISOString(),
      }, { force: true });

      // 5) 续跑（根会话）
      const instruction = [
        `[云端接力] 你的任务已从本地迁移到这台云端机器继续执行（本地已暂停）。`,
        manifest.taskSummary ? `原任务说明：${manifest.taskSummary}` : `（未提供任务说明，请先回顾上文，复述你正在进行的任务目标，再继续执行。）`,
        `执行要求：`,
        `1. 首先调用 create_goal 建立目标「继续完成：${(manifest.title || "迁移任务").slice(0, 80)}（云端接力 ${jobId.slice(0, 8)}）」，保证执行可以跨轮次自动延续。`,
        `2. 继续完成该任务，直到你认为已全部完成。`,
        `3. 全部完成后，调用工具 dsh_cloud_finish，参数 jobId = "${jobId}"，summary 用一句话总结最终结果（列出关键产出文件的路径）。`,
      ].join("\n");

      const resolved = await svc.sessionController.resolveAgent(rootLog.id);
      if ("error" in resolved) throw new Error(`会话加载失败: ${String(resolved.error?.message ?? resolved.error)}`);
      const message = {
        id: "msg_" + randomUUID(),
        role: "user",
        content: [{ type: "text", text: instruction }],
        source: { kind: "user", rpcId: randomUUID() },
      };
      resolved.agent.followup(message);
      await svc.sessions.flush(resolved.agent.session);
      return { ok: true, phase: "running", sessionId: rootLog.id };
    };

    // ---- 云端工具：dsh_cloud_finish ----
    disposers.push(ctx.tools.register(defineTool({
      name: "dsh_cloud_finish",
      description: "云端接力任务全部完成后调用：把结果（工作区变更 + 会话新增历史）打包成回传 bundle，供本地自动拉取。参数 jobId 来自续跑指令。",
      parameters: {
        jobId: { type: "string", description: "云端接力 jobId（见续跑指令）" },
        summary: { type: "string", description: "一句话总结最终结果，列出关键产出文件路径" },
      },
      output: { schema: { type: "json" }, render: (_a, v) => T(v.text) },
      isConcurrencySafe: () => false,
      async execute(args) {
        const jobId = String(args?.jobId ?? "");
        const job = jobFor(jobId);
        if (!job) return { ok: false, text: `未找到云端任务 ${jobId}` };
        if (job.state === "DONE") return { ok: true, text: "该任务已标记完成（幂等）" };
        if (job.state === "ABORTED") return { ok: true, text: "该任务已被本地中止，不再接受完成标记" };
        try {
          const r = await buildReturnBundle(job, jobId, args?.summary, "DONE");
          return { ok: true, text: `已打包回传：${r.changed} 个变更文件、${r.deleted} 个删除。` };
        } catch (error) {
          return { ok: false, text: `打包失败: ${String(error?.stack ?? error).slice(0, 2000)}` };
        }
      },
    })));

    // ---- 云端清理：确认(ack)/丢弃后或超保留期，删除该 job 的全部云端产物 ----
    const purgeJob = (jobId) => {
      const job = jobFor(jobId);
      const removed = [];
      for (const base of [join(workspaceRoot, jobId), join(incomingDir, jobId), join(outgoingDir, jobId)]) {
        try { rmSync(base, { recursive: true, force: true }); removed.push(base); } catch { /* 忽略 */ }
      }
      if (job?.sessionId) {
        const r = spawnSync("find", [join(dshHome, "sessions"), "-mindepth", "2", "-maxdepth", "2", "-name", job.sessionId, "-type", "d"], { encoding: "utf8" });
        if (r.status === 0) {
          for (const dir of r.stdout.split("\n").filter(Boolean)) {
            try { rmSync(dir, { recursive: true, force: true }); removed.push(dir); } catch { /* 忽略 */ }
          }
        }
      }
      try { rmSync(cloudJobs.file(jobId), { force: true }); removed.push(cloudJobs.file(jobId)); } catch { /* 忽略 */ }
      return removed;
    };

    /** 保留期清扫：终态（DONE/ABORTED/FAILED）超过 retentionDays 的 job 全部清除。 */
    const sweepExpired = () => {
      const retentionMs = (Number(effective().retentionDays) || 7) * 24 * 3600 * 1000;
      const now = Date.now();
      let purged = 0;
      try {
        for (const f of readdirSync(cloudJobs.dir)) {
          if (!f.endsWith(".json")) continue;
          const job = cloudJobs.get(f.slice(0, -5));
          if (!job) continue;
          const terminal = job.state === "DONE" || job.state === "ABORTED" || job.state === "FAILED";
          if (!terminal) continue;
          const t = Date.parse(job.finishedAt || job.updatedAt || job.createdAt);
          if (!Number.isFinite(t) || now - t < retentionMs) continue;
          purgeJob(job.jobId);
          purged += 1;
        }
      } catch (error) {
        console.warn(`[${name}] 云端保留期清扫异常: ${String(error?.message ?? error)}`);
      }
      if (purged > 0) console.log(`[${name}] 云端保留期清扫：清除 ${purged} 个过期任务`);
    };

    // ---- 云端 RPC ----
    const CLOUD_ROUTES = {
      ping: async () => ({ ok: true, role: "cloud", name }),
      receive: async (args, svc) => {
        const jobId = String(args?.jobId ?? "");
        if (!/^[0-9a-f-]{20,64}$/i.test(jobId)) return { ok: false, error: "jobId 非法" };
        if (args?.token !== token) return { ok: false, error: "token 不符", code: 401 };
        const dir = join(incomingDir, jobId);
        if (!existsSync(join(dir, "manifest.json"))) return { ok: false, error: `云端未收到 bundle（${jobId}）` };
        try {
          const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
          const check = verifyBundle(dir, manifest);
          if (!check.ok) return { ok: false, error: `bundle 校验失败: ${check.errors.join("; ")}` };
          const job = jobFor(jobId);
          if (job?.state === "RUNNING" || job?.state === "DONE" || job?.state === "ABORTED") {
            return { ok: true, phase: job.state === "DONE" ? "done" : job.state === "ABORTED" ? "aborted" : "running", replay: true };
          }
          cloudJobs.patch(jobId, { state: "PENDING", manifest });
          return await startCloudTask(svc, jobId, manifest);
        } catch (error) {
          return { ok: false, error: String(error?.stack ?? error).slice(0, 3000) };
        }
      },
      status: async (args) => {
        // 惰性收敛：RUNNING 但云端回合其实已结束的任务（避免永久卡在「云端仍在执行」）
        const j0 = jobFor(String(args?.jobId ?? ""));
        if (j0 && j0.state === "RUNNING") {
          try { await reconcileJob(j0); } catch { /* 收敛失败不阻塞状态查询 */ }
        }
        const job = jobFor(String(args?.jobId ?? ""));
        if (!job) return { ok: true, found: false };
        let progress = null;
        const logPath = job.sessionId ? findSessionLog(dshHome, job.sessionId) : null;
        if (logPath && existsSync(logPath)) {
          try {
            const text = await decompressSessionLog(readFileSync(logPath));
            progress = { events: text.split("\n").filter(Boolean).length };
          } catch { /* 读取中 */ }
        }
        return {
          ok: true, found: true, state: job.state, stateLabel: stateLabel(job.state),
          job: { jobId: job.jobId, sessionId: job.sessionId, lastEventAt: job.lastEventAt, finishedAt: job.finishedAt, summary: job.receipt?.summary },
          progress,
        };
      },
      abort: async (args, svc) => {
        const jobId = String(args?.jobId ?? "");
        if (args?.token !== token) return { ok: false, error: "token 不符", code: 401 };
        const job = jobFor(jobId);
        if (!job) return { ok: false, error: "job 不存在" };
        if (job.state === "ABORTED" || job.state === "DONE") return { ok: true, replay: true, changed: 0, deleted: 0, tailEvents: 0 };
        try {
          if (job.sessionId) await svc.sessionController.cancel({ sessionId: job.sessionId }).catch(() => {});
        } catch { /* cancel 失败不阻塞 */ }
        try {
          const r = await buildReturnBundle(job, jobId, "（本地中止）", "ABORTED");
          return { ok: true, ...r };
        } catch (error) {
          console.warn(`[${name}] 中止打包失败（状态仍置 ABORTED，回收时重试）: ${String(error?.stack ?? error)}`);
          cloudJobs.patch(jobId, { state: "ABORTED", finishedAt: new Date().toISOString() });
          return { ok: true, changed: 0, deleted: 0, tailEvents: 0, degraded: true };
        }
      },
      ack: async (args) => {
        const jobId = String(args?.jobId ?? "");
        if (args?.token !== token) return { ok: false, error: "token 不符", code: 401 };
        if (!jobFor(jobId)) return { ok: false, error: "job 不存在" };
        const removed = purgeJob(jobId);
        return { ok: true, removed: removed.length };
      },
    };

    ctx.inject(["connection", "webServer", "sessionController", "sessions"], (webCtx) => {
      services = webCtx;
      webCtx.effect(() => {
        const dispose = webCtx.webServer.register({
          kind: "prefix",
          path: ROUTE_PREFIX,
          handler: async (req, res) => {
            try {
              const url = new URL(req.url || "/", "http://localhost");
              if (!url.pathname.startsWith(ROUTE_PREFIX + "/")) { respond(res, 404, { error: "not found" }); return; }
              const method = decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length + 1));
              const fn = Object.hasOwn(CLOUD_ROUTES, method) ? CLOUD_ROUTES[method] : null;
              if (typeof fn !== "function") { respond(res, 404, { error: "unknown method: " + method }); return; }
              let args = {};
              if (req.method === "POST" || req.method === "PUT") {
                const raw = await readBody(req);
                if (raw.length > 0) { try { args = JSON.parse(raw); } catch { respond(res, 400, { error: "invalid JSON body" }); return; } }
              }
              respond(res, 200, await fn(args, webCtx));
            } catch (error) {
              console.warn(`[${name}] 云端 RPC 失败: ${String(error?.stack ?? error)}`);
              respond(res, 500, { error: String(error?.message ?? error) });
            }
          },
        });
        return () => dispose();
      });
    });

    // 云端卡死收敛：每 60 秒检查 RUNNING 任务是否其实已结束
    {
      const t0 = setInterval(() => {
        (async () => {
          try {
            let checked = 0, reconciled = 0;
            for (const f of readdirSync(cloudJobs.dir)) {
              if (!f.endsWith(".json")) continue;
              const job = cloudJobs.get(f.slice(0, -5));
              if (job?.state !== "RUNNING") continue;
              checked += 1;
              if (await reconcileJob(job)) reconciled += 1;
            }
            if (checked > 0) console.log(`[${name}] 收敛扫描：检查 ${checked} 个运行中任务，收敛 ${reconciled} 个`);
          } catch (error) {
            console.warn(`[${name}] 收敛扫描异常: ${String(error?.stack ?? error).slice(0, 500)}`);
          }
        })();
      }, 60_000);
      disposers.push(() => clearInterval(t0));
    }

    // 云端保留期清扫：启动 30 秒后一次，此后每 12 小时一次
    {
      const t1 = setTimeout(() => { try { sweepExpired(); } catch {} }, 30_000);
      const t2 = setInterval(() => { try { sweepExpired(); } catch {} }, 12 * 3600 * 1000);
      disposers.push(() => { clearTimeout(t1); clearInterval(t2); });
    }

  }

  // ================= 本地角色 =================
  if (role === "local") {
    const jobs = new JobStore(LOCAL_JOBS_FILE);
  const ops = new OpLog(join(CONFIG_DIR, "operations.json"));
    const localStaging = join(WORK_DIR, "staging");

  /** 记录每一次用户操作（本地日志 + 任务历史），便于事后追溯。 */
  const recordOp = (action, detail = {}) => {
    const entry = ops.add({ action, ...detail });
    const jobId = detail.jobId ?? jobs.active;
    if (jobId) {
      const job = jobs.get(jobId);
      if (job) {
        const history = Array.isArray(job.history) ? job.history.slice(-49) : [];
        history.push({ at: entry.at, action, note: detail.note ?? "" });
        jobs.patch(jobId, { history });
      }
    }
    return entry;
  };
    const localPulled = join(WORK_DIR, "pulled");
    const lastOp = { ref: null };

    const sshCfg = () => ({
      host: effective().host || "dsh-cloud",
      sshUser: effective().sshUser || "dshcloud",
      sshPort: effective().sshPort || 0,
      sshKey: effective().sshKey || "",
      remotePort: effective().remotePort || 39127,
      remoteBase: effective().remoteBase || "/srv/dsh-cloud",
    });

    const waitForSettle = async (logPath, timeoutMs) => {
      const start = Date.now();
      let lastLen = 0;
      try { lastLen = readFileSync(logPath).length; } catch {}
      while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 2000));
        let len = 0;
        try { len = readFileSync(logPath).length; } catch {}
        if (len === lastLen) return true;
        lastLen = len;
      }
      return false;
    };

    const doSend = async (args) => {
      const sessionId = String(args?.sessionId ?? "");
      if (!sessionId) return { ok: false, summary: "缺少 sessionId", text: "缺少 sessionId（请从会话界面发起）" };
      const c = sshCfg();
      const logPath = findSessionLog(dshHome, sessionId);
      if (!logPath) return { ok: false, summary: "找不到会话日志", text: `找不到会话 ${sessionId} 的日志` };

      const active = jobs.activeJob;
      if (active && (active.state === "FROZEN" || active.state === "REMOTE_RUNNING")) {
        return { ok: false, summary: "已有任务在云端执行", text: `已有任务「${active.title || active.jobId.slice(0, 8)}」在云端执行，完成并同步后再发起新的迁移` };
      }

      const header = await readSessionHeader(logPath);
      const jobId = randomUUID();

      // 0) 预检：先确认工作区可打包（含非 git 目录兜底），失败时不打断当前轮
      let scan;
      try {
        scan = scanWorkspace(header.cwd);
      } catch (error) {
        const msg = String(error?.message ?? error);
        return {
          ok: false,
          summary: "工作区无法打包，任务未被打断",
          text: `${msg}\n（本次未结束当前轮；工作区不需要 git 仓库，但需要把超大文件/缓存排除或移出）`,
        };
      }

      // 1) 结束当前轮并等日志停稳（若该会话在跑）
      try { await services?.sessionController.cancel({ sessionId }).catch(() => {}); } catch { /* 无运行中回合 */ }
      const settled = await waitForSettle(logPath, effective().pauseTimeoutMs || 30_000);

      // 2) 打包：先把"与任务相关的上下文"提炼成简报（不发整段会话历史）
      const memoryFiles = memoryFileCandidates(dshHome);
      const brief = await buildTaskBrief(logPath, {
        taskSummary: String(args?.taskSummary ?? ""),
        title: String(header.title ?? ""),
        cwd: header.cwd,
        extraBrief: String(args?.briefOverride ?? "").slice(0, 120_000),
        budgetBytes: Number(effective().briefBudgetBytes) || undefined,
      });
      console.log(`[${name}] 任务简报已生成：${(brief.bytes / 1024).toFixed(1)} KB（源日志 ${(brief.stats.sourceBytes / 1048576).toFixed(1)} MB）`);
      const { manifest } = await packBundle({
        jobId,
        cwd: header.cwd,
        fileList: scan.files,
        listingMode: scan.mode,
        skipped: scan.skipped,
        brief,
        originSessionId: sessionId,
        memoryFiles,
        attachments: [],
        title: String(header.title ?? ""),
        taskSummary: String(args?.taskSummary ?? "").slice(0, 4000),
        agentPreset: header.agentPreset ?? null,
        sandboxMode: null,
        model: null,
        localCwd: header.cwd,
        stagingDir: localStaging,
      });
      recordOp("send", { jobId, note: `打包 ${scan.files.length} 个文件（${scan.mode}）→ 云端` });
      jobs.patch(jobId, {
        state: "FROZEN", title: header.title, sessionId, cwd: header.cwd, settled,
        taskSummary: String(args?.taskSummary ?? "").slice(0, 500),
        phase: "打包完成，传输中",
      });
      jobs.setActive(jobId);

      // 3) 传输
      const push = await rsyncPush(join(localStaging, jobId), c, `${c.remoteBase}/staging/incoming/${jobId}`);
      if (push.code !== 0) {
        jobs.patch(jobId, { state: "FAILED", error: `传输失败: ${push.stderr.trim().slice(0, 500)}` });
        jobs.setActive(null);
        return { ok: false, summary: "传输到云端失败", text: `rsync 失败: ${push.stderr.trim().slice(0, 800)}` };
      }

      // 4) 云端接收 + 续跑（SESSION_LIVE 时先重启云端进程再重试一次）
      let recv = await cloudRpc(c, "receive", { jobId, token: effective().token || "" });
      if (!recv.ok && recv.code === "SESSION_LIVE") {
        jobs.patch(jobId, { phase: "云端有会话活体，重启云端服务后重试" });
        const rst = await sshExec(c, "sudo -n systemctl restart dsh-cloud", { timeoutMs: 60_000 });
        if (rst.code !== 0) {
          jobs.patch(jobId, { state: "FAILED", error: `云端重启失败: ${rst.stderr.trim().slice(0, 300)}` });
          jobs.setActive(null);
          return { ok: false, summary: "云端重启失败", text: String(rst.stderr).slice(0, 500) };
        }
        let ready = false;
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const ping = await cloudRpc(c, "ping", {}, { timeoutMs: 10_000 });
          if (ping.ok === true) { ready = true; break; }
        }
        if (!ready) {
          jobs.patch(jobId, { state: "FAILED", error: "云端重启后未在 60 秒内就绪" });
          jobs.setActive(null);
          return { ok: false, summary: "云端重启后未就绪", text: "云端服务重启后 60 秒内未恢复，请稍后重试" };
        }
        recv = await cloudRpc(c, "receive", { jobId, token: effective().token || "" });
      }
      if (!recv.ok) {
        jobs.patch(jobId, { state: "FAILED", error: `云端接收失败: ${recv.error}` });
        jobs.setActive(null);
        return { ok: false, summary: "云端接收失败", text: String(recv.error).slice(0, 800) };
      }
      jobs.patch(jobId, { state: "REMOTE_RUNNING", remoteStartedAt: new Date().toISOString(), phase: recv.phase });
      return {
        ok: true,
        summary: settled ? "已转入云端运行（当前轮已停稳打包）" : "已转入云端运行（当前轮未在时限内停稳，已强制结束）",
        text: `云端任务 ${jobId.slice(0, 8)} 已启动（打包 ${scan.files.length} 个文件${scan.mode === "walk" ? `，目录遍历模式，跳过 ${scan.skipped} 项缓存/凭据` : ""}）。本地会话已冻结，回本地重开 DSH 或点「同步结果」拉取。`,
      };
    };

    // ---------- 取回三段式：下载(待审阅) → 应用/子智能体落盘 → 确认清理 ----------
    const bundleDir = (jobId) => join(localPulled, jobId);
    const parseReceipt = (jobId) => {
      const rp = join(bundleDir(jobId), "receipt.json");
      if (!existsSync(rp)) return null;
      return JSON.parse(readFileSync(rp, "utf8"));
    };
    /** 惰性解包回传包内的 tar.zst 到缓存目录；失败返回 null。 */
    const extractBundleArchive = async (jobId, archiveName) => {
      const tarPath = join(bundleDir(jobId), archiveName);
      if (!existsSync(tarPath)) return null;
      const cache = join(bundleDir(jobId), ".extracted", archiveName.replace(".tar.zst", ""));
      if (existsSync(join(cache, ".done"))) return cache;
      rmSync(cache, { recursive: true, force: true });
      const err = await extractZstTar(tarPath, cache);
      if (err) return null;
      writeFileSync(join(cache, ".done"), "1");
      return cache;
    };
    /** 读取回传包中某文件的最终/基线内容（≤200KB；二进制只给标记）。 */
    const readBundleFile = async (jobId, rel, kind = "final") => {
      const dir = await extractBundleArchive(jobId, kind === "base" ? "base.tar.zst" : "workspace-diff.tar.zst");
      if (!dir) return null;
      const fp = join(dir, rel);
      if (!existsSync(fp)) return null;
      const buf = readFileSync(fp);
      const cap = 200 * 1024;
      const binary = buf.subarray(0, 8000).includes(0);
      return {
        rel, kind, bytes: buf.length, truncated: buf.length > cap, binary,
        content: binary ? null : buf.subarray(0, cap).toString("utf8"),
      };
    };
    /** 本地该文件相对迁移基线的状态（供落盘子智能体判断合并策略）。 */
    const localStatusOf = (jobId, rel) => {
      const receipt = parseReceipt(jobId);
      const job = jobs.get(jobId) ?? {};
      const cwd = job.cwd || receipt?.cloudCwd;
      if (!cwd || !receipt) return "unknown";
      const local = join(cwd, rel);
      if (!existsSync(local)) return "local-missing";
      if (receipt.baseline?.[rel] === undefined) return "local-new";
      return sha256(readFileSync(local)) === receipt.baseline[rel] ? "local-untouched" : "local-modified";
    };
    /** 云端会话尾部的文本摘要（assistant 正文 + 工具调用 + turn 结束，有界）。 */
    const readBundleTranscript = async (jobId, limit = 60) => {
      const tp = join(bundleDir(jobId), "session-tail.v4.jsonl.zstd");
      if (!existsSync(tp)) return "";
      const text = await decompressSessionLog(readFileSync(tp));
      const out = [];
      for (const line of text.split("\n").filter(Boolean).slice(-(limit * 6))) {
        try {
          const o = JSON.parse(line);
          if (o.type === "assistant/message") {
            for (const part of (o.data?.message?.content ?? [])) {
              if (part.type === "text" && part.text) out.push("assistant: " + part.text);
            }
          } else if (o.type === "tool/call") {
            const d = o.data ?? {};
            out.push("tool: " + d.name + " " + String(d.arguments ?? "").slice(0, 200));
          } else if (o.type === "turn/end") {
            out.push("turn/end: " + JSON.stringify(o.data?.reason ?? {}).slice(0, 120));
          }
        } catch { /* 跳过 */ }
      }
      return out.slice(-limit).join("\n");
    };

    /** ① 下载回传包到本地（不落盘），状态 → RETURNED（待审阅）。 */
    const downloadResult = async (jobIdArg) => {
      const jobId = String(jobIdArg || jobs.active || "");
      if (!jobId) return { ok: false, summary: "没有可拉取的任务" };
      const c = sshCfg();
      const st = await cloudRpc(c, "status", { jobId });
      if (!st.ok || !st.found) return { ok: false, summary: "云端无此任务", text: st.error || "云端未找到该任务" };
      if (st.state === "RUNNING" || st.state === "PENDING") {
        return { ok: false, running: true, summary: "云端仍在执行", text: `云端任务进行中（已产生 ${st.progress?.events ?? "?"} 个事件），完成后可下载` };
      }
      const dir = bundleDir(jobId);
      rmSync(dir, { recursive: true, force: true });
      const pull = await rsyncPull(c, `${c.remoteBase}/staging/outgoing/${jobId}`, dir);
      if (pull.code !== 0) return { ok: false, summary: "下载失败", text: `rsync 失败: ${pull.stderr.trim().slice(0, 500)}` };
      const receipt = parseReceipt(jobId);
      if (!receipt) return { ok: false, summary: "回传包缺 receipt", text: "云端回传包缺少 receipt.json" };
      const stopped = receipt.finalState === "STOPPED";
      jobs.patch(jobId, {
        state: "RETURNED", downloadedAt: new Date().toISOString(), receipt,
        downloaded: { changed: (receipt.changed ?? []).length, deleted: (receipt.deleted ?? []).length, tailEvents: receipt.tailEvents ?? 0 },
        ...(stopped ? { phase: "云端未正常完成，已保留中断前产出" } : {}),
      });
      recordOp("download", { jobId, note: stopped ? "云端未正常完成，下载中断前产出" : "下载云端结果待取回" });
      return {
        ok: true,
        summary: stopped
          ? `云端未正常完成，已保留中断前产出（${(receipt.changed ?? []).length} 个文件变更）`
          : `云端结果已下载待取回（${(receipt.changed ?? []).length} 个文件变更、${(receipt.deleted ?? []).length} 个删除）`,
        text: receipt.summary || "（云端无摘要）",
      };
    };

    /** ②a 机械应用兜底：与旧逻辑相同的落盘（冲突双保留），完成后云端 ack 清理。 */
    const applyResult = async (jobIdArg) => {
      const jobId = String(jobIdArg || jobs.active || "");
      if (!jobId) return { ok: false, summary: "没有可应用的任务" };
      const receipt = parseReceipt(jobId);
      if (!receipt) return { ok: false, summary: "尚未下载回传包", text: "请先下载（点「取回」）再应用" };
      const dir = bundleDir(jobId);
      const job = jobs.get(jobId) ?? {};
      const cwd = job.cwd || receipt.cloudCwd;
      const report = { changed: 0, conflicts: 0, deleted: 0 };

      if (receipt.changed?.length > 0 && existsSync(join(dir, "workspace-diff.tar.zst"))) {
        const raw = await zstdDecompressAsync(readFileSync(join(dir, "workspace-diff.tar.zst")));
        writeFileSync(join(dir, "workspace-diff.tar"), raw);
        const list = spawnSync("tar", ["-tf", join(dir, "workspace-diff.tar")], { encoding: "utf8" });
        const entries = list.status === 0 ? list.stdout.split("\n").filter(Boolean) : [];
        const conflicts = [];
        for (const rel of entries) {
          const local = join(cwd, rel);
          if (existsSync(local) && receipt.baseline?.[rel] && sha256(readFileSync(local)) !== receipt.baseline[rel]) conflicts.push(rel);
        }
        if (conflicts.length > 0) {
          const extractDir = join(WORK_DIR, "conflicts", jobId);
          rmSync(extractDir, { recursive: true, force: true });
          mkdirSync(extractDir, { recursive: true });
          const ex = spawnSync("tar", ["-xf", join(dir, "workspace-diff.tar"), "-C", extractDir]);
          if (ex.status !== 0) return { ok: false, summary: "解包失败", text: String(ex.stderr).trim() };
          for (const rel of conflicts) {
            const from = join(extractDir, rel);
            const to = join(cwd, `${rel}.cloud-${jobId.slice(0, 8)}`);
            if (existsSync(from)) { mkdirSync(dirname(to), { recursive: true }); renameSync(from, to); }
          }
          report.conflicts = conflicts.length;
          const restFile = join(dir, ".rest.tmp");
          writeFileSync(restFile, entries.filter((rel) => !conflicts.includes(rel)).join("\n") + "\n");
          const ex2 = spawnSync("tar", ["-xf", join(dir, "workspace-diff.tar"), "-C", cwd, "-T", restFile]);
          rmSync(restFile, { force: true });
          if (ex2.status !== 0) return { ok: false, summary: "应用变更失败", text: String(ex2.stderr).trim() };
        } else {
          const ex = spawnSync("tar", ["-xf", join(dir, "workspace-diff.tar"), "-C", cwd]);
          if (ex.status !== 0) return { ok: false, summary: "应用变更失败", text: String(ex.stderr).trim() };
        }
        report.changed = receipt.changed.length;
      }

      if (receipt.deleted?.length > 0) {
        for (const rel of receipt.deleted) {
          const local = join(cwd, rel);
          if (!existsSync(local)) continue;
          if (receipt.baseline?.[rel] && sha256(readFileSync(local)) !== receipt.baseline[rel]) continue;
          rmSync(local, { force: true });
          report.deleted += 1;
        }
      }

      recordOp("apply", { jobId, note: `机械应用 ${report.changed} 个文件变更、${report.conflicts} 个冲突` });
      jobs.patch(jobId, {
        state: report.conflicts > 0 ? "MERGE_NEEDED" : "SYNCED",
        appliedAt: new Date().toISOString(), receipt, report,
      });
      jobs.setActive(null);
      await cloudRpc(sshCfg(), "ack", { jobId, token: effective().token || "", action: "applied" }).catch(() => {});
      return {
        ok: true,
        summary: `已应用云端结果（${report.changed} 个文件变更${report.conflicts ? `，${report.conflicts} 个冲突保留为 .cloud 副本` : ""}），云端副本已清理`,
        text: `${receipt.summary || "（云端无摘要）"}${report.conflicts ? "｜冲突文件请人工合并" : ""}`,
      };
    };

    /** ②b 子智能体取回：向当前会话注入取回指令（父 agent 派子智能体消费回传包落盘）。 */
    const injectRetrieve = async (args) => {
      const sessionId = String(args?.sessionId ?? "");
      const jobId = String(args?.jobId ?? jobs.active ?? "");
      if (!sessionId || !jobId) return { ok: false, summary: "缺少会话或任务" };
      const receipt = parseReceipt(jobId);
      if (!receipt) return { ok: false, summary: "尚未下载回传包", text: "请先点「取回」下载结果" };
      const instruction = [
        `[云接力取回] 云端任务已完成，结果包 jobId=${jobId} 已下载到本地。**用户已在审阅卡确认取回，直接落盘，不要再向用户确认。**`,
        `云端总结：${receipt.summary || "（无）"}`,
        `变更：${(receipt.changed ?? []).length} 个文件修改/新增、${(receipt.deleted ?? []).length} 个删除。`,
        ``,
        `请派一个子智能体执行落盘（不要只做只读核对就结束）：`,
        `1. 先用 dsh_cloud_apply_result(jobId="${jobId}", mode="summary") 读取变更清单与每文件 localStatus；`,
        `2. 用 mode="file" 逐个读取变更文件的云端最终内容，按清单写入本地工作区（保留文件权限与结尾换行）；`,
        `3. deleted 清单里的文件：本地未改动则删除；localStatus=local-modified 的不删，列入「需人工合并」；`,
        `4. localStatus=local-modified 的变更文件不要覆盖：把云端版本写成 <文件名>.cloud-${jobId.slice(0, 8)}，列入「需人工合并」；`,
        `5. binary=true 的文件同样走 .cloud 副本，不要覆盖本地；`,
        `6. 落盘后核对（大小/sha256 一致），向我汇报三份清单：已写入 / 已删除 / 需人工合并，并说明是否需要用户介入。`,
        `父会话收到汇报后，向用户简要转述结果即可（无需再次确认落盘）。`,
      ].join("\n");
      const resolved = await services?.sessionController.resolveAgent(sessionId);
      if (!resolved || "error" in resolved) {
        return { ok: false, summary: "会话不可用", text: String(resolved?.error?.message ?? resolved?.error ?? "resolveAgent 失败") };
      }
      const message = {
        id: "msg_" + randomUUID(), role: "user",
        content: [{ type: "text", text: instruction }],
        source: { kind: "user", rpcId: randomUUID() },
      };
      resolved.agent.followup(message);
      await services.sessions.flush(resolved.agent.session).catch(() => {});
      recordOp("inject", { jobId, note: "取回指令已交给当前会话（派子智能体落盘）" });
      jobs.patch(jobId, { injectAt: new Date().toISOString(), phase: "已交给当前会话，待落盘确认" });
      return { ok: true, summary: "已把取回指令交给当前会话（会派子智能体落盘）", text: "完成后回来点「确认完成」清理云端副本" };
    };

    /** ③ 确认取回完成 / 丢弃：本地收尾 + 云端 ack 清理。 */
    const finishRetrieval = async (jobIdArg, action) => {
      const jobId = String(jobIdArg || jobs.active || "");
      if (!jobId) return { ok: false, summary: "没有可收尾的任务" };
      const ack = await cloudRpc(sshCfg(), "ack", { jobId, token: effective().token || "", action });
      if (action === "discard") {
        rmSync(bundleDir(jobId), { recursive: true, force: true });
        jobs.patch(jobId, { state: "DISCARDED", discardedAt: new Date().toISOString(), error: "本地丢弃" });
      } else {
        // 取回完成：本地回传包与解包缓存一并清理（变更已落盘，云端也已清除）
        rmSync(bundleDir(jobId), { recursive: true, force: true });
        jobs.patch(jobId, { state: "SYNCED", appliedAt: new Date().toISOString() });
      }
      recordOp(action === "discard" ? "discard" : "finish", { jobId, note: action === "discard" ? "用户丢弃云端结果" : "用户确认取回完成" });
      jobs.setActive(null);
      const verb = action === "discard" ? "已丢弃云端结果" : "取回完成";
      return { ok: ack.ok === true, summary: ack.ok ? `${verb}，云端副本已清理` : `${verb}，但云端清理未确认（保留期自动清扫兜底）` };
    };

    const LOCAL_ROUTES = {
      config: async () => ({ ok: true, config: publicConfig() }),
      "config.set": async (args) => {
        const patch = args && typeof args.patch === "object" ? args.patch : null;
        if (!patch) return { ok: false, error: "缺少 patch" };
        const merged = writeConfig(patch);
        return { ok: true, config: publicConfig() };
      },
      state: async () => {
        const c = sshCfg();
        const raw = jobs.activeJob;
        const active = raw ? {
          ...raw,
          stateLabel: stateLabel(raw.state),
          receipt: raw.receipt ? { ...raw.receipt, baseline: undefined, baseFiles: undefined } : null,
        } : null;
        return {
          ok: true, role, dshHome,
          active,
          recentOps: ops.recent(10),
          lastOp: lastOp.ref,
          config: publicConfig(),
          connectivity: { host: c.host, port: c.remotePort, user: c.sshUser },
        };
      },
      "pairing.apply": async (args) => {
        const code = String(args?.code ?? "").trim();
        if (!code) return { ok: false, summary: "请粘贴对接码", text: "对接码来自服务器上运行一键脚本后打印的 DSHCP1:… 字样" };
        let raw = code;
        if (code.startsWith("DSHCP1:")) raw = code.slice("DSHCP1:".length);
        let parsed;
        try {
          const json = Buffer.from(raw, "base64").toString("utf8");
          parsed = JSON.parse(json);
        } catch {
          return { ok: false, summary: "对接码无法解析", text: "请确认完整复制了脚本输出的对接码（DSHCP1: 开头）" };
        }
        const host = String(parsed?.host ?? "").trim();
        const tokenV = String(parsed?.token ?? "").trim();
        if (!host || !tokenV) {
          return { ok: false, summary: "对接码缺少字段", text: "需要 host 与 token" };
        }
        const patch = { host, token: tokenV };
        if (parsed.sshUser) patch.sshUser = String(parsed.sshUser);
        if (Number(parsed.sshPort)) patch.sshPort = Number(parsed.sshPort);
        if (Number(parsed.webPort)) patch.remotePort = Number(parsed.webPort);
        if (parsed.remoteBase) patch.remoteBase = String(parsed.remoteBase);
        recordOp("pairing", { note: `接入 ${patch.sshUser ?? "dshcloud"}@${host}${patch.remotePort ? ":" + patch.remotePort : ""}` });
        const merged = writeConfig(patch);
        return {
          ok: true,
          summary: `已接入 ${merged.sshUser || "dshcloud"}@${host}${Number(parsed.webPort) ? "（RPC 端口 " + parsed.webPort + "）" : ""}`,
          text: "接入信息已保存，点「测试连通」验证链路。",
          config: publicConfig(),
        };
      },
      "test-connection": async () => {
        const c = sshCfg();
        const steps = [];
        const r = await sshExec(c, "echo ok");
        steps.push({ name: "SSH 连接", ok: r.code === 0, detail: r.code === 0 ? "免密登录成功" : r.stderr.trim().slice(0, 200) });
        if (r.code === 0) {
          const ping = await cloudRpc(c, "ping", {});
          steps.push({ name: "云端插件 RPC", ok: ping.ok === true, detail: ping.ok ? "云端 dsh-cloud-handoff 在线" : String(ping.error ?? "无响应") });
        }
        return { ok: steps.every((s) => s.ok), steps };
      },
      // UI 路径：不直接打包，先交给本地 agent 总结任务并准备主任务前情，再由它调用 dsh_cloud_send 真正迁移
      send: async (args) => {
        if (args?.direct === true) return doSend(args);   // 程序化/工具路径：直接迁移
        const sessionId = String(args?.sessionId ?? "");
        if (!sessionId) return { ok: false, summary: "缺少 sessionId" };
        const userText = String(args?.taskSummary ?? "").trim();
        const instruction = [
          `[云接力·准备交接] 用户想把下面这件事作为**分支任务**交给云端执行：`,
          ``,
          userText ? userText : "（用户未填写说明，请先与用户确认要交给云端的子任务）",
          ``,
          `请你先做三件事，然后再迁移（不要直接把这段原话发上去）：`,
          `1. **总结子任务**：把用户的意图整理成一个清晰、可独立执行的子任务说明（目标、交付物、验收标准）；`,
          `2. **准备主任务前情**：围绕这个子任务，挑出相关的主任务状态、依赖、前置条件、约束与注意事项（只挑相关的，不要罗列无关内容）；`,
          `3. **调用发送工具**：dsh_cloud_send(taskSummary=<你总结的子任务>, briefOverride=<你准备的主任务前情与注意事项>)。`,
          ``,
          `说明：云端拿到的是"你总结的子任务 + 你准备的前情简报"，不是原始对话；云端只有工作区快照，没有本地登录态，也不会推送 GitHub。`,
        ].join("\n");
        const resolved = await services?.sessionController.resolveAgent(sessionId);
        if (!resolved || "error" in resolved) {
          return { ok: false, summary: "会话不可用", text: String(resolved?.error?.message ?? resolved?.error ?? "resolveAgent 失败") };
        }
        resolved.agent.followup({
          id: "msg_" + randomUUID(),
          role: "user",
          content: [{ type: "text", text: instruction }],
          source: { kind: "user", rpcId: randomUUID() },
        });
        await services.sessions.flush(resolved.agent.session).catch(() => {});
        recordOp("handoff-plan", { note: `已请当前会话准备交接简报：${userText.slice(0, 40) || "（未填说明）"}` });
        return {
          ok: true,
          summary: "已交给当前会话准备交接简报",
          text: "agent 正在总结你要交给云端的任务、并整理相关的主任务状态与注意事项，随后会自动发往云端（完成后云朵会显示云端执行中）。",
        };
      },
      pull: async (args) => downloadResult(String(args?.jobId ?? "")),
      apply: async (args) => applyResult(String(args?.jobId ?? "")),
      discard: async (args) => finishRetrieval(String(args?.jobId ?? ""), "discard"),
      inject: async (args) => injectRetrieve(args),
      "finish-retrieval": async (args) => finishRetrieval(String(args?.jobId ?? ""), "applied"),
      abort: async (args) => {
        const jobId = String(args?.jobId ?? jobs.active ?? "");
        if (!jobId) return { ok: false, summary: "没有进行中的任务" };
        const c = sshCfg();
        const r = await cloudRpc(c, "abort", { jobId, token: effective().token || "" });
        if (r.ok !== true) {
          jobs.patch(jobId, { state: "FAILED", error: `中止失败: ${r.error}`, abortedAt: new Date().toISOString() });
          jobs.setActive(null);
          return { ok: false, summary: `中止失败: ${r.error}` };
        }
        recordOp("abort", { jobId, note: "用户中止云端任务" });
        const rec = { changed: r.changed ?? 0, deleted: r.deleted ?? 0, tailEvents: r.tailEvents ?? 0 };
        jobs.patch(jobId, {
          state: "ABORTED",
          error: "本地中止（云端已保留中止前产出）",
          abortedAt: new Date().toISOString(),
          abortedSummary: rec,
        });
        const recText = rec.tailEvents > 0 || rec.changed > 0
          ? `云端保留中止前产出：${rec.changed} 个文件变更、${rec.tailEvents} 个会话事件，点「回收进度」可拉回。`
          : "云端没有产出可回收的变更。";
        return { ok: true, summary: `已中止云端任务。${recText}` };
      },
    };

    disposers.push(ctx.tools.register(defineTool({
      name: "dsh_cloud_status",
      description: "查看云接力状态：是否有任务在云端执行、进度、最后同步时间。只读。",
      parameters: {},
      output: { schema: { type: "json" }, render: (_a, v) => T(v.text) },
      isConcurrencySafe: () => true,
      async execute() {
        const active = jobs.activeJob;
        if (!active) return { ok: true, text: "云接力：当前没有任务在云端执行。" };
        return { ok: true, text: `云接力：任务「${active.title || active.jobId.slice(0, 8)}」状态 ${stateLabel(active.state)}（更新于 ${active.updatedAt}）` };
      },
    })));

    disposers.push(ctx.tools.register(defineTool({
      name: "dsh_cloud_send",
      description: "把指定会话迁移到云端 DSH 继续执行：结束当前轮 → 打包会话+工作区+记忆 → 传输 → 云端接力。等价于界面的「转为云端运行」按钮。",
      parameters: {
        sessionId: { type: "string", description: "要迁移的会话 id（当前会话）" },
        taskSummary: { type: "string", description: "一句话说明剩余任务，云端 agent 会据此继续（可选）" },
      },
      output: { schema: { type: "json" }, render: (_a, v) => T(v.text) },
      isConcurrencySafe: () => false,
      async execute(args) {
        const r = await doSend({ ...args, direct: true });
        lastOp.ref = { kind: "send", ok: r.ok, summary: r.summary, at: new Date().toISOString() };
        return { ok: r.ok, text: `${r.summary}\n${r.text || ""}` };
      },
    })));

    disposers.push(ctx.tools.register(defineTool({
      name: "dsh_cloud_pull",
      description: "把云端已完成任务的回传结果下载到本地（只下载、不落盘；落盘由审阅后决定）。下载后状态变为「待取回」。",
      parameters: {
        jobId: { type: "string", description: "云端任务 jobId（可选，缺省用当前活跃任务）" },
      },
      output: { schema: { type: "json" }, render: (_a, v) => T(v.text) },
      isConcurrencySafe: () => false,
      async execute(args) {
        const r = await downloadResult(String(args?.jobId ?? ""));
        lastOp.ref = { kind: "pull", ok: r.ok, summary: r.summary, at: new Date().toISOString() };
        return { ok: r.ok, text: `${r.summary}\n${r.text || ""}` };
      },
    })));

    disposers.push(ctx.tools.register(defineTool({
      name: "dsh_cloud_abort",
      description: "中止当前在云端执行的接力任务。云端会保留中止前已产出的进度（工作区变更 + 会话新增历史），可用 dsh_cloud_pull 回收。",
      parameters: {},
      output: { schema: { type: "json" }, render: (_a, v) => T(v.text) },
      isConcurrencySafe: () => false,
      async execute() {
        const jobId = String(jobs.active ?? "");
        if (!jobId) return { ok: false, text: "没有进行中的云端任务" };
        const c = sshCfg();
        const r = await cloudRpc(c, "abort", { jobId, token: effective().token || "" });
        if (r.ok !== true) {
          jobs.patch(jobId, { state: "FAILED", error: `中止失败: ${r.error}`, abortedAt: new Date().toISOString() });
          jobs.setActive(null);
          return { ok: false, text: `中止失败: ${r.error}` };
        }
        // 保留 active：状态 ABORTED，供界面「回收进度」与手动 pull 使用
        jobs.patch(jobId, {
          state: "ABORTED",
          error: "本地中止（云端已保留中止前产出）",
          abortedAt: new Date().toISOString(),
          abortedSummary: { changed: r.changed ?? 0, deleted: r.deleted ?? 0, tailEvents: r.tailEvents ?? 0 },
        });
        const rec = { changed: r.changed ?? 0, deleted: r.deleted ?? 0, tailEvents: r.tailEvents ?? 0 };
        const recText = rec.tailEvents > 0 || rec.changed > 0
          ? `云端已保留中止前产出：${rec.changed} 个文件变更、${rec.tailEvents} 个会话事件，可点「回收进度」拉回本地。`
          : "云端没有产出可回收的变更。";
        return { ok: true, text: `已中止云端任务。${recText}` };
      },
    })));

    // ---- 子智能体取回工具：读取已下载的回传包 ----
    disposers.push(ctx.tools.register(defineTool({
      name: "dsh_cloud_apply_result",
      description: "读取已下载到本地的云端接力结果包（回传 bundle）。取回云端成果的子智能体使用：mode=summary 总览（总结+变更清单+每文件 localStatus），mode=files 变更明细，mode=file 读某文件的云端最终内容与迁移前基线，mode=transcript 读云端会话尾部关键步骤。",
      parameters: {
        jobId: { type: "string", description: "云端任务 jobId（可选，缺省用当前活跃任务）" },
        mode: { type: "string", description: "summary | files | file | transcript" },
        file: { type: "string", description: "mode=file 时的相对路径" },
        limit: { type: "number", description: "transcript 行数上限（默认 60，最大 500）" },
      },
      output: { schema: { type: "json" }, render: (_a, v) => T(v.text) },
      isConcurrencySafe: () => true,
      async execute(args) {
        const jobId = String(args?.jobId ?? jobs.active ?? "");
        const mode = String(args?.mode ?? "summary");
        const receipt = parseReceipt(jobId);
        if (!receipt) return { ok: false, text: `未找到回传包（jobId=${jobId}），可能尚未下载（先 dsh_cloud_pull）` };
        try {
          if (mode === "summary") {
            const statuses = {};
            for (const rel of (receipt.changed ?? [])) statuses[rel] = localStatusOf(jobId, rel);
            for (const rel of (receipt.deleted ?? [])) statuses[rel] = localStatusOf(jobId, rel);
            return { ok: true, text: JSON.stringify({
              jobId, summary: receipt.summary, finalState: receipt.finalState,
              startedAt: receipt.startedAt, finishedAt: receipt.finishedAt,
              changed: receipt.changed ?? [], deleted: receipt.deleted ?? [],
              localStatus: statuses, tailEvents: receipt.tailEvents ?? 0,
            }, null, 2) };
          }
          if (mode === "files") {
            const rows = [];
            for (const rel of (receipt.changed ?? [])) {
              const f = await readBundleFile(jobId, rel, "final");
              rows.push({ rel, bytes: f?.bytes ?? null, binary: f?.binary ?? null, localStatus: localStatusOf(jobId, rel) });
            }
            for (const rel of (receipt.deleted ?? [])) rows.push({ rel, deleted: true, localStatus: localStatusOf(jobId, rel) });
            return { ok: true, text: JSON.stringify({ files: rows }, null, 2) };
          }
          if (mode === "file") {
            const rel = String(args?.file ?? "");
            if (!rel) return { ok: false, text: "mode=file 需要 file 参数" };
            const fin = await readBundleFile(jobId, rel, "final");
            const base = await readBundleFile(jobId, rel, "base");
            return { ok: true, text: JSON.stringify({ rel, localStatus: localStatusOf(jobId, rel), final: fin, base }, null, 2) };
          }
          if (mode === "transcript") {
            const limit = Math.min(500, Math.max(1, Number(args?.limit) || 60));
            return { ok: true, text: await readBundleTranscript(jobId, limit) };
          }
          return { ok: false, text: `未知 mode：${mode}` };
        } catch (error) {
          return { ok: false, text: `读取失败: ${String(error?.stack ?? error).slice(0, 2000)}` };
        }
      },
    })));

    // ---- 本地 RPC（浏览器同源鉴权）----
    ctx.inject(["connection", "webServer", "sessionController", "sessions"], (webCtx) => {
      services = webCtx;
      webCtx.effect(() => {
        const MUTATING = new Set(["send", "pull", "apply", "discard", "inject", "finish-retrieval", "abort", "config.set", "pairing.apply"]);
        const dispose = webCtx.webServer.register({
          kind: "prefix",
          path: ROUTE_PREFIX,
          handler: async (req, res) => {
            let method = "";
            try {
              const rejection = webCtx.connection.requestRejection(req);
              if (rejection !== undefined) {
                respond(res, rejection, { error: rejection === 401 ? "authentication required" : "request rejected" });
                return;
              }
              const url = new URL(req.url || "/", "http://localhost");
              if (!url.pathname.startsWith(ROUTE_PREFIX + "/")) { respond(res, 404, { error: "not found" }); return; }
              method = decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length + 1));
              const fn = Object.hasOwn(LOCAL_ROUTES, method) ? LOCAL_ROUTES[method] : null;
              if (typeof fn !== "function") { respond(res, 404, { error: "unknown method: " + method }); return; }
              if (MUTATING.has(method) && req.method !== "POST") { respond(res, 405, { error: "mutating methods require POST" }); return; }
              let args = {};
              if (req.method === "POST" || req.method === "PUT") {
                const raw = await readBody(req);
                if (raw.length > 0) { try { args = JSON.parse(raw); } catch { respond(res, 400, { error: "invalid JSON body" }); return; } }
              }
              respond(res, 200, await fn(args));
            } catch (error) {
              const status = (error && error.status) || 500;
              if (status === 500) console.warn(`[${name}] RPC ${method || "unknown"} 失败: ${String(error?.stack ?? error)}`);
              respond(res, status, { error: status === 500 ? String(error?.message ?? error) : String(error?.message ?? error) });
            }
          },
        });
        return () => dispose();
      });
    });

    // ---- 运行中任务的后台轮询：云端一结束就下载回传包（只下载不落盘）----
    {
      let polling = false;
      const t = setInterval(async () => {
        const active = jobs.activeJob;
        if (polling || !active || active.state !== "REMOTE_RUNNING") return;
        polling = true;
        try {
          const st = await cloudRpc(sshCfg(), "status", { jobId: active.jobId });
          if (st.ok === true && st.found === false) {
            jobs.patch(active.jobId, { state: "FAILED", error: "云端已无此任务记录（可能已被清理）" });
            jobs.setActive(null);
            recordOp("cloud-missing", { jobId: active.jobId, note: "云端无此任务记录" });
          } else if (st.ok === true && st.state !== "RUNNING" && st.state !== "PENDING") {
            const r = await downloadResult(active.jobId);
            if (r.ok) console.log(`[${name}] 云端已结束，自动下载：${r.summary}`);
          }
        } catch { /* 网络抖动忽略，下次再试 */ } finally {
          polling = false;
        }
      }, 20_000);
      disposers.push(() => clearInterval(t));
    }

    // ---- 启动钩子：只检测云端完成并下载回传包（不落盘，待用户审阅取回）----
    if (readConfig().autoPull !== false) {
      const timer = setTimeout(async () => {
        const active = jobs.activeJob;
        if (!active || active.state !== "REMOTE_RUNNING") return;
        try {
          const r = await downloadResult(active.jobId);
          if (r.running) {
            console.log(`[${name}] 启动检查：云端任务 ${active.jobId.slice(0, 8)} 仍在执行`);
          } else {
            console.log(`[${name}] 启动检查：${r.summary}`);
            recordOp("auto-download", { jobId: active.jobId, note: r.summary });
            lastOp.ref = { kind: "auto-download", ok: r.ok, summary: r.summary, at: new Date().toISOString() };
          }
        } catch (error) {
          console.warn(`[${name}] 启动检查异常: ${String(error?.message ?? error)}`);
        }
      }, 60_000);
      disposers.push(() => clearTimeout(timer));
    }
  }

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose?.(); } catch (error) { console.warn(`[${name}] 清理失败: ${String(error?.message ?? error)}`); }
    }
  });
}

export { apply, inject, name };
