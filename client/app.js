/* Raja Rani — solo client. Local engine mirrors server/game.js exactly
   (same role order, same swap rule, same points), so solo play with bots
   behaves identically to the Socket.IO server. */
'use strict';

const ROLE_DEFS = [
  { id: 'king', en: 'King', hi: 'Raja', emoji: '👑' },
  { id: 'queen', en: 'Queen', hi: 'Rani', emoji: '👸' },
  { id: 'minister', en: 'Minister', hi: 'Mantri', emoji: '🎩' },
  { id: 'commander', en: 'Commander', hi: 'Senapati', emoji: '⚔️' },
  { id: 'judge', en: 'Judge', hi: 'Nyayadhish', emoji: '⚖️' },
  { id: 'doctor', en: 'Doctor', hi: 'Vaidya', emoji: '🩺' },
  { id: 'merchant', en: 'Merchant', hi: 'Vyapari', emoji: '💰' },
  { id: 'farmer', en: 'Farmer', hi: 'Kisan', emoji: '🌾' },
  { id: 'police', en: 'Police', hi: 'Sipahi', emoji: '👮' },
  { id: 'thief', en: 'Thief', hi: 'Chor', emoji: '🥷' },
];
const MIDDLE = ROLE_DEFS.slice(0, 8);
const BOT_NAMES = ['Chintu', 'Bunty', 'Pinky', 'Raju', 'Meena', 'Golu', 'Chotu', 'Babita', 'Monty'];
const BOT_AVATARS = ['🤖', '🦊', '🐼', '🦁', '🐸', '🦄', '🐯', '🐵', '🦉'];
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ state
const state = {
  lang: 'en', sound: true, myAvatar: '😎',
  settings: { playerCount: 5, totalRounds: 10, twoThieves: false, wrongGuessPenalty: 0, points: {} },
  roleNames: {}, // roleId -> custom display name
  players: [], // {id,name,avatar,isBot,isHost,connected,score,wrongGuesses}
  phase: 'lobby', round: 0,
  assignments: {}, revealed: [], currentGuesserId: null, currentTargetRoleId: null,
  thievesFound: 0, thievesTotal: 1, lastGuess: null,
  roundScores: [], winners: [], tieBreaker: false, tieBreakerCount: 0,
  lock: false, leftSeat: false,
};
let roomCode = '';

function getRoles(n, twoThieves) {
  if (twoThieves && n < 8) throw new Error('Two Thieves needs 8+ players');
  const tail = twoThieves ? 3 : 2;
  const roles = MIDDLE.slice(0, n - tail).map((r) => r.id);
  roles.push('police', 'thief');
  if (twoThieves) roles.push('thief');
  return roles;
}
function defaultPoints(roles) {
  const p = {};
  roles.forEach((id, i) => { p[id] = id === 'thief' ? 0 : Math.max(0, 100 - i * 10); });
  return p;
}
function roleDef(id) { return ROLE_DEFS.find((r) => r.id === id); }
function roleName(id) {
  if (state.roleNames[id]) return state.roleNames[id];
  const d = roleDef(id);
  return state.lang === 'hi' ? d.hi : d.en;
}
function rolesNow() { return getRoles(state.settings.playerCount, state.settings.twoThieves); }
function pointsFor(id) { return state.settings.points[id] ?? (id === 'thief' ? 0 : 0); }

// ------------------------------------------------------------ sound (Web Audio, no files)
let audioCtx = null;
function beep(freq = 600, dur = 0.12, type = 'sine', vol = 0.12) {
  if (!state.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + dur);
  } catch (e) { /* audio not available — game still works */ }
}
const sfx = {
  rustle() { beep(300, 0.08, 'triangle', 0.08); setTimeout(() => beep(420, 0.08, 'triangle', 0.06), 90); },
  correct() { beep(660, 0.12); setTimeout(() => beep(880, 0.18), 120); },
  wrong() { beep(220, 0.2, 'sawtooth', 0.07); },
  win() { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => beep(f, 0.2), i * 130)); },
};

