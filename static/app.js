'use strict';

const $ = id => document.getElementById(id);
const mobile = window.PaperStudioMobile?.chooseFiles ? window.PaperStudioMobile : null;
function loadPageImage(image, url) {
  if (image.dataset.requested === url) return;
  image.dataset.requested = url;
  const candidate = mobile ? mobile.pageImage(url) : url;
  if (typeof candidate === 'string') { image.src = candidate; return; }
  candidate.then(source => {
    if (!image.isConnected || image.dataset.requested !== url) { URL.revokeObjectURL(source); return; }
    const release = () => {
      URL.revokeObjectURL(source);
      image.removeEventListener('load', release);
      image.removeEventListener('error', release);
    };
    image.addEventListener('load', release);
    image.addEventListener('error', release);
    image.src = source;
  }).catch(() => {
    if (image.isConnected && image.dataset.requested === url) image.dispatchEvent(new Event('error'));
  });
}
const ignoreOptions = [...$('ignore-content').querySelectorAll('input')];
const ignoredContent = () => ignoreOptions.filter(input => input.checked).map(input => input.value);
const importFormats = new Set($('file-picker').accept.split(',').map(entry => entry.trim().slice(1)));
const extensionOf = name => /\.([^.]+)$/.exec(name)?.[1].toLowerCase() || '';
const documentTitle = name => importFormats.has(extensionOf(name)) ? name.replace(/\.[^.]+$/, '') : name;
const sourceFormat = job => importFormats.has(job.source_format) ? job.source_format : 'pdf';
const formatBadges = {markdown:'MD', jpeg:'JPG', tiff:'TIF'};
const byId = new Map();
const pending = new Set();
const openTabs = new Set();
const docMemory = new Map(); // jobId -> {page, mode}
const running = job => job?.state === 'queued' || job?.state === 'running';
const canResume = job => Boolean(mobile && job?.state === 'paused' && job.remaining_pages?.length);
const pagePending = (job, page) => job.remaining_pages?.includes(page);
const hasResult = job => Boolean(job?.has_result ?? (job?.state === 'completed'));
const resultVersion = job => job.result_id || 'legacy';
const textRevision = job => job.text_revision || resultVersion(job);
const textKey = job => job ? `${job.id}:${textRevision(job)}` : '';
const states = {uploaded:'待翻译', queued:'排队中', running:'翻译中', paused:'待续译', completed:'已完成', failed:'失败', cancelled:'已取消'};
const jobStatus = job => job.state === 'completed' && job.failed_pages?.length ? '部分完成' : (states[job.state] || '');
function jobProgressLabel(job) {
  const percent = Math.max(0, Math.min(100, (Number(job.progress) || 0) * 100));
  if (mobile && job.provider === 'precision' && percent > 0 && percent < 1) {
    return percent < .1 ? '＜0.1%' : percent.toFixed(1) + '%';
  }
  return Math.round(percent) + '%';
}
const providerLabels = {
  magpie:'Magpie', codex:'Codex', antigravity:'Antigravity', offline:'本机离线',
  openai:'OpenAI', deepseek:'DeepSeek', kimi:'Kimi', glm:'GLM',
  gemini:'Gemini', siliconflow:'SiliconFlow', api:'自定义 API', precision:'本机精译', demo:'示例'
};
const usesApi = provider => !['codex', 'antigravity', 'offline', 'precision'].includes(provider);
const profiles = new Map();
const mobileChannels = new Map();

let selectedProvider = $('provider').value;
let configRevision = 0;
let viewMode = 'dual-pdf';
let textRequestKey = '';
let textView = {target:'', signature:''};
let currentPairs = [];
let fullSegments = {};
let segmentsJobKey = '';
let segmentsRequest = null;
let selectedId = null;
let currentPage = 1;
let connection = null;
let progressTimer = null;
let toastTimer = null;
let saveSettingsTimer = null;
let listSignature = '';
let tabsSignature = '';
let streamSignature = '';
let doc2xRenderKey = '';
let outlineSignature = '';
let mutationEpoch = 0;
let renderingJob = null;
let uploading = false;
let polling = false;
let lostConnection = false;
let syncingScroll = false;
let programmaticScroll = false;
let scrollReleaseTimer = null;
let pageObserver = null;
let lastScrollTop = 0;

const leftPane = $('left-pane');
const rightPane = $('right-pane');

const currentJob = () => byId.get(selectedId);
const jobPath = id => `/api/jobs/${encodeURIComponent(id)}`;

async function request(path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.method && options.method !== 'GET') headers.set('X-Local-Request', '1');
  const response = await fetch(path, {...options, headers, cache:'no-store'});
  let result;
  try { result = await response.json(); }
  catch { throw new Error(`本地服务返回了无法读取的响应（${response.status}）。`); }
  if (!response.ok) throw new Error(result.error || `请求失败（${response.status}）。`);
  return result;
}

function announce(text, error = false) {
  const element = $('toast');
  element.textContent = text;
  element.classList.toggle('error', error);
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, error ? 8500 : 3600);
}

/* 主题与工具栏折叠控制 */
function applyTheme(theme) {
  const valid = ['light', 'sepia', 'dark'].includes(theme) ? theme : 'light';
  document.documentElement.dataset.theme = valid;
  try { localStorage.setItem('paper_studio_theme', valid); } catch {}
  for (const btn of document.querySelectorAll('.theme-btn')) {
    btn.classList.toggle('active', btn.dataset.themeVal === valid);
  }
}

function setToolbarCollapsed(collapsed) {
  const reader = $('active-reader');
  reader.classList.toggle('toolbar-collapsed', Boolean(collapsed));
  $('toolbar-reveal-strip').hidden = !collapsed;
}

function toggleZenMode(force) {
  const active = typeof force === 'boolean' ? force : !document.body.classList.contains('zen-mode');
  document.body.classList.toggle('zen-mode', active);
  $('zen-hud').hidden = !active;
  if (active) announce('已进入专注阅读模式，按 Esc 退出。');
}

function connectionRows() {
  const entries = [
    [mobile ? 'Android 文献引擎' : 'PDF2zh 版面引擎', connection?.engine],
    ['本地离线 OCR', connection ? {ok: connection.ocr, message: connection.ocr ? '离线识别模型已就绪' : '便携包未找到 OCR 模型'} : null],
    ['本机离线英译中', connection?.providers?.offline],
  ];
  if (mobile) entries.push(['本机精译', connection?.providers?.precision]);
  if (!mobile) entries.push(
    ['Magpie 聚合网关', connection?.providers?.magpie],
    ['Codex 订阅', connection?.providers?.codex],
    ['Antigravity 订阅', connection?.providers?.antigravity]
  );
  const target = $('connections');
  const children = entries.map(([title, entry]) => {
    const row = document.createElement('div');
    row.className = 'connection-row';
    const dot = document.createElement('i');
    if (entry?.ok) dot.className = 'ok';
    const content = document.createElement('div');
    const label = document.createElement('strong');
    label.textContent = title;
    const message = document.createElement('p');
    message.textContent = entry?.message || '未检测';
    content.append(label, message);
    row.append(dot, content);
    return row;
  });
  target.replaceChildren(...children);
}

async function loadSavedSettings() {
  try {
    const savedTheme = localStorage.getItem('paper_studio_theme');
    if (savedTheme) applyTheme(savedTheme);
    const savedAutohide = localStorage.getItem('paper_studio_autohide');
    if (savedAutohide === '1') $('autohide-toolbar').checked = true;
  } catch {}
  try {
    const saved = await request('/api/settings');
    if (saved.profiles && typeof saved.profiles === 'object') {
      for (const [k, v] of Object.entries(saved.profiles)) {
        if (v && typeof v === 'object') profiles.set(k, {...v});
      }
    }
    if (saved.active_provider && $('provider').querySelector(`option[value="${saved.active_provider}"]`)) {
      $('provider').value = saved.active_provider;
      selectedProvider = saved.active_provider;
    }
    if (saved.source_language) $('source-language').value = saved.source_language;
    if (saved.target_language) $('target-language').value = saved.target_language;
    if (saved.concurrency) $('concurrency').value = String(saved.concurrency);
    if (typeof saved.ocr === 'boolean') $('ocr').checked = saved.ocr;
    const ignored = new Set(Array.isArray(saved.ignore_content) ? saved.ignore_content : []);
    for (const input of ignoreOptions) input.checked = ignored.has(input.value);
    if (typeof saved.auto_glossary === 'boolean') $('auto-glossary').checked = saved.auto_glossary;
    if (mobile) $('reuse-api-cache').checked = saved.reuse_api_cache !== false;
    if (typeof saved.glossary === 'string') $('glossary').value = saved.glossary;
    loadProfile();
    updateForm();
  } catch {}
}

function persistSettings() {
  const provider = $('provider').value;
  const profile = {base_url:$('base-url').value.trim(), api_key:$('api-key').value.trim(), model:$('model').value.trim()};
  profiles.set(provider, profile);
  return jsonRequest('/api/settings', 'POST', {
    active_provider:provider, provider, ...profile, profiles:Object.fromEntries(profiles),
    source_language:$('source-language').value, target_language:$('target-language').value,
    concurrency:Number($('concurrency').value) || 4, ocr:$('ocr').checked,
    ignore_content:ignoredContent(), auto_glossary:$('auto-glossary').checked, glossary:$('glossary').value,
    ...(mobile ? {reuse_api_cache:$('reuse-api-cache').checked} : {})
  });
}

function scheduleSaveSettings() {
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(() => void persistSettings().catch(() => {}), 450);
}

async function refreshConnections() {
  const button = $('refresh-status');
  const initial = !connection;
  const revision = configRevision;
  button.disabled = true;
  try { connection = await request('/api/status'); }
  catch (error) { announce(`连接状态读取失败：${error.message}`, true); }
  finally { button.disabled = false; }
  connectionRows();
  if (initial && revision === configRevision) loadProfile();
  $('ocr').disabled = connection?.ocr === false;
  $('ocr').title = connection?.ocr === false ? '当前便携包未找到 OCR 模型' : '扫描页在本机识别，译文按页重新排版';
  updateForm();
  void refreshModelList();
}

function toggleConnections(force) {
  const panel = $('connection-panel');
  panel.hidden = typeof force === 'boolean' ? !force : !panel.hidden;
  $('status-toggle').setAttribute('aria-expanded', String(!panel.hidden));
}

let modelCatalogRevision = 0;
let configuredApiOrigin = '';

function apiOrigin(value) {
  try { return new URL(value).origin; } catch { return ''; }
}

function showModelListNote(text, kind = '') {
  const note = $('model-list-note');
  note.textContent = text;
  note.dataset.kind = kind;
  note.hidden = !text;
}

function clearModelList() {
  modelCatalogRevision++;
  populateModelChoices([]);
  $('fetch-models').disabled = false;
  showModelListNote('');
}

function populateModelChoices(models) {
  const picker = $('model-picker');
  const datalist = $('model-datalist');
  datalist.replaceChildren();
  if (!Array.isArray(models) || !models.length) {
    picker.replaceChildren();
    picker.hidden = true;
    return;
  }
  const groups = new Map();
  for (const item of models) {
    const id = typeof item === 'string' ? item : item.id;
    const label = typeof item === 'string' ? item : (item.label || item.id);
    const group = (typeof item === 'object' && item.group) ? item.group : 'API 返回';
    if (!id) continue;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({id, label});

    const opt = document.createElement('option');
    opt.value = id;
    opt.label = label;
    datalist.append(opt);
  }

  const firstOption = document.createElement('option');
  firstOption.value = '';
  firstOption.textContent = `-- 点选模型（共 ${models.length} 个） --`;
  const children = [firstOption];

  for (const [groupName, items] of groups.entries()) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = groupName;
    for (const {id, label} of items) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = label !== id ? `${label} (${id})` : id;
      optgroup.append(opt);
    }
    children.push(optgroup);
  }
  picker.replaceChildren(...children);
  picker.value = models.some(m => (m.id || m) === $('model').value) ? $('model').value : '';
  picker.hidden = false;
}

async function refreshModelList() {
  clearModelList();
  const payload = modelSettings();
  if (!usesApi(payload.provider)) return;
  if (!payload.base_url) { showModelListNote('先填写 API 地址，再查询模型。'); return; }
  const revision = modelCatalogRevision;
  const btn = $('fetch-models');
  btn.disabled = true;
  showModelListNote('正在查询模型…');
  try {
    const res = await request('/api/models', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    });
    if (revision !== modelCatalogRevision) return;
    if (res.ok && Array.isArray(res.models) && res.models.length) {
      populateModelChoices(res.models);
      showModelListNote(res.message, 'success');
    } else showModelListNote(res.message || '接口未返回模型。可手动输入模型 ID。', 'warning');
  } catch (error) {
    if (revision === modelCatalogRevision) showModelListNote(error.message, 'warning');
  } finally {
    if (revision === modelCatalogRevision) btn.disabled = false;
  }
}

function updateForm() {
  const provider = $('provider').value;
  const api = usesApi(provider);
  const offline = provider === 'offline';
  const local = ['offline', 'precision'].includes(provider);
  const isMagpie = provider === 'magpie';
  const job = currentJob();
  $('api-fields').hidden = !api;
  $('base-url').disabled = !api;
  $('base-url').required = api;
  $('api-key').disabled = !api;
  $('model-fields').hidden = local;
  $('model').disabled = local;
  $('model').required = api;
  $('fetch-models').hidden = !api;
  $('model-optional').textContent = api ? '必填' : '选填';
  $('model').placeholder = api ? '查询模型后选择，或输入模型 ID' : '默认使用 CLI 订阅当前模型';
  $('language-fields').hidden = offline;
  $('concurrency').disabled = local && !mobile;
  if (local && !mobile) $('concurrency').value = '1';
  $('auto-glossary').disabled = local;
  $('auto-glossary').parentElement.title = offline && !mobile ? '本机离线翻译可使用下方的自定义术语表' : '';
  $('test-connection').textContent = mobile && offline ? '试用 Google 翻译' : local ? '本机试译' : '测试连接';

  const status = !api ? connection?.providers?.[provider] : (isMagpie ? connection?.providers?.magpie : null);
  const note = $('provider-note');
  note.dataset.kind = status && !status.ok ? 'warning' : (status?.ok ? 'success' : '');
  if (isMagpie) {
    note.textContent = status?.message || '连接本机 Magpie 网关 (127.0.0.1:3425)，已启用前缀缓存与非推理极速模式。';
  } else if (api) {
    note.textContent = '使用当前 API 地址和密钥查询模型。';
  } else if (local) {
    note.textContent = status?.message || (offline ? '英语 → 简体中文 · 使用本机语言包，免账号和 API Key。'
      : '导入 Hy-MT2 后可在设备上断网精译。');
  } else {
    note.textContent = status && !status.ok
      ? status.message
      : (provider === 'codex' ? '复用本机 Codex 订阅登录，无需 API Key。' : '复用已登录的 agy 命令行，无需 API Key。');
  }

  mobile?.updateSettings(provider, status);
  const resume = canResume(job);
  const label = resume ? '继续剩余 ' + job.remaining_pages.length + ' 页'
    : mobile && offline ? (job?.state === 'completed' ? '用 Google 重新翻译' : '使用 Google 翻译')
    : job?.state === 'completed' ? '重新翻译' : ['failed', 'cancelled'].includes(job?.state) ? '再次翻译' : '开始翻译';
  $('translate-button').lastChild.textContent = ` ${label}`;
  const providerBlocked = !api && status?.ok === false;
  const translateDisabled = !job || running(job) || job.stopping || pending.has(job.id) ||
    (!resume && (connection?.engine?.ok === false || providerBlocked));
  $('translate-button').disabled = translateDisabled;
  $('translate-button').formNoValidate = resume;
  if ($('drawer-translate-btn')) {
    $('drawer-translate-btn').textContent = label;
    $('drawer-translate-btn').disabled = translateDisabled;
    $('drawer-translate-btn').formNoValidate = resume;
  }
  $('selection-note').textContent = !job ? '请先在上方导入或选择文献' : (running(job) ? '后台翻译中，可先阅读原文' : `当前文献 · 共 ${job.pages} 页`);
  updateModelSummaryCard();
}

