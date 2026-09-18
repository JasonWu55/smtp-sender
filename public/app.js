/* ══════════════════════════════════════════════
   SMTP Mail Sender — app.js
══════════════════════════════════════════════ */

// ── State ──────────────────────────────────────
const state = {
  profiles: [],
  activeProfileId: null,
  recipients: [],         // [{ email, ...args }]
  csvHeaders: ['email'],  // first is always email
  history: [],            // send sessions
  drafts: [],             // saved email drafts/templates
  aiHtml: '',
  aiPreviewMode: false,
  templateName: '',       // name of the applied template marker
  editorMode: 'rich',     // rich = Quill, html = raw source editor
};

// ── Persistence helpers ────────────────────────
const LS = {
  get: (k, def = null) => { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

// ── Quill instance ─────────────────────────────
let quill;

// ── Template engine ────────────────────────────
function applyTemplate(tpl, data, html = false) {
  return tpl.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, k) => {
    if (!Object.hasOwn(data, k)) return match;
    return html ? esc(data[k]) : String(data[k]);
  });
}

function sanitizeEmailHtml(html) {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'base', 'link', 'meta', 'video', 'audio'],
    FORBID_ATTR: ['srcset', 'id', 'name'],
  });
}

function renderEmailHtml(html, data) {
  return sanitizeEmailHtml(applyTemplate(html, data, true));
}

function previewDocument(html) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'">
    <meta name="referrer" content="no-referrer">
    <style>body{font-family:system-ui,sans-serif;padding:24px;max-width:640px;margin:0 auto;}</style>
    </head><body>${sanitizeEmailHtml(html)}</body></html>`;
}

// ── Email HTML normaliser ──────────────────────
// Quill's <p> tags have no inline styles, so email clients apply their
// own default margin (1em top + bottom) → double-spaced paragraphs.
// This injects minimal inline styles before sending.
function prepareHtmlForEmail(html) {
  const div = document.createElement('div');
  div.innerHTML = sanitizeEmailHtml(html);

  div.querySelectorAll('p').forEach(p => {
    // Quill empty-line placeholder: <p><br></p>
    if (p.childNodes.length === 1 && p.firstChild?.nodeName === 'BR') {
      p.style.margin = '0';
      p.style.lineHeight = '0.7em';
    } else {
      if (!p.style.margin)     p.style.margin = '0 0 0.55em 0';
      if (!p.style.lineHeight) p.style.lineHeight = '1.6';
    }
  });

  div.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => {
    if (!h.style.margin)     h.style.margin = '0 0 0.45em 0';
    if (!h.style.lineHeight) h.style.lineHeight = '1.25';
  });

  div.querySelectorAll('ul,ol').forEach(list => {
    if (!list.style.margin)       list.style.margin = '0 0 0.55em 0';
    if (!list.style.paddingLeft)  list.style.paddingLeft = '1.5em';
  });

  div.querySelectorAll('li').forEach(li => {
    if (!li.style.lineHeight) li.style.lineHeight = '1.6';
    if (!li.style.margin)     li.style.margin = '0 0 3px 0';
  });

  div.querySelectorAll('blockquote').forEach(bq => {
    if (!bq.style.margin)      bq.style.margin = '0 0 0.55em 1em';
    if (!bq.style.paddingLeft) bq.style.paddingLeft = '1em';
    if (!bq.style.borderLeft)  bq.style.borderLeft = '4px solid #cbd5e1';
    if (!bq.style.color)       bq.style.color = '#64748b';
  });

  return div.innerHTML;
}

// ── UUID ───────────────────────────────────────
function uid() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}

// ── Toast ──────────────────────────────────────
function toast(msg, type = 'info', ms = 3000) {
  const wrap = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
  el.innerHTML = `<span>${icon}</span><span>${esc(msg)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 300ms'; setTimeout(() => el.remove(), 320); }, ms);
}

// ── Modal helpers ──────────────────────────────
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
  if (id === 'profile-modal') document.getElementById('pf-password').value = '';
}

document.querySelectorAll('.modal-close').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.dataset.modal));
});
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(overlay.id); });
});

// ── Theme ──────────────────────────────────────
(function initTheme() {
  const saved = LS.get('theme', 'light');
  if (saved === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  document.getElementById('theme-btn').textContent = saved === 'dark' ? '☀️' : '🌙';
})();

document.getElementById('theme-btn').addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
  document.getElementById('theme-btn').textContent = isDark ? '🌙' : '☀️';
  LS.set('theme', isDark ? 'light' : 'dark');
});

// ── Tab switching ──────────────────────────────
document.querySelectorAll('.h-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.h-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    if (tab.dataset.tab === 'history') renderHistory();
  });
});

// ══════════════════════════════════════════════
//   PROFILES
// ══════════════════════════════════════════════

function loadProfiles() {
  state.profiles = LS.get('smtp_profiles', []);
  state.activeProfileId = LS.get('smtp_active', null);
  saveProfiles(); // Remove passwords saved by older versions; keep only in page memory.
  renderProfiles();
}

function saveProfiles() {
  LS.set('smtp_profiles', state.profiles.map(({ password, ...profile }) => profile));
}

function getActiveProfile() {
  return state.profiles.find(p => p.id === state.activeProfileId) || null;
}

