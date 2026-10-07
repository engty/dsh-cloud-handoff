/**
 * dsh-cloud-handoff — 客户端半边
 *
 * 界面目标（按用户偏好）：
 *   - 输入区一个「转为云端运行」按钮：当前状态 + 点击后的结果
 *   - 设置页：状态卡 + 测试连通 + 高级（默认折叠，路径类自动识别不暴露）
 *   - 详情小眼睛折叠；出错自动展开；时间人类可读（今天 15:19）
 *
 * 注意：宿主热应用/注册时会导入本模块，Node 环境无 window——守卫后跳过执行，
 * 仅在浏览器端由 __ModuleLoader__ 装载。
 */
if (typeof window === "undefined") {
  // 宿主环境：客户端模块不执行，仅占位导出
} else if (window.__ModuleLoader__) {
window.__ModuleLoader__.load({
  id: "dsh-cloud-handoff",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");

    var PACKAGE_ID = "dsh-cloud-handoff";
    var RPC_BASE = "/_dsh/dsh-cloud-handoff";
    var RPC_TIMEOUT_MS = 300000;
    var inject = ["slots"];

    function rpc(method, body) {
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, RPC_TIMEOUT_MS);
      return fetch(RPC_BASE + "/" + method, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
        credentials: "same-origin",
        signal: controller.signal
      }).then(function (res) {
        clearTimeout(timer);
        return res.text().then(function (raw) {
          var parsed = null;
          try { parsed = JSON.parse(raw); } catch (e) { /* 非 JSON */ }
          if (!res.ok) throw new Error((parsed && parsed.error) || ("HTTP " + res.status));
          return parsed;
        });
      }, function (error) {
        clearTimeout(timer);
        throw error;
      });
    }

    // ---------- 样式 ----------
    var C = {
      text: "var(--dsw-alias-label-primary, #1f2328)",
      dim: "var(--dsw-alias-label-secondary, #5a6169)",
      faint: "var(--dsw-alias-label-tertiary, #8a9099)",
      line: "var(--dsw-alias-line, rgba(128,128,128,0.25))",
      input: "var(--dsw-alias-bg-input, rgba(128,128,128,0.06))",
      soft: "var(--dsw-alias-bg-secondary, rgba(128,128,128,0.08))",
      accent: "var(--dsw-alias-fill-accent, #4b6bff)",
      green: "#2f9e44",
      amber: "#e8930c",
      red: "#d4380d"
    };
    var S = {
      page: { display: "flex", flexDirection: "column", gap: "16px", padding: "20px 22px", fontSize: "13px", lineHeight: "1.6", color: C.text },
      card: { border: "1px solid " + C.line, borderRadius: "10px", padding: "16px 18px", display: "flex", flexDirection: "column", gap: "12px" },
      head: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" },
      title: { fontSize: "14px", fontWeight: 600, margin: 0 },
      badge: { display: "inline-flex", alignItems: "center", gap: "6px", padding: "3px 10px", borderRadius: "999px", background: C.soft, fontSize: "12px", color: C.dim, whiteSpace: "nowrap" },
      dot: { width: "7px", height: "7px", borderRadius: "50%", flex: "0 0 auto" },
      sub: { margin: 0, fontSize: "12px", color: C.dim },
      faint: { margin: 0, fontSize: "12px", color: C.faint },
      row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" },
      buttons: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" },
      pre: { margin: 0, padding: "10px 12px", borderRadius: "8px", background: C.soft, fontSize: "12px", lineHeight: "1.5", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: "300px", overflow: "auto", color: C.dim, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
      input: { boxSizing: "border-box", width: "100%", padding: "6px 8px", fontSize: "13px", borderRadius: "7px", border: "1px solid " + C.line, background: C.input, color: C.text },
      link: { background: "none", border: "none", padding: 0, fontSize: "12px", color: C.faint, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "4px" },
      divider: { height: "1px", background: C.line, margin: 0, border: 0 }
    };
    function btn(kind, disabled) {
      var base = { padding: "6px 14px", fontSize: "13px", borderRadius: "7px", cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1, whiteSpace: "nowrap" };
      if (kind === "primary") return Object.assign(base, { border: "1px solid transparent", background: "var(--dsw-alias-bg-invert, #1f2328)", color: "var(--dsw-alias-label-invert, #fff)" });
      if (kind === "danger") return Object.assign(base, { border: "1px solid " + C.red, background: "transparent", color: C.red });
      return Object.assign(base, { border: "1px solid " + C.line, background: "transparent", color: C.text });
    }
    function eyeIcon(open) {
      var props = { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", style: { display: "block" } };
      return React.createElement("svg", props,
        React.createElement("path", { d: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" }),
        React.createElement("circle", { cx: 12, cy: 12, r: 3 }),
        open ? React.createElement("line", { x1: 4, y1: 20, x2: 20, y2: 4 }) : null
      );
    }
    function Badge(props) {
      return React.createElement("span", { style: S.badge },
        React.createElement("span", { style: Object.assign({}, S.dot, { background: props.color }) }),
        props.label
      );
    }
    /** ISO → 「今天 15:19 / 昨天 09:04 / 10-05 15:19」。 */
    function friendly(at) {
      if (!at) return "";
      var d = new Date(at);
      if (isNaN(d.getTime())) return "";
      var now = new Date();
      var hm = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
      if (d.toDateString() === now.toDateString()) return "今天 " + hm;
      var y = new Date(now.getTime() - 86400000);
      if (d.toDateString() === y.toDateString()) return "昨天 " + hm;
      return (d.getMonth() + 1) + "-" + ("0" + d.getDate()).slice(-2) + " " + hm;
    }
    function stateDot(state) {
      switch (state) {
        case "SYNCED": case "DONE": return { color: C.green, label: "已同步" };
        case "REMOTE_RUNNING": case "RUNNING": return { color: C.amber, label: "云端执行中" };
        case "FROZEN": case "PENDING": return { color: C.amber, label: "迁移中…" };
        case "FAILED": return { color: C.red, label: "失败" };
        case "MERGE_NEEDED": return { color: C.amber, label: "需手动合并" };
        default: return { color: C.faint, label: "本地" };
      }
    }

    // ---------- 共享状态源（模块级，两个挂载点复用）----------
    var listeners = [];
    var snapshot = { loading: true, state: null, busy: "", error: "", detail: "", detailOpen: false, result: null };
    function emit(patch) {
      snapshot = Object.assign({}, snapshot, patch);
      listeners.forEach(function (fn) { fn(snapshot); });
    }
    function refresh() {
      return rpc("state").then(function (r) {
        emit({ state: r || null, loading: false });
      }, function (e) {
        emit({ loading: false, error: String((e && e.message) || e) });
      });
    }
    function useShared() {
      return React.useSyncExternalStore(
        function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },
        function () { return snapshot; },
        function () { return snapshot; }
      );
    }
    var pollTimer = null;
    function ensurePolling() {
      if (pollTimer !== null) return;
      refresh();
      pollTimer = setInterval(function () {
        if (document.visibilityState === "hidden") return;
        refresh();
      }, 15000);
    }
    function stopPolling() { if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; } }

    // ---------- 输入区按钮（conversation.composer.dock）----------
    function ComposerButton(props) {
      var s = useShared();
      var sessionId = props.sessionId;
      var busy = s.busy !== "";
      var active = s.state && s.state.active;
      var dot = active ? stateDot(active.state) : { color: C.faint, label: "" };

      var panelOpen = React.useState(false);
      var openPanel = panelOpen[0];
      var setOpenPanel = panelOpen[1];
      var summary = React.useState("");
      var summaryText = summary[0];
      var setSummaryText = summary[1];

      var doSend = function () {
        setOpenPanel(false);
        emit({ busy: "send", error: "", detail: "", detailOpen: false, result: null });
        rpc("send", { sessionId: sessionId, taskSummary: summaryText }).then(function (r) {
          emit({
            busy: "",
            result: { ok: r.ok !== false, text: r.summary || "" },
            detail: r.text || "",
            detailOpen: false,
            error: r.ok === false ? (r.summary || "迁移失败") : ""
          });
          return refresh();
        }, function (e) {
          emit({ busy: "", error: String((e && e.message) || e), detailOpen: true });
        });
      };

      if (active && (active.state === "REMOTE_RUNNING" || active.state === "FROZEN" || active.state === "PENDING" || active.state === "RUNNING")) {
        var doPull = function () {
          emit({ busy: "pull", error: "", result: null });
          rpc("pull", { jobId: active.jobId }).then(function (r) {
            emit({ busy: "", result: { ok: r.ok !== false, text: r.summary || "" }, detail: r.text || "", error: r.ok === false ? (r.summary || "同步失败") : "", detailOpen: r.ok === false });
            return refresh();
          }, function (e) {
            emit({ busy: "", error: String((e && e.message) || e), detailOpen: true });
          });
        };
        return React.createElement("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px" }, title: active.stateLabel || "云端执行中" },
          React.createElement("span", { style: Object.assign({}, S.dot, { background: dot.color, animation: "dsh-cloud-pulse 1.6s ease-in-out infinite" }) }),
          React.createElement("button", { type: "button", style: btn("", busy), disabled: busy, onClick: doPull },
            busy === "pull" ? "同步中…" : (active.state === "REMOTE_RUNNING" ? "云端执行中 · 查看进度" : "同步结果"))
        );
      }

      if (openPanel) {
        return React.createElement("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px" } },
          React.createElement("input", {
            type: "text", placeholder: "剩余任务一句话说明（可选）", value: summaryText,
            style: Object.assign({}, S.input, { width: "220px" }),
            onChange: function (e) { setSummaryText(e.target.value); },
            onKeyDown: function (e) { if (e.key === "Enter") doSend(); if (e.key === "Escape") setOpenPanel(false); }
          }),
          React.createElement("button", { type: "button", style: btn("primary", busy), disabled: busy, onClick: doSend },
            busy === "send" ? "打包迁移中…" : "确认转云端"),
          React.createElement("button", { type: "button", style: btn("", false), onClick: function () { setOpenPanel(false); } }, "取消")
        );
      }

      return React.createElement("button", {
        type: "button", title: "结束当前轮 → 打包会话与工作区 → 云端继续执行；回本地自动同步结果",
        style: btn("", busy),
        disabled: !sessionId || busy,
        onClick: function () { setOpenPanel(true); }
      }, "☁ 转为云端运行");
    }

    // ---------- 设置页 ----------
    function FieldRow(props) {
      return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
        React.createElement("label", { style: { fontSize: "12px", color: C.dim } }, props.label),
        React.createElement("input", {
          type: "text", defaultValue: props.value || "", placeholder: props.placeholder, style: S.input,
          onBlur: function (event) { if (event.target.value !== (props.value || "")) props.onCommit(event.target.value); },
          onKeyDown: function (event) { if (event.key === "Enter") event.target.blur(); }
        }),
        props.hint ? React.createElement("p", { style: S.faint }, props.hint) : null
      );
    }

    function SettingsPanel() {
      var s = useShared();
      var advancedOpen = React.useState(false);
      var st = s.state || {};
      var cfg = (st.config || {});
      var active = st.active;

      React.useEffect(function () { ensurePolling(); return stopPolling; }, []);

      var save = function (patch) {
        return rpc("config.set", { patch: patch }).then(function (r) { emit({ state: Object.assign({}, s.state, { config: r.config }) }); });
      };
      var testConn = function () {
        emit({ busy: "test", error: "", detailOpen: false, result: null });
        rpc("test-connection").then(function (r) {
          var detailText = (r.steps || []).map(function (x) { return (x.ok ? "✔ " : "✗ ") + x.name + "：" + (x.detail || ""); }).join("\n");
          emit({
            busy: "", result: { ok: r.ok, text: r.ok ? "云端连接正常" : "云端连接失败" },
            detail: detailText, detailOpen: !r.ok, error: r.ok ? "" : "云端连接失败"
          });
        }, function (e) {
          emit({ busy: "", error: String((e && e.message) || e), detailOpen: true });
        });
      };
      var doAbort = function () {
        if (!active) return;
        emit({ busy: "abort", error: "" });
        rpc("abort", { jobId: active.jobId }).then(function (r) {
          emit({ busy: "", result: { ok: r.ok !== false, text: r.summary || "" }, error: r.ok === false ? (r.summary || "中止失败") : "" });
          return refresh();
        }, function (e) {
          emit({ busy: "", error: String((e && e.message) || e), detailOpen: true });
        });
      };

      var busy = s.busy !== "";
      var dot = active ? stateDot(active.state) : { color: C.green, label: "空闲" };

      return React.createElement("div", { style: S.page },
        React.createElement("div", { style: S.card },
          React.createElement("div", { style: S.head },
            React.createElement("h3", { style: S.title }, "云接力"),
            React.createElement(Badge, { color: dot.color, label: active ? (active.stateLabel || dot.label) : dot.label })
          ),
          React.createElement("p", { style: S.sub },
            active
              ? ("任务「" + (active.title || active.jobId.slice(0, 8)) + "」" + (active.remoteStartedAt ? " · 云端开始于 " + friendly(active.remoteStartedAt) : "") + (active.pulledAt ? " · 已同步于 " + friendly(active.pulledAt) : ""))
              : "没有任务在云端执行。在会话输入区点「转为云端运行」即可把任务迁到云端继续。" + (st.lastOp ? " 上次操作：" + st.lastOp.summary + " · " + friendly(st.lastOp.at) : "")
          ),
          s.error ? React.createElement("p", { style: { margin: 0, fontSize: "12px", color: C.red } }, "✗ " + s.error) : null,
          s.result ? React.createElement("p", { style: { margin: 0, fontSize: "12px", color: s.result.ok ? C.green : C.red } }, (s.result.ok ? "✔ " : "✗ ") + s.result.text) : null,
          React.createElement("div", { style: S.buttons },
            React.createElement("button", { type: "button", style: btn("", busy), disabled: busy, onClick: testConn }, busy === "test" ? "测试中…" : "测试连通"),
            active && (active.state === "REMOTE_RUNNING" || active.state === "RUNNING")
              ? React.createElement("button", { type: "button", style: btn("danger", busy), disabled: busy, onClick: doAbort }, "中止云端任务")
              : null,
            React.createElement("button", {
              type: "button", style: Object.assign({}, S.link, { marginLeft: "auto" }),
              onClick: function () { emit({ detailOpen: !s.detailOpen }); }
            }, eyeIcon(s.detailOpen), s.detailOpen ? "收起详情" : "详情")
          ),
          s.detailOpen ? React.createElement("pre", { style: S.pre }, s.detail || JSON.stringify(active || {}, null, 2)) : null
        ),
        React.createElement("div", { style: S.card },
          React.createElement("button", { type: "button", style: S.link, onClick: function () { advancedOpen[1](!advancedOpen[0]); } },
            (advancedOpen[0] ? "▾ 高级" : "▸ 高级") + "（一般无需修改，路径自动识别）"
          ),
          advancedOpen[0] ? React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } },
            React.createElement("p", { style: S.faint }, "云端执行端：" + (st.connectivity ? st.connectivity.user + "@" + st.connectivity.host + "（RPC 端口 " + st.connectivity.port + "）" : "未配置")),
            React.createElement(FieldRow, { label: "云端主机（SSH 别名或地址）", value: cfg.host, placeholder: "默认 dsh-cloud", onCommit: function (v) { save({ host: v }); } }),
            React.createElement(FieldRow, { label: "SSH 用户", value: cfg.sshUser, placeholder: "默认 dshcloud", onCommit: function (v) { save({ sshUser: v }); } }),
            React.createElement(FieldRow, { label: "SSH 端口（0 = 默认 22）", value: String(cfg.sshPort || ""), placeholder: "0", onCommit: function (v) { save({ sshPort: Number(v) || 0 }); } }),
            React.createElement(FieldRow, { label: "云端 RPC 端口", value: String(cfg.remotePort || ""), placeholder: "39127", onCommit: function (v) { save({ remotePort: Number(v) || 39127 }); } }),
            React.createElement(FieldRow, { label: "云端鉴权 token", value: cfg.tokenConfigured ? "（已配置，不回显）" : "", placeholder: "与云端 config.json 的 token 一致", onCommit: function (v) { if (v) save({ token: v }); } }),
            React.createElement("p", { style: S.faint }, "token 在云端 /home/dshcloud/.dsh/dsh-cloud-handoff/config.json（云端自动生成）。")
          ) : null
        )
      );
    }

    function apply(ctx) {
      try {
        ctx.slots.inject("conversation.composer.dock", function () {
          return ctx.slots.register({
            name: "conversation.composer.dock",
            id: PACKAGE_ID,
            order: 60
          }, function (props) { return React.createElement(ComposerButton, props || {}); });
        });
      } catch (error) {
        console.error("[dsh-cloud-handoff] 输入区按钮注册失败：", error);
      }
      try {
        ctx.slots.inject("settings.section", function () {
          return ctx.slots.register({
            name: "settings.section",
            id: PACKAGE_ID,
            order: 76,
            label: function () { return "云接力"; },
            locale: PACKAGE_ID
          }, function () { return React.createElement(SettingsPanel, null); });
        });
      } catch (error) {
        console.error("[dsh-cloud-handoff] 设置页注册失败：", error);
      }
      try {
        ctx.slots.inject("plugins.bundle.config", function () {
          return ctx.slots.register({
            name: "plugins.bundle.config",
            key: PACKAGE_ID,
            locale: PACKAGE_ID
          }, function () { return React.createElement(SettingsPanel, null); });
        });
      } catch (error) {
        console.error("[dsh-cloud-handoff] 配置卡注册失败：", error);
      }
      // 脉冲动画注入一次
      try {
        if (!document.getElementById("dsh-cloud-handoff-style")) {
          var styleEl = document.createElement("style");
          styleEl.id = "dsh-cloud-handoff-style";
          styleEl.textContent = "@keyframes dsh-cloud-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }";
          document.head.appendChild(styleEl);
        }
      } catch (e) { /* 忽略 */ }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
}
