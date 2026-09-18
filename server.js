import express from 'express';
import nodemailer from 'nodemailer';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { smtpInput, sendInput, aiInput, smtpOptions, InputError } from './security.js';

const root = dirname(fileURLToPath(import.meta.url));
const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-src 'self' about:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

function smtpError(error) {
  return ({
    EAUTH: 'SMTP 認證失敗，請檢查帳號與應用程式密碼',
    ETIMEDOUT: 'SMTP 連線逾時',
    ESOCKET: 'SMTP 連線或 TLS 驗證失敗',
    ECONNECTION: '無法連線至 SMTP 主機',
    EDNS: '無法解析 SMTP 主機',
    EENVELOPE: 'SMTP 主機拒絕寄件人或收件人',
    EMESSAGE: 'SMTP 主機拒絕信件內容',
  })[error.code] || 'SMTP 操作失敗，請檢查主機、TLS 與寄送設定';
}

async function writeChunk(res, chunk, signal) {
  signal.throwIfAborted();
  if (!res.write(chunk)) await once(res, 'drain', { signal });
}

function operation(res, timeout) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  res.once('close', cancel);
  const timer = setTimeout(cancel, timeout);
  timer.unref();
  return {
    signal: controller.signal,
    dispose() { clearTimeout(timer); res.off('close', cancel); },
  };
}

// Dependencies can be replaced by local test doubles; tests never send mail.
export function createApp({ createTransport = nodemailer.createTransport, fetchImpl = fetch, lookup, allowedHosts = process.env.SMTP_ALLOWED_HOSTS || '' } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Cache-Control': 'no-store',
    });
    // Binding only to loopback is not sufficient against DNS rebinding.
    const authority = req.get('host');
    const port = req.socket.localPort;
    const suffix = port === 80 ? '' : `:${port}`;
    if (![`localhost${suffix}`, `127.0.0.1${suffix}`].includes(authority)) {
      return res.status(403).json({ error: '僅允許 localhost 或 127.0.0.1 存取' });
    }
    if (/^\/api(?:\/|$)/i.test(req.path)) {
      const origin = req.get('origin');
      if ((origin && origin !== `http://${authority}`) ||
          ['cross-site', 'same-site'].includes(req.get('sec-fetch-site')) ||
          req.get('x-smtp-sender') !== '1') {
        return res.status(403).json({ error: '請由本機 SMTP Sender 頁面操作' });
      }
      if (req.method !== 'POST') return res.status(405).json({ error: '僅支援 POST' });
      if (!req.is('application/json')) return res.status(415).json({ error: '必須使用 JSON' });
    }
    next();
  });

  let active = 0;
  let windowStart = Date.now();
  let requests = 0;
  app.use('/api', (req, res, next) => {
    if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); requests = 0; }
    if (++requests > 60 || active >= 3) {
      res.set('Retry-After', '60');
      return res.status(429).json({ error: '請稍後再試，目前請求過多' });
    }
    active++;
    res.once('close', () => active--);
    next();
  });
  app.use('/api', express.json({ limit: '10mb', strict: true, inflate: false }));
  const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);

  app.post('/api/verify-smtp', route(async (req, res) => {
    const smtp = smtpInput(req.body);
    const op = operation(res, 45_000);
    let transporter;
    try {
      const options = await smtpOptions(smtp, { lookup, allowedHosts });
      op.signal.throwIfAborted();
      transporter = createTransport(options);
      await transporter.verify();
      if (!op.signal.aborted) res.json({ ok: true, message: '連線成功！' });
    } catch (error) {
      if (error instanceof InputError) throw error;
      if (!res.destroyed) res.status(400).json({ ok: false, error: smtpError(error) });
    } finally {
      transporter?.close();
      op.dispose();
      if (op.signal.aborted && !res.destroyed) res.end();
    }
  }));

  app.post('/api/send', route(async (req, res) => {
    const { smtp, emails, pause } = sendInput(req.body);
    const op = operation(res, 30 * 60_000);
    let transporter;
    try {
      const options = await smtpOptions(smtp, { lookup, allowedHosts });
      op.signal.throwIfAborted();
      transporter = createTransport(options);
      res.set({ 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      for (let index = 0; index < emails.length; index++) {
        op.signal.throwIfAborted();
        const email = emails[index];
        let result;
        try {
          await transporter.sendMail({
            from: { name: smtp.fromName, address: smtp.fromEmail || smtp.username },
            ...email,
            disableFileAccess: true,
            disableUrlAccess: true,
          });
          result = { index, email: email.to, status: 'sent' };
        } catch (error) {
          result = { index, email: email.to, status: 'failed', error: smtpError(error) };
        }
        await writeChunk(res, JSON.stringify(result) + '\n', op.signal);
        if (pause && index < emails.length - 1) await delay(pause, undefined, { signal: op.signal });
      }
      res.end();
    } catch (error) {
      if (!res.headersSent && !op.signal.aborted) throw error;
      // A disconnected client stops the batch. An already accepted email cannot be recalled.
      if (!res.destroyed) res.destroy();
    } finally {
      transporter?.close();
      op.dispose();
    }
  }));

  app.post('/api/ai', route(async (req, res) => {
    const { apiKey, model, messages } = aiInput(req.body);
    const op = operation(res, 120_000);
    try {
      const upstream = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        redirect: 'error',
        signal: op.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'SMTP Mail Sender' },
        body: JSON.stringify({ model, messages, stream: true }),
      });
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel();
        return res.status(502).json({ error: `AI 服務回應失敗（HTTP ${upstream.status}），請檢查金鑰、模型與額度` });
      }
      res.set({ 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      let received = 0;
      for await (const chunk of upstream.body) {
        received += chunk.byteLength;
        if (received > 2 * 1024 * 1024) throw new Error('Response too large');
        await writeChunk(res, chunk, op.signal);
      }
      res.end();
    } catch {
      if (!res.headersSent && !res.destroyed) res.status(502).json({ error: 'AI 服務連線失敗或逾時，請稍後再試' });
      else if (!res.destroyed) res.destroy();
    } finally { op.dispose(); }
  }));

  // Only these browser bundles are public; never expose the node_modules directory.
  for (const [url, file] of Object.entries({
    'quill.js': 'quill/dist/quill.js',
    'quill.snow.css': 'quill/dist/quill.snow.css',
    'papaparse.min.js': 'papaparse/papaparse.min.js',
    'purify.min.js': 'dompurify/dist/purify.min.js',
  })) {
    app.get(`/vendor/${url}`, (req, res) => res.sendFile(join(root, 'node_modules', file)));
  }
  app.use(express.static(join(root, 'public'), { dotfiles: 'deny', etag: false }));
  app.use((req, res) => res.status(404).json({ error: '找不到此資源' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error instanceof InputError ? 400 : [400, 413, 415].includes(error.status) ? error.status : 500;
    const message = error instanceof InputError ? error.message : ({
      400: 'JSON 格式不正確', 413: '請求超過 10 MB 上限', 415: '不支援此資料格式',
    })[status] || '伺服器無法完成請求';
    res.status(status).json({ error: message });
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必須介於 1 到 65535');
  const server = createApp().listen(port, '127.0.0.1', () => console.log(`SMTP Sender → http://localhost:${port}`));
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
}
