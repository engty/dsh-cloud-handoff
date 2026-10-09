/**
 * lib/brief.mjs — 任务简报：迁移前在本地把"与任务相关的上下文"提炼成小体积文本。
 *
 * 为什么不发整段会话：会话日志包含全部工具输出，动辄几 MB～几十 MB，
 * 云端要据此构造的模型请求会超限/超时（实测 16.9MB 日志 → 云端调用必失败）。
 * 简报只保留人读得懂的关键信息：任务说明、用户诉求、助手结论、涉及的文件。
 */
import { readFileSync } from "node:fs";
import { decompressSessionLog } from "./import.mjs";

// 上限依据（2026-10-08 实测 @ api.deepseek.com/anthropic）：
//   2MB → 200 OK(4.3s)；8MB → 200 OK(83s)；16MB → 400（1,398,191 tokens > 1,048,576 上限）
// 即真正的硬限制是模型上下文窗口 1M tokens，与请求体字节数无关。
// 简报取 300KB（≈5~7 万 tokens，占窗口 5~7%）：细节可充分保留，上传 1 秒内完成，
// 并为云端执行过程（读文件、工具输出）留足余量。
const DEFAULT_BUDGET = 300 * 1024;
/** 实测得到的云端上限（供 UI/文档引用）。 */
export const CLOUD_LIMITS = {
  contextWindowTokens: 1_048_576,
  measuredAt: "2026-10-08",
  requestBytesOk: 8 * 1024 * 1024,
  requestBytesFail: 16 * 1024 * 1024,
  briefBudgetBytes: DEFAULT_BUDGET,
};

/** 去掉 harness 注入块（记忆快照、运行时上下文、后台任务通知等），只留用户真正说的话。 */
const INJECTED_LINE = /^(\s*)(MNEMON RUNTIME MEMORY SNAPSHOT|Current runtime context|Browser time zone|Time sampled|background job |\[model changed|MNEMON VIEW TOOLS|Contents of (USER|MEMORY)\.md|<runtime-memory-file)/;
function stripInjected(text) {
  const kept = [];
  for (const line of String(text).split("\n")) {
    if (INJECTED_LINE.test(line)) break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/** 单条文本裁剪。 */
function clip(text, max) {
  const t = String(text ?? "").replace(/\s+\n/g, "\n").trim();
  return t.length > max ? t.slice(0, max) + "…（已截断）" : t;
}

/**
 * 从会话日志生成任务简报（Markdown）。
 * @param {string} logPath 会话日志路径
 * @param {{taskSummary?:string, title?:string, cwd?:string, userTurns?:number, assistantTurns?:number, budgetBytes?:number}} options
 */
export async function buildTaskBrief(logPath, options = {}) {
  const budget = options.budgetBytes ?? DEFAULT_BUDGET;
  const text = await decompressSessionLog(readFileSync(logPath));
  const lines = text.split("\n").filter(Boolean);

  const userMsgs = [];
  const assistantMsgs = [];
  const files = new Map();      // 路径 → 最近一次动作
  let lastTool = "";

  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const type = ev.type;
    const d = ev.data ?? {};
    if (type === "user/message") {
      const t = (d.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("\n").trim();
      // 跳过系统/续跑注入类消息
      if (t) userMsgs.push(stripInjected(t));
    } else if (type === "assistant/message") {
      const t = (d.message?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("\n").trim();
      if (t) assistantMsgs.push(t);
    } else if (type === "tool/call") {
      const name = String(d.name ?? "");
      let args = {};
      try { args = typeof d.arguments === "string" ? JSON.parse(d.arguments) : (d.arguments ?? {}); } catch { args = {}; }
      const path = args.file_path ?? args.path ?? args.file ?? "";
      if (path && ["write", "edit", "read", "str_replace_editor", "create_file"].some((n) => name.includes(n))) {
        files.set(String(path), name);
        lastTool = name;
      }
    }
  }

  const userN = options.userTurns ?? 150;
  const asstN = options.assistantTurns ?? 80;

  // 从用户消息里挑出"约束/注意事项"类表达（否定、必须、边界）
  const CONSTRAINT = /(不要|不能|不可以|禁止|别|必须|只能|务必|注意|小心|切记|别忘|前提|依赖|需要先|除非)/;
  const constraints = userMsgs.filter((m) => CONSTRAINT.test(m)).slice(-40);

  const parts = [];
  parts.push(`# 云端子任务交接简报（本地生成）`);
  parts.push("");
  parts.push(`> 这是一份**分支任务**交接：下面的内容来自本地主任务的上下文提炼，不是完整对话。`);
  parts.push("");
  parts.push(`## 一、主任务背景与当前状态`);
  parts.push(`- 主线会话：《${clip(options.title || "（无标题）", 80)}》`);
  if (options.cwd) parts.push(`- 本地工作区：${options.cwd}`);
  const latest = assistantMsgs.slice(-3);
  if (latest.length > 0) {
    parts.push(`- 本地进行到：`);
    for (const m of latest) parts.push(`  - ${clip(m, 4000)}`);
  }
  parts.push("");
  if (constraints.length > 0) {
    parts.push(`## 二、依赖与注意事项（来自主任务的约束）`);
    for (const m of constraints) parts.push(`- ${clip(m, 4000)}`);
    parts.push("");
  }
  parts.push(`## 三、云端环境事实（务必知悉）`);
  parts.push(`- 你在**云端机器**上工作，工作区就是当前目录；本地机器已暂停，不会再改动这里。`);
  parts.push(`- 云端**没有**本地用户的登录态与账号型模型通道，模型调用走 API Key。`);
  parts.push(`- 不要向 GitHub 或任何远程仓库推送（本地会人工审阅后再合并）。`);
  parts.push(`- 完整会话历史未随包发送：需要更多细节时，查看工作区文件、简报中的线索，或按合理假设推进并在汇报中说明。`);
  parts.push(`- 完成后必须调用 dsh_cloud_finish 汇报（含关键产出文件路径）；中途受阻也要调用它说明卡点。`);
  parts.push("");
  parts.push(`## 四、交给云端的子任务（本次目标）`);
  parts.push(clip(options.taskSummary || "（用户未填写任务说明，请依据主任务背景自行判断可推进的工作并先向用户确认）", 3000));
  parts.push("");
  if (options.extraBrief) {
    parts.push(`## 五、发起方补充的关键上下文`);
    parts.push(clip(options.extraBrief, 120_000));
    parts.push("");
  }
  if (userMsgs.length > 0) {
    parts.push(`## ${options.extraBrief ? "六" : "五"}、主任务里用户的关键要求（最近 ${Math.min(userN, userMsgs.length)} 条）`);
    for (const m of userMsgs.slice(-userN)) parts.push(`- ${clip(m, 3000)}`);
    parts.push("");
  }
  if (files.size > 0) {
    parts.push(`## 关键文件线索（最近操作）`);
    for (const [p, op] of [...files.entries()].slice(-200)) parts.push(`- ${p}（${op}）`);
    parts.push("");
  }

  let brief = parts.join("\n");
  return {
    brief,
    bytes: Buffer.byteLength(brief),
    stats: { userMsgs: userMsgs.length, assistantMsgs: assistantMsgs.length, files: files.size, sourceBytes: Buffer.byteLength(text) },
  };
}