function renderProfiles() {
  const list = document.getElementById('profile-list');
  if (!state.profiles.length) {
    list.innerHTML = '<div class="profile-empty">尚無設定檔<br><small>點擊右上角 + 新增</small></div>';
    return;
  }

  list.innerHTML = state.profiles.map(p => `
    <div class="profile-card ${p.id === state.activeProfileId ? 'active' : ''}"
         data-id="${esc(p.id)}" role="button" tabindex="0">
      <div class="profile-dot"></div>
      <div class="profile-info">
        <div class="profile-name">${esc(p.name)}</div>
        <div class="profile-addr">${esc(p.username)}</div>
      </div>
      <div class="profile-actions">
        <button class="profile-act-btn" data-action="edit" data-id="${esc(p.id)}" title="編輯">✏️</button>
        <button class="profile-act-btn del" data-action="del" data-id="${esc(p.id)}" title="刪除">🗑</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.profile-card').forEach(card => {
    card.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (btn) return; // handled below
      setActiveProfile(card.dataset.id);
    });
    card.addEventListener('keydown', e => { if (e.key === 'Enter') setActiveProfile(card.dataset.id); });
  });

  list.querySelectorAll('[data-action="edit"]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openEditProfile(btn.dataset.id); });
  });

  list.querySelectorAll('[data-action="del"]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (confirm(`刪除設定檔「${state.profiles.find(p => p.id === btn.dataset.id)?.name}」？`)) {
        deleteProfile(btn.dataset.id);
      }
    });
  });
}

function setActiveProfile(id) {
  state.activeProfileId = id;
  LS.set('smtp_active', id);
  renderProfiles();
}

function deleteProfile(id) {
  state.profiles = state.profiles.filter(p => p.id !== id);
  if (state.activeProfileId === id) {
    state.activeProfileId = state.profiles[0]?.id || null;
    LS.set('smtp_active', state.activeProfileId);
  }
  saveProfiles();
  renderProfiles();
}

// ── Profile modal ──────────────────────────────
document.getElementById('add-profile-btn').addEventListener('click', () => openNewProfile());

function openNewProfile() {
  document.getElementById('profile-modal-title').textContent = '新增 SMTP 設定檔';
  document.getElementById('profile-edit-id').value = '';
  ['pf-name','pf-host','pf-username','pf-password','pf-from-name','pf-from-email'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('pf-port').value = '587';
  document.getElementById('pf-secure').checked = false;
  hideTestResult();
  openModal('profile-modal');
}

function openEditProfile(id) {
  const p = state.profiles.find(x => x.id === id);
  if (!p) return;
  document.getElementById('profile-modal-title').textContent = '編輯 SMTP 設定檔';
  document.getElementById('profile-edit-id').value = id;
  document.getElementById('pf-name').value = p.name || '';
  document.getElementById('pf-host').value = p.host || '';
  document.getElementById('pf-port').value = p.port || 587;
  document.getElementById('pf-secure').checked = !!p.secure;
  document.getElementById('pf-username').value = p.username || '';
  document.getElementById('pf-password').value = p.password || '';
  document.getElementById('pf-from-name').value = p.fromName || '';
  document.getElementById('pf-from-email').value = p.fromEmail || '';
  hideTestResult();
  openModal('profile-modal');
}

function getProfileFormData() {
  return {
    name: document.getElementById('pf-name').value.trim(),
    host: document.getElementById('pf-host').value.trim(),
    port: parseInt(document.getElementById('pf-port').value) || 587,
    secure: document.getElementById('pf-secure').checked,
    username: document.getElementById('pf-username').value.trim(),
    password: document.getElementById('pf-password').value,
    fromName: document.getElementById('pf-from-name').value.trim(),
    fromEmail: document.getElementById('pf-from-email').value.trim(),
  };
}

document.getElementById('profile-save-btn').addEventListener('click', () => {
  const data = getProfileFormData();
  if (!data.name || !data.host || !data.username || !data.password) {
    toast('請填寫必填欄位（名稱、主機、帳號、密碼）', 'error');
    return;
  }
  const editId = document.getElementById('profile-edit-id').value;
  if (editId) {
    const idx = state.profiles.findIndex(p => p.id === editId);
    if (idx !== -1) state.profiles[idx] = { ...state.profiles[idx], ...data };
  } else {
    const p = { id: uid(), ...data };
    state.profiles.push(p);
    state.activeProfileId = p.id;
    LS.set('smtp_active', p.id);
  }
  saveProfiles();
  renderProfiles();
  closeModal('profile-modal');
  toast('設定檔已儲存', 'success');
});

document.getElementById('test-smtp-btn').addEventListener('click', async () => {
  const data = getProfileFormData();
  if (!data.host || !data.username || !data.password) {
    toast('請先填寫主機、帳號和密碼', 'error');
    return;
  }
  const btn = document.getElementById('test-smtp-btn');
  btn.textContent = '測試中…';
  btn.disabled = true;
  hideTestResult();
  try {
    const res = await fetch('/api/verify-smtp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-SMTP-Sender': '1' },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    showTestResult(json.ok, json.ok ? '✓ ' + json.message : '✕ ' + json.error);
  } catch (err) {
    showTestResult(false, '✕ 網路錯誤：' + err.message);
  } finally {
    btn.textContent = '🔌 測試連線';
    btn.disabled = false;
  }
});

function showTestResult(ok, msg) {
  const el = document.getElementById('smtp-test-result');
  el.className = 'test-result ' + (ok ? 'ok' : 'err');
  el.textContent = msg;
  el.style.display = 'block';
}
function hideTestResult() {
  document.getElementById('smtp-test-result').style.display = 'none';
}

// ══════════════════════════════════════════════
//   QUILL EDITOR
// ══════════════════════════════════════════════

function initEditor() {
  quill = new Quill('#editor', {
    theme: 'snow',
    placeholder: '在此輸入信件內容…\n使用 {{name}}、{{company}} 等佔位符，對應 CSV 欄位名稱',
    modules: {
      toolbar: [
        ['bold', 'italic', 'underline', 'strike'],
        [{ header: [1, 2, 3, false] }],
        [{ size: ['small', false, 'large', 'huge'] }],
        [{ color: [] }, { background: [] }],
        [{ font: [] }],
        [{ align: [] }],
        [{ list: 'ordered' }, { list: 'bullet' }],
        ['link', 'blockquote'],
        ['clean'],
      ],
    },
  });

  setEditorMode('rich', { sync: false });
}

function getHtmlSourceEditor() {
  return document.getElementById('html-source-editor');
}

function isHtmlMode() {
  return state.editorMode === 'html';
}

function setEditorMode(mode, opts = {}) {
  const nextMode = mode === 'html' ? 'html' : 'rich';
  const { sync = true, html = null } = opts;
  const wrap = document.getElementById('editor-wrap');
  const source = getHtmlSourceEditor();
  const richBtn = document.getElementById('mode-rich-btn');
  const htmlBtn = document.getElementById('mode-html-btn');

  if (sync && state.editorMode !== nextMode) {
    if (nextMode === 'html') {
      source.value = currentEditableHtml({ normalize: false });
    } else {
      quill.clipboard.dangerouslyPasteHTML(sanitizeEmailHtml(source.value), 'api');
    }
  }

  if (html !== null) source.value = html;

  state.editorMode = nextMode;
  wrap.classList.toggle('html-mode', nextMode === 'html');
  richBtn.classList.toggle('active', nextMode === 'rich');
  htmlBtn.classList.toggle('active', nextMode === 'html');
}

function loadHtmlSource(html) {
  setEditorMode('html', { sync: false, html: html || '' });
}

function loadRichHtml(html) {
  setEditorMode('rich', { sync: false });
  getHtmlSourceEditor().value = '';
  quill.clipboard.dangerouslyPasteHTML(sanitizeEmailHtml(html || ''), 'api');
}

function currentEditableHtml({ normalize = false } = {}) {
  const html = isHtmlMode()
    ? getHtmlSourceEditor().value
    : quill.getSemanticHTML();
  return normalize && !isHtmlMode() ? prepareHtmlForEmail(html) : html;
}

document.getElementById('mode-rich-btn').addEventListener('click', () => {
  if (isHtmlMode() &&
      !confirm('切回視覺編輯會讓 Quill 重新解析 HTML，複雜表格版型可能被簡化。確定切換？')) {
    return;
  }
  setEditorMode('rich');
});

document.getElementById('mode-html-btn').addEventListener('click', () => {
  setEditorMode('html');
});

// ══════════════════════════════════════════════
//   RECIPIENTS / CSV
// ══════════════════════════════════════════════

document.getElementById('csv-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast('CSV 檔案不可超過 5 MB', 'error'); e.target.value = ''; return; }
  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header, index) => index === 0 ? header.trim().toLowerCase() : header.trim(),
    complete: result => {
      if (result.errors.length) { toast('CSV 格式錯誤，請檢查欄位數與引號', 'error'); return; }
      if (result.data.length > 500) { toast('每批最多 500 位收件人', 'error'); return; }
      if (!result.data.length) { toast('CSV 檔案是空的', 'error'); return; }
      const headers = result.meta.fields || [];
      if (!headers[0] || headers[0].toLowerCase() !== 'email') {
        toast('CSV 第一欄必須是 "email"', 'error');
        return;
      }
      if (headers.length > 50 || headers.some(h => !h || ['__proto__', 'constructor', 'prototype'].includes(h))) {
        toast('CSV 欄位名稱不正確或超過 50 欄', 'error'); return;
      }
      state.csvHeaders = headers;
      state.recipients = result.data.map(row => {
        const r = Object.create(null);
        headers.forEach(h => { r[h] = row[h] || ''; });
        return r;
      });
      renderRecipientsTable();
      toast(`已匯入 ${state.recipients.length} 位收件人`, 'success');
    },
    error: err => toast('CSV 解析失敗：' + err.message, 'error'),
  });
  e.target.value = '';
});

document.getElementById('add-row-btn').addEventListener('click', () => {
  if (state.recipients.length >= 500) { toast('每批最多 500 位收件人', 'error'); return; }
  const row = Object.create(null);
  state.csvHeaders.forEach(h => { row[h] = ''; });
  state.recipients.push(row);
  renderRecipientsTable();
});

document.getElementById('clear-recipients-btn').addEventListener('click', () => {
  if (state.recipients.length && !confirm('確定清除所有收件人？')) return;
  state.recipients = [];
  state.csvHeaders = ['email'];
  renderRecipientsTable();
});

function renderRecipientsTable() {
  const head = document.getElementById('table-head');
  const body = document.getElementById('table-body');
  const count = document.getElementById('recipient-count');
  const sendCount = document.getElementById('send-count');

  count.textContent = state.recipients.length;
  sendCount.textContent = state.recipients.length;

  // Build header
  head.innerHTML = '<tr>' +
    state.csvHeaders.map(h => `<th>${esc(h)}</th>`).join('') +
    '<th class="col-action"></th></tr>';

  if (!state.recipients.length) {
    body.innerHTML = '<tr class="table-empty-row"><td colspan="99">尚無收件人</td></tr>';
    return;
  }

  body.innerHTML = state.recipients.map((r, i) =>
    `<tr>
      ${state.csvHeaders.map(h =>
        `<td><input class="td-input" data-row="${i}" data-col="${esc(h)}" value="${esc(r[h] || '')}" /></td>`
      ).join('')}
      <td><button class="row-del" data-row="${i}">✕</button></td>
    </tr>`
  ).join('');

  body.querySelectorAll('.td-input').forEach(input => {
    input.addEventListener('change', e => {
      const { row, col } = e.target.dataset;
      state.recipients[+row][col] = e.target.value;
    });
  });

  body.querySelectorAll('.row-del').forEach(btn => {
    btn.addEventListener('click', () => {
      state.recipients.splice(+btn.dataset.row, 1);
      renderRecipientsTable();
    });
  });
}

// ══════════════════════════════════════════════
//   PREVIEW
// ══════════════════════════════════════════════

document.getElementById('preview-btn').addEventListener('click', () => {
  if (!quill) return;
  const profile = getActiveProfile();
  const subject = document.getElementById('subject').value;

  const select = document.getElementById('preview-select');
  select.innerHTML = '';

  const samples = state.recipients.length
    ? state.recipients
    : [{ email: 'preview@example.com', name: '範例姓名' }];

  samples.forEach((r, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = r.email || `收件人 ${i + 1}`;
    select.appendChild(opt);
  });

  const normalizedHtml = currentBodyHtml();
  const ccRaw = document.getElementById('cc').value.trim();
  const bccRaw = document.getElementById('bcc').value.trim();

  const updatePreview = () => {
    const r = samples[+select.value] || samples[0];
    document.getElementById('pv-from').textContent =
      profile ? `${profile.fromName || ''} <${profile.fromEmail || profile.username}>` : '（未選擇設定檔）';
    document.getElementById('pv-to').textContent = r.email || '';
    const ccRow = document.getElementById('pv-cc-row');
    const bccRow = document.getElementById('pv-bcc-row');
    if (ccRaw) { ccRow.style.display = ''; document.getElementById('pv-cc').textContent = applyTemplate(ccRaw, r); }
    else ccRow.style.display = 'none';
    if (bccRaw) { bccRow.style.display = ''; document.getElementById('pv-bcc').textContent = applyTemplate(bccRaw, r); }
    else bccRow.style.display = 'none';
    document.getElementById('pv-subject').textContent = applyTemplate(subject, r);
    const frame = document.getElementById('preview-frame');
    frame.srcdoc = previewDocument(renderEmailHtml(normalizedHtml, r));
  };

  updatePreview();
  select.onchange = updatePreview;
  openModal('preview-modal');
});

// ══════════════════════════════════════════════
//   SEND
// ══════════════════════════════════════════════

document.getElementById('send-btn').addEventListener('click', () => {
  if (!state.recipients.length) { toast('請先新增收件人', 'error'); return; }
  const profile = getActiveProfile();
  if (!profile) { toast('請先選擇 SMTP 設定檔', 'error'); return; }
  if (!profile.password) { openEditProfile(profile.id); toast('請重新輸入 SMTP 密碼；密碼僅保留於本次頁面', 'info'); return; }
  const subject = document.getElementById('subject').value.trim();
  if (!subject) { toast('請填寫信件主旨', 'error'); return; }

  const html = currentBodyHtml();
  const delay = parseInt(document.getElementById('send-delay').value) || 0;
  const replyToRaw = document.getElementById('reply-to').value.trim();
  const ccRaw = document.getElementById('cc').value.trim();
  const bccRaw = document.getElementById('bcc').value.trim();

  const emails = state.recipients.map(r => ({
    to: r.email,
    subject: applyTemplate(subject, r),
    html: renderEmailHtml(html, r),
    replyTo: replyToRaw ? applyTemplate(replyToRaw, r) : undefined,
    cc: ccRaw ? applyTemplate(ccRaw, r) : undefined,
    bcc: bccRaw ? applyTemplate(bccRaw, r) : undefined,
  }));

  startSend(profile, emails, delay);
});

let abortSend = false;

async function startSend(profile, emails, delay) {
  abortSend = false;
  const total = emails.length;
  let done = 0;
  let interrupted = false;
  const controller = new AbortController();
  document.getElementById('send-btn').disabled = true;

  document.getElementById('send-modal-title').textContent = `寄送中… 0 / ${total}`;
  document.getElementById('progress-fill').style.width = '0%';
  document.getElementById('progress-text').textContent = '準備中…';
  document.getElementById('send-log').innerHTML = '';
  document.getElementById('send-done-btn').disabled = true;
  document.getElementById('send-abort-btn').disabled = false;
  openModal('send-modal');

  const sessionResults = { ts: Date.now(), subject: document.getElementById('subject').value, rows: [] };

  document.getElementById('send-abort-btn').onclick = () => { abortSend = true; controller.abort(); };

  try {
    const res = await fetch('/api/send', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-SMTP-Sender': '1' },
      body: JSON.stringify({ smtp: profile, emails, delay }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || '發送失敗');
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      if (abortSend) { await reader.cancel(); break; }
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;

      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line);
          done++;
          sessionResults.rows.push(item);
          const pct = Math.round((done / total) * 100);
          document.getElementById('progress-fill').style.width = pct + '%';
          document.getElementById('progress-text').textContent = `${done} / ${total}`;
          document.getElementById('send-modal-title').textContent = `寄送中… ${done} / ${total}`;
          appendLogRow(item);
        } catch {}
      }
    }
    if (!abortSend && done !== total) throw new Error('寄送連線提前結束，未回報的信件狀態不明，請先確認後再重試');
  } catch (err) {
    interrupted = true;
    if (!abortSend) toast('寄送未完成：' + err.message, 'error', 6000);
  } finally {
    document.getElementById('send-btn').disabled = false;
  }

  document.getElementById('send-done-btn').disabled = false;
  document.getElementById('send-abort-btn').disabled = true;
  document.getElementById('send-modal-title').textContent =
    abortSend ? '已中止（已送出的信件無法撤回）' : interrupted ? `寄送中斷 ${done} / ${total}` : `完成 ${done} / ${total}`;

  if (sessionResults.rows.length) {
    state.history.unshift(sessionResults);
    if (state.history.length > 100) state.history.length = 100;
    LS.set('send_history', state.history);
  }
}

function appendLogRow(item) {
  const log = document.getElementById('send-log');
  const row = document.createElement('div');
  row.className = `log-row ${item.status}`;
  row.innerHTML = `
    <div class="log-email">${esc(item.email)}</div>
    <div class="log-status">${item.status === 'sent' ? '✓ 已送出' : '✕ 失敗'}</div>
    ${item.error ? `<div class="log-err">${esc(item.error)}</div>` : ''}
  `;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

document.getElementById('send-done-btn').addEventListener('click', () => closeModal('send-modal'));

// ══════════════════════════════════════════════
//   HISTORY
// ══════════════════════════════════════════════

function renderHistory() {
  const list = document.getElementById('history-list');
  if (!state.history.length) {
    list.innerHTML = '<div class="empty-state">尚無寄送記錄</div>';
    return;
  }
  list.innerHTML = state.history.map((session, si) => {
    const sent = session.rows.filter(r => r.status === 'sent').length;
    const failed = session.rows.filter(r => r.status === 'failed').length;
    const date = new Date(session.ts).toLocaleString('zh-TW');
    return `
      <div class="history-session">
        <div class="history-session-header">
          <div>
            <strong>${esc(session.subject || '（無主旨）')}</strong>
            <span class="history-session-meta"> · ${date}</span>
          </div>
          <div style="display:flex;gap:8px;font-size:12px">
            <span style="color:var(--clr-success)">✓ ${sent}</span>
            ${failed ? `<span style="color:var(--clr-error)">✕ ${failed}</span>` : ''}
          </div>
        </div>
        <div class="history-rows">
          ${session.rows.map(r => `
            <div class="history-row">
              <div class="status-dot ${r.status === 'sent' ? 'sent' : 'failed'}"></div>
              <div class="history-email">${esc(r.email)}</div>
              ${r.error ? `<div class="history-err">${esc(r.error)}</div>` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }).join('');
}

document.getElementById('clear-history-btn').addEventListener('click', () => {
  if (!confirm('確定清除所有寄送記錄？')) return;
  state.history = [];
  LS.set('send_history', []);
  renderHistory();
});

// ══════════════════════════════════════════════
//   DRAFTS
// ══════════════════════════════════════════════

function loadDrafts() {
  state.drafts = LS.get('email_drafts', []);
  updateDraftCount();
}

function saveDrafts() {
  LS.set('email_drafts', state.drafts);
  updateDraftCount();
}

function updateDraftCount() {
  const n = state.drafts.length;
  const badge = document.getElementById('draft-count');
  badge.textContent = n;
  badge.style.display = n ? 'inline' : 'none';
}

function draftBodyHtml(draft) {
  const html = draft.html || '';
  const text = html.replace(/<[^>]*>/g, '').trim();
  if (!text && draft.templateHtml) return draft.templateHtml;
  return html || draft.templateHtml || '';
}

// Open save-draft modal
document.getElementById('save-draft-btn').addEventListener('click', () => {
  const subject = document.getElementById('subject').value.trim();
  const html = currentEditableHtml({ normalize: false });
  const replyTo = document.getElementById('reply-to').value.trim();

  if (!subject && !html.replace(/<[^>]*>/g, '').trim()) {
    toast('請先填寫主旨或信件內容再儲存', 'error');
    return;
  }

  const input = document.getElementById('draft-name-input');
  input.value = subject || state.templateName || '未命名草稿';

  const preview = document.getElementById('draft-save-preview');
  const bodyText = html.replace(/<[^>]*>/g, '').trim().slice(0, 80);
  preview.innerHTML =
    `<strong>主旨：</strong>${esc(subject || '（無）')}<br>` +
    `<strong>內容：</strong>${esc(bodyText || '（空）')}${bodyText.length >= 80 ? '…' : ''}`;

  openModal('save-draft-modal');
  setTimeout(() => { input.select(); }, 80);
});

document.getElementById('draft-save-confirm-btn').addEventListener('click', () => {
  const name = document.getElementById('draft-name-input').value.trim();
  if (!name) { toast('請輸入草稿名稱', 'error'); return; }

  const draft = {
    id: uid(),
    name,
    subject: document.getElementById('subject').value,
    replyTo: document.getElementById('reply-to').value,
    cc: document.getElementById('cc').value,
    bcc: document.getElementById('bcc').value,
    html: currentEditableHtml({ normalize: false }),
    editorMode: state.editorMode,
    templateName: state.templateName,
    savedAt: Date.now(),
  };

  state.drafts.unshift(draft);
  saveDrafts();
  renderDraftList();
  closeModal('save-draft-modal');
  toast(`草稿「${name}」已儲存`, 'success');
});

// Drafts dropdown toggle
const draftDropdown = document.getElementById('draft-dropdown');
document.getElementById('drafts-btn').addEventListener('click', e => {
  e.stopPropagation();
  draftDropdown.classList.toggle('open');
  if (draftDropdown.classList.contains('open')) renderDraftList();
});
document.addEventListener('click', e => {
  if (!document.getElementById('draft-dropdown-wrap').contains(e.target)) {
    draftDropdown.classList.remove('open');
  }
});

function renderDraftList() {
  const list = document.getElementById('draft-list');
  if (!state.drafts.length) {
    list.innerHTML = '<div class="draft-empty">尚無已儲存的草稿</div>';
    return;
  }
  list.innerHTML = state.drafts.map(d => {
    const date = d.savedAt
      ? new Date(d.savedAt).toLocaleString('zh-TW', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      })
      : '舊草稿';
    const draftHtml = draftBodyHtml(d);
    const bodyText = draftHtml.replace(/<[^>]*>/g, '').trim().slice(0, 40);
    return `
      <div class="draft-item">
        <div class="draft-item-info" data-id="${esc(d.id)}">
          <div class="draft-item-name">${esc(d.name)}</div>
          <div class="draft-item-meta">${date}${bodyText ? ' · ' + esc(bodyText) + '…' : ''}</div>
        </div>
        <div class="draft-item-actions">
          <button class="btn btn-sm btn-primary" data-load="${esc(d.id)}" title="載入此草稿">載入</button>
          <button class="btn btn-sm btn-ghost" data-del="${esc(d.id)}" title="刪除">✕</button>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('[data-load]').forEach(btn => {
    btn.addEventListener('click', () => loadDraft(btn.dataset.load));
  });
  list.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => deleteDraft(btn.dataset.del));
  });
  // Click on info area also loads
  list.querySelectorAll('.draft-item-info').forEach(el => {
    el.addEventListener('click', () => loadDraft(el.dataset.id));
  });
}

