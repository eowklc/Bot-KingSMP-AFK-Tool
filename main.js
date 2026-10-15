'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { Server } = require('socket.io');
const { BotInstance } = require('./lib/botManager');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const ACCOUNTS_PATH = path.join(__dirname, 'accounts.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8')); } catch { return []; }
}
function saveAccounts(list) {
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(list, null, 2), 'utf8');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const bots = new Map();

function serializeBots() {
  return Array.from(bots.values()).map(b => ({
    id: b.account.id,
    username: b.account.username,
    proxy: b.account.proxy || '',
    status: b.status,
    lastError: b.lastError,
    joinedAt: b.joinedAt
  }));
}

function broadcastStatus() {
  io.emit('accounts-status', serializeBots());
}

function buildAgent(proxyUrl) {
  if (!proxyUrl) return undefined;
  let parsed;
  try { parsed = new URL(proxyUrl); } catch { throw new Error('Proxy URL khong hop le.'); }
  if (['socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) {
    const { SocksProxyAgent } = require('socks-proxy-agent');
    return new SocksProxyAgent(proxyUrl);
  }
  if (['http:', 'https:'].includes(parsed.protocol)) {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    return new HttpsProxyAgent(proxyUrl);
  }
  throw new Error('Proxy chi ho tro http/https/socks4/socks5.');
}

function attachBotListeners(instance) {
  instance.on('log', (entry) => io.emit('bot-log', entry));
  instance.on('status', () => broadcastStatus());
}

function spawnAccount(account) {
  if (bots.has(account.id)) return bots.get(account.id);
  const instance = new BotInstance(account, config, { buildAgent });
  attachBotListeners(instance);
  bots.set(account.id, instance);
  instance.start();
  broadcastStatus();
  return instance;
}

function killAccount(id) {
  const instance = bots.get(id);
  if (!instance) return;
  instance.stop();
  bots.delete(id);
  visionCleanup(id);
  visionViewers.delete(id);
  broadcastStatus();
}

function autostartAll() {
  for (const acc of loadAccounts()) spawnAccount(acc);
}

// ============================================================
// BOT VISION
// ============================================================
const VISION_ROOM_PREFIX = 'vision:';
let visionRegistryCache = null;
const visionBlockCache = new Map();

const VISION_WOOD = {
  oak: [162, 130, 78], spruce: [114, 84, 48], birch: [196, 179, 123], jungle: [160, 115, 80],
  acacia: [168, 90, 50], dark_oak: [66, 43, 20], mangrove: [117, 54, 48], cherry: [226, 178, 172],
  bamboo: [193, 173, 80], crimson: [101, 48, 70], warped: [43, 104, 99]
};

const VISION_DYE = [
  ['light_blue', [110, 170, 215]], ['light_gray', [155, 155, 150]], ['white', [225, 228, 230]],
  ['orange', [216, 127, 51]], ['magenta', [178, 76, 216]], ['yellow', [229, 229, 51]],
  ['lime', [127, 204, 25]], ['pink', [242, 127, 165]], ['gray', [76, 76, 76]],
  ['cyan', [76, 127, 153]], ['purple', [127, 63, 178]], ['blue', [51, 76, 178]],
  ['brown', [102, 76, 51]], ['green', [102, 127, 51]], ['red', [153, 51, 51]], ['black', [25, 25, 30]]
];

const VISION_ORE = {
  coal: [40, 40, 40], iron: [216, 175, 147], gold: [252, 238, 75], diamond: [92, 219, 213],
  redstone: [190, 20, 20], lapis: [38, 67, 160], emerald: [23, 221, 98], copper: [192, 107, 79]
};

const VISION_RULES = [
  [/^(water|bubble_column)$/, [47, 98, 205], null, 0.55, 'w'],
  [/^lava$/, [235, 110, 25]],
  [/^ice$/, [150, 195, 245], null, 0.6],
  [/^(packed_ice|blue_ice|frosted_ice)$/, [140, 180, 235]],
  [/^(snow|snow_block|powder_snow)$/, [240, 248, 250]],
  [/^grass_block$/, [121, 85, 58], [92, 150, 58]],
  [/^(mycelium)$/, [110, 90, 100], [125, 100, 125]],
  [/^podzol$/, [95, 65, 35], [110, 80, 40]],
  [/^(dirt|coarse_dirt|rooted_dirt|farmland|dirt_path|mud)$/, [121, 85, 58]],
  [/^red_sand$/, [190, 102, 33]],
  [/^(sand|suspicious_sand)$/, [219, 207, 155]],
  [/^red_sandstone|^smooth_red_sandstone|^cut_red_sandstone|^chiseled_red_sandstone/, [180, 98, 40]],
  [/sandstone/, [216, 203, 155]],
  [/^gravel$/, [131, 127, 126]],
  [/^clay$/, [160, 166, 179]],
  [/glass/, [200, 225, 235], null, 0.25],
  [/leaves$/, [58, 125, 40], null, 1, 'l'],
  [/^(cobblestone|mossy_cobblestone|cobblestone_.*)$/, [110, 110, 110]],
  [/^(stone|smooth_stone|stone_bricks|stone_brick_.*|mossy_stone_bricks|cracked_stone_bricks|chiseled_stone_bricks|andesite|polished_andesite|infested_stone)/, [125, 125, 125]],
  [/deepslate/, [72, 72, 78]],
  [/diorite/, [190, 190, 190]],
  [/granite/, [150, 103, 86]],
  [/^tuff/, [108, 109, 102]],
  [/^calcite$/, [225, 225, 220]],
  [/blackstone|^basalt|^smooth_basalt/, [48, 45, 52]],
  [/^netherrack$|^nether_(gold|quartz)_ore$/, [110, 50, 50]],
  [/nether_brick/, [48, 24, 28]],
  [/^(soul_sand|soul_soil)$/, [84, 64, 51]],
  [/obsidian/, [20, 14, 32]],
  [/^bedrock$/, [60, 60, 60]],
  [/^end_stone/, [219, 222, 158]],
  [/^(glowstone|shroomlight|sea_lantern|ochre_froglight)$/, [250, 210, 130]],
  [/^magma_block$/, [160, 60, 20]],
  [/^terracotta$/, [152, 94, 67]],
  [/^(bricks|brick_.*)$/, [150, 97, 83]],
  [/quartz/, [235, 229, 222]],
  [/prismarine/, [99, 156, 151]],
  [/^iron_block$/, [220, 220, 220]],
  [/^gold_block$/, [250, 238, 77]],
  [/^diamond_block$/, [98, 237, 228]],
  [/^emerald_block$/, [42, 203, 87]],
  [/^lapis_block$/, [38, 67, 160]],
  [/^redstone_block$/, [170, 24, 10]],
  [/^coal_block$/, [20, 20, 20]],
  [/copper/, [192, 107, 79]],
  [/^bookshelf$/, [140, 110, 60]],
  [/^(pumpkin|carved_pumpkin|jack_o_lantern)$/, [200, 120, 20]],
  [/^melon$/, [110, 150, 30]],
  [/^hay_block$/, [200, 170, 20]],
  [/^cactus$/, [20, 120, 40]],
  [/^tnt$/, [200, 50, 40]],
  [/^slime_block$/, [110, 190, 90], null, 0.75],
  [/^honey_block$/, [230, 170, 40], null, 0.75],
  [/^(furnace|blast_furnace|smoker|dispenser|dropper|observer|piston|sticky_piston)$/, [110, 110, 110]],
  [/chest$|^barrel$|^crafting_table$|^fletching_table$|^cartography_table$|^loom$/, [150, 100, 30]]
];

function visionHslToRgb(h, s, l) {
  const k = (n) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function visionHashColor(name) {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return visionHslToRgb(((hash >>> 0) % 360) / 360, 0.35, 0.52);
}

function visionScale(color, factor) {
  return color.map((value) => Math.max(0, Math.min(255, Math.round(value * factor))));
}

function visionBlockInfo(name) {
  if (visionBlockCache.has(name)) return visionBlockCache.get(name);
  let info = null;
  const wood = name.match(/^(?:stripped_)?(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped)_(.+)$/);
  if (wood && !/leaves$/.test(name)) {
    const base = VISION_WOOD[wood[1]];
    if (/(log|wood|stem|hyphae|block)$/.test(wood[2])) info = { c: visionScale(base, 0.68), t: base };
    else info = { c: base };
  }
  if (!info) {
    const ore = name.match(/^(deepslate_)?(coal|iron|gold|diamond|redstone|lapis|emerald|copper)_ore$/);
    if (ore) {
      const stone = ore[1] ? [72, 72, 78] : [125, 125, 125];
      const tint = VISION_ORE[ore[2]];
      info = { c: stone.map((value, i) => Math.round(value * 0.55 + tint[i] * 0.45)) };
    }
  }
  if (!info && /(wool|concrete|terracotta|carpet|stained_glass|shulker_box|candle|bed|banner)/.test(name)) {
    const dye = VISION_DYE.find(([word]) => name.includes(word));
    if (dye) info = { c: dye[1], a: /stained_glass/.test(name) ? 0.4 : 1 };
  }
  if (!info) {
    for (const [regex, color, top, alpha, flag] of VISION_RULES) {
      if (!regex.test(name)) continue;
      info = { c: color };
      if (top) info.t = top;
      if (alpha !== undefined && alpha < 1) info.a = alpha;
      if (flag === 'w') info.w = 1;
      if (flag === 'l') info.l = 1;
      break;
    }
  }
  if (!info) info = { c: visionHashColor(name) };
  visionBlockCache.set(name, info);
  return info;
}

function visionRegistry(bot) {
  if (bot && bot.registry) return bot.registry;
  if (!visionRegistryCache && bot && bot.version) {
    try { visionRegistryCache = require('minecraft-data')(bot.version); } catch (_) {}
  }
  return visionRegistryCache;
}

function visionResolveState(registry, stateId, palette, paletteIndex) {
  const def = registry.blocksByStateId && registry.blocksByStateId[stateId];
  if (!def || /^(air|cave_air|void_air)$/.test(def.name)) return 0;
  const liquid = /^(water|lava|bubble_column)$/.test(def.name);
  if (!liquid && def.boundingBox === 'empty') return 0;
  let index = paletteIndex.get(def.name);
  if (index === undefined) {
    if (palette.length >= 255) return 254;
    index = palette.length;
    palette.push(visionBlockInfo(def.name));
    paletteIndex.set(def.name, index);
  }
  return index;
}

function buildVisionWorld(instance, radiusOverride) {
  const bot = instance.bot;
  const entity = bot && bot.entity;
  const world = bot && bot.world;
  const registry = visionRegistry(bot);
  if (!entity || !entity.position || !world || typeof world.getColumn !== 'function' || !registry) return null;
  const V = config.vision || {};
  const radius = radiusOverride || V.radius || 22;
  const below = V.below || 12;
  const above = V.above || 12;
  const cx = Math.floor(entity.position.x);
  const cy = Math.floor(entity.position.y);
  const cz = Math.floor(entity.position.z);
  const minX = cx - radius;
  const minZ = cz - radius;
  const minY = cy - below;
  const nx = radius * 2 + 1;
  const nz = nx;
  const ny = below + above + 1;
  const data = Buffer.alloc(nx * ny * nz);
  const palette = [null];
  const paletteIndex = new Map();
  const stateIndex = new Map();
  const Vec3 = entity.position.constructor;
  const local = new Vec3(0, 0, 0);
  const worldMinY = Number.isFinite(bot.game && bot.game.minY) ? bot.game.minY : 0;
  const worldMaxY = worldMinY + (Number.isFinite(bot.game && bot.game.height) ? bot.game.height : 256);
  const y0 = Math.max(minY, worldMinY);
  const y1 = Math.min(minY + ny - 1, worldMaxY - 1);
  for (let chunkX = minX >> 4; chunkX <= (minX + nx - 1) >> 4; chunkX += 1) {
    for (let chunkZ = minZ >> 4; chunkZ <= (minZ + nz - 1) >> 4; chunkZ += 1) {
      const column = world.getColumn(chunkX, chunkZ);
      if (!column) continue;
      const xStart = Math.max(minX, chunkX * 16);
      const xEnd = Math.min(minX + nx - 1, chunkX * 16 + 15);
      const zStart = Math.max(minZ, chunkZ * 16);
      const zEnd = Math.min(minZ + nz - 1, chunkZ * 16 + 15);
      for (let z = zStart; z <= zEnd; z += 1) {
        local.z = z - chunkZ * 16;
        for (let x = xStart; x <= xEnd; x += 1) {
          local.x = x - chunkX * 16;
          const base = (z - minZ) * nx + (x - minX);
          for (let y = y0; y <= y1; y += 1) {
            local.y = y;
            const stateId = column.getBlockStateId(local);
            if (!stateId) continue;
            let index = stateIndex.get(stateId);
            if (index === undefined) {
              index = visionResolveState(registry, stateId, palette, paletteIndex);
              stateIndex.set(stateId, index);
            }
            if (index) data[(y - minY) * nz * nx + base] = index;
          }
        }
      }
    }
  }
  return {
    origin: { x: minX, y: minY, z: minZ },
    size: { x: nx, y: ny, z: nz },
    palette,
    data,
    ms: 0
  };
}

function visionEntityKind(entity) {
  const type = String(entity.type || '').toLowerCase();
  const kind = String(entity.kind || '').toLowerCase();
  const name = String(entity.name || '').toLowerCase();
  if (name === 'item') return 'item';
  if (type === 'player') return 'player';
  if (kind.includes('hostile') || type === 'hostile') return 'hostile';
  if (kind.includes('passive') || type === 'animal' || type === 'ambient') return 'passive';
  if (name === 'item' || type === 'object' || type === 'orb') return 'item';
  return 'other';
}

// Tên hiển thị của entity: người chơi, quái/động vật, hoặc tên vật phẩm rơi.
function visionEntityName(entity, kind) {
  try {
    if (entity.username) return String(entity.username);
    if (kind === 'item' && String(entity.name || '').toLowerCase() === 'item') {
      const stack = typeof entity.getDroppedItem === 'function' ? entity.getDroppedItem() : null;
      if (stack) return (stack.displayName || stack.name || 'Item') + (stack.count > 1 ? ' x' + stack.count : '');
      return 'Item';
    }
    return String(entity.displayName || entity.name || entity.type || 'Entity');
  } catch (_) { return 'Entity'; }
}

function buildVisionState(instance) {
  const bot = instance.bot;
  const self = bot && bot.entity;
  if (!self || !self.position) return null;
  const V = config.vision || {};
  const range = V.entityRange || 48; // 3 chunk
  const range2 = range * range;
  const entities = [];
  for (const id of Object.keys(bot.entities || {})) {
    const entity = bot.entities[id];
    if (!entity || entity === self || !entity.position) continue;
    const dx = entity.position.x - self.position.x;
    const dy = entity.position.y - self.position.y;
    const dz = entity.position.z - self.position.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > range2) continue;
    const kind = visionEntityKind(entity);
    entities.push({
      id: entity.id,
      k: kind,
      n: visionEntityName(entity, kind).slice(0, 40),
      x: entity.position.x,
      y: entity.position.y,
      z: entity.position.z,
      w: Number(entity.width) || (kind === 'item' ? 0.25 : 0.6),
      h: Number(entity.height) || (kind === 'item' ? 0.25 : 1.8),
      d2
    });
  }
  entities.sort((a, b) => a.d2 - b.d2);
  const max = V.maxEntities || 96;
  const trimmed = entities.slice(0, max).map(({ d2, ...rest }) => rest);
  return {
    x: self.position.x,
    y: self.position.y + 1.62,
    z: self.position.z,
    yaw: self.yaw,
    pitch: self.pitch,
    health: bot.health,
    food: bot.food,
    tod: bot.time && bot.time.timeOfDay,
    entities: trimmed
  };
}

const visionTimers = new Map();
// accId -> Map(socketId -> số chunk mà client đó muốn xem)
const visionViewers = new Map();

function visionClampChunks(value) {
  const V = config.vision || {};
  const lo = V.minChunks || 2;
  const hi = V.maxChunks || 5;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return V.defaultChunks || 3;
  return Math.max(lo, Math.min(hi, n));
}

function visionSetViewer(accId, socketId, chunks) {
  if (!visionViewers.has(accId)) visionViewers.set(accId, new Map());
  visionViewers.get(accId).set(socketId, visionClampChunks(chunks));
}

function visionRemoveViewer(accId, socketId) {
  const map = visionViewers.get(accId);
  if (!map) return;
  map.delete(socketId);
  if (!map.size) visionViewers.delete(accId);
}

// Bán kính (block) cần dựng = chunk lớn nhất trong các client đang xem bot này.
function visionRadiusFor(accId) {
  const map = visionViewers.get(accId);
  let chunks = (config.vision && config.vision.defaultChunks) || 3;
  if (map && map.size) chunks = Math.max(...map.values());
  return chunks * 16;
}

function visionRoom(id) { return VISION_ROOM_PREFIX + id; }

function visionSubscriberCount(id) {
  const room = io.sockets.adapter.rooms.get(visionRoom(id));
  return room ? room.size : 0;
}

function visionEnsureTimer(id) {
  if (visionTimers.has(id)) return;
  const V = config.vision || {};
  const timers = { stateTimer: null, worldTimer: null, dirty: true, lastAt: 0, lastRadius: 0, lastPos: null };
  timers.stateTimer = setInterval(() => {
    if (!visionSubscriberCount(id)) return;
    const instance = bots.get(id);
    if (!instance || instance.status !== 'online') return;
    const state = buildVisionState(instance);
    if (!state) return;
    io.to(visionRoom(id)).volatile.emit('vision-state', state);
  }, V.stateMs || 100);
  timers.worldTimer = setInterval(() => {
    if (!visionSubscriberCount(id)) return;
    const instance = bots.get(id);
    if (!instance || instance.status !== 'online') return;
    const entity = instance.bot && instance.bot.entity;
    if (!entity || !entity.position) return;
    const radius = visionRadiusFor(id);
    const pos = entity.position;
    const now = Date.now();
    const moved = timers.lastPos
      ? Math.hypot(pos.x - timers.lastPos.x, pos.y - timers.lastPos.y, pos.z - timers.lastPos.z)
      : Infinity;
    // Dựng lại khi: bị đánh dấu, đổi tầm nhìn, bot di chuyển >= 3 block, hoặc định kỳ (để thấy block thay đổi).
    // Tầm nhìn càng lớn thì snapshot càng nặng nên giãn khoảng cách giữa các lần dựng.
    const minGap = 800 + radius * 10;
    const maxGap = 2500 + radius * 25;
    const due = timers.dirty || radius !== timers.lastRadius
      || (moved >= 3 && now - timers.lastAt >= minGap)
      || now - timers.lastAt >= maxGap;
    if (!due) return;
    timers.dirty = false;
    try {
      const snapshot = buildVisionWorld(instance, radius);
      timers.lastAt = now;
      timers.lastRadius = radius;
      timers.lastPos = { x: pos.x, y: pos.y, z: pos.z };
      if (snapshot) io.to(visionRoom(id)).emit('vision-world', snapshot);
    } catch (e) {
      io.to(visionRoom(id)).emit('vision-error', { message: e.message });
    }
  }, V.worldMs || 500);
  visionTimers.set(id, timers);
}

function visionCleanup(id) {
  const timers = visionTimers.get(id);
  if (timers) {
    clearInterval(timers.stateTimer);
    clearInterval(timers.worldTimer);
    visionTimers.delete(id);
  }
}

function visionMarkDirty(id) {
  const timers = visionTimers.get(id);
  if (timers) timers.dirty = true;
}

// ============================================================
// PROXY CHECKER
// ============================================================
let activeProxyRequest = null;

function requestPublicIp(proxyUrl) {
  return new Promise((resolve, reject) => {
    let agent;
    try { agent = buildAgent(proxyUrl || ''); } catch (e) { reject(e); return; }
    const options = {
      agent,
      headers: { 'User-Agent': 'KingSMP-Panel/1.0', Accept: 'application/json' }
    };
    const request = https.get('https://api.ipify.org?format=json', options, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (c) => { body += c; });
      response.on('end', () => {
        if (activeProxyRequest === request) activeProxyRequest = null;
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error('API HTTP ' + response.statusCode));
          return;
        }
        try {
          const json = JSON.parse(body);
          if (!json.ip) throw new Error('Khong co truong ip.');
          resolve(String(json.ip));
        } catch (e) {
          reject(new Error('Khong doc duoc phan hoi: ' + e.message));
        }
      });
    });
    activeProxyRequest = request;
    request.setTimeout(10000, () => request.destroy(new Error('Timeout 10s.')));
    request.on('error', (e) => {
      if (activeProxyRequest === request) activeProxyRequest = null;
      reject(e);
    });
  });
}

