/**
 * lib/jobs.mjs — 任务状态机（本地与云端共用）
 *
 * 本地状态: LOCAL_ACTIVE → FROZEN(打包/传输) → REMOTE_RUNNING → SYNCED | MERGE_NEEDED | FAILED
 * 云端状态: PENDING → RUNNING → DONE | FAILED | CONFLICT
 * 全部落盘（JSON 文件），崩溃可恢复；receipt 防重复导入。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export const LOCAL_STATES = ["LOCAL_ACTIVE", "FROZEN", "REMOTE_RUNNING", "SYNCED", "MERGE_NEEDED", "FAILED"];
export const CLOUD_STATES = ["PENDING", "RUNNING", "DONE", "FAILED", "CONFLICT"];

export function loadJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function saveJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

export class JobStore {
  constructor(file) {
    this.file = file;
    this.data = loadJson(file, { version: 1, active: null, jobs: {} });
  }
  /** 全量写回（单进程内串行调用，无需锁）。 */
  flush() {
    saveJson(this.file, this.data);
  }
  get(jobId) {
    return this.data.jobs[jobId] ?? null;
  }
  /** 更新一个 job 的字段并落盘。 */
  patch(jobId, fields) {
    const job = this.data.jobs[jobId] ?? { jobId, createdAt: new Date().toISOString() };
    this.data.jobs[jobId] = { ...job, ...fields, updatedAt: new Date().toISOString() };
    this.flush();
    return this.data.jobs[jobId];
  }
  setActive(jobId) {
    this.data.active = jobId;
    this.flush();
  }
  get active() {
    return this.data.active;
  }
  get activeJob() {
    return this.data.active ? this.data.jobs[this.data.active] ?? null : null;
  }
}

/** 云端 job 记录文件：<base>/jobs/<jobId>.json */
export class CloudJobs {
  constructor(base) {
    this.dir = join(base, "jobs");
    mkdirSync(this.dir, { recursive: true });
  }
  file(jobId) {
    return join(this.dir, `${jobId}.json`);
  }
  get(jobId) {
    return loadJson(this.file(jobId), null);
  }
  /** 幂等写入：云端状态机只允许按顺序推进（除非 force）。 */
  patch(jobId, fields, { force = false } = {}) {
    const cur = this.get(jobId) ?? { jobId, state: "PENDING", createdAt: new Date().toISOString() };
    if (!force && cur.state === "DONE") return cur; // 完成后只读（receipt 语义）
    const next = { ...cur, ...fields, updatedAt: new Date().toISOString() };
    saveJson(this.file(jobId), next);
    return next;
  }
}

/** 人类可读状态文案（中文）。 */
export function stateLabel(state) {
  switch (state) {
    case "LOCAL_ACTIVE": return "本地执行中";
    case "FROZEN": return "打包中…";
    case "REMOTE_RUNNING": return "云端执行中";
    case "SYNCED": return "已同步回本地";
    case "MERGE_NEEDED": return "需手动合并";
    case "FAILED": return "失败";
    case "PENDING": return "待启动";
    case "RUNNING": return "执行中";
    case "DONE": return "完成";
    case "CONFLICT": return "冲突";
    default: return state ?? "未知";
  }
}
