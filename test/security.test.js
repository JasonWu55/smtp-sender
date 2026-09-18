import test from 'node:test';
import assert from 'node:assert/strict';
import { smtpInput, sendInput, aiInput, smtpOptions } from '../security.js';
import nodemailer from 'nodemailer';

export const smtp = { host: 'smtp.example.com', port: 587, secure: false, username: 'sender@example.com', password: 'test-only', fromName: '測試寄件人' };
export const email = { to: 'recipient@example.com', subject: '測試', html: '<p>Hello</p>' };
const publicDns = async () => [{ address: '8.8.8.8' }];

test('rejects file/URL objects and extra Nodemailer options before composing', () => {
  for (const html of [{ path: '/etc/passwd' }, { href: 'http://127.0.0.1/' }, ['hello'], null]) {
    assert.throws(() => sendInput({ smtp, emails: [{ ...email, html }] }), /HTML/);
  }
  const result = sendInput({ smtp, emails: [{ ...email, raw: { path: '/etc/passwd' }, attachments: [{}], envelope: {}, disableFileAccess: false }] });
  assert.deepEqual(Object.keys(result.emails[0]).sort(), ['bcc', 'cc', 'html', 'replyTo', 'subject', 'to']);
});

test('rejects malformed SMTP settings, injected headers and unbounded batches', () => {
  for (const patch of [{ host: 'https://example.com' }, { port: 80 }, { port: '587' }, { secure: 'false' }, { password: {} }]) {
    assert.throws(() => smtpInput({ ...smtp, ...patch }));
  }
  for (const patch of [{ subject: 'hello\r\nBcc: intruder@example.com' }, { to: {} }, { cc: 'bad' }, { html: 'x'.repeat(256 * 1024 + 1) }]) {
    assert.throws(() => sendInput({ smtp, emails: [{ ...email, ...patch }] }));
  }
  for (const emails of [[], [null], Array(501).fill(email)]) assert.throws(() => sendInput({ smtp, emails }));
  for (const delay of [-1, '100', 30_001, 1.5]) assert.throws(() => sendInput({ smtp, emails: [email], delay }));
  assert.throws(() => sendInput({ emails: [email] }));
  assert.throws(() => sendInput({ smtp: { ...smtp, fromName: 'a\r\nb' }, emails: [email] }));
});

test('preserves cc/bcc/reply-to and Unicode display names as structured fields', () => {
  const result = sendInput({ smtp, emails: [{ ...email, cc: 'one@example.com, two@example.com', bcc: 'private@example.com', replyTo: 'reply@example.com' }], delay: 0 });
  assert.equal(result.emails[0].cc, 'one@example.com, two@example.com');
  assert.equal(result.emails[0].bcc, 'private@example.com');
  assert.equal(result.smtp.fromName, '測試寄件人');
  assert.equal(result.pause, 0);
});

test('blocks private, mapped, metadata, multicast and reserved SMTP addresses', async () => {
  for (const host of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', '2001:db8::1']) {
    await assert.rejects(smtpOptions({ ...smtp, host }), /內網或保留/);
  }
  await assert.rejects(smtpOptions(smtp, { lookup: async () => [{ address: '8.8.8.8' }, { address: '127.0.0.1' }] }), /內網或保留/);
  await assert.rejects(smtpOptions(smtp, { lookup: async () => [] }), /內網或保留/);
  await assert.rejects(smtpOptions(smtp, { lookup: async () => { throw new Error('private DNS details'); } }), /無法解析/);
});

test('pins DNS resolution, requires TLS and keeps certificate hostname verification', async () => {
  let calls = 0;
  const options = await smtpOptions(smtp, { lookup: async () => { calls++; return publicDns(); } });
  assert.equal(calls, 1);
  assert.equal(options.host, '8.8.8.8');
  assert.equal(options.tls.servername, smtp.host);
  assert.equal(options.tls.rejectUnauthorized, true);
  assert.equal(options.requireTLS, true);
  assert.equal(options.disableFileAccess, true);
  assert.equal(options.disableUrlAccess, true);
  assert.equal(options.debug, false);
});

test('private SMTP exceptions require an exact server-side hostname', async () => {
  const lookup = async () => [{ address: '192.168.1.2' }];
  await assert.rejects(smtpOptions(smtp, { lookup, allowedHosts: 'example.com' }));
  const options = await smtpOptions(smtp, { lookup, allowedHosts: ' smtp.example.com ' });
  assert.equal(options.host, '192.168.1.2');
  assert.equal(options.requireTLS, true);
});

test('AI only accepts bounded text messages and valid credentials', () => {
  const valid = { apiKey: 'test-only', model: 'provider/model', messages: [{ role: 'user', content: 'Hello' }] };
  assert.deepEqual(aiInput(valid), valid);
  for (const patch of [{ apiKey: 'test\r\nInjected: a' }, { messages: [{}] }, { messages: [{ role: 'tool', content: 'x' }] }, { messages: [{ role: 'user', content: { url: 'file:///etc/passwd' } }] }, { messages: [] }, { model: {} }]) {
    assert.throws(() => aiInput({ ...valid, ...patch }));
  }
});

test('installed Nodemailer composes mail and enforces file/URL access restrictions without SMTP', async () => {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, disableFileAccess: true, disableUrlAccess: true });
  const message = await transport.sendMail({ from: { name: smtp.fromName, address: smtp.username }, ...email, cc: 'copy@example.com', bcc: 'hidden@example.com' });
  assert.match(message.message.toString(), /Hello/);
  assert.deepEqual(message.envelope.to, ['recipient@example.com', 'copy@example.com', 'hidden@example.com']);
  // Stream transport intentionally includes Bcc for inspection; SMTP transport removes it.
  await assert.rejects(transport.sendMail({ from: smtp.username, to: email.to, html: { path: '/etc/passwd' } }), /access|reading|file/i);
  await assert.rejects(transport.sendMail({ from: smtp.username, to: email.to, html: { href: 'http://127.0.0.1/' } }), /access|url/i);
  transport.close();
});

test('real Nodemailer refuses SMTP without STARTTLS before sending credentials', async t => {
  const { createServer } = await import('node:net');
  const { once } = await import('node:events');
  const commands = [];
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('220 local test server\r\n');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\r\n');
      buffer = lines.pop();
      for (const line of lines) {
        commands.push(line.split(' ')[0]);
        if (line.startsWith('EHLO')) socket.write('250-local test server\r\n250 AUTH PLAIN LOGIN\r\n');
        else socket.write('502 Not supported\r\n');
      }
    });
    socket.on('error', () => {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }));
  const options = await smtpOptions(smtp, { lookup: publicDns });
  const transport = nodemailer.createTransport({ ...options, host: '127.0.0.1', port: server.address().port, socketTimeout: 1000 });
  await assert.rejects(transport.verify(), /STARTTLS|TLS/i);
  assert.ok(commands.includes('STARTTLS'));
  assert.ok(!commands.includes('AUTH'));
  assert.ok(!commands.includes('DATA'));
  transport.close();
});
