'use strict';

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

let ws = null;
let myId = null;
let worldW = 1200;
let worldH = 800;
let gameState = { players: [], bullets: [], mines: [] };
let obstacles = [];

// Input state
const keys = { forward: false, backward: false, rotateLeft: false, rotateRight: false, fire: false, mine: false, missile: false };
let lastInputStr = '';

// Key bindings
const KEY_MAP = {
  'w': 'forward',
  's': 'backward',
  'a': 'rotateLeft',
  'x': 'rotateRight',
  ' ': 'fire',
  'arrowup': 'forward',
  'arrowdown': 'backward',
  'arrowleft': 'rotateLeft',
  'arrowright': 'rotateRight',
  'c': 'mine',
  'q': 'missile'
};

let voiceMuted = false;
window.addEventListener('keydown', e => {
  if (e.key.toLowerCase() === 'm') {
    voiceMuted = !voiceMuted; Voice.setMuted(voiceMuted); e.preventDefault(); return;
  }
  const action = KEY_MAP[e.key.toLowerCase()];
  if (action) { keys[action] = true; e.preventDefault(); }
});
window.addEventListener('keyup', e => {
  const action = KEY_MAP[e.key.toLowerCase()];
  if (action) { keys[action] = false; e.preventDefault(); }
});

// Send input at ~30 Hz (only when changed)
setInterval(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const str = JSON.stringify(keys);
  if (str !== lastInputStr) {
    lastInputStr = str;
    ws.send(JSON.stringify({ type: 'input', ...keys }));
  }
}, 33);

// Join game
document.getElementById('join-btn').addEventListener('click', joinGame);
document.getElementById('name-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') joinGame();
});

function joinGame() {
  getAudio(); // initialise AudioContext during user gesture so it isn't blocked
  const name = document.getElementById('name-input').value.trim() || 'Tank';
  document.getElementById('name-screen').style.display = 'none';
  document.getElementById('game-wrap').style.display = 'flex';

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'name', name }));
  };

  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'init') {
      myId = msg.id;
      worldW = msg.worldW;
      worldH = msg.worldH;
      obstacles = msg.obstacles || [];
      canvas.width = worldW;
      canvas.height = worldH;
      Voice.init(ws, myId, msg.peers || []);
    } else if (msg.type === 'state') {
      gameState = msg;
    } else {
      Voice.handle(msg);
    }
  };

  ws.onclose = () => {
    document.getElementById('my-status').textContent = 'Disconnected — refresh to reconnect';
  };

  requestAnimationFrame(renderLoop);
}

// ─── Audio ────────────────────────────────────────────────────────────────────

let audioCtx = null;
function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playFireSound() {
  try {
    const ac = getAudio();
    const now = ac.currentTime;

    // Deep cannon thud — two stacked sines for body
    for (const [freq, endFreq, vol, dur] of [[75, 18, 1.4, 0.22], [140, 30, 0.9, 0.15]]) {
      const osc = ac.createOscillator();
      const og  = ac.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);
      osc.frequency.exponentialRampToValueAtTime(endFreq, now + dur);
      og.gain.setValueAtTime(vol, now);
      og.gain.exponentialRampToValueAtTime(0.001, now + dur);
      osc.connect(og); og.connect(ac.destination);
      osc.start(now); osc.stop(now + dur);
    }

    // Low noise body (adds weight)
    const len = Math.floor(ac.sampleRate * 0.25);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d   = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.2);
    const src  = ac.createBufferSource();
    src.buffer = buf;
    const filt = ac.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 280;
    const sg = ac.createGain();
    sg.gain.setValueAtTime(1.2, now);
    sg.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    src.connect(filt); filt.connect(sg); sg.connect(ac.destination);
    src.start(now);
  } catch (_) {}
}

