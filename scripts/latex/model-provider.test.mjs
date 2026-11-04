import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ModelProvider, normalizeBaseUrl, catalogModels } from './model-provider.mjs';

const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const data = { data: [{ id: 'gpt-chat', owned_by: 'provider' }, { id: 'gpt-image' }, { id: 'grok-video' }, { id: 'voice-tts' }, { id: 'gpt-chat' }, {}] };
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sidex-models-'));

test('model addresses normalize local management URLs and reject embedded credentials', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8000/management.html'), 'http://127.0.0.1:8000/v1');
  assert.equal(normalizeBaseUrl('https://example.com/custom/v1/'), 'https://example.com/custom/v1');
  assert.throws(() => normalizeBaseUrl('http://remote.example/v1'));
  assert.throws(() => normalizeBaseUrl('https://user:secret@example.com/v1'));
  assert.throws(() => normalizeBaseUrl('https://example.com/v1?key=secret'));
});
test('the catalog preserves every model category and deduplicates IDs', () => {
  const models = catalogModels(data); assert.equal(models.length, 4);
  assert.deepEqual(new Set(models.map(m => m.kind)), new Set(['chat', 'image', 'video', 'audio']));
  assert.throws(() => catalogModels({ models: [] }));
});
test('discovery uses the supplied key only for the chosen API and never invokes chat', async () => {
  const calls = [], provider = new ModelProvider(path.join(directory, 'discover.json'), async (url, options) => { calls.push({ url, options }); return json(data); });
  const result = await provider.discover({ baseUrl: 'https://models.example/v1', key: 'test-secret' });
  assert.equal(result.models.length, 4); assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://models.example/v1/models');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-secret'); assert.equal(calls[0].options.redirect, 'error');
  assert(!JSON.stringify(result).includes('test-secret'));
});
test('selected model/catalog survive restart while typed credentials stay in memory', async () => {
  const file = path.join(directory, 'persist.json'), provider = new ModelProvider(file, async () => json(data));
  await provider.save({ baseUrl: 'https://models.example/v1', key: 'private-test-key', model: 'gpt-chat', credentialSource: { path: '/ignored' } });
  assert.equal((await provider.connection()).key, 'private-test-key');
  const saved = await fs.readFile(file, 'utf8'); assert(!saved.includes('private-test-key')); assert(!saved.includes('credentialSource'));
  const restored = new ModelProvider(file, async () => json(data)), settings = await restored.settings();
  assert.equal(settings.model, 'gpt-chat'); assert.equal(settings.models.length, 4); assert.equal(settings.hasKey, false);
});
test('changing provider URLs never forwards the old provider credential', async () => {
  const calls = [], provider = new ModelProvider(path.join(directory, 'isolate.json'), async (url, options) => { calls.push(options.headers); return json(data); });
  await provider.save({ baseUrl: 'https://one.example/v1', key: 'one-secret', model: 'gpt-chat' });
  await provider.discover({ baseUrl: 'https://two.example/v1' });
  assert.equal(calls.at(-1).Authorization, undefined);
  await assert.rejects(provider.save({ baseUrl: 'https://one.example/v1', model: 'gpt-image' }), /请选择聊天模型/);
  assert.equal((await provider.settings()).model, 'gpt-chat');
});
test('authentication and malformed responses give bounded errors without leaking provider bodies', async () => {
  const provider = new ModelProvider(path.join(directory, 'fail.json'), async () => new Response('private upstream body', { status: 401 }));
  await assert.rejects(provider.discover({ baseUrl: 'http://127.0.0.1:8000/v1' }), /API Key/);
  provider.fetcher = async () => new Response('private upstream body');
  await assert.rejects(provider.discover({ baseUrl: 'http://127.0.0.1:8000/v1' }), error => error.message.includes('有效 JSON') && !error.message.includes('private'));
});
test('legacy credential file references are ignored and cannot be accepted through settings', async () => {
 const state=path.join(directory,'legacy.json');
 await fs.writeFile(state,JSON.stringify({baseUrl:'https://models.example/v1',model:'gpt-chat',models:[],credentialSource:{type:'unsupported-file',path:'/must-not-read'}}));
 const calls=[],provider=new ModelProvider(state,async(url,options)=>{calls.push(options.headers);return json(data);});
 await provider.ready;assert.equal((await provider.connection()).key,'');
 await provider.save({baseUrl:'https://models.example/v1',model:'gpt-chat',credentialSource:{type:'unsupported-file',path:'/must-not-read'}});
 assert.equal(calls.at(-1).Authorization,undefined);assert(!(await fs.readFile(state,'utf8')).includes('credentialSource'));
});
