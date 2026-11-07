// Source for addon/public/exam-monitor.js (built with `npm run build:frontend`).
const message = document.getElementById('em-msg') as HTMLElement;
const grid = document.getElementById('em-grid') as HTMLElement;
const statsHost = document.getElementById('em-stats') as HTMLElement;
const modal = document.getElementById('em-modal') as HTMLElement;
const modalBody = document.getElementById('em-modal-body') as HTMLElement;
const modalTitle = document.getElementById('em-modal-title') as HTMLElement;

const LABELS: Record<string, string> = {
  UNREACHABLE: '设备不可达', TLS_FAILED: '证书校验失败', AUTH_FAILED: '认证失败',
  FRAME_UNAVAILABLE: '画面不可用', TIMEOUT: '任务超时', IMAGE_TOO_LARGE: '图片过大',
  CANCELLED: '已取消', INVALID_JPEG: '图片格式错误', CAPTURE_FAILED: '采集失败',
};
const AGENT_STALE_MS = 90000;

function time(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
function show(text: string, isError = false) {
  message.textContent = text;
  message.className = isError ? 'em-msg err' : 'em-msg';
}
function imageUrl(id: string) { return `${location.pathname}?image=${encodeURIComponent(id)}`; }

async function action(act: string, extra: Record<string, unknown> = {}) {
  const response = await fetch(location.pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: act, ...extra }) });
  if (!response.ok) throw new Error(`操作失败 (${response.status})`);
  const data = await response.json().catch(() => ({}));
  show((data as any).message || '操作已提交');
  await refresh();
}

function openModal(title: string, content: HTMLElement) {
  modalTitle.textContent = title;
  modalBody.replaceChildren(content);
  modal.classList.add('open');
}

function agentState(agent: any): { state: string; text: string } {
  if (!agent) return { state: 'wait', text: '采集脚本未部署' };
  if (Date.now() - (agent.at || 0) > AGENT_STALE_MS) return { state: 'err', text: `采集已停止 · 最后 ${time(agent.at)}` };
  const suspects: any[] = agent.suspects || [];
  if (suspects.length) return { state: 'err', text: `可疑：${suspects.map((s) => s.n).slice(0, 4).join('、')}` };
  return { state: 'ok', text: `进程正常 · ${time(agent.at)}` };
}

function renderCard(mapping: any, row: any, runtime: any, okAt: number | undefined, agent: any) {
  const card = el('article', 'em-card');
  const latest = row && row.latest;
  const error: string | undefined = latest && latest.error;
  const hasImage = !!(latest && latest._id && !error);
  const proc = agentState(agent);
  const suspectCount = (agent?.suspects || []).length;
  card.dataset.state = hasImage ? (suspectCount ? 'warn' : 'ok') : error ? 'err' : 'wait';

  const shot = el('a', hasImage ? 'em-shot' : 'em-shot empty');
  if (hasImage) {
    shot.setAttribute('href', imageUrl(latest._id));
    shot.setAttribute('target', '_blank');
    const img = el('img');
    img.loading = 'lazy'; img.decoding = 'async';
    img.alt = `学生 ${mapping.studentId}`;
    img.src = imageUrl(latest._id);
    shot.append(img);
  } else {
    shot.dataset.text = error ? (LABELS[error] ?? error) : '等待首次画面';
  }
  if (suspectCount) {
    const badge = el('span', 'em-badge', `可疑 ${suspectCount}`);
    shot.append(badge);
  }

  const body = el('div', 'em-body');
  const idLine = el('div', 'em-id');
  idLine.append(document.createTextNode(`学生 ${mapping.studentId}`), el('span', 'em-ip', mapping.deviceId));
  body.append(idLine);

  let stateText: string; let stateCls: string;
  if (hasImage) { stateText = `截图成功 · ${time(latest.completedAt)}`; stateCls = 'ok'; }
  else if (error) { stateText = `${LABELS[error] ?? error} · ${time(latest.completedAt)}`; stateCls = 'err'; }
  else { stateText = '等待首次检测'; stateCls = 'wait'; }
  body.append(el('div', `em-line ${stateCls}`, stateText));

  let queue: string;
  if (runtime?.pending) queue = `排队 ${Math.round(runtime.queueDelayMs / 1000)} 秒`;
  else if (runtime?.running) queue = '正在采集';
  else queue = '等待下次检测';
  body.append(el('div', 'em-line', `${queue}${okAt ? ` · 最近成功 ${time(okAt)}` : ''}`));
  body.append(el('div', `em-line ${proc.state}`, proc.text));

  const mini = el('div', 'em-mini');
  const shotBtn = el('button', '', '抽查');
  shotBtn.onclick = () => void action('capture', { studentId: mapping.studentId }).catch(showError);
  const historyBtn = el('button', '', '历史');
  historyBtn.onclick = () => void loadHistory(mapping.studentId).catch(showError);
  mini.append(shotBtn, historyBtn);
  if (agent) {
    const procBtn = el('button', '', '进程');
    procBtn.onclick = () => showProcesses(mapping, agent);
    mini.append(procBtn);
  }
  body.append(mini);

  card.append(shot, body);
  return card;
}