function playExplosionSound() {
  try {
    const ac  = getAudio();
    const now = ac.currentTime;

    // Boom oscillator
    const osc = ac.createOscillator();
    const og  = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(90, now);
    osc.frequency.exponentialRampToValueAtTime(18, now + 0.45);
    og.gain.setValueAtTime(1.0, now);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
    osc.connect(og); og.connect(ac.destination);
    osc.start(now); osc.stop(now + 0.45);

    // Noise rumble
    const len = Math.floor(ac.sampleRate * 1.1);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d   = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.4);
    }
    const src  = ac.createBufferSource();
    src.buffer = buf;
    const filt = ac.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(900, now);
    filt.frequency.exponentialRampToValueAtTime(60, now + 0.6);
    const ng = ac.createGain();
    ng.gain.setValueAtTime(1.3, now);
    ng.gain.exponentialRampToValueAtTime(0.001, now + 1.1);
    src.connect(filt); filt.connect(ng); ng.connect(ac.destination);
    src.start(now);
  } catch (_) {}
}

// ─── Explosions ───────────────────────────────────────────────────────────────

let explosions = [];

function spawnExplosion(x, y) {
  const particles = [];
  const fireColors = ['#ffffff', '#fff176', '#ffd700', '#ff8c00', '#ff4500', '#cc2200'];

  for (let i = 0; i < 36; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 1.5 + Math.random() * 7;
    const debris = i >= 28;
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1.0,
      decay: debris ? 0.007 + Math.random() * 0.01 : 0.018 + Math.random() * 0.028,
      r:    debris ? 2 + Math.random() * 3          : 5 + Math.random() * 11,
      color: debris ? '#3a3a3a' : fireColors[Math.floor(Math.random() * fireColors.length)],
      grav:  debris ? 0.12 : 0.025
    });
  }

  explosions.push({ x, y, particles, ring: 0, flash: 1.0 });
}

function updateAndDrawExplosions(dt) {
  explosions = explosions.filter(exp => {
    let anyAlive = false;

    // Flash
    if (exp.flash > 0) {
      exp.flash = Math.max(0, exp.flash - dt * 7);
      ctx.save();
      ctx.globalAlpha = exp.flash * 0.65;
      const fg = ctx.createRadialGradient(exp.x, exp.y, 0, exp.x, exp.y, 70 * exp.flash + 10);
      fg.addColorStop(0, '#ffffff');
      fg.addColorStop(0.4, '#fff176');
      fg.addColorStop(1, 'transparent');
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.arc(exp.x, exp.y, 70 * exp.flash + 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Expanding shockwave ring
    exp.ring += dt * 220;
    if (exp.ring < 100) {
      anyAlive = true;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 0.6 * (1 - exp.ring / 100));
      ctx.strokeStyle = '#ffcc44';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(exp.x, exp.y, exp.ring, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Particles
    for (const p of exp.particles) {
      if (p.life <= 0) continue;
      p.x  += p.vx; p.y += p.vy;
      p.vy += p.grav;
      p.vx *= 0.96; p.vy *= 0.96;
      p.life -= p.decay;
      if (p.life <= 0) continue;
      anyAlive = true;
      ctx.save();
      ctx.globalAlpha = Math.min(1, p.life * 1.4);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.5, p.r * p.life), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    return anyAlive;
  });
}

// ─── State-change tracking ────────────────────────────────────────────────────

const prevAlive        = {};
const seenBulletIds    = new Set();
const clientColliding  = new Set(); // pairKey strings currently overlapping

function clientPairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

function spawnCollisionSpark(x, y) {
  const particles = [];
  for (let i = 0; i < 10; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 1.5 + Math.random() * 3.5;
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      life: 1.0, decay: 0.07 + Math.random() * 0.07,
      r: 1.5 + Math.random() * 2.5,
      color: Math.random() < 0.6 ? '#fff' : '#ffd700',
      grav: 0
    });
  }
  explosions.push({ x, y, particles, ring: 0, flash: 0.25 });
}
const prevMissilePos   = new Map();   // missileId -> {x,y}
const missileTrails    = new Map();   // missileId -> [{x,y}, ...]
const TRAIL_LEN        = 28;
const MISSILE_BLAST_R  = Math.round(Math.sqrt(1200 * 800 * 0.05 / Math.PI)); // ≈124
let   blastEffects     = [];          // [{x,y,life}] for blast-radius rings

function checkStateChanges() {
  const { players, bullets } = gameState;

  // Deaths → explosion
  for (const p of players) {
    if (p.id in prevAlive && prevAlive[p.id] === true && !p.alive) {
      spawnExplosion(p.x, p.y);
      playExplosionSound();
    }
    prevAlive[p.id] = p.alive;
  }

  // New bullets by this player → fire sound
  for (const b of bullets) {
    if (!seenBulletIds.has(b.id) && b.ownerId === myId) {
      playFireSound();
    }
    seenBulletIds.add(b.id);
  }
  // Prune old bullet ids so the set doesn't grow forever
  if (seenBulletIds.size > 2000) seenBulletIds.clear();

  // Tank–tank collisions → spark on first contact
  const alive = players.filter(p => p.alive);
  const nowColliding = new Set();
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i], b = alive[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      if (dx * dx + dy * dy < (20 * 2) ** 2) {
        const key = clientPairKey(a.id, b.id);
        nowColliding.add(key);
        if (!clientColliding.has(key)) {
          spawnCollisionSpark((a.x + b.x) / 2, (a.y + b.y) / 2);
        }
      }
    }
  }
  clientColliding.clear();
  for (const k of nowColliding) clientColliding.add(k);

  // Missile disappearance → big explosion at last known position
  const curMissiles = new Set((gameState.missiles || []).map(m => m.id));
  for (const [id, pos] of prevMissilePos) {
    if (!curMissiles.has(id)) {
      spawnMissileExplosion(pos.x, pos.y);
      playExplosionSound();
    }
  }
  prevMissilePos.clear();
  for (const m of (gameState.missiles || [])) prevMissilePos.set(m.id, { x: m.x, y: m.y });
}

