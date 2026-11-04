import './home.css';

interface Project {
  id: string;
  name: string;
  root: string;
  createdAt?: string | number;
  updatedAt?: string | number;
  lastOpenedAt?: string | number | null;
  archived: boolean;
  available?: boolean;
  main?: string | null;
  texFiles?: number;
}
interface ApiResult {projects?: Project[]; project?: Project; projectsRoot?: string; error?: string; id?: string; url?: string}
type Tab = 'all' | 'recent' | 'archived';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const paths = {
  folder: '<path d="M3 7V5.5A1.5 1.5 0 0 1 4.5 4H9l2 3h8.5A1.5 1.5 0 0 1 21 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z"/>',
  grid: '<rect x="3.5" y="3.5" width="6" height="6" rx="1"/><rect x="14.5" y="3.5" width="6" height="6" rx="1"/><rect x="3.5" y="14.5" width="6" height="6" rx="1"/><rect x="14.5" y="14.5" width="6" height="6" rx="1"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
  archive: '<path d="M4 8h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z"/><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M9 12h6"/>',
  restore: '<path d="M4 8h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z"/><rect x="3" y="4" width="18" height="4" rx="1"/><path d="m9 14 3-3 3 3m-3-3v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  import: '<path d="M8 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3M12 3h9v9M21 3l-11 11"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 2-2.5 4M12 17h.01"/>',
  refresh: '<path d="M20 8a8 8 0 1 0 .2 7M20 3v5h-5"/>',
  list: '<path d="M9 5h12M9 12h12M9 19h12M3 5h.01M3 12h.01M3 19h.01"/>',
  file: '<path d="M14 3H6a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 6 21h12a1.5 1.5 0 0 0 1.5-1.5V8.5Z"/><path d="M14 3v6h5M8 13h8M8 17h5"/>',
  paper: '<path d="M14 2.5H6A1.5 1.5 0 0 0 4.5 4v16A1.5 1.5 0 0 0 6 21.5h12a1.5 1.5 0 0 0 1.5-1.5V8Z"/><path d="M14 2.5V8h5.5M8.5 12h7M8.5 15.5h7M8.5 19h4"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  pencil: '<path d="m15 4 5 5M4 20l1-6L16 3a1.5 1.5 0 0 1 2 0l3 3a1.5 1.5 0 0 1 0 2L10 19Z"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="1.5"/><path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h4"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  alert: '<path d="m10.3 4.5-8 14A1.5 1.5 0 0 0 3.6 21h16.8a1.5 1.5 0 0 0 1.3-2.5l-8-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v5M12 17h.01"/>',
  spinner: '<path d="M21 12a9 9 0 1 1-9-9"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>'
};
function icon(name: keyof typeof paths, extra = '') {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" class="' + extra + '">' + paths[name] + '</svg>';
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);element.className = className;if (text !== undefined) element.textContent = text;return element;
}
let token = '', projects: Project[] = [], tab: Tab = 'all', loading = true, opening: string | null = null, modalBusy = false;
let loadTicket = 0, fetching = false;
let picked: Project | null = null, lastLoaded = 0, managedRoot = '', toastTimer: ReturnType<typeof setTimeout> | undefined;
let view: 'grid' | 'list' = 'grid';
try { if (localStorage.getItem('sidex.home.view') === 'list') view = 'list'; } catch {}
const root = document.getElementById('home-app')!;
root.innerHTML = [
  '<aside class="sidebar"><a class="home-brand" href="/home" aria-label="SideX LaTeX Studio 首页"><span class="brand-glyph">S</span><span><span class="brand-name">SideX</span><span class="brand-subtitle">LATEX STUDIO</span></span></a>',
  '<div class="workspace-switch"><span class="workspace-avatar" aria-hidden="true">T</span><div><div class="workspace-label">我的工作区</div><div class="workspace-hint">LOCAL WORKSPACE</div></div></div><p class="nav-label">LIBRARY</p>',
  '<nav class="home-nav" aria-label="项目分类"><button class="nav-button active" data-tab="all" aria-current="page">' + icon('grid') + '<span>全部项目</span><span class="nav-count" id="count-all">0</span></button>',
  '<button class="nav-button" data-tab="recent">' + icon('clock') + '<span>最近打开</span><span class="nav-count" id="count-recent">0</span></button>',
  '<button class="nav-button" data-tab="archived">' + icon('archive') + '<span>归档</span><span class="nav-count" id="count-archived">0</span></button></nav>',
  '<hr class="sidebar-separator"><button class="sidebar-help" id="help-button">' + icon('help') + '工作区指南</button><div class="sidebar-bottom"><div class="local-status"><span class="status-dot" id="service-dot"></span><span id="service-label">正在连接本地服务</span></div><p>项目目录保留在本机<br>专注写作，从一个项目开始。</p></div></aside>',
  '<main class="home-main"><div class="home-topbar"><div class="topbar-location">' + icon('folder') + '<span>工作区</span>' + icon('chevron') + '<strong id="topbar-current">全部项目</strong></div><div class="topbar-right"><span class="local-badge">LOCAL</span><button class="round-button" id="top-help" title="工作区指南" aria-label="工作区指南">' + icon('help') + '</button></div></div>',
  '<div class="content-wrap"><p class="workspace-eyebrow">YOUR RESEARCH, IN ONE PLACE</p><header class="page-heading"><div><h1 id="page-title">项目</h1><p class="page-description" id="page-description">开始一篇新文稿，或回到你的研究。</p></div><div class="heading-actions"><button class="button" id="import-project">' + icon('import') + '导入本地项目</button><button class="button primary" id="new-project">' + icon('plus') + '新建项目</button></div></header>',
  '<section class="project-toolbar" aria-label="筛选项目"><label class="project-search">' + icon('search') + '<input id="project-search" type="search" placeholder="搜索项目名称或目录…" aria-label="搜索项目名称或目录"><span class="search-shortcut">Ctrl K</span></label><span class="toolbar-spacer"></span>',
  '<label class="sort-control">排序<select id="project-sort" aria-label="项目排序"><option value="recent">最近打开</option><option value="created">创建时间</option><option value="name">项目名称</option></select></label><div class="view-toggle" role="group" aria-label="项目显示方式"><button id="grid-view" class="active" aria-label="网格视图" aria-pressed="true" title="网格视图">' + icon('grid') + '</button><button id="list-view" aria-label="列表视图" aria-pressed="false" title="列表视图">' + icon('list') + '</button></div><button class="icon-button" id="refresh-projects" title="刷新项目" aria-label="刷新项目">' + icon('refresh') + '</button></section>',
  '<div class="error-banner hidden" id="page-error" role="alert">' + icon('alert') + '<p id="page-error-text"></p><button id="retry-projects">重试</button><button id="dismiss-error" aria-label="关闭提示">' + icon('close') + '</button></div>',
  '<div class="result-row"><span class="result-label"><span class="count-dot"></span><span id="result-count" aria-live="polite">正在读取项目…</span></span><small id="view-hint">本地项目库</small></div><section id="projects" class="project-grid" aria-label="LaTeX 项目" aria-busy="true"></section>',
  '<footer class="home-bottomline"><span>' + icon('shield') + '新建项目由本地服务管理，导入项目保留原目录。</span><span class="keyboard-hint">N 新建项目 · Ctrl K 搜索</span></footer></div></main>',
  '<dialog id="create-dialog" aria-labelledby="create-title"><form id="create-form"><div class="dialog-header"><h2 id="create-title">新建项目</h2><button type="button" class="icon-button" data-close aria-label="关闭">' + icon('close') + '</button></div><div class="dialog-body"><label class="field-label" for="create-name">项目名称</label><input id="create-name" name="name" type="text" required maxlength="100" placeholder="例如：My research paper" autocomplete="off" autofocus><p class="template-label">从哪里开始</p><div class="template-options"><label class="template-option"><input type="radio" name="template" value="article" checked><span class="template-box"><strong>' + icon('file') + '论文文稿<span class="template-check"></span></strong><small>标题、摘要与章节<br>开箱即可编译</small></span></label><label class="template-option"><input type="radio" name="template" value="blank"><span class="template-box"><strong>' + icon('paper') + '空白文档<span class="template-check"></span></strong><small>最小 LaTeX 结构<br>自由构建你的文稿</small></span></label></div><p class="field-hint" id="create-location">项目文件保存在本地项目库。</p><p class="field-error" id="create-error" role="alert"></p></div><div class="dialog-footer"><button type="button" class="button" data-close>取消</button><button type="submit" class="button primary" data-submit>创建并打开' + icon('arrow') + '</button></div></form></dialog>',
  '<dialog id="import-dialog" aria-labelledby="import-title"><form id="import-form"><div class="dialog-header"><h2 id="import-title">导入本地项目</h2><button type="button" class="icon-button" data-close aria-label="关闭">' + icon('close') + '</button></div><div class="dialog-body"><p class="dialog-description">连接已有的 LaTeX 项目目录，直接使用其中的文件。</p><label class="field-label" for="import-path">项目文件夹的完整路径</label><input id="import-path" class="path-input" name="path" type="text" required placeholder="C:\\papers\\my-project" autocomplete="off" spellcheck="false" autofocus><p class="field-hint">请选择包含主文档的目录。导入只添加到项目库，不移动或复制原文件。</p><label class="field-label" for="import-name" style="margin-top:21px">显示名称 <span class="muted">（可选）</span></label><input id="import-name" name="name" type="text" maxlength="100" placeholder="默认使用文件夹名称" autocomplete="off"><p class="field-error" id="import-error" role="alert"></p></div><div class="dialog-footer"><button type="button" class="button" data-close>取消</button><button type="submit" class="button primary" data-submit>导入并打开' + icon('arrow') + '</button></div></form></dialog>',
  '<dialog id="rename-dialog" aria-labelledby="rename-title"><form id="rename-form"><div class="dialog-header"><h2 id="rename-title">重命名项目</h2><button type="button" class="icon-button" data-close aria-label="关闭">' + icon('close') + '</button></div><div class="dialog-body"><label class="field-label" for="rename-name">显示名称</label><input id="rename-name" name="name" type="text" required maxlength="100" autocomplete="off" autofocus><p class="field-hint">只更改项目库中的名称，目录和文件名保持原样。</p><p class="field-error" id="rename-error" role="alert"></p></div><div class="dialog-footer"><button type="button" class="button" data-close>取消</button><button type="submit" class="button primary" data-submit>保存名称</button></div></form></dialog>',
  '<dialog id="archive-dialog" aria-labelledby="archive-title"><form id="archive-form"><div class="dialog-header"><h2 id="archive-title">归档项目</h2><button type="button" class="icon-button" data-close aria-label="关闭">' + icon('close') + '</button></div><div class="dialog-body"><p class="dialog-description">将 <strong id="archive-name"></strong> 移入归档？</p><p class="field-hint">原目录和项目文件不会删除。你可以随时在「归档」中恢复。</p><p class="field-error" id="archive-error" role="alert"></p></div><div class="dialog-footer"><button type="button" class="button" data-close>取消</button><button type="submit" class="button danger-soft" data-submit>' + icon('archive') + '移入归档</button></div></form></dialog>',
  '<dialog id="help-dialog" aria-labelledby="help-title"><div class="dialog-header"><h2 id="help-title">你的本地写作工作区</h2><button type="button" class="icon-button" data-close aria-label="关闭">' + icon('close') + '</button></div><div class="dialog-body"><ol class="help-list"><li><span class="help-number">1</span><div><h3>新建或导入项目</h3><p>从简单文稿开始，也可以连接已有的 LaTeX 文件夹。</p></div></li><li><span class="help-number">2</span><div><h3>进入编辑器</h3><p>源码与排版结果并排显示，编译、终端和智能体都在同一个工作区。</p></div></li><li><span class="help-number">3</span><div><h3>整理你的研究</h3><p>搜索、重命名与归档项目。归档仅整理列表，不删除磁盘文件。</p></div></li></ol><p class="managed-directory"><span>新建项目保存位置</span><code id="managed-root">由本地服务管理</code></p></div><div class="dialog-footer"><button type="button" class="button primary" data-close>开始写作</button></div></dialog>',
  '<div class="toast" id="toast" role="status" aria-live="polite"></div>'
].join('');