// ------------------------------------------------------------ helpers
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2600);
}
function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }
function showScreen(name) {
  ['screen-lobby', 'screen-game', 'screen-round', 'screen-final'].forEach((id) => hide(id));
  show('screen-' + name);
}
function shuffle(a) {
  const arr = [...a];
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}
function me() { return state.players.find((p) => p.id === 'me'); }
function playerName(id) { const p = state.players.find((x) => x.id === id); return p ? p.name : id; }

// ------------------------------------------------------------ lobby
function newRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  roomCode = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  $('roomCode').textContent = roomCode;
}
function renderAvatars() {
  const wrap = $('avatars'); wrap.innerHTML = '';
  ['😎', '👑', '👸', '🦊', '🐼', '🦁', '🐸', '🦄', '🤖', '🎩'].forEach((a) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = a;
    if (a === state.myAvatar) b.classList.add('sel');
    b.onclick = () => { state.myAvatar = a; renderAvatars(); renderLobby(); };
    wrap.appendChild(b);
  });
}
function renderPointsGrid() {
  const grid = $('pointsGrid'); grid.innerHTML = '';
  rolesNow().forEach((id) => {
    const d = roleDef(id);
    const lab = document.createElement('label');
    lab.innerHTML = `<span>${d.emoji} ${d.en}</span>`;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.min = 0; inp.max = 200; inp.value = pointsFor(id);
    inp.disabled = id === 'thief';
    inp.onchange = () => { state.settings.points[id] = Math.max(0, Number(inp.value) || 0); };
    lab.appendChild(inp); grid.appendChild(lab);
  });
}
function renderNameEditor() {
  const box = $('nameEditor'); box.innerHTML = '';
  ROLE_DEFS.forEach((d) => {
    const row = document.createElement('div');
    row.className = 'row'; row.style.margin = '.25rem 0';
    row.innerHTML = `<span style="min-width:90px">${d.emoji} ${d.en} / ${d.hi}</span>`;
    const inp = document.createElement('input');
    inp.value = state.roleNames[d.id] || ''; inp.placeholder = d.en; inp.style.flex = '1';
    inp.onchange = () => { state.roleNames[d.id] = inp.value.trim(); };
    row.appendChild(inp); box.appendChild(row);
  });
}
function syncSettingsFromLobby() {
  state.settings.playerCount = Number($('pcVal').textContent);
  state.settings.totalRounds = Number($('roundsSel').value);
  state.settings.twoThieves = $('twoThieves').classList.contains('on');
  state.settings.wrongGuessPenalty = Number($('penaltySel').value);
  if (state.settings.twoThieves && state.settings.playerCount < 8) {
    state.settings.twoThieves = false; $('twoThieves').classList.remove('on');
    toast('Two Thieves needs 8+ players — turned off.');
  }
  // Rebuild default points if the role list changed and points were not customised.
  const roles = rolesNow();
  const defaults = defaultPoints(roles);
  Object.keys(defaults).forEach((id) => { if (!(id in state.settings.points)) state.settings.points[id] = defaults[id]; });
  state.settings.points.thief = 0;
}
function renderLobby() {
  syncSettingsFromLobby();
  $('lobbyCount').textContent = `${state.players.length} / ${state.settings.playerCount} players`;
  $('howRounds').textContent = state.settings.totalRounds;
  $('howCount').textContent = state.settings.playerCount;
  const wrap = $('lobbyPlayers'); wrap.innerHTML = '';
  state.players.forEach((p) => {
    const d = document.createElement('div');
    d.className = 'player' + (p.id === 'me' ? ' me' : '');
    d.innerHTML = `<div class="av">${p.avatar}</div><div class="nm">${p.name}${p.isHost ? ' 👑 host' : ''}</div><div class="role muted">${p.isBot ? 'Bot' : 'You / Player'}</div>`;
    wrap.appendChild(d);
  });
  renderPointsGrid();
  // How-to-play table
  const tbody = document.querySelector('#howTable tbody'); tbody.innerHTML = '';
  rolesNow().forEach((id, i) => {
    const d = roleDef(id);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${i + 1}</td><td>${d.emoji} ${roleName(id)} <span class="muted">(${d.en} / ${d.hi})</span></td><td>${pointsFor(id)}</td>`;
    tbody.appendChild(tr);
  });
}
function addBot() {
  if (state.players.length >= state.settings.playerCount) { toast('Room is full.'); return; }
  const i = state.players.filter((p) => p.isBot).length;
  state.players.push({
    id: 'bot-' + Date.now() + '-' + i, name: BOT_NAMES[i % BOT_NAMES.length],
    avatar: BOT_AVATARS[i % BOT_AVATARS.length], isBot: true, isHost: false,
    connected: true, score: 0, wrongGuesses: 0,
  });
  renderLobby();
}
function ensureMe() {
  if (!me()) {
    state.players.unshift({
      id: 'me', name: $('myName').value.trim() || 'You', avatar: state.myAvatar,
      isBot: false, isHost: true, connected: true, score: 0, wrongGuesses: 0,
    });
  } else {
    me().name = $('myName').value.trim() || 'You'; me().avatar = state.myAvatar;
  }
}

// ------------------------------------------------------------ rounds
function startRound() {
  const roles = shuffle(rolesNow());
  state.assignments = {};
  state.players.forEach((p, i) => { state.assignments[p.id] = roles[i]; p.wrongGuesses = 0; });
  const kingId = state.players.find((p) => state.assignments[p.id] === 'king').id;
  state.revealed = [kingId];
  state.currentGuesserId = kingId;
  state.currentTargetRoleId = 'queen';
  state.thievesFound = 0;
  state.thievesTotal = state.settings.twoThieves ? 2 : 1;
  state.lastGuess = null;
  state.round += 1;
  state.phase = 'guessing';
  $('gameLog').innerHTML = '';
  log(`🃏 Round ${state.round} — slips shuffled! The King is <b>${playerName(kingId)}</b>.`);
  sfx.rustle();
  renderGame();
  maybeBotTurn();
}
function nextTargetAfter(roleId) {
  const roles = rolesNow();
  if (roleId === 'thief') return state.thievesFound < state.thievesTotal ? 'thief' : null;
  const idx = roles.indexOf(roleId);
  return idx >= 0 && idx + 1 < roles.length ? roles[idx + 1] : null;
}
function eligibleTargets() {
  return state.players.filter((p) => p.id !== state.currentGuesserId && !state.revealed.includes(p.id));
}
function log(html) {
  const d = document.createElement('div'); d.innerHTML = html;
  $('gameLog').prepend(d);
}
function chatLog(html) {
  const d = document.createElement('div'); d.innerHTML = html;
  $('chatLog').appendChild(d);
}

function makeGuess(guesserId, targetId) {
  if (state.phase !== 'guessing' || state.lock) return { ok: false, error: 'Not your turn' };
  if (guesserId !== state.currentGuesserId) return { ok: false, error: 'Not your turn to guess' };
  if (guesserId === targetId) { toast("You can't guess yourself!"); return { ok: false, error: 'self' }; }
  if (state.revealed.includes(targetId)) { toast('That player is already revealed.'); return { ok: false, error: 'revealed' }; }
  state.lock = true;
  const targetRole = state.assignments[targetId];
  const wanted = state.currentTargetRoleId;
  const guesser = state.players.find((p) => p.id === guesserId);

  if (targetRole === wanted) {
    state.revealed.push(targetId);
    state.lastGuess = { guesserId, targetId, correct: true, roleId: targetRole };
    log(`✅ <b>${playerName(guesserId)}</b> found the <b>${roleName(targetRole)}</b> — it's <b>${playerName(targetId)}</b>!`);
    sfx.correct();
    const el = document.querySelector(`[data-pid="${targetId}"]`);
    if (el) el.classList.add('correct');
    if (targetRole === 'thief') {
      state.thievesFound += 1;
      if (state.thievesFound >= state.thievesTotal) {
        state.lock = false; endRound(); return { ok: true, correct: true, roundEnded: true };
      }
      state.currentGuesserId = targetId; state.currentTargetRoleId = 'thief';
    } else {
      state.currentGuesserId = targetId;
      state.currentTargetRoleId = nextTargetAfter(targetRole);
    }
    state.lock = false; renderGame(); maybeBotTurn();
    return { ok: true, correct: true };
  }

  // WRONG — swap slips. The role moves to the target, who tries again.
  guesser.wrongGuesses = (guesser.wrongGuesses || 0) + 1;
  const guesserRole = state.assignments[guesserId];
  state.assignments[guesserId] = targetRole;
  state.assignments[targetId] = guesserRole;
  state.revealed = state.revealed.filter((id) => id !== guesserId);
  if (!state.revealed.includes(targetId)) state.revealed.push(targetId);
  state.lastGuess = { guesserId, targetId, correct: false, guesserRole, targetRole };
  log(`❌ <b>${playerName(guesserId)}</b> guessed <b>${playerName(targetId)}</b> as ${roleName(wanted)} — wrong! Slips swapped. <b>${playerName(targetId)}</b> is now the ${roleName(guesserRole)} and tries again.`);
  sfx.wrong();
  const el = document.querySelector(`[data-pid="${targetId}"]`);
  if (el) el.classList.add('swap', 'wrong');
  state.currentGuesserId = targetId; // new holder tries again; target role unchanged
  state.lock = false; renderGame(); maybeBotTurn();
  return { ok: true, correct: false, swapped: true };
}

function maybeBotTurn() {
  if (state.phase !== 'guessing') return;
  const guesser = state.players.find((p) => p.id === state.currentGuesserId);
  if (!guesser || !guesser.isBot) return;
  setTimeout(() => {
    if (state.phase !== 'guessing') return;
    const eligible = eligibleTargets();
    if (!eligible.length) return;
    const pick = eligible[Math.floor(Math.random() * eligible.length)];
    makeGuess(state.currentGuesserId, pick.id);
  }, 1100 + Math.random() * 900);
}

function endRound() {
  const scores = {}; const rolesSnap = { ...state.assignments };
  state.players.forEach((p) => {
    const base = pointsFor(state.assignments[p.id]);
    const gained = Math.max(0, base - state.settings.wrongGuessPenalty * (p.wrongGuesses || 0));
    scores[p.id] = gained; p.score += gained;
  });
  state.roundScores.push({ round: state.round, scores, roles: rolesSnap, tieBreaker: state.tieBreaker });
  state.phase = 'round-end';
  sfx.win();
  showRoundSummary();
}
function leaders() {
  const max = Math.max(...state.players.map((p) => p.score), 0);
  return state.players.filter((p) => p.score === max);
}
function advanceAfterRound() {
  if (state.round < state.settings.totalRounds) return 'next-round';
  const top = leaders();
  if (top.length > 1 && state.tieBreakerCount < 3) {
    state.tieBreaker = true; state.tieBreakerCount += 1;
    toast(`🤝 Tie at the top! Tie-breaker round ${state.tieBreakerCount}.`);
    return 'tie-breaker';
  }
  state.winners = top.map((p) => p.id); state.tieBreaker = false; state.phase = 'game-end';
  return 'game-end';
}

// ------------------------------------------------------------ rendering
function renderGame() {
  showScreen('game');
  $('roundPill').textContent = `Round ${state.round} / ${state.settings.totalRounds}${state.tieBreaker ? ' — tie-breaker!' : ''}`;
  const guesser = state.players.find((p) => p.id === state.currentGuesserId);
  const targetName = state.currentTargetRoleId ? roleName(state.currentTargetRoleId) : '—';
  $('turnPill').textContent = guesser ? `${guesser.name}'s turn` : '';
  $('turnText').innerHTML = guesser
    ? `<b>${guesser.name}</b> — find the <b>${targetName}</b>! Tap a face-down player.`
    : '';
  $('scorePill').textContent = `You: ${me() ? me().score : 0} pts`;
  // Chain
  const chain = $('chain'); chain.innerHTML = '';
  rolesNow().forEach((id) => {
    const holder = state.players.find((p) => state.assignments[p.id] === id);
    const done = holder && state.revealed.includes(holder.id);
    const now = id === state.currentTargetRoleId;
    const d = roleDef(id);
    const s = document.createElement('div');
    s.className = 'step' + (done ? ' done' : '') + (now ? ' now' : '');
    s.innerHTML = `${d.emoji}<br>${roleName(id)}${done ? '<br>✓' : ''}${now ? '<br>👉' : ''}`;
    chain.appendChild(s);
  });
  // My slip
  const myRole = state.assignments.me;
  const slip = $('mySlip');
  slip.classList.remove('folded');
  if (myRole) {
    const d = roleDef(myRole);
    $('slipEmoji').textContent = d.emoji;
    $('slipName').textContent = roleName(myRole);
    $('slipHi').textContent = state.lang === 'hi' ? d.en : d.hi;
    $('slipPts').textContent = `${pointsFor(myRole)} points if you finish as ${roleName(myRole)}`;
  }
  // Table
  const table = $('gameTable'); table.innerHTML = '';
  state.players.forEach((p) => {
    const isRevealed = state.revealed.includes(p.id);
    const roleId = state.assignments[p.id];
    const isGuesser = p.id === state.currentGuesserId;
    const isMe = p.id === 'me';
    const guessable = state.phase === 'guessing' && state.currentGuesserId === 'me' && !state.leftSeat
      && p.id !== 'me' && !isRevealed;
    const d = document.createElement('div');
    d.className = 'player' + (isMe ? ' me' : '') + (isGuesser ? ' active' : '')
      + (isRevealed ? ' revealed' : '') + (guessable ? ' guessable' : ' disabled');
    d.dataset.pid = p.id;
    d.innerHTML = `<div class="av">${p.avatar}</div><div class="nm">${p.name}${isMe ? ' (you)' : ''}${p.isBot ? ' 🤖' : ''}</div>`
      + `<div class="role">${isRevealed ? `${roleDef(roleId).emoji} ${roleName(roleId)}` : '🗒️ Folded slip'}</div>`
      + `<div class="pts">${p.score} pts${p.wrongGuesses ? ` • ${p.wrongGuesses} wrong` : ''}${isGuesser ? ' • 👉 guessing' : ''}</div>`
      + (isRevealed && roleId === 'king' ? '<span class="crown">👑</span>' : '');
    if (guessable) d.onclick = () => makeGuess('me', p.id);
    table.appendChild(d);
  });
}
function scoreTableHTML(rows) {
  return `<table class="score"><thead><tr><th>#</th><th>Player</th><th>Final role</th><th>Round pts</th><th>Total</th></tr></thead><tbody>`
    + rows.map((r, i) => `<tr><td>${i + 1}</td><td>${r.avatar} ${r.name}</td><td>${roleDef(r.role).emoji} ${roleName(r.role)}</td><td>${r.points}</td><td><b>${r.total}</b></td></tr>`).join('')
    + `</tbody></table>`;
}
function showRoundSummary() {
  const last = state.roundScores[state.roundScores.length - 1];
  $('roundTitle').textContent = `Round ${last.round} over!${last.tieBreaker ? ' (Tie-breaker)' : ''}`;
  const rows = state.players.map((p) => ({
    id: p.id, name: p.name, avatar: p.avatar, role: last.roles[p.id], points: last.scores[p.id], total: p.score,
  })).sort((a, b) => b.total - a.total);
  $('roundTable').innerHTML = scoreTableHTML(rows);
  $('leaderboard').innerHTML = scoreTableHTML(rows.map((r) => ({ ...r, points: r.total })));
  showScreen('round');
}
function showFinal() {
  const top = leaders();
  $('winnerTitle').textContent = top.length === 1 ? `🏆 ${top[0].name} wins!` : `🏆 It's a tie — ${top.map((p) => p.name).join(' & ')} win!`;
  $('winnerSub').textContent = `${state.settings.totalRounds} rounds played • Top score: ${top[0].score} points`;
  const rows = [...state.players].sort((a, b) => b.score - a.score).map((p) => ({
    id: p.id, name: p.name, avatar: p.avatar, role: state.assignments[p.id], points: p.score, total: p.score,
  }));
  $('finalTable').innerHTML = scoreTableHTML(rows);
  showScreen('final');
  sfx.win(); launchConfetti();
}
function launchConfetti() {
  const c = $('confetti'); c.classList.remove('hidden');
  c.width = innerWidth; c.height = innerHeight;
  const ctx = c.getContext('2d');
  const pieces = Array.from({ length: 160 }, () => ({
    x: Math.random() * c.width, y: -20 - Math.random() * c.height * 0.5,
    w: 6 + Math.random() * 8, h: 8 + Math.random() * 8,
    color: ['#f2b705', '#7b1e26', '#2e7d32', '#ff7043', '#1976d2'][Math.floor(Math.random() * 5)],
    vy: 2 + Math.random() * 3, vx: -1 + Math.random() * 2, r: Math.random() * Math.PI,
  }));
  let frames = 0;
  (function tick() {
    ctx.clearRect(0, 0, c.width, c.height);
    pieces.forEach((p) => { p.y += p.vy; p.x += p.vx; p.r += 0.05; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore(); });
    if (++frames < 220) requestAnimationFrame(tick);
    else c.classList.add('hidden');
  })();
}

// ------------------------------------------------------------ wiring
function init() {
  newRoomCode(); renderAvatars(); renderNameEditor();
  state.settings.points = defaultPoints(rolesNow());
  ensureMe(); renderLobby();

  $('pcMinus').onclick = () => { const v = Math.max(5, Number($('pcVal').textContent) - 1); $('pcVal').textContent = v; renderLobby(); };
  $('pcPlus').onclick = () => { const v = Math.min(10, Number($('pcVal').textContent) + 1); $('pcVal').textContent = v; renderLobby(); };
  $('roundsSel').onchange = renderLobby;
  $('penaltySel').onchange = renderLobby;
  $('twoThieves').onclick = (e) => { e.currentTarget.classList.toggle('on'); renderLobby(); };
  $('fillBots').onclick = (e) => { e.currentTarget.classList.toggle('on'); };
  $('myName').oninput = () => { ensureMe(); renderLobby(); };
  $('newCode').onclick = () => { newRoomCode(); toast('New room code: ' + roomCode); };
  $('copyLink').onclick = async () => {
    const link = `${location.origin}${location.pathname}?room=${roomCode}`;
    try { await navigator.clipboard.writeText(link); toast('Link copied — share it!'); }
    catch { toast('Room code: ' + roomCode + ' — copy it manually.'); }
  };
  $('addBotBtn').onclick = addBot;
  $('startBtn').onclick = () => {
    ensureMe(); syncSettingsFromLobby();
    if ($('fillBots').classList.contains('on')) {
      while (state.players.length < state.settings.playerCount) addBot();
    }
    if (state.players.length < state.settings.playerCount) {
      toast(`Need ${state.settings.playerCount} players — add bots or wait for friends.`);
      return;
    }
    state.round = 0; state.roundScores = []; state.winners = [];
    state.tieBreaker = false; state.tieBreakerCount = 0;
    state.players.forEach((p) => { p.score = 0; });
    state.phase = 'draw';
    $('mySlip').classList.add('folded', 'shuffling');
    showScreen('game');
    setTimeout(() => { $('mySlip').classList.remove('shuffling'); startRound(); }, 900);
  };
  $('nextRoundBtn').onclick = () => {
    const next = advanceAfterRound();
    if (next === 'game-end') showFinal();
    else startRound();
  };
  $('playAgainBtn').onclick = () => {
    state.players.forEach((p) => { p.score = 0; });
    state.round = 0; state.roundScores = []; state.winners = [];
    state.tieBreaker = false; state.tieBreakerCount = 0; state.phase = 'lobby';
    renderLobby(); showScreen('lobby');
  };
  $('backLobbyBtn').onclick = () => { state.phase = 'lobby'; renderLobby(); showScreen('lobby'); };
  $('leaveBtn').onclick = () => {
    if (!state.leftSeat) {
      state.leftSeat = true; me().isBot = true; me().connected = false;
      $('leaveBtn').textContent = '↩️ Rejoin my seat';
      toast('You left — a bot took over your seat. Tap Rejoin to take it back.');
      log('🚪 <b>You</b> left. 🤖 Bot took over your seat.');
      renderGame(); maybeBotTurn();
    } else {
      state.leftSeat = false; me().isBot = false; me().connected = true;
      $('leaveBtn').textContent = '🚪 Leave (bot takes over)';
      toast('Welcome back — your seat and slip were restored.');
      log('↩️ <b>You</b> rejoined and took your seat back.');
      renderGame(); maybeBotTurn();
    }
  };
  $('mySlip').onclick = () => { $('mySlip').classList.toggle('folded'); sfx.rustle(); };
  $('langBtn').onclick = () => {
    state.lang = state.lang === 'en' ? 'hi' : 'en';
    $('langBtn').textContent = state.lang === 'en' ? 'हिन्दी' : 'English';
    renderLobby(); if (state.phase === 'guessing') renderGame();
    toast(state.lang === 'hi' ? 'हिन्दी नाम चालू' : 'English names on');
  };
  $('soundBtn').onclick = (e) => {
    state.sound = !state.sound;
    e.currentTarget.textContent = state.sound ? '🔊 Sound' : '🔇 Muted';
    if (state.sound) beep(600, 0.1);
  };
  $('howBtn').onclick = () => { renderLobby(); $('howModal').classList.remove('hidden'); };
  $('howClose').onclick = () => $('howModal').classList.add('hidden');
  $('howModal').onclick = (e) => { if (e.target.id === 'howModal') $('howModal').classList.add('hidden'); };
  $('chatSend').onclick = sendChat;
  $('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
  const emojis = ['😂', '👏', '🔥', '😮', '🎉', '🤔', '👑', '🥷'];
  emojis.forEach((em) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = em;
    b.onclick = () => chatLog(`<b>${me() ? me().name : 'You'}</b> reacted ${em}`);
    $('emojiRow').appendChild(b);
  });
  function sendChat() {
    const v = $('chatInput').value.trim();
    if (!v) return;
    chatLog(`<b>${me() ? me().name : 'You'}</b>: ${v.replace(/</g, '&lt;')}`);
    $('chatInput').value = '';
    // A bot sometimes replies, so solo chat feels alive.
    if (Math.random() < 0.5) {
      const bot = state.players.find((p) => p.isBot);
      if (bot) setTimeout(() => chatLog(`<b>${bot.name}</b>: ${['😂😂', 'Arre wah!', 'My turn next!', '👑'][Math.floor(Math.random() * 4)]}`), 900);
    }
  }
  // Join via ?room=XXXXX (server mode): show the code in the lobby.
  const params = new URLSearchParams(location.search);
  if (params.get('room')) { roomCode = params.get('room').toUpperCase(); $('roomCode').textContent = roomCode; toast('Joining room ' + roomCode + ' — start the server to play with friends.'); }
}
document.addEventListener('DOMContentLoaded', init);