// ─── Rendering ────────────────────────────────────────────────────────────────

let lastFrameTime = performance.now();

function renderLoop(now) {
  requestAnimationFrame(renderLoop);
  const dt = Math.min((now - lastFrameTime) / 1000, 0.05);
  lastFrameTime = now;
  render(dt);
}

function render(dt = 0) {
  checkStateChanges();
  const { players, bullets, mines, missiles: msls = [], round } = gameState;

  // Background
  ctx.fillStyle = '#1a3a1a';
  ctx.fillRect(0, 0, worldW, worldH);

  // Grid
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= worldW; x += 80) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, worldH); ctx.stroke();
  }
  for (let y = 0; y <= worldH; y += 80) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(worldW, y); ctx.stroke();
  }

  // Border
  ctx.strokeStyle = '#2a5a2a';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, worldW - 4, worldH - 4);

  // Obstacles (drawn before bullets/tanks so they appear under)
  obstacles.forEach(drawHedge);

  // Mines (on ground, under bullets and tanks)
  mines.forEach(drawMine);

  // Bullets
  bullets.forEach(drawBullet);

  // Missiles — update trails then draw
  const activeMissileIds = new Set(msls.map(m => m.id));
  for (const id of missileTrails.keys()) { if (!activeMissileIds.has(id)) missileTrails.delete(id); }
  for (const m of msls) {
    if (!missileTrails.has(m.id)) missileTrails.set(m.id, []);
    const t = missileTrails.get(m.id);
    t.push({ x: m.x, y: m.y });
    if (t.length > TRAIL_LEN) t.shift();
  }
  msls.forEach(drawMissile);

  // Tanks
  players.forEach(p => { if (p.alive) drawTank(p); });

  // Blast radius rings + explosions
  drawBlastEffects(dt);
  updateAndDrawExplosions(dt);

  // Scores overlay (top-right)
  drawScoreboard(players, round);

  // Round timer & phase overlays
  if (round) {
    drawRoundTimer(round);
    if (round.phase === 'between')    drawBetweenRoundOverlay(round);
    if (round.phase === 'match_over') drawMatchOverOverlay(round, players);
  }

  // HUD & respawn
  const me = players.find(p => p.id === myId);
  updateHUD(me);
  updateRespawnOverlay(me);
}