function loadDraft(id) {
  const d = state.drafts.find(x => x.id === id);
  if (!d) return;

  if (editorHasContent()) {
    if (!confirm(`載入草稿「${d.name}」將取代目前的內容，確定繼續？`)) return;
  }

  document.getElementById('subject').value = d.subject || '';
  document.getElementById('reply-to').value = d.replyTo || '';
  document.getElementById('cc').value = d.cc || '';
  document.getElementById('bcc').value = d.bcc || '';

  clearTemplate();
  if (d.editorMode === 'html' || d.templateHtml) {
    loadHtmlSource(draftBodyHtml(d));
  } else {
    loadRichHtml(draftBodyHtml(d));
  }
  if (d.templateName || d.templateHtml) showTemplateBanner(d.templateName || d.name);
  draftDropdown.classList.remove('open');
  toast(`已載入草稿「${d.name}」`, 'success');
}

function deleteDraft(id) {
  const d = state.drafts.find(x => x.id === id);
  if (!d || !confirm(`刪除草稿「${d.name}」？`)) return;
  state.drafts = state.drafts.filter(x => x.id !== id);
  saveDrafts();
  renderDraftList();
  toast('草稿已刪除', 'info');
}

// ══════════════════════════════════════════════
//   BUILT-IN TEMPLATES (presets)
// ══════════════════════════════════════════════
// Presets are loaded into the raw HTML editor so users can edit without losing
// table-based email layout. Quill's clipboard import does not preserve arbitrary HTML.