function message(error: unknown) { return error instanceof Error ? error.message : '操作未完成，请重试。'; }
function notify(text: string) {
  clearTimeout(toastTimer);$('toast').textContent = text;$('toast').classList.add('visible');
  toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 4200);
}
function showError(text: string) { $('page-error-text').textContent = text;$('page-error').classList.remove('hidden'); }
function service(online: boolean) {
  $('service-dot').classList.toggle('offline', !online);
  $('service-label').textContent = online ? '本地服务已连接' : '本地服务未连接';
}
async function connectSession() {
  let response: Response;
  try { response = await fetch('/__latex/session', {cache: 'no-store'}); }
  catch { throw Error('无法连接本地服务，请从一键启动脚本打开工作区。'); }
  if (!response.ok) throw Error('无法连接本地服务，请从一键启动脚本打开工作区。');
  const value = await response.json() as {token?: string};
  if (!value.token) throw Error('本地服务未返回有效会话，请重新启动工作区。');
  token = value.token;
}
async function api(action: string, data: Record<string, unknown> = {}, retry = true): Promise<ApiResult> {
  if (!token) await connectSession();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('/__latex/projects', {
      method: 'POST', headers: {'Content-Type': 'application/json', 'X-LaTeX-Token': token},
      body: JSON.stringify({action, ...data}), signal: controller.signal
    });
    if (response.status === 403 && retry) { await connectSession();return api(action, data, false); }
    let value: ApiResult;
    try { value = await response.json() as ApiResult; }
    catch { throw Error('本地服务响应异常，请重新启动工作区后再试。'); }
    if (!response.ok || value.error) throw Error(value.error || '本地服务暂时无法完成操作。');
    service(true);return value;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw Error('本地服务响应超时，请稍后刷新项目列表。');
    if (error instanceof TypeError) throw Error('无法连接本地服务，请重新运行一键启动脚本。');
    throw error;
  } finally { clearTimeout(timer); }
}
function setBusyState() {
  for (const id of ['new-project', 'import-project', 'refresh-projects']) $<HTMLButtonElement>(id).disabled = loading || opening !== null;
}
function timestamp(value?: string | number | null) {
  if (value === undefined || value === null) return 0;
  const number = new Date(value).getTime();return Number.isFinite(number) ? number : 0;
}
function relativeDate(value?: string | number | null) {
  const time = timestamp(value);if (!time) return '尚未打开';
  const days = Math.floor((Date.now() - time) / 86400000);
  if (days <= 0) return '今天';if (days === 1) return '昨天';if (days < 7) return days + ' 天前';
  return new Date(time).toLocaleDateString('zh-CN', {month: 'short', day: 'numeric', year: new Date(time).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined});
}
function closeMenus() { document.querySelectorAll<HTMLDetailsElement>('.project-menu[open]').forEach(menu => { menu.open = false; }); }
function selectedProjects() {
  const query = $<HTMLInputElement>('project-search').value.trim().toLocaleLowerCase();
  const sort = tab === 'recent' ? 'recent' : $<HTMLSelectElement>('project-sort').value;
  return projects.filter(project => tab === 'archived' ? project.archived : !project.archived)
    .filter(project => tab !== 'recent' || timestamp(project.lastOpenedAt) > 0)
    .filter(project => !query || (project.name + ' ' + project.root).toLocaleLowerCase().includes(query))
    .sort((a,b) => sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN', {numeric: true}) : (sort === 'created' ? timestamp(b.createdAt) - timestamp(a.createdAt) : timestamp(b.lastOpenedAt) - timestamp(a.lastOpenedAt) || timestamp(b.createdAt) - timestamp(a.createdAt)));
}
function menuAction(label: string, glyph: keyof typeof paths, action: () => void, className = '') {
  const button = node('button', className);button.type = 'button';button.innerHTML = icon(glyph);button.append(node('span', '', label));
  button.onclick = event => { event.stopPropagation();closeMenus();action(); };return button;
}
function projectCard(project: Project) {
  const card = node('article', 'project-card' + (project.available === false ? ' unavailable' : '') + (opening === project.id ? ' opening' : ''));
  card.setAttribute('role', 'listitem');
  const top = node('div', 'card-top'), preview = node('div', 'document-icon');preview.innerHTML = '<span class="tex-letter" aria-hidden="true">T<span style="font-size:13px;vertical-align:-3px">E</span>X</span>';
  const menu = node('details', 'project-menu'), summary = node('summary');summary.innerHTML = icon('more');summary.setAttribute('aria-label', project.name + ' 的项目操作');
  menu.addEventListener('toggle', () => { if (menu.open) document.querySelectorAll<HTMLDetailsElement>('.project-menu[open]').forEach(other => { if (other !== menu) other.open = false; }); });
  const popup = node('div', 'menu-popover');popup.setAttribute('aria-label', '项目操作');
  popup.append(menuAction('重命名', 'pencil', () => rename(project)), menuAction('复制项目目录', 'copy', () => { void copyPath(project); }));
  popup.append(node('div', 'menu-separator'));
  popup.append(project.archived ? menuAction('恢复项目', 'restore', () => { void restore(project); }) : menuAction('移入归档', 'archive', () => archive(project), 'archive-action'));
  menu.append(summary,popup);top.append(preview,menu);
  const heading = node('h2'), title = node('button', 'project-title', opening === project.id ? '正在打开…' : project.name);
  title.type = 'button';title.disabled = opening !== null || project.available === false;title.title = project.name;
  title.setAttribute('aria-label', '打开项目 ' + project.name);title.onclick = () => { void openProject(project); };heading.append(title);
  const path = node('p', 'project-path', project.root);path.title = project.root;
  const footer = node('div', 'card-footer'), meta = node('span', project.available === false ? 'unavailable-label' : 'file-meta');
  if (project.available === false) { meta.innerHTML = icon('alert');meta.append('目录不可用'); }
  else { meta.innerHTML = icon('file');meta.append(project.main || (typeof project.texFiles === 'number' ? project.texFiles + ' 个 TeX 文件' : 'LaTeX 项目')); }
  const date = node('span', 'project-date', relativeDate(project.lastOpenedAt));date.title = timestamp(project.lastOpenedAt) ? '最近打开：' + new Date(timestamp(project.lastOpenedAt)).toLocaleString('zh-CN') : '尚未打开';
  footer.append(meta,date);card.append(top,heading,path,footer);
  card.onclick = event => {
    if ((event.target as HTMLElement).closest('button,details,.project-path') || window.getSelection()?.toString()) return;
    void openProject(project);
  };
  return card;
}
function renderEmpty(query: boolean) {
  const empty = node('div', 'empty-state'), art = node('div', 'empty-art');art.innerHTML = icon(query ? 'search' : tab === 'archived' ? 'archive' : 'paper');
  const title = query ? '没有找到匹配的项目' : tab === 'archived' ? '归档是留给告一段落的研究' : tab === 'recent' ? '从打开一个项目开始' : '把下一篇论文，放在这里';
  const description = query ? '试试其他关键词，或按项目文件夹路径查找。' : tab === 'archived' ? '归档后的项目会显示在这里，随时可以恢复。' : tab === 'recent' ? '你最近打开的项目会显示在这里，方便继续写作。' : '创建一份文稿，或者导入已有的 LaTeX 项目。文件保留在本地，写作在同一个工作区继续。';
  empty.append(art,node('h2','',title),node('p','',description));
  const actions = node('div', 'empty-actions');
  if (query) {
    const clear = node('button', 'button small', '清除搜索');clear.onclick = () => { $<HTMLInputElement>('project-search').value = '';render();$<HTMLInputElement>('project-search').focus(); };actions.append(clear);
  } else if (tab === 'all') {
    const create = node('button', 'button primary small');create.innerHTML = icon('plus') + '新建项目';create.onclick = newProject;
    const imported = node('button', 'button small', '导入本地项目');imported.onclick = importProject;actions.append(create,imported);
  } else if (tab === 'recent') {
    const all = node('button', 'button small', '查看全部项目');all.onclick = () => setTab('all');actions.append(all);
  }
  if (actions.childNodes.length) empty.append(actions);
  return empty;
}
function render() {
  setBusyState();const grid = $('projects');grid.classList.toggle('list-view', view === 'list');grid.setAttribute('role', 'list');grid.setAttribute('aria-busy', String(loading));
  const all = projects.filter(project => !project.archived), archived = projects.filter(project => project.archived);
  $('count-all').textContent = String(all.length);$('count-archived').textContent = String(archived.length);$('count-recent').textContent = String(all.filter(project => timestamp(project.lastOpenedAt) > 0).length);
  for (const current of ['grid','list']) { const button = $<HTMLButtonElement>(current + '-view');button.classList.toggle('active',view === current);button.setAttribute('aria-pressed',String(view === current)); }
  grid.replaceChildren();
  if (loading) { const status = node('div','loading-state');status.innerHTML = icon('spinner','spin');status.append('正在读取本地项目…');grid.append(status);$('result-count').textContent = '正在读取项目…';return; }
  const visible = selectedProjects(), query = $<HTMLInputElement>('project-search').value.trim();
  $('result-count').textContent = (query ? '找到 ' : '共 ') + visible.length + ' 个项目';
  $('view-hint').textContent = tab === 'archived' ? '归档不会删除项目文件' : '本地项目库';
  if (!visible.length) { const empty = renderEmpty(Boolean(query));empty.style.gridColumn = '1 / -1';grid.append(empty); }
  else { const fragment = document.createDocumentFragment();for (const project of visible) fragment.append(projectCard(project));grid.append(fragment); }
}
async function loadProjects(initial = false) {
  if (opening || modalBusy || fetching) return;
  fetching = true;const ticket = ++loadTicket;
  if (initial) { loading = true;render(); }
  $('page-error').classList.add('hidden');
  try {
    const result = await api('list');
    if (!Array.isArray(result.projects)) throw Error('项目列表格式不正确，请更新或重新启动本地服务。');
    if (ticket !== loadTicket) return;
    projects = result.projects;managedRoot = result.projectsRoot || '';
    $('managed-root').textContent = managedRoot || '由本地服务管理';
    $('create-location').textContent = managedRoot ? '保存位置：' + managedRoot : '项目文件保存在本地项目库。';
    lastLoaded = Date.now();
  } catch (error) { if (ticket === loadTicket) { service(false);showError(message(error)); } }
  finally { fetching = false;if (ticket === loadTicket) { loading = false;render(); } }
}
function setTab(next: Tab) {
  if (opening) return;tab = next;
  const labels = {all:'全部项目',recent:'最近打开',archived:'归档'};
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    const active = button.dataset.tab === next;button.classList.toggle('active',active);
    if (active) button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
  }
  $('topbar-current').textContent = labels[next];$('page-title').textContent = next === 'all' ? '项目' : labels[next];
  $('page-description').textContent = next === 'archived' ? '告一段落的文稿，也值得好好保留。' : next === 'recent' ? '回到上次停下的地方，继续你的研究。' : '开始一篇新文稿，或回到你的研究。';
  $<HTMLSelectElement>('project-sort').disabled = next === 'recent';closeMenus();render();
}
function showDialog(id: string) {
  if (opening || modalBusy) return;closeMenus();
  const dialog = $<HTMLDialogElement>(id);dialog.querySelectorAll<HTMLElement>('.field-error').forEach(error => { error.textContent = ''; });dialog.showModal();
}
function newProject() { $<HTMLFormElement>('create-form').reset();showDialog('create-dialog'); }
function importProject() { $<HTMLFormElement>('import-form').reset();showDialog('import-dialog'); }
function rename(project: Project) { picked = project;$<HTMLInputElement>('rename-name').value = project.name;showDialog('rename-dialog');$<HTMLInputElement>('rename-name').select(); }
function archive(project: Project) { picked = project;$('archive-name').textContent = project.name;showDialog('archive-dialog'); }
async function copyPath(project: Project) {
  try { await navigator.clipboard.writeText(project.root);notify('已复制项目目录。'); }
  catch { notify('复制未完成，可从项目卡片中选择目录文字复制。'); }
}
async function openProject(project: Project) {
  if (opening) return;
  if (project.available === false) return notify('项目目录不可用，请确认原文件夹仍然存在。');
  opening = project.id;render();
  try { const result = await api('open',{id:project.id});location.assign(result.url || '/latex.html?project=' + encodeURIComponent(project.id)); }
  catch (error) { opening = null;render();showError(message(error)); }
}
async function restore(project: Project) {
  if (opening || modalBusy) return;
  try { applyProject(await api('restore',{id:project.id}));notify('项目已恢复，可在全部项目中打开。'); }
  catch (error) { showError(message(error)); }
}
async function submitDialog(id: string, action: () => Promise<void>) {
  if (modalBusy) return;
  modalBusy = true;setBusyState();const dialog = $<HTMLDialogElement>(id);
  dialog.setAttribute('aria-busy','true');dialog.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = true; });
  try { await action(); }
  catch (error) { const text = dialog.querySelector<HTMLElement>('.field-error');if (text) text.textContent = message(error);else showError(message(error)); }
  finally { modalBusy = false;setBusyState();dialog.removeAttribute('aria-busy');dialog.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = false; }); }
}
function applyProject(result: ApiResult) {
  const project = requireProject(result);loadTicket++;loading = false;projects = [...projects.filter(item => item.id !== project.id),project];render();return project;
}
function requireProject(result: ApiResult) {
  const project = result.project || (result.id ? result as unknown as Project : undefined);
  if (!project?.id) throw Error('本地服务未返回项目，请刷新项目列表。');
  return project;
}
$<HTMLFormElement>('create-form').onsubmit = event => {
  event.preventDefault();void submitDialog('create-dialog',async () => {
    const name = $<HTMLInputElement>('create-name').value.trim();
    if (!name) throw Error('请填写项目名称。');
    const form = new FormData($<HTMLFormElement>('create-form'));
    const project = applyProject(await api('create',{name,template:form.get('template') === 'blank' ? 'blank' : 'article'}));
    $<HTMLDialogElement>('create-dialog').close();await openProject(project);
  });
};
$<HTMLFormElement>('import-form').onsubmit = event => {
  event.preventDefault();void submitDialog('import-dialog',async () => {
    const path = $<HTMLInputElement>('import-path').value.trim(), name = $<HTMLInputElement>('import-name').value.trim();
    if (!path) throw Error('请填写项目文件夹的完整路径。');
    const project = applyProject(await api('import',{path,...(name ? {name} : {})}));
    $<HTMLDialogElement>('import-dialog').close();await openProject(project);
  });
};
$<HTMLFormElement>('rename-form').onsubmit = event => {
  event.preventDefault();void submitDialog('rename-dialog',async () => {
    if (!picked) return;const name = $<HTMLInputElement>('rename-name').value.trim();if (!name) throw Error('请填写项目名称。');
    applyProject(await api('rename',{id:picked.id,name}));$<HTMLDialogElement>('rename-dialog').close();notify('项目名称已更新。');
  });
};
$<HTMLFormElement>('archive-form').onsubmit = event => {
  event.preventDefault();void submitDialog('archive-dialog',async () => {
    if (!picked) return;applyProject(await api('archive',{id:picked.id}));$<HTMLDialogElement>('archive-dialog').close();notify('项目已归档，原目录和文件保持原样。');
  });
};
$('new-project').onclick = newProject;$('import-project').onclick = importProject;
for (const id of ['help-button','top-help']) $(id).onclick = () => showDialog('help-dialog');
for (const id of ['refresh-projects','retry-projects']) $(id).onclick = () => { void loadProjects(true); };
$('dismiss-error').onclick = () => $('page-error').classList.add('hidden');
$<HTMLInputElement>('project-search').oninput = render;$<HTMLSelectElement>('project-sort').onchange = render;
for (const next of ['grid','list'] as const) $(next + '-view').onclick = () => {
  view = next;try { localStorage.setItem('sidex.home.view',next); } catch {}render();
};
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) button.onclick = () => setTab(button.dataset.tab as Tab);
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-close]')) button.onclick = () => {
  if (!modalBusy) button.closest<HTMLDialogElement>('dialog')?.close();
};
for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog')) dialog.addEventListener('cancel',event => { if (modalBusy) event.preventDefault(); });
document.addEventListener('click', event => { if (!(event.target as HTMLElement).closest('.project-menu')) closeMenus(); });
document.addEventListener('keydown', event => {
  if (document.querySelector('dialog[open]')) return;
  const target = event.target as HTMLElement, typing = target.matches('input,textarea,select') || target.isContentEditable;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault();$<HTMLInputElement>('project-search').focus(); }
  else if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'n') { event.preventDefault();newProject(); }
  else if (event.key === 'Escape') closeMenus();
});
window.addEventListener('focus', () => { if (!loading && Date.now() - lastLoaded > 5000 && !document.querySelector('dialog[open]')) void loadProjects(); });
window.addEventListener('pageshow', event => { if (event.persisted) { opening = null;void loadProjects(true); } });
void loadProjects(true);