function updateModelSummaryCard() {
  const providerEl = $('provider');
  if (!providerEl || !$('summary-provider')) return;
  const provider = providerEl.value;
  const api = usesApi(provider);
  const offline = provider === 'offline';
  const isMagpie = provider === 'magpie';
  const providerTitle = providerEl.selectedOptions[0]?.textContent?.split('·')[0]?.trim() || provider;
  $('summary-provider').textContent = providerTitle;

  const rawModel = $('model')?.value.trim() || '';
  if (offline) {
    $('summary-model').textContent = '本机离线英译中语言包';
  } else if (provider === 'precision') {
    $('summary-model').textContent = 'Hy-MT2-1.8B · Q4';
  } else if (!api) {
    $('summary-model').textContent = rawModel || '默认 CLI 订阅模型';
  } else {
    $('summary-model').textContent = rawModel || '点击选择或填写模型 ID';
  }

  const srcText = $('source-language')?.selectedOptions[0]?.textContent?.split(' ')[0] || '英语';
  const tgtText = $('target-language')?.selectedOptions[0]?.textContent?.split(' ')[0] || '简体中文';
  const conc = $('concurrency')?.value || '4';
  $('summary-meta').textContent = offline
    ? '英语 → 简体中文 · 本机离线'
    : `${srcText} → ${tgtText} · ${provider === 'precision' ? '本机精译' : conc + ' 通道'}`;

  const status = !api ? connection?.providers?.[provider] : (isMagpie ? connection?.providers?.magpie : null);
  const dot = $('summary-dot');
  if (dot) {
    const warn = (status && status.ok === false) || (api && (!rawModel || !$('base-url')?.value.trim()));
    dot.className = `summary-dot${warn ? ' warning' : ''}`;
  }
}

function toggleSettingsDrawer(force) {
  const drawer = $('settings-drawer');
  const backdrop = $('settings-backdrop');
  if (!drawer) return;
  const open = typeof force === 'boolean' ? force : drawer.hidden;
  drawer.hidden = !open;
  if (backdrop) backdrop.hidden = !open;
  $('settings-toggle-btn')?.setAttribute('aria-expanded', String(open));
  $('model-summary-card')?.setAttribute('aria-expanded', String(open));
}

function toggleMoreMenu(force) {
  const menu = $('more-menu');
  if (!menu) return;
  const open = typeof force === 'boolean' ? force : menu.hidden;
  menu.hidden = !open;
  $('more-menu-btn')?.setAttribute('aria-expanded', String(open));
  if (open && $('export-menu')) $('export-menu').hidden = true;
}

function loadProfile() {
  const saved = profiles.get(selectedProvider);
  const defaults = connection?.presets?.[selectedProvider];
  $('base-url').value = saved?.base_url || defaults?.base_url || '';
  configuredApiOrigin = apiOrigin($('base-url').value);
  $('model').value = saved?.model || '';
  $('api-key').value = saved?.api_key ?? (configuredApiOrigin === apiOrigin(defaults?.base_url) ? defaults?.default_key : '') ?? '';
}

function resetCheck() {
  configRevision++;
  $('check-note').hidden = true;
}

function switchProvider() {
  profiles.set(selectedProvider, {
    base_url: $('base-url').value.trim(),
    api_key: $('api-key').value.trim(),
    model: $('model').value.trim()
  });
  if (mobile) mobileChannels.set(selectedProvider, $('concurrency').value);
  selectedProvider = $('provider').value;
  if (mobile) {
    $('concurrency').value = mobileChannels.get(selectedProvider) || (usesApi(selectedProvider) ? '2' : '1');
  } else if (!usesApi(selectedProvider)) {
    $('concurrency').value = '1';
  } else if ($('concurrency').value === '1') {
    $('concurrency').value = '4';
  }
  loadProfile();
  resetCheck();
  updateForm();
  scheduleSaveSettings();
  void refreshModelList();
}

function modelSettings() {
  const provider = $('provider').value;
  if (['offline', 'precision'].includes(provider)) return {provider};
  const result = {provider, model: $('model').value.trim()};
  if (usesApi(provider)) {
    result.base_url = $('base-url').value.trim();
    result.api_key = $('api-key').value.trim();
  }
  return result;
}

async function testConnection() {
  for (const id of ['base-url', 'model']) if (!$(id).reportValidity()) return;
  const revision = configRevision;
  const button = $('test-connection');
  const note = $('check-note');
  button.disabled = true;
  note.dataset.kind = '';
  note.textContent = $('provider').value === 'offline' ? '正在本机试译…' : '正在验证模型响应…';
  note.hidden = false;
  try {
    const result = await request('/api/check', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(modelSettings())
    });
    if (configRevision === revision) {
      note.dataset.kind = 'success';
      const label = $('provider').value === 'offline' ? result.message : '连接成功 · 试译';
      note.textContent = result.sample ? `${label} · 「${result.sample}」` : result.message;
    }
  } catch (error) {
    if (configRevision === revision) {
      note.dataset.kind = 'warning';
      note.textContent = error.message;
    }
  } finally { button.disabled = false; }
}

/* 顶部多文档标签栏 */
function renderTabs() {
  for (const id of [...openTabs]) {
    if (!byId.has(id)) openTabs.delete(id);
  }
  if (selectedId && byId.has(selectedId)) openTabs.add(selectedId);
  const tabJobs = [...openTabs].map(id => byId.get(id)).filter(Boolean);
  const sig = JSON.stringify([selectedId, ...tabJobs.map(j => [j.id, j.name, j.state, j.progress])]);
  if (sig === tabsSignature) return;
  tabsSignature = sig;

  const container = $('doc-tabs');
  const nodes = tabJobs.map(job => {
    const tab = document.createElement('div');
    tab.className = `doc-tab${job.id === selectedId ? ' active' : ''}`;
    tab.title = `${job.name} (${jobStatus(job)})`;
    const dot = document.createElement('span');
    dot.className = `tab-dot ${job.state === 'completed' ? 'completed' : running(job) ? 'running' : ''}`;
    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = documentTitle(job.name);
    tab.append(dot, name);
    tab.addEventListener('click', () => selectJob(job.id));

    if (tabJobs.length > 1) {
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'tab-close';
      closeBtn.textContent = '×';
      closeBtn.title = '关闭标签页';
      closeBtn.addEventListener('click', event => {
        event.stopPropagation();
        openTabs.delete(job.id);
        if (selectedId === job.id) {
          const nextId = [...openTabs][0] || [...byId.keys()].find(k => k !== job.id) || null;
          selectJob(nextId);
        } else {
          renderTabs();
        }
      });
      tab.append(closeBtn);
    }
    return tab;
  });
  container.replaceChildren(...nodes);
}

function renderJobs() {
  const jobs = [...byId.values()].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
  const signature = JSON.stringify([selectedId, ...jobs.map(job => [job.id, job.state, job.progress, job.name, job.pages, sourceFormat(job)])]);
  if (signature !== listSignature) {
    listSignature = signature;
    const list = $('job-list');
    const focused = document.activeElement?.dataset.jobId;
    const children = jobs.map(job => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'job-item';
      button.dataset.jobId = job.id;
      button.setAttribute('aria-pressed', String(job.id === selectedId));
      button.title = job.name;
      const badge = document.createElement('span');
      badge.className = 'file-mark';
      const format = sourceFormat(job);
      badge.textContent = formatBadges[format] || format.toUpperCase();
      badge.setAttribute('aria-hidden', 'true');
      const meta = document.createElement('span');
      const name = document.createElement('span');
      name.className = 'job-title';
      name.textContent = job.name;
      const detail = document.createElement('span');
      detail.className = 'job-detail';
      detail.dataset.state = job.state;
      detail.textContent = `${job.pages}页 · ${jobStatus(job)}${job.state === 'running' ? ` ${jobProgressLabel(job)}` : ''}`;
      meta.append(name, detail);
      button.append(badge, meta);
      button.addEventListener('click', () => {
        openTabs.add(job.id);
        selectJob(job.id);
      });
      li.append(button);
      return li;
    });
    list.replaceChildren(...children);
    if (focused) [...list.querySelectorAll('button')].find(button => button.dataset.jobId === focused)?.focus({preventScroll:true});
    $('file-count').textContent = String(jobs.length);
    $('no-files').hidden = !!jobs.length;
  }
  renderTabs();
}

/* 目录大纲与页面缩略图抽屉 */
function renderOutlineAndThumbs(job) {
  if (!job) return;
  const sig = JSON.stringify([job.id, job.pages, job.toc || []]);
  if (sig === outlineSignature) {
    highlightActiveOutline(currentPage);
    return;
  }
  outlineSignature = sig;

  const tocContainer = $('toc-list');
  const tocItems = Array.isArray(job.toc) && job.toc.length
    ? job.toc
    : Array.from({length: job.pages}, (_, i) => ({level: 1, title: `第 ${i + 1} 页`, page: i + 1}));

  tocContainer.replaceChildren(...tocItems.map(item => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toc-item';
    btn.dataset.page = String(item.page);
    btn.style.paddingLeft = `${7 + (Math.max(1, item.level) - 1) * 10}px`;
    const title = document.createElement('span');
    title.textContent = item.title;
    const pno = document.createElement('small');
    pno.textContent = `P${item.page}`;
    btn.append(title, pno);
    btn.addEventListener('click', () => setPage(item.page, true));
    return btn;
  }));

  const thumbContainer = $('thumb-list');
  const path = jobPath(job.id);
  thumbContainer.replaceChildren(...Array.from({length: job.pages}, (_, i) => {
    const page = i + 1;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'thumb-card';
    card.dataset.page = String(page);
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = `第 ${page} 页缩略图`;
    loadPageImage(img, `${path}/page/original/${page}.png?width=240`);
    const label = document.createElement('span');
    label.textContent = `P${page}`;
    card.append(img, label);
    card.addEventListener('click', () => setPage(page, true));
    return card;
  }));
  highlightActiveOutline(currentPage);
}

function highlightActiveOutline(page) {
  for (const el of $('toc-list').querySelectorAll('.toc-item')) {
    el.classList.toggle('active', Number(el.dataset.page) === page);
  }
  for (const el of $('thumb-list').querySelectorAll('.thumb-card')) {
    el.classList.toggle('active', Number(el.dataset.page) === page);
  }
}

/* 连续滚动流构建与懒加载 */
function setupLazyObserver() {
  if (pageObserver) pageObserver.disconnect();
  pageObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const sheet = entry.target;
      const img = sheet.querySelector('img[data-src]');
      if (img && img.dataset.requested !== img.dataset.src) {
        img.hidden = false;
        loadPageImage(img, img.dataset.src);
      }
    }
  }, {rootMargin: '900px 0px'});
}

function createSheetNode(job, kind, page, width, version) {
  const [w, h] = job.dimensions?.[page - 1] || [];
  const aspect = mobile?.pageAspect(job, page) ||
    (Number(w) > 0 && Number(h) > 0 ? `${Number(w)} / ${Number(h)}` : '612 / 792');
  const done = hasResult(job);
  const waiting = kind === 'translated' && pagePending(job, page);
  const failed = kind === 'translated' && (done || !running(job)) && job.failed_pages?.includes(page);
  const isScan = !mobile && done && kind === 'translated' && job.ocr_pages?.includes(page);
  const path = jobPath(job.id);

  const sheet = document.createElement('div');
  sheet.className = `sheet${isScan ? ' reflow' : ''}`;
  sheet.dataset.page = String(page);
  sheet.style.setProperty('--aspect', aspect);

  const badge = document.createElement('span');
  badge.className = 'page-badge';
  badge.textContent = `${kind === 'original' ? '原文' : waiting ? (canResume(job) ? '待续译' : '待翻译') : failed ? '待重试' : '译文'} P${page}`;
  sheet.append(badge);

  const img = document.createElement('img');
  img.alt = `${kind === 'original' ? '原文' : '译文'}第 ${page} 页`;
  const err = document.createElement('p');
  err.className = 'image-error';
  err.hidden = true;
  err.textContent = '页面渲染加载失败。';

  img.addEventListener('error', () => {
    if (!img.dataset.requested) return;
    img.hidden = true;
    err.hidden = false;
  });

  if (kind === 'original' || (done && !failed)) {
    const url = kind === 'original'
      ? `${path}/page/original/${page}.png?width=${width}`
      : `${path}/page/translated/${page}.png?width=${width}&v=${encodeURIComponent(version)}`;
    img.dataset.src = url;
    if (Math.abs(page - currentPage) <= 1) {
      loadPageImage(img, url);
    } else {
      img.hidden = true;
    }
    sheet.append(img, err);
  } else {
    img.hidden = true;
    sheet.append(img, err);
    const ph = document.createElement('div');
    ph.className = 'page-placeholder';
    const title = document.createElement('strong');
    title.textContent = waiting && canResume(job) ? '第 ' + page + ' 页待续译'
      : running(job) && (waiting || !failed) ? '正在翻译第 ' + page + ' 页…'
      : failed ? '第 ' + page + ' 页待重试' : '等待翻译';
    const note = document.createElement('p');
    note.textContent = waiting ? (canResume(job) ? '点击「继续剩余页」后自动翻译本页。' : '翻译完成后将自动展示本页译文。')
      : failed ? (job.page_errors?.[page] || '可在工具栏选择「重试失败页」。')
      : running(job) ? '翻译完成后将自动展示本页译文。' : '在左侧选择翻译服务并点击开始翻译。';
    ph.append(title, note);
    sheet.append(ph);
  }
  return sheet;
}

