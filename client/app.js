/* Raja Rani — client. Two modes, one UI:
   SOLO: local engine mirrors server/game.js exactly (same role order,
   same swap rule, same points), so solo play with bots behaves
   identically to the Socket.IO server.
   ONLINE: the server is the source of truth. This client only renders
   server state (see applyServerState) and emits the exact events from
   server/server.js: create_room, join_room, rejoin_room, add_bots,
   update_settings, start_game, make_guess, next_round, play_again, chat.
   Hidden roles are never in the client — getPublicState() only sends
   your own role plus revealed roles. */
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
const SESSION_KEY = 'rrc-session-v1';

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
let mode = 'solo'; // 'solo' | 'create' | 'join' — create/join are online modes

// Online (Socket.IO) session. Everything here is server-driven.
const online = {
  socket: null, handlersAttached: false, connected: false,
  roomCode: '', playerId: '', serverUrl: '',
  lastState: null, lastGuessAt: 0, lastSummary: null,
  guessLock: false, left: false, pendingRejoin: null, flash: null,
};

function isOnline() { return mode === 'create' || mode === 'join'; }
function onlineActive() { return isOnline() && online.roomCode; }
function myId() { return onlineActive() ? online.playerId : 'me'; }
function amHost() { const m = me(); return !!(m && m.isHost); }

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
  if (!id) return '—';
  if (state.roleNames[id]) return state.roleNames[id];
  const d = roleDef(id);
  return d ? (state.lang === 'hi' ? d.hi : d.en) : id;
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
  setTimeout(() => t.classList.add('hidden'), 3000);
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
function me() { return state.players.find((p) => p.id === myId()); }
function playerName(id) { const p = state.players.find((x) => x.id === id); return p ? p.name : id; }
function esc(s) { return String(s ?? '').replace(/</g, '&lt;'); }

// ------------------------------------------------------------ lobby (solo)
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
    inp.onchange = () => {
      state.settings.points[id] = Math.max(0, Number(inp.value) || 0);
      onSettingsControlChanged();
    };
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
    inp.onchange = () => {
      state.roleNames[d.id] = inp.value.trim();
      onSettingsControlChanged();
    };
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
  const roles = rolesNow();
  const defaults = defaultPoints(roles);
  Object.keys(defaults).forEach((id) => { if (!(id in state.settings.points)) state.settings.points[id] = defaults[id]; });
  state.settings.points.thief = 0;
  state.settings.language = state.lang;
  state.settings.roleNames = { ...state.roleNames };
}
function renderLobby() {
  if (onlineActive()) { renderLobbyOnline(); return; }
  syncSettingsFromLobby();
  $('lobbyCount').textContent = `${state.players.length} / ${state.settings.playerCount} players`;
  $('howRounds').textContent = state.settings.totalRounds;
  $('howCount').textContent = state.settings.playerCount;
  const wrap = $('lobbyPlayers'); wrap.innerHTML = '';
  state.players.forEach((p) => {
    const d = document.createElement('div');
    d.className = 'player' + (p.id === myId() ? ' me' : '');
    d.innerHTML = `<div class="av">${p.avatar}</div><div class="nm">${esc(p.name)}${p.isHost ? ' 👑 host' : ''}</div><div class="role muted">${p.isBot ? 'Bot' : 'You / Player'}</div>`;
    wrap.appendChild(d);
  });
  renderPointsGrid();
  renderHowTable();
}
function renderHowTable() {
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

// ------------------------------------------------------------ online: connection
function defaultServerUrl() {
  if (location.protocol.startsWith('http')) return location.origin;
  return 'http://localhost:3001';
}
function saveSession() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      roomCode: online.roomCode, playerId: online.playerId,
      name: $('myName').value.trim(), avatar: state.myAvatar,
    }));
  } catch (e) { /* storage unavailable — rejoin just won't survive a reload */ }
}
function loadSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; }
}
function clearSession() { try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ } }
function setOnlineStatus(text, onlineNow) {
  const el = $('onlineStatus');
  el.textContent = text;
  el.classList.toggle('green', !!onlineNow);
  el.classList.toggle('red', !onlineNow && isOnline());
}

/** Connect to the game server. Resolves with the socket, or rejects with
    a plain-English reason. CDN missing / unreachable server -> reject. */
