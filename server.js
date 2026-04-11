const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const WORLD_W = 1200;
const WORLD_H = 800;
const TANK_SPEED = 3;
const ROTATE_SPEED = 0.05;
const BULLET_SPEED = 10;
const BULLET_RADIUS = 5;
const TANK_RADIUS = 20;
const BULLET_DAMAGE = 25;
const FIRE_COOLDOWN_TICKS = 20;
const RESPAWN_DELAY_TICKS = 90;
const BULLET_LIFETIME_TICKS = 80;
const TICK_RATE = 1000 / 30;
const COLLISION_DAMAGE = Math.round(BULLET_DAMAGE / 3); // ≈ 8 HP per ram
const MAX_MINES = 5;
const MINE_RADIUS = 14;
const MINE_ARMING_TICKS = 45;
const MINE_COOLDOWN_TICKS = 20;
const MINE_DAMAGE = 100;
const ROUND_DURATION_TICKS  = 180 * 30;
const BETWEEN_ROUND_TICKS   = 6  * 30;
const MATCH_OVER_TICKS      = 10 * 30;
const ROUNDS_TO_WIN_MATCH   = 3;
const MISSILE_SPEED         = 6;            // px per tick
const MISSILE_TURN_RATE     = 0.07;         // radians per tick — limits how tightly it curves
const MISSILE_LIFETIME      = 10 * 30;      // 10 seconds before self-destruct
const MISSILE_BLAST_RADIUS  = Math.round(Math.sqrt(WORLD_W * WORLD_H * 0.05 / Math.PI)); // ≈124 px

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

// ─── Obstacle generation ──────────────────────────────────────────────────────

// Obstacles are axis-aligned rectangles stored as centre (x,y) + half-extents (w,h).
function generateObstacles() {
  const obs = [];

  function overlaps(c) {
    for (const o of obs) {
      if (Math.abs(o.x - c.x) < (o.w + c.w) / 2 + 30 &&
          Math.abs(o.y - c.y) < (o.h + c.h) / 2 + 30) return true;
    }
    return false;
  }

  function place(orientation, count) {
    for (let i = 0; i < count; i++) {
      for (let attempt = 0; attempt < 80; attempt++) {
        const long  = 120 + Math.random() * 130;  // 120–250 px
        const short = 28  + Math.random() * 20;   // 28–48 px
        const c = {
          type: 'hedge',
          orientation,
          w: orientation === 'horizontal' ? long : short,
          h: orientation === 'horizontal' ? short : long,
          x: 100 + Math.random() * (WORLD_W - 200),
          y: 100 + Math.random() * (WORLD_H - 200)
        };
        if (!overlaps(c)) { obs.push(c); break; }
      }
    }
  }

  place('horizontal', 6);
  place('vertical',   6);
  return obs;
}

const obstacles = generateObstacles();

// Circle vs AABB (centre-based rect)
function circleVsRect(cx, cy, cr, o) {
  const nearX = Math.max(o.x - o.w / 2, Math.min(cx, o.x + o.w / 2));
  const nearY = Math.max(o.y - o.h / 2, Math.min(cy, o.y + o.h / 2));
  const dx = cx - nearX, dy = cy - nearY;
  return dx * dx + dy * dy < cr * cr;
}

function tankCollidesWithObstacle(x, y) {
  for (const o of obstacles) {
    if (circleVsRect(x, y, TANK_RADIUS, o)) return true;
  }
  return false;
}

function bulletHitsObstacle(x, y) {
  for (const o of obstacles) {
    if (circleVsRect(x, y, BULLET_RADIUS, o)) return true;
  }
  return false;
}

// HTTP static file server
const httpServer = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];

  // QR code endpoint — generates a PNG QR code for the given URL
  if (urlPath === '/api/qr') {
    const params = new URLSearchParams(req.url.split('?')[1] || '');
    const target = params.get('url') || '';
    if (!target) { res.writeHead(400); res.end('Missing url param'); return; }
    QRCode.toBuffer(target, { type: 'png', width: 160, margin: 1 }, (err, buf) => {
      if (err) { res.writeHead(500); res.end('QR error'); return; }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public,max-age=3600' });
      res.end(buf);
    });
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';
  // Sanitize: strip directory traversal, only allow known filenames
  const parts = urlPath.split('/').filter(p => p && p !== '..' && p !== '.');
  const filePath = path.join(__dirname, 'public', ...parts);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server: httpServer });

const activeCollisions = new Set(); // "minId|maxId" pairs currently overlapping
function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

function handleTankCollisions() {
  const alive = Array.from(players.values()).filter(p => p.alive);
  const current = new Set();

  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i], b = alive[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const distSq = dx * dx + dy * dy;
      const minDist = TANK_RADIUS * 2;

      if (distSq > 0 && distSq < minDist * minDist) {
        const dist = Math.sqrt(distSq);
        const key  = pairKey(a.id, b.id);
        current.add(key);

        // Push tanks apart along the collision normal
        const overlap = (minDist - dist) / 2;
        const nx = dx / dist, ny = dy / dist;
        const aOk = !tankCollidesWithObstacle(a.x - nx * overlap, a.y - ny * overlap);
        const bOk = !tankCollidesWithObstacle(b.x + nx * overlap, b.y + ny * overlap);
        if (aOk) { a.x -= nx * overlap; a.y -= ny * overlap; }
        if (bOk) { b.x += nx * overlap; b.y += ny * overlap; }
        // If one is wall-blocked, give full push to the other
        if (aOk && !bOk && !tankCollidesWithObstacle(a.x - nx * overlap, a.y - ny * overlap)) {
          a.x -= nx * overlap; a.y -= ny * overlap;
        }
        if (bOk && !aOk && !tankCollidesWithObstacle(b.x + nx * overlap, b.y + ny * overlap)) {
          b.x += nx * overlap; b.y += ny * overlap;
        }

        // Damage only on the first tick of contact
        if (!activeCollisions.has(key)) {
          a.hp -= COLLISION_DAMAGE;
          b.hp -= COLLISION_DAMAGE;
          if (a.hp <= 0) { a.alive = false; a.respawnTimer = RESPAWN_DELAY_TICKS; }
          if (b.hp <= 0) { b.alive = false; b.respawnTimer = RESPAWN_DELAY_TICKS; }
        }
      }
    }
  }

  activeCollisions.clear();
  for (const k of current) activeCollisions.add(k);
}