function buildPageStreams(job) {
  const zoomVal = $('zoom').disabled ? 100 : Number($('zoom').value) || 100;
  const width = zoomVal >= 150 ? 1500 : 1050;
  const version = resultVersion(job);
  const sig = JSON.stringify([job.id, hasResult(job), running(job) && !hasResult(job), version,
    width, job.pages, job.failed_pages || [], job.remaining_pages || [], canResume(job)]);

  $('dual-stage').style.setProperty('--zoom', `${zoomVal}%`);
  $('dual-stage').classList.toggle('zoom-wide', zoomVal > 100);

  if (sig !== streamSignature) {
    streamSignature = sig;
    setupLazyObserver();
    const origNodes = [];
    const transNodes = [];
    for (let p = 1; p <= job.pages; p++) {
      const oSheet = createSheetNode(job, 'original', p, width, version);
      const tSheet = createSheetNode(job, 'translated', p, width, version);
      origNodes.push(oSheet);
      transNodes.push(tSheet);
      pageObserver.observe(oSheet);
      pageObserver.observe(tSheet);
    }
    $('original-stream').replaceChildren(...origNodes);
    $('translated-stream').replaceChildren(...transNodes);
    requestAnimationFrame(() => scrollToPage(currentPage, false));
  }
}

// 精读交互共用同一份原文段落索引。
const documentReferences = new Map();
const referenceSegments = new Set();
const citationPopover = $('citation-popover');
const inspector = $('selection-inspector');
const inspectionBubble = $('insp-bubble');
let citationAnchor = null;
let citationPinned = false;
let citationCloseTimer;
let selectionSession = null;
let peekOriginalId = null;

function extractDocumentReferences() {
  documentReferences.clear();
  referenceSegments.clear();
  const heading = /^(?:[IVXLCDM\d]+[.、．]\s*)?(?:references|bibliography|参考文献|參考文獻)\s*[:：]?$/i;
  const sectionEnd = /^(?:[IVXLCDM\d]+[.、．]\s*)?(?:appendix\b|acknowledg(?:e)?ments?\b|author biographies\b|附录|附錄|致谢|作者简介)/i;
  const biography = /^[\p{Lu}][\p{L} .'-]{1,65}(?: \([^)]*\))? (?:received the|is currently|was born)\b/u;
  let inReferences = false;
  let ended = false;
  let previousLine = '';
  let item = null;

  for (const [page, entry] of Object.entries(fullSegments)) {
    for (const [segment, [original]] of (entry.pairs || []).entries()) {
      const kind = entry.kinds?.[segment];
      for (const raw of String(original || '').split(/\r?\n/)) {
        const line = raw.trim().replace(/^#{1,6}\s+/, '');
        if (!line) continue;
        if (heading.test(line.replace(/\s+/g, '')) || /^r$/i.test(previousLine) && /^eferences$/i.test(line)) {
          inReferences = true;
          ended = false;
          item = null;
          previousLine = '';
          continue;
        }
        previousLine = line;
        if (sectionEnd.test(line) || (inReferences && biography.test(line))) {
          if (inReferences) ended = true;
          inReferences = false;
          item = null;
          continue;
        }
        if (!ended && kind === 'references') inReferences = true;
        if (!inReferences || kind === 'artwork' || (kind === 'furniture' && !/^Proc\./i.test(line))) continue;
        const key = page + ':' + segment;
        // Some extractors join adjacent references in a single paragraph.
        for (const part of line.split(/(?<=\.)\s+(?=\[\d{1,4}\]\s+\p{L})/u)) {
          const match = /^(?:[\[［]\s*(\d{1,4})\s*[\]］]|(\d{1,4})[.)、．])\s*(\S.*)$/.exec(part);
          if (match) {
            const num = Number(match[1] || match[2]);
            item = documentReferences.has(num) ? null : {num, text:match[3], page:Number(page), segment};
            if (item) documentReferences.set(num, item);
            referenceSegments.add(key);
          } else if (item && item.text.length < 3000) {
            item.text += ' ' + part;
            referenceSegments.add(key);
          }
        }
      }
    }
  }
}

function citedNumbers(label) {
  const numbers = new Set();
  for (const item of label.split(/[,，、;；]/)) {
    const [first, last = first] = item.trim().split(/\s*[-–—−]\s*/).map(Number);
    for (let num = first; num <= Math.min(last, first + 99); num++) {
      if (documentReferences.has(num)) numbers.add(num);
    }
  }
  return [...numbers];
}

const mathSymbols = {
  'α':'\\alpha', 'β':'\\beta', 'γ':'\\gamma', 'δ':'\\delta', 'θ':'\\theta',
  'λ':'\\lambda', 'μ':'\\mu', 'π':'\\pi', 'σ':'\\sigma', 'τ':'\\tau', 'φ':'\\phi', 'ω':'\\omega',
  'Δ':'\\Delta', 'Σ':'\\Sigma', 'Ω':'\\Omega', '∑':'\\sum', '∫':'\\int', '∞':'\\infty',
  '≤':'\\leq', '≥':'\\geq', '≠':'\\ne', '≈':'\\approx', '×':'\\times', '·':'\\cdot',
  '±':'\\pm', '−':'-', '→':'\\to'
};

function latexSource(text, kind) {
  const equations = text.match(/(?<!\\)(?:\$\$[\s\S]+?\$\$|\$(?![\s$])[^$\n]+?(?<!\s)\$(?![$\d])|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]|\\begin\{(equation\*?|align\*?|gather\*?|cases|[pbvBV]?matrix)\}[\s\S]+?\\end\{\1\})/g);
  const extracted = equations?.filter(equation => !/\{v\d+\}|公式见\s*PDF/i.test(equation));
  if (extracted?.length) return extracted.join('\n');
  const raw = text.trim();
  if (kind !== 'formula' || /\{v\d+\}|公式见\s*PDF/i.test(raw)) return '';
  if (/^\\(?:frac|sqrt|sum|int|prod)\b/.test(raw)) return raw;
  const expression = raw.replace(/\s+\(\d+\)\s*$/, '');
  if (!/[=≠≈≤≥]/.test(expression) || /^[=+−*/]/.test(expression) || /[=+−*/]$/.test(expression) ||
      !/^[\w\s.,()+\-*/^=<>{}[\]|αβγδθλμπστφωΔΣΩ∑∫∞≤≥≠≈×·±−→⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]+$/.test(expression) ||
      /\b[A-Za-z]{4,}\b|[A-Za-z]\s+\d/.test(expression)) return '';
  return Array.from(expression, char => mathSymbols[char] ? mathSymbols[char] + ' ' : char).join('')
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, part => '^{' + Array.from(part, char => '⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(char)).join('') + '}')
    .replace(/[₀₁₂₃₄₅₆₇₈₉]+/g, part => '_{' + Array.from(part, char => '₀₁₂₃₄₅₆₇₈₉'.indexOf(char)).join('') + '}').trim();
}

function positionReadingOverlay(overlay, rect, above = false) {
  const viewport = window.visualViewport;
  const x = viewport?.offsetLeft || 0;
  const y = viewport?.offsetTop || 0;
  const width = viewport?.width || innerWidth;
  const height = viewport?.height || innerHeight;
  const gap = 8;
  const {offsetWidth:w, offsetHeight:h} = overlay;
  const upper = rect.top - h - gap;
  const lower = rect.bottom + gap;
  const top = above && upper >= y + gap || lower + h > y + height - gap ? upper : lower;
  overlay.style.left = Math.max(x + gap, Math.min(rect.left, x + width - w - gap)) + 'px';
  overlay.style.top = Math.max(y + gap, Math.min(top, y + height - h - gap)) + 'px';
}

async function copyReadingText(text, label) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const field = document.createElement('textarea');
      field.value = text;
      field.style.cssText = 'position:fixed;left:0;top:0;opacity:0;pointer-events:none';
      document.body.append(field);
      try {
        field.select();
        if (!document.execCommand('copy')) throw new Error('copy');
      } finally { field.remove(); }
    }
    if (label) announce(label);
    return true;
  } catch {
    announce('无法访问剪贴板，可选中文字复制。', true);
    return false;
  }
}

function closeCitation() {
  clearTimeout(citationCloseTimer);
  citationAnchor?.setAttribute('aria-expanded', 'false');
  citationAnchor = null;
  citationPinned = false;
  citationPopover.hidden = true;
}

function dismissCitationOnLeave() {
  if (!citationPinned) citationCloseTimer = setTimeout(closeCitation, 200);
}

function showCitationPopover(anchor, numbers, pin) {
  const job = currentJob();
  if (!job) return;
  if (citationAnchor === anchor) {
    clearTimeout(citationCloseTimer);
    citationPinned ||= pin;
    return;
  }
  closeCitation();
  const entries = numbers.map(number => documentReferences.get(number));
  citationAnchor = anchor;
  citationPinned = pin;
  anchor.setAttribute('aria-expanded', 'true');
  $('cite-pop-num').textContent = anchor.textContent;
  $('cite-pop-content').replaceChildren(...entries.map(ref => {
    const row = document.createElement('div');
    row.className = 'cite-pop-entry';
    const text = document.createElement('div');
    const number = document.createElement('strong');
    number.textContent = '[' + ref.num + '] ';
    text.append(number, ref.text);
    const jump = readerButton('定位第 ' + ref.page + ' 页', async () => {
      closeCitation();
      const stillCurrent = () => currentJob()?.id === job.id;
      if (!await locateParagraph(job, ref.page, ref.segment, stillCurrent) && stillCurrent()) {
        setMode('orig-pdf');
        setPage(ref.page, true);
      }
    }, 'link-button');
    row.append(text, jump);
    return row;
  }));
  $('cite-pop-copy').onclick = () => void copyReadingText(entries.map(ref => '[' + ref.num + '] ' + ref.text).join('\n'), '已复制参考文献。');
  citationPopover.hidden = false;
  positionReadingOverlay(citationPopover, anchor.getBoundingClientRect());
}

function decorateContentWithCitationsAndLatex(container, rawText, page, segment, isTranslation, kind) {
  const text = String(rawText || '');
  container.dataset.readingText = isTranslation ? 'translation' : 'original';
  container.dataset.readingPage = page;
  container.dataset.readingSegment = segment;
  if (!text) return;
  let offset = 0;
  if (!referenceSegments.has(page + ':' + segment)) {
    const pattern = /[\[［]\s*(\d{1,4}(?:\s*[-–—−,，、;；]\s*\d{1,4})*)\s*[\]］]/g;
    for (const match of text.matchAll(pattern)) {
      const numbers = citedNumbers(match[1]);
      if (!numbers.length) continue;
      const tag = document.createElement('span');
      tag.className = 'cite-ref';
      tag.textContent = match[0];
      tag.tabIndex = 0;
      tag.setAttribute('role', 'button');
      tag.setAttribute('aria-expanded', 'false');
      tag.setAttribute('aria-controls', citationPopover.id);
      tag.addEventListener('pointerenter', event => {
        if (event.pointerType === 'mouse' && (!citationPinned || citationAnchor === tag)) showCitationPopover(tag, numbers, false);
      });
      tag.addEventListener('pointerleave', dismissCitationOnLeave);
      tag.addEventListener('click', event => {
        event.stopPropagation();
        if (window.getSelection()?.isCollapsed === false) return;
        showCitationPopover(tag, numbers, true);
      });
      tag.addEventListener('keydown', event => {
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        showCitationPopover(tag, numbers, true);
        $('cite-pop-close').focus();
      });
      container.append(text.slice(offset, match.index), tag);
      offset = match.index + match[0].length;
    }
  }
  container.append(text.slice(offset));
  const latex = latexSource(text, kind);
  if (latex) container.append(readerButton('复制 LaTeX', event => {
    event.stopPropagation();
    void copyReadingText(latex, '已复制 LaTeX 源码。');
  }, 'copy-latex-btn'));
}

const localConcepts = {
  adc:['模数转换器','按一定速率采样模拟信号，并把每次采样的幅值量化为数字码。'],
  'sar adc':['逐次逼近型模数转换器','通过比较器和数模转换器逐位逼近输入电压，得到数字输出。'],
  cmos:['互补金属氧化物半导体','用互补的 NMOS 与 PMOS 器件实现电路，可降低静态功耗。'],
  snr:['信噪比','信号功率与噪声功率的比值，常用分贝表示。'],
  enob:['有效位数','由测得的信号与噪声失真比换算出的等效量化位数。'],
  sfdr:['无杂散动态范围','主信号与最大杂散分量的幅值比，常用 dBc 表示。'],
  doi:['数字对象标识符','用于持久识别论文和数据等数字资源，可在 DOI 解析服务中定位其来源。'],
  ocr:['光学字符识别','将扫描图像里的印刷文字转换成可搜索和编辑的文本。'],
  'confidence interval':['置信区间','用重复抽样构造区间时，给定比例的区间能覆盖真实参数。'],
  'standard deviation':['标准差','方差的平方根，衡量观测值相对于均值的离散程度。'],
  'floating inverter amplifier':['浮动反相器放大器','以浮动电容供电的反相器放大级，常见于低功耗动态比较器。']
};

function glossaryRows() {
  return $('glossary').value.split(/\r?\n/).map(line => {
    const match = /^\s*(.+?)\s*(?:=|→|->|：|:|\t)\s*(.+?)\s*$/.exec(line);
    return {line, source:match?.[1] || '', target:match?.[2] || ''};
  });
}

function closeSelectionInspector() {
  selectionSession = null;
  inspector.hidden = inspectionBubble.hidden = true;
}

function readingSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const text = range.toString().trim();
  if (!text || text.length > 1000) return null;
  const node = endpoint => (endpoint.nodeType === Node.ELEMENT_NODE ? endpoint : endpoint.parentElement);
  const source = node(range.startContainer)?.closest('[data-reading-text]');
  if (!source || source !== node(range.endContainer)?.closest('[data-reading-text]') ||
      range.cloneContents().querySelector('button')) return null;
  const rect = range.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const originalSide = source.dataset.readingText === 'original';
  const pair = fullSegments[source.dataset.readingPage]?.pairs?.[source.dataset.readingSegment];
  const context = pair?.[originalSide ? 0 : 1] || text;
  const nearby = Math.max(0, context.indexOf(text) - 450);
  return {source, text, rect, range:range.cloneRange(), originalSide, original:pair?.[0] || '',
    context:context.slice(nearby, nearby + 1400)};
}