function connectOnline() {
  return new Promise((resolve, reject) => {
    if (typeof io === 'undefined') {
      reject(new Error('Socket.IO did not load (check your internet connection). Solo mode still works.'));
      return;
    }
    const url = ($('serverUrl').value || '').trim() || defaultServerUrl();
    online.serverUrl = url;
    if (online.socket && online.socket.connected) { resolve(online.socket); return; }
    if (online.socket) { online.socket.connect(); }
    else {
      online.socket = io(url, { reconnection: true, reconnectionAttempts: 5, timeout: 8000 });
      attachSocketHandlers(online.socket);
    }
    const sock = online.socket;
    if (sock.connected) { resolve(sock); return; }
    const timer = setTimeout(() => reject(new Error(`Could not reach the game server at ${url}. Is it running? Solo mode still works.`)), 9000);
    sock.once('connect', () => { clearTimeout(timer); resolve(sock); });
    sock.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not reach the game server at ${url} (${err && err.message ? err.message : 'connection failed'}). Solo mode still works.`));
    });
  });
}
function attachSocketHandlers(sock) {
  if (online.handlersAttached) return;
  online.handlersAttached = true;
  sock.on('connect', () => {
    online.connected = true;
    if (online.pendingRejoin) {
      const rej = online.pendingRejoin; online.pendingRejoin = null;
      doRejoin(rej.roomCode, rej.playerId);
    }
  });
  sock.on('disconnect', () => {
    online.connected = false;
    if (onlineActive()) {
      setOnlineStatus('● Disconnected — your seat is held, a bot takes over after 45s. Tap Rejoin.', false);
      toast('Lost connection to the server — your seat is held. It will try to reconnect.');
    }
  });
  sock.on('state', (s) => { if (s) applyServerState(s); });
  sock.on('guess_result', () => { online.guessLock = false; });
  sock.on('draw_slip', (d) => {
    sfx.rustle();
    toast(`🃏 Round ${d && d.round ? d.round : ''} — slips shuffled!${d && d.tieBreaker ? ' Tie-breaker!' : ''}`);
    const slip = $('mySlip'); slip.classList.add('folded', 'shuffling');
    setTimeout(() => slip.classList.remove('shuffling'), 900);
  });
  sock.on('round_end', (summary) => { online.lastSummary = summary || null; showRoundSummary(summary); });
  sock.on('game_end', (d) => { showFinal(d && d.winners, d && d.scores); });
  sock.on('chat', (msg) => {
    if (!msg) return;
    if (msg.system) chatLog(`<i class="muted">${esc(msg.text)}</i>`);
    else if (msg.emoji) chatLog(`<b>${esc(msg.name || 'Player')}</b> reacted ${esc(msg.emoji)}`);
    else chatLog(`<b>${esc(msg.name || 'Player')}</b>: ${esc(msg.text)}`);
  });
}
function emitWithAck(event, payload) {
  return new Promise((resolve) => {
    if (!online.socket || !online.socket.connected) { resolve({ ok: false, error: 'Not connected to the server.' }); return; }
    online.socket.emit(event, payload || {}, (res) => resolve(res || { ok: false, error: 'No reply from server.' }));
  });
}

// ------------------------------------------------------------ online: lobby
async function createOnlineRoom() {
  hide('joinError');
  let sock;
  try { sock = await connectOnline(); } catch (e) { toast(e.message); setOnlineStatus('● Server unreachable — solo mode still works', false); return; }
  syncSettingsFromLobby();
  const res = await emitWithAck('create_room', {
    name: $('myName').value.trim() || 'Host', avatar: state.myAvatar,
    settings: { ...state.settings },
  });
  if (!res.ok) { toast(res.error || 'Could not create the room.'); return; }
  online.roomCode = res.roomCode; online.playerId = res.playerId; online.left = false;
  roomCode = res.roomCode; $('roomCode').textContent = roomCode;
  saveSession();
  setOnlineStatus(`● Online — Room ${roomCode} • share the code!`, true);
  toast(`Room ${roomCode} created! Share the code or link with friends.`);
  $('waitingHint').textContent = 'Waiting for friends… add bots or wait, then Start.';
}
async function joinOnlineRoom(code) {
  const clean = (code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{5}$/.test(clean)) { showJoinError('Enter the 5-letter room code from your friend.'); return; }
  hide('joinError');
  try { await connectOnline(); } catch (e) { showJoinError(e.message); return; }
  const res = await emitWithAck('join_room', {
    roomCode: clean, name: $('myName').value.trim() || 'Player', avatar: state.myAvatar,
  });
  if (!res.ok) { showJoinError(res.error || 'Could not join the room.'); return; }
  online.roomCode = res.roomCode; online.playerId = res.playerId; online.left = false;
  roomCode = res.roomCode; $('roomCode').textContent = roomCode;
  saveSession();
  setOnlineStatus(`● Online — Room ${roomCode}`, true);
  toast(`Joined room ${roomCode}!`);
}
function showJoinError(msg) {
  const el = $('joinError'); el.textContent = '⚠️ ' + msg; el.classList.remove('hidden');
  toast(msg);
}
async function doRejoin(code, playerId) {
  const res = await emitWithAck('rejoin_room', { roomCode: code, playerId });
  if (!res.ok) {
    clearSession();
    toast('Could not rejoin that seat (' + (res.error || 'room gone') + '). Enter the code to join again.');
    setMode('join'); $('joinCode').value = code || '';
    return;
  }
  online.roomCode = res.roomCode; online.playerId = res.playerId; online.left = false;
  roomCode = res.roomCode; $('roomCode').textContent = roomCode;
  setMode('join');
  saveSession();
  setOnlineStatus(`● Online — Room ${roomCode} • seat restored`, true);
  toast('Welcome back — your seat and slip were restored.');
}
function renderLobbyOnline() {
  $('howRounds').textContent = state.settings.totalRounds;
  $('howCount').textContent = state.settings.playerCount;
  // Settings controls reflect the SERVER's settings (host changes push them).
  $('pcVal').textContent = state.settings.playerCount;
  $('roundsSel').value = String(state.settings.totalRounds);
  $('twoThieves').classList.toggle('on', !!state.settings.twoThieves);
  $('penaltySel').value = String(state.settings.wrongGuessPenalty);
  $('lobbyCount').textContent = `${state.players.length} / ${state.settings.playerCount} players`;
  $('roomCode').textContent = online.roomCode || '—';
  setOnlineStatus(`● Online — Room ${online.roomCode} • ${state.players.length}/${state.settings.playerCount} players`, true);
  const host = amHost();
  $('createRoomBtn').classList.add('hidden');
  $('startBtn').classList.toggle('hidden', !host || state.phase !== 'lobby');
  $('addBotBtn').classList.toggle('hidden', !host || state.phase !== 'lobby');
  $('waitingHint').textContent = host
    ? 'You are the host — add bots or wait for friends, then Start.'
    : 'Waiting for the host to start the game…';
  const wrap = $('lobbyPlayers'); wrap.innerHTML = '';
  state.players.forEach((p) => {
    const d = document.createElement('div');
    d.className = 'player' + (p.id === myId() ? ' me' : '');
    d.innerHTML = `<div class="av">${p.avatar}</div><div class="nm">${esc(p.name)}${p.isHost ? ' 👑 host' : ''}</div><div class="role muted">${p.isBot ? 'Bot' : (p.id === myId() ? 'You' : 'Player')}${p.connected ? '' : ' • away'}</div>`;
    wrap.appendChild(d);
  });
  renderPointsGrid();
  renderHowTable();
  showScreen('lobby');
}
function onSettingsControlChanged() {
  // Solo: re-render locally. Online lobby, host only: push to the server.
  if (onlineActive() && state.phase === 'lobby' && amHost()) pushOnlineSettings();
  else if (!onlineActive()) renderLobby();
}
async function pushOnlineSettings() {
  syncSettingsFromLobby();
  const res = await emitWithAck('update_settings', { settings: { ...state.settings } });
  if (!res.ok) toast(res.error || 'Could not update settings.');
}

// ------------------------------------------------------------ online: state
function applyServerState(s) {
  online.lastState = s;
  state.settings = { ...(s.settings || state.settings) };
  if (s.settings && s.settings.roleNames) state.roleNames = { ...s.settings.roleNames };
  state.phase = s.phase; state.round = s.round;
  state.revealed = [...(s.revealed || [])];
  state.currentGuesserId = s.currentGuesserId;
  state.currentTargetRoleId = s.currentTargetRoleId;
  state.thievesFound = s.thievesFound || 0;
  state.thievesTotal = s.thievesTotal || 1;
  state.lastGuess = s.lastGuess || null;
  state.roundScores = s.roundScores || [];
  state.winners = s.winners || [];
  state.tieBreaker = !!s.tieBreaker;
  state.players = (s.players || []).map((p) => ({
    id: p.id, name: p.name, avatar: p.avatar, isBot: p.isBot, isHost: p.isHost,
    connected: p.connected, score: p.score, wrongGuesses: p.wrongGuesses,
  }));
  state.assignments = {};
  Object.keys(s.roles || {}).forEach((pid) => { if (s.roles[pid]) state.assignments[pid] = s.roles[pid]; });
  if (s.myRole) state.assignments[online.playerId] = s.myRole;
  // Log each new guess exactly once (server state is re-broadcast often).
  if (s.lastGuess && s.lastGuess.at && s.lastGuess.at !== online.lastGuessAt) {
    online.lastGuessAt = s.lastGuess.at;
    logGuess(s.lastGuess);
  }
  if (s.phase === 'lobby') { renderLobbyOnline(); }
  else if (s.phase === 'guessing' || s.phase === 'draw') { renderGame(); }
  else if (s.phase === 'round-end') { showRoundSummary(); }
  else if (s.phase === 'game-end') { showFinal(); }
}
function logGuess(lg) {
  if (lg.correct) {
    log(`✅ <b>${esc(playerName(lg.guesserId))}</b> found the <b>${roleName(lg.roleId)}</b> — it's <b>${esc(playerName(lg.targetId))}</b>!`);
    sfx.correct();
    online.flash = { pid: lg.targetId, cls: 'correct' };
  } else {
    log(`❌ <b>${esc(playerName(lg.guesserId))}</b> guessed <b>${esc(playerName(lg.targetId))}</b> — wrong! Slips swapped. <b>${esc(playerName(lg.targetId))}</b> is now the ${roleName(lg.guesserRole)} and tries again.`);
    sfx.wrong();
    online.flash = { pid: lg.targetId, cls: 'swap wrong' };
  }
}
async function onlineGuess(targetId) {
  if (online.guessLock) return;
  if (state.currentGuesserId !== myId()) { toast('Not your turn to guess.'); return; }
  if (targetId === myId()) { toast("You can't guess yourself!"); return; }
  if (state.revealed.includes(targetId)) { toast('That player is already revealed.'); return; }
  online.guessLock = true;
  const res = await emitWithAck('make_guess', { targetId });
  if (!res.ok) { online.guessLock = false; toast(res.error || 'Guess failed.'); renderGame(); }
  // On success the server emits guess_result + state; guessLock clears
  // on guess_result, and applyServerState re-renders the table.
  setTimeout(() => { online.guessLock = false; }, 5000); // safety net
}

// ------------------------------------------------------------ rounds (solo)
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
  if (onlineActive()) return; // online bots are driven by the server
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
    ? `<b>${esc(guesser.name)}</b> — find the <b>${targetName}</b>! Tap a face-down player.`
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
  // My slip — online: only myRole ever arrives from the server.
  const myRole = state.assignments[myId()];
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
    const isMe = p.id === myId();
    const myTurn = state.phase === 'guessing' && state.currentGuesserId === myId() && !state.leftSeat && !online.left;
    const guessable = myTurn && p.id !== myId() && !isRevealed && !online.guessLock;
    const d = document.createElement('div');
    d.className = 'player' + (isMe ? ' me' : '') + (isGuesser ? ' active' : '')
      + (isRevealed ? ' revealed' : '') + (guessable ? ' guessable' : ' disabled');
    d.dataset.pid = p.id;
    d.innerHTML = `<div class="av">${p.avatar}</div><div class="nm">${esc(p.name)}${isMe ? ' (you)' : ''}${p.isBot ? ' 🤖' : ''}${p.connected ? '' : ' • away'}</div>`
      + `<div class="role">${isRevealed && roleId ? `${roleDef(roleId).emoji} ${roleName(roleId)}` : '🗒️ Folded slip'}</div>`
      + `<div class="pts">${p.score} pts${p.wrongGuesses ? ` • ${p.wrongGuesses} wrong` : ''}${isGuesser ? ' • 👉 guessing' : ''}</div>`
      + (isRevealed && roleId === 'king' ? '<span class="crown">👑</span>' : '');
    if (guessable) d.onclick = () => (onlineActive() ? onlineGuess(p.id) : makeGuess('me', p.id));
    table.appendChild(d);
  });
  if (online.flash) {
    const el = document.querySelector(`[data-pid="${online.flash.pid}"]`);
    if (el) el.classList.add(...online.flash.cls.split(' '));
    online.flash = null;
  }
  if (onlineActive()) $('leaveBtn').textContent = online.left ? '↩️ Rejoin my seat' : '🚪 Leave (bot takes over)';
}
function scoreTableHTML(rows) {
  return `<table class="score"><thead><tr><th>#</th><th>Player</th><th>Final role</th><th>Round pts</th><th>Total</th></tr></thead><tbody>`
    + rows.map((r, i) => `<tr><td>${i + 1}</td><td>${r.avatar} ${esc(r.name)}</td><td>${r.role && roleDef(r.role) ? `${roleDef(r.role).emoji} ${roleName(r.role)}` : '—'}</td><td>${r.points}</td><td><b>${r.total}</b></td></tr>`).join('')
    + `</tbody></table>`;
}
function showRoundSummary(summary) {
  let rows;
  if (summary && summary.rows) {
    rows = [...summary.rows].sort((a, b) => b.total - a.total);
    $('roundTitle').textContent = `Round ${summary.round} over!${summary.tieBreaker ? ' (Tie-breaker)' : ''}`;
  } else {
    const last = state.roundScores[state.roundScores.length - 1];
    if (!last) return;
    $('roundTitle').textContent = `Round ${last.round} over!${last.tieBreaker ? ' (Tie-breaker)' : ''}`;
    rows = state.players.map((p) => ({
      id: p.id, name: p.name, avatar: p.avatar, role: last.roles[p.id], points: last.scores[p.id], total: p.score,
    })).sort((a, b) => b.total - a.total);
  }
  $('roundTable').innerHTML = scoreTableHTML(rows);
  $('leaderboard').innerHTML = scoreTableHTML(rows.map((r) => ({ ...r, points: r.total })));
  showScreen('round');
}
function showFinal(winnersOverride, scoresOverride) {
  let top;
  if (winnersOverride && winnersOverride.length) {
    top = winnersOverride.map((id) => state.players.find((p) => p.id === id)).filter(Boolean);
    if (!top.length) top = leaders();
  } else if (state.winners && state.winners.length) {
    top = state.winners.map((id) => state.players.find((p) => p.id === id)).filter(Boolean);
    if (!top.length) top = leaders();
  } else {
    top = leaders();
  }
  $('winnerTitle').textContent = top.length === 1 ? `🏆 ${top[0].name} wins!` : `🏆 It's a tie — ${top.map((p) => p.name).join(' & ')} win!`;
  $('winnerSub').textContent = `${state.settings.totalRounds} rounds played • Top score: ${top[0] ? top[0].score : 0} points`;
  const sorted = scoresOverride && scoresOverride.length
    ? [...scoresOverride].sort((a, b) => b.score - a.score)
    : [...state.players].sort((a, b) => b.score - a.score);
  const rows = sorted.map((p) => ({
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

// ------------------------------------------------------------ mode tabs
function setMode(m) {
  mode = m;
  ['tabCreate', 'tabJoin', 'tabSolo'].forEach((id) => $(id).classList.remove('sel'));
  $('tabCreate').classList.toggle('sel', m === 'create');
  $('tabJoin').classList.toggle('sel', m === 'join');
  $('tabSolo').classList.toggle('sel', m === 'solo');
  $('joinPanel').classList.toggle('hidden', m !== 'join');
  $('settingsGrid').classList.toggle('hidden', m === 'join');
  $('createRoomBtn').classList.toggle('hidden', m !== 'create');
  $('startBtn').classList.toggle('hidden', m !== 'solo');
  $('addBotBtn').classList.toggle('hidden', m !== 'solo');
  $('newCode').classList.toggle('hidden', m !== 'solo');
  if (m === 'create') {
    $('modeHint').textContent = 'Create a room on the server — share the 5-letter code, friends join from any phone.';
    $('roomHint').textContent = 'The server gives you a real room code after you tap Create room. Share the link — friends type the code to join.';
    $('waitingHint').textContent = '';
    if (!onlineActive()) { ensureMe(); renderLobby(); setOnlineStatus('● Online — not created yet', false); }
  } else if (m === 'join') {
    $('modeHint').textContent = 'Enter the 5-letter code from your friend, then tap Join room.';
    $('waitingHint').textContent = '';
    if (!onlineActive()) { $('lobbyPlayers').innerHTML = '<div class="muted">Join a room to see who is in it.</div>'; $('lobbyCount').textContent = 'Not in a room yet'; }
  } else {
    $('modeHint').textContent = 'Practice alone against bots — runs entirely in this browser.';
    $('roomHint').textContent = 'Solo mode runs entirely in this browser with bots. To play online with friends, use Create Room above — the server gives you a real code to share.';
    $('waitingHint').textContent = '';
    setOnlineStatus('● Solo practice — no server needed', false);
    ensureMe(); renderLobby();
  }
}

// ------------------------------------------------------------ wiring
function init() {
  $('serverUrl').value = defaultServerUrl();
  newRoomCode(); renderAvatars(); renderNameEditor();
  state.settings.points = defaultPoints(rolesNow());
  ensureMe(); renderLobby();

  $('tabCreate').onclick = () => setMode('create');
  $('tabJoin').onclick = () => setMode('join');
  $('tabSolo').onclick = () => setMode('solo');
  $('pcMinus').onclick = () => { const v = Math.max(5, Number($('pcVal').textContent) - 1); $('pcVal').textContent = v; onSettingsControlChanged(); };
  $('pcPlus').onclick = () => { const v = Math.min(10, Number($('pcVal').textContent) + 1); $('pcVal').textContent = v; onSettingsControlChanged(); };
  $('roundsSel').onchange = onSettingsControlChanged;
  $('penaltySel').onchange = onSettingsControlChanged;
  $('twoThieves').onclick = (e) => { e.currentTarget.classList.toggle('on'); onSettingsControlChanged(); };
  $('fillBots').onclick = (e) => { e.currentTarget.classList.toggle('on'); };
  $('myName').oninput = () => { if (!onlineActive()) { ensureMe(); renderLobby(); } };
  $('newCode').onclick = () => { newRoomCode(); toast('New room code: ' + roomCode); };
  $('copyLink').onclick = async () => {
    const code = onlineActive() ? online.roomCode : roomCode;
    const link = `${location.origin}${location.pathname}?room=${code}`;
    try { await navigator.clipboard.writeText(link); toast('Link copied — share it!'); }
    catch { toast('Room code: ' + code + ' — copy it manually.'); }
  };
  $('createRoomBtn').onclick = createOnlineRoom;
  $('joinBtn').onclick = () => joinOnlineRoom($('joinCode').value);
  $('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinOnlineRoom($('joinCode').value); });
  $('joinCode').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); hide('joinError'); });
  $('addBotBtn').onclick = async () => {
    if (onlineActive()) {
      const res = await emitWithAck('add_bots', {});
      if (!res.ok) toast(res.error || 'Could not add bots.');
      return;
    }
    addBot();
  };
  $('startBtn').onclick = async () => {
    if (onlineActive()) {
      const res = await emitWithAck('start_game', {});
      if (!res.ok) toast(res.error || 'Could not start the game.');
      return;
    }
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
  $('nextRoundBtn').onclick = async () => {
    if (onlineActive()) {
      const res = await emitWithAck('next_round', {});
      if (!res.ok) toast(res.error || 'Could not go to the next round.');
      return;
    }
    const next = advanceAfterRound();
    if (next === 'game-end') showFinal();
    else startRound();
  };
  $('playAgainBtn').onclick = async () => {
    if (onlineActive()) {
      const res = await emitWithAck('play_again', {});
      if (!res.ok) toast(res.error || 'Could not restart.');
      return;
    }
    state.players.forEach((p) => { p.score = 0; });
    state.round = 0; state.roundScores = []; state.winners = [];
    state.tieBreaker = false; state.tieBreakerCount = 0; state.phase = 'lobby';
    renderLobby(); showScreen('lobby');
  };
  $('backLobbyBtn').onclick = async () => {
    if (onlineActive()) {
      // Reset scores on the server, then show the online lobby.
      await emitWithAck('play_again', {});
      return;
    }
    state.phase = 'lobby'; renderLobby(); showScreen('lobby');
  };
  $('leaveBtn').onclick = async () => {
    if (onlineActive()) {
      if (!online.left) {
        online.left = true;
        if (online.socket) online.socket.disconnect();
        state.leftSeat = true;
        toast('You left — a bot takes over your seat after 45s. Tap Rejoin to take it back.');
        log('🚪 <b>You</b> left. 🤖 Bot will take over your seat.');
        renderGame();
      } else {
        online.left = false; state.leftSeat = false;
        const sess = loadSession();
        if (sess && sess.roomCode && sess.playerId) {
          online.pendingRejoin = { roomCode: sess.roomCode, playerId: sess.playerId };
          try { await connectOnline(); toast('Rejoining your seat…'); }
          catch (e) { toast(e.message); }
        }
        renderGame();
      }
      return;
    }
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
    // Online: never jump back to the lobby mid-game — just re-render
    // the current screen from server state.
    if (onlineActive()) {
      renderHowTable();
      if (state.phase === 'guessing') renderGame();
      else if (state.phase === 'lobby') renderLobbyOnline();
      else if (state.phase === 'round-end') showRoundSummary();
      else if (state.phase === 'game-end') showFinal();
    } else {
      renderLobby(); if (state.phase === 'guessing') renderGame();
    }
    toast(state.lang === 'hi' ? 'हिन्दी नाम चालू' : 'English names on');
  };
  $('soundBtn').onclick = (e) => {
    state.sound = !state.sound;
    e.currentTarget.textContent = state.sound ? '🔊 Sound' : '🔇 Muted';
    if (state.sound) beep(600, 0.1);
  };
  $('howBtn').onclick = () => { renderHowTable(); $('howModal').classList.remove('hidden'); };
  $('howClose').onclick = () => $('howModal').classList.add('hidden');
  $('howModal').onclick = (e) => { if (e.target.id === 'howModal') $('howModal').classList.add('hidden'); };
  $('chatSend').onclick = sendChat;
  $('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
  const emojis = ['😂', '👏', '🔥', '😮', '🎉', '🤔', '👑', '🥷'];
  emojis.forEach((em) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = em;
    b.onclick = () => {
      if (onlineActive() && online.socket && online.socket.connected) online.socket.emit('chat', { emoji: em });
      else chatLog(`<b>${me() ? esc(me().name) : 'You'}</b> reacted ${em}`);
    };
    $('emojiRow').appendChild(b);
  });
  function sendChat() {
    const v = $('chatInput').value.trim();
    if (!v) return;
    if (onlineActive() && online.socket && online.socket.connected) {
      online.socket.emit('chat', { text: v });
    } else {
      chatLog(`<b>${me() ? esc(me().name) : 'You'}</b>: ${esc(v)}`);
      if (Math.random() < 0.5) {
        const bot = state.players.find((p) => p.isBot);
        if (bot) setTimeout(() => chatLog(`<b>${esc(bot.name)}</b>: ${['😂😂', 'Arre wah!', 'My turn next!', '👑'][Math.floor(Math.random() * 4)]}`), 900);
      }
    }
    $('chatInput').value = '';
  }

  // ?room=XXXXX: pre-fill Join mode. Stored session: try to rejoin on load.
  const params = new URLSearchParams(location.search);
  const urlRoom = params.get('room');
  const sess = loadSession();
  if (urlRoom) {
    setMode('join');
    $('joinCode').value = urlRoom.toUpperCase();
    $('roomCode').textContent = urlRoom.toUpperCase();
    if (sess && sess.roomCode === urlRoom.toUpperCase() && sess.playerId) {
      // Reload mid-game in this room: restore the seat automatically.
      online.pendingRejoin = { roomCode: sess.roomCode, playerId: sess.playerId };
      connectOnline().catch((e) => { toast(e.message + ' Enter the code to join again.'); });
    } else {
      toast('Room ' + urlRoom.toUpperCase() + ' — enter your name and tap Join room.');
    }
  } else if (sess && sess.roomCode && sess.playerId) {
    setMode('join');
    $('joinCode').value = sess.roomCode;
    $('roomCode').textContent = sess.roomCode;
    online.pendingRejoin = { roomCode: sess.roomCode, playerId: sess.playerId };
    connectOnline().catch(() => { /* server down: stay in Join mode, solo still works */ });
  }
}
document.addEventListener('DOMContentLoaded', init);