// Logo must be a PNG — Gmail/Outlook strip <img> SVG. COSCUP GitHub org avatar:
const LOGO_URL = 'https://github.com/COSCUP.png';

const TEMPLATES = [
  {
    id: 'coscup-volunteer',
    name: 'COSCUP 志工登錄完成通知',
    subject: '【COSCUP Volunteer】2026 志工登錄完成通知',
    replyTo: '',
    cc: '',
    bcc: '',
    // CSV columns this preset expects (besides email)
    columns: ['name', 'nickname', 'gender', 'phone', 'team', 'tshirt', 'diet', 'allergy', 'thanks', 'hours', 'accommodation', 'mattermost'],
    html: `<div style="max-width:580px;margin:0 auto;font-family:Arial,Helvetica,sans-serif">
  <div style="background-color:#57c257;padding:10px">
    <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background:#ffffff">
      <tr>
        <td style="padding:20px">
          <p style="text-align:right;margin:0 0 14px 0"><img width="80" src="${LOGO_URL}" alt="COSCUP" style="border:none;display:block;margin-left:auto;"></p>
          <p style="margin:0 0 10px;font-size:14px;color:#222;font-weight:700">親愛的 {{nickname}} 你好，</p>
          <p style="margin:0 0 20px;font-size:14px;color:#222;line-height:1.6">感謝你完成志工資料填寫！</p>

          <p style="font-size:13px;font-weight:700;color:#222;margin:0 0 8px;border-bottom:2px solid #57c257;padding-bottom:6px">你填寫的資料</p>
          <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:20px">
            <tr><td style="padding:6px 4px;border-bottom:1px solid #f0f7f0;font-size:12px;color:#5a7a5a;font-weight:600;width:36%">姓名</td><td style="padding:6px 4px;border-bottom:1px solid #f0f7f0;font-size:13px;color:#222">{{name}}</td></tr>
            <tr><td style="padding:6px 4px;border-bottom:1px solid #f0f7f0;font-size:12px;color:#5a7a5a;font-weight:600;width:36%">稱呼</td><td style="padding:6px 4px;border-bottom:1px solid #f0f7f0;font-size:13px;color:#222">{{nickname}}</td></tr>
            <tr><td style="padding:6px 4px;border-bottom:1px solid #f0f7f0;font-size:12px;color:#5a7a5a;font-weight:600;width:36%">性別</td><td style="padding:6px 4px;border-bottom:1px solid #f0f7f0;font-size:13px;color:#222">{{gender}}</td></tr>
            <tr><td style="padding:6px 4px;border-bottom:1px solid #f0f7f0;font-size:12px;color:#5a7a5a;font-weight:600;width:36%">手機</td><td style="padding:6px 4px;border-bottom:1px solid #f0f7f0;font-size:13px;color:#222">{{phone}}</td></tr>
            <tr><td style="padding:6px 4px;border-bottom:1px solid #f0f7f0;font-size:12px;color:#5a7a5a;font-weight:600;width:36%">組別</td><td style="padding:6px 4px;border-bottom:1px solid #f0f7f0;font-size:13px;color:#222">{{team}}</td></tr>
            <tr><td style="padding:6px 4px;border-bottom:1px solid #f0f7f0;font-size:12px;color:#5a7a5a;font-weight:600;width:36%">T恤尺寸</td><td style="padding:6px 4px;border-bottom:1px solid #f0f7f0;font-size:13px;color:#222">{{tshirt}}</td></tr>
            <tr><td style="padding:6px 4px;border-bottom:1px solid #f0f7f0;font-size:12px;color:#5a7a5a;font-weight:600;width:36%">飲食習慣</td><td style="padding:6px 4px;border-bottom:1px solid #f0f7f0;font-size:13px;color:#222">{{diet}}</td></tr>
            <tr><td style="padding:6px 4px;border-bottom:1px solid #f0f7f0;font-size:12px;color:#5a7a5a;font-weight:600;width:36%">過敏原</td><td style="padding:6px 4px;border-bottom:1px solid #f0f7f0;font-size:13px;color:#222">{{allergy}}</td></tr>
            <tr><td style="padding:6px 4px;border-bottom:1px solid #f0f7f0;font-size:12px;color:#5a7a5a;font-weight:600;width:36%">感謝狀</td><td style="padding:6px 4px;border-bottom:1px solid #f0f7f0;font-size:13px;color:#222">{{thanks}}</td></tr>
            <tr><td style="padding:6px 4px;border-bottom:1px solid #f0f7f0;font-size:12px;color:#5a7a5a;font-weight:600;width:36%">志工時數證明</td><td style="padding:6px 4px;border-bottom:1px solid #f0f7f0;font-size:13px;color:#222">{{hours}}</td></tr>
            <tr><td style="padding:6px 4px;font-size:12px;color:#5a7a5a;font-weight:600;width:36%">住宿</td><td style="padding:6px 4px;font-size:13px;color:#222">{{accommodation}}</td></tr>
          </table>

          <p style="font-size:13px;font-weight:700;color:#222;margin:0 0 8px;border-bottom:2px solid #57c257;padding-bottom:6px">加入團隊 Mattermost</p>
          <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:20px">
            <tr><td style="padding:10px 4px;font-size:13px;color:#333;line-height:1.7">點擊以下連結加入 COSCUP 志工 Mattermost 頻道吧！<br>
              <a href="{{mattermost}}" style="color:#3a7d38;font-weight:700">{{mattermost}}</a></td></tr>
          </table>

          <p style="font-size:13px;font-weight:700;color:#222;margin:0 0 8px;border-bottom:2px solid #57c257;padding-bottom:6px">日後如何修改資料？</p>
          <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:16px">
            <tr><td style="padding:6px 4px;border-bottom:1px solid #f0f7f0;font-size:13px;color:#333"><span style="display:inline-block;background:#57c257;color:#fff;font-family:'Courier New',monospace;font-size:10px;font-weight:700;padding:2px 6px;border-radius:2px;margin-right:6px">01</span>重新開啟填寫連結</td></tr>
            <tr><td style="padding:6px 4px;border-bottom:1px solid #f0f7f0;font-size:13px;color:#333"><span style="display:inline-block;background:#57c257;color:#fff;font-family:'Courier New',monospace;font-size:10px;font-weight:700;padding:2px 6px;border-radius:2px;margin-right:6px">02</span>輸入此 Email 取得新的驗證碼</td></tr>
            <tr><td style="padding:6px 4px;font-size:13px;color:#333"><span style="display:inline-block;background:#57c257;color:#fff;font-family:'Courier New',monospace;font-size:10px;font-weight:700;padding:2px 6px;border-radius:2px;margin-right:6px">03</span>驗證後即可修改任何欄位</td></tr>
          </table>
          <p style="margin:0;font-size:12px;color:#999999">如有任何問題，請聯繫製播組。</p>
        </td>
      </tr>
    </table>
    <div style="padding:10px 0;text-align:center">
      <p style="margin:0;color:#ffffff;font-size:12px">COSCUP 製播組 | Secretary Team</p>
    </div>
  </div>
</div>`,
  },
];

