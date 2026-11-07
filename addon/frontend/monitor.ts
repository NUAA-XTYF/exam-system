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
const ERROR_CODES = Object.keys(LABELS);

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

async function action(act: string, extra: Record<string, unknown> = {}) {
  const response = await fetch(location.pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: act, ...extra }) });
  if (!response.ok) throw new Error(`操作失败 (${response.status})`);
  const data = await response.json().catch(() => ({}));
  show((data as any).message || '操作已提交');
  await refresh();
}

function imageUrl(id: string) { return `${location.pathname}?image=${encodeURIComponent(id)}`; }

function renderCard(mapping: any, row: any, runtime: any, okAt: number | undefined) {
  const card = el('article', 'em-card');
  const latest = row && row.latest;
  const error: string | undefined = latest && latest.error;
  const hasImage = !!(latest && latest._id && !error);
  card.dataset.state = hasImage ? 'ok' : error ? 'err' : 'wait';

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

  const mini = el('div', 'em-mini');
  const shotBtn = el('button', '', '抽查');
  shotBtn.onclick = () => void action('capture', { studentId: mapping.studentId }).catch(showError);
  const historyBtn = el('button', '', '历史');
  historyBtn.onclick = () => void loadHistory(mapping.studentId).catch(showError);
  mini.append(shotBtn, historyBtn);
  body.append(mini);

  card.append(shot, body);
  return card;
}

function renderStats(data: any) {
  const rows: any[] = data.rows || [];
  const byId = new Map(rows.map((r: any) => [r._id, r.latest]));
  let ok = 0, err = 0, wait = 0;
  for (const m of data.mappings) {
    const latest: any = byId.get(m.studentId);
    if (!latest) { wait++; continue; }
    if (latest.error) err++; else ok++;
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

  const live = el('div', 'em-live');
  const stale = !data.collectorSeenAt || Date.now() - data.collectorSeenAt > 10000;
  live.append(el('span', `em-dot ${data.active ? (stale ? 'off' : 'on') : ''}`));
  live.append(document.createTextNode(data.active ? (stale ? '采集进程无响应' : '采集进程正常') : '未开始监考'));
  statsHost.append(live);
}

async function loadHistory(studentId: number) {
  const response = await fetch(`${location.pathname}?history=${studentId}`);
  if (!response.ok) throw new Error('无法读取历史画面');
  const { rows } = await response.json();
  modalTitle.textContent = `学生 ${studentId} · 历史画面（${rows.length} 张）`;
  modalBody.replaceChildren();
  if (!rows.length) { modalBody.append(el('div', 'em-empty', '还没有历史画面')); }
  else {
    const gridBox = el('div', 'em-hgrid');
    for (const row of rows) {
      const item = el('a', 'em-hitem');
      item.href = imageUrl(row._id); item.target = '_blank';
      const img = el('img'); img.loading = 'lazy'; img.src = imageUrl(row._id); img.alt = '';
      const caption = el('div', '', `${time(row.completedAt)} · ${Math.round((row.bytes || 0) / 1024)} KB`);
      item.append(img, caption);
      gridBox.append(item);
    }
    modalBody.append(gridBox);
  }
  modal.classList.add('open');
}

async function refresh() {
  const response = await fetch(`${location.pathname}?status=1`);
  if (!response.ok) throw new Error('状态获取失败');
  const data = await response.json();
  renderStats(data);
  const okAt = new Map((data.successes || []).map((s: any) => [s._id, s.lastSuccessAt]));
  grid.replaceChildren();
  if (!data.mappings.length) {
    grid.append(el('div', 'em-empty', '还没有映射：让学生的 seat 账号登录一次 OJ，然后点「按登录 IP 生成映射」'));
  }
  const sorted = [...data.mappings].sort((a: any, b: any) => a.studentId - b.studentId);
  for (const mapping of sorted) {
    const row = (data.rows || []).find((r: any) => r._id === mapping.studentId);
    const runtime = (data.runtime || []).find((r: any) => r.studentId === mapping.studentId);
    grid.append(renderCard(mapping, row, runtime, okAt.get(mapping.studentId) as number | undefined));
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