function drawTank(p) {
  const isMe = p.id === myId;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle);

  // Tracks (shadow-like strips)
  ctx.fillStyle = '#111';
  ctx.fillRect(-22, -18, 44, 7);
  ctx.fillRect(-22, 11, 44, 7);

  // Body
  ctx.fillStyle = isMe ? shadeColor(p.color, 20) : p.color;
  ctx.fillRect(-18, -12, 36, 24);

  // Body highlight edge
  ctx.strokeStyle = isMe ? '#ffffff88' : '#00000044';
  ctx.lineWidth = isMe ? 2 : 1;
  ctx.strokeRect(-18, -12, 36, 24);

  // Turret base
  ctx.fillStyle = isMe ? shadeColor(p.color, 30) : shadeColor(p.color, -20);
  ctx.beginPath();
  ctx.arc(0, 0, 10, 0, Math.PI * 2);
  ctx.fill();

  // Barrel
  ctx.fillStyle = '#333';
  ctx.fillRect(8, -4, 20, 8);
  ctx.fillStyle = isMe ? shadeColor(p.color, 10) : shadeColor(p.color, -30);
  ctx.fillRect(8, -3, 20, 6);

  ctx.restore();

  // HP bar
  const barW = 44;
  const barH = 5;
  const hpRatio = p.hp / 100;
  const bx = p.x - barW / 2;
  const by = p.y - 32;
  ctx.fillStyle = '#111';
  ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);
  ctx.fillStyle = hpRatio > 0.6 ? '#2ecc71' : hpRatio > 0.3 ? '#f39c12' : '#e74c3c';
  ctx.fillRect(bx, by, barW * hpRatio, barH);

  // Name label
  ctx.font = isMe ? 'bold 11px Courier New' : '10px Courier New';
  ctx.fillStyle = isMe ? '#fff' : '#ccc';
  ctx.textAlign = 'center';
  ctx.fillText(p.name, p.x, p.y - 36);

  // Speaking indicator
  if (Voice.getSpeakingSet().has(p.id)) {
    const t = (Date.now() % 900) / 900;
    ctx.save();
    for (let i = 0; i < 3; i++) {
      const phase = (t + i / 3) % 1;
      const r     = 30 + phase * 22;
      ctx.globalAlpha = (1 - phase) * 0.75;
      ctx.strokeStyle = '#00e676';
      ctx.lineWidth   = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle   = '#00e676';
    ctx.font        = '13px sans-serif';
    ctx.fillText('🎙', p.x + 24, p.y - 30);
    ctx.restore();
  }
}

function drawBullet(b) {
  // Glow
  const grd = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, 10);
  grd.addColorStop(0, 'rgba(255, 230, 50, 0.8)');
  grd.addColorStop(1, 'rgba(255, 150, 0, 0)');
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(b.x, b.y, 10, 0, Math.PI * 2);
  ctx.fill();

  // Core
  ctx.fillStyle = '#fff176';
  ctx.beginPath();
  ctx.arc(b.x, b.y, 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawMine(m) {
  ctx.save();
  ctx.translate(m.x, m.y);

  if (m.armed) {
    // Armed: dark casing with spikes
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.arc(0, 0, 10, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = m.color;
    ctx.lineWidth = 2;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 10, Math.sin(a) * 10);
      ctx.lineTo(Math.cos(a) * 15, Math.sin(a) * 15);
      ctx.stroke();
    }

    // Blinking red dot
    if (Math.floor(Date.now() / 400) % 2 === 0) {
      ctx.fillStyle = '#e74c3c';
      ctx.beginPath();
      ctx.arc(0, 0, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // Unarmed: faint outline only
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = m.color;
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(0, 0, 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();
}

function drawHedge(o) {
  const left = o.x - o.w / 2, top = o.y - o.h / 2;
  ctx.save();

  // Dark shadow behind
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(left + 4, top + 4, o.w, o.h);

  // Base fill — deep green
  ctx.fillStyle = '#1e6b1e';
  ctx.fillRect(left, top, o.w, o.h);

  // Bushy blob pattern drawn as overlapping circles along the hedge
  const isH = o.orientation === 'horizontal';
  const count = Math.round((isH ? o.w : o.h) / 22);
  const step  = (isH ? o.w : o.h) / count;
  const half  = (isH ? o.h : o.w) / 2;

  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) * step;
    const bx = isH ? left + t          : o.x;
    const by = isH ? o.y               : top + t;
    const r  = half * 0.72;

    // Back blobs (darker)
    ctx.fillStyle = '#175417';
    ctx.beginPath();
    ctx.arc(bx - (isH ? 0 : r * 0.3), by - (isH ? r * 0.3 : 0), r * 0.9, 0, Math.PI * 2);
    ctx.fill();

    // Front blobs (lighter)
    ctx.fillStyle = '#27ae27';
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fill();

    // Highlight
    ctx.fillStyle = 'rgba(100,210,80,0.25)';
    ctx.beginPath();
    ctx.arc(bx - (isH ? r * 0.25 : 0), by - (isH ? 0 : r * 0.25), r * 0.45, 0, Math.PI * 2);
    ctx.fill();
  }

  // Crisp border
  ctx.strokeStyle = '#145214';
  ctx.lineWidth = 2;
  ctx.strokeRect(left, top, o.w, o.h);

  ctx.restore();
}

function spawnMissileExplosion(x, y) {
  const fireColors = ['#ffffff', '#fff9c4', '#ffd700', '#ff8c00', '#ff4500', '#cc1100'];
  const particles  = [];
  for (let i = 0; i < 90; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 2 + Math.random() * 14;
    const debris = i >= 68;
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      life: 1.0,
      decay: debris ? 0.004 + Math.random() * 0.007 : 0.01 + Math.random() * 0.018,
      r:    debris ? 3 + Math.random() * 6           : 7 + Math.random() * 18,
      color: debris ? '#2a2a2a' : fireColors[Math.floor(Math.random() * fireColors.length)],
      grav:  debris ? 0.18 : 0.03
    });
  }
  explosions.push({ x, y, particles, ring: 0, flash: 2.0 });
  blastEffects.push({ x, y, life: 1.0 });
}

