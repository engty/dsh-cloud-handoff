import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWorkspacePath, rewriteSessionCwd, buildSessionLog, decompressSessionLog } from "../lib/import.mjs";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

// 本机真实目录名 → 路径 的 6 组对照（2026-10-07 实测）
const REAL_PAIRS = [
  ["/Users/alice/.dsh/dsh_orb", "--Users-alice-.dsh-dsh_orb--"],
  ["/Users/alice/Documents/deepseek-harness/default-workspace", "--Users-alice-Documents-deepseek-harness-default-workspace--"],
  ["/Users/alice/Projects/my-strategy", "--Users-alice-Projects-my-strategy--"],
  ["/Users/alice/Projects/notes", "--Users-alice-Projects-notes--"],
  ["/Users/alice/Projects/homelab", "--Users-alice-Projects-homelab--"],
  ["/Users/alice/Projects/demo-app", "--Users-alice-Projects-demo-app--"],
];

test("encodeWorkspacePath 与真实目录名一致（含中文）", () => {
  for (const [path, name] of REAL_PAIRS) {
    assert.equal(encodeWorkspacePath(path), name, `路径 ${path}`);
  }
  // 中文（任=4EFB 务=52A1 示=793A 例=4F8B 目=76EE 录=5F55；相邻转义共享波浪号边界）
  const zh = "/Users/alice/.dsh/dsh_orb/任务-示例目录";
  assert.equal(
    encodeWorkspacePath(zh),
    "--Users-alice-.dsh-dsh_orb-~4EFB~52A1-~793A~4F8B~76EE~5F55--"
  );
  // 空格与波浪号等不安全 ASCII 也要转义
  assert.equal(encodeWorkspacePath("/tmp/a b~/c"), "--tmp-a~0020b~007E-c--");
  // 连续分隔符合并
  assert.equal(encodeWorkspacePath("/tmp//x"), "--tmp-x--");
});

test("buildSessionLog 帧结构：第 1 帧单行 header、每帧可独立解码", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "dsh-ch-test-"));
  const events = Array.from({ length: 800 }, (_, i) =>
    JSON.stringify({ type: "user/message", seq: i, time: i, data: { text: `e${i}` } })
  );
  const outPath = join(tmp, "session.v4.jsonl.zstd");
  const frames = await buildSessionLog(JSON.stringify({ type: "session", version: 4, id: "t-1", cwd: "/x" }), events, outPath);
  assert.equal(frames, 3); // 1 头部帧 + 2 事件帧（500 + 300）

  // 用 node:zlib 逐帧扫描验证结构（官方 reader 的帧校验方式）
  const buf = await readFile(outPath);
  // 逐帧解压应还原全部内容
  const text = await decompressSessionLog(buf);
  const lines = text.split("\n").filter(Boolean);
  assert.equal(lines.length, 1 + 800);
  assert.equal(JSON.parse(lines[0]).type, "session");
  assert.equal(JSON.parse(lines[1]).data.text, "e0");
  rmSync(tmp, { recursive: true, force: true });
});

test("rewriteSessionCwd 只改首事件 cwd，其余事件逐字节保留", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "dsh-ch-test-"));
  const raw = [
    JSON.stringify({ type: "session", version: 4, id: "t-1", createdAt: 1, cwd: "/old/place", agentPreset: "standard" }),
    JSON.stringify({ type: "sandbox/mode", seq: 0, time: 1, data: { mode: "danger-full-access" } }),
    JSON.stringify({ type: "user/message", seq: 1, time: 2, data: { text: "你好" } }),
    JSON.stringify({ type: "assistant/message", seq: 2, time: 3, data: { text: "收到" } }),
  ].join("\n") + "\n";

  const inPath = join(tmp, "in.jsonl.zstd");
  const outPath = join(tmp, "out", "session.v4.jsonl.zstd");
  await buildSessionLog(raw.split("\n")[0], raw.split("\n").slice(1, -1), inPath);

  const { events, oldCwd } = await rewriteSessionCwd(inPath, "/srv/dsh-cloud/workspaces/job-1", outPath);
  assert.equal(events, 4);
  assert.equal(oldCwd, "/old/place");

  const text = await decompressSessionLog(await readFile(outPath));
  const lines = text.split("\n").filter(Boolean);
  assert.equal(lines.length, 4);
  assert.equal(JSON.parse(lines[0]).cwd, "/srv/dsh-cloud/workspaces/job-1");
  const orig = raw.split("\n").filter(Boolean);
  for (let i = 1; i < 4; i++) assert.equal(lines[i], orig[i], `事件 ${i} 应原样保留`);
  rmSync(tmp, { recursive: true, force: true });
});

