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
  var ERROR_CODES = Object.keys(LABELS);
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
  async function action(act, extra = {}) {
    const response = await fetch(location.pathname, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: act, ...extra }) });
    if (!response.ok) throw new Error(`\u64CD\u4F5C\u5931\u8D25 (${response.status})`);
    const data = await response.json().catch(() => ({}));
    show(data.message || "\u64CD\u4F5C\u5DF2\u63D0\u4EA4");
    await refresh();
  }
  function imageUrl(id) {
    return `${location.pathname}?image=${encodeURIComponent(id)}`;
  }
  function renderCard(mapping, row, runtime, okAt) {
    const card = el("article", "em-card");
    const latest = row && row.latest;
    const error = latest && latest.error;
    const hasImage = !!(latest && latest._id && !error);
    card.dataset.state = hasImage ? "ok" : error ? "err" : "wait";
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
    const mini = el("div", "em-mini");
    const shotBtn = el("button", "", "\u62BD\u67E5");
    shotBtn.onclick = () => void action("capture", { studentId: mapping.studentId }).catch(showError);
    const historyBtn = el("button", "", "\u5386\u53F2");
    historyBtn.onclick = () => void loadHistory(mapping.studentId).catch(showError);
    mini.append(shotBtn, historyBtn);
    body.append(mini);
    card.append(shot, body);
    return card;
  }
  function renderStats(data) {
    const rows = data.rows || [];
    const byId = new Map(rows.map((r) => [r._id, r.latest]));
    let ok = 0, err = 0, wait = 0;
    for (const m of data.mappings) {
      const latest = byId.get(m.studentId);
      if (!latest) {
        wait++;
        continue;
      }
      if (latest.error) err++;
      else ok++;
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
    const live = el("div", "em-live");
    const stale = !data.collectorSeenAt || Date.now() - data.collectorSeenAt > 1e4;
    live.append(el("span", `em-dot ${data.active ? stale ? "off" : "on" : ""}`));
    live.append(document.createTextNode(data.active ? stale ? "\u91C7\u96C6\u8FDB\u7A0B\u65E0\u54CD\u5E94" : "\u91C7\u96C6\u8FDB\u7A0B\u6B63\u5E38" : "\u672A\u5F00\u59CB\u76D1\u8003"));
    statsHost.append(live);
  }
  async function loadHistory(studentId) {
    const response = await fetch(`${location.pathname}?history=${studentId}`);
    if (!response.ok) throw new Error("\u65E0\u6CD5\u8BFB\u53D6\u5386\u53F2\u753B\u9762");
    const { rows } = await response.json();
    modalTitle.textContent = `\u5B66\u751F ${studentId} \xB7 \u5386\u53F2\u753B\u9762\uFF08${rows.length} \u5F20\uFF09`;
    modalBody.replaceChildren();
    if (!rows.length) {
      modalBody.append(el("div", "em-empty", "\u8FD8\u6CA1\u6709\u5386\u53F2\u753B\u9762"));
    } else {
      const gridBox = el("div", "em-hgrid");
      for (const row of rows) {
        const item = el("a", "em-hitem");
        item.href = imageUrl(row._id);
        item.target = "_blank";
        const img = el("img");
        img.loading = "lazy";
        img.src = imageUrl(row._id);
        img.alt = "";
        const caption = el("div", "", `${time(row.completedAt)} \xB7 ${Math.round((row.bytes || 0) / 1024)} KB`);
        item.append(img, caption);
        gridBox.append(item);
      }
      modalBody.append(gridBox);
    }
    modal.classList.add("open");
  }
  async function refresh() {
    const response = await fetch(`${location.pathname}?status=1`);
    if (!response.ok) throw new Error("\u72B6\u6001\u83B7\u53D6\u5931\u8D25");
    const data = await response.json();
    renderStats(data);
    const okAt = new Map((data.successes || []).map((s) => [s._id, s.lastSuccessAt]));
    grid.replaceChildren();
    if (!data.mappings.length) {
      grid.append(el("div", "em-empty", "\u8FD8\u6CA1\u6709\u6620\u5C04\uFF1A\u8BA9\u5B66\u751F\u7684 seat \u8D26\u53F7\u767B\u5F55\u4E00\u6B21 OJ\uFF0C\u7136\u540E\u70B9\u300C\u6309\u767B\u5F55 IP \u751F\u6210\u6620\u5C04\u300D"));
    }
    const sorted = [...data.mappings].sort((a, b) => a.studentId - b.studentId);
    for (const mapping of sorted) {
      const row = (data.rows || []).find((r) => r._id === mapping.studentId);
      const runtime = (data.runtime || []).find((r) => r.studentId === mapping.studentId);
      grid.append(renderCard(mapping, row, runtime, okAt.get(mapping.studentId)));
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
  document.getElementById("em-modal-close").onclick = () => modal.classList.remove("open");
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.remove("open");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") modal.classList.remove("open");
  });
  void refresh().catch(showError);
  setInterval(() => void refresh().catch(showError), 15e3);
})();