function setupSelectionInspector() {
  let selectionTimer;
  let interacting = false;
  let actionSelected = false;
  const bubbleText = $('insp-bubble-text');
  const glossary = $('glossary-dialog');
  const term = $('glossary-term');
  const translation = $('glossary-translation');

  function repositionSelection() {
    const session = selectionSession;
    if (!session || inspector.hidden) return;
    const rect = session.range.getBoundingClientRect();
    const pane = session.source.closest('.pane, #viewer-scroll')?.getBoundingClientRect();
    if (!session.source.isConnected || !rect.height || (pane && (rect.bottom < pane.top || rect.top > pane.bottom))) {
      closeSelectionInspector();
      return;
    }
    session.rect = rect;
    positionReadingOverlay(inspector, rect, true);
  }

  citationPopover.addEventListener('pointerenter', () => clearTimeout(citationCloseTimer));
  citationPopover.addEventListener('pointerleave', dismissCitationOnLeave);
  $('cite-pop-close').addEventListener('click', () => {
    citationAnchor?.focus({preventScroll:true});
    closeCitation();
  });
  document.addEventListener('selectionchange', () => {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      if (glossary.open || interacting || (!inspector.hidden && inspector.contains(document.activeElement))) return;
      const next = readingSelection();
      if (!next) {
        if (!actionSelected && inspectionBubble.hidden) closeSelectionInspector();
        return;
      }
      if (selectionSession?.text === next.text && selectionSession.source === next.source) return;
      selectionSession = next;
      actionSelected = false;
      inspectionBubble.hidden = true;
      inspector.hidden = false;
      positionReadingOverlay(inspector, next.rect, true);
    }, 140);
  });
  document.addEventListener('pointerdown', event => {
    interacting = inspector.contains(event.target);
    actionSelected = interacting;
    if (!interacting && !event.target.closest('dialog')) closeSelectionInspector();
    if (!citationPopover.contains(event.target) && !event.target.closest('.cite-ref')) closeCitation();
  }, true);
  for (const name of ['pointerup', 'pointercancel']) {
    document.addEventListener(name, () => { interacting = false; }, true);
  }
  inspector.addEventListener('mousedown', event => {
    if (event.target.closest('button')) event.preventDefault();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { closeCitation(); closeSelectionInspector(); }
  });
  document.addEventListener('scroll', event => {
    if (citationPopover.contains(event.target) || inspector.contains(event.target)) return;
    closeCitation();
    repositionSelection();
  }, true);
  window.addEventListener('resize', () => { closeCitation(); repositionSelection(); });

  $('insp-explain-btn').addEventListener('click', async () => {
    const session = selectionSession;
    if (!session) return;
    const selection = session.text;
    const key = selection.toLowerCase().replace(/\s+/g, ' ');
    const custom = glossaryRows().find(row => row.source.toLowerCase() === key || row.target.toLowerCase() === key);
    const local = Object.hasOwn(localConcepts, key) ? localConcepts[key]
      : Object.values(localConcepts).find(([name]) => name === selection);
    const fallback = local ? local[0] + '。' + local[1]
      : custom ? custom.source + ' · ' + custom.target : window.PaperStudioMobile?.lookupDict?.(selection);
    const hint = $('insp-bubble-hint');
    inspectionBubble.hidden = false;
    $('insp-bubble-copy').disabled = true;
    const show = (content, source, copy = true) => {
      bubbleText.textContent = content;
      hint.textContent = source;
      $('insp-bubble-copy').disabled = !copy;
      positionReadingOverlay(inspector, session.rect, true);
    };
    const options = modelSettings();
    const localOnly = ['offline', 'precision'].includes(options.provider) ||
      (usesApi(options.provider) && !options.model) ||
      window.PaperStudioMobile?.isStandalone?.();
    if (localOnly) {
      show(fallback || '本机词库暂无这个条目。配置模型后可获取上下文解释。', '本机词库', Boolean(fallback));
      return;
    }
    show('正在生成学术解释…', providerLabels[options.provider] || '模型', false);
    try {
      const {explanation} = await jsonRequest('/api/explain', 'POST', {...options, text:selection,
        context:session.context});
      if (selectionSession === session && session.source.isConnected && !inspectionBubble.hidden) {
        show(explanation, providerLabels[options.provider] || '模型');
      }
    } catch (error) {
      if (selectionSession === session && !inspectionBubble.hidden) {
        show(fallback || error.message, fallback ? '本机词库' : '解释失败', Boolean(fallback));
      }
    }
  });
  $('insp-bubble-close').addEventListener('click', () => {
    inspectionBubble.hidden = true;
    if (selectionSession) positionReadingOverlay(inspector, selectionSession.rect, true);
  });
  $('insp-bubble-copy').addEventListener('click', () => void copyReadingText(bubbleText.textContent, '已复制解释。'));
  $('insp-copy-btn').addEventListener('click', async () => {
    if (selectionSession && await copyReadingText(selectionSession.text, '已复制选中文字。')) closeSelectionInspector();
  });
  $('insp-deepseek-btn').addEventListener('click', async () => {
    if (!selectionSession) return;
    const prompt = '请结合学术语境简要解释以下论文片段。\n\n' + selectionSession.text;
    if (mobile?.shareQuestion) {
      try { await mobile.shareQuestion(prompt); }
      catch (error) { announce(error.message, true); }
    } else {
      window.open('https://chat.deepseek.com/', '_blank', 'noopener');
      await copyReadingText(prompt, '已复制提问，可在 DeepSeek 粘贴。');
    }
    closeSelectionInspector();
  });
  $('insp-scholar-btn').addEventListener('click', () => {
    if (!selectionSession) return;
    const url = 'https://scholar.google.com/scholar?q=' + encodeURIComponent(selectionSession.text);
    if (mobile?.openExternal) void mobile.openExternal(url).catch(error => announce(error.message, true));
    else window.open(url, '_blank', 'noopener');
    closeSelectionInspector();
  });
  $('insp-add-glossary-btn').addEventListener('click', () => {
    const session = selectionSession;
    if (!session) return;
    const selected = session.text.replace(/\s+/g, ' ').slice(0, 180);
    const key = selected.toLowerCase();
    const known = glossaryRows().find(row => (session.originalSide ? row.source : row.target).toLowerCase() === key);
    const sameAsOriginal = /^[A-Za-z][A-Za-z0-9 -]*$/.test(selected) && session.original.toLowerCase().includes(key);
    term.value = known?.source || (session.originalSide || sameAsOriginal ? selected : '');
    translation.value = known?.target || (session.originalSide || sameAsOriginal ? localConcepts[key]?.[0] || '' : selected);
    closeSelectionInspector();
    glossary.showModal();
    (term.value ? translation : term).focus();
  });
  $('glossary-cancel').addEventListener('click', () => glossary.close());
  $('glossary-entry-form').addEventListener('submit', async event => {
    event.preventDefault();
    const original = term.value.trim();
    const target = translation.value.trim();
    if (!original || !target || /[=→：:\t]|->/.test(original)) {
      announce('请填写有效的原文术语和对应译名。', true);
      return;
    }
    const rows = glossaryRows().filter(row => row.line.trim());
    const index = rows.findIndex(row => row.source.toLowerCase() === original.toLowerCase());
    const line = original + ' = ' + target;
    if (index < 0) rows.push({line});
    else rows[index].line = line;
    const updated = rows.map(row => row.line).join('\n');
    if (updated.length > $('glossary').maxLength) {
      announce('术语表已达到容量上限，请先在翻译设置中精简已有条目。', true);
      return;
    }
    $('glossary').value = updated;
    const button = event.currentTarget.querySelector('[type="submit"]');
    button.disabled = true;
    clearTimeout(saveSettingsTimer);
    try {
      await persistSettings();
      glossary.close();
      announce('已保存术语。新翻译任务会读取更新后的术语表。');
    } catch (error) {
      announce('术语保存失败。' + error.message, true);
    } finally { button.disabled = false; }
  });
}

function setupFitWidthLock() {
  const button = $('fit-width-btn');
  const viewer = $('viewer-scroll');
  function lock(enabled) {
    viewer.classList.toggle('fit-width-locked', enabled);
    button.setAttribute('aria-pressed', String(enabled));
    $('zoom').disabled = enabled;
  }
  try { lock(localStorage.getItem('paper_studio_fit_width') === '1'); } catch {}
  button.addEventListener('click', () => {
    const enabled = button.getAttribute('aria-pressed') !== 'true';
    lock(enabled);
    if (enabled) for (const pane of [viewer, leftPane, rightPane]) pane.scrollLeft = 0;
    renderPages(currentJob());
    scrollToPage(currentPage, false);
    try { localStorage.setItem('paper_studio_fit_width', enabled ? '1' : '0'); } catch {}
  });
}

function setupPeekToggleFab() {
  const button = $('peek-toggle-fab');
  const panes = [leftPane, rightPane, $('viewer-scroll')];
  let gesture = null;
  let suppressClick = false;

  function release(event) {
    if (!gesture || (event?.pointerId != null && event.pointerId !== gesture.pointer)) return;
    const held = gesture;
    gesture = null;
    clearTimeout(held.timer);
    if (button.hasPointerCapture(held.pointer)) button.releasePointerCapture(held.pointer);
    if (!held.positions) return;
    suppressClick = true;
    peekOriginalId = null;
    button.classList.remove('peeking');
    $('peek-label').textContent = '原译对比';
    const job = currentJob();
    if (job?.id !== held.id) return;
    clearTimeout(scrollReleaseTimer);
    programmaticScroll = true;
    renderPages(job);
    panes.forEach((pane, index) => {
      pane.scrollTop = held.positions[index][0];
      pane.scrollLeft = held.positions[index][1];
    });
    scrollReleaseTimer = setTimeout(() => { programmaticScroll = false; }, 80);
  }

  button.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || !hasResult(currentJob())) return;
    suppressClick = false;
    button.setPointerCapture(event.pointerId);
    const held = {pointer:event.pointerId, id:selectedId};
    gesture = held;
    held.timer = setTimeout(() => {
      const job = currentJob();
      if (gesture !== held || job?.id !== held.id) return;
      held.positions = panes.map(pane => [pane.scrollTop, pane.scrollLeft]);
      const pane = leftPane.hidden ? rightPane : leftPane;
      const oldPage = pane.querySelector('[data-page="' + currentPage + '"]');
      const fraction = oldPage ? Math.min(0.99, Math.max(0, (pane.scrollTop - oldPage.offsetTop) / oldPage.offsetHeight)) : 0;
      peekOriginalId = job.id;
      button.classList.add('peeking');
      $('peek-label').textContent = '松手返回';
      renderPages(job);
      const original = leftPane.querySelector('.sheet[data-page="' + currentPage + '"]');
      if (original) leftPane.scrollTop = original.offsetTop - 8 + fraction * original.offsetHeight;
    }, 220);
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(name, release);
  button.addEventListener('contextmenu', event => event.preventDefault());
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
  button.addEventListener('click', event => {
    if (event.detail && suppressClick) { suppressClick = false; return; }
    if (!hasResult(currentJob())) return;
    const modes = ['dual-pdf', 'mono-pdf', 'orig-pdf'];
    setMode(modes[(modes.indexOf(viewMode) + 1) % modes.length]);
  });
}

/* Doc2X 风格：右侧结构化双语段落流与在线编辑 */
function ensureFullSegments(job) {
  if (!hasResult(job) || !job.has_text) return Promise.resolve(false);
  const key = textKey(job);
  if (segmentsJobKey === key) return Promise.resolve(true);
  if (segmentsRequest?.key === key) return segmentsRequest.promise;
  const loading = {key};
  loading.promise = request(`${jobPath(job.id)}/segments`).then(res => {
    if (textKey(currentJob()) !== key) return false;
    if (viewMode === 'doc2x') { closeCitation(); closeSelectionInspector(); }
    fullSegments = res.pages || {};
    segmentsJobKey = key;
    extractDocumentReferences();
    renderDoc2xStream(currentJob());
    return true;
  }).catch(error => {
    if (textKey(currentJob()) === key && viewMode === 'doc2x') {
      const note = document.createElement('p');
      note.className = 'text-page-message';
      note.textContent = `段落读取失败。${error.message}`;
      $('doc2x-stream').replaceChildren(note);
    }
    return false;
  }).finally(() => {
    if (segmentsRequest === loading) segmentsRequest = null;
  });
  segmentsRequest = loading;
  return loading.promise;
}

let paragraphSession = null;
let notesSession = null;