// ============================================================
// REST API
// ============================================================
app.get('/api/accounts', (_req, res) => {
  const list = loadAccounts();
  res.json(list.map(a => ({
    id: a.id,
    username: a.username,
    proxy: a.proxy || '',
    status: bots.get(a.id) ? bots.get(a.id).status : 'offline'
  })));
});

app.post('/api/accounts', (req, res) => {
  const body = req.body || {};
  const username = body.username;
  const password = body.password;
  const proxy = body.proxy;
  if (!username || !password) return res.status(400).json({ ok: false, error: 'Thieu username hoac password.' });
  const list = loadAccounts();
  if (list.some(a => a.username === username)) return res.status(409).json({ ok: false, error: 'Acc da ton tai.' });
  const account = {
    id: 'acc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    username: String(username).trim(),
    password: String(password),
    proxy: String(proxy || '').trim(),
    createdAt: Date.now()
  };
  list.push(account);
  saveAccounts(list);
  spawnAccount(account);
  res.json({ ok: true, account: { id: account.id, username: account.username } });
});

app.delete('/api/accounts/:id', (req, res) => {
  const id = req.params.id;
  saveAccounts(loadAccounts().filter(a => a.id !== id));
  killAccount(id);
  res.json({ ok: true });
});

app.post('/api/accounts/:id/start', (req, res) => {
  const acc = loadAccounts().find(a => a.id === req.params.id);
  if (!acc) return res.status(404).json({ ok: false, error: 'Khong tim thay acc.' });
  spawnAccount(acc);
  res.json({ ok: true });
});