let players      = new Map();
let bullets      = [];
let mines        = [];
let missiles      = [];
let airStrikes    = [];
let nextPlayerId  = 1;
let nextBulletId  = 1;
let nextMineId    = 1;
let nextMissileId = 1;
let nextAirStrikeId = 1;

// ─── Round state ──────────────────────────────────────────────────────────────
let roundNumber   = 1;
let roundTicksLeft = ROUND_DURATION_TICKS;
let roundPhase    = 'active';   // 'active' | 'between' | 'match_over'
let pauseTicks    = 0;
let roundWins     = new Map();  // playerId -> round wins
let roundHistory  = [];         // [{num, winnerId, winnerName, color}]
let matchWinnerId = null;

function respawnAll() {
  for (const [, p] of players) {
    const s = randomSpawn();
    p.x = s.x; p.y = s.y; p.angle = s.angle;
    p.hp = 100; p.alive = true; p.minesLeft = MAX_MINES; p.missileReady = true; p.airStrikeReady = true;
    p.fireCooldown = 0; p.mineCooldown = 0;
  }
  bullets = []; mines = []; missiles = [];
}

function endRound() {
  // Find highest scorer
  let winner = null;
  for (const [, p] of players) {
    if (!winner || p.score > winner.score) winner = p;
  }

  if (winner && winner.score > 0) {
    const wins = (roundWins.get(winner.id) || 0) + 1;
    roundWins.set(winner.id, wins);
    roundHistory.push({ num: roundNumber, winnerId: winner.id, winnerName: winner.name, color: winner.color });

    if (wins >= ROUNDS_TO_WIN_MATCH) {
      matchWinnerId = winner.id;
      roundPhase = 'match_over';
      pauseTicks  = MATCH_OVER_TICKS;
      return;
    }
  } else {
    // Draw — no round winner, still record it
    roundHistory.push({ num: roundNumber, winnerId: null, winnerName: 'Draw', color: '#888' });
  }

  roundPhase = 'between';
  pauseTicks  = BETWEEN_ROUND_TICKS;
}

function startNextRound() {
  roundNumber++;
  roundTicksLeft = ROUND_DURATION_TICKS;
  roundPhase = 'active';
  for (const [, p] of players) p.score = 0;
  respawnAll();
}

function resetMatch() {
  roundNumber   = 1;
  roundTicksLeft = ROUND_DURATION_TICKS;
  roundPhase    = 'active';
  pauseTicks    = 0;
  roundWins.clear();
  roundHistory  = [];
  matchWinnerId = null;
  for (const [, p] of players) p.score = 0;
  respawnAll();
}

function tickRound() {
  if (roundPhase === 'active') {
    roundTicksLeft--;
    if (roundTicksLeft <= 0) endRound();
  } else {
    pauseTicks--;
    if (pauseTicks <= 0) {
      if (roundPhase === 'match_over') resetMatch();
      else startNextRound();
    }
  }
}

const PLAYER_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#e91e63'];

// ─── Bot AI ───────────────────────────────────────────────────────────────────

const BOT_NAMES = ['Rusty', 'Blaze', 'Shadow', 'Viper', 'Thunder', 'Ghost', 'Havoc', 'Storm'];

// Difficulty now controls BEHAVIOUR only — all bots have full player capabilities.
// lookFwd/lookSide: feeler distances (longer = earlier obstacle detection = smoother nav)
// stuckThresh: ticks before declaring stuck (lower = quicker recovery)
// fireAngleTol: angle error (rad) within which bot fires (smaller = waits for better shot)
// retreatHp: HP threshold to seek cover; 0 = never retreat
// mineStrategy: 'random' | 'pursuit' (lays in chaser's path) | 'chokepoint' (near hedges)
// missileStrategy: 'random' | 'opportunistic' (fires when enemy is in the open)
const BOT_CFG = {
  easy: {
    lookFwd: 62,  lookSide: 48,  stuckThresh: 22,
    fireAngleTol: 0.55,
    retreatHp: 0, seekCover: false,
    mineStrategy: 'random',    mineChance: 0.003,
    missileStrategy: 'random', missileChance: 0.004,
    predictShots: false, bulletAware: false, optimalRange: 0,
  },
  medium: {
    lookFwd: 90,  lookSide: 65,  stuckThresh: 12,
    fireAngleTol: 0.22,
    retreatHp: 25, seekCover: true,
    mineStrategy: 'pursuit',          mineChance: 0.005,
    missileStrategy: 'opportunistic', missileChance: 0.007,
    predictShots: false, bulletAware: false, optimalRange: 0,
  },
  hard: {
    lookFwd: 130, lookSide: 90,  stuckThresh: 4,
    fireAngleTol: 0.16,
    retreatHp: 0, seekCover: false,       // constant aggression, never hides
    mineStrategy: 'chokepoint', mineChance: 0.018,
    missileStrategy: 'opportunistic', missileChance: 0.025,
    predictShots: true,   // leads bullets based on tracked target velocity
    bulletAware: true,    // detects and dodges incoming bullets
    optimalRange: 300,    // holds preferred engagement distance
  },
};

// ─── Player Behaviour Models (hard bot adaptive learning) ─────────────────────
const playerModels = new Map(); // playerId -> BehaviourModel