function jsonRequest(path, method, body) {
  return request(path, {method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
}

function readerButton(label, action, className = 'secondary compact-btn') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

function paragraphLocation(page, segment) {
  return `第 ${page} 页 · 第 ${segment + 1} 段`;
}

function dialogStatus(id, text, isError = false) {
  $(id).textContent = text;
  $(id).dataset.kind = isError ? 'error' : '';
}

function syncParagraphEditor(session) {
  const locked = Boolean(session.busy) || !session.review;
  $('paragraph-draft').readOnly = locked;
  $('paragraph-retranslate').disabled = locked || Boolean(session.review?.source_unavailable);
  $('paragraph-draft-save').disabled = locked;
  $('paragraph-publish').disabled = locked || Boolean(session.review?.pdf_error);
  $('paragraph-close').disabled = session.busy === 'saving';
}

async function openParagraphEditor(job, page, segment, original, translation) {
  if (running(currentJob()) || pending.has(job.id)) { announce('请等当前任务结束后再编辑译文。'); return; }
  const session = {
    jobId: job.id, page, segment, revision: textRevision(job),
    url: `${jobPath(job.id)}/paragraph/${page}/${segment}`, busy: 'loading'
  };
  paragraphSession = session;
  $('paragraph-location').textContent = `${job.name} · ${paragraphLocation(page, segment)}`;
  $('paragraph-original').textContent = original;
  $('paragraph-current').textContent = translation;
  $('paragraph-draft').value = translation;
  $('paragraph-formula').hidden = true;
  const model = modelSettings();
  const service = $('provider').selectedOptions[0]?.textContent || providerLabels[model.provider];
  $('paragraph-engine').textContent = `重译使用左侧设置 · ${service}${model.model ? ` · ${model.model}` : ''}`;
  dialogStatus('paragraph-state', '正在读取该段的排版信息…');
  syncParagraphEditor(session);
  $('paragraph-dialog').showModal();
  try {
    const review = await request(session.url);
    if (paragraphSession !== session) return;
    if (review.revision !== session.revision) throw new Error('译文已更新，请重新打开这个段落。');
    session.review = review;
    $('paragraph-original').textContent = review.source;
    $('paragraph-current').textContent = review.current;
    $('paragraph-draft').value = review.draft;
    $('paragraph-formula').hidden = !review.has_formulas;
    if (mobile) $('paragraph-formula').textContent = '可调整公式位置，写回 PDF 时请原样保留公式文字。';
    dialogStatus('paragraph-state', review.pdf_error || '', Boolean(review.pdf_error));
  } catch (error) {
    if (paragraphSession === session) dialogStatus('paragraph-state', error.message, true);
  } finally {
    session.busy = '';
    if (paragraphSession === session) syncParagraphEditor(session);
  }
}

async function retranslateParagraph() {
  const session = paragraphSession;
  if (!session?.review || session.busy) return;
  session.busy = 'translating';
  syncParagraphEditor(session);
  dialogStatus('paragraph-state', '正在重译所选段落…');
  try {
    const result = await jsonRequest(session.url, 'POST', {
      ...modelSettings(), glossary: $('glossary').value, revision: session.revision
    });
    if (paragraphSession !== session) return;
    $('paragraph-draft').value = result.draft;
    dialogStatus('paragraph-state', session.review.pdf_error || '重译完成。可以修改拟用译文后再保存。',
                 Boolean(session.review.pdf_error));
  } catch (error) {
    if (paragraphSession === session) dialogStatus('paragraph-state', error.message, true);
  } finally {
    session.busy = '';
    if (paragraphSession === session) syncParagraphEditor(session);
  }
}

async function saveReviewedParagraph(writePdf) {
  const session = paragraphSession;
  if (!session?.review || session.busy) return;
  const translation = $('paragraph-draft').value.trim();
  if (!translation) { dialogStatus('paragraph-state', '译文不能为空。', true); $('paragraph-draft').focus(); return; }
  session.busy = 'saving';
  pending.add(session.jobId);
  syncParagraphEditor(session);
  dialogStatus('paragraph-state', writePdf ? `正在重排第 ${session.page} 页并更新导出…` : '正在保存文字稿…');
  try {
    const {job} = await jsonRequest(session.url, 'PUT', {
      revision: session.revision, translation, write_pdf: writePdf
    });
    pending.delete(session.jobId);
    $('paragraph-dialog').close();
    upsert(job);
    announce(writePdf ? `第 ${session.page} 页已写回 PDF。` : '已保存文字稿。');
    if (selectedId === job.id && viewMode === 'doc2x') {
      void locateParagraph(job, session.page, session.segment, () => textKey(currentJob()) === textKey(job));
    }
  } catch (error) {
    if (paragraphSession === session) dialogStatus('paragraph-state', error.message, true);
  } finally {
    pending.delete(session.jobId);
    updateForm();
    session.busy = '';
    if (paragraphSession === session) syncParagraphEditor(session);
  }
}

function paragraphActions(job, page, segment, original, translation) {
  const actions = document.createElement('div');
  actions.className = 'doc2x-seg-actions';
  actions.append(
    readerButton('编辑', () => void openParagraphEditor(job, page, segment, original, translation), ''),
    readerButton('记笔记', () => openNotes(job, {page, segment, original, translation}), '')
  );
  return actions;
}

function openNotes(job, excerpt = null) {
  const session = {jobId: job.id, revision: textRevision(job), url: `${jobPath(job.id)}/notes`};
  notesSession = session;
  $('notes-document').textContent = job.name;
  $('notes-export').href = `${session.url}.md`;
  $('notes-dialog').showModal();
  if (excerpt) showNoteEditor(session, excerpt);
  else void showNoteList(session);
}

function showNoteEditor(session, note) {
  session.edit = note;
  $('notes-library').hidden = true;
  $('note-form').hidden = false;
  $('note-location').textContent = paragraphLocation(note.page, note.segment);
  $('note-original').textContent = note.original;
  $('note-translation').textContent = note.translation;
  $('note-comment').value = note.comment || '';
  $('note-save').disabled = false;
  $('note-back').disabled = false;
  dialogStatus('notes-state', '');
  $('note-comment').focus();
}

function noteExcerpts(note) {
  const details = document.createElement('details');
  const label = document.createElement('summary');
  label.textContent = '原文与译文';
  const columns = document.createElement('div');
  columns.className = 'review-columns';
  for (const [title, content] of [['原文', note.original], ['译文', note.translation]]) {
    const column = document.createElement('div');
    const heading = document.createElement('h3');
    heading.textContent = title;
    const excerpt = document.createElement('div');
    excerpt.className = 'review-excerpt';
    excerpt.textContent = content;
    column.append(heading, excerpt);
    columns.append(column);
  }
  details.append(label, columns);
  return details;
}

async function showNoteList(session) {
  session.edit = null;
  $('notes-library').hidden = false;
  $('note-form').hidden = true;
  $('notes-list').replaceChildren();
  $('notes-count').textContent = '';
  $('notes-export').hidden = true;
  dialogStatus('notes-state', '正在读取双语笔记…');
  try {
    const {notes} = await request(session.url);
    if (notesSession !== session) return;
    $('notes-count').textContent = `${notes.length} 条笔记`;
    $('notes-export').hidden = !notes.length;
    dialogStatus('notes-state', notes.length ? '' : '在任意双语段落点「记笔记」即可保存摘录。');
    const items = notes.map(note => {
      const card = document.createElement('article');
      card.className = 'note-card';
      const title = document.createElement('h3');
      title.textContent = paragraphLocation(note.page, note.segment);
      const comment = document.createElement('p');
      comment.textContent = note.comment;
      const actions = document.createElement('div');
      actions.className = 'reader-dialog-actions';
      actions.append(
        readerButton('定位到段落', () => void jumpToNote(session, note)),
        readerButton('编辑笔记', () => showNoteEditor(session, note)),
        readerButton('删除笔记', () => void deleteNote(session, note))
      );
      card.append(title);
      if (note.comment) card.append(comment);
      card.append(noteExcerpts(note), actions);
      return card;
    });
    $('notes-list').replaceChildren(...items);
  } catch (error) {
    if (notesSession === session) dialogStatus('notes-state', error.message, true);
  }
}

async function saveNote(event) {
  event.preventDefault();
  const session = notesSession;
  const note = session?.edit;
  if (!note || $('note-save').disabled) return;
  const comment = $('note-comment').value;
  $('note-save').disabled = true;
  $('note-back').disabled = true;
  try {
    if (note.id) {
      await jsonRequest(`${session.url}/${note.id}`, 'PUT', {comment});
    } else {
      await jsonRequest(session.url, 'POST', {page: note.page, segment: note.segment, comment, revision: session.revision});
    }
    if (notesSession === session) await showNoteList(session);
  } catch (error) {
    if (notesSession === session) dialogStatus('notes-state', error.message, true);
  } finally {
    if (notesSession === session) {
      $('note-save').disabled = false;
      $('note-back').disabled = false;
    }
  }
}

async function deleteNote(session, note) {
  if (!window.confirm('删除这条双语笔记？')) return;
  try {
    await request(`${session.url}/${note.id}`, {method: 'DELETE'});
    if (notesSession === session) await showNoteList(session);
  } catch (error) {
    if (notesSession === session) dialogStatus('notes-state', error.message, true);
  }
}

async function jumpToNote(session, note) {
  $('notes-dialog').close();
  const job = currentJob();
  if (job?.id !== session.jobId) return;
  const stillCurrent = () => textKey(currentJob()) === textKey(job);
  const found = await locateParagraph(job, note.page, note.segment, stillCurrent, note.anchor_original ?? note.original);
  if (!found && stillCurrent()) {
    setMode('dual-pdf');
    setPage(note.page, true);
    announce(`已定位到原文第 ${note.page} 页。该段落已调整。`);
  }
}

function renderDoc2xStream(job) {
  const container = $('doc2x-stream');
  const key = JSON.stringify([textKey(job), job.state, job.failed_pages, job.remaining_pages, job.preserved_pages]);
  if (doc2xRenderKey === key) return;
  doc2xRenderKey = key;
  if (!hasResult(job) || !job.has_text) {
    container.replaceChildren();
    return;
  }
  const cards = [];
  const failed = new Set(job.failed_pages || []);
  const preserved = new Set(job.preserved_pages || []);
  for (let p = 1; p <= job.pages; p++) {
    const entry = fullSegments[String(p)];
    if (!entry?.pairs?.length && !failed.has(p) && !preserved.has(p)) continue;

    const card = document.createElement('div');
    card.className = 'doc2x-page-card';
    card.dataset.page = String(p);
    if (failed.has(p) || preserved.has(p)) {
      const title = document.createElement('strong');
      const waiting = pagePending(job, p);
      const status = waiting ? (canResume(job) ? '待续译' : '待翻译') : failed.has(p) ? '待重试' : '保留原文';
      title.textContent = '第 ' + p + ' 页 · ' + status;
      const reason = document.createElement('p');
      reason.className = 'text-page-message';
      reason.textContent = waiting ? '本页译完后会自动显示。'
        : preserved.has(p) ? '已按忽略翻译设置保留，可在双栏 PDF 中查看。'
        : job.page_errors?.[p] || '可在工具栏选择「重试失败页」。';
      card.append(title, reason);
      cards.push(card);
      continue;
    }

    const head = document.createElement('div');
    head.className = 'doc2x-page-head';
    const title = document.createElement('span');
    title.textContent = `第 ${p} 页${entry.mode === 'ocr' ? ' · OCR' : ''}`;
    const copyAllBtn = document.createElement('button');
    copyAllBtn.type = 'button';
    copyAllBtn.className = 'link-button tiny-btn';
    copyAllBtn.textContent = '复制本页';
    copyAllBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(entry.pairs.map(([, t]) => t).join('\n\n'));
        announce(`已复制第 ${p} 页全部译文。`);
      } catch {
        announce('无法访问剪贴板，请直接选中文字复制。', true);
      }
    });
    head.append(title, copyAllBtn);
    card.append(head);

    entry.pairs.forEach(([orig, trans, issues], idx) => {
      const seg = document.createElement('div');
      seg.className = 'doc2x-seg';
      seg.dataset.segment = String(idx);
      seg.addEventListener('click', event => {
        if (event.target.closest('button, textarea, details, .cite-ref') || !window.getSelection()?.isCollapsed) return;
        setPage(p, true);
      });

      const bar = document.createElement('div');
      bar.className = 'doc2x-seg-bar';
      const anchor = document.createElement('span');
      anchor.textContent = `P${p}.${idx + 1}`;
      const actions = paragraphActions(job, p, idx, orig, trans);

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.textContent = '复制';
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(trans);
          announce('已复制该段落译文。');
        } catch {
          announce('复制失败，请手动选中复制。', true);
        }
      });

      actions.prepend(copyBtn);
      bar.append(anchor, actions);

      const origEl = document.createElement('div');
      origEl.className = 'doc2x-orig';
      decorateContentWithCitationsAndLatex(origEl, orig, p, idx, false, entry.kinds?.[idx]);

      const transEl = document.createElement('div');
      transEl.className = 'doc2x-trans';
      decorateContentWithCitationsAndLatex(transEl, trans, p, idx, true, entry.kinds?.[idx]);

      seg.append(bar, origEl, transEl);
      if (issues?.length) {
        const review = document.createElement('details');
        review.className = 'segment-review';
        const summary = document.createElement('summary');
        summary.textContent = `校对提示（${issues.length}）`;
        const messages = document.createElement('ul');
        for (const issue of issues) {
          const item = document.createElement('li');
          item.textContent = issue.message;
          messages.append(item);
        }
        review.append(summary, messages);
        seg.append(review);
      }
      card.append(seg);
    });
    cards.push(card);
  }
  container.replaceChildren(...cards);
}

function renderLegacySinglePage(job) {
  const page = currentPage;
  const done = hasResult(job) && !job.failed_pages?.includes(page);
  const path = jobPath(job.id);
  const version = resultVersion(job);
  const width = Number($('zoom').value) >= 150 ? 1500 : 1000;
  const origImg = $('original-page');
  const transImg = $('translated-page');
  loadPageImage(origImg, `${path}/page/original/${page}.png?width=${width}`);
  if (done) {
    transImg.hidden = false;
    loadPageImage(transImg, `${path}/page/translated/${page}.png?width=${width}&v=${encodeURIComponent(version)}`);
  } else {
    transImg.removeAttribute('src');
    transImg.hidden = true;
  }
}

function updatePageIndicators(page, total) {
  if (document.activeElement !== $('page-number')) $('page-number').value = page;
  $('page-total').textContent = `/ ${total}`;
  $('mini-page-indicator').textContent = `${page} / ${total}`;
  $('zen-page-info').textContent = `${page} / ${total}`;
  $('previous-page').disabled = page <= 1;
  $('next-page').disabled = page >= total;
  $('zen-prev').disabled = page <= 1;
  $('zen-next').disabled = page >= total;
}

function renderPages(job) {
  if (!job) return;
  const page = currentPage;
  const done = hasResult(job);
  const canReadText = done && job.has_text;
  const peeking = peekOriginalId === job.id;
  $('peek-toggle-fab').hidden = !done;

  if (!canReadText && (viewMode === 'doc2x' || viewMode === 'text')) viewMode = 'dual-pdf';
  if (!done && viewMode === 'mono-pdf') viewMode = 'dual-pdf';

  $('page-number').max = job.pages;
  updatePageIndicators(page, job.pages);

  $('doc2x-mode').disabled = !canReadText;
  $('text-mode').disabled = !canReadText;
  $('mono-view-mode').disabled = !done;

  const effectiveMode = peeking ? 'orig-pdf' : viewMode;
  for (const [id, m] of [
    ['page-mode', 'dual-pdf'],
    ['doc2x-mode', 'doc2x'],
    ['text-mode', 'text'],
    ['mono-view-mode', 'mono-pdf'],
    ['orig-view-mode', 'orig-pdf']
  ]) {
    $(id).setAttribute('aria-pressed', String(effectiveMode === m));
  }

  const showPureText = effectiveMode === 'text';
  const showDoc2x = effectiveMode === 'doc2x';
  const singleLeft = effectiveMode === 'orig-pdf';
  mobile?.showCredit(job, !singleLeft);
  const singleRight = effectiveMode === 'mono-pdf';

  $('dual-stage').hidden = showPureText;
  $('text-view').hidden = !showPureText;
  $('copy-page').hidden = !showPureText;
  $('zoom').hidden = $('fit-width-btn').hidden = showPureText;
  $('sync-toggle-wrap').hidden = showPureText || singleLeft || singleRight;

  $('dual-stage').classList.toggle('single-left', singleLeft);
  $('dual-stage').classList.toggle('single-right', singleRight);
  $('left-pane').hidden = singleRight;
  $('right-pane').hidden = singleLeft;
  $('split-resizer').hidden = singleLeft || singleRight;

  $('translated-stream').hidden = showDoc2x;
  $('doc2x-stream').hidden = !showDoc2x;

  const isScan = done && job.ocr_pages?.includes(page);
  $('range-note').textContent = pagePending(job, page) ? (canResume(job) ? '本页待续译' : '本页待翻译')
    : job.failed_pages?.includes(page) ? '本页待重试'
    : job.preserved_pages?.includes(page) ? '保留原文' : isScan ? 'OCR 重排'
    : (job.page_range ? `范围 ${job.page_range}` : '');
  $('range-note').hidden = !done || !$('range-note').textContent;

  renderOutlineAndThumbs(job);
  if (peeking) {
    buildPageStreams(job);
    return;
  }
  renderLegacySinglePage(job);

  if (showPureText) {
    void renderTextPage(job, page);
    return;
  }
  textRequestKey = '';

  buildPageStreams(job);
  if (showDoc2x) {
    if (segmentsJobKey === textKey(job)) renderDoc2xStream(job);
    else void ensureFullSegments(job);
  }
}