function renderStats(data: any) {
  const rows: any[] = data.rows || [];
  const byId = new Map(rows.map((r: any) => [r._id, r.latest]));
  const agents = new Map((data.agents || []).map((a: any) => [a._id, a]));
  let ok = 0, err = 0, wait = 0, suspect = 0, stale = 0;
  for (const m of data.mappings) {
    const latest: any = byId.get(m.studentId);
    if (!latest) wait++;
    else if (latest.error) err++;
    else ok++;
    const agent: any = agents.get(m.deviceId);
    if (agent) {
      if ((agent.suspects || []).length) suspect++;
      if (Date.now() - (agent.at || 0) > AGENT_STALE_MS) stale++;
    }
  }
  statsHost.replaceChildren();
  const add = (cls: string, value: string, label: string) => {
    const box = el('div', `em-stat ${cls}`);
    box.append(el('b', '', value), document.createTextNode(label));
    statsHost.append(box);
  };
  add('', String(data.mappings.length), '台在监');
  add('ok', String(ok), '画面正常');
  add('err', String(err), '有异常');
  add('wait', String(wait), '等待首次');
  if (suspect) add('err', String(suspect), '可疑程序');
  if (stale) add('wait', String(stale), '采集中断');

  const live = el('div', 'em-live');
  const collectorStale = !data.collectorSeenAt || Date.now() - data.collectorSeenAt > 10000;
  live.append(el('span', `em-dot ${data.active ? (collectorStale ? 'off' : 'on') : ''}`));
  live.append(document.createTextNode(data.active ? (collectorStale ? '采集进程无响应' : '采集进程正常') : '未开始监考'));
  statsHost.append(live);
}

async function loadHistory(studentId: number) {
  const response = await fetch(`${location.pathname}?history=${studentId}`);
  if (!response.ok) throw new Error('无法读取历史画面');
  const { rows } = await response.json();
  const box = el('div', 'em-hgrid');
  if (!rows.length) box.append(el('div', 'em-empty', '还没有历史画面'));
  for (const row of rows) {
    const item = el('a', 'em-hitem');
    item.href = imageUrl(row._id); item.target = '_blank';
    const img = el('img'); img.loading = 'lazy'; img.src = imageUrl(row._id); img.alt = '';
    item.append(img, el('div', '', `${time(row.completedAt)} · ${Math.round((row.bytes || 0) / 1024)} KB`));
    box.append(item);
  }
  openModal(`学生 ${studentId} · 历史画面（${rows.length} 张）`, box);
}