function getOrCreateModel(id) {
  if (!playerModels.has(id)) {
    playerModels.set(id, {
      dodgeBias:  0,     // EMA of turn direction under bot aim (+ = tends right, - = left)
      avgRange:   350,   // EMA of player's preferred engagement distance
      coverUsage: 0,     // EMA fraction of ticks spent near obstacles
      isRusher:   0.5,   // EMA 0 = stays far/sniper, 1 = closes in/rusher
      prevX: null, prevY: null, prevAngle: null,
    });
  }
  return playerModels.get(id);
}

// Sample one tick of a human player's behaviour relative to 'bot' and update EMA model.
function samplePlayerBehavior(player, bot) {
  const m = getOrCreateModel(player.id);
  const A = 0.04; // EMA alpha ≈ 0.8 s half-life at 30 Hz
  if (m.prevX !== null) {
    // Movement aggression
    const speed = Math.hypot(player.x - m.prevX, player.y - m.prevY);
    m.isRusher += ((speed > 1.5 ? 1 : 0) - m.isRusher) * A;

    // Dodge direction bias: sample only when bot is roughly aimed at player
    const angleToPlayer = Math.atan2(player.y - bot.y, player.x - bot.x);
    if (Math.abs(normAngle(angleToPlayer - bot.angle)) < 0.25) {
      const turn = normAngle(player.angle - m.prevAngle);
      m.dodgeBias += (Math.sign(turn) - m.dodgeBias) * A;
    }

    // Preferred range
    const dist = Math.hypot(player.x - bot.x, player.y - bot.y);
    m.avgRange += (dist - m.avgRange) * A * 0.5;

    // Cover usage
    const inCover = nearObstacle(player.x, player.y, TANK_RADIUS + 50) ? 1 : 0;
    m.coverUsage += (inCover - m.coverUsage) * A;
  }
  m.prevX = player.x; m.prevY = player.y; m.prevAngle = player.angle;
  return m;
}

function createBot(id, ownerId, difficulty, nameIdx) {
  const spawn = randomSpawn();
  return {
    id, isBot: true, ownerId, difficulty,
    ws: null,
    name: BOT_NAMES[nameIdx % BOT_NAMES.length],
    color: PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length],
    x: spawn.x, y: spawn.y, angle: spawn.angle,
    hp: 100, score: 0, alive: true,
    respawnTimer: 0, fireCooldown: 0,
    minesLeft: MAX_MINES, mineCooldown: 0, missileReady: true,
    // Bot-only state
    botWander: Math.random() * Math.PI * 2,
    botWanderTimer: 0,
    botPrevX: spawn.x, botPrevY: spawn.y,
    botStuckTimer: 0, botWasTryingToMove: false,
    botTargetPrev: null,   // previous target position for shot prediction
    input: { forward: false, backward: false, rotateLeft: false, rotateRight: false, fire: false, mine: false, missile: false }
  };
}

// Ray vs AABB (slab method). AABB expanded by TANK_RADIUS for clearance.
function rayVsAABB(ox, oy, dx, dy, length, o) {
  const minX = o.x - o.w / 2 - TANK_RADIUS;
  const maxX = o.x + o.w / 2 + TANK_RADIUS;
  const minY = o.y - o.h / 2 - TANK_RADIUS;
  const maxY = o.y + o.h / 2 + TANK_RADIUS;
  let tMin = 0, tMax = length;
  if (Math.abs(dx) < 1e-8) { if (ox < minX || ox > maxX) return false; }
  else {
    const t1 = (minX - ox) / dx, t2 = (maxX - ox) / dx;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
    if (tMin > tMax) return false;
  }
  if (Math.abs(dy) < 1e-8) { if (oy < minY || oy > maxY) return false; }
  else {
    const t1 = (minY - oy) / dy, t2 = (maxY - oy) / dy;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
    if (tMin > tMax) return false;
  }
  return true;
}

function normAngle(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }

// Three forward-facing feelers using per-difficulty look distances.
function botFeelers(bot, cfg) {
  const SIDE_ANG = Math.PI / 4;
  const WALL_PAD = TANK_RADIUS + 12;
  const fwd = bot.angle;
  const cdx = Math.cos(fwd), cdy = Math.sin(fwd);
  const ldx = Math.cos(fwd - SIDE_ANG), ldy = Math.sin(fwd - SIDE_ANG);
  const rdx = Math.cos(fwd + SIDE_ANG), rdy = Math.sin(fwd + SIDE_ANG);
  let fwdBlocked = false, leftBlocked = false, rightBlocked = false;
  for (const o of obstacles) {
    if (!fwdBlocked   && rayVsAABB(bot.x, bot.y, cdx, cdy, cfg.lookFwd,  o)) fwdBlocked   = true;
    if (!leftBlocked  && rayVsAABB(bot.x, bot.y, ldx, ldy, cfg.lookSide, o)) leftBlocked  = true;
    if (!rightBlocked && rayVsAABB(bot.x, bot.y, rdx, rdy, cfg.lookSide, o)) rightBlocked = true;
  }
  const fx = bot.x + cdx * cfg.lookFwd, fy = bot.y + cdy * cfg.lookFwd;
  if (fx < WALL_PAD || fx > WORLD_W - WALL_PAD || fy < WALL_PAD || fy > WORLD_H - WALL_PAD)
    fwdBlocked = true;
  return { fwdBlocked, leftBlocked, rightBlocked };
}

