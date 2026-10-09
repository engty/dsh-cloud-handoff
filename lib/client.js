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
        case "RETURNED": return { color: C.green, label: "云端已完成·待取回" };
        case "FAILED": return { color: C.red, label: "失败" };
        case "DISCARDED": return { color: C.faint, label: "已丢弃" };
        case "MERGE_NEEDED": return { color: C.amber, label: "需手动合并" };
        default: return { color: C.faint, label: "本地" };
      }
    }

    // ---------- 共享状态源（模块级，两个挂载点复用）----------
    var listeners = [];
    var snapshot = { loading: true, state: null, busy: "", error: "", detail: "", detailOpen: false, result: null };
    function emit(patch) {
      // 归一化：一次操作只保留一个结果/错误，避免旧状态与新状态同时显示（出现两行重复提示）
      var next = Object.assign({}, patch);
      if (next.result !== undefined && next.error === undefined) next.error = "";
      if (next.error !== undefined && next.result === undefined && next.error) next.result = null;
      snapshot = Object.assign({}, snapshot, next);
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
    var pollRefs = 0;
    function ensurePolling() {
      pollRefs += 1;
      if (pollTimer !== null) return;
      refresh();
      pollTimer = setInterval(function () {
        if (document.visibilityState === "hidden") return;
        refresh();
      }, 15000);
    }
    function stopPolling() {
      pollRefs = Math.max(0, pollRefs - 1);
      if (pollRefs === 0 && pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
    }

    // ---------- 输入区按钮（conversation.composer.dock）----------
    /** 云朵图标（无边框按钮用）。 */
    function CloudGlyph(size, color) {
      return React.createElement("svg", {
        width: size, height: size, viewBox: "0 0 24 24", fill: "none",
        stroke: color, strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round",
        style: { display: "block" }
      }, React.createElement("path", { d: "M7.2 18.5a4.2 4.2 0 0 1-.2-8.4 5.6 5.6 0 0 1 10.7-1.2 4 4 0 0 1-.4 9.6H7.2Z" }));
    }

    /** 浮动卡片（与上下文面板同风格）。 */
    var PANEL_STYLE = {
      position: "fixed", zIndex: 1100, width: "288px",
      padding: "12px", borderRadius: "12px",
      border: "0.5px solid var(--dsw-alias-border-l4, rgba(128,128,128,0.28))",
      background: "var(--dsw-alias-bg-layer-3, #fff)",
      color: "var(--dsw-alias-label-secondary, #5a6169)",
      boxShadow: "var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,0.18))",
      display: "flex", flexDirection: "column", gap: "10px", fontSize: "12px"
    };

    function ComposerButton(props) {
      var s = useShared();
      var sessionId = props.sessionId;
      var busy = s.busy !== "";
      var active = s.state && s.state.active;
      var running = !!(active && (active.state === "REMOTE_RUNNING" || active.state === "FROZEN" || active.state === "PENDING" || active.state === "RUNNING"));
      var aborted = !!(active && active.state === "ABORTED");
      var returned = !!(active && active.state === "RETURNED");
      var dot = active ? stateDot(active.state) : { color: C.faint, label: "" };

      var openPair = React.useState(false);
      var openPanel = openPair[0];
      var setOpenPanel = openPair[1];
      var placePair = React.useState({ right: 16, bottom: 80 });
      var place = placePair[0];
      var setPlace = placePair[1];
      var summaryPair = React.useState("");
      var summaryText = summaryPair[0];
      var setSummaryText = summaryPair[1];
      var hoverPair = React.useState(false);
      var hovered = hoverPair[0];
      var setHovered = hoverPair[1];
      var wrapRef = React.useRef(null);

      React.useEffect(function () { ensurePolling(); }, []);

      var openIt = function () {
        var r = wrapRef.current && wrapRef.current.getBoundingClientRect();
        if (r) setPlace({ right: Math.max(12, window.innerWidth - r.right), bottom: Math.max(12, window.innerHeight - r.top + 10) });
        setOpenPanel(true);
      };

      // 外部点击 / Esc / 滚动时收起
      React.useEffect(function () {
        if (!openPanel) return undefined;
        var onDown = function (e) { if (!wrapRef.current || !wrapRef.current.contains(e.target)) setOpenPanel(false); };
        var onKey = function (e) { if (e.key === "Escape") setOpenPanel(false); };
        var onScroll = function () { setOpenPanel(false); };
        document.addEventListener("mousedown", onDown, true);
        document.addEventListener("keydown", onKey, true);
        window.addEventListener("scroll", onScroll, true);
        return function () {
          document.removeEventListener("mousedown", onDown, true);
          document.removeEventListener("keydown", onKey, true);
          window.removeEventListener("scroll", onScroll, true);
        };
      }, [openPanel]);

      var doSend = function () {
        emit({ busy: "send", error: "", result: null, detailOpen: false });
        rpc("send", { sessionId: sessionId, taskSummary: summaryText }).then(function (r) {
          emit({
            busy: "", result: { ok: r.ok !== false, text: r.summary || "" },
            detail: r.text || "", error: r.ok === false ? (r.summary || "迁移失败") : "", detailOpen: false
          });
          setSummaryText("");
          return refresh();
        }, function (e) {
          emit({ busy: "", error: String((e && e.message) || e) });
        });
      };

      var doPull = function () {
        emit({ busy: "pull", error: "", result: null });
        rpc("pull", { jobId: active.jobId }).then(function (r) {
          emit({ busy: "", result: r.running ? { ok: true, info: true, text: r.summary || "云端正在执行" } : { ok: r.ok !== false, text: r.summary || "" }, detail: r.text || "", error: (!r.running && r.ok === false) ? (r.summary || "取回失败") : "" });
          return refresh();
        }, function (e) {
          emit({ busy: "", error: String((e && e.message) || e) });
        });
      };

      var run = function (method, label, body, doneLabel) {
        emit({ busy: method, error: "", result: null });
        rpc(method, body || {}).then(function (r) {
          emit({
            busy: "", result: { ok: r.ok !== false, text: r.summary || "" },
            detail: r.text || "", error: r.ok === false ? (r.summary || (label + "失败")) : "", detailOpen: false
          });
          return refresh();
        }, function (e) {
          emit({ busy: "", error: String((e && e.message) || e) });
        });
      };

      var panelBody = function () {
        var feedback = [
          s.error ? React.createElement("p", { key: "e", style: { margin: 0, color: C.red } }, "✗ " + s.error) : null,
          s.result && s.result.info
            ? React.createElement("p", { key: "r", style: { margin: 0, color: C.amber } }, "• " + s.result.text)
            : (s.result ? React.createElement("p", { key: "r", style: { margin: 0, color: s.result.ok ? C.green : C.red } }, (s.result.ok ? "✔ " : "✗ ") + s.result.text) : null)
        ];
        if (running || aborted) {
          return [
            React.createElement("div", { key: "h", style: { display: "flex", alignItems: "center", gap: "6px", color: C.text, fontWeight: 600 } },
              React.createElement("span", { style: Object.assign({}, S.dot, { background: dot.color, animation: running ? "dsh-cloud-pulse 1.6s ease-in-out infinite" : "none" }) }),
              active.stateLabel || dot.label
            ),
            React.createElement("p", { key: "d", style: { margin: 0, color: C.dim } },
              "「" + (active.title || active.jobId.slice(0, 8)) + "」" +
              (active.remoteStartedAt ? " · 云端开始 " + friendly(active.remoteStartedAt) : "") +
              (running ? "。回到本地会自动同步，也可以现在手动拉一次。" : "。中止前的产出可以回收。")
            )
          ].concat(feedback, [
            React.createElement("div", { key: "b", style: { display: "flex", justifyContent: "flex-end", gap: "8px" } },
              React.createElement("button", { type: "button", style: btn("", busy), disabled: busy, onClick: function () { setOpenPanel(false); } }, "取消"),
              React.createElement("button", { type: "button", style: btn("primary", busy), disabled: busy, onClick: doPull },
                busy === "pull" ? "处理中…" : (aborted ? "回收进度" : "取回结果（下载）"))
            )
          ]);
        }
        if (returned) {
          var rcp = active.receipt || {};
          var dl = active.downloaded || {};
          var rows = [];
          rows.push(React.createElement("div", { key: "h", style: { display: "flex", alignItems: "center", gap: "6px", color: C.text, fontWeight: 600 } },
            React.createElement("span", { style: Object.assign({}, S.dot, { background: dot.color }) }),
            "云端已完成 · 待取回"
          ));
          rows.push(React.createElement("p", { key: "s", style: { margin: 0, color: C.dim } },
            (rcp.summary || "（云端无摘要）")
          ));
          if (rcp.finalState === "STOPPED") {
            rows.push(React.createElement("p", { key: "warn", style: { margin: 0, color: C.amber } },
              "⚠ 云端未正常完成（会话回合中断），以下是中断前的产出"
            ));
          }
          rows.push(React.createElement("p", { key: "d", style: S.faint },
            "变更 " + (dl.changed || 0) + " 个文件 · 删除 " + (dl.deleted || 0) + " 个 · 云端会话 " + (dl.tailEvents || 0) + " 个事件" +
            (active.downloadedAt ? " · 下载于 " + friendly(active.downloadedAt) : "")
          ));
          var chList = rcp.changed || [];
          var delList = rcp.deleted || [];
          if (chList.length > 0 || delList.length > 0) {
            var lines = chList.slice(0, 8).map(function (f) { return "· " + f; });
            if (chList.length > 8) lines.push("· …等共 " + chList.length + " 个");
            if (delList.length > 0) {
              lines.push("删除：" + delList.slice(0, 4).join("、") + (delList.length > 4 ? " 等 " + delList.length + " 个" : ""));
            }
            rows.push(React.createElement("pre", {
              key: "fl",
              style: { margin: 0, maxHeight: "132px", overflow: "auto", fontSize: "11px", lineHeight: "1.5", color: C.dim, background: "var(--dsw-alias-bg-secondary, rgba(128,128,128,0.08))", borderRadius: "8px", padding: "6px 8px", whiteSpace: "pre-wrap", wordBreak: "break-all" }
            }, lines.join("\n")));
          }
          rows = rows.concat(feedback);
          rows.push(React.createElement("div", { key: "b", style: { display: "flex", justifyContent: "flex-end", gap: "8px", flexWrap: "wrap" } },
            React.createElement("button", { type: "button", style: btn("", busy), disabled: busy, onClick: function () { run("discard", "丢弃", { jobId: active.jobId }); } }, "丢弃"),
            React.createElement("button", { type: "button", style: btn("", busy), disabled: busy, title: "按文件清单机械落盘（冲突保留 .cloud 副本）", onClick: function () { run("apply", "机械应用", { jobId: active.jobId }); } }, "机械应用"),
            active.injectAt
              ? React.createElement("button", { type: "button", style: btn("primary", busy), disabled: busy, onClick: function () { run("finish-retrieval", "确认完成", { jobId: active.jobId }); } }, busy === "finish-retrieval" ? "处理中…" : "确认完成 · 清理云端")
              : React.createElement("button", { type: "button", style: btn("primary", busy), disabled: busy || !sessionId, onClick: function () { run("inject", "取回", { jobId: active.jobId, sessionId: sessionId }); } }, busy === "inject" ? "派发中…" : "交给当前会话落盘")
          ));
          rows.push(React.createElement("p", { key: "hint", style: S.faint },
            active.injectAt ? "取回指令已交给当前会话（" + friendly(active.injectAt) + "），子智能体落盘完成后回来点「确认完成」。" : "「交给当前会话落盘」会派子智能体读取云端成果并合并到本地，先报清单再动手。"
          ));
          return rows;
        }
        return [
          React.createElement("div", { key: "h", style: { color: C.text, fontWeight: 600 } }, "转为云端运行"),
          React.createElement("textarea", {
            key: "t", rows: 3, value: summaryText, autoFocus: true,
            placeholder: "剩余任务一句话说明（可选）",
            style: Object.assign({}, S.input, { resize: "vertical", minHeight: "56px", fontFamily: "inherit", lineHeight: "1.5", boxSizing: "border-box" }),
            onChange: function (e) { setSummaryText(e.target.value); }
          }),
          React.createElement("p", { key: "n", style: S.faint }, "当前轮先停稳，再把会话 + 工作区 + 记忆打包到云端继续执行。")
        ].concat(feedback, [
          React.createElement("div", { key: "b", style: { display: "flex", justifyContent: "flex-end", gap: "8px" } },
            React.createElement("button", { type: "button", style: btn("", busy), disabled: busy, onClick: function () { setOpenPanel(false); } }, "取消"),
            React.createElement("button", { type: "button", style: btn("primary", busy), disabled: busy || !sessionId, onClick: doSend },
              busy === "send" ? "打包迁移中…" : "发送")
          )
        ]);
      };

      var iconColor = active ? dot.color : (hovered || openPanel ? C.dim : C.faint);
      return React.createElement("span", {
        ref: wrapRef,
        style: { position: "relative", display: "inline-flex", alignItems: "center", alignSelf: "center", flex: "none" }
      },
        React.createElement("button", {
          type: "button",
          title: running ? ("云端执行中 · " + (active.title || "")).trim() : aborted ? "已中止 · 可回收进度" : returned ? "云端已完成 · 待取回" : "转为云端运行",
          disabled: !sessionId,
          onMouseEnter: function () { setHovered(true); },
          onMouseLeave: function () { setHovered(false); },
          onClick: function () { if (openPanel) setOpenPanel(false); else openIt(); },
          style: {
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: "26px", height: "26px", padding: 0, border: "none", borderRadius: "999px",
            background: (hovered || openPanel) ? "var(--dsw-alias-bg-secondary, rgba(128,128,128,0.10))" : "transparent",
            cursor: sessionId ? "pointer" : "default", opacity: sessionId ? 1 : 0.45,
            flex: "none", position: "relative", top: "2px", lineHeight: 0
          }
        },
          CloudGlyph(18, iconColor),
          (running || aborted || returned) ? React.createElement("span", {
            style: {
              position: "absolute", top: "2px", right: "2px", width: "7px", height: "7px", borderRadius: "50%",
              background: dot.color, border: "1px solid var(--dsw-alias-bg-layer-3, #fff)"
            }
          }) : null
        ),
        openPanel ? React.createElement("div", {
          style: Object.assign({}, PANEL_STYLE, { right: place.right + "px", bottom: place.bottom + "px" })
        }, panelBody()) : null
      );
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
      var pairPair = React.useState("");
      var pairCode = pairPair[0];
      var setPairCode = pairPair[1];

      React.useEffect(function () { ensurePolling(); return stopPolling; }, []);

      var doPair = function () {
        emit({ busy: "pair", error: "", result: null });
        rpc("pairing.apply", { code: pairCode }).then(function (r) {
          emit({ busy: "", result: { ok: r.ok !== false, text: r.summary || "" }, detail: r.text || "", error: r.ok === false ? (r.summary || "接入失败") : "", detailOpen: r.ok === false });
          if (r.ok !== false) setPairCode("");
          return refresh();
        }, function (e) {
          emit({ busy: "", error: String((e && e.message) || e), detailOpen: true });
        });
      };

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
      var doRecover = function () {
        if (!active) return;
        emit({ busy: "pull", error: "", result: null });
        rpc("pull", { jobId: active.jobId }).then(function (r) {
          emit({
            busy: "",
            result: r.running ? { ok: true, info: true, text: r.summary || "云端正在执行" } : { ok: r.ok !== false, text: r.summary || "" },
            detail: r.text || "",
            error: (!r.running && r.ok === false) ? (r.summary || "回收失败") : "",
            detailOpen: (!r.running && r.ok === false)
          });
          return refresh();
        }, function (e) {
          emit({ busy: "", error: String((e && e.message) || e), detailOpen: true });
        });
      };

      var doDiscard = function () {
        if (!active) return;
        emit({ busy: "discard", error: "" });
        rpc("discard", { jobId: active.jobId }).then(function (r) {
          emit({ busy: "", result: { ok: r.ok !== false, text: r.summary || "" }, error: r.ok === false ? (r.summary || "丢弃失败") : "" });
          return refresh();
        }, function (e) {
          emit({ busy: "", error: String((e && e.message) || e), detailOpen: true });
        });
      };

      var busy = s.busy !== "";
      var dot = active ? stateDot(active.state) : { color: C.green, label: "空闲" };

      var paired = Boolean(cfg.tokenConfigured && cfg.host);
      var ops = (st.recentOps || []);
      var opLabel = { send: "发送任务", download: "取回结果", "auto-download": "自动取回", apply: "机械应用", inject: "交给会话落盘", finish: "确认完成", discard: "丢弃结果", abort: "中止任务", pairing: "完成接入" };
      return React.createElement("div", { style: S.page },
        ops.length > 0 ? React.createElement("div", { style: S.card },
          React.createElement("div", { style: S.head },
            React.createElement("h3", { style: S.title }, "最近操作"),
            React.createElement(Badge, { color: C.dim, label: ops.length + " 条" })
          ),
          React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
            ops.slice(0, 6).map(function (op, i) {
              return React.createElement("div", { key: i, style: { display: "flex", gap: "8px", fontSize: "12px", color: C.dim } },
                React.createElement("span", { style: { color: C.text, minWidth: "76px" } }, opLabel[op.action] || op.action),
                React.createElement("span", { style: { flex: "1 1 auto" } }, String(op.note || op.jobId || "").slice(0, 60)),
                React.createElement("span", { style: { flex: "none", color: C.faint } }, friendly(op.at))
              );
            })
          )
        ) : null,
        React.createElement("div", { style: S.card },
          React.createElement("div", { style: S.head },
            React.createElement("h3", { style: S.title }, "云端接入"),
            React.createElement(Badge, {
              color: paired ? C.green : C.amber,
              label: paired ? ("已接入 · " + (cfg.sshUser || "dshcloud") + "@" + cfg.host) : "未接入"
            })
          ),
          React.createElement("p", { style: S.faint },
            "在你自己的一台 Linux 服务器上运行一键脚本，把脚本最后打印的「对接码」粘贴到这里即可完成云端与本地端的对接。"
          ),
          React.createElement("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
            React.createElement("input", {
              type: "text", value: pairCode, placeholder: "DSHCP1:…（脚本输出的对接码）",
              style: Object.assign({}, S.input, { flex: "1 1 auto" }),
              onChange: function (e) { setPairCode(e.target.value); },
              onKeyDown: function (e) { if (e.key === "Enter") doPair(); }
            }),
            React.createElement("button", { type: "button", style: btn("primary", s.busy !== ""), disabled: s.busy !== "" || !pairCode.trim(), onClick: doPair },
              s.busy === "pair" ? "接入中…" : "解析并接入")
          ),
          s.result && s.busy !== "pair" ? React.createElement("p", { style: { margin: 0, fontSize: "12px", color: s.result.ok ? C.green : C.red } }, (s.result.ok ? "✔ " : "✗ ") + s.result.text) : null,
          React.createElement("p", { style: S.faint },
            "也可以跳过对接码：展开下方「高级」手动填主机 / SSH 用户 / 端口 / Token（Token 在服务器 /home/dshcloud/.dsh/dsh-cloud-handoff/config.json）。"
          )
        ),
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
            active && active.state === "ABORTED"
              ? React.createElement("button", { type: "button", style: btn("", busy), disabled: busy, onClick: doRecover }, busy === "pull" ? "回收中…" : "回收中止前产出")
              : null,
            active && active.state === "RETURNED"
              ? [
                  React.createElement("button", { key: "a", type: "button", style: btn("", busy), disabled: busy, onClick: function () { doRecover(); } }, "机械应用"),
                  React.createElement("button", { key: "d", type: "button", style: btn("danger", busy), disabled: busy, onClick: function () { doDiscard(); } }, "丢弃")
                ]
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
      // 样式注入一次：脉冲动画 + 让底部信息栏收窄到内容宽度
      // （信息栏默认 width:100% 会把云朵顶到最右边；收窄后整簇居中，云朵紧贴上下文圆环）
      try {
        if (!document.getElementById("dsh-cloud-handoff-style")) {
          var styleEl = document.createElement("style");
          styleEl.id = "dsh-cloud-handoff-style";
          styleEl.textContent =
            "@keyframes dsh-cloud-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }\n" +
            ".bi-root { width: fit-content !important; max-width: 100% !important; }";
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