// ── Body source: current editor mode ──
function currentBodyHtml() {
  return currentEditableHtml({ normalize: true });
}

function editorHasContent() {
  if (!quill) return false;
  return !!currentEditableHtml({ normalize: false }).replace(/<[^>]*>/g, '').trim();
}

// ── Template dropdown ──────────────────────────
const templateDropdown = document.getElementById('template-dropdown');
document.getElementById('templates-btn').addEventListener('click', e => {
  e.stopPropagation();
  templateDropdown.classList.toggle('open');
  if (templateDropdown.classList.contains('open')) renderTemplateList();
});
document.addEventListener('click', e => {
  if (!document.getElementById('template-dropdown-wrap').contains(e.target)) {
    templateDropdown.classList.remove('open');
  }
});

function renderTemplateList() {
  const list = document.getElementById('template-list');
  if (!TEMPLATES.length) {
    list.innerHTML = '<div class="draft-empty">尚無內建範本</div>';
    return;
  }
  list.innerHTML = TEMPLATES.map(t => `
    <div class="draft-item">
      <div class="draft-item-info" data-id="${esc(t.id)}">
        <div class="draft-item-name">${esc(t.name)}</div>
        <div class="draft-item-meta">${esc(t.columns.length ? '欄位：' + t.columns.join(', ') : '無佔位符')}</div>
      </div>
      <div class="draft-item-actions">
        <button class="btn btn-sm btn-primary" data-apply="${esc(t.id)}" title="套用此範本">套用</button>
      </div>
    </div>`).join('');

  list.querySelectorAll('[data-apply]').forEach(btn => {
    btn.addEventListener('click', () => applyTemplatePreset(btn.dataset.apply));
  });
  list.querySelectorAll('.draft-item-info').forEach(el => {
    el.addEventListener('click', () => applyTemplatePreset(el.dataset.id));
  });
}