function drawMissile(m) {
  // ── Curved smoke trail ───────────────────────────────────────────────────
  const trail = missileTrails.get(m.id) || [];
  if (trail.length > 1) {
    for (let i = 1; i < trail.length; i++) {
      const t   = i / trail.length;           // 0 = oldest, 1 = newest
      const w   = t * 5;                      // trail widens toward head
      const alpha = t * 0.55;
      const r   = Math.round(255);
      const g   = Math.round(80 + 120 * (1 - t));  // orange → red toward tail
      ctx.strokeStyle = `rgba(${r},${g},0,${alpha})`;
      ctx.lineWidth   = w;
      ctx.lineCap     = 'round';
      ctx.beginPath();
      ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
      ctx.lineTo(trail[i].x,     trail[i].y);
      ctx.stroke();
    }
    // Smoke puffs along the older portion
    for (let i = 0; i < trail.length - 1; i += 3) {
      const t = i / trail.length;
      ctx.save();
      ctx.globalAlpha = (1 - t) * 0.18;
      ctx.fillStyle   = '#aaa';
      ctx.beginPath();
      ctx.arc(trail[i].x, trail[i].y, 4 + (1 - t) * 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // ── Missile body ─────────────────────────────────────────────────────────
  ctx.save();
  ctx.translate(m.x, m.y);
  ctx.rotate(m.angle);

  // Engine glow
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = '#ff6600';
  ctx.beginPath(); ctx.arc(0, 0, 15, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;

  // Body
  ctx.fillStyle = '#c8c8c8';
  ctx.beginPath(); ctx.ellipse(0, 0, 11, 4, 0, 0, Math.PI * 2); ctx.fill();

  // Nose cone
  ctx.fillStyle = '#e74c3c';
  ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(8, -4); ctx.lineTo(8, 4); ctx.closePath(); ctx.fill();

  // Tail fins
  ctx.fillStyle = '#888';
  ctx.beginPath(); ctx.moveTo(-8, 0); ctx.lineTo(-14, -7); ctx.lineTo(-8, -3); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(-8, 0); ctx.lineTo(-14,  7); ctx.lineTo(-8,  3); ctx.closePath(); ctx.fill();

  // Exhaust flame
  const flame = ctx.createLinearGradient(-22, 0, -10, 0);
  flame.addColorStop(0, 'transparent');
  flame.addColorStop(1, 'rgba(255,120,0,0.9)');
  ctx.fillStyle = flame;
  ctx.beginPath(); ctx.ellipse(-14, 0, 8, 3, 0, 0, Math.PI * 2); ctx.fill();

  ctx.restore();
}

function drawBlastEffects(dt) {
  blastEffects = blastEffects.filter(b => {
    b.life -= dt * 0.9;
    if (b.life <= 0) return false;
    ctx.save();
    // Filled blast zone (faint red wash)
    ctx.globalAlpha = b.life * 0.12;
    ctx.fillStyle = '#ff4500';
    ctx.beginPath(); ctx.arc(b.x, b.y, MISSILE_BLAST_R, 0, Math.PI * 2); ctx.fill();
    // Dashed perimeter ring
    ctx.globalAlpha = b.life * 0.7;
    ctx.strokeStyle = '#ff6600';
    ctx.lineWidth = 3;
    ctx.setLineDash([12, 6]);
    ctx.beginPath(); ctx.arc(b.x, b.y, MISSILE_BLAST_R, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    return true;
  });
}

function drawScoreboard(players, round) {
  const sorted = [...players].sort((a, b) => (b.roundWins ?? 0) - (a.roundWins ?? 0) || b.score - a.score);
  const lineH = 19;
  const padX = 10;
  const padY = 10;
  const w = 210;
  const h = padY * 2 + lineH * 2 + sorted.length * lineH;
  const sx = worldW - w - 10;
  const sy = 10;

  ctx.fillStyle = 'rgba(0,0,0,0.68)';
  roundRect(sx, sy, w, h, 6);
  ctx.fill();

  ctx.font = 'bold 12px Courier New';
  ctx.fillStyle = '#f39c12';
  ctx.textAlign = 'left';
  ctx.fillText('SCOREBOARD', sx + padX, sy + padY + 10);

  // Column headers
  ctx.font = '10px Courier New';
  ctx.fillStyle = '#777';
  ctx.fillText('PLAYER', sx + padX, sy + padY + 26);
  ctx.textAlign = 'center';
  ctx.fillText('KILLS', sx + w - 46, sy + padY + 26);
  ctx.fillText('WINS', sx + w - padX - 4, sy + padY + 26);
  ctx.textAlign = 'left';

  sorted.forEach((p, i) => {
    const y = sy + padY + lineH * 2 + i * lineH + 4;
    const isMe = p.id === myId;
    const wins = p.roundWins ?? 0;

    ctx.font = isMe ? 'bold 11px Courier New' : '11px Courier New';
    ctx.fillStyle = p.alive ? p.color : '#555';
    // Truncate long names
    const name = p.name.length > 10 ? p.name.slice(0, 9) + '…' : p.name;
    ctx.fillText(name, sx + padX, y);

    ctx.fillStyle = isMe ? '#fff' : '#aaa';
    ctx.textAlign = 'center';
    ctx.fillText(p.score, sx + w - 46, y);

    // Round wins as filled stars
    ctx.fillStyle = wins >= 3 ? '#f1c40f' : '#aaa';
    ctx.fillText('★'.repeat(wins) + '☆'.repeat(Math.max(0, 3 - wins)), sx + w - padX - 4, y);
    ctx.textAlign = 'left';
  });
}

function drawRoundTimer(round) {
  const secsLeft = Math.ceil(round.ticksLeft / 30);
  const mins = Math.floor(secsLeft / 60);
  const secs = String(secsLeft % 60).padStart(2, '0');
  const timeStr = `${mins}:${secs}`;
  const urgent  = secsLeft <= 30;

  ctx.save();
  ctx.textAlign = 'center';

  // Round label
  ctx.font = 'bold 13px Courier New';
  ctx.fillStyle = '#aaa';
  ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 6;
  ctx.fillText(`ROUND  ${round.number}`, worldW / 2, 22);

  // Timer
  ctx.font = `bold 30px Courier New`;
  ctx.fillStyle = urgent ? '#e74c3c' : '#ffffff';
  if (urgent && Math.floor(Date.now() / 500) % 2 === 0) ctx.fillStyle = '#ff6b6b';
  ctx.fillText(timeStr, worldW / 2, 52);
  ctx.shadowBlur = 0;
  ctx.restore();
}

function drawBetweenRoundOverlay(round) {
  const last     = round.history[round.history.length - 1];
  const secsLeft = Math.ceil(round.pauseTicks / 30);

  // Dim screen
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  ctx.fillRect(0, 0, worldW, worldH);

  ctx.save();
  ctx.textAlign = 'center';

  ctx.font = 'bold 44px Courier New';
  ctx.fillStyle = '#f39c12';
  ctx.fillText(`ROUND ${last ? last.num : round.number} OVER`, worldW / 2, worldH / 2 - 70);

  if (last) {
    ctx.font = 'bold 30px Courier New';
    ctx.fillStyle = last.winnerId ? last.color : '#888';
    ctx.fillText(last.winnerId ? `${last.winnerName} wins the round!` : 'Draw!', worldW / 2, worldH / 2 - 20);
  }

  // Round history
  if (round.history.length) {
    ctx.font = '14px Courier New';
    round.history.forEach((r, i) => {
      ctx.fillStyle = r.winnerId ? r.color : '#666';
      ctx.fillText(`Round ${r.num}: ${r.winnerName}`, worldW / 2, worldH / 2 + 30 + i * 22);
    });
  }

  ctx.font = 'bold 16px Courier New';
  ctx.fillStyle = '#aaa';
  ctx.fillText(`Next round in ${secsLeft}s…`, worldW / 2, worldH / 2 + 50 + round.history.length * 22);

  ctx.restore();
}

function drawMatchOverOverlay(round, players) {
  const winner    = players.find(p => p.id === round.matchWinnerId);
  const secsLeft  = Math.ceil(round.pauseTicks / 30);

  ctx.fillStyle = 'rgba(0,0,0,0.78)';
  ctx.fillRect(0, 0, worldW, worldH);

  ctx.save();
  ctx.textAlign = 'center';

  // Pulsing gold title
  const pulse = 0.85 + 0.15 * Math.sin(Date.now() / 300);
  ctx.font = `bold ${Math.round(52 * pulse)}px Courier New`;
  ctx.fillStyle = '#f1c40f';
  ctx.fillText('MATCH OVER', worldW / 2, worldH / 2 - 90);

  if (winner) {
    ctx.font = 'bold 36px Courier New';
    ctx.fillStyle = winner.color;
    ctx.fillText(winner.name, worldW / 2, worldH / 2 - 30);
    ctx.font = 'bold 24px Courier New';
    ctx.fillStyle = '#fff';
    ctx.fillText('WINS THE MATCH!', worldW / 2, worldH / 2 + 10);
  }

  // Full round history
  ctx.font = '14px Courier New';
  round.history.forEach((r, i) => {
    ctx.fillStyle = r.winnerId ? r.color : '#666';
    ctx.fillText(`Round ${r.num}: ${r.winnerName}`, worldW / 2, worldH / 2 + 55 + i * 22);
  });

  ctx.font = '13px Courier New';
  ctx.fillStyle = '#666';
  ctx.fillText(`New match in ${secsLeft}s…`, worldW / 2, worldH / 2 + 70 + round.history.length * 22);

  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function updateHUD(me) {
  const el = document.getElementById('my-status');
  if (!me) { el.textContent = 'Waiting for server...'; return; }
  if (!me.alive) return;
  const mineIcons    = '💣'.repeat(me.minesLeft ?? 0) || '—';
  const missileIcon  = me.missileReady ? '🚀 <span style="color:#2ecc71">READY</span>' : '🚀 <span style="color:#555">USED</span>';
  el.innerHTML = `HP: <span style="color:${me.hp > 60 ? '#2ecc71' : me.hp > 30 ? '#f39c12' : '#e74c3c'}">${me.hp}</span> &bull; Score: <strong>${me.score}</strong> &bull; Mines: ${mineIcons} &bull; ${missileIcon}`;
}

function updateRespawnOverlay(me) {
  const box = document.getElementById('respawn-box');
  const count = document.getElementById('respawn-count');
  if (me && !me.alive) {
    box.style.display = 'block';
    const secs = Math.ceil(me.respawnTimer / 30);
    count.textContent = secs > 0 ? secs : '...';
  } else {
    box.style.display = 'none';
  }
}

function shadeColor(hex, pct) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, Math.max(0, (num >> 16) + pct));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0xff) + pct));
  const b = Math.min(255, Math.max(0, (num & 0xff) + pct));
  return `rgb(${r},${g},${b})`;
}
