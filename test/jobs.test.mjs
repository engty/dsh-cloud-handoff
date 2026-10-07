import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore, CloudJobs, LOCAL_STATES, CLOUD_STATES, stateLabel } from "../lib/jobs.mjs";

test("状态机包含 ABORTED（本地与云端）", () => {
  assert.ok(LOCAL_STATES.includes("ABORTED"));
  assert.ok(CLOUD_STATES.includes("ABORTED"));
  assert.equal(stateLabel("ABORTED"), "已中止");
  assert.equal(stateLabel("REMOTE_RUNNING"), "云端执行中");
});

test("JobStore：abort 保留 active 供回收，pull 后清空", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-ch-jobs-"));
  const file = join(dir, "jobs.json");
  const store = new JobStore(file);
  store.patch("j1", { state: "REMOTE_RUNNING", title: "t" });
  store.setActive("j1");
  assert.equal(store.active, "j1");
  // 中止：置 ABORTED、保留 active
  store.patch("j1", { state: "ABORTED", abortedAt: "x", abortedSummary: { changed: 2, tailEvents: 30 } });
  assert.equal(store.activeJob.state, "ABORTED");
  assert.deepEqual(store.activeJob.abortedSummary, { changed: 2, tailEvents: 30 });
  // 回收完成：SYNCED、清 active
  store.patch("j1", { state: "SYNCED", pulledAt: "y" });
  store.setActive(null);
  assert.equal(store.active, null);
  const reloaded = new JobStore(file);
  assert.equal(reloaded.get("j1").state, "SYNCED");
  rmSync(dir, { recursive: true, force: true });
});

test("CloudJobs：ABORTED 后 DONE 保护仍生效（完成态只读）", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-ch-cjobs-"));
  const jobs = new CloudJobs(dir);
  jobs.patch("j1", { state: "ABORTED", receipt: { summary: "（本地中止）" } });
  // 完成态只读：再 patch 不覆盖（CloudJobs 保护 DONE；ABORTED 也应按终态处理——验证当前行为）
  const after = jobs.patch("j1", { state: "DONE" });
  assert.equal(after.state, "ABORTED");
  rmSync(dir, { recursive: true, force: true });
});