// Returns true if the straight line from (ax,ay) to (bx,by) is not blocked by any hedgerow.
// Uses raw obstacle bounds (bullet-width clearance, no tank-radius expansion).
function hasLineOfSight(ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return true;
  const nx = dx / dist, ny = dy / dist;
  for (const o of obstacles) {
    const minX = o.x - o.w / 2, maxX = o.x + o.w / 2;
    const minY = o.y - o.h / 2, maxY = o.y + o.h / 2;
    let tMin = 0, tMax = dist;
    if (Math.abs(nx) < 1e-8) { if (ax < minX || ax > maxX) continue; }
    else {
      const t1 = (minX - ax) / nx, t2 = (maxX - ax) / nx;
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
      if (tMin > tMax) continue;
    }
    if (Math.abs(ny) < 1e-8) { if (ay < minY || ay > maxY) continue; }
    else {
      const t1 = (minY - ay) / ny, t2 = (maxY - ay) / ny;
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
      if (tMin > tMax) continue;
    }
    return false; // blocked
  }
  return true;
}

// Returns direction angle toward the nearest obstacle (for cover seeking).
function nearestObstacleAngle(bot) {
  let best = Infinity, angle = 0;
  for (const o of obstacles) {
    const dx = o.x - bot.x, dy = o.y - bot.y;
    const d = dx * dx + dy * dy;
    if (d < best) { best = d; angle = Math.atan2(dy, dx); }
  }
  return angle;
}

// True if the point (x,y) is within 'margin' px of any obstacle edge.
function nearObstacle(x, y, margin) {
  for (const o of obstacles) {
    const cx = Math.max(o.x - o.w / 2, Math.min(x, o.x + o.w / 2));
    const cy = Math.max(o.y - o.h / 2, Math.min(y, o.y + o.h / 2));
    if ((x - cx) ** 2 + (y - cy) ** 2 < margin * margin) return true;
  }
  return false;
}

// True if the target is far from all obstacles (exposed / in the open).
function targetInOpen(target) {
  return !nearObstacle(target.x, target.y, 70);
}

// True if an enemy tank appears to be chasing this bot
// (enemy is roughly facing toward the bot).
function enemyChasing(bot, target) {
  const angleToBot = Math.atan2(bot.y - target.y, bot.x - target.x);
  return Math.abs(normAngle(angleToBot - target.angle)) < 0.6;
}

// Returns true if bullet b will come within 'threshold' px of (x,y).
function bulletThreatens(b, x, y, threshold) {
  const vx = Math.cos(b.angle) * BULLET_SPEED;
  const vy = Math.sin(b.angle) * BULLET_SPEED;
  const dx = x - b.x, dy = y - b.y;
  const t = (dx * vx + dy * vy) / (vx * vx + vy * vy);
  if (t < 0 || t > BULLET_LIFETIME_TICKS) return false;
  const cx = b.x + vx * t - x, cy = b.y + vy * t - y;
  return cx * cx + cy * cy < threshold * threshold;
}

// Aim angle that leads the target based on its observed velocity.
// bot.botTargetPrev must be maintained across ticks.
function predictedAimAngle(bot, target) {
  let vx = 0, vy = 0;
  if (bot.botTargetPrev && bot.botTargetPrev.id === target.id) {
    vx = target.x - bot.botTargetPrev.x;
    vy = target.y - bot.botTargetPrev.y;
  }
  bot.botTargetPrev = { id: target.id, x: target.x, y: target.y };
  const dist = Math.hypot(target.x - bot.x, target.y - bot.y);
  const lead = dist / BULLET_SPEED;
  return Math.atan2((target.y + vy * lead) - bot.y, (target.x + vx * lead) - bot.x);
}

// Steer toward a desired angle; apply obstacle avoidance if forward is blocked.
function steerToward(bot, desiredAngle, inp, feelers) {
  const { fwdBlocked, leftBlocked, rightBlocked } = feelers;
  const diff = normAngle(desiredAngle - bot.angle);
  if (fwdBlocked) {
    inp.forward = false;
    if (!rightBlocked)     inp.rotateRight = true;
    else if (!leftBlocked) inp.rotateLeft  = true;
    else                   inp.backward    = true;
  } else {
    inp.rotateRight = diff >  0.08;
    inp.rotateLeft  = diff < -0.08;
    inp.forward     = true;
  }
}