async function renderTextPage(job, page) {
  const key = [textKey(job), page, pagePending(job, page) ? job.state : ''].join(':');
  if (textRequestKey === key) return;
  textRequestKey = key;
  const message = $('text-page-message');
  const list = $('text-pairs');
  const target = job.id + ':' + page;
  if (textView.target !== target) {
    closeCitation();
    closeSelectionInspector();
    textView = {target, signature:''};
    currentPairs = [];
    $('copy-page').disabled = true;
    list.replaceChildren();
    message.textContent = '正在读取本页段落…';
  }
  try {
    const [result] = await Promise.all([request(`${jobPath(job.id)}/text/${page}`), ensureFullSegments(job)]);
    if (textRequestKey !== key || viewMode !== 'text') return;
    currentPairs = result.pairs;
    message.textContent = pagePending(job, page) ? (canResume(job) ? '本页待续译。' : '本页待翻译。')
      : job.failed_pages?.includes(page) ? '本页翻译未完成，可在工具栏重试。'
      : job.preserved_pages?.includes(page) ? '本页已按忽略翻译设置保留，可切回双栏查看。'
      : !currentPairs.length ? '本页没有已翻译的段落，可切回双栏查看原文。'
      : result.mode === 'ocr' ? '原文由本机 OCR 识别。可切换到「PDF+解析」模式边看原图边在线编辑。'
      : '保留图表和公式的排版见「双栏」或「PDF+解析」模式。';
    const signature = JSON.stringify([currentPairs, result.kinds, [...documentReferences], [...referenceSegments]]);
    if (textView.signature === signature) return;
    textView.signature = signature;
    closeCitation();
    closeSelectionInspector();
    list.replaceChildren(...currentPairs.map(([original, translation], index) => {
      const row = document.createElement('div');
      row.className = 'text-row';
      const bar = document.createElement('div');
      bar.className = 'text-row-actions';
      const anchor = document.createElement('span');
      anchor.textContent = paragraphLocation(page, index);
      bar.append(anchor, paragraphActions(job, page, index, original, translation));
      const left = document.createElement('p');
      decorateContentWithCitationsAndLatex(left, original, page, index, false, result.kinds?.[index]);
      const right = document.createElement('p');
      decorateContentWithCitationsAndLatex(right, translation, page, index, true, result.kinds?.[index]);
      row.append(bar, left, right);
      return row;
    }));
    $('copy-page').disabled = !currentPairs.length;
  } catch (error) {
    if (textRequestKey === key && viewMode === 'text') message.textContent = error.message;
  }
}

function setMode(mode) {
  const job = currentJob();
  if (!job || viewMode === mode) return;
  closeCitation();
  closeSelectionInspector();
  viewMode = mode;
  if (selectedId) docMemory.set(selectedId, {page: currentPage, mode: viewMode});
  renderPages(job);
  requestAnimationFrame(() => {
    if (selectedId === job.id && viewMode === mode) scrollToPage(currentPage, false);
  });
}

async function copyPage() {
  if (!currentPairs.length) return;
  try {
    await navigator.clipboard.writeText(currentPairs.map(([, translation]) => translation).join('\n\n'));
    announce('已复制本页译文。');
  } catch {
    announce('无法访问剪贴板，可直接选中文字后复制。', true);
  }
}

// 全文搜索与高亮定位
let searchHits = [];
let searchIndex = -1;
let searchTotal = 0;
let searchRequest = 0;
let searchJump = 0;
let searchPdfKey = '';
const searchBoxCache = new Map();

const searchTerm = () => $('search-input').value.trim().replace(/\s+/g, ' ');
const pdfSearchKey = job => job ? `${job.id}:${resultVersion(job)}` : '';
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

function resetSearchResults() {
  searchRequest++;
  searchJump++;
  searchHits = [];
  searchIndex = -1;
  searchTotal = 0;
  searchPdfKey = '';
  $('search-results').replaceChildren();
  $('search-results').hidden = true;
  $('search-prev').disabled = true;
  $('search-next').disabled = true;
  $('search-count').textContent = searchTerm() ? '按 Enter 查找' : '';
  clearSearchHighlights();
}

async function performSearch() {
  const job = currentJob();
  const term = searchTerm();
  resetSearchResults();
  if (!job || !term || $('search-bar').hidden) return;
  const id = searchRequest;
  const key = pdfSearchKey(job);
  searchPdfKey = key;
  $('search-count').textContent = '搜索中…';
  try {
    const side = $('search-side').value;
    const res = await request(`${jobPath(job.id)}/search?${new URLSearchParams({q: term, side})}`);
    if (id !== searchRequest || pdfSearchKey(currentJob()) !== key) return;
    searchHits = res.hits || [];
    searchTotal = res.total || searchHits.length;
    if (!searchHits.length) {
      $('search-count').textContent = side === 'translated' && !hasResult(job) ? '译文尚未生成'
        : res.searchable ? '没有匹配' : '没有可搜索文字';
      return;
    }
    const items = searchHits.map((hit, i) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'search-hit';
      const label = document.createElement('strong');
      const sideLabel = hit.kind === 'original' ? '原文 PDF' : '译文 PDF';
      label.textContent = `${sideLabel} · 第 ${hit.page} 页`;
      const snippet = document.createElement('span');
      const mark = document.createElement('mark');
      mark.textContent = hit.snippet.match;
      snippet.append(hit.snippet.before, mark, hit.snippet.after);
      button.append(label, snippet);
      button.addEventListener('click', () => void focusSearchHit(i));
      return button;
    });
    $('search-results').replaceChildren(...items);
    $('search-results').hidden = false;
    $('search-prev').disabled = items.length < 2;
    $('search-next').disabled = items.length < 2;
    await focusSearchHit(0);
  } catch (error) {
    if (id === searchRequest) $('search-count').textContent = error.message;
  }
}

function navigateSearch(step) {
  if (searchHits.length) return focusSearchHit((searchIndex + step + searchHits.length) % searchHits.length);
}

async function locateParagraph(job, page, segment, stillCurrent, original = null) {
  if (!stillCurrent()) return false;
  setMode('doc2x');
  setPage(page, false);
  if (!await ensureFullSegments(job)) return false;
  await nextFrame();
  if (!stillCurrent() || viewMode !== 'doc2x') return false;
  scrollToPage(page, false);
  if (original !== null) {
    const pairs = fullSegments[String(page)]?.pairs || [];
    if (pairs[segment]?.[0] !== original) {
      const matches = pairs.flatMap(([text], index) => text === original ? [index] : []);
      if (matches.length !== 1) return false;
      segment = matches[0];
    }
  }
  const row = $('doc2x-stream').querySelector(`[data-page="${page}"] [data-segment="${segment}"]`);
  if (!row) return false;
  $('doc2x-stream').querySelectorAll('.search-row-active').forEach(item => item.classList.remove('search-row-active'));
  row.classList.add('search-row-active');
  row.scrollIntoView({block: 'center', inline: 'nearest'});
  return true;
}

async function focusSearchHit(index) {
  const hit = searchHits[index];
  const job = currentJob();
  if (!hit || !job || searchPdfKey !== pdfSearchKey(job)) return;
  const jump = ++searchJump;
  const stillCurrent = () => jump === searchJump && pdfSearchKey(currentJob()) === searchPdfKey;
  searchIndex = index;
  const suffix = searchTotal > searchHits.length ? ` · 共 ${searchTotal} 项` : '';
  $('search-count').textContent = `${index + 1} / ${searchHits.length}${suffix}`;
  for (const [i, button] of [...$('search-results').children].entries()) {
    button.setAttribute('aria-current', i === index ? 'true' : 'false');
  }
  $('search-results').children[index]?.scrollIntoView({block: 'nearest', inline: 'nearest'});
  clearSearchHighlights();
  const side = hit.kind;
  if (viewMode === 'text' || (side === 'original' && viewMode === 'mono-pdf')
      || (side === 'translated' && ['orig-pdf', 'doc2x'].includes(viewMode))) {
    setMode('dual-pdf');
  }
  setPage(hit.page, false);
  await nextFrame();
  if (!stillCurrent()) return;
  scrollToPage(hit.page, false);
  const box = await renderPageSearchBoxes(job, hit, searchTerm(), stillCurrent);
  if (box && stillCurrent() && currentPage === hit.page) {
    const pane = side === 'original' ? leftPane : rightPane;
    const top = box.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    pane.scrollTop += top - pane.clientHeight * .38;
  }
}

async function renderPageSearchBoxes(job, hit, term, stillCurrent) {
  const {kind: side, page, match_index: matchIndex} = hit;
  const container = $(side === 'original' ? 'original-stream' : 'translated-stream');
  const sheet = container.querySelector(`.sheet[data-page="${page}"]`);
  if (!sheet) return;
  const key = JSON.stringify([job.id, resultVersion(job), side, page, term]);
  let data = searchBoxCache.get(key);
  if (!data) {
    try {
      data = await request(`${jobPath(job.id)}/search/boxes?${new URLSearchParams({q: term, side, page})}`);
      if (searchBoxCache.size >= 60) searchBoxCache.delete(searchBoxCache.keys().next().value);
      searchBoxCache.set(key, data);
    } catch {
      return;
    }
  }
  if (!stillCurrent() || !sheet.isConnected || !data.boxes?.length) return;
  const layer = document.createElement('div');
  layer.className = 'search-box-layer';
  layer.setAttribute('aria-hidden', 'true');
  if (data.aspect > 0) {
    layer.style.bottom = 'auto';
    layer.style.aspectRatio = String(data.aspect);
  }
  for (const [i, [x, y, w, h]] of data.boxes.entries()) {
    const el = document.createElement('span');
    el.className = 'search-box';
    if (data.match_ids?.[i] === matchIndex) el.classList.add('current');
    el.style.left = `${x * 100}%`;
    el.style.top = `${y * 100}%`;
    el.style.width = `${w * 100}%`;
    el.style.height = `${h * 100}%`;
    layer.append(el);
  }
  sheet.append(layer);
  return layer.querySelector('.current') || layer.firstElementChild;
}

function clearSearchHighlights() {
  document.querySelectorAll('.search-box-layer').forEach(el => el.remove());
  document.querySelectorAll('.search-row-active').forEach(el => el.classList.remove('search-row-active'));
}

function toggleSearchBar(force) {
  const bar = $('search-bar');
  const show = force ?? bar.hidden;
  if (show) toggleAuditPanel(false);
  bar.hidden = !show;
  $('search-toggle-btn').setAttribute('aria-expanded', String(show));
  if (show) {
    $('search-input').focus();
    $('search-input').select();
    if (searchTerm()) void performSearch();
  } else {
    resetSearchResults();
  }
}

// 译文校对提示
let auditRequest = null;

function ensureAuditReport(job) {
  if (!hasResult(job) || !job.has_text) return;
  const key = textKey(job);
  if (auditRequest?.key === key) return;
  const loading = {key, failed: false};
  auditRequest = loading;
  $('audit-summary-bar').textContent = '正在检查译文段落…';
  $('audit-issue-list').replaceChildren();
  request(`${jobPath(job.id)}/audit`).then(report => {
    if (auditRequest !== loading || textKey(currentJob()) !== key) return;
    const count = report.total_issues;
    $('audit-toggle-btn').classList.toggle('clean', !count && report.checked_segments > 0);
    $('audit-badge-text').textContent = count ? `校对 (${count})` : '校对';
    renderAuditPanel(job, report);
  }).catch(error => {
    if (auditRequest !== loading || textKey(currentJob()) !== key) return;
    loading.failed = true;
    $('audit-summary-bar').textContent = `校对读取失败。${error.message}`;
  });
}

function renderAuditPanel(job, report) {
  const labels = {formula:'公式标记', citation:'引用', number:'数值', unit:'单位', truncation:'疑似漏译', missing:'疑似未译'};
  const tags = [document.createElement('span')];
  tags[0].textContent = `已检查 ${report.checked_segments} 段`;
  for (const [key, count] of Object.entries(report.summary || {})) {
    if (!count) continue;
    const tag = document.createElement('span');
    tag.className = 'audit-tag has-issue';
    tag.textContent = `${labels[key] || key} ${count}`;
    tags.push(tag);
  }
  $('audit-summary-bar').replaceChildren(...tags);

  const items = [];
  const key = textKey(job);
  for (const [page, issues] of Object.entries(report.details || {})) {
    for (const item of issues) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'audit-item';
      const head = document.createElement('strong');
      head.className = 'audit-item-head';
      head.textContent = `第 ${page} 页 · 段落 ${item.segment_index + 1}`;
      const message = document.createElement('span');
      message.className = 'audit-item-msg';
      message.textContent = item.issues.map(issue => issue.message).join(' ');
      const original = document.createElement('span');
      original.className = 'audit-item-snippet';
      original.textContent = `原文　${item.original_snippet}`;
      const translation = document.createElement('span');
      translation.className = 'audit-item-snippet';
      translation.textContent = `译文　${item.translated_snippet}`;
      button.append(head, message, original, translation);
      button.addEventListener('click', () => {
        toggleAuditPanel(false);
        clearSearchHighlights();
        void locateParagraph(job, Number(page), item.segment_index, () => textKey(currentJob()) === key);
      });
      items.push(button);
    }
  }
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'audit-empty';
    empty.textContent = report.checked_segments ? '这些段落暂无一致性提示。' : '没有可校对的译文段落。';
    items.push(empty);
  }
  $('audit-issue-list').replaceChildren(...items);
}

function toggleAuditPanel(force) {
  const panel = $('audit-panel');
  const show = force ?? panel.hidden;
  panel.hidden = !show;
  $('audit-toggle-btn').setAttribute('aria-expanded', String(show));
  if (show) {
    toggleSearchBar(false);
    if (auditRequest?.failed) auditRequest = null;
    ensureAuditReport(currentJob());
    $('audit-close').focus();
  }
}

/* 只重试失败页 */
async function retryFailedPages() {
  const job = currentJob();
  if (!job || running(job) || canResume(job) || job.stopping || pending.has(job.id)) return;
  const failed = job.failed_pages || [];
  if (!failed.length) {
    announce('当前文献没有未完成或失败的页面。');
    return;
  }
  for (const id of ['base-url', 'model']) if (!$(id).reportValidity()) return;
  pending.add(job.id);
  render();
  try {
    const payload = {...modelSettings(), ocr: $('ocr').checked && !$('ocr').disabled,
      concurrency: Number($('concurrency').value) || 4,
      ...(mobile ? {reuse_api_cache:$('reuse-api-cache').checked} : {})};
    const res = await request(`${jobPath(job.id)}/retry-failed`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    });
    upsert(res.job);
    announce(`已提交 ${failed.length} 个失败页。`);
    void pollJobs();
  } catch (err) {
    announce(err.message, true);
  } finally {
    pending.delete(job.id);
    render();
  }
}