function applyTemplatePreset(id) {
  const t = TEMPLATES.find(x => x.id === id);
  if (!t) return;

  if (editorHasContent() &&
      !confirm(`套用範本「${t.name}」將覆蓋目前的主旨與內容，確定繼續？`)) {
    return;
  }

  document.getElementById('subject').value = t.subject || '';
  document.getElementById('reply-to').value = t.replyTo || '';
  document.getElementById('cc').value = t.cc || '';
  document.getElementById('bcc').value = t.bcc || '';

  clearTemplate();
  loadHtmlSource(t.html);
  showTemplateBanner(t.name);

  templateDropdown.classList.remove('open');
  toast(`已套用範本「${t.name}」`, 'success');
  if (t.columns.length) {
    toast(`請匯入含欄位的 CSV：email, ${t.columns.join(', ')}`, 'info', 6000);
  }
}

function showTemplateBanner(name) {
  state.templateName = name;
  document.getElementById('template-banner-name').textContent = name;
  document.getElementById('template-banner').style.display = 'flex';
}

function clearTemplate() {
  state.templateName = '';
  document.getElementById('template-banner').style.display = 'none';
}

document.getElementById('template-clear-btn').addEventListener('click', () => {
  clearTemplate();
  toast('已清除範本標記，HTML 內容仍保留', 'info');
});