function tickBotAI(bot) {
  if (!bot.alive) return;
  const cfg = BOT_CFG[bot.difficulty] || BOT_CFG.medium;
  const inp = bot.input;

  // Reset all inputs
  inp.fire = inp.mine = inp.missile = false;
  inp.forward = inp.backward = inp.rotateLeft = inp.rotateRight = false;

  // ── Stuck detection ──────────────────────────────────────────────────────
  const moved = (bot.x - bot.botPrevX) ** 2 + (bot.y - bot.botPrevY) ** 2;
  if (bot.botWasTryingToMove && moved < 0.5) {
    if (++bot.botStuckTimer > cfg.stuckThresh) {
      bot.botWander     = bot.angle + (Math.random() > 0.5 ? Math.PI / 2 : -Math.PI / 2)
                          + (Math.random() - 0.5) * 0.6;
      bot.botWanderTimer = 35 + Math.floor(Math.random() * 25);
      bot.botStuckTimer  = 0;
    }
  } else { bot.botStuckTimer = 0; }
  bot.botPrevX = bot.x; bot.botPrevY = bot.y;

  const feelers = botFeelers(bot, cfg);
  const { fwdBlocked, leftBlocked, rightBlocked } = feelers;

  // ── Air strike evasion (highest priority — run perpendicular to jet path) ──
  for (const a of airStrikes) {
    if (a.x > bot.x + 60) continue;              // jet already passed
    if (Math.abs(bot.y - a.y) >= MISSILE_BLAST_RADIUS) continue; // not in path
    // Sprint perpendicular to jet (change Y) to escape blast radius
    const escapeAngle = bot.y >= a.y ? Math.PI / 2 : -Math.PI / 2;
    const wd = normAngle(escapeAngle - bot.angle);
    inp.rotateRight = wd >  0.12;
    inp.rotateLeft  = wd < -0.12;
    inp.forward  = !fwdBlocked;
    if (fwdBlocked) { inp.forward = false; inp.backward = true; }
    bot.botWasTryingToMove = true;
    return;
  }

  // ── Incoming missile evasion — steer perpendicular to approach vector ───
  // Does NOT return early: bot keeps firing while evading
  let missileEvading = false;
  let missileEvasionAngle = 0;
  for (const m of missiles) {
    if (m.targetId !== bot.id) continue;
    const mDist = Math.hypot(bot.x - m.x, bot.y - m.y);
    if (mDist > 320) continue;    // not close enough to react yet
    // Perpendicular to the missile's approach vector
    const approach = Math.atan2(bot.y - m.y, bot.x - m.x);
    const perpL = normAngle(approach - Math.PI / 2);
    const perpR = normAngle(approach + Math.PI / 2);
    // Pick the side that stays within world bounds
    const exL = bot.x + Math.cos(perpL) * 90, eyL = bot.y + Math.sin(perpL) * 90;
    const inBoundsL = exL > 50 && exL < WORLD_W - 50 && eyL > 50 && eyL < WORLD_H - 50;
    missileEvasionAngle = inBoundsL ? perpL : perpR;
    missileEvading = true;
    break;
  }

  // ── Wander / escape override ─────────────────────────────────────────────
  if (bot.botWanderTimer > 0) {
    bot.botWanderTimer--;
    const wd = normAngle(bot.botWander - bot.angle);
    if (Math.abs(wd) > 0.12) { inp.rotateRight = wd > 0; inp.rotateLeft = wd < 0; }
    else { inp.forward = !fwdBlocked; }
    if (fwdBlocked) {
      inp.forward = false;
      if (!rightBlocked) inp.rotateRight = true;
      else if (!leftBlocked) inp.rotateLeft = true;
      else inp.backward = true;
    }
    bot.botWasTryingToMove = inp.forward || inp.backward;
    return;
  }

  // ── Find closest alive enemy ─────────────────────────────────────────────
  let target = null, bestDist = Infinity;
  for (const [, p] of players) {
    if (p.id === bot.id || !p.alive) continue;
    const dx = p.x - bot.x, dy = p.y - bot.y;
    const d = dx * dx + dy * dy;
    if (d < bestDist) { bestDist = d; target = p; }
  }

  if (target) {
    const dist     = Math.sqrt(bestDist);
    const toTarget = Math.atan2(target.y - bot.y, target.x - bot.x);
    const los      = hasLineOfSight(bot.x, bot.y, target.x, target.y);

    // ── Adaptive learning: sample human player behaviour (hard only) ─────
    let model = null;
    if (cfg.predictShots && !target.isBot) {
      model = samplePlayerBehavior(target, bot);
    }

    // Aim angle: hard bots lead the shot; others aim directly
    let aimAngle = cfg.predictShots ? predictedAimAngle(bot, target) : toTarget;
    // Counter observed dodge bias: shift aim opposite to the player's habitual dodge
    if (model && Math.abs(model.dodgeBias) > 0.1) {
      aimAngle -= model.dodgeBias * 0.2; // up to ~0.2 rad counter-lean
    }
    const diff     = normAngle(aimAngle - bot.angle);

    // ── Bullet-in-motion awareness (hard) ────────────────────────────────
    // Scan all live bullets; if one will pass close, dodge perpendicular to it
    let dodging = false;
    if (cfg.bulletAware) {
      for (const b of bullets) {
        if (b.ownerId === bot.id) continue;
        if (bulletThreatens(b, bot.x, bot.y, TANK_RADIUS * 2.8)) {
          // Dodge: turn toward whichever perpendicular side is clear
          const perpL = normAngle(b.angle - Math.PI / 2 - bot.angle);
          const perpR = normAngle(b.angle + Math.PI / 2 - bot.angle);
          const dodgeAngle = (!leftBlocked && Math.abs(perpL) < Math.abs(perpR))
            ? bot.angle - Math.PI / 2
            : bot.angle + Math.PI / 2;
          steerToward(bot, dodgeAngle, inp, feelers);
          dodging = true;
          break;
        }
      }
    }

    if (!dodging) {
      // ── Missile evasion overrides normal movement (bot still fires) ───
      if (missileEvading) {
        steerToward(bot, missileEvasionAngle, inp, feelers);
      // ── Cover / retreat (medium when HP is low) ───────────────────────
      } else if (cfg.seekCover && bot.hp <= cfg.retreatHp) {
        const coverAngle = nearestObstacleAngle(bot);
        if (nearObstacle(bot.x, bot.y, TANK_RADIUS + 28)) {
          inp.rotateRight = diff >  0.08;
          inp.rotateLeft  = diff < -0.08;
        } else {
          steerToward(bot, coverAngle, inp, feelers);
        }
        if (bot.minesLeft > 0 && Math.random() < cfg.mineChance * 2) inp.mine = true;

      } else if (cfg.optimalRange) {
        // ── Hard: maintain optimal engagement range ───────────────────
        // Adapt range: stay further from rushers, close in on snipers
        const adaptedRange = model
          ? cfg.optimalRange * (0.75 + model.isRusher * 0.55)  // 0.75–1.3×
          : cfg.optimalRange;
        const lo = adaptedRange * 0.65, hi = adaptedRange * 1.5;
        if (!los) {
          // No line of sight — manoeuvre around the hedgerow to find a clear shot
          steerToward(bot, toTarget, inp, feelers);
        } else if (dist < lo) {
          // Too close — back away while keeping aim
          inp.rotateRight = diff >  0.08;
          inp.rotateLeft  = diff < -0.08;
          inp.backward    = true;
        } else if (dist > hi) {
          // Too far — close in, navigate around obstacles
          if (fwdBlocked) {
            if (!rightBlocked)     inp.rotateRight = true;
            else if (!leftBlocked) inp.rotateLeft  = true;
            else { inp.backward = true; bot.botWander = bot.angle + Math.PI; bot.botWanderTimer = 20; }
          } else {
            inp.rotateRight = diff >  0.08;
            inp.rotateLeft  = diff < -0.08;
            inp.forward = true;
          }
        } else {
          // In optimal range with clear shot — face target, inch forward to maintain pressure
          inp.rotateRight = diff >  0.08;
          inp.rotateLeft  = diff < -0.08;
          if (dist > lo * 1.15 && !fwdBlocked) inp.forward = true;
        }

      } else {
        // ── Easy / medium: direct chase ───────────────────────────────
        // If hedgerow is blocking LOS, close in aggressively to clear it
        if (!los || (dist > TANK_RADIUS * 3.5 && fwdBlocked)) {
          if (!rightBlocked)     { inp.rotateRight = true; }
          else if (!leftBlocked) { inp.rotateLeft  = true; }
          else {
            inp.backward = true;
            bot.botWander     = bot.angle + Math.PI + (Math.random() - 0.5) * 1.2;
            bot.botWanderTimer = 20 + Math.floor(Math.random() * 20);
          }
          if (!fwdBlocked) inp.forward = true;
        } else {
          inp.rotateRight = diff >  0.08;
          inp.rotateLeft  = diff < -0.08;
          inp.forward     = dist > TANK_RADIUS * 3.5;
        }
      }
    }

    // ── Fire — only when aimed and hedgerow is not blocking the shot ─────
    if (!dodging && Math.abs(diff) < cfg.fireAngleTol && los) inp.fire = true;

    // ── Mines ─────────────────────────────────────────────────────────────
    if (bot.minesLeft > 0 && Math.random() < cfg.mineChance) {
      if      (cfg.mineStrategy === 'random')     { inp.mine = true; }
      else if (cfg.mineStrategy === 'pursuit')    { if (enemyChasing(bot, target)) inp.mine = true; }
      else if (cfg.mineStrategy === 'chokepoint') { if (nearObstacle(bot.x, bot.y, TANK_RADIUS + 35)) inp.mine = true; }
    }

    // ── Missile ───────────────────────────────────────────────────────────
    if (bot.missileReady && Math.random() < cfg.missileChance) {
      if      (cfg.missileStrategy === 'random')        { inp.missile = true; }
      else if (cfg.missileStrategy === 'opportunistic') {
        if (targetInOpen(target)) { inp.missile = true; }
        // Flush campers: if player frequently hides, fire even when in cover
        else if (model && model.coverUsage > 0.45 && Math.random() < 0.45) { inp.missile = true; }
      }
    }

  } else {
    // ── No targets — wander ───────────────────────────────────────────────
    if (--bot.botWanderTimer <= 0) {
      bot.botWander     = Math.random() * Math.PI * 2;
      bot.botWanderTimer = 90 + Math.floor(Math.random() * 60);
    }
    const wd = normAngle(bot.botWander - bot.angle);
    if (Math.abs(wd) > 0.15) { inp.rotateRight = wd > 0; inp.rotateLeft = wd < 0; }
    inp.forward = true;
    if (fwdBlocked) {
      inp.forward = false;
      if (!rightBlocked)     inp.rotateRight = true;
      else if (!leftBlocked) inp.rotateLeft  = true;
      else { inp.backward = true; bot.botWanderTimer = 12; }
    }
  }

  bot.botWasTryingToMove = inp.forward || inp.backward;
}