function renderReader() {
  const job = currentJob();
  const sourceReview = $('source-review-btn');
  if (sourceReview) sourceReview.disabled = !job || job.demo || running(job) || job.stopping || pending.has(job.id);
  $('active-reader').hidden = !job;
  $('empty-reader').hidden = !!job;
  if (!job) {
    mobile?.showCredit(null, false);
    $('peek-toggle-fab').hidden = true;
    closeCitation();
    closeSelectionInspector();
    textRequestKey = '';
    currentPairs = [];
    renderingJob = null;
    toggleSearchBar(false);
    toggleAuditPanel(false);
    return;
  }
  if (renderingJob !== job.id) {
    closeCitation();
    closeSelectionInspector();
    documentReferences.clear();
    referenceSegments.clear();
    renderingJob = job.id;
    streamSignature = '';
    doc2xRenderKey = '';
    segmentsJobKey = '';
    $('doc2x-stream').replaceChildren();
    auditRequest = null;
    toggleSearchBar(false);
    toggleAuditPanel(false);
    const mem = docMemory.get(job.id);
    currentPage = mem?.page ? Math.min(job.pages, mem.page) : 1;
    viewMode = mem?.mode || 'dual-pdf';
    $('page-number').value = currentPage;
  }
  const done = hasResult(job);
  const active = running(job);
  const path = jobPath(job.id);
  const format = sourceFormat(job);
  const progress = Math.max(0, Math.min(1, Number(job.progress) || 0));

  $('document-title').textContent = job.name;
  $('document-title').title = job.name;
  $('mini-doc-title').textContent = documentTitle(job.name);
  const reflowed = ['docx', 'txt', 'md', 'markdown'].includes(format);
  $('document-description').textContent = [jobStatus(job), providerLabels[job.provider],
    reflowed ? '重排预览' : ''].filter(Boolean).join(' · ');
  $('document-description').title = reflowed ? '页码以阅读用 PDF 为准；可从导出菜单下载原文件。' : '';

  const usage = job.usage || {};
  const cacheBadge = $('cache-badge');
  if (mobile) {
    const labels = [];
    const details = [];
    if (usage.cache_prompt_tokens > 0) {
      labels.push('接口缓存 ' + usage.cache_hit_rate + '%');
      details.push('接口上报的缓存命中 ' + usage.cached_tokens + ' / ' + usage.cache_prompt_tokens + ' 输入 token');
    }
    if (usage.reused_fragments > 0) {
      labels.push('本机复用 ' + usage.reused_fragments + ' 段');
      details.push('本机直接复用了 ' + usage.reused_fragments + ' 个译文片段');
    }
    if (usage.requests > 0) {
      const requests = 'API 请求 ' + usage.requests + ' 次';
      if (!labels.length) labels.push(requests);
      details.push(requests);
    }
    if (usage.prompt_tokens > 0 || usage.completion_tokens > 0) {
      details.push('接口报告输入 ' + usage.prompt_tokens + '、输出 ' + usage.completion_tokens + ' token');
    }
    cacheBadge.textContent = labels.join(' · ');
    cacheBadge.title = details.join('。');
    cacheBadge.hidden = !labels.length;
  } else if (usage.prompt_tokens > 0) {
    cacheBadge.textContent = `⚡ 缓存命中 ${usage.cache_hit_rate}%`;
    cacheBadge.title = `前缀缓存命中 ${usage.cached_tokens} / ${usage.prompt_tokens} 输入 token（共 ${usage.requests} 次请求）`;
    cacheBadge.hidden = false;
  } else {
    cacheBadge.hidden = true;
  }

  const resume = canResume(job);
  const controlsDisabled = Boolean(job.stopping || pending.has(job.id));
  $('cancel-button').hidden = !active && !resume;
  $('cancel-button').disabled = controlsDisabled;
  $('pause-button').hidden = !mobile || !active;
  $('pause-button').disabled = controlsDisabled;
  $('resume-button').hidden = !resume;
  $('resume-button').disabled = controlsDisabled;
  if (resume) $('resume-button').textContent = '继续剩余 ' + job.remaining_pages.length + ' 页';
  $('delete-button').disabled = active || controlsDisabled;

  // 只重试失败页按钮
  const retryBtn = $('retry-failed-btn');
  const failedPages = job.failed_pages || [];
  retryBtn.disabled = pending.has(job.id);
  if (failedPages.length > 0 && !active && !resume && !job.stopping) {
    retryBtn.hidden = false;
    $('retry-failed-count').textContent = failedPages.length;
    retryBtn.title = `使用当前模型重试第 ${failedPages.join('、')} 页，沿用原任务的翻译语言和忽略选项`;
  } else {
    retryBtn.hidden = true;
  }

  // 译文校对提示按钮
  const canAudit = done && job.has_text;
  $('audit-toggle-btn').hidden = !canAudit;
  if (!canAudit) toggleAuditPanel(false);
  if (auditRequest?.key !== textKey(job)) {
    $('audit-toggle-btn').classList.remove('clean');
    $('audit-badge-text').textContent = '校对';
  }
  if (canAudit && !$('audit-panel').hidden) ensureAuditReport(job);
  if (!$('search-bar').hidden && searchPdfKey && searchPdfKey !== pdfSearchKey(job)) void performSearch();

  $('mono-download').hidden = !done;
  $('dual-download').hidden = !done;
  $('export-dropdown').hidden = false;
  for (const id of ['markdown-download', 'markdown-mono-download', 'html-download', 'word-download']) {
    $(id).hidden = !done;
  }
  $('mono-download').href = `${path}/download/translated`;
  $('dual-download').href = `${path}/download/bilingual`;
  $('markdown-download').href = `${path}/download/markdown`;
  $('markdown-mono-download').href = `${path}/download/markdown_mono`;
  $('html-download').href = `${path}/download/html`;
  $('word-download').href = `${path}/download/word`;
  $('original-link').href = `${path}/download/original`;
  $('original-link').textContent = format === 'pdf' ? '📎 下载原始 PDF' : '📄 下载阅读用 PDF';
  $('source-download').hidden = format === 'pdf';
  $('source-download').textContent = `📎 下载原文件 (.${format})`;
  $('source-download').href = `${path}/download/source`;

  $('task-progress').hidden = !active && !resume && !job.stopping;
  if (!$('task-progress').hidden) {
    const message = job.stopping ? '正在停止当前页…' : job.message || states[job.state];
    if ($('progress-message').textContent !== message) $('progress-message').textContent = message;
    $('progress-number').textContent = jobProgressLabel(job);
    const elapsed = $('progress-elapsed');
    const seconds = job.elapsed_seconds;
    elapsed.hidden = !Number.isFinite(seconds);
    if (!elapsed.hidden) elapsed.textContent = '已用 ' +
      (seconds >= 60 ? Math.floor(seconds / 60) + ' 分 ' : '') + seconds % 60 + ' 秒';
    $('progress-bar').value = progress;
  }
  const error = job.error || (job.state === 'failed' ? job.message : '');
  $('task-error').hidden = !error;
  if ($('task-error').textContent !== (error || '')) $('task-error').textContent = error || '';
  renderPages(job);
}

function render() {
  renderJobs();
  updateForm();
  renderReader();
}

function selectJob(id) {
  if (selectedId && byId.has(selectedId)) {
    docMemory.set(selectedId, {page: currentPage, mode: viewMode});
  }
  selectedId = byId.has(id) ? id : null;
  if (selectedId) openTabs.add(selectedId);
  render();
}

function scrollToPage(page, smooth = true) {
  if (viewMode === 'text') return;
  clearTimeout(scrollReleaseTimer);
  programmaticScroll = true;
  const behavior = smooth ? 'smooth' : 'auto';
  if (!leftPane.hidden) {
    const leftTarget = $('original-stream').querySelector(`.sheet[data-page="${page}"]`);
    if (leftTarget) leftPane.scrollTo({top: leftTarget.offsetTop - 8, behavior});
  }
  if (!rightPane.hidden) {
    const rightTarget = viewMode === 'doc2x'
      ? $('doc2x-stream').querySelector(`.doc2x-page-card[data-page="${page}"]`)
      : $('translated-stream').querySelector(`.sheet[data-page="${page}"]`);
    if (rightTarget) rightPane.scrollTo({top: rightTarget.offsetTop - 8, behavior});
  }
  scrollReleaseTimer = setTimeout(() => { programmaticScroll = false; }, smooth ? 420 : 80);
}

function setPage(value, shouldScroll = true) {
  const job = currentJob();
  if (!job) return;
  currentPage = Math.min(job.pages, Math.max(1, Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : currentPage));
  if (selectedId) docMemory.set(selectedId, {page: currentPage, mode: viewMode});
  updatePageIndicators(currentPage, job.pages);
  highlightActiveOutline(currentPage);
  if (viewMode === 'text') {
    $('viewer-scroll').scrollTo(0, 0);
    renderPages(job);
  } else if (shouldScroll) {
    scrollToPage(currentPage, true);
    renderLegacySinglePage(job);
  }
}

/* 连续滚动时的实时页码检测、双栏同步滚动与工具栏自动隐藏 */
function detectVisiblePage(paneEl, selector) {
  if (peekOriginalId) return;
  const top = paneEl.scrollTop;
  if ($('autohide-toolbar').checked && !document.body.classList.contains('zen-mode')) {
    if (top > lastScrollTop + 28 && top > 60) {
      setToolbarCollapsed(true);
    } else if (top < lastScrollTop - 22 || top < 20) {
      setToolbarCollapsed(false);
    }
  }
  lastScrollTop = top;

  const mid = top + paneEl.clientHeight * 0.38;
  const items = paneEl.querySelectorAll(selector);
  let bestPage = currentPage;
  for (const item of items) {
    if (item.offsetTop <= mid) {
      bestPage = Number(item.dataset.page) || bestPage;
    } else {
      break;
    }
  }
  if (bestPage !== currentPage) {
    currentPage = bestPage;
    const job = currentJob();
    if (job) updatePageIndicators(currentPage, job.pages);
    if (selectedId) docMemory.set(selectedId, {page: currentPage, mode: viewMode});
    highlightActiveOutline(currentPage);
  }
}

function syncPaperPosition(source, target) {
  const anchor = Math.min(96, source.clientHeight * .30);
  const position = source.getBoundingClientRect().top + anchor;
  let page;
  for (const sheet of source.querySelectorAll('.sheet[data-page]')) {
    if (!page || sheet.getBoundingClientRect().top <= position) page = sheet;
    else break;
  }
  const match = page && target.querySelector('.sheet[data-page="' + page.dataset.page + '"]');
  if (!match) return;
  const from = page.getBoundingClientRect();
  const to = match.getBoundingClientRect();
  const fraction = Math.max(0, Math.min(1, (position - from.top) / Math.max(1, from.height)));
  target.scrollTop += to.top + to.height * fraction - target.getBoundingClientRect().top - anchor;
}

function bindSyncScroll() {
  leftPane.addEventListener('scroll', () => {
    if (leftPane.hidden || viewMode === 'text') return;
    if (!programmaticScroll) detectVisiblePage(leftPane, '#original-stream .sheet');
    if (rightPane.hidden || syncingScroll || programmaticScroll || !$('sync-scroll').checked) return;
    syncingScroll = true;
    if (viewMode === 'dual-pdf') {
      const maxL = leftPane.scrollHeight - leftPane.clientHeight;
      const maxR = rightPane.scrollHeight - rightPane.clientHeight;
      if (mobile) syncPaperPosition(leftPane, rightPane);
      else if (maxL > 0 && maxR > 0) {
        rightPane.scrollTop = (leftPane.scrollTop / maxL) * maxR;
      }
      const maxW = leftPane.scrollWidth - leftPane.clientWidth;
      if (maxW > 0) {
        rightPane.scrollLeft = (leftPane.scrollLeft / maxW) * (rightPane.scrollWidth - rightPane.clientWidth);
      }
    } else if (viewMode === 'doc2x') {
      const card = $('doc2x-stream').querySelector(`.doc2x-page-card[data-page="${currentPage}"]`);
      if (card) rightPane.scrollTo({top: card.offsetTop - 8});
    }
    requestAnimationFrame(() => { syncingScroll = false; });
  }, {passive: true});

  rightPane.addEventListener('scroll', () => {
    if (rightPane.hidden || viewMode === 'text') return;
    if ((viewMode === 'dual-pdf' || viewMode === 'mono-pdf') && !programmaticScroll) {
      detectVisiblePage(rightPane, '#translated-stream .sheet');
    }
    if (syncingScroll || programmaticScroll || !$('sync-scroll').checked) return;
    if (viewMode !== 'dual-pdf') return;
    syncingScroll = true;
    const maxR = rightPane.scrollHeight - rightPane.clientHeight;
    const maxL = leftPane.scrollHeight - leftPane.clientHeight;
    if (mobile) syncPaperPosition(rightPane, leftPane);
    else if (maxR > 0 && maxL > 0) {
      leftPane.scrollTop = (rightPane.scrollTop / maxR) * maxL;
    }
    const maxW = rightPane.scrollWidth - rightPane.clientWidth;
    if (maxW > 0) {
      leftPane.scrollLeft = (rightPane.scrollLeft / maxW) * (leftPane.scrollWidth - leftPane.clientWidth);
    }
    requestAnimationFrame(() => { syncingScroll = false; });
  }, {passive: true});
}

function bindSplitResizer() {
  const resizer = $('split-resizer');
  const stage = $('dual-stage');
  let dragging = false;

  resizer.addEventListener('pointerdown', event => {
    dragging = true;
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add('dragging');
  });

  resizer.addEventListener('pointermove', event => {
    if (!dragging) return;
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = Math.min(75, Math.max(25, ((event.clientX - rect.left) / rect.width) * 100));
    stage.style.setProperty('--split-left', `${pct.toFixed(1)}%`);
  });

  const stopDrag = () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
  };
  resizer.addEventListener('pointerup', stopDrag);
  resizer.addEventListener('pointercancel', stopDrag);
  resizer.addEventListener('dblclick', () => {
    stage.style.setProperty('--split-left', '50%');
  });
}

function upsert(job, select = false) {
  if (!job?.id) return;
  mutationEpoch++;
  byId.set(job.id, job);
  if (select) {
    openTabs.add(job.id);
    selectJob(job.id);
  } else {
    render();
  }
}

async function pollJobs() {
  if (polling) return;
  polling = true;
  const epoch = mutationEpoch;
  try {
    const result = await request('/api/jobs');
    if (epoch !== mutationEpoch) return;
    const fresh = result.jobs || [];
    byId.clear();
    for (const job of fresh) byId.set(job.id, job);
    if (!byId.has(selectedId)) selectJob((fresh.find(canResume) || fresh[0])?.id);
    else render();
    if (lostConnection) announce('已重新连接本地服务。');
    lostConnection = false;
  } catch (error) {
    if (!lostConnection) announce(`本地任务读取失败：${error.message}`, true);
    lostConnection = true;
  } finally {
    polling = false;
    clearTimeout(progressTimer);
    progressTimer = setTimeout(pollJobs, [...byId.values()].some(job => running(job) || job.stopping) ? 1200 : 3200);
  }
}

async function uploadFiles(files = null) {
  if (uploading) { announce('正在添加文件，请稍候。'); return; }
  if (files === null && !mobile) { $('file-picker').click(); return; }
  if (files && !files.length) return;
  uploading = true;
  $('upload-button').disabled = true;
  $('hero-upload').disabled = true;
  const status = $('upload-status');
  status.hidden = false;
  const errors = [];
  let added = 0;
  if (files === null) {
    status.textContent = '正在选择并读取文献…';
    try {
      for (const item of await mobile.chooseFiles()) {
        if (item.job) { upsert(item.job, true); added++; }
        else errors.push(`${item.name}：${item.error}`);
      }
    } catch (error) { errors.push(error.message); }
  }
  for (let i = 0; i < (files?.length || 0); i++) {
    const file = files[i];
    status.textContent = `导入文献 ${i + 1} / ${files.length}，正在准备预览…`;
    if (!importFormats.has(extensionOf(file.name))) {
      errors.push(`${file.name}：暂不支持此格式。请选择 PDF、DOCX、TXT、Markdown 或图片（PNG、JPEG、WebP、TIFF）`);
      continue;
    }
    try {
      const result = await request('/api/upload', {
        method:'POST', body:file,
        headers:{'Content-Type':file.type || 'application/octet-stream', 'X-Filename':encodeURIComponent(file.name)}
      });
      upsert(result.job, true);
      added++;
    } catch (error) { errors.push(`${file.name}：${error.message}`); }
  }
  uploading = false;
  status.hidden = true;
  $('upload-button').disabled = false;
  $('hero-upload').disabled = false;
  $('file-picker').value = '';
  if (errors.length) announce([added ? `已导入 ${added} 份。` : '', ...errors].filter(Boolean).join('；'), true);
  else if (added) announce(`已导入 ${added} 份文献。`);
}

