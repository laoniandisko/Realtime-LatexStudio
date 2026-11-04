import { promises as fs } from 'node:fs';
import path from 'node:path';

export function normalizeBaseUrl(value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw Error('远程接口使用 HTTPS；本机网关可使用 HTTP。');
  if (url.username || url.password || url.search || url.hash) throw Error('API 地址不能包含账号、查询参数或片段。');
  url.pathname = url.pathname.replace(/\/management\.html\/?$/, '/v1').replace(/\/$/, '') || '/v1';
  return url.href.replace(/\/$/, '');
}
export function modelKind(id) {
  if (/video/i.test(id)) return 'video';
  if (/tts|voice|audio|speech/i.test(id)) return 'audio';
  if (/image|imagine/i.test(id)) return 'image';
  return 'chat';
}
export function catalogModels(data) {
  const list = Array.isArray(data) ? data : data?.data;
  if (!Array.isArray(list)) throw Error('接口未返回 OpenAI 兼容的模型列表。');
  const seen = new Set();
  return list.filter(m => typeof m?.id === 'string' && m.id.trim() && m.id.length <= 256 && !seen.has(m.id) && seen.add(m.id)).map(m => ({ id: m.id, name: typeof m.name === 'string' ? m.name : m.id, provider: typeof m.owned_by === 'string' ? m.owned_by : 'API', kind: modelKind(m.id) })).sort((a, b) => a.id.localeCompare(b.id));
}

export class ModelProvider {
  config = null;
  sessionKey = '';
  ready;
  constructor(statePath, fetcher = fetch) {
    this.statePath = statePath; this.fetcher = fetcher;
    this.ready = fs.readFile(statePath, 'utf8').then(text => { const c = JSON.parse(text); this.config = { ...c, baseUrl: normalizeBaseUrl(c.baseUrl), models: catalogModels(c.models?.map(m => ({ ...m, owned_by: m.provider }))) }; }).catch(e => { if (e.code !== 'ENOENT') this.loadError = '模型设置读取失败，请重新获取模型。'; });
  }
  async keyFor(baseUrl, supplied) {
    if (typeof supplied === 'string' && supplied.trim()) return supplied.trim();
    if (!this.config || baseUrl !== this.config.baseUrl) return '';
    if (this.sessionKey) return this.sessionKey;
    return '';
  }
  async discover(data = {}) {
    await this.ready;
    const baseUrl = normalizeBaseUrl(data.baseUrl || this.config?.baseUrl || '');
    const key = await this.keyFor(baseUrl, data.key);
    let response;
    try { response = await this.fetcher(baseUrl + '/models', { headers: key ? { Authorization: 'Bearer ' + key } : {}, signal: AbortSignal.timeout(15000), redirect: 'error' }); }
    catch { throw Error('无法连接模型目录，请检查 API 地址和网关状态。'); }
    if (response.status === 401 || response.status === 403) throw Error('API Key 无效或缺失，请填写网关的客户端 API Key。');
    if (!response.ok) throw Error(`获取模型失败（HTTP ${response.status}）。`);
    let body; try { body = await response.json(); } catch { throw Error('模型接口返回的不是有效 JSON。'); }
    const models = catalogModels(body);
    if (!models.length) throw Error('网关模型列表为空，请检查上游连接。');
    return { baseUrl, models, count: models.length, hasKey: !!key, fetchedAt: new Date().toISOString() };
  }
  async settings() {
    await this.ready;
    const c = this.config;
    return { configured: !!c?.model, baseUrl: c?.baseUrl || '', model: c?.model || '', models: c?.models || [], hasKey: c ? !!await this.keyFor(c.baseUrl).catch(() => '') : false, error: this.loadError };
  }
  async save(data) {
    await this.ready;
    const catalog = await this.discover(data), selected = catalog.models.find(m => m.id === data.model);
    if (!selected) throw Error('请选择模型目录中的一个模型。');
    if (selected.kind !== 'chat') throw Error('此模型用于图像、视频或语音；智能体对话请选择聊天模型。');
    const config = { baseUrl: catalog.baseUrl, model: selected.id, models: catalog.models, fetchedAt: catalog.fetchedAt };
    const key = await this.keyFor(config.baseUrl, data.key);
    // Only non-secret settings/catalogs are persisted. Typed keys stay in process memory.
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify(config, null, 2) + '\n');
    this.config = config; this.sessionKey = key;
    return this.settings();
  }
  async connection() {
    await this.ready;
    if (!this.config?.model) throw Error('请先获取可用模型并选择一个聊天模型。');
    return { baseUrl: this.config.baseUrl, model: this.config.model, key: await this.keyFor(this.config.baseUrl) };
  }
}
