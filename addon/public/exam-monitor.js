"use strict";
(() => {
  // addon/frontend/monitor.ts
  var message = document.getElementById("em-msg");
  var grid = document.getElementById("em-grid");
  var statsHost = document.getElementById("em-stats");
  var modal = document.getElementById("em-modal");
  var modalBody = document.getElementById("em-modal-body");
  var modalTitle = document.getElementById("em-modal-title");
  var LABELS = {
    UNREACHABLE: "\u8BBE\u5907\u4E0D\u53EF\u8FBE",
    TLS_FAILED: "\u8BC1\u4E66\u6821\u9A8C\u5931\u8D25",
    AUTH_FAILED: "\u8BA4\u8BC1\u5931\u8D25",
    FRAME_UNAVAILABLE: "\u753B\u9762\u4E0D\u53EF\u7528",
    TIMEOUT: "\u4EFB\u52A1\u8D85\u65F6",
    IMAGE_TOO_LARGE: "\u56FE\u7247\u8FC7\u5927",
    CANCELLED: "\u5DF2\u53D6\u6D88",
    INVALID_JPEG: "\u56FE\u7247\u683C\u5F0F\u9519\u8BEF",
    CAPTURE_FAILED: "\u91C7\u96C6\u5931\u8D25"
  };
  var AGENT_STALE_MS = 9e4;
  function time(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  }
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== void 0) node.textContent = text;
    return node;
  }
  function show(text, isError = false) {
    message.textContent = text;
    message.className = isError ? "em-msg err" : "em-msg";
  }
  function imageUrl(id) {
    return `${location.pathname}?image=${encodeURIComponent(id)}`;
  }
  async function action(act, extra = {}) {
    const response = await fetch(location.pathname, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: act, ...extra }) });
    if (!response.ok) throw new Error(`\u64CD\u4F5C\u5931\u8D25 (${response.status})`);
    const data = await response.json().catch(() => ({}));
    show(data.message || "\u64CD\u4F5C\u5DF2\u63D0\u4EA4");
    await refresh();
  }
  function openModal(title, content) {
    modalTitle.textContent = title;
    modalBody.replaceChildren(content);
    modal.classList.add("open");
  }
  function groupSuspects(list) {
    const map = /* @__PURE__ */ new Map();
    for (const s of list || []) {
      const entry = map.get(s.n) || { n: s.n, count: 0 };
      entry.count++;
      map.set(s.n, entry);
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }
  function groupText(list, limit = 4) {
    return groupSuspects(list).slice(0, limit).map((g) => g.count > 1 ? `${g.n}\xD7${g.count}` : g.n).join("\u3001");
  }
  function agentState(agent) {
    if (!agent) return { state: "wait", text: "\u91C7\u96C6\u811A\u672C\u672A\u90E8\u7F72" };
    if (Date.now() - (agent.at || 0) > AGENT_STALE_MS) return { state: "err", text: `\u91C7\u96C6\u5DF2\u505C\u6B62 \xB7 \u6700\u540E ${time(agent.at)}` };
    const suspects = agent.suspects || [];
    if (suspects.length) return { state: "err", text: `\u53EF\u7591\uFF1A${groupText(suspects)}` };
    return { state: "ok", text: `\u8FDB\u7A0B\u6B63\u5E38 \xB7 ${time(agent.at)}` };
  }
  function renderCard(mapping, row, runtime, okAt, agent) {
    const card = el("article", "em-card");
    const latest = row && row.latest;
    const error = latest && latest.error;
    const hasImage = !!(latest && latest._id && !error);
    const proc = agentState(agent);
    const suspectCount = (agent?.suspects || []).length;
    card.dataset.state = hasImage ? suspectCount ? "warn" : "ok" : error ? "err" : "wait";
    const shot = el("a", hasImage ? "em-shot" : "em-shot empty");
    if (hasImage) {
      shot.setAttribute("href", imageUrl(latest._id));
      shot.setAttribute("target", "_blank");
      const img = el("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = `\u5B66\u751F ${mapping.studentId}`;
      img.src = imageUrl(latest._id);
      shot.append(img);
    } else {
      shot.dataset.text = error ? LABELS[error] ?? error : "\u7B49\u5F85\u9996\u6B21\u753B\u9762";
    }
    if (suspectCount) {
      const badge = el("span", "em-badge", `\u53EF\u7591 ${suspectCount}`);
      shot.append(badge);
    }
    const body = el("div", "em-body");
    const idLine = el("div", "em-id");
    idLine.append(document.createTextNode(`\u5B66\u751F ${mapping.studentId}`), el("span", "em-ip", mapping.deviceId));
    body.append(idLine);
    let stateText;
    let stateCls;
    if (hasImage) {
      stateText = `\u622A\u56FE\u6210\u529F \xB7 ${time(latest.completedAt)}`;
      stateCls = "ok";
    } else if (error) {
      stateText = `${LABELS[error] ?? error} \xB7 ${time(latest.completedAt)}`;
      stateCls = "err";
    } else {
      stateText = "\u7B49\u5F85\u9996\u6B21\u68C0\u6D4B";
      stateCls = "wait";
    }
    body.append(el("div", `em-line ${stateCls}`, stateText));
    let queue;
    if (runtime?.pending) queue = `\u6392\u961F ${Math.round(runtime.queueDelayMs / 1e3)} \u79D2`;
    else if (runtime?.running) queue = "\u6B63\u5728\u91C7\u96C6";
    else queue = "\u7B49\u5F85\u4E0B\u6B21\u68C0\u6D4B";
    body.append(el("div", "em-line", `${queue}${okAt ? ` \xB7 \u6700\u8FD1\u6210\u529F ${time(okAt)}` : ""}`));
    body.append(el("div", `em-line ${proc.state}`, proc.text));
    const mini = el("div", "em-mini");
    const shotBtn = el("button", "", "\u62BD\u67E5");
    shotBtn.onclick = () => void action("capture", { studentId: mapping.studentId }).catch(showError);
    const historyBtn = el("button", "", "\u5386\u53F2");
    historyBtn.onclick = () => void loadHistory(mapping.studentId).catch(showError);
    const recordBtn = el("button", "", "\u8BB0\u5F55");
    recordBtn.onclick = () => void loadRecords(mapping.studentId).catch(showError);
    mini.append(shotBtn, historyBtn, recordBtn);
    if (agent) {
      const procBtn = el("button", "", "\u8FDB\u7A0B");
      procBtn.onclick = () => void loadProcesses(mapping.studentId).catch(showError);
      mini.append(procBtn);
    }
    body.append(mini);
    card.append(shot, body);
    return card;
  }
  function renderStats(data) {
    const rows = data.rows || [];
    const byId = new Map(rows.map((r) => [r._id, r.latest]));
    const agents = new Map((data.agents || []).map((a) => [a._id, a]));
    let ok = 0, err = 0, wait = 0, suspect = 0, stale = 0;
    for (const m of data.mappings) {
      const latest = byId.get(m.studentId);
      if (!latest) wait++;
      else if (latest.error) err++;
      else ok++;
      const agent = agents.get(m.deviceId);
      if (agent) {
        if ((agent.suspects || []).length) suspect++;
        if (Date.now() - (agent.at || 0) > AGENT_STALE_MS) stale++;
      }
    }
    statsHost.replaceChildren();
    const add = (cls, value, label) => {
      const box = el("div", `em-stat ${cls}`);
      box.append(el("b", "", value), document.createTextNode(label));
      statsHost.append(box);
    };
    add("", String(data.mappings.length), "\u53F0\u5728\u76D1");
    add("ok", String(ok), "\u753B\u9762\u6B63\u5E38");
    add("err", String(err), "\u6709\u5F02\u5E38");
    add("wait", String(wait), "\u7B49\u5F85\u9996\u6B21");
    if (suspect) add("err", String(suspect), "\u53EF\u7591\u7A0B\u5E8F");
    if (stale) add("wait", String(stale), "\u91C7\u96C6\u4E2D\u65AD");
    const live = el("div", "em-live");
    const collectorStale = !data.collectorSeenAt || Date.now() - data.collectorSeenAt > 1e4;
    live.append(el("span", `em-dot ${data.active ? collectorStale ? "off" : "on" : ""}`));
    live.append(document.createTextNode(data.active ? collectorStale ? "\u91C7\u96C6\u8FDB\u7A0B\u65E0\u54CD\u5E94" : "\u91C7\u96C6\u8FDB\u7A0B\u6B63\u5E38" : "\u672A\u5F00\u59CB\u76D1\u8003"));
    statsHost.append(live);
  }
  async function loadHistory(studentId) {
    const response = await fetch(`${location.pathname}?history=${studentId}`);
    if (!response.ok) throw new Error("\u65E0\u6CD5\u8BFB\u53D6\u5386\u53F2\u753B\u9762");
    const { rows } = await response.json();
    const box = el("div", "em-hgrid");
    if (!rows.length) box.append(el("div", "em-empty", "\u8FD8\u6CA1\u6709\u5386\u53F2\u753B\u9762"));
    for (const row of rows) {
      const item = el("a", "em-hitem");
      item.href = imageUrl(row._id);
      item.target = "_blank";
      const img = el("img");
      img.loading = "lazy";
      img.src = imageUrl(row._id);
      img.alt = "";
      item.append(img, el("div", "", `${time(row.completedAt)} \xB7 ${Math.round((row.bytes || 0) / 1024)} KB`));
      box.append(item);
    }
    openModal(`\u5B66\u751F ${studentId} \xB7 \u5386\u53F2\u753B\u9762\uFF08${rows.length} \u5F20\uFF09`, box);
  }
  async function loadProcesses(studentId) {
    const response = await fetch(`${location.pathname}?processes=${studentId}`);
    if (!response.ok) throw new Error("\u65E0\u6CD5\u8BFB\u53D6\u8FDB\u7A0B\u5217\u8868");
    const { agent } = await response.json();
    if (!agent) {
      show("\u8FD9\u53F0\u673A\u5668\u8FD8\u6CA1\u6709\u4E0A\u62A5\u8FC7", true);
      return;
    }
    showProcesses({ studentId }, agent);
  }
  function showProcesses(mapping, agent) {
    const wrap = el("div", "em-proc");
    const meta = el(
      "div",
      "em-proc-meta",
      `\u4E3B\u673A ${agent.host || "-"} \xB7 \u7528\u6237 ${agent.user || "-"} \xB7 \u6700\u540E\u4E0A\u62A5 ${time(agent.at)} \xB7 \u5171 ${(agent.items || []).length} \u4E2A\u8FDB\u7A0B`
    );
    wrap.append(meta);
    const suspects = agent.suspects || [];
    if (suspects.length) {
      const names = groupSuspects(suspects).map((g) => `${g.n}${g.count > 1 ? `\xD7${g.count}` : ""}`).join("\u3001");
      wrap.append(el("div", "em-proc-alert", `\u53EF\u7591\u8FDB\u7A0B ${suspects.length} \u4E2A\uFF1A${names}`));
    }
    const all = agent.items || [];
    const isBad = (i) => suspects.some((s) => s.n === i.n);
    const row = (item) => {
      const line = el("div", isBad(item) ? "em-proc-row bad" : "em-proc-row");
      const pid = item.p ? ` (pid ${item.p})` : "";
      line.append(el("b", "", item.n), document.createTextNode(`${pid}${item.t ? ` \xB7 ${item.t}` : ""}`), el("span", "em-proc-mem", `${Math.round((item.m || 0) / 1024)} MB`));
      return line;
    };
    const win = all.filter((i) => i.t).sort((a, b) => (isBad(b) ? 1 : 0) - (isBad(a) ? 1 : 0));
    const bg = all.filter((i) => !i.t).sort((a, b) => (isBad(b) ? 1 : 0) - (isBad(a) ? 1 : 0));
    const list = el("div", "em-proc-list");
    if (!win.length) list.append(el("div", "em-empty", "\u6CA1\u6709\u5E26\u7A97\u53E3\u7684\u8FDB\u7A0B"));
    for (const item of win) list.append(row(item));
    wrap.append(list);
    if (bg.length) {
      wrap.append(el("div", "em-proc-sub", `\u540E\u53F0\u8FDB\u7A0B\uFF08\u65E0\u7A97\u53E3\uFF09${bg.length} \u4E2A`));
      const bgList = el("div", "em-proc-list");
      for (const item of bg.slice(0, 120)) bgList.append(row(item));
      wrap.append(bgList);
    }
    const events = (agent.events || []).slice(-12).reverse();
    if (events.length) {
      wrap.append(el("div", "em-proc-sub", "\u6700\u8FD1\u4E8B\u4EF6"));
      const ev = el("div", "em-proc-events");
      for (const e of events) {
        ev.append(el(
          "div",
          e.act === "stop" ? "em-proc-row" : "em-proc-row bad",
          `${time(e.at)} ${e.act === "stop" ? "\u5173\u95ED" : "\u542F\u52A8"} ${e.n}${e.t ? ` \xB7 ${e.t}` : ""}`
        ));
      }
      wrap.append(ev);
    }
    openModal(`\u5B66\u751F ${mapping.studentId} \xB7 \u8FDB\u7A0B`, wrap);
  }
  async function loadRecords(studentId) {
    const url = studentId === void 0 ? `${location.pathname}?events=1&limit=800` : `${location.pathname}?events=1&limit=800&studentId=${studentId}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error("\u65E0\u6CD5\u8BFB\u53D6\u7A0B\u5E8F\u8BB0\u5F55");
    const { rows } = await response.json();
    const wrap = el("div", "em-proc");
    wrap.append(el("div", "em-proc-meta", `\u5171 ${rows.length} \u6761\u8BB0\u5F55\uFF08\u53EA\u4FDD\u7559\u6700\u8FD1 ${30} \u5929\uFF0C\u547D\u4E2D\u89C4\u5219\u7684\u6807\u7EA2\uFF09`));
    if (!rows.length) wrap.append(el("div", "em-empty", "\u8FD8\u6CA1\u6709\u8BB0\u5F55"));
    const list = el("div", "em-proc-list");
    for (const row of rows.slice(0, 500)) {
      const line = el("div", row.s || row.act === "start" ? "em-proc-row bad" : "em-proc-row");
      const who = studentId === void 0 ? `${row.studentId ? `\u5B66\u751F ${row.studentId}` : row.deviceId} \xB7 ` : "";
      line.append(el("b", "", `${time(row.at)}`), document.createTextNode(`${who}${row.act === "stop" ? "\u5173\u95ED" : row.act === "title" ? "\u6807\u9898" : "\u542F\u52A8"} ${row.n}${row.t ? ` \xB7 ${row.t}` : ""}`));
      list.append(line);
    }
    wrap.append(list);
    openModal(studentId === void 0 ? "\u5168\u90E8\u7A0B\u5E8F\u8BB0\u5F55" : `\u5B66\u751F ${studentId} \xB7 \u7A0B\u5E8F\u8BB0\u5F55`, wrap);
  }
  async function refresh() {
    const response = await fetch(`${location.pathname}?status=1`);
    if (!response.ok) throw new Error("\u72B6\u6001\u83B7\u53D6\u5931\u8D25");
    const data = await response.json();
    renderStats(data);
    const okAt = new Map((data.successes || []).map((s) => [s._id, s.lastSuccessAt]));
    const agents = new Map((data.agents || []).map((a) => [a._id, a]));
    grid.replaceChildren();
    if (!data.mappings.length) {
      grid.append(el("div", "em-empty", "\u8FD8\u6CA1\u6709\u6620\u5C04\uFF1A\u8BA9\u5B66\u751F\u7684 seat \u8D26\u53F7\u767B\u5F55\u4E00\u6B21 OJ\uFF0C\u7136\u540E\u70B9\u300C\u6309\u767B\u5F55 IP \u751F\u6210\u6620\u5C04\u300D"));
    }
    const sorted = [...data.mappings].sort((a, b) => a.studentId - b.studentId);
    for (const mapping of sorted) {
      const row = (data.rows || []).find((r) => r._id === mapping.studentId);
      const runtime = (data.runtime || []).find((r) => r.studentId === mapping.studentId);
      grid.append(renderCard(mapping, row, runtime, okAt.get(mapping.studentId), agents.get(mapping.deviceId)));
    }
    if (!data.active) show("\u5F53\u524D\u672A\u5728\u76D1\u8003 \u2014 \u70B9\u300C\u5F00\u59CB\u76D1\u8003\u300D\u5F00\u59CB\u91C7\u96C6");
    else if (data.collectorSeenAt && Date.now() - data.collectorSeenAt > 1e4) show("\u91C7\u96C6\u8FDB\u7A0B\u672A\u66F4\u65B0\u72B6\u6001\uFF0C\u8BF7\u68C0\u67E5\u670D\u52A1", true);
  }
  function showError(e) {
    show(e.message || String(e), true);
  }
  document.querySelectorAll("[data-action]").forEach((button) => {
    button.onclick = () => {
      const act = button.dataset.action;
      const extra = act === "import" ? { mappings: document.getElementById("mapping").value } : act === "start" ? { autoStop: document.getElementById("autostop").checked } : {};
      void action(act, extra).catch(showError);
    };
  });
  document.getElementById("em-records").onclick = () => void loadRecords().catch(showError);
  document.getElementById("em-modal-close").onclick = () => modal.classList.remove("open");
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.remove("open");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") modal.classList.remove("open");
  });
  void refresh().catch(showError);
  setInterval(() => void refresh().catch(showError), 8e3);
})();
