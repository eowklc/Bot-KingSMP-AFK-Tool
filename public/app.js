'use strict';
(() => {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
  const socket = typeof io === 'function' ? io() : null;

  const pages = {
    accounts: { title: 'Tài khoản', description: 'Quản lý bot.' },
    logs: { title: 'Log', description: 'Log chung và riêng.' },
    'bot-vision': { title: 'Bot Vision', description: 'Xem góc nhìn của bot.' },
    proxy: { title: 'API Proxy', description: 'Kiểm tra proxy và IP public.' }
  };

  let logEntries = [];
  const logEntriesByAcc = new Map();
  let accounts = [];
  let activeLogAccountId = '*';
  let selectedVisionAcc = null;
  let collapsedCards = loadStateMap('kingsmp-card-collapsed');
  let maximizedCards = loadStateMap('kingsmp-card-maximized');

  function loadStateMap(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (_) { return {}; }
  }
  function saveStateMap(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }

  function showToast(message, type = 'info', duration = 3600) {
    const stack = $('#toast-stack');
    if (!stack) return;
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = String(message || '');
    stack.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(12px)';
      setTimeout(() => toast.remove(), 220);
    }, duration);
  }

  function setTheme(dark) {
    document.body.classList.toggle('dark-mode', dark);
    const icon = $('#theme-icon');
    if (icon) icon.textContent = dark ? '☀' : '☾';
    const btn = $('#theme-toggle');
    if (btn) btn.setAttribute('aria-label', dark ? 'Chuyển giao diện sáng' : 'Chuyển giao diện tối');
    try { localStorage.setItem('kingsmp-theme', dark ? 'dark' : 'light'); } catch (_) {}
  }

  function initTheme() {
    let saved = 'light';
    try { saved = localStorage.getItem('kingsmp-theme') || 'light'; } catch (_) {}
    setTheme(saved === 'dark');
    const btn = $('#theme-toggle');
    if (btn) btn.addEventListener('click', () => setTheme(!document.body.classList.contains('dark-mode')));
  }

  function setActivePage(page) {
    if (!pages[page]) return;
    $$('[data-page-view]').forEach(v => v.classList.toggle('active', v.dataset.pageView === page));
    $$('[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === page));
    const title = $('#page-title');
    const crumb = $('#page-breadcrumb');
    const desc = $('#page-description');
    if (title) title.textContent = pages[page].title;
    if (crumb) crumb.textContent = pages[page].title;
    if (desc) desc.textContent = pages[page].description;
    document.dispatchEvent(new CustomEvent('kingsmp:page', { detail: { page } }));
  }

  function initNavigation() {
    $$('[data-page]').forEach(b => b.addEventListener('click', () => setActivePage(b.dataset.page)));
    const col = $('#sidebar-collapse');
    if (col) col.addEventListener('click', () => {
      const isCollapsed = document.body.classList.toggle('sidebar-collapsed');
      col.setAttribute('aria-expanded', String(!isCollapsed));
      col.title = isCollapsed ? 'Mở rộng thanh bên' : 'Thu gọn thanh bên';
      col.textContent = isCollapsed ? '»' : '☰';
    });
  }

  function normalizeKnownNotification(input) {
    let message = String(input || '');
    message = message
      .replace(/\[\s*bi\s+kick\s*\]/ig, '[Bị kick]')
      .replace(/\[\s*loi\s+bot\s*\]/ig, '[Lỗi bot]')
      .replace(/\bkingmc\s+dang\s+bao\s+tri\b/ig, 'KingMC đang bảo trì')
      .replace(/\bloi\s+mang\s+noi\s+bo\b/ig, 'lỗi mạng nội bộ')
      .replace(/\bbot\s+da\s+spawn\b/ig, 'Bot đã spawn')
      .replace(/\bda\s+gui\s+login\b/ig, 'đã gửi login')
      .replace(/\bmenu\s+mo\s+click\s+slot\s*(\d+)/ig, 'Menu mở · click slot $1')
      .replace(/\[\s*ngat\s+ket\s+noi\s*\]/ig, '[ Ngắt kết nối ]')
      .replace(/\bda\s+click\s+slot\s*(\d+)/ig, 'Đã click slot $1');
    if (/Parse error for play\.toClient|array size is abnormally large|PartialReadError|Unexpected buffer end while reading VarInt/i.test(message)) {
      return '[Lỗi giao thức] Không đọc được packet Minecraft. Cần kiểm tra phiên bản Mineflayer/protocol hoặc proxy.';
    }
    return message;
  }

  function isProtocolStackNoise(message) {
    return /^(?:\s*at\s+(?:Object\.)?(?:byteArray|nbtSwitch|anonymousNbt|SlotComponent|readVarInt|string|eval|Object\.)|\s*field:\s*['\"]play\.toClient|\s*PartialReadError:|\s*Read error for undefined\s*:|\s*Error: Read error for undefined\s*:|\s*\^|\s*\})/i.test(String(message || '')) ||
      /protodef\/src\/compiler\.js|node_modules\/protodef|<anonymous>:\d+:\d+|Unexpected buffer end while reading VarInt/i.test(String(message || ''));
  }

  function normalizeLog(entry) {
    const rawMessage = String(entry && entry.message ? entry.message : '');
    if (!rawMessage.trim() || isProtocolStackNoise(rawMessage)) return null;
    const message = normalizeKnownNotification(rawMessage);
    const username = String(entry.username || '');
    const id = String(entry.id || (accounts.find(a => a.username === username) || {}).id || 'unknown');
    const type = entry.type === 'chat' ? 'chat' : entry.type === 'error' || /^\[Lỗi giao thức\]/i.test(message) || /\[\s*Bị kick\s*\]|KingMC đang bảo trì|Lỗi mạng nội bộ|Ngắt kết nối/i.test(message) ? 'error' : entry.type === 'command' ? 'command' : 'system';
    return {
      id, message, type, username,
      segments: entry.segments,
      time: new Date(entry.time || Date.now()).toLocaleTimeString('vi-VN', { hour12: false }),
      timestamp: Number(entry.time || Date.now())
    };
  }

  const MC_COLORS = {
    black:'#000000', dark_blue:'#0000aa', dark_green:'#00aa00', dark_aqua:'#00aaaa', dark_red:'#aa0000', dark_purple:'#aa00aa', gold:'#ffaa00', gray:'#aaaaaa', dark_gray:'#555555', blue:'#5555ff', green:'#55ff55', aqua:'#55ffff', red:'#ff5555', light_purple:'#ff55ff', yellow:'#ffff55', white:'#ffffff', reset:''
  };
  function mcRaw(value) {
    if (!value || typeof value !== 'object' || !('type' in value) || !('value' in value)) return value;
    if (value.type === 'compound') return value.value;
    if (value.type === 'list') {
      const v = value.value;
      if (v && typeof v === 'object' && v.type === 'compound' && Array.isArray(v.value)) return v.value;
      if (Array.isArray(v)) return v;
      if (v && Array.isArray(v.value)) return v.value;
      return v;
    }
    return value.value;
  }
  function mcScalar(value) {
    let current = value;
    for (let i = 0; i < 5 && current && typeof current === 'object' && 'type' in current && 'value' in current; i++) {
      if (current.type === 'compound' || current.type === 'list') break;
      current = current.value;
    }
    return current;
  }
  function mcBool(value) { return !!mcScalar(value); }
  function appendStyledText(container, text, style) {
    if (text === undefined || text === null || text === '') return;
    const span = document.createElement('span');
    span.textContent = String(text);
    if (style.color && MC_COLORS[style.color]) span.style.color = MC_COLORS[style.color];
    else if (style.color && /^#[0-9a-f]{6}$/i.test(style.color)) span.style.color = style.color;
    if (style.bold) span.style.fontWeight = '700';
    if (style.italic) span.style.fontStyle = 'italic';
    const decorations = [];
    if (style.underlined) decorations.push('underline');
    if (style.strikethrough) decorations.push('line-through');
    if (decorations.length) span.style.textDecoration = decorations.join(' ');
    container.appendChild(span);
  }
  function renderMinecraftComponent(container, node, inherited = {}) {
    if (node === undefined || node === null) return;
    if (typeof node === 'string' || typeof node === 'number') { appendStyledText(container, node, inherited); return; }
    if (Array.isArray(node)) { node.forEach(child => renderMinecraftComponent(container, child, inherited)); return; }
    const obj = mcRaw(node);
    if (!obj || typeof obj !== 'object') { appendStyledText(container, mcScalar(obj), inherited); return; }
    const style = Object.assign({}, inherited);
    const color = mcScalar(obj.color);
    if (typeof color === 'string') style.color = color;
    for (const key of ['bold', 'italic', 'underlined', 'strikethrough']) {
      if (obj[key] !== undefined) style[key] = mcBool(obj[key]);
    }
    const text = mcScalar(obj.text);
    const translate = mcScalar(obj.translate);
    if (text !== undefined) appendStyledText(container, text, style);
    else if (translate) appendStyledText(container, String(translate), style);
    const extra = mcRaw(obj.extra);
    if (Array.isArray(extra)) extra.forEach(child => renderMinecraftComponent(container, child, style));
    else if (extra && typeof extra === 'object') renderMinecraftComponent(container, extra, style);
    const withNode = mcRaw(obj.with);
    if (Array.isArray(withNode)) withNode.forEach(child => renderMinecraftComponent(container, child, style));
  }
  function appendFormattedMessage(container, rawMessage) {
    const message = normalizeKnownNotification(rawMessage);
    const jsonStart = message.indexOf('{');
    if (jsonStart < 0) {
      if (/KingMC đang bảo trì/i.test(message)) appendStyledText(container, message, { color: 'yellow', bold: true });
      else if (/lỗi mạng nội bộ|bị kick|ngắt kết nối|lỗi giao thức/i.test(message)) appendStyledText(container, message, { color: 'red', bold: true });
      else container.textContent = message;
      return;
    }
    const prefix = message.slice(0, jsonStart);
    let component;
    try { component = JSON.parse(message.slice(jsonStart)); }
    catch (_) { container.textContent = message; return; }
    if (prefix) appendStyledText(container, prefix, /bị kick/i.test(prefix) ? { color: 'red', bold: true } : {});
    renderMinecraftComponent(container, component, {});
  }

  function addLog(entry) {
    const line = normalizeLog(entry);
    if (!line) return;
    logEntries.push(line);
    if (logEntries.length > 4000) logEntries = logEntries.slice(-4000);
    if (!logEntriesByAcc.has(line.id)) logEntriesByAcc.set(line.id, []);
    const botLines = logEntriesByAcc.get(line.id);
    botLines.push(line);
    if (botLines.length > 1800) botLines.splice(0, botLines.length - 1800);
    renderLogs();
    document.dispatchEvent(new CustomEvent('kingsmp:bot-log', { detail: line }));
  }

function makeLogRow(line) {
  const row = document.createElement('div');
  row.className = 'log-line ' + line.type;
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = line.time;
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = line.username ? '[' + line.username + ']' : '';
  const msg = document.createElement('span');
  msg.className = 'log-message';
  
  // Ưu tiên render bằng segments có sẵn màu sắc từ botManager, nếu không có mới dùng appendFormattedMessage
  if (Array.isArray(line.segments) && line.segments.length > 0) {
    line.segments.forEach(seg => {
      const span = document.createElement('span');
      span.textContent = seg.t;
      if (seg.c) span.style.color = seg.c;
      if (seg.b) span.style.fontWeight = '700';
      if (seg.i) span.style.fontStyle = 'italic';
      const dec = [];
      if (seg.u) dec.push('underline');
      if (seg.s) dec.push('line-through');
      if (dec.length) span.style.textDecoration = dec.join(' ');
      msg.appendChild(span);
    });
  } else {
    appendFormattedMessage(msg, line.message);
  }

  row.append(time, who, msg);
  return row;
}

  function linesForActiveLog() {
    return activeLogAccountId === '*' ? logEntries : (logEntriesByAcc.get(activeLogAccountId) || []);
  }

  function renderLogs() {
    const container = $('#log-container');
    if (!container) return;
    const oldScrollTop = container.scrollTop;
    const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
    container.replaceChildren();
    const lines = linesForActiveLog();
    if (!lines.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = activeLogAccountId === '*' ? 'Chưa có log nào. Đang chờ dữ liệu từ bot...' : 'Bot này chưa có log nào.';
      container.appendChild(empty);
    } else {
      const frag = document.createDocumentFragment();
      for (const line of lines) frag.appendChild(makeLogRow(line));
      container.appendChild(frag);
    }
    const count = $('#log-count');
    if (count) count.textContent = lines.length + ' dòng';
    container.scrollTop = wasAtBottom ? container.scrollHeight : oldScrollTop;
  }

  function renderLogTabs() {
    const tabs = $('#log-account-tabs');
    if (!tabs) return;
    tabs.replaceChildren();
    const addTab = (id, label, status) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'log-tab' + (activeLogAccountId === id ? ' active' : '');
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(activeLogAccountId === id));
      btn.dataset.logAccountId = id;
      btn.innerHTML = '<span class="log-tab-dot"></span><span class="log-tab-label"></span>';
      $('.log-tab-label', btn).textContent = label;
      if (status) {
        const small = document.createElement('small');
        small.textContent = status;
        btn.appendChild(small);
      }
      btn.addEventListener('click', () => {
        activeLogAccountId = id;
        if (id !== '*') {
          const target = $('#log-command-target');
          if (target) target.value = id;
        }
        renderLogTabs();
        renderLogs();
      });
      tabs.appendChild(btn);
    };
    addTab('*', 'Tất cả bot', logEntries.length ? String(logEntries.length) + ' log' : '');
    for (const acc of accounts) addTab(acc.id, acc.username, acc.status || 'offline');
  }

  function renderLogTargetOptions() {
    const select = $('#log-command-target');
    if (!select) return;
    const previous = select.value;
    select.replaceChildren();
    const prompt = document.createElement('option');
    prompt.value = '';
    prompt.textContent = 'Chọn bot nhận lệnh…';
    select.appendChild(prompt);
    const all = document.createElement('option');
    all.value = '*';
    all.textContent = 'Tất cả bot đang online';
    select.appendChild(all);
    for (const acc of accounts) {
      const opt = document.createElement('option');
      opt.value = acc.id;
      opt.textContent = acc.username + ' · ' + (acc.status || 'offline');
      select.appendChild(opt);
    }
    if (previous && Array.from(select.options).some(o => o.value === previous)) select.value = previous;
    else if (activeLogAccountId !== '*') select.value = activeLogAccountId;
    else select.value = '*';
  }

  function initLogs() {
    const clear = $('#clear-logs');
    if (clear) clear.addEventListener('click', () => {
      if (activeLogAccountId === '*') {
        logEntries = [];
        logEntriesByAcc.clear();
      } else {
        const kept = logEntries.filter(line => line.id !== activeLogAccountId);
        logEntries = kept;
        logEntriesByAcc.delete(activeLogAccountId);
      }
      renderLogs();
      renderLogTabs();
      showToast(activeLogAccountId === '*' ? 'Đã xóa toàn bộ log đang lưu.' : 'Đã xóa log của bot đang chọn.', 'success');
    });
    const form = $('#log-command-form');
    if (form) form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('#log-command-input');
      const target = $('#log-command-target');
      const cmd = input.value.trim();
      if (!cmd) return;
      if (!target.value) {
        showToast('Chọn bot nhận lệnh trước khi gửi.', 'error');
        target.focus();
        return;
      }
      const result = await sendCommand(target.value, cmd);
      if (result) input.value = '';
      input.focus();
    });
  }

  async function postJson(url, body) {
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    } catch (e) {
      showToast('Không gửi được lệnh: ' + (e.message || e), 'error');
      return null;
    }
  }

  async function sendCommand(targetId, command) {
    const cmd = String(command || '').trim();
    if (!cmd) return false;
    if (!targetId) {
      showToast('Chưa chọn bot nhận lệnh.', 'error');
      return false;
    }
    const all = targetId === '*';
    const data = await postJson(all ? '/api/broadcast' : '/api/accounts/' + encodeURIComponent(targetId) + '/command', { command: cmd });
    if (!data) return false;
    if (all) showToast('Đã gửi lệnh cho ' + (data.sent || 0) + ' bot.', 'success');
    else {
      const acc = accounts.find(a => a.id === targetId);
      showToast('Đã gửi lệnh cho ' + (acc ? acc.username : 'bot đã chọn') + '.', 'success');
    }
    return true;
  }

  function accountButton(label, className, title, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'small-button ' + (className || '');
    btn.textContent = label;
    btn.title = title || label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function openBotLog(accId) {
    activeLogAccountId = accId;
    setActivePage('logs');
    const target = $('#log-command-target');
    if (target) target.value = accId;
    renderLogTabs();
    renderLogs();
    const input = $('#log-command-input');
    if (input) input.focus();
  }

  function openBotVision(accId) {
    const sel = $('#vision-acc-select');
    if (sel) sel.value = accId;
    if (selectedVisionAcc !== accId && window.KingSMPVision) window.KingSMPVision.switchAcc(selectedVisionAcc, accId);
    selectedVisionAcc = accId;
    setActivePage('bot-vision');
    const title = $('#vision-status-text');
    const acc = accounts.find(a => a.id === accId);
    if (title && acc) title.textContent = 'Vision riêng · ' + acc.username;
  }

  function renderAccounts() {
    const list = $('#accounts-list');
    const count = $('#acc-count');
    if (!list) return;
    if (count) count.textContent = accounts.length + ' bot';
    list.replaceChildren();
    if (!accounts.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state accounts-empty';
      empty.textContent = 'Chưa có bot nào. Thêm tài khoản ở phía trên để bắt đầu.';
      list.appendChild(empty);
      renderLogTabs();
      renderLogTargetOptions();
      return;
    }

    for (const acc of accounts) {
      const card = document.createElement('article');
      card.className = 'acc-card' + (collapsedCards[acc.id] ? ' is-collapsed' : '') + (maximizedCards[acc.id] ? ' is-maximized' : '');
      card.dataset.accountId = acc.id;

      const top = document.createElement('div');
      top.className = 'acc-card-header';
      const identity = document.createElement('div');
      identity.className = 'acc-identity';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = acc.username;
      const sub = document.createElement('span');
      sub.className = 'acc-subtitle';
      sub.textContent = 'Bot · Log · Image';
      identity.append(name, sub);
      const status = document.createElement('span');
      status.className = 'status ' + (acc.status || 'offline');
      status.textContent = acc.status || 'offline';
      top.append(identity, status);

      const tools = document.createElement('div');
      tools.className = 'acc-card-tools';
      tools.append(
        accountButton('≋ Log', 'bot-log-open', 'Mở log riêng của bot ' + acc.username, () => openBotLog(acc.id)),
        accountButton('◉ Vision', 'bot-vision-open', 'Mở Vision riêng của bot ' + acc.username, () => openBotVision(acc.id))
      );
      const collapseBtn = accountButton(collapsedCards[acc.id] ? '⌄ Mở rộng' : '⌃ Thu gọn', 'bot-collapse-toggle', 'Thu gọn hoặc mở rộng bot tab', () => {
        collapsedCards[acc.id] = !collapsedCards[acc.id];
        saveStateMap('kingsmp-card-collapsed', collapsedCards);
        card.classList.toggle('is-collapsed', !!collapsedCards[acc.id]);
        collapseBtn.textContent = collapsedCards[acc.id] ? '⌄ Mở rộng' : '⌃ Thu gọn';
        collapseBtn.setAttribute('aria-expanded', String(!collapsedCards[acc.id]));
      });
      collapseBtn.setAttribute('aria-expanded', String(!collapsedCards[acc.id]));
      const zoomBtn = accountButton(maximizedCards[acc.id] ? '⤡ Thu nhỏ' : '⤢ Phóng to', 'bot-zoom-toggle', 'Phóng to hoặc thu nhỏ thẻ bot', () => {
        maximizedCards[acc.id] = !maximizedCards[acc.id];
        saveStateMap('kingsmp-card-maximized', maximizedCards);
        card.classList.toggle('is-maximized', !!maximizedCards[acc.id]);
        zoomBtn.textContent = maximizedCards[acc.id] ? '⤡ Thu nhỏ' : '⤢ Phóng to';
      });
      tools.append(collapseBtn, zoomBtn);
      const heading = document.createElement('div');
      heading.className = 'acc-card-topline';
      heading.append(top, tools);

      const content = document.createElement('div');
      content.className = 'acc-card-content';
      const proxy = document.createElement('div');
      proxy.className = 'proxy';
      proxy.textContent = acc.proxy ? 'Proxy: ' + acc.proxy : 'Không dùng proxy';

      const cmdForm = document.createElement('form');
      cmdForm.className = 'cmd-row card-command-form';
      const cmdInput = document.createElement('input');
      cmdInput.type = 'text';
      cmdInput.autocomplete = 'off';
      cmdInput.placeholder = 'Nhập lệnh cho ' + acc.username + '…';
      const cmdBtn = document.createElement('button');
      cmdBtn.type = 'submit';
      cmdBtn.className = 'small-button';
      cmdBtn.textContent = 'Gửi ↗';
      cmdForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const cmd = cmdInput.value.trim();
        if (!cmd) return;
        if (await sendCommand(acc.id, cmd)) cmdInput.value = '';
        cmdInput.focus();
      });
      cmdForm.append(cmdInput, cmdBtn);

      const actions = document.createElement('div');
      actions.className = 'actions';
      const startBtn = accountButton('▶ Start', '', 'Khởi động bot', async () => {
        const data = await postJson('/api/accounts/' + encodeURIComponent(acc.id) + '/start', {});
        if (data) { showToast('Đã yêu cầu khởi động ' + acc.username, 'success'); loadAccounts(); }
      });
      const stopBtn = accountButton('■ Stop', '', 'Dừng bot', async () => {
        try {
          const res = await fetch('/api/accounts/' + encodeURIComponent(acc.id) + '/stop', { method: 'POST' });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) throw new Error(data.error || 'Không dừng được bot');
          showToast('Đã yêu cầu dừng ' + acc.username, 'success');
          loadAccounts();
        } catch (e) { showToast(e.message, 'error'); }
      });
      const delBtn = accountButton('Xóa', 'danger-action', 'Xóa tài khoản bot', async () => {
        if (!confirm('Xóa bot ' + acc.username + '?')) return;
        try {
          const res = await fetch('/api/accounts/' + encodeURIComponent(acc.id), { method: 'DELETE' });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) throw new Error(data.error || 'Không xóa được bot');
          delete collapsedCards[acc.id]; delete maximizedCards[acc.id];
          saveStateMap('kingsmp-card-collapsed', collapsedCards);
          saveStateMap('kingsmp-card-maximized', maximizedCards);
          showToast('Đã xóa bot ' + acc.username, 'success');
          loadAccounts();
        } catch (e) { showToast(e.message, 'error'); }
      });
      actions.append(startBtn, stopBtn, delBtn);
      content.append(proxy, cmdForm, actions);
      card.append(heading, content);
      list.appendChild(card);
    }
    renderLogTabs();
    renderLogTargetOptions();
  }

  async function loadAccounts() {
    try {
      const res = await fetch('/api/accounts');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      accounts = Array.isArray(data) ? data : [];
      renderAccounts();
      updateVisionSelect();
    } catch (e) { console.error(e); }
  }

  function initAccounts() {
    const form = $('#add-form');
    if (form) form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = $('#acc-username').value.trim();
      const password = $('#acc-password').value;
      const proxy = $('#acc-proxy').value.trim();
      if (!username || !password) return showToast('Nhập đủ username + password.', 'error');
      const data = await postJson('/api/accounts', { username, password, proxy });
      if (!data) return;
      form.reset();
      showToast('Đã thêm bot ' + username, 'success');
      loadAccounts();
    });
    const bc = $('#broadcast-btn');
    const input = $('#broadcast-input');
    const sendBroadcast = async () => {
      const cmd = input.value.trim();
      if (!cmd) return;
      if (await sendCommand('*', cmd)) input.value = '';
    };
    if (bc) bc.addEventListener('click', sendBroadcast);
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendBroadcast(); } });
  }

  function updateVisionSelect() {
    const sel = $('#vision-acc-select');
    if (!sel) return;
    const current = sel.value || selectedVisionAcc || '';
    sel.replaceChildren();
    const opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = '-- Chọn bot để xem Vision --';
    sel.appendChild(opt0);
    for (const acc of accounts) {
      const opt = document.createElement('option');
      opt.value = acc.id;
      opt.textContent = acc.username + ' (' + (acc.status || 'offline') + ')';
      sel.appendChild(opt);
    }
    if (current && accounts.some(a => a.id === current)) sel.value = current;
    else if (selectedVisionAcc && !accounts.some(a => a.id === selectedVisionAcc)) {
      selectedVisionAcc = null;
      if (window.KingSMPVision) window.KingSMPVision.switchAcc(current, null);
    }
  }

  function initVisionSelect() {
    const sel = $('#vision-acc-select');
    if (sel) sel.addEventListener('change', (e) => {
      const accId = e.target.value || null;
      if (window.KingSMPVision) window.KingSMPVision.switchAcc(selectedVisionAcc, accId);
      selectedVisionAcc = accId;
      const acc = accounts.find(a => a.id === accId);
      const txt = $('#vision-status-text');
      if (txt) txt.textContent = acc ? 'Vision riêng · ' + acc.username : 'Chọn bot để bắt đầu';
    });
  }

  function initProxy() {
    const box = $('#proxy-status-box');
    const setStatus = (kind, title, message) => {
      if (!box) return;
      box.classList.remove('success', 'error');
      if (kind) box.classList.add(kind);
      $('#proxy-status-title').textContent = title;
      $('#proxy-status-message').textContent = message;
    };
    let busy = false;
    const setBusy = (b) => {
      busy = b;
      const tp = $('#test-proxy'); if (tp) tp.disabled = b;
      const ci = $('#check-ip'); if (ci) ci.disabled = b;
      const sp = $('#stop-proxy'); if (sp) sp.disabled = !b;
    };
    const tp = $('#test-proxy');
    if (tp) tp.addEventListener('click', () => {
      const url = $('#proxy-url').value.trim();
      if (!url) return showToast('Nhập proxy URL trước.', 'error');
      if (!socket) return showToast('Socket.IO chưa kết nối.', 'error');
      setBusy(true); setStatus('', 'Đang test...', 'Đợi tối đa 10 giây.');
      socket.emit('proxy-test', { proxyUrl: url });
    });
    const ci = $('#check-ip');
    if (ci) ci.addEventListener('click', () => {
      if (!socket) return showToast('Socket.IO chưa kết nối.', 'error');
      setBusy(true); setStatus('', 'Đang check IP...', 'Đợi tối đa 10 giây.');
      socket.emit('proxy-check-ip');
    });
    const sp = $('#stop-proxy');
    if (sp) sp.addEventListener('click', () => { if (busy && socket) socket.emit('proxy-stop'); });
    if (socket) {
      socket.on('proxy-result', (r) => {
        setBusy(false);
        if (r.ok) { setStatus('success', r.title || 'OK', r.message || ''); showToast(r.message || 'OK', 'success'); }
        else { setStatus('error', r.title || 'Lỗi', r.message || ''); showToast(r.message || 'Lỗi', 'error'); }
      });
      socket.on('proxy-stopped', (r) => { setBusy(false); setStatus('', 'Đã dừng', r.message || ''); });
    }
  }

  function initSocket() {
    if (!socket) {
      showToast('Socket.IO chưa kết nối.', 'error');
      return;
    }
    socket.on('connect', () => {
      $('#sidebar-connection-text').textContent = 'Panel online';
      $('#sidebar-connection-dot').classList.add('online');
      socket.emit('request-status');
    });
    socket.on('disconnect', () => {
      $('#sidebar-connection-text').textContent = 'Mất kết nối';
      $('#sidebar-connection-dot').classList.remove('online');
    });
    socket.on('accounts-status', (list) => {
      const statusById = new Map((Array.isArray(list) ? list : []).map(item => [item.id, item]));
      accounts = accounts.map(acc => {
        const status = statusById.get(acc.id);
        return Object.assign({}, acc, { status: status ? status.status : 'offline', lastError: status ? status.lastError : '' });
      });
      renderAccounts();
      updateVisionSelect();
    });
    socket.on('bot-log', addLog);
  }

  window.KingSMP = {
    socket, showToast, setActivePage, sendCommand, openBotLog, openBotVision,
    getLogs: () => logEntries,
    getLogsForAccount: (id) => logEntriesByAcc.get(id) || [],
    getAccounts: () => accounts,
    appendFormattedMessage,
    getSelectedVisionAccId: () => selectedVisionAcc
  };

  initTheme();
  initNavigation();
  initLogs();
  initAccounts();
  initVisionSelect();
  initProxy();
  initSocket();
  renderLogTabs();
  renderLogTargetOptions();
  loadAccounts();
})();
