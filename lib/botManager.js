'use strict';

// BotInstance: quản lý 1 bot mineflayer (đăng nhập, click menu, AFK, log có màu).
// Mỗi dòng log phát ra có dạng:
//   { id, username, message, type, time, segments }
// segments = [{ t: 'text', c: '#RRGGBB', b: true, i: true, u: true, s: true }]
// -> giao diện dùng segments để hiển thị đúng màu server gửi về.

const EventEmitter = require('events');
const http = require('http');
const https = require('https');
const mineflayer = require('mineflayer');

// ---------------------------------------------------------------
// Màu / định dạng chữ Minecraft
// ---------------------------------------------------------------
const COLOR_HEX = {
  black: '#000000', dark_blue: '#0000AA', dark_green: '#00AA00', dark_aqua: '#00AAAA',
  dark_red: '#AA0000', dark_purple: '#AA00AA', gold: '#FFAA00', gray: '#AAAAAA',
  dark_gray: '#555555', blue: '#5555FF', green: '#55FF55', aqua: '#55FFFF',
  red: '#FF5555', light_purple: '#FF55FF', yellow: '#FFFF55', white: '#FFFFFF'
};
const LEGACY_CODE = {
  '0': 'black', '1': 'dark_blue', '2': 'dark_green', '3': 'dark_aqua', '4': 'dark_red',
  '5': 'dark_purple', '6': 'gold', '7': 'gray', '8': 'dark_gray', '9': 'blue',
  a: 'green', b: 'aqua', c: 'red', d: 'light_purple', e: 'yellow', f: 'white'
};

function toHexColor(color) {
  if (!color) return undefined;
  const value = String(color).toLowerCase();
  if (COLOR_HEX[value]) return COLOR_HEX[value];
  if (/^#[0-9a-f]{6}$/.test(value)) return value;
  return undefined;
}

function makeSegment(text, style) {
  const seg = { t: String(text) };
  if (style.color) seg.c = style.color;
  if (style.bold) seg.b = true;
  if (style.italic) seg.i = true;
  if (style.underlined) seg.u = true;
  if (style.strikethrough) seg.s = true;
  return seg;
}

// Tách mã màu kiểu cũ (§c, §l, ...) trong chuỗi.
function parseLegacy(str, base) {
  const out = [];
  let style = Object.assign({}, base);
  let buf = '';
  const flush = () => { if (buf) { out.push(makeSegment(buf, style)); buf = ''; } };
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === '\u00a7' && i + 1 < str.length) {
      const code = str[i + 1].toLowerCase();
      flush();
      if (LEGACY_CODE[code]) style = { color: toHexColor(LEGACY_CODE[code]) };
      else if (code === 'l') style.bold = true;
      else if (code === 'o') style.italic = true;
      else if (code === 'n') style.underlined = true;
      else if (code === 'm') style.strikethrough = true;
      else if (code === 'r') style = {};
      i += 1;
      continue;
    }
    buf += ch;
  }
  flush();
  return out;
}

function plainText(segments) {
  return segments.map((seg) => seg.t).join('');
}

function formatTranslate(template, args) {
  let next = 0;
  return String(template).replace(/%(?:(\d+)\$)?([sd%])/g, (m, n, t) => {
    if (t === '%') return '%';
    const value = args[n ? Number(n) - 1 : next++];
    return value === undefined ? '' : plainText(componentToSegments(value, {}, null));
  });
}

// Chuyển component chat (JSON / NBT đã simplify) thành mảng segments.
function componentToSegments(component, inherited, language) {
  const base = inherited || {};
  if (component === null || component === undefined) return [];
  if (typeof component === 'string' || typeof component === 'number' || typeof component === 'boolean') {
    return parseLegacy(String(component), base);
  }
  if (Array.isArray(component)) {
    const out = [];
    for (const part of component) out.push(...componentToSegments(part, base, language));
    return out;
  }
  if (typeof component !== 'object') return [];
  const style = {
    color: toHexColor(component.color) || base.color,
    bold: component.bold === undefined ? base.bold : !!component.bold,
    italic: component.italic === undefined ? base.italic : !!component.italic,
    underlined: component.underlined === undefined ? base.underlined : !!component.underlined,
    strikethrough: component.strikethrough === undefined ? base.strikethrough : !!component.strikethrough
  };
  let text = '';
  if (component.text !== undefined) text = String(component.text);
  else if (component.translate !== undefined) {
    const template = (language && language[component.translate]) || component.fallback || component.translate;
    const args = component.with || component.args || [];
    text = formatTranslate(template, Array.isArray(args) ? args : [args]);
  }
  const out = text ? parseLegacy(text, style) : [];
  if (Array.isArray(component.extra)) {
    for (const part of component.extra) out.push(...componentToSegments(part, style, language));
  }
  return out;
}