function showProcesses(mapping: any, agent: any) {
  const wrap = el('div', 'em-proc');
  const meta = el('div', 'em-proc-meta',
    `主机 ${agent.host || '-'} · 用户 ${agent.user || '-'} · 最后上报 ${time(agent.at)} · 共 ${(agent.items || []).length} 个窗口进程`);
  wrap.append(meta);

  const suspects: any[] = agent.suspects || [];
  if (suspects.length) {
    const box = el('div', 'em-proc-alert', `可疑进程：${suspects.map((s) => `${s.n}${s.t ? `（${s.t}）` : ''}`).join('、')}`);
    wrap.append(box);
  }

  const list = el('div', 'em-proc-list');
  const items = [...(agent.items || [])].sort((a: any, b: any) => (suspects.some((s) => s.n === b.n) ? 1 : 0) - (suspects.some((s) => s.n === a.n) ? 1 : 0));
  for (const item of items) {
    const line = el('div', suspects.some((s) => s.n === item.n) ? 'em-proc-row bad' : 'em-proc-row');
    line.append(el('b', '', item.n), document.createTextNode(item.t ? ` ${item.t}` : ''), el('span', 'em-proc-mem', `${Math.round((item.m || 0) / 1024)} MB`));
    list.append(line);
  }
  if (!items.length) list.append(el('div', 'em-empty', '没有带窗口的进程'));
  wrap.append(list);

  const events: any[] = (agent.events || []).slice(-12).reverse();
  if (events.length) {
    wrap.append(el('div', 'em-proc-sub', '最近事件'));
    const ev = el('div', 'em-proc-events');
    for (const e of events) {
      ev.append(el('div', e.act === 'stop' ? 'em-proc-row' : 'em-proc-row bad',
        `${time(e.at)} ${e.act === 'stop' ? '关闭' : '启动'} ${e.n}${e.t ? ` · ${e.t}` : ''}`));
    }
    wrap.append(ev);
  }
  openModal(`学生 ${mapping.studentId} · 进程`, wrap);
}

async function refresh() {
  const response = await fetch(`${location.pathname}?status=1`);
  if (!response.ok) throw new Error('状态获取失败');
  const data = await response.json();
  renderStats(data);
  const okAt = new Map((data.successes || []).map((s: any) => [s._id, s.lastSuccessAt]));
  const agents = new Map((data.agents || []).map((a: any) => [a._id, a]));
  grid.replaceChildren();
  if (!data.mappings.length) {
    grid.append(el('div', 'em-empty', '还没有映射：让学生的 seat 账号登录一次 OJ，然后点「按登录 IP 生成映射」'));
  }
  const sorted = [...data.mappings].sort((a: any, b: any) => a.studentId - b.studentId);
  for (const mapping of sorted) {
    const row = (data.rows || []).find((r: any) => r._id === mapping.studentId);
    const runtime = (data.runtime || []).find((r: any) => r.studentId === mapping.studentId);
    grid.append(renderCard(mapping, row, runtime, okAt.get(mapping.studentId) as number | undefined, agents.get(mapping.deviceId)));
  }
  if (!data.active) show('当前未在监考 — 点「开始监考」开始采集');
  else if (data.collectorSeenAt && Date.now() - data.collectorSeenAt > 10000) show('采集进程未更新状态，请检查服务', true);
}

function showError(e: Error) { show(e.message || String(e), true); }

document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) => {
  button.onclick = () => {
    const act = button.dataset.action!;
    const extra: Record<string, unknown> = act === 'import'
      ? { mappings: (document.getElementById('mapping') as HTMLTextAreaElement).value }
      : act === 'start'
        ? { autoStop: (document.getElementById('autostop') as HTMLInputElement).checked }
        : {};
    void action(act, extra).catch(showError);
  };
});
document.getElementById('em-modal-close')!.onclick = () => modal.classList.remove('open');
modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') modal.classList.remove('open'); });

void refresh().catch(showError);
setInterval(() => void refresh().catch(showError), 15000);
