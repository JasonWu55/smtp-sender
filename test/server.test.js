import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.js';

const smtp = { host: 'smtp.example.com', port: 587, secure: false, username: 'sender@example.com', password: 'test-only' };
const email = { to: 'recipient@example.com', subject: 'Hello', html: '<p>Test</p>' };
const headers = { 'Content-Type': 'application/json', 'X-SMTP-Sender': '1' };

async function setup(t, options = {}) {
  const sent = [];
  let closed = 0;
  const app = createApp({
    lookup: async () => [{ address: '8.8.8.8' }],
    createTransport: () => ({ verify: async () => true, sendMail: async mail => { sent.push(mail); }, close: () => closed++ }),
    ...options,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, extra = {}) => fetch(url + path, { method: 'POST', headers, body: JSON.stringify(body), ...extra });
  return { url, post, sent, closed: () => closed };
}

test('local page and pinned browser bundles load with security headers; private files stay hidden', async t => {
  const { url } = await setup(t);
  for (const path of ['/', '/vendor/quill.js', '/vendor/quill.snow.css', '/vendor/papaparse.min.js', '/vendor/purify.min.js']) {
    const res = await fetch(url + path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    await res.arrayBuffer();
  }
  for (const path of ['/.env', '/package.json', '/node_modules/nodemailer/package.json', '/vendor/package.json']) {
    const res = await fetch(url + path); assert.equal(res.status, 404, path); await res.arrayBuffer();
  }
});

test('rejects cross-site requests, forged hostnames and simple requests', async t => {
  const { url, post, sent } = await setup(t);
  for (const extra of [{ Origin: 'https://attacker.invalid' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { 'X-SMTP-Sender': '' }]) {
    const res = await post('/api/send', { smtp, emails: [email] }, { headers: { ...headers, ...extra } });
    assert.equal(res.status, 403, JSON.stringify(extra)); await res.arrayBuffer();
  }
  const forged = await new Promise((resolve, reject) => {
    const req = request(url + '/api/send', { method: 'POST', headers: { ...headers, Host: 'attacker.invalid' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ smtp, emails: [email] }));
  });
  assert.equal(forged, 403);
  const uppercase = await post('/API/send', { smtp, emails: [email] }, { headers: { 'Content-Type': 'application/json' } });
  assert.equal(uppercase.status, 403);
  const preflight = await fetch(url + '/api/send', { method: 'OPTIONS', headers: { Origin: 'https://attacker.invalid' } });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  const form = await post('/api/send', {}, { headers: { ...headers, 'Content-Type': 'text/plain' } });
  assert.equal(form.status, 415);
  assert.equal(sent.length, 0);
});

test('malformed JSON and missing fields return safe errors without crashing', async t => {
  const { post } = await setup(t);
  for (const body of [{}, { smtp, emails: [null] }, { smtp, emails: [{ ...email, html: { path: '/etc/passwd' } }] }]) {
    const res = await post('/api/send', body); assert.equal(res.status, 400); assert.doesNotMatch(await res.text(), /at |\/root\//);
  }
  const bad = await post('/api/send', {}, { body: '{' });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'JSON 格式不正確' });
  const good = await post('/api/verify-smtp', smtp);
  assert.equal(good.status, 200);
});

test('rejects oversized and compressed requests before SMTP work', async t => {
  const { post, sent } = await setup(t);
  const oversized = await post('/api/send', {}, { body: ' '.repeat(10 * 1024 * 1024 + 1) });
  assert.equal(oversized.status, 413);
  const compressed = await post('/api/send', {}, { headers: { ...headers, 'Content-Encoding': 'gzip' } });
  assert.equal(compressed.status, 415);
  assert.equal(sent.length, 0);
});

test('send streams progress and passes only validated mail fields', async t => {
  const { post, sent, closed } = await setup(t);
  const res = await post('/api/send', { smtp, emails: [{ ...email, cc: 'copy@example.com', bcc: 'hidden@example.com', replyTo: 'reply@example.com', raw: 'unexpected' }, email], delay: 0 });
  assert.equal(res.status, 200);
  const rows = (await res.text()).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.status), ['sent', 'sent']);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].raw, undefined);
  assert.equal(sent[0].bcc, 'hidden@example.com');
  assert.equal(sent[0].disableFileAccess, true);
  assert.deepEqual(sent[0].from, { name: '', address: smtp.username });
  assert.equal(closed(), 1);
});

test('SMTP server errors cannot disclose raw credentials or injected HTML', async t => {
  const error = Object.assign(new Error('password=<img src=x>'), { code: 'EAUTH' });
  const { post } = await setup(t, { createTransport: () => ({ verify: async () => { throw error; }, sendMail: async () => { throw error; }, close() {} }) });
  const verify = await post('/api/verify-smtp', smtp);
  assert.equal(verify.status, 400);
  assert.doesNotMatch(await verify.text(), /password|<img/);
  const send = await post('/api/send', { smtp, emails: [email] });
  const row = JSON.parse((await send.text()).trim());
  assert.equal(row.status, 'failed');
  assert.doesNotMatch(row.error, /password|<img/);
});

test('disconnect cancels remaining batch and releases transport', async t => {
  const { post, sent, closed } = await setup(t);
  const controller = new AbortController();
  const res = await post('/api/send', { smtp, emails: [email, email, email], delay: 150 }, { signal: controller.signal });
  await res.body.getReader().read();
  controller.abort();
  await delay(250);
  assert.equal(sent.length, 1);
  assert.equal(closed(), 1);
});

test('AI upstream failure is redacted and successful SSE is forwarded', async t => {
  let fail = true;
  let request;
  const { post } = await setup(t, { fetchImpl: async (url, options) => {
    request = { url, options };
    return fail ? new Response('sensitive upstream error', { status: 401 }) : new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n');
  } });
  const input = { apiKey: 'test-only', model: 'provider/model', messages: [{ role: 'user', content: 'Hello' }] };
  const bad = await post('/api/ai', input);
  assert.equal(bad.status, 502);
  assert.doesNotMatch(await bad.text(), /sensitive|test-only/);
  fail = false;
  const good = await post('/api/ai', input);
  assert.match(await good.text(), /\[DONE\]/);
  assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(request.options.redirect, 'error');
  assert.ok(request.options.signal instanceof AbortSignal);
});

test('AI client disconnect aborts upstream generation', async t => {
  let signal;
  const { post } = await setup(t, { fetchImpl: async (url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {}\n\n'));
      signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
    } }));
  } });
  const controller = new AbortController();
  const res = await post('/api/ai', { apiKey: 'test-only', model: 'provider/model', messages: [{ role: 'user', content: 'Hello' }] }, { signal: controller.signal });
  await res.body.getReader().read();
  controller.abort();
  await delay(50);
  assert.equal(signal.aborted, true);
});

test('request burst is limited', async t => {
  const { post } = await setup(t);
  for (let i = 0; i < 60; i++) {
    const res = await post('/api/verify-smtp', {}); assert.equal(res.status, 400); await res.arrayBuffer();
  }
  const res = await post('/api/verify-smtp', {});
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '60');
});