app.post('/api/accounts/:id/stop', (req, res) => {
  killAccount(req.params.id);
  res.json({ ok: true });
});

app.post('/api/accounts/:id/command', (req, res) => {
  const instance = bots.get(req.params.id);
  if (!instance || !instance.bot) return res.status(404).json({ ok: false, error: 'Bot chua online.' });
  const cmd = String((req.body && req.body.command) || '').trim();
  if (!cmd) return res.status(400).json({ ok: false, error: 'Lenh rong.' });
  try { instance.bot.chat(cmd); instance.log('[Lệnh gửi] ' + cmd, 'command'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/broadcast', (req, res) => {
  const cmd = String((req.body && req.body.command) || '').trim();
  if (!cmd) return res.status(400).json({ ok: false, error: 'Lenh rong.' });
  let count = 0;
  for (const instance of bots.values()) {
    if (instance.bot && instance.status === 'online') {
      try { instance.bot.chat(cmd); instance.log('[Broadcast] ' + cmd, 'command'); count++; } catch (_) {}
    }
  }
  res.json({ ok: true, sent: count });
});

// ============================================================
// Socket.IO
// ============================================================
io.on('connection', (socket) => {
  socket.emit('accounts-status', serializeBots());
  socket.on('request-status', broadcastStatus);

  socket.on('vision-subscribe', (payload) => {
    const accId = payload && payload.accId;
    if (!accId || !bots.has(accId)) {
      socket.emit('vision-error', { message: 'Acc khong ton tai.' });
      return;
    }
    socket.join(visionRoom(accId));
    visionSetViewer(accId, socket.id, payload.chunks);
    visionEnsureTimer(accId);
    visionMarkDirty(accId);
    const instance = bots.get(accId);
    if (instance && instance.status === 'online') {
      try {
        const snapshot = buildVisionWorld(instance, visionRadiusFor(accId));
        if (snapshot) socket.emit('vision-world', snapshot);
        const state = buildVisionState(instance);
        if (state) socket.emit('vision-state', state);
      } catch (e) {
        socket.emit('vision-error', { message: e.message });
      }
    }
  });

  // Client đổi tầm nhìn (2-5 chunk) khi đang xem.
  socket.on('vision-settings', (payload) => {
    const accId = payload && payload.accId;
    if (!accId || !bots.has(accId)) return;
    visionSetViewer(accId, socket.id, payload.chunks);
    visionMarkDirty(accId);
  });

  socket.on('disconnect', () => {
    for (const accId of Array.from(visionViewers.keys())) {
      visionRemoveViewer(accId, socket.id);
      if (!visionSubscriberCount(accId)) visionCleanup(accId);
    }
  });

  socket.on('vision-unsubscribe', (payload) => {
    const accId = payload && payload.accId;
    if (!accId) return;
    visionRemoveViewer(accId, socket.id);
    socket.leave(visionRoom(accId));
    if (!visionSubscriberCount(accId)) visionCleanup(accId);
  });

  socket.on('proxy-test', async (payload) => {
    const proxyUrl = String((payload && payload.proxyUrl) || '').trim();
    if (!proxyUrl) {
      socket.emit('proxy-result', { ok: false, title: 'Thieu Proxy URL', message: 'Nhap proxy truoc.' });
      return;
    }
    if (activeProxyRequest) {
      socket.emit('proxy-result', { ok: false, title: 'Dang ban', message: 'Co request khac dang chay.' });
      return;
    }
    try {
      const ip = await requestPublicIp(proxyUrl);
      socket.emit('proxy-result', { ok: true, title: 'Proxy hoat dong', ip: ip, message: 'IP public qua proxy: ' + ip });
    } catch (e) {
      socket.emit('proxy-result', { ok: false, title: 'Kiem tra that bai', message: e.message });
    }
  });

  socket.on('proxy-check-ip', async () => {
    if (activeProxyRequest) {
      socket.emit('proxy-result', { ok: false, title: 'Dang ban', message: 'Co request khac dang chay.' });
      return;
    }
    try {
      const ip = await requestPublicIp('');
      socket.emit('proxy-result', { ok: true, title: 'IP truc tiep', ip: ip, message: 'IP public truc tiep: ' + ip });
    } catch (e) {
      socket.emit('proxy-result', { ok: false, title: 'Kiem tra that bai', message: e.message });
    }
  });

  socket.on('proxy-stop', () => {
    if (activeProxyRequest) {
      const request = activeProxyRequest;
      activeProxyRequest = null;
      try { request.destroy(new Error('Cancelled')); } catch (_) {}
      socket.emit('proxy-stopped', { message: 'Da huy request.' });
    } else {
      socket.emit('proxy-stopped', { message: 'Khong co request nao.' });
    }
  });
});

// ============================================================
// BOOT
// ============================================================
const port = Number(process.env.PORT) || Number(config.webPort) || 3001;
server.listen(port, '0.0.0.0', () => {
  console.log('>>> Panel: http://localhost:' + port);
  autostartAll();
});