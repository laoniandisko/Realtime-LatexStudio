export interface CatalogModel { id: string; name: string; provider: string; kind: 'chat' | 'image' | 'video' | 'audio' }
export interface ModelSettings { configured: boolean; baseUrl: string; model: string; models: CatalogModel[]; hasKey: boolean }
interface Options {
  api<T = any>(name: string, data?: any): Promise<T>;
  modal(html: string, className?: string): void; close(): void;
  saved(settings: ModelSettings): void; notify(message: string, error?: boolean): void;
}
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const kinds = { chat: '聊天', image: '图像', video: '视频', audio: '语音' };

export async function showModelSettings(options: Options) {
  let state: ModelSettings;
  try { state = await options.api('model-settings'); }
  catch (e: any) { options.notify('模型设置加载失败：' + e.message, true); return; }
  options.modal(`<div class="dialog-head"><span class="codicon codicon-sparkle"></span>模型设置<button class="icon-btn" data-close>×</button></div><div class="dialog-body"><p>填写 API 地址与密钥，自动获取可用模型。选择后即可用于智能体对话。</p><label class="field">API 地址<input id="model-url" value="${escape(state.baseUrl)}" placeholder="https://api.example.com/v1"></label><label class="field">API Key<input id="model-key" type="password" autocomplete="off" placeholder="${state.hasKey ? '已配置凭据；留空保留' : '无鉴权接口可留空'}"><small>输入的密钥只保留在本地服务内存中，不写入浏览器存储。</small></label><div class="catalog-heading"><strong>模型目录</strong><span id="model-catalog-count"></span><button id="fetch-models" class="secondary"><span class="codicon codicon-refresh"></span>获取可用模型</button></div><div id="model-catalog-status" role="status" class="catalog-status"></div><div class="catalog-filters"><input id="model-search" placeholder="搜索模型名称或提供方" aria-label="搜索模型"><select id="model-kind" aria-label="模型类型"><option value="">全部类型</option><option value="chat">聊天</option><option value="image">图像</option><option value="video">视频</option><option value="audio">语音</option></select></div><div id="model-catalog" class="model-catalog" role="listbox" aria-label="可用模型"></div><div class="catalog-selection">当前选择：<strong id="model-selected"></strong></div><small class="muted">图像、视频、语音模型保留在目录中；当前智能体对话使用聊天模型。模型目录不代表上游调用已逐一验证。</small></div><div class="dialog-actions"><button class="secondary" data-close>取消</button><button class="primary" id="save-model">保存</button></div>`, 'model-dialog');
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const url = $('model-url') as HTMLInputElement, key = $('model-key') as HTMLInputElement, search = $('model-search') as HTMLInputElement, filter = $('model-kind') as HTMLSelectElement;
  const catalog = $('model-catalog'), status = $('model-catalog-status'), save = $('save-model') as HTMLButtonElement, fetchButton = $('fetch-models') as HTMLButtonElement;
  let models = state.models || [], selected = state.model, catalogBase = state.baseUrl, busy = false, revision = 0;
  const statusText = (message: string, error = false) => { status.textContent = message; status.classList.toggle('error', error); };
  function draw() {
    $('model-catalog-count').textContent = `${models.length} 个模型`;
    $('model-selected').textContent = selected || '尚未选择';
    save.disabled = busy || !models.some(m => m.id === selected && m.kind === 'chat') || url.value.trim().replace(/\/$/, '') !== catalogBase;
    const query = search.value.toLowerCase().trim();
    const visible = models.filter(m => (!filter.value || m.kind === filter.value) && (!query || `${m.id} ${m.name} ${m.provider}`.toLowerCase().includes(query)));
    catalog.replaceChildren();
    if (!visible.length) { const p = document.createElement('p'); p.className = 'catalog-empty'; p.textContent = models.length ? '没有匹配的模型' : '点击「获取可用模型」加载目录'; catalog.append(p); }
    for (const model of visible) {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'catalog-model'; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(model.id === selected)); row.classList.toggle('selected', model.id === selected); row.disabled = model.kind !== 'chat';
      row.title = model.kind === 'chat' ? model.id : `${kinds[model.kind]}模型，当前对话面板使用聊天模型`;
      const check = document.createElement('span'); check.className = 'catalog-check'; check.textContent = model.id === selected ? '✓' : '';
      const name = document.createElement('span'); name.className = 'catalog-name'; const label = document.createElement('strong'); label.textContent = model.name; const id = document.createElement('small'); id.textContent = model.name !== model.id ? model.id : model.provider; name.append(label, id);
      const badge = document.createElement('span'); badge.className = 'catalog-kind ' + model.kind; badge.textContent = kinds[model.kind]; row.append(check, name, badge);
      row.onclick = () => { selected = model.id; draw(); }; catalog.append(row);
    }
  }
  async function discover() {
    const request = ++revision, baseUrl = url.value.trim(), apiKey = key.value;
    busy = true; fetchButton.disabled = true; statusText('正在连接模型目录…'); draw();
    try {
      const result = await options.api<{ baseUrl: string; models: CatalogModel[] }>('models', { baseUrl, key: apiKey });
      if (!catalog.isConnected || request !== revision || url.value.trim() !== baseUrl || key.value !== apiKey) return;
      models = result.models; catalogBase = result.baseUrl; url.value = result.baseUrl;
      if (!models.some(m => m.id === selected && m.kind === 'chat')) selected = models.find(m => m.id === 'gpt-6.1-sol')?.id || models.find(m => m.kind === 'chat')?.id || '';
      statusText(`已获取 ${models.length} 个模型 · ${models.filter(m => m.kind === 'chat').length} 个可用于对话`);
    } catch (e: any) { if (catalog.isConnected && request === revision) statusText(e.message, true); }
    finally { if (catalog.isConnected && request === revision) { busy = false; fetchButton.disabled = false; draw(); } }
  }
  fetchButton.onclick = () => void discover(); search.oninput = draw; filter.onchange = draw;
  let timer: ReturnType<typeof setTimeout>;
  const editedConnection = () => { revision++; busy = false; fetchButton.disabled = false; draw(); statusText('连接设置已更改，请获取模型目录'); clearTimeout(timer); timer = setTimeout(() => { if (catalog.isConnected && url.value.trim()) void discover(); }, 700); };
  url.onchange = editedConnection; key.onchange = editedConnection; url.oninput = () => { save.disabled = true; };
  save.onclick = async () => {
    save.disabled = true;
    try { const result = await options.api<ModelSettings>('model', { baseUrl: url.value.trim(), model: selected, key: key.value }); options.saved(result); options.close(); options.notify('模型已保存：' + result.model); }
    catch (e: any) { statusText(e.message, true); draw(); }
  };
  draw();
  if (models.length) statusText(`已加载 ${models.length} 个模型，正在刷新目录…`);
  void discover();
}