// ══════════════════════════════════════════════
//   AI PANEL
// ══════════════════════════════════════════════

const aiPanel = document.getElementById('ai-panel');

document.getElementById('ai-toggle-btn').addEventListener('click', () => {
  aiPanel.classList.toggle('open');
  document.getElementById('ai-toggle-btn').classList.toggle('active', aiPanel.classList.contains('open'));
});
document.getElementById('ai-close-btn').addEventListener('click', () => {
  aiPanel.classList.remove('open');
  document.getElementById('ai-toggle-btn').classList.remove('active');
});

// Load saved API key & model
(function initAiSettings() {
  const key = LS.get('or_api_key', '');
  localStorage.removeItem('or_api_key');
  const model = LS.get('or_model', 'anthropic/claude-3.5-haiku');
  if (key) document.getElementById('or-api-key').value = key;
  const sel = document.getElementById('ai-model');
  if (model && [...sel.options].some(o => o.value === model)) sel.value = model;
})();

document.getElementById('save-api-key-btn').addEventListener('click', () => {
  document.getElementById('or-api-key').value = '';
  localStorage.removeItem('or_api_key');
  toast('API Key 已清除', 'success');
});

document.getElementById('ai-model').addEventListener('change', () => {
  LS.set('or_model', document.getElementById('ai-model').value);
});

// ── Generate ───────────────────────────────────
document.getElementById('ai-generate-btn').addEventListener('click', generateWithAI);

