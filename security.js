import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export class InputError extends Error {}
const fail = message => { throw new InputError(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const controls = /[\u0000-\u001f\u007f]/;

function text(value, label, max, { optional = false, multiline = false } = {}) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || (!multiline && controls.test(value))) {
    fail(`${label} 格式或長度不正確`);
  }
  return value;
}

function address(value, label, optional = false, multiple = false) {
  const result = text(value, label, multiple ? 4096 : 254, { optional });
  if (!result) return '';
  const entries = multiple ? result.split(',').map(item => item.trim()) : [result];
  if (entries.length > 50 || entries.some(entry => entry.length > 254 || !/^[^\s<>(),;:"\\@]+@[^\s<>(),;:"\\@]+\.[^\s<>(),;:"\\@]+$/u.test(entry))) {
    fail(`${label} 必須是 Email 地址，多個地址請以逗號分隔`);
  }
  return entries.join(', ');
}

export function smtpInput(value) {
  if (!object(value)) fail('缺少 SMTP 設定');
  const host = text(value.host, 'SMTP 主機', 253).toLowerCase();
  if (!isIP(host) && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) fail('SMTP 主機格式不正確');
  const port = value.port;
  if (!Number.isInteger(port) || ![25, 465, 587, 2525].includes(port)) fail('SMTP Port 僅支援 25、465、587、2525');
  if (typeof value.secure !== 'boolean') fail('SMTP TLS 設定必須是布林值');
  const username = text(value.username, 'SMTP 帳號', 320);
  const password = text(value.password, 'SMTP 密碼', 1024);
  const fromEmail = address(value.fromEmail, '寄件人', true);
  const fromName = text(value.fromName, '寄件人名稱', 200, { optional: true });
  return { host, port, secure: value.secure, username, password, fromEmail, fromName };
}

export function sendInput(value) {
  if (!object(value)) fail('請求格式不正確');
  const smtp = smtpInput(value.smtp);
  address(smtp.fromEmail || smtp.username, '寄件人');
  if (!Array.isArray(value.emails) || value.emails.length < 1 || value.emails.length > 500) fail('每批收件人必須介於 1 到 500 位');
  const pause = value.delay === undefined ? 500 : value.delay;
  if (!Number.isInteger(pause) || pause < 0 || pause > 30_000) fail('寄送間隔必須介於 0 到 30000 毫秒');
  const emails = value.emails.map(email => {
    if (!object(email)) fail('信件格式不正確');
    return {
      to: address(email.to, '收件人'),
      cc: address(email.cc, 'CC', true, true),
      bcc: address(email.bcc, 'BCC', true, true),
      replyTo: address(email.replyTo, '回覆地址', true),
      subject: text(email.subject, '主旨', 998),
      html: text(email.html, 'HTML 內容', 256 * 1024, { multiline: true }),
    };
  });
  return { smtp, emails, pause };
}

export function aiInput(value) {
  if (!object(value)) fail('AI 請求格式不正確');
  const apiKey = text(value.apiKey, 'API Key', 512);
  if (/\s/.test(apiKey)) fail('API Key 不可包含空白');
  const model = text(value.model, '模型', 200);
  if (!/^[a-zA-Z0-9_.:/-]+$/.test(model)) fail('模型格式不正確');
  if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 30) fail('訊息數量必須介於 1 到 30');
  const messages = value.messages.map(message => {
    if (!object(message) || !['system', 'user', 'assistant'].includes(message.role)) fail('AI 訊息角色不正確');
    return { role: message.role, content: text(message.content, 'AI 訊息', 100_000, { multiline: true }) };
  });
  if (messages.reduce((sum, message) => sum + message.content.length, 0) > 200_000) fail('AI 訊息內容過長');
  return { apiKey, model, messages };
}

export async function smtpOptions(smtp, { lookup = dnsLookup, allowedHosts = '' } = {}) {
  const allowPrivate = allowedHosts.split(',').map(host => host.trim().toLowerCase()).filter(Boolean).includes(smtp.host);
  let timer;
  let addresses;
  try {
    addresses = isIP(smtp.host) ? [{ address: smtp.host }] : await Promise.race([
      lookup(smtp.host, { all: true }),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), 10_000); }),
    ]);
  } catch { fail('無法解析 SMTP 主機'); }
  finally { clearTimeout(timer); }
  if (!addresses.length || addresses.some(({ address }) => !ipaddr.isValid(address) || (!allowPrivate && ipaddr.process(address).range() !== 'unicast'))) {
    fail('SMTP 主機不可指向內網或保留位址；自管主機請設定 SMTP_ALLOWED_HOSTS');
  }
  return {
    // Pin the validated address so a second DNS lookup cannot rebind into the LAN.
    host: addresses[0].address,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: !smtp.secure,
    auth: { user: smtp.username, pass: smtp.password },
    tls: { servername: smtp.host, minVersion: 'TLSv1.2', rejectUnauthorized: true },
    name: 'localhost',
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  };
}