// NBT dạng {type, value} (1.20.3+) -> object thường.
function simplifyNbt(tag) {
  if (!tag || typeof tag !== 'object') return tag;
  if (Object.prototype.hasOwnProperty.call(tag, 'type') && Object.prototype.hasOwnProperty.call(tag, 'value')) {
    if (tag.type === 'compound') {
      const obj = {};
      for (const key of Object.keys(tag.value || {})) obj[key] = simplifyNbt(tag.value[key]);
      return obj;
    }
    if (tag.type === 'list') {
      const inner = tag.value || {};
      return (inner.value || []).map((item) => simplifyNbt({ type: inner.type, value: item }));
    }
    return tag.value;
  }
  return tag;
}

function reasonToSegments(reason, language) {
  let data = reason;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
      try { data = JSON.parse(trimmed); } catch (_) { data = reason; }
    }
  }
  data = simplifyNbt(data);
  return componentToSegments(data, {}, language);
}

// ---------------------------------------------------------------
// Kết nối qua proxy (http/https CONNECT hoặc socks4/5)
// ---------------------------------------------------------------
function createProxySocket(proxyUrl, host, port) {
  const proxy = new URL(proxyUrl);
  const isSocks = proxy.protocol.startsWith('socks');
  const proxyPort = Number(proxy.port) || (isSocks ? 1080 : proxy.protocol === 'https:' ? 443 : 80);
  const user = decodeURIComponent(proxy.username || '');
  const pass = decodeURIComponent(proxy.password || '');

  if (isSocks) {
    const { SocksClient } = require('socks');
    return SocksClient.createConnection({
      proxy: {
        host: proxy.hostname,
        port: proxyPort,
        type: proxy.protocol.startsWith('socks4') ? 4 : 5,
        userId: user || undefined,
        password: pass || undefined
      },
      command: 'connect',
      destination: { host, port },
      timeout: 15000
    }).then((result) => result.socket);
  }

  return new Promise((resolve, reject) => {
    const lib = proxy.protocol === 'https:' ? https : http;
    const headers = { Host: host + ':' + port };
    if (user || pass) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
    const req = lib.request({
      host: proxy.hostname, port: proxyPort, method: 'CONNECT', path: host + ':' + port, headers, timeout: 15000
    });
    req.once('connect', (res, socket) => {
      req.removeAllListeners('timeout');
      if (res.statusCode === 200) {
        socket.setTimeout(0);
        resolve(socket);
      } else {
        socket.destroy();
        reject(new Error('Proxy từ chối kết nối (HTTP ' + res.statusCode + ')'));
      }
    });
    req.once('timeout', () => req.destroy(new Error('Proxy timeout')));
    req.once('error', reject);
    req.end();
  });
}

// Lỗi parse gói tin (server/plugin gửi packet lạ) – không được làm bot sập.
const PARSE_ERROR_RE = /parse error|read error|partialread|array size|unexpected buffer|chunk size/i;

// ---------------------------------------------------------------
class BotInstance extends EventEmitter {
  constructor(account, config) {
    super();
    this.account = account;
    this.config = config || {};
    this.bot = null;
    this.status = 'offline';
    this.lastError = '';
    this.joinedAt = null;
    this.stopped = false;
    this.timers = new Set();
    this.afkTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.warnState = new Map();
    this.session = 0;
  }

  // ----- log -----
  log(message, type, segments) {
    const text = String(message === undefined ? '' : message);
    if (!text.trim()) return;
    this.emit('log', {
      id: this.account.id,
      username: this.account.username,
      message: text,
      type: type || 'system',
      time: Date.now(),
      segments: Array.isArray(segments) && segments.length ? segments : undefined
    });
  }

  logColored(prefix, prefixColor, segments, type) {
    const head = prefix ? [{ t: prefix + ' ', c: prefixColor, b: true }] : [];
    const all = head.concat(segments);
    this.log(plainText(all), type, all);
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  later(fn, ms) {
    const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms);
    this.timers.add(timer);
    return timer;
  }

