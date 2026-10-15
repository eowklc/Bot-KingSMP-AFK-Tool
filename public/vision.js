'use strict';
(() => {
  const api = window.KingSMP;
  const stage = document.getElementById('vision-stage');
  const canvas = document.getElementById('vision-canvas');
  const overlay = document.getElementById('vision-overlay');
  const placeholder = document.getElementById('vision-placeholder');
  const placeholderText = document.getElementById('vision-placeholder-text');
  const miniLog = document.getElementById('minilog');
  const miniLogStream = document.getElementById('minilog-stream');
  const miniLogInput = document.getElementById('minilog-input');
  const visionPage = document.getElementById('page-bot-vision');
  if (!api || !api.socket || !stage || !canvas || !overlay) return;

  const socket = api.socket;
  const ctx = canvas.getContext('2d', { alpha: false });
  const octx = overlay.getContext('2d');

  const TAU = Math.PI * 2;
  const MAX_FPS = 30;
  const QUALITY_ROWS = { low: 96, medium: 144, high: 216 };
  const ENTITY_COLORS = { player: '#4f8cff', hostile: '#ff5a5a', passive: '#4cc777', item: '#f0c24b', other: '#b99cff' };

  let currentAccId = null;
  let mode = 'bot';
  let paused = false;
  let pageActive = false;
  let subscribed = false;
  let botOnline = false;
  let errorText = '';
  let world = null;
  let target = null;
  let tod = 6000;
  let caveAmount = 0;
  let caveTarget = 0;
  const cam = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, ready: false };
  const freeLook = { yaw: 0, pitch: 0 };
  const entities = new Map();
  const settings = { quality: 'medium', fov: 70, chunks: 3, names: true, entCoords: false };
  const ENTITY_RANGE = 48; // 3 chunk
  let coordsHidden = false;
  let currentEffect = 'normal';
  function readVisionProfiles() {
    try { return JSON.parse(localStorage.getItem('kingsmp-vision-profiles') || '{}') || {}; }
    catch (_) { return {}; }
  }
  let visionProfiles = readVisionProfiles();
  function saveVisionPrefs(accId = currentAccId) {
    if (!accId) return;
    visionProfiles[accId] = {
      quality: settings.quality,
      fov: settings.fov,
      effect: currentEffect,
      mode,
      coordsHidden,
      chunks: settings.chunks,
      names: settings.names,
      entCoords: settings.entCoords
    };
    try { localStorage.setItem('kingsmp-vision-profiles', JSON.stringify(visionProfiles)); } catch (_) {}
  }
  function loadVisionPrefs(accId) {
    const profile = accId && visionProfiles[accId] ? visionProfiles[accId] : {};
    settings.quality = QUALITY_ROWS[profile.quality] ? profile.quality : 'medium';
    settings.fov = Math.max(40, Math.min(110, Number(profile.fov) || 70));
    currentEffect = ['normal', 'night', 'thermal', 'gray', 'retro', 'vivid', 'dream'].includes(profile.effect) ? profile.effect : 'normal';
    mode = profile.mode === 'free' ? 'free' : 'bot';
    coordsHidden = !!profile.coordsHidden;
    settings.chunks = Math.max(2, Math.min(5, Math.round(Number(profile.chunks)) || 3));
    settings.names = profile.names === undefined ? true : !!profile.names;
    settings.entCoords = !!profile.entCoords;
    syncChunkControls();
    const namesBox = document.getElementById('vision-names');
    const entCoordsBox = document.getElementById('vision-entity-coords');
    if (namesBox) namesBox.checked = settings.names;
    if (entCoordsBox) entCoordsBox.checked = settings.entCoords;
    const qualityControl = document.getElementById('vision-quality');
    const effectControl = document.getElementById('vision-effect');
    const fovControl = document.getElementById('vision-fov');
    const fovLabel = document.getElementById('vision-fov-value');
    if (qualityControl) qualityControl.value = settings.quality;
    if (effectControl) effectControl.value = currentEffect;
    if (fovControl) fovControl.value = String(settings.fov);
    if (fovLabel) fovLabel.textContent = settings.fov + '°';
    stage.dataset.effect = currentEffect;
    document.querySelectorAll('[data-vision-mode]').forEach(btn => btn.classList.toggle('active', btn.dataset.visionMode === mode));
    if (visionPage) visionPage.classList.toggle('hide-coords', coordsHidden);
    const coordsBtn = document.getElementById('vision-coords-toggle');
    if (coordsBtn) coordsBtn.textContent = coordsHidden ? '◉ Hiện tọa độ' : '◌ Ẩn tọa độ';
    dirty = true;
    requestAnimationFrame(resize);
  }

  let imageData = null, pixels = null, depth = null, ndcXs = null, ndcYs = null;
  let dpr = 1, dirty = true, raf = 0, lastRender = 0, frames = 0;
  let fpsStamp = performance.now(), fps = 0, renderMs = 0;

  function resize() {
    const rect = stage.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    if (w < 8 || h < 8) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const rows = QUALITY_ROWS[settings.quality];
    const cols = Math.max(32, Math.round((rows * w) / h));
    if (canvas.width !== cols || canvas.height !== rows) {
      canvas.width = cols;
      canvas.height = rows;
      imageData = ctx.createImageData(cols, rows);
      pixels = new Uint32Array(imageData.data.buffer);
      depth = new Float32Array(cols * rows);
      ndcXs = new Float32Array(cols);
      ndcYs = new Float32Array(rows);
    }
    overlay.width = Math.round(w * dpr);
    overlay.height = Math.round(h * dpr);
    dirty = true;
  }

  function dayLight(time) {
    const t = ((time % 24000) + 24000) % 24000;
    if (t < 12000) return 1;
    if (t < 13800) return 1 - ((t - 12000) / 1800) * 0.75;
    if (t < 22200) return 0.25;
    return 0.25 + ((t - 22200) / 1800) * 0.75;
  }

  function mix(a, b, f) { return a + (b - a) * f; }
  function angleDelta(from, to) {
    let d = (to - from) % TAU;
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    return d;
  }

  function stepCamera(dt) {
    if (!target) return false;
    let moved = false;
    const k = 1 - Math.exp(-dt * 18);
    const kRot = mode === 'free' ? 1 - Math.exp(-dt * 40) : k;
    const dx = target.x - cam.x, dy = target.y - cam.y, dz = target.z - cam.z;
    if (dx * dx + dy * dy + dz * dz > 144) {
      cam.x = target.x; cam.y = target.y; cam.z = target.z; moved = true;
    } else {
      cam.x += dx * k; cam.y += dy * k; cam.z += dz * k;
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1e-3) moved = true;
    }
    const tYaw = mode === 'bot' ? target.yaw : freeLook.yaw;
    const tPitch = mode === 'bot' ? target.pitch : freeLook.pitch;
    const dYaw = angleDelta(cam.yaw, tYaw);
    const dPitch = tPitch - cam.pitch;
    cam.yaw += dYaw * kRot;
    cam.pitch += dPitch * kRot;
    if (Math.abs(dYaw) > 1e-3 || Math.abs(dPitch) > 1e-3) moved = true;
    for (const e of entities.values()) {
      const ex = e.x - e.dx, ey = e.y - e.dy, ez = e.z - e.dz;
      e.dx += ex * k; e.dy += ey * k; e.dz += ez * k;
      if (Math.abs(ex) + Math.abs(ey) + Math.abs(ez) > 1e-3) moved = true;
    }
    if (Math.abs(caveAmount - caveTarget) > 0.01) {
      caveAmount += (caveTarget - caveAmount) * (1 - Math.exp(-dt * 3));
      moved = true;
    }
    return moved;
  }

  function renderWorld() {
    const W = canvas.width, H = canvas.height;
    const w = world;
    if (!w) return;
    const { data, nx, ny, nz } = w;
    const sinY = Math.sin(cam.yaw), cosY = Math.cos(cam.yaw);
    const sinP = Math.sin(cam.pitch), cosP = Math.cos(cam.pitch);
    const fx = -sinY * cosP, fy = sinP, fz = -cosY * cosP;
    const rx = cosY, rz = -sinY;
    const ux = sinY * sinP, uy = cosP, uz = cosY * sinP;
    const tanH = Math.tan((settings.fov * Math.PI) / 360);
    const aspect = W / H;
    for (let x = 0; x < W; x++) ndcXs[x] = (((x + 0.5) / W) * 2 - 1) * tanH * aspect;
    for (let y = 0; y < H; y++) ndcYs[y] = (1 - ((y + 0.5) / H) * 2) * tanH;
    const px = cam.x - w.ox, py = cam.y - w.oy, pz = cam.z - w.oz;
    const bx = Math.floor(px), by = Math.floor(py), bz = Math.floor(pz);
    const insideGrid = bx >= 0 && by >= 0 && bz >= 0 && bx < nx && by < ny && bz < nz;
    let inWater = false;
    caveTarget = 0;
    if (insideGrid) {
      inWater = w.pw[data[(by * nz + bz) * nx + bx]] === 1;
      let solids = 0;
      for (let yy = by + 2; yy < ny; yy++) {
        const id = data[(yy * nz + bz) * nx + bx];
        if (id && w.pa[id] >= 1 && !w.pl[id]) solids++;
      }
      caveTarget = solids >= 2 ? 1 : 0;
    }
    const light = dayLight(tod);
    const night = 1 - light;
    const cave = caveAmount;
    const hr = mix(mix(190, 18, night), 12, cave);
    const hg = mix(mix(218, 24, night), 13, cave);
    const hb = mix(mix(245, 48, night), 17, cave);
    const zr = mix(mix(96, 6, night), 12, cave) - hr;
    const zg = mix(mix(152, 9, night), 13, cave) - hg;
    const zb = mix(mix(232, 24, night), 17, cave) - hb;
    const brightness = (0.45 + 0.55 * light) * (1 - cave * 0.3);
    // Tầm nhìn do người dùng chọn (2-5 chunk), không vượt quá vùng server đã gửi.
    const viewBlocks = Math.min(settings.chunks * 16, Math.min(nx, nz) / 2 - 2);
    const fogEnd = viewBlocks - cave * 4;
    const fogStart = Math.max(7, viewBlocks * 0.4) - cave * 4;
    const fogRange = Math.max(1, fogEnd - fogStart);
    const maxSteps = nx + ny + nz;
    const pr = w.pr, pg = w.pg, pb = w.pb, tr = w.tr, tg = w.tg, tb = w.tb, pa = w.pa;
    for (let y = 0; y < H; y++) {
      const ndcY = ndcYs[y];
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const ndcX = ndcXs[x];
        let dx = fx + rx * ndcX + ux * ndcY;
        let dy = fy + uy * ndcY;
        let dz = fz + rz * ndcX + uz * ndcY;
        if (Math.abs(dx) < 1e-9) dx = 1e-9;
        if (Math.abs(dy) < 1e-9) dy = 1e-9;
        if (Math.abs(dz) < 1e-9) dz = 1e-9;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        let r = 0, g = 0, b = 0, trans = 1, hitDepth = Infinity;
        if (insideGrid) {
          const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
          const tdx = Math.abs(1 / dx), tdy = Math.abs(1 / dy), tdz = Math.abs(1 / dz);
          let tmx = dx > 0 ? (bx + 1 - px) * tdx : (px - bx) * tdx;
          let tmy = dy > 0 ? (by + 1 - py) * tdy : (py - by) * tdy;
          let tmz = dz > 0 ? (bz + 1 - pz) * tdz : (pz - bz) * tdz;
          let ix = bx, iy = by, iz = bz;
          const tLimit = fogEnd / len;
          for (let step = 0; step < maxSteps; step++) {
            let t, face;
            if (tmx < tmy && tmx < tmz) { ix += stepX; t = tmx; tmx += tdx; face = 0; }
            else if (tmy < tmz) { iy += stepY; t = tmy; tmy += tdy; face = 1; }
            else { iz += stepZ; t = tmz; tmz += tdz; face = 2; }
            if (t > tLimit || ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) break;
            const id = data[(iy * nz + iz) * nx + ix];
            if (id === 0) continue;
            let cr, cg, cb, shade;
            if (face === 1) {
              if (stepY < 0) { cr = tr[id]; cg = tg[id]; cb = tb[id]; shade = 1; }
              else { cr = pr[id]; cg = pg[id]; cb = pb[id]; shade = 0.55; }
            } else {
              cr = pr[id]; cg = pg[id]; cb = pb[id];
              shade = face === 0 ? 0.8 : 0.68;
            }
            const hx = px + dx * t, hy = py + dy * t, hz = pz + dz * t;
            let u, v;
            if (face === 0) { u = hz - iz; v = hy - iy; }
            else if (face === 1) { u = hx - ix; v = hz - iz; }
            else { u = hx - ix; v = hy - iy; }
            let h = Math.imul(ix + w.ox, 73856093) ^ Math.imul(iy + w.oy, 19349663) ^ Math.imul(iz + w.oz, 83492791);
            h = Math.imul(h ^ (h >>> 15), 2246822519);
            h ^= h >>> 13;
            shade *= 0.9 + ((h & 255) / 255) * 0.16;
            shade *= brightness;
            const dist = t * len;
            const fog = dist > fogStart ? Math.min(1, (dist - fogStart) / fogRange) : 0;
            const keep = 1 - fog;
            const lr = cr * shade * keep + hr * fog;
            const lg = cg * shade * keep + hg * fog;
            const lb = cb * shade * keep + hb * fog;
            const alpha = pa[id];
            if (alpha >= 1) {
              r += trans * lr; g += trans * lg; b += trans * lb;
              trans = 0; hitDepth = t; break;
            }
            const weight = trans * alpha;
            r += weight * lr; g += weight * lg; b += weight * lb;
            trans *= 1 - alpha;
            if (trans < 0.04) { hitDepth = t; trans = 0; break; }
          }
        }
        if (trans > 0.001) {
          let st = dy / len;
          st = st > 0 ? Math.pow(st, 0.55) : 0;
          r += trans * (hr + zr * st);
          g += trans * (hg + zg * st);
          b += trans * (hb + zb * st);
        }
        if (inWater) {
          r = r * 0.62 + 18;
          g = g * 0.74 + 52;
          b = b * 0.9 + 112;
        }
        depth[row + x] = hitDepth;
        pixels[row + x] = 0xff000000
          | ((Math.min(255, b) | 0) << 16)
          | ((Math.min(255, g) | 0) << 8)
          | (Math.min(255, r) | 0);
      }
    }
    ctx.putImageData(imageData, 0, 0);
  }

  // Nhãn tên (và tọa độ) entity/item trong bán kính 3 chunk. Gần vẽ trước, nhãn chồng nhau thì bỏ.
  function drawEntityLabels(list, OW, OH) {
    const placed = [];
    const showXYZ = settings.entCoords && !coordsHidden;
    octx.textAlign = 'left';
    octx.textBaseline = 'top';
    let drawn = 0;
    for (const it of list) {
      if (drawn >= 40) break;
      const name = it.e.n;
      if (!name) continue;
      const size = Math.round(Math.max(8, Math.min(12, 12 - it.dist / 14)) * dpr);
      const lineH = Math.round(size * 1.25);
      const pad = Math.round(3 * dpr);
      octx.font = '600 ' + size + 'px "JetBrains Mono", monospace';
      const lines = [name + ' · ' + Math.round(it.dist) + 'm'];
      if (showXYZ) lines.push(Math.round(it.e.dx) + ' ' + Math.round(it.e.dy) + ' ' + Math.round(it.e.dz));
      let textW = 0;
      for (const line of lines) textW = Math.max(textW, octx.measureText(line).width);
      const w = Math.ceil(textW + pad * 2);
      const h = lines.length * lineH + pad * 2 - Math.round((lineH - size) / 2);
      let x = Math.max(2, Math.min(OW - w - 2, it.cx - w / 2));
      let y = it.cy - it.bh / 2 - h - 3 * dpr;
      if (y < 2) y = it.cy + it.bh / 2 + 3 * dpr;
      if (y + h > OH - 2) continue;
      let overlap = false;
      for (const r of placed) {
        if (x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y) { overlap = true; break; }
      }
      if (overlap) continue;
      placed.push({ x, y, w, h });
      drawn += 1;
      octx.fillStyle = 'rgba(8,12,18,.66)';
      octx.fillRect(x, y, w, h);
      octx.fillStyle = it.color;
      octx.fillRect(x, y, Math.max(2, Math.round(2 * dpr)), h);
      for (let i = 0; i < lines.length; i += 1) {
        octx.fillStyle = i === 0 ? '#ffffff' : '#c9d4e3';
        octx.fillText(lines[i], x + pad + Math.round(2 * dpr), y + pad + i * lineH);
      }
    }
    octx.textAlign = 'start';
    octx.textBaseline = 'alphabetic';
  }

  function drawOverlay() {
    const OW = overlay.width, OH = overlay.height;
    octx.clearRect(0, 0, OW, OH);
    const sinY = Math.sin(cam.yaw), cosY = Math.cos(cam.yaw);
    const sinP = Math.sin(cam.pitch), cosP = Math.cos(cam.pitch);
    const fx = -sinY * cosP, fy = sinP, fz = -cosY * cosP;
    const rx = cosY, rz = -sinY;
    const ux = sinY * sinP, uy = cosP, uz = cosY * sinP;
    const tanH = Math.tan((settings.fov * Math.PI) / 360);
    const aspect = canvas.width / canvas.height;
    const visible = [];
    for (const e of entities.values()) {
      const relx = e.dx - cam.x, rely = e.dy + e.h * 0.5 - cam.y, relz = e.dz - cam.z;
      const depthF = relx * fx + rely * fy + relz * fz;
      if (depthF < 0.4 || depthF > ENTITY_RANGE + 4) continue;
      const nxp = (relx * rx + relz * rz) / (depthF * tanH * aspect);
      const nyp = (relx * ux + rely * uy + relz * uz) / (depthF * tanH);
      if (Math.abs(nxp) > 1.5 || Math.abs(nyp) > 1.5) continue;
      const cx = (nxp * 0.5 + 0.5) * OW;
      const cy = (0.5 - nyp * 0.5) * OH;
      const scale = OH / (2 * tanH * depthF);
      visible.push({
        e, cx, cy, depthF,
        dist: Math.sqrt(relx * relx + rely * rely + relz * relz),
        bw: Math.max(5 * dpr, e.w * scale),
        bh: Math.max(5 * dpr, e.h * scale),
        color: ENTITY_COLORS[e.k] || ENTITY_COLORS.other
      });
    }
    visible.sort((p, q) => p.depthF - q.depthF);
    for (const it of visible) {
      octx.globalAlpha = 0.22;
      octx.fillStyle = it.color;
      octx.fillRect(it.cx - it.bw / 2, it.cy - it.bh / 2, it.bw, it.bh);
      octx.globalAlpha = 0.95;
      octx.strokeStyle = it.color;
      octx.strokeRect(it.cx - it.bw / 2, it.cy - it.bh / 2, it.bw, it.bh);
    }
    octx.globalAlpha = 1;
    if (settings.names) drawEntityLabels(visible, OW, OH);
    if (mode === 'bot') {
      const cx = OW / 2, cy = OH / 2, arm = 7 * dpr;
      octx.lineWidth = 3 * dpr;
      octx.strokeStyle = 'rgba(0,0,0,.45)';
      octx.beginPath();
      octx.moveTo(cx - arm, cy); octx.lineTo(cx + arm, cy);
      octx.moveTo(cx, cy - arm); octx.lineTo(cx, cy + arm);
      octx.stroke();
      octx.lineWidth = 1.2 * dpr;
      octx.strokeStyle = 'rgba(255,255,255,.9)';
      octx.stroke();
    }
  }

  function updateHud() {
    if (!target) return;
    const set = (id, txt) => { const el = document.getElementById(id); if (el && el.textContent !== txt) el.textContent = txt; };
    const feetY = cam.y - 1.62;
    set('vision-chip-pos', cam.x.toFixed(1) + ', ' + feetY.toFixed(1) + ', ' + cam.z.toFixed(1));
    set('vision-chip-facing', Math.round(((-cam.yaw * 180) / Math.PI % 360 + 360) % 360) + '°');
    set('vision-info-pos', cam.x.toFixed(2) + ', ' + feetY.toFixed(2) + ', ' + cam.z.toFixed(2));
    const hp = Number.isFinite(target.health) ? (target.health / 2).toFixed(1) + '/10' : '—';
    const food = Number.isFinite(target.food) ? (target.food / 2).toFixed(1) + '/10' : '—';
    set('vision-info-vitals', hp + ' · ' + food);
    set('vision-info-chunk', Math.floor(cam.x / 16) + ', ' + Math.floor(cam.z / 16));
    let mobs = 0, drops = 0;
    for (const e of entities.values()) { if (e.k === 'item') drops += 1; else mobs += 1; }
    set('vision-info-entities', mobs + ' · ' + drops);
    set('vision-info-fps', fps + ' FPS · ' + renderMs.toFixed(0) + ' ms');
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - lastRender < 1000 / MAX_FPS - 1) return;
    const dt = Math.min(0.1, (now - lastRender) / 1000);
    lastRender = now;
    const moved = stepCamera(dt);
    if (!dirty && !moved) return;
    dirty = false;
    if (!world || !cam.ready || !botOnline || !pixels) return;
    const started = performance.now();
    renderWorld();
    drawOverlay();
    renderMs = performance.now() - started;
    frames++;
    if (now - fpsStamp >= 1000) {
      fps = Math.round((frames * 1000) / (now - fpsStamp));
      frames = 0;
      fpsStamp = now;
    }
  }

  function startLoop() {
    if (raf) return;
    lastRender = performance.now();
    dirty = true;
    raf = requestAnimationFrame(frame);
  }
  function stopLoop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  function toBytes(raw) {
    if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
    if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    return null;
  }

  function updatePlaceholder() {
    let text = '';
    if (errorText) text = errorText;
    else if (!currentAccId) text = 'Chọn acc ở trên để xem.';
    else if (!botOnline) text = 'Bot đang offline.';
    else if (!world) text = 'Đang tải dữ liệu thế giới...';
    placeholder.hidden = !text;
    if (placeholderText) placeholderText.textContent = text;
  }

  socket.on('vision-world', (payload) => {
    try {
      const bytes = toBytes(payload && payload.data);
      const origin = payload && payload.origin;
      const size = payload && payload.size;
      const palette = payload && payload.palette;
      if (!bytes || !origin || !size || bytes.length !== size.x * size.y * size.z) return;
      const count = 256;
      const next = {
        ox: origin.x, oy: origin.y, oz: origin.z,
        nx: size.x, ny: size.y, nz: size.z,
        data: bytes,
        pr: new Float32Array(count), pg: new Float32Array(count), pb: new Float32Array(count),
        tr: new Float32Array(count), tg: new Float32Array(count), tb: new Float32Array(count),
        pa: new Float32Array(count).fill(1),
        pw: new Uint8Array(count), pl: new Uint8Array(count)
      };
      (palette || []).forEach((info, i) => {
        if (!info || i >= count) return;
        const top = info.t || info.c;
        next.pr[i] = info.c[0]; next.pg[i] = info.c[1]; next.pb[i] = info.c[2];
        next.tr[i] = top[0]; next.tg[i] = top[1]; next.tb[i] = top[2];
        next.pa[i] = info.a === undefined ? 1 : info.a;
        next.pw[i] = info.w ? 1 : 0;
        next.pl[i] = info.l ? 1 : 0;
      });
      world = next;
      errorText = '';
      dirty = true;
      updatePlaceholder();
    } catch (e) {
      errorText = 'Lỗi đọc snapshot: ' + e.message;
      updatePlaceholder();
    }
  });

  socket.on('vision-state', (state) => {
    if (!state || !Number.isFinite(state.x)) return;
    botOnline = true;
    target = state;
    updatePlaceholder();
    if (Number.isFinite(state.tod)) tod = state.tod;
    if (!cam.ready) {
      cam.x = state.x; cam.y = state.y; cam.z = state.z;
      cam.yaw = state.yaw || 0; cam.pitch = state.pitch || 0;
      freeLook.yaw = cam.yaw; freeLook.pitch = cam.pitch;
      cam.ready = true;
    }
    const seen = new Set();
    for (const e of state.entities || []) {
      seen.add(e.id);
      const existing = entities.get(e.id);
      if (existing) Object.assign(existing, e);
      else entities.set(e.id, Object.assign({}, e, { dx: e.x, dy: e.y, dz: e.z }));
    }
    for (const id of Array.from(entities.keys())) if (!seen.has(id)) entities.delete(id);
    dirty = true;
  });

  socket.on('vision-error', (payload) => {
    errorText = String((payload && payload.message) || 'Vision gặp lỗi.');
    updatePlaceholder();
  });

  socket.on('accounts-status', (list) => {
    if (!currentAccId || !Array.isArray(list)) return;
    const acc = list.find(item => item.id === currentAccId);
    if (acc) {
      botOnline = acc.status === 'online';
      const statusText = document.getElementById('vision-status-text');
      if (statusText) statusText.textContent = 'Vision riêng · ' + acc.username + ' · ' + (acc.status || 'offline');
      updatePlaceholder();
    }
  });

  function appendMiniLog(entry) {
  if (!miniLogStream || !entry) return;
  const row = document.createElement('div');
  row.className = 'minilog-line ' + (entry.type || 'system');
  const time = document.createElement('span');
  time.className = 'mini-time';
  time.textContent = entry.time || new Date(entry.timestamp || Date.now()).toLocaleTimeString('vi-VN', { hour12: false });
  const msg = document.createElement('span');
  msg.className = 'mini-message';
  const prefix = entry.username ? '[' + entry.username + '] ' : '';
  const body = document.createElement('span');
  
  // Xử lý vẽ segments có màu cho mini log
  if (Array.isArray(entry.segments) && entry.segments.length > 0) {
    entry.segments.forEach(seg => {
      const span = document.createElement('span');
      span.textContent = seg.t;
      if (seg.c) span.style.color = seg.c;
      if (seg.b) span.style.fontWeight = '700';
      if (seg.i) span.style.fontStyle = 'italic';
      body.appendChild(span);
    });
  } else {
    body.textContent = String(entry.message || '');
  }

  msg.append(prefix, body);
  row.append(time, msg);
  miniLogStream.appendChild(row);
  while (miniLogStream.children.length > 150) miniLogStream.firstElementChild.remove();
  miniLogStream.scrollTop = miniLogStream.scrollHeight;
}

  function loadMiniLogHistory(accId) {
    if (!miniLogStream) return;
    miniLogStream.replaceChildren();
    if (!accId || !api.getLogsForAccount) return;
    for (const entry of api.getLogsForAccount(accId).slice(-100)) appendMiniLog(entry);
    const name = document.getElementById('minilog-bot-name');
    const acc = (api.getAccounts && api.getAccounts().find(item => item.id === accId)) || null;
    if (name) name.textContent = acc ? acc.username : 'Bot';
  }

  // ---- Scale & resize mini log ----
  const MINI_KEY = 'kingsmp-minilog-prefs';
  const miniPrefs = { scale: 1, w: 420, h: 310 };
  try { Object.assign(miniPrefs, JSON.parse(localStorage.getItem(MINI_KEY) || '{}')); } catch (_) {}
  const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function saveMiniPrefs() {
    try { localStorage.setItem(MINI_KEY, JSON.stringify(miniPrefs)); } catch (_) {}
  }

  function applyMiniPrefs() {
    if (!miniLog) return;
    miniPrefs.scale = clampNum(Number(miniPrefs.scale) || 1, 0.7, 2);
    const maxW = Math.max(240, stage.clientWidth - 24);
    const maxH = Math.max(160, stage.clientHeight - 24);
    miniLog.style.setProperty('--mini-scale', String(miniPrefs.scale));
    miniLog.style.width = clampNum(Number(miniPrefs.w) || 420, 240, maxW) + 'px';
    miniLog.style.height = clampNum(Number(miniPrefs.h) || 310, 160, maxH) + 'px';
    const label = document.getElementById('minilog-scale-label');
    if (label) label.textContent = Math.round(miniPrefs.scale * 100) + '%';
  }

  function setMiniScale(value) {
    miniPrefs.scale = Math.round(clampNum(value, 0.7, 2) * 100) / 100;
    applyMiniPrefs();
    saveMiniPrefs();
  }

  function initMiniResize() {
    const handle = document.getElementById('minilog-resize');
    if (!handle || !miniLog) return;
    let start = null;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      start = { id: e.pointerId, x: e.clientX, y: e.clientY, w: miniLog.offsetWidth, h: miniLog.offsetHeight };
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return;
      // Tay nắm ở góc trên-phải: kéo sang phải = rộng hơn, kéo lên = cao hơn.
      miniPrefs.w = start.w + (e.clientX - start.x);
      miniPrefs.h = start.h - (e.clientY - start.y);
      applyMiniPrefs();
    });
    const end = (e) => {
      if (!start || e.pointerId !== start.id) return;
      start = null;
      saveMiniPrefs();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('dblclick', () => { miniPrefs.w = 420; miniPrefs.h = 310; miniPrefs.scale = 1; applyMiniPrefs(); saveMiniPrefs(); });
  }

  function setMiniLogOpen(open) {
    if (!miniLog) return;
    miniLog.hidden = !open;
    if (open) applyMiniPrefs();
    const toggle = document.getElementById('vision-minilog-toggle');
    if (toggle) toggle.classList.toggle('active', !!open);
    if (open) {
      loadMiniLogHistory(currentAccId);
      if (!currentAccId) {
        if (miniLogStream) miniLogStream.textContent = 'Chọn bot trước khi gửi lệnh.';
      } else if (miniLogInput) miniLogInput.focus();
    }
  }

  document.addEventListener('kingsmp:bot-log', (event) => {
    const entry = event.detail;
    if (entry && currentAccId && entry.id === currentAccId) appendMiniLog(entry);
  });

  function switchAcc(oldId, newId) {
    if (oldId && subscribed) socket.emit('vision-unsubscribe', { accId: oldId });
    if (oldId) saveVisionPrefs(oldId);
    currentAccId = newId;
    subscribed = false;
    loadVisionPrefs(newId);
    loadMiniLogHistory(newId);
    if (!newId) {
      world = null; target = null; cam.ready = false; entities.clear();
      botOnline = false;
      stopLoop();
      updatePlaceholder();
      return;
    }
    botOnline = false;
    world = null; target = null; cam.ready = false; entities.clear();
    errorText = '';
    sync();
    updatePlaceholder();
  }

  function sync() {
    const run = pageActive && !paused && !document.hidden && currentAccId;
    if (run && !subscribed) {
      subscribed = true;
      socket.emit('vision-subscribe', { accId: currentAccId, chunks: settings.chunks });
      startLoop();
    } else if (!run && subscribed) {
      subscribed = false;
      if (currentAccId) socket.emit('vision-unsubscribe', { accId: currentAccId });
      stopLoop();
    }
    const lbl = document.getElementById('vision-live-label');
    if (lbl) lbl.textContent = paused ? 'TẠM DỪNG' : 'LIVE';
    const pb = document.getElementById('vision-pause');
    if (pb) pb.textContent = paused ? 'Tiếp tục' : 'Tạm dừng';
    updatePlaceholder();
  }

  document.addEventListener('kingsmp:page', (event) => {
    pageActive = event.detail && event.detail.page === 'bot-vision';
    sync();
    if (pageActive) requestAnimationFrame(resize);
  });
  document.addEventListener('visibilitychange', sync);

  const pb = document.getElementById('vision-pause');
  if (pb) pb.addEventListener('click', () => { paused = !paused; sync(); });

  document.querySelectorAll('[data-vision-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      mode = btn.dataset.visionMode;
      if (mode === 'free') { freeLook.yaw = cam.yaw; freeLook.pitch = cam.pitch; }
      document.querySelectorAll('[data-vision-mode]').forEach(b => b.classList.toggle('active', b === btn));
      dirty = true;
      saveVisionPrefs();
    });
  });

  const qs = document.getElementById('vision-quality');
  if (qs) qs.addEventListener('change', (e) => {
    settings.quality = QUALITY_ROWS[e.target.value] ? e.target.value : 'medium';
    resize();
    saveVisionPrefs();
  });

  const effectSelect = document.getElementById('vision-effect');
  if (effectSelect) effectSelect.addEventListener('change', () => {
    currentEffect = effectSelect.value || 'normal';
    stage.dataset.effect = currentEffect;
    saveVisionPrefs();
    stage.classList.remove('effect-change');
    void stage.offsetWidth;
    stage.classList.add('effect-change');
    setTimeout(() => stage.classList.remove('effect-change'), 420);
  });

  const fovControl = document.getElementById('vision-fov');
  const fovValue = document.getElementById('vision-fov-value');
  function setFov(value) {
    settings.fov = Math.max(40, Math.min(110, Number(value) || 70));
    if (fovControl) fovControl.value = String(settings.fov);
    if (fovValue) fovValue.textContent = settings.fov + '°';
    dirty = true;
    saveVisionPrefs();
  }
  if (fovControl) fovControl.addEventListener('input', (e) => setFov(e.target.value));

  // ---- Tầm nhìn bot (2-5 chunk) ----
  const chunksControl = document.getElementById('vision-chunks');
  function syncChunkControls() {
    const control = document.getElementById('vision-chunks');
    const label = document.getElementById('vision-chunks-value');
    if (control) control.value = String(settings.chunks);
    if (label) label.textContent = settings.chunks + ' chunk · ' + settings.chunks * 16 + ' block';
  }
  function setChunks(value) {
    settings.chunks = Math.max(2, Math.min(5, Math.round(Number(value)) || 3));
    syncChunkControls();
    dirty = true;
    saveVisionPrefs();
    if (subscribed && currentAccId) socket.emit('vision-settings', { accId: currentAccId, chunks: settings.chunks });
  }
  if (chunksControl) chunksControl.addEventListener('input', (e) => setChunks(e.target.value));
  syncChunkControls();

  const namesBox = document.getElementById('vision-names');
  if (namesBox) namesBox.addEventListener('change', () => { settings.names = namesBox.checked; dirty = true; saveVisionPrefs(); });
  const entCoordsBox = document.getElementById('vision-entity-coords');
  if (entCoordsBox) entCoordsBox.addEventListener('change', () => { settings.entCoords = entCoordsBox.checked; dirty = true; saveVisionPrefs(); });
  stage.addEventListener('wheel', (e) => {
    if (e.target && e.target.closest && e.target.closest('.minilog')) return;
    e.preventDefault();
    setFov(settings.fov + (e.deltaY > 0 ? 5 : -5));
  }, { passive: false });

  const coordsToggle = document.getElementById('vision-coords-toggle');
  if (coordsToggle) coordsToggle.addEventListener('click', () => {
    coordsHidden = !coordsHidden;
    if (visionPage) visionPage.classList.toggle('hide-coords', coordsHidden);
    coordsToggle.textContent = coordsHidden ? '◉ Hiện tọa độ' : '◌ Ẩn tọa độ';
    saveVisionPrefs();
  });

  const fullscreenBtn = document.getElementById('vision-fullscreen');
  if (fullscreenBtn) fullscreenBtn.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement === stage) await document.exitFullscreen();
      else if (stage.requestFullscreen) await stage.requestFullscreen();
      else stage.classList.toggle('is-theater');
    } catch (_) { stage.classList.toggle('is-theater'); }
    requestAnimationFrame(resize);
  });
  document.addEventListener('fullscreenchange', () => {
    if (fullscreenBtn) fullscreenBtn.textContent = document.fullscreenElement === stage ? '⤡ Thu nhỏ' : '⛶ Toàn màn hình';
    requestAnimationFrame(resize);
  });

  const miniToggle = document.getElementById('vision-minilog-toggle');
  const miniClose = document.getElementById('minilog-close');
  if (miniToggle) miniToggle.addEventListener('click', () => setMiniLogOpen(miniLog ? miniLog.hidden : true));
  if (miniClose) miniClose.addEventListener('click', (e) => { e.stopPropagation(); setMiniLogOpen(false); });
  const scaleDown = document.getElementById('minilog-scale-down');
  const scaleUp = document.getElementById('minilog-scale-up');
  if (scaleDown) scaleDown.addEventListener('click', () => setMiniScale(miniPrefs.scale - 0.1));
  if (scaleUp) scaleUp.addEventListener('click', () => setMiniScale(miniPrefs.scale + 0.1));
  if (miniLog) miniLog.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setMiniScale(miniPrefs.scale + (e.deltaY > 0 ? -0.1 : 0.1));
  }, { passive: false });
  initMiniResize();
  applyMiniPrefs();
  const miniForm = document.getElementById('minilog-form');
  if (miniForm) miniForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cmd = miniLogInput ? miniLogInput.value.trim() : '';
    if (!cmd) return;
    if (!currentAccId) {
      if (api.showToast) api.showToast('Chọn bot trước khi gửi lệnh.', 'error');
      return;
    }
    const sent = await api.sendCommand(currentAccId, cmd);
    if (sent && miniLogInput) miniLogInput.value = '';
    if (miniLogInput) miniLogInput.focus();
  });
  document.addEventListener('keydown', (e) => {
    if (!pageActive || e.ctrlKey || e.altKey || e.metaKey) return;
    const tag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : '';
    const isTyping = tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable);
    if (e.key.toLowerCase() === 'm' && !isTyping) {
      e.preventDefault();
      setMiniLogOpen(!!(miniLog && miniLog.hidden));
    } else if (e.key === 'Escape' && e.target === miniLogInput) {
      e.preventDefault();
      miniLogInput.blur();
      stage.focus();
    }
  });

  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // Không kéo camera / bắt pointer khi bấm vào log nhanh, nút zoom hoặc các control khác.
    if (e.target && e.target.closest && e.target.closest('.minilog, button, input, select, textarea')) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('is-dragging');
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (mode !== 'free') {
      mode = 'free';
      document.querySelectorAll('[data-vision-mode]').forEach(b => b.classList.toggle('active', b.dataset.visionMode === 'free'));
    }
    freeLook.yaw -= dx * 0.005;
    freeLook.pitch = Math.max(-1.55, Math.min(1.55, freeLook.pitch - dy * 0.005));
    dirty = true;
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    stage.classList.remove('is-dragging');
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(stage);
  window.addEventListener('resize', () => { resize(); applyMiniPrefs(); });

  window.KingSMPVision = { switchAcc };
  resize();
})();