function translationOptions() {
  const settings = modelSettings();
  const offline = settings.provider === 'offline';
  return {
    ...settings,
    source_language: offline ? 'en' : $('source-language').value,
    target_language: offline ? 'zh' : $('target-language').value,
    concurrency: Number($('concurrency').value) || 4,
    ocr: $('ocr').checked && !$('ocr').disabled,
    ignore_content: ignoredContent(),
    auto_glossary: $('auto-glossary').checked && !$('auto-glossary').disabled,
    glossary: $('glossary').value,
    ...(mobile ? {reuse_api_cache:$('reuse-api-cache').checked} : {})
  };
}

$('source-review-btn')?.addEventListener('click', () => {
  toggleMoreMenu(false);
  void mobile.reviewSource(currentJob(), currentPage, translationOptions());
});

async function submitTranslation(event) {
  event.preventDefault();
  const job = currentJob();
  if (!job || running(job) || job.stopping || pending.has(job.id)) return;
  if (canResume(job)) { await controlTranslation('resume'); return; }
  const pageRange = $('page-range').value.trim().replace(/[–—]/g, '-').replace(/，/g, ',').replace(/\s+/g, '');
  if (pageRange && !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(pageRange)) { announce('请按 1-2,4 的格式填写翻译页码。', true); $('page-range').focus(); return; }
  const payload = {...translationOptions(), pages:pageRange};
  const offline = payload.provider === 'offline';
  if (payload.source_language === payload.target_language) {
    announce('请选择不同的原文和译文语言。', true);
    $('target-language').focus();
    return;
  }
  pending.add(job.id);
  toggleSettingsDrawer(false);
  updateForm();
  scheduleSaveSettings();
  try {
    const result = await request(`${jobPath(job.id)}/translate`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    upsert(result.job);
    announce(offline ? '已提交本机翻译。扫描页将先进行 OCR。' : '任务已提交，正在准备翻译。');
    void pollJobs();
  } catch (error) { announce(error.message, true); }
  finally { pending.delete(job.id); render(); }
}

async function controlTranslation(action) {
  const job = currentJob();
  if (!job || job.stopping || pending.has(job.id)) return;
  if (action === 'resume' ? !canResume(job) : !running(job) && !canResume(job)) return;
  const labels = {pause:'已暂停，进度已保存。', resume:'已继续翻译剩余页。', cancel:'已提交取消请求，已完成译文已保存。'};
  pending.add(job.id);
  toggleSettingsDrawer(false);
  render();
  try {
    const result = await request(jobPath(job.id) + '/' + action, {method:'POST'});
    upsert(result.job);
    announce(labels[action]);
    void pollJobs();
  } catch (error) { announce(error.message, true); }
  finally { pending.delete(job.id); render(); }
}

async function deleteJob() {
  const job = currentJob();
  if (!job || running(job) || job.stopping || pending.has(job.id) || !window.confirm(`移除「${job.name}」及工作台里的译文？原始文件不会被修改。`)) return;
  pending.add(job.id);
  render();
  try {
    await request(jobPath(job.id), {method:'DELETE'});
    mutationEpoch++;
    byId.delete(job.id);
    openTabs.delete(job.id);
    if (selectedId === job.id) selectJob([...openTabs][0] || byId.keys().next().value);
    announce('已移除本地任务。');
  } catch (error) { announce(error.message, true); }
  finally { pending.delete(job.id); render(); }
}

async function openDemo() {
  const buttons = [$('demo-button'), $('sample-link')];
  buttons.forEach(button => { button.disabled = true; });
  try {
    const result = await request('/api/demo', {method:'POST'});
    upsert(result.job, true);
    announce('已打开内置双语对照示例。');
  } catch (error) { announce(error.message, true); }
  finally { buttons.forEach(button => { button.disabled = false; }); }
}

/* 事件绑定 */
for (const id of ['upload-button','hero-upload']) $(id).addEventListener('click', () => void uploadFiles());
$('file-picker').addEventListener('change', event => void uploadFiles([...event.target.files]));
const dropzone = $('upload-button');
dropzone.addEventListener('dragover', event => { event.preventDefault(); dropzone.classList.add('dragging'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
dropzone.addEventListener('drop', event => { event.preventDefault(); dropzone.classList.remove('dragging'); void uploadFiles([...event.dataTransfer.files]); });
document.addEventListener('dragover', event => { if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault(); });
document.addEventListener('drop', event => { if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault(); });

$('sidebar-toggle').addEventListener('click', () => {
  $('workspace').classList.toggle('sidebar-collapsed');
});

for (const btn of document.querySelectorAll('.theme-btn')) {
  btn.addEventListener('click', () => applyTheme(btn.dataset.themeVal));
}

$('collapse-toolbar-btn').addEventListener('click', () => { toggleMoreMenu(false); setToolbarCollapsed(true); });
$('expand-toolbar-btn').addEventListener('click', () => setToolbarCollapsed(false));
$('focus-mode-btn').addEventListener('click', () => { toggleMoreMenu(false); toggleZenMode(); });
$('zen-exit').addEventListener('click', () => toggleZenMode(false));
$('zen-prev').addEventListener('click', () => setPage(currentPage - 1, true));
$('zen-next').addEventListener('click', () => setPage(currentPage + 1, true));
$('autohide-toolbar').addEventListener('change', event => {
  try { localStorage.setItem('paper_studio_autohide', event.target.checked ? '1' : '0'); } catch {}
  if (!event.target.checked) setToolbarCollapsed(false);
});

$('settings-toggle-btn')?.addEventListener('click', () => toggleSettingsDrawer());
$('model-summary-card')?.addEventListener('click', () => toggleSettingsDrawer());
$('settings-close-btn')?.addEventListener('click', () => toggleSettingsDrawer(false));
$('settings-done-btn')?.addEventListener('click', () => toggleSettingsDrawer(false));
$('settings-backdrop')?.addEventListener('click', () => toggleSettingsDrawer(false));

$('provider').addEventListener('change', switchProvider);
$('base-url').addEventListener('input', () => {
  const origin = apiOrigin($('base-url').value.trim());
  if (origin && configuredApiOrigin && origin !== configuredApiOrigin) $('api-key').value = '';
  if (origin) configuredApiOrigin = origin;
  clearModelList();
  resetCheck();
  updateModelSummaryCard();
  scheduleSaveSettings();
});
$('api-key').addEventListener('input', () => { clearModelList(); resetCheck(); scheduleSaveSettings(); });
for (const id of ['base-url', 'api-key']) $(id).addEventListener('change', () => void refreshModelList());
$('model').addEventListener('input', () => {
  const picker = $('model-picker');
  picker.value = [...picker.options].some(item => item.value === $('model').value.trim()) ? $('model').value.trim() : '';
  resetCheck();
  updateModelSummaryCard();
  scheduleSaveSettings();
});
$('model-picker').addEventListener('change', event => {
  if (event.target.value) {
    $('model').value = event.target.value;
    resetCheck();
    updateModelSummaryCard();
    scheduleSaveSettings();
  }
});
$('fetch-models').addEventListener('click', () => void refreshModelList());
for (const id of ['source-language', 'target-language', 'concurrency', 'ocr', 'auto-glossary', 'glossary', 'reuse-api-cache']) {
  $(id).addEventListener('change', () => {
    updateModelSummaryCard();
    scheduleSaveSettings();
  });
}

$('test-connection').addEventListener('click', testConnection);
for (const input of ignoreOptions) input.addEventListener('change', scheduleSaveSettings);
$('translate-form').addEventListener('submit', submitTranslation);
$('status-toggle').addEventListener('click', () => toggleConnections());
$('refresh-status').addEventListener('click', refreshConnections);
$('demo-button').addEventListener('click', openDemo);
$('sample-link').addEventListener('click', openDemo);

$('page-mode').addEventListener('click', () => setMode('dual-pdf'));
$('doc2x-mode').addEventListener('click', () => setMode('doc2x'));
$('text-mode').addEventListener('click', () => setMode('text'));
$('mono-view-mode').addEventListener('click', () => setMode('mono-pdf'));
$('orig-view-mode').addEventListener('click', () => setMode('orig-pdf'));

$('outline-toggle').addEventListener('click', () => {
  const drawer = $('outline-drawer');
  drawer.hidden = !drawer.hidden;
  $('outline-toggle').setAttribute('aria-pressed', String(!drawer.hidden));
});
$('tab-toc').addEventListener('click', () => {
  $('tab-toc').classList.add('active');
  $('tab-thumbs').classList.remove('active');
  $('toc-list').hidden = false;
  $('thumb-list').hidden = true;
});
$('tab-thumbs').addEventListener('click', () => {
  $('tab-thumbs').classList.add('active');
  $('tab-toc').classList.remove('active');
  $('thumb-list').hidden = false;
  $('toc-list').hidden = true;
});

$('export-menu-btn').addEventListener('click', event => {
  event.stopPropagation();
  toggleMoreMenu(false);
  $('export-menu').hidden = !$('export-menu').hidden;
});
$('more-menu-btn')?.addEventListener('click', event => {
  event.stopPropagation();
  toggleMoreMenu();
});

$('copy-page').addEventListener('click', copyPage);
for (const action of ['pause', 'resume', 'cancel']) {
  $(action + '-button').addEventListener('click', () => void controlTranslation(action));
}
$('delete-button').addEventListener('click', () => { toggleMoreMenu(false); void deleteJob(); });
$('previous-page').addEventListener('click', () => setPage(currentPage - 1, true));
$('next-page').addEventListener('click', () => setPage(currentPage + 1, true));
$('page-number').addEventListener('change', event => setPage(event.target.value, true));
$('page-number').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); setPage(event.target.value, true); } });
$('zoom').addEventListener('change', () => {
  renderPages(currentJob());
  if (searchIndex >= 0 && !$('search-bar').hidden) void focusSearchHit(searchIndex);
});

$('search-toggle-btn').addEventListener('click', () => toggleSearchBar());
$('search-close').addEventListener('click', () => toggleSearchBar(false));
$('search-prev').addEventListener('click', () => void navigateSearch(-1));
$('search-next').addEventListener('click', () => void navigateSearch(1));
$('search-side').addEventListener('change', () => void performSearch());
$('search-input').addEventListener('input', resetSearchResults);
$('search-input').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  if (searchHits.length) void navigateSearch(event.shiftKey ? -1 : 1);
  else void performSearch();
});

$('audit-toggle-btn').addEventListener('click', () => toggleAuditPanel());
$('audit-close').addEventListener('click', () => toggleAuditPanel(false));
$('retry-failed-btn').addEventListener('click', () => void retryFailedPages());
$('paragraph-retranslate').addEventListener('click', () => void retranslateParagraph());
$('paragraph-draft-save').addEventListener('click', () => void saveReviewedParagraph(false));
$('paragraph-publish').addEventListener('click', () => void saveReviewedParagraph(true));
$('paragraph-close').addEventListener('click', () => $('paragraph-dialog').close());
$('paragraph-dialog').addEventListener('cancel', event => {
  if (paragraphSession?.busy === 'saving') event.preventDefault();
});
$('paragraph-dialog').addEventListener('close', () => { paragraphSession = null; });
$('notes-toggle-btn').addEventListener('click', () => { toggleMoreMenu(false); if (currentJob()) openNotes(currentJob()); });
$('notes-close').addEventListener('click', () => $('notes-dialog').close());
$('notes-dialog').addEventListener('close', () => { notesSession = null; });
$('note-form').addEventListener('submit', event => void saveNote(event));
$('note-back').addEventListener('click', () => { if (notesSession) void showNoteList(notesSession); });

document.addEventListener('click', event => {
  if (!$('connection-panel').hidden && !event.target.closest('.top-actions')) toggleConnections(false);
  if (!$('export-menu').hidden && !event.target.closest('.export-dropdown')) $('export-menu').hidden = true;
  if ($('more-menu') && !$('more-menu').hidden && !event.target.closest('.more-dropdown')) toggleMoreMenu(false);
  if (!$('audit-panel').hidden && !event.target.closest('#audit-panel') && !event.target.closest('#audit-toggle-btn')) {
    toggleAuditPanel(false);
  }
});

document.addEventListener('keydown', event => {
  if ($('paragraph-dialog').open || $('notes-dialog').open || $('glossary-dialog').open) return;
  // 全局 Ctrl+F / Cmd+F 快捷全文检索
  if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
    if (currentJob()) {
      event.preventDefault();
      toggleSearchBar(true);
      return;
    }
  }

  const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (event.key === 'Escape') {
    if ($('settings-drawer') && !$('settings-drawer').hidden) { toggleSettingsDrawer(false); return; }
    if ($('more-menu') && !$('more-menu').hidden) { toggleMoreMenu(false); return; }
    if (!$('search-bar').hidden) { toggleSearchBar(false); return; }
    if (!$('audit-panel').hidden) { toggleAuditPanel(false); return; }
    if (document.body.classList.contains('zen-mode')) { toggleZenMode(false); return; }
    if (!$('connection-panel').hidden) { toggleConnections(false); $('status-toggle').focus(); return; }
    if (!$('export-menu').hidden) { $('export-menu').hidden = true; return; }
  }
  if (inInput || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'f' || event.key === 'F') {
    if (currentJob()) { event.preventDefault(); toggleZenMode(); }
  } else if (event.key === 't' || event.key === 'T') {
    if (currentJob()) {
      event.preventDefault();
      setToolbarCollapsed(!$('active-reader').classList.contains('toolbar-collapsed'));
    }
  } else if (event.key === '[') {
    event.preventDefault();
    $('workspace').classList.toggle('sidebar-collapsed');
  } else if (event.key === 'ArrowLeft') {
    if (currentJob() && currentPage > 1) { event.preventDefault(); setPage(currentPage - 1, true); }
  } else if (event.key === 'ArrowRight') {
    if (currentJob() && currentPage < currentJob().pages) { event.preventDefault(); setPage(currentPage + 1, true); }
  }
});

bindSyncScroll();
bindSplitResizer();
setupSelectionInspector();
setupFitWidthLock();
setupPeekToggleFab();
connectionRows();
updateForm();
void loadSavedSettings().then(() => refreshConnections());
void pollJobs();