  clearTimers() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.afkTimer) { clearInterval(this.afkTimer); this.afkTimer = null; }
  }

  language() {
    return this.bot && this.bot.registry && this.bot.registry.language ? this.bot.registry.language : null;
  }

  // ----- vòng đời -----
  start() {
    if (this.bot) return;
    this.stopped = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.clearTimers();
    const bot = this.bot;
    if (bot) {
      try { bot.quit('stop'); } catch (_) {}
      try { bot.end(); } catch (_) {}
    } else {
      this.setStatus('offline');
    }
  }

  connect() {
    const server = this.config.server || {};
    const host = server.host || 'localhost';
    const port = Number(server.port) || 25565;
    const version = server.version && server.version !== 'auto' ? server.version : undefined;
    const proxyUrl = String(this.account.proxy || '').trim();
    const session = ++this.session;

    this.lastError = '';
    this.joinedAt = null;
    this.setStatus('connecting');
    this.log('Đang kết nối tới ' + host + ':' + port + (proxyUrl ? ' qua proxy' : '') + '…', 'system');

    const options = {
      host, port, version,
      username: this.account.username,
      auth: 'offline',
      hideErrors: true, // không in lỗi parse ra console, tự xử lý bên dưới
      viewDistance: Number(this.config.viewDistance) || 7, // chunk; đủ cho tầm nhìn Vision tối đa 5 chunk
      checkTimeoutInterval: 60 * 1000
    };
    if (proxyUrl) {
      options.connect = (client) => {
        createProxySocket(proxyUrl, host, port)
          .then((socket) => { client.setSocket(socket); client.emit('connect'); })
          .catch((err) => client.emit('error', err));
      };
    }

    let bot;
    try {
      bot = mineflayer.createBot(options);
    } catch (err) {
      this.lastError = err.message;
      this.log('[Lỗi bot] ' + err.message, 'error');
      this.setStatus('error');
      this.scheduleReconnect(0);
      return;
    }
    this.bot = bot;

    const state = { loginSent: false, joined: false, menuSeen: false, clicking: false, spawned: false, ended: false, kickSeconds: 0, hadError: false };

    // Lỗi parse: ghi cảnh báo (giới hạn tần suất), KHÔNG ngắt bot.
    const handleError = (err) => {
      const message = String((err && err.message) || err);
      if (PARSE_ERROR_RE.test(message)) { this.warnParse(message); return; }
      state.hadError = true;
      this.lastError = message;
      this.log('[Lỗi bot] ' + message, 'error');
    };
    bot.on('error', handleError);
    if (bot._client) bot._client.on('error', handleError);

    bot.once('login', () => this.log('Đã đăng nhập vào server, đang chờ spawn…', 'system'));

    bot.on('spawn', () => {
      if (state.spawned) return;
      state.spawned = true;
      this.joinedAt = Date.now();
      this.reconnectAttempt = 0;
      this.setStatus('online');
      this.log('Bot đã spawn', 'success');

      this.later(() => this.sendLogin(state), 1500);
      // Nếu sau login mà không thấy menu nào mở thì báo để dễ chẩn đoán (không tự gửi lại lệnh để tránh bị kick spam).
      this.later(() => {
        if (!state.joined && !state.menuSeen) {
          this.log('[Cảnh báo] Chưa thấy menu mở sau khi login. Kiểm tra mật khẩu /login hoặc thử gửi lệnh tay.', 'warn');
        }
      }, 30000);
      // Dự phòng: nếu không có menu nào (vd đã ở sẵn trong server) vẫn bật chống AFK.
      this.later(() => { if (!state.joined) this.startAfk(); }, 60000);
    });

    // Menu chọn cụm: xử lý MỌI cửa sổ mở ra cho tới khi click thành công (không giới hạn thời gian).
    bot.on('windowOpen', (window) => this.handleMenu(bot, window, state));

    bot.on('message', (jsonMsg, position) => {
      if (position === 'game_info') return; // action bar
      let segments = [];
      try {
        segments = componentToSegments(jsonMsg.json !== undefined ? jsonMsg.json : jsonMsg.toString(), {}, this.language());
      } catch (_) {
        segments = [{ t: String(jsonMsg) }];
      }
      const text = plainText(segments);
      if (text.trim()) this.log(text, 'chat', segments);
    });

    bot.on('kicked', (reason) => {
      let segments = [];
      try { segments = reasonToSegments(reason, this.language()); } catch (_) { segments = [{ t: String(reason) }]; }
      if (!segments.length) segments = [{ t: 'Không rõ lý do' }];
      const match = plainText(segments).match(/(\d+)\s*(?:giây|giay|s\b|sec)/i);
      if (match) state.kickSeconds = Number(match[1]);
      this.logColored('[Bị kick]', '#FF5555', segments, 'error');
    });

    bot.on('end', (reason) => {
      if (state.ended || session !== this.session) return;
      state.ended = true;
      this.clearTimers();
      this.bot = null;
      this.joinedAt = null;
      this.log('[ Ngắt kết nối ]' + (reason ? ' ' + reason : ''), 'error');
      this.setStatus(state.hadError && !state.spawned ? 'error' : 'offline');
      if (this.stopped) return;
      this.scheduleReconnect(state.kickSeconds);
    });
  }

  windowTitle(window) {
    try {
      const raw = window && window.title;
      if (!raw) return '';
      const data = raw && raw.json !== undefined ? raw.json : raw;
      return plainText(reasonToSegments(data, this.language())).trim();
    } catch (_) { return ''; }
  }

  async handleMenu(bot, window, state) {
    state.menuSeen = true;
    if (state.joined) return;        // đã vào cụm, không tự click các cửa sổ khác
    if (state.clicking) return;      // đang xử lý một menu
    const slot = Number(this.config.menuSlot) || 24;
    const title = this.windowTitle(window);
    this.log('Menu đã mở' + (title ? ' "' + title + '"' : '') + ', chuẩn bị click slot ' + slot, 'success');
    state.clicking = true;
    try {
      await new Promise((resolve) => this.later(resolve, Number(this.config.menuDelayMs) || 2500));
      if (this.bot !== bot) return;
      if (bot.currentWindow !== window) {
        this.log('[Cảnh báo] Menu đã đóng trước khi click, chờ menu kế tiếp…', 'warn');
        return;
      }
      const total = window.slots ? window.slots.length : 0;
      if (total && slot >= total) {
        this.log('[Cảnh báo] Cửa sổ này chỉ có ' + total + ' slot, không có slot ' + slot + '. Bỏ qua.', 'warn');
        return;
      }
      // Item của menu có thể nạp chậm hơn lúc mở cửa sổ: đợi tối đa ~3 giây.
      for (let i = 0; i < 6 && window.slots && !window.slots[slot]; i += 1) {
        await new Promise((resolve) => this.later(resolve, 500));
        if (this.bot !== bot || bot.currentWindow !== window) return;
      }
      if (window.slots && !window.slots[slot]) {
        this.log('[Cảnh báo] Slot ' + slot + ' đang trống, vẫn thử click.', 'warn');
      }
      try {
        await Promise.race([
          bot.clickWindow(slot, 0, 0),
          new Promise((resolve) => this.later(resolve, 5000))
        ]);
      } catch (err) {
        // Click xong menu tự đóng nên mineflayer hay báo "Server didn't respond to transaction": coi là đã click.
        if (!/respond|transaction|window/i.test(String(err && err.message))) throw err;
      }
      state.joined = true;
      this.log('Đã click slot ' + slot, 'success');
      this.later(() => this.startAfk(), Number(this.config.enterDelayMs) || 8000);
    } catch (err) {
      this.log('[Lỗi bot] Không click được slot ' + slot + ': ' + err.message, 'error');
    } finally {
      state.clicking = false;
    }
  }

  warnParse(message) {
    const key = message.slice(0, 120);
    const now = Date.now();
    const entry = this.warnState.get(key) || { last: 0, skipped: 0 };
    if (entry.last && now - entry.last < 30000) { entry.skipped += 1; this.warnState.set(key, entry); return; }
    const extra = entry.skipped ? ' (đã bỏ qua thêm ' + entry.skipped + ' lần)' : '';
    this.warnState.set(key, { last: now, skipped: 0 });
    this.log('[Cảnh báo] Bỏ qua gói tin lỗi từ server: ' + message + extra, 'warn');
  }

  sendLogin(state) {
    if (state.loginSent || !this.bot) return;
    state.loginSent = true;
    const template = this.config.defaultLoginCommand || '/login {password}';
    const command = template.replace('{password}', this.account.password);
    try {
      this.bot.chat(command);
      this.log('Đã gửi login', 'success');
    } catch (err) {
      this.log('[Lỗi bot] Không gửi được login: ' + err.message, 'error');
    }
  }

  startAfk() {
    if (this.afkTimer || !this.bot) return;
    const interval = Number(this.config.afkIntervalMs) || 30000;
    this.afkTimer = setInterval(() => {
      const bot = this.bot;
      if (!bot || !bot.entity) return;
      try {
        bot.setControlState('jump', true);
        setTimeout(() => { try { bot.setControlState('jump', false); } catch (_) {} }, 300);
        bot.look(bot.entity.yaw + (Math.random() - 0.5) * 0.6, bot.entity.pitch, false);
        bot.swingArm();
      } catch (_) {}
    }, interval);
  }

  scheduleReconnect(kickSeconds) {
    if (this.config.autoReconnect === false || this.stopped) return;
    this.reconnectAttempt += 1;
    const delay = kickSeconds > 0 ? (kickSeconds + 5) * 1000 : Math.min(60000, 10000 * this.reconnectAttempt);
    this.log('Tự động kết nối lại sau ' + Math.round(delay / 1000) + ' giây…', 'system');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped && !this.bot) this.connect();
    }, delay);
  }
}

module.exports = { BotInstance, componentToSegments, reasonToSegments };