async function generateWithAI() {
  const apiKey = document.getElementById('or-api-key').value.trim();
  const model = document.getElementById('ai-model').value;
  const prompt = document.getElementById('ai-prompt').value.trim();
  const tone = document.getElementById('ai-tone').value;
  const lang = document.getElementById('ai-lang').value;

  if (!apiKey) { toast('請輸入 OpenRouter API Key', 'error'); return; }
  if (!prompt) { toast('請描述你想要的信件內容', 'error'); return; }

  const toneLabel = { professional:'專業', friendly:'友好親切', formal:'正式', casual:'輕鬆', persuasive:'說服力強' }[tone] || tone;
  const langLabel = { 'zh-TW':'繁體中文', 'zh-CN':'簡體中文', en:'English', ja:'日本語', ko:'한국어' }[lang] || lang;

  const systemMsg = `你是一位專業的電子郵件寫作助理。
根據用戶的描述，生成高品質的 HTML 電子郵件正文。

嚴格規則：
1. 使用內聯 CSS (inline styles) 設定所有樣式，確保在各郵件客戶端正確顯示
2. 只返回郵件正文 HTML，不包含 <!DOCTYPE>、<html>、<head>、<body> 標籤
3. 使用合適的 HTML 結構：<h1>、<h2>、<p>、<ul>、<li>、<a>、<div>、<table>、<strong>、<em>
4. 語氣：${toneLabel}
5. 語言：${langLabel}
6. 保留用戶在描述中提到的 {{佔位符}}，如 {{name}}、{{company}} 等，不要替換它們
7. 設計要美觀且適合商業郵件，使用柔和的顏色搭配
8. 字體使用 font-family: -apple-system, system-ui, 'Segoe UI', sans-serif
9. 最外層使用 <div style="max-width:600px;margin:0 auto;..."> 包裹
10. 如需分隔線，使用 <hr style="border:none;border-top:1px solid #e2e8f0;">
11. 按鈕/CTA 使用 <a href="#"> 加上按鈕樣式
12. 結尾包含問候語`;

  const outputWrap = document.getElementById('ai-output-wrap');
  const outputCode = document.getElementById('ai-output-code');
  const generateBtn = document.getElementById('ai-generate-btn');

  outputWrap.style.display = 'block';
  outputCode.innerHTML = '<div class="ai-loading"><div class="spinner"></div><span>生成中…</span></div>';
  generateBtn.disabled = true;
  state.aiHtml = '';
  state.aiPreviewMode = false;
  document.getElementById('ai-output-preview').style.display = 'none';
  document.getElementById('ai-output-code').style.display = 'block';
  document.getElementById('ai-preview-toggle').textContent = 'HTML 預覽';

  let fullText = '';
  let started = false;
  let completed = false;

  try {
    const res = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-SMTP-Sender': '1' },
      body: JSON.stringify({
        apiKey,
        model,
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
      throw new Error(typeof err.error === 'string' ? err.error : err.error?.message || 'AI 服務發生錯誤');
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') { completed = true; continue; }
        try {
          const json = JSON.parse(raw);
          const chunk = json.choices?.[0]?.delta?.content || '';
          if (chunk) {
            if (!started) { outputCode.textContent = ''; started = true; }
            fullText += chunk;
            outputCode.textContent = fullText;
            outputCode.scrollTop = outputCode.scrollHeight;
          }
        } catch {}
      }
    }

    if (!completed) throw new Error('AI 連線提前結束，請重新生成');
    state.aiHtml = sanitizeEmailHtml(fullText);
    if (!fullText) throw new Error('AI 沒有返回內容');

  } catch (err) {
    outputCode.innerHTML = `<div style="color:var(--clr-error);padding:8px">生成失敗：${esc(err.message)}</div>`;
  } finally {
    generateBtn.disabled = false;
  }
}

document.getElementById('ai-preview-toggle').addEventListener('click', () => {
  state.aiPreviewMode = !state.aiPreviewMode;
  const code = document.getElementById('ai-output-code');
  const preview = document.getElementById('ai-output-preview');
  const btn = document.getElementById('ai-preview-toggle');

  if (state.aiPreviewMode && state.aiHtml) {
    code.style.display = 'none';
    preview.style.display = 'block';
    preview.srcdoc = previewDocument(state.aiHtml);
    btn.textContent = '查看代碼';
  } else {
    code.style.display = 'block';
    preview.style.display = 'none';
    btn.textContent = 'HTML 預覽';
  }
});

document.getElementById('ai-insert-btn').addEventListener('click', () => {
  if (!state.aiHtml) { toast('沒有可插入的內容', 'error'); return; }
  if (isHtmlMode()) {
    const source = getHtmlSourceEditor();
    const start = source.selectionStart ?? source.value.length;
    const end = source.selectionEnd ?? source.value.length;
    source.value = source.value.slice(0, start) + state.aiHtml + source.value.slice(end);
    const nextPos = start + state.aiHtml.length;
    source.setSelectionRange(nextPos, nextPos);
    source.focus();
    toast('已插入 HTML 原始碼', 'success');
    return;
  }
  const range = quill.getSelection(true) || { index: quill.getLength(), length: 0 };
  quill.clipboard.dangerouslyPasteHTML(range.index, sanitizeEmailHtml(state.aiHtml), 'user');
  toast('已插入編輯器', 'success');
});

document.getElementById('ai-replace-btn').addEventListener('click', () => {
  if (!state.aiHtml) { toast('沒有可插入的內容', 'error'); return; }
  if (isHtmlMode()) {
    getHtmlSourceEditor().value = state.aiHtml;
    toast('已取代 HTML 原始碼', 'success');
    return;
  }
  quill.clipboard.dangerouslyPasteHTML(sanitizeEmailHtml(state.aiHtml), 'user');
  toast('已取代編輯器內容', 'success');
});

// ══════════════════════════════════════════════
//   UTILITIES
// ══════════════════════════════════════════════

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ══════════════════════════════════════════════
//   INIT
// ══════════════════════════════════════════════

function init() {
  initEditor();
  loadProfiles();
  loadDrafts();
  state.history = LS.get('send_history', []);
  renderRecipientsTable();
}

init();