function randomSpawn() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const x = 60 + Math.random() * (WORLD_W - 120);
    const y = 60 + Math.random() * (WORLD_H - 120);
    if (!tankCollidesWithObstacle(x, y)) return { x, y, angle: Math.random() * Math.PI * 2 };
  }
  // Fallback to centre if all attempts fail
  return { x: WORLD_W / 2, y: WORLD_H / 2, angle: 0 };
}

function createPlayer(id, ws) {
  const spawn = randomSpawn();
  return {
    id,
    ws,
    name: `Player ${id}`,
    color: PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length],
    x: spawn.x,
    y: spawn.y,
    angle: spawn.angle,
    hp: 100,
    score: 0,
    alive: true,
    respawnTimer: 0,
    fireCooldown: 0,
    minesLeft: MAX_MINES,
    mineCooldown: 0,
    missileReady: true,
    airStrikeReady: true,
    input: { forward: false, backward: false, rotateLeft: false, rotateRight: false, fire: false, mine: false, missile: false, airStrike: false }
  };
}

function tick() {
  tickRound();

  // Freeze gameplay between rounds / after match
  if (roundPhase !== 'active') {
    broadcastState();
    return;
  }

  // Run bot AI before processing inputs
  for (const [, p] of players) {
    if (p.isBot) tickBotAI(p);
  }

  // Process players
  for (const [, p] of players) {
    if (!p.alive) {
      p.respawnTimer--;
      if (p.respawnTimer <= 0) {
        const spawn = randomSpawn();
        p.alive = true;
        p.hp = 100;
        p.x = spawn.x;
        p.y = spawn.y;
        p.angle = spawn.angle;
      }
      continue;
    }

    const inp = p.input;
    if (inp.rotateLeft)  p.angle -= ROTATE_SPEED;
    if (inp.rotateRight) p.angle += ROTATE_SPEED;
    p.angle = ((p.angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

    let nx = p.x, ny = p.y;
    if (inp.forward)  { nx += Math.cos(p.angle) * TANK_SPEED; ny += Math.sin(p.angle) * TANK_SPEED; }
    if (inp.backward) { nx -= Math.cos(p.angle) * TANK_SPEED; ny -= Math.sin(p.angle) * TANK_SPEED; }
    nx = Math.max(TANK_RADIUS, Math.min(WORLD_W - TANK_RADIUS, nx));
    ny = Math.max(TANK_RADIUS, Math.min(WORLD_H - TANK_RADIUS, ny));
    if (!tankCollidesWithObstacle(nx, ny)) { p.x = nx; p.y = ny; }

    if (p.fireCooldown > 0) p.fireCooldown--;
    if (inp.fire && p.fireCooldown === 0) {
      bullets.push({
        id: nextBulletId++,
        ownerId: p.id,
        x: p.x + Math.cos(p.angle) * (TANK_RADIUS + 5),
        y: p.y + Math.sin(p.angle) * (TANK_RADIUS + 5),
        angle: p.angle,
        life: BULLET_LIFETIME_TICKS
      });
      p.fireCooldown = FIRE_COOLDOWN_TICKS;
    }

    if (p.mineCooldown > 0) p.mineCooldown--;
    if (inp.mine && p.mineCooldown === 0 && p.minesLeft > 0) {
      mines.push({
        id: nextMineId++,
        ownerId: p.id,
        color: p.color,
        x: p.x,
        y: p.y,
        armedTimer: MINE_ARMING_TICKS
      });
      p.minesLeft--;
      p.mineCooldown = MINE_COOLDOWN_TICKS;
    }

    if (inp.missile && p.missileReady && p.alive) {
      // Find closest alive enemy
      let target = null, bestDist = Infinity;
      for (const [, other] of players) {
        if (other.id === p.id || !other.alive) continue;
        const dx = other.x - p.x, dy = other.y - p.y;
        const d = dx * dx + dy * dy;
        if (d < bestDist) { bestDist = d; target = other; }
      }
      if (target) {
        missiles.push({
          id: nextMissileId++, ownerId: p.id, targetId: target.id,
          x: p.x + Math.cos(p.angle) * (TANK_RADIUS + 12),
          y: p.y + Math.sin(p.angle) * (TANK_RADIUS + 12),
          vx: Math.cos(p.angle) * MISSILE_SPEED,
          vy: Math.sin(p.angle) * MISSILE_SPEED,
          angle: p.angle,
          life: MISSILE_LIFETIME
        });
        p.missileReady = false;
      }
    }

    // Air strike
    if (inp.airStrike && p.airStrikeReady && p.alive) {
      airStrikes.push({
        id: nextAirStrikeId++, ownerId: p.id,
        x: -80, y: p.y,
        hitIds: new Set(),
      });
      p.airStrikeReady = false;
    }
  }

  handleTankCollisions();

  // Update bullets and check collisions
  bullets = bullets.filter(b => {
    b.x += Math.cos(b.angle) * BULLET_SPEED;
    b.y += Math.sin(b.angle) * BULLET_SPEED;
    b.life--;

    if (b.life <= 0 || b.x < 0 || b.x > WORLD_W || b.y < 0 || b.y > WORLD_H) return false;
    if (bulletHitsObstacle(b.x, b.y)) return false;

    for (const [, p] of players) {
      if (p.id === b.ownerId || !p.alive) continue;
      const dx = p.x - b.x;
      const dy = p.y - b.y;
      if (dx * dx + dy * dy < (TANK_RADIUS + BULLET_RADIUS) ** 2) {
        p.hp -= BULLET_DAMAGE;
        if (p.hp <= 0) {
          p.alive = false;
          p.respawnTimer = RESPAWN_DELAY_TICKS;
          const shooter = players.get(b.ownerId);
          if (shooter) shooter.score++;
        }
        return false;
      }
    }
    return true;
  });

  // Update mines
  mines = mines.filter(m => {
    if (m.armedTimer > 0) { m.armedTimer--; return true; }
    for (const [, p] of players) {
      if (p.id === m.ownerId || !p.alive) continue;
      const dx = p.x - m.x, dy = p.y - m.y;
      if (dx * dx + dy * dy < (MINE_RADIUS + TANK_RADIUS) ** 2) {
        p.hp -= MINE_DAMAGE;
        if (p.hp <= 0) {
          p.alive = false;
          p.respawnTimer = RESPAWN_DELAY_TICKS;
          const layer = players.get(m.ownerId);
          if (layer) layer.score++;
        }
        return false; // mine consumed
      }
    }
    return true;
  });

  // Update missiles (velocity-steered with limited turn rate)
  missiles = missiles.filter(m => {
    // Lifetime check
    m.life--;
    if (m.life <= 0) return false;

    // Re-target if current target gone/dead
    let tgt = players.get(m.targetId);
    if (!tgt || !tgt.alive) {
      let best = null, bestD = Infinity;
      for (const [, p] of players) {
        if (p.id === m.ownerId || !p.alive) continue;
        const dx = p.x - m.x, dy = p.y - m.y;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = p; }
      }
      if (!best) return false;
      m.targetId = best.id;
      tgt = best;
    }

    // Steer toward target with limited turn rate (creates the arc)
    const desired = Math.atan2(tgt.y - m.y, tgt.x - m.x);
    let diff = desired - m.angle;
    // Wrap to [-π, π]
    while (diff >  Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    m.angle += Math.sign(diff) * Math.min(Math.abs(diff), MISSILE_TURN_RATE);

    // Proximity check — explode when close enough
    const dx = tgt.x - m.x, dy = tgt.y - m.y;
    if (dx * dx + dy * dy <= (MISSILE_SPEED + 6) ** 2) {
      const owner = players.get(m.ownerId);
      for (const [, p] of players) {
        if (!p.alive) continue;
        const bx = p.x - tgt.x, by = p.y - tgt.y;
        if (Math.sqrt(bx * bx + by * by) <= MISSILE_BLAST_RADIUS) {
          p.hp = 0; p.alive = false; p.respawnTimer = RESPAWN_DELAY_TICKS;
          if (p.id !== m.ownerId && owner) owner.score++;
        }
      }
      return false;
    }

    // Advance along current heading
    m.vx = Math.cos(m.angle) * MISSILE_SPEED;
    m.vy = Math.sin(m.angle) * MISSILE_SPEED;
    m.x += m.vx;
    m.y += m.vy;
    return true;
  });

  // Update air strikes — jet flies left to right bombing tanks in its path
  const AIR_STRIKE_SPEED = 11; // px/tick → ~60% of original speed
  airStrikes = airStrikes.filter(a => {
    a.x += AIR_STRIKE_SPEED;
    for (const [, p] of players) {
      if (a.hitIds.has(p.id) || !p.alive || p.id === a.ownerId) continue; // skip owner
      // Bomb drops when jet passes overhead; hit anything within blast radius vertically
      if (Math.abs(p.x - a.x) < 30 && Math.abs(p.y - a.y) < MISSILE_BLAST_RADIUS) {
        a.hitIds.add(p.id);
        p.hp = 0;
        p.alive = false;
        p.respawnTimer = RESPAWN_DELAY_TICKS;
        const owner = players.get(a.ownerId);
        if (owner && p.id !== a.ownerId) owner.score++;
      }
    }
    return a.x < WORLD_W + 100;
  });

  broadcastState();
}

function broadcastState() {
  const state = JSON.stringify({
    type: 'state',
    players: Array.from(players.values()).map(p => ({
      id: p.id, name: p.name, color: p.color,
      x: p.x, y: p.y, angle: p.angle,
      hp: p.hp, score: p.score, alive: p.alive,
      respawnTimer: p.respawnTimer, minesLeft: p.minesLeft,
      missileReady: p.missileReady,
      airStrikeReady: p.airStrikeReady,
      roundWins: roundWins.get(p.id) || 0,
      isBot: !!p.isBot
    })),
    bullets:    bullets.map(b => ({ id: b.id, x: b.x, y: b.y, ownerId: b.ownerId })),
    mines:      mines.map(m => ({ id: m.id, x: m.x, y: m.y, color: m.color, armed: m.armedTimer === 0 })),
    missiles:   missiles.map(m => ({ id: m.id, x: m.x, y: m.y, angle: m.angle })),
    airStrikes: airStrikes.map(a => ({ id: a.id, x: a.x, y: a.y })),
    round: {
      number:        roundNumber,
      ticksLeft:     roundTicksLeft,
      phase:         roundPhase,
      pauseTicks,
      history:       roundHistory,
      matchWinnerId
    }
  });

  for (const [, p] of players) {
    if (!p.isBot && p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(state);
  }
}

wss.on('connection', ws => {
  const id = nextPlayerId++;
  const player = createPlayer(id, ws);
  players.set(id, player);

  ws.send(JSON.stringify({
    type: 'init', id, worldW: WORLD_W, worldH: WORLD_H, obstacles,
    peers: Array.from(players.values()).filter(p => !p.isBot && p.id !== id).map(p => p.id)
  }));

  // Tell existing real players a new peer joined (for WebRTC)
  for (const [pid, p] of players) {
    if (pid !== id && !p.isBot && p.ws && p.ws.readyState === WebSocket.OPEN)
      p.ws.send(JSON.stringify({ type: 'peer_joined', id }));
  }

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (!players.has(id)) return;
      const p = players.get(id);

      if (msg.type === 'input') {
        p.input.forward    = !!msg.forward;
        p.input.backward   = !!msg.backward;
        p.input.rotateLeft = !!msg.rotateLeft;
        p.input.rotateRight= !!msg.rotateRight;
        p.input.fire       = !!msg.fire;
        p.input.mine       = !!msg.mine;
        p.input.missile    = !!msg.missile;
        p.input.airStrike  = !!msg.airStrike;
      } else if (msg.type === 'name' && typeof msg.name === 'string') {
        p.name = msg.name.trim().substring(0, 16) || `Player ${id}`;
        // Single-player: spawn AI bots owned by this player
        if (msg.bots && msg.bots >= 1) {
          const count = Math.min(Math.floor(msg.bots), 5);
          const diff  = ['easy', 'medium', 'hard'].includes(msg.difficulty) ? msg.difficulty : 'medium';
          console.log(`[SP] Player ${id} "${p.name}" spawning ${count} ${diff} bots`);
          for (let i = 0; i < count; i++) {
            const botId = nextPlayerId++;
            players.set(botId, createBot(botId, id, diff, i));
          }
        }
      } else if (msg.type === 'rtc_offer' || msg.type === 'rtc_answer' || msg.type === 'rtc_ice') {
        // Relay WebRTC signaling to target player
        const target = players.get(msg.to);
        if (target && target.ws.readyState === WebSocket.OPEN)
          target.ws.send(JSON.stringify({ ...msg, from: id, to: undefined }));
      } else if (msg.type === 'speaking') {
        // Relay speaking state to all other players
        const payload = JSON.stringify({ type: 'speaking', id, speaking: !!msg.speaking });
        for (const [pid, op] of players) {
          if (pid !== id && !op.isBot && op.ws && op.ws.readyState === WebSocket.OPEN) op.ws.send(payload);
        }
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    playerModels.delete(id);
    // Remove any bots owned by this player
    for (const [pid, p] of players) {
      if (p.isBot && p.ownerId === id) players.delete(pid);
    }
    players.delete(id);
    // Tell remaining real players this peer left (for WebRTC cleanup)
    for (const [, p] of players) {
      if (!p.isBot && p.ws && p.ws.readyState === WebSocket.OPEN)
        p.ws.send(JSON.stringify({ type: 'peer_left', id }));
    }
  });
});

setInterval(tick, TICK_RATE);

httpServer.listen(PORT, () => {
  console.log(`Tank Battle running at http://localhost:${PORT}`);
});