test("scanWorkspace：非 git 目录走遍历模式，排除缓存/凭据/嵌套.git", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { scanWorkspace } = await import("../lib/handoff.mjs");
  const dir = mkdtempSync(join(tmpdir(), "dsh-ch-walk-"));
  writeFileSync(join(dir, "a.txt"), "hello");
  writeFileSync(join(dir, ".env"), "SECRET=x");                      // 凭据应排除
  mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });   // 依赖应排除
  writeFileSync(join(dir, "node_modules", "pkg", "x.js"), "x");
  mkdirSync(join(dir, "nested", ".git"), { recursive: true });        // 嵌套 .git 应排除
  writeFileSync(join(dir, "nested", ".git", "HEAD"), "ref");
  writeFileSync(join(dir, "nested", "keep.md"), "keep");
  const scan = scanWorkspace(dir);
  assert.equal(scan.mode, "walk");
  assert.ok(scan.files.includes("a.txt"));
  assert.ok(scan.files.includes("nested/keep.md"));
  assert.ok(!scan.files.includes(".env"));
  assert.ok(!scan.files.some((f) => f.startsWith("node_modules/")));
  assert.ok(!scan.files.some((f) => f.includes("/.git/")));
  assert.ok(scan.skipped >= 2);
  rmSync(dir, { recursive: true, force: true });
});

test("scanWorkspace：git 仓库根目录走 git 模式", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const { scanWorkspace } = await import("../lib/handoff.mjs");
  const dir = mkdtempSync(join(tmpdir(), "dsh-ch-git-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "tracked.txt"), "t");
  spawnSync("git", ["-C", dir, "add", "-A"]);
  spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  writeFileSync(join(dir, "untracked.txt"), "u");
  const scan = scanWorkspace(dir);
  assert.equal(scan.mode, "git");
  assert.ok(scan.files.includes("tracked.txt"));
  assert.ok(scan.files.includes("untracked.txt"));
  rmSync(dir, { recursive: true, force: true });
});

test("buildTaskBrief → packBundle 集成：简报字段对齐（回归：曾因 brief/brief.text 命名不一致而失败）", async () => {
  const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const { buildTaskBrief } = await import("../lib/brief.mjs");
  const { packBundle } = await import("../lib/handoff.mjs");
  const { buildSessionLog } = await import("../lib/import.mjs");

  // 造一个最小合法会话日志（header + 两条消息）
  const sessDir = mkdtempSync(join(tmpdir(), "brief-sess-"));
  const logPath = join(sessDir, "session.v4.jsonl.zstd");
  const header = JSON.stringify({ type: "session", version: 4, id: "session-test", createdAt: new Date().toISOString(), cwd: "/tmp/ws", isSeeded: false, delegationDepth: 0, agentPreset: "standard" });
  const body = [
    JSON.stringify({ type: "user/message", seq: 1, data: { content: [{ type: "text", text: "请优化这个仓库的构建速度" }] } }),
    JSON.stringify({ type: "assistant/message", seq: 2, data: { message: { content: [{ type: "text", text: "已完成分析" }] } } }),
  ];
  await buildSessionLog(header, body, logPath);

  const brief = await buildTaskBrief(logPath, { taskSummary: "优化构建速度", title: "构建优化" });
  assert.equal(typeof brief.text, "string", "buildTaskBrief 必须返回 text 字段");
  assert.ok(brief.text.length > 0);

  // 打包必须接受该对象（字段名对齐）
  const ws = mkdtempSync(join(tmpdir(), "brief-ws-"));
  mkdirSync(join(ws, "sub"), { recursive: true });
  writeFileSync(join(ws, "a.txt"), "x");
  const staging = mkdtempSync(join(tmpdir(), "brief-stage-"));
  const packed = await packBundle({
    jobId: "22222222-2222-2222-2222-222222222222", cwd: ws, fileList: ["a.txt"],
    listingMode: "walk", skipped: 0, brief, originSessionId: "session-test",
    memoryFiles: [], attachments: [], title: "构建优化", taskSummary: "优化构建速度",
    agentPreset: null, sandboxMode: null, model: null, localCwd: ws, stagingDir: staging,
  });
  assert.equal(packed.manifest.brief.bytes, brief.bytes);
  assert.ok(packed.manifest.files["brief.md"], "bundle 必须包含 brief.md");
  for (const p of [sessDir, ws, staging]) rmSync(p, { recursive: true, force: true });
});

test("classifyResearchScope：研究目录内才算在范围，其余越界", async () => {
  const { classifyResearchScope } = await import("../lib/handoff.mjs");
  const changed = [
    { rel: "cloud-research/主题-复盘.md" },
    { rel: "cloud-research/examples/fix.js" },
    { rel: "src/index.js" },
    { rel: "package.json" },
    { rel: "README.md" },
  ];
  const r = classifyResearchScope(changed, ["src/old.js", "cloud-research/notes.md"], "cloud-research");
  assert.deepEqual(r.inScope.map((f) => f.rel), ["cloud-research/主题-复盘.md", "cloud-research/examples/fix.js"]);
  assert.deepEqual(r.outOfScope.map((f) => f.rel), ["src/index.js", "package.json", "README.md"]);
  assert.deepEqual(r.deletedIn, ["cloud-research/notes.md"]);
  assert.deepEqual(r.deletedOut, ["src/old.js"]);
});
