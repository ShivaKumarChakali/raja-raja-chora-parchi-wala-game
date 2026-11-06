/**
 * Raja Rani Mantri Chor Sipahi — realtime server (Express + Socket.IO).
 *
 * Run:  npm install && npm start        (from server/)
 *        or from repo root: npm run server
 * Env:  PORT (default 3001), CLIENT_URL (default http://localhost:5173)
 *
 * Server is the source of truth. Every state broadcast is per-player
 * via game.getPublicState(game, socketPlayerId) — hidden roles are
 * never sent to anyone who should not see them.
 */
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const game = require('./game');

const PORT = Number(process.env.PORT || 3001);
const app = express();
app.use(express.json());

// Serve the plain-HTML client when deployed together (client/ is ../client).
app.use(express.static(path.join(__dirname, '..', 'client')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('/api/roles', (req, res) => {
  const n = Number(req.query.players || 5);
  const twoThieves = req.query.twoThieves === 'true';
  try {
    const roles = game.getRolesForPlayerCount(n, { twoThieves });
    res.json({ players: n, roles, points: game.defaultPoints(roles) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CLIENT_URL || '*', methods: ['GET', 'POST'] },
});

const rooms = new Map(); // roomCode -> { game, sockets: Map<playerId, socketId>, timers }
const BOT_TAKEOVER_MS = 45_000; // bot takes over a disconnected player after 45s

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? roomCode() : code;
}

function broadcast(room) {
  // Per-player view: each socket gets ONLY its own safe state.
  for (const [playerId, socketId] of room.sockets) {
    const sock = io.sockets.sockets.get(socketId);
    if (sock) sock.emit('state', game.getPublicState(room.game, playerId));
  }
  // Spectators / lobby watchers get a no-role view.
  io.to(room.game.id).emit('lobby-count', { players: room.game.players.length });
}

function findRoomBySocket(socket) {
  for (const room of rooms.values()) {
    if (room.sockets.has(socket.data.playerId)) return room;
  }
  return null;
}

function maybeBotTurn(room) {
  const g = room.game;
  if (g.phase !== 'guessing' || !g.currentGuesserId) return;
  const guesser = g.players.find((p) => p.id === g.currentGuesserId);
  if (!guesser || !guesser.isBot) return;
  // Clear any pending bot timer, then act after a human-like delay.
  if (room.botTimer) clearTimeout(room.botTimer);
  room.botTimer = setTimeout(() => {
    const targetId = game.chooseBotGuess(g);
    if (!targetId) return;
    const res = game.makeGuess(g, g.currentGuesserId, targetId);
    io.to(g.id).emit('guess_result', res);
    if (res.roundEnded) {
      io.to(g.id).emit('round_end', game.getRoundSummary(g));
    }
    broadcast(room);
    maybeBotTurn(room); // chain: next guesser may also be a bot
  }, 1100 + Math.random() * 900);
}

io.on('connection', (socket) => {
  socket.data.playerId = null;

  socket.on('create_room', ({ name, avatar, settings } = {}, cb) => {
    try {
      const g = game.createGame({ ...(settings || {}), id: roomCode() });
      const playerId = `p-${socket.id.slice(0, 8)}`;
      const added = game.addPlayer(g, { id: playerId, name: name || 'Host', avatar: avatar || '👑' });
      if (!added.ok) return cb?.({ ok: false, error: added.error });
      const room = { game: g, sockets: new Map([[playerId, socket.id]]), botTimer: null };
      rooms.set(g.id, room);
      socket.data.playerId = playerId;
      socket.join(g.id);
      cb?.({ ok: true, roomCode: g.id, playerId });
      broadcast(room);
    } catch (e) { cb?.({ ok: false, error: e.message }); }
  });

  socket.on('join_room', ({ roomCode: code, name, avatar } = {}, cb) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: 'Room not found. Check the code.' });
    const playerId = `p-${socket.id.slice(0, 8)}`;
    const added = game.addPlayer(room.game, { id: playerId, name: name || 'Player', avatar: avatar || '🙂' });
    if (!added.ok) return cb?.({ ok: false, error: added.error });
    room.sockets.set(playerId, socket.id);
    socket.data.playerId = playerId;
    socket.join(room.game.id);
    cb?.({ ok: true, roomCode: room.game.id, playerId });
    io.to(room.game.id).emit('chat', { system: true, text: `${name} joined the room.` });
    broadcast(room);
  });

  // Reconnect with the same playerId: restore seat + role.
  socket.on('rejoin_room', ({ roomCode: code, playerId } = {}, cb) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: 'Room not found' });
    const p = room.game.players.find((x) => x.id === playerId);
    if (!p) return cb?.({ ok: false, error: 'Seat not found' });
    p.connected = true;
    p.isBot = false; // human is back — take the seat back from the bot
    if (room.takeoverTimer) { clearTimeout(room.takeoverTimer); room.takeoverTimer = null; }
    room.sockets.set(playerId, socket.id);
    socket.data.playerId = playerId;
    socket.join(room.game.id);
    cb?.({ ok: true, roomCode: room.game.id, playerId });
    broadcast(room);
  });

  socket.on('add_bots', (_payload, cb) => {
    const room = findRoomBySocket(socket);
    if (!room) return cb?.({ ok: false, error: 'Not in a room' });
    game.fillWithBots(room.game);
    cb?.({ ok: true, count: room.game.players.length });
    broadcast(room);
  });

  socket.on('update_settings', ({ settings } = {}, cb) => {
    const room = findRoomBySocket(socket);
    if (!room) return cb?.({ ok: false, error: 'Not in a room' });
    if (room.game.phase !== 'lobby') return cb?.({ ok: false, error: 'Game already started' });
    try {
      const validated = game.validateSettings({ ...room.game.settings, ...(settings || {}) });
      // Player-count change in lobby: trim / keep players to fit.
      room.game.settings = validated;
      while (room.game.players.length > validated.playerCount) {
        const removed = room.game.players.pop();
        room.sockets.delete(removed.id);
      }
      cb?.({ ok: true });
      broadcast(room);
    } catch (e) { cb?.({ ok: false, error: e.message }); }
  });

  socket.on('start_game', (_payload, cb) => {
    const room = findRoomBySocket(socket);
    if (!room) return cb?.({ ok: false, error: 'Not in a room' });
    const g = room.game;
    if (g.players.length < g.settings.playerCount) {
      return cb?.({ ok: false, error: `Need ${g.settings.playerCount} players (have ${g.players.length}). Add bots or wait.` });
    }
    const res = game.startRound(g);
    if (!res.ok) return cb?.({ ok: false, error: res.error });
    io.to(g.id).emit('draw_slip', { round: g.round });
    cb?.({ ok: true });
    broadcast(room);
    maybeBotTurn(room);
  });

  socket.on('make_guess', ({ targetId } = {}, cb) => {
    const room = findRoomBySocket(socket);
    if (!room) return cb?.({ ok: false, error: 'Not in a room' });
    const g = room.game;
    // Single-flight guard: ignore a guess if one is already being resolved
    // in this tick (Socket.IO delivers in order per socket; this also
    // protects against double-taps from the client).
    if (room.guessLock) return cb?.({ ok: false, error: 'Guess already in progress' });
    room.guessLock = true;
    try {
      const res = game.makeGuess(g, socket.data.playerId, targetId);
      if (!res.ok) return cb?.({ ok: false, error: res.error });
      io.to(g.id).emit('guess_result', res);
      if (res.roundEnded) io.to(g.id).emit('round_end', game.getRoundSummary(g));
      cb?.({ ok: true, ...res });
      broadcast(room);
      maybeBotTurn(room);
    } finally { room.guessLock = false; }
  });

  socket.on('next_round', (_payload, cb) => {
    const room = findRoomBySocket(socket);
    if (!room) return cb?.({ ok: false, error: 'Not in a room' });
    const g = room.game;
    if (g.phase !== 'round-end') return cb?.({ ok: false, error: 'Round is not over yet' });
    const adv = game.advanceAfterRound(g);
    if (!adv.ok) return cb?.({ ok: false, error: adv.error });
    if (adv.next === 'game-end') {
      io.to(g.id).emit('game_end', { winners: adv.winners, scores: g.players });
      cb?.({ ok: true, next: 'game-end' });
    } else {
      const res = game.startRound(g);
      if (!res.ok) return cb?.({ ok: false, error: res.error });
      io.to(g.id).emit('draw_slip', { round: g.round, tieBreaker: adv.next === 'tie-breaker' });
      cb?.({ ok: true, next: adv.next });
    }
    broadcast(room);
    maybeBotTurn(room);
  });

  socket.on('play_again', (_payload, cb) => {
    const room = findRoomBySocket(socket);
    if (!room) return cb?.({ ok: false, error: 'Not in a room' });
    const g = room.game;
    g.players.forEach((p) => { p.score = 0; });
    g.round = 0; g.roundScores = []; g.winners = [];
    g.tieBreaker = false; g.tieBreakerCount = 0; g.phase = 'lobby';
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('chat', ({ text, emoji } = {}) => {
    const room = findRoomBySocket(socket);
    if (!room) return;
    const p = room.game.players.find((x) => x.id === socket.data.playerId);
    if (!p) return;
    io.to(room.game.id).emit('chat', {
      name: p.name, avatar: p.avatar,
      text: (text || '').slice(0, 200), emoji: emoji || null, at: Date.now(),
    });
  });

  socket.on('disconnect', () => {
    const room = findRoomBySocket(socket);
    if (!room) return;
    const playerId = socket.data.playerId;
    const p = room.game.players.find((x) => x.id === playerId);
    if (!p) return;
    p.connected = false;
    room.sockets.delete(playerId);
    io.to(room.game.id).emit('chat', { system: true, text: `${p.name} disconnected. Seat held for reconnect.` });
    // Host leaving: transfer host to the next connected player.
    if (p.isHost) {
      const next = room.game.players.find((x) => x.id !== playerId && x.connected);
      if (next) { p.isHost = false; next.isHost = true; }
    }
    // Bot takeover if they stay away too long (mid-round only).
    if (room.game.phase === 'guessing') {
      room.takeoverTimer = setTimeout(() => {
        p.isBot = true; // a bot plays this seat until the human rejoins
        io.to(room.game.id).emit('chat', { system: true, text: `🤖 Bot took over ${p.name}'s seat.` });
        broadcast(room);
        maybeBotTurn(room);
      }, BOT_TAKEOVER_MS);
    }
    broadcast(room);
    // Clean up empty rooms after 10 minutes.
    if (room.game.players.every((x) => !x.connected)) {
      setTimeout(() => {
        if (room.game.players.every((x) => !x.connected)) rooms.delete(room.game.id);
      }, 10 * 60 * 1000);
    }
  });
});

server.listen(PORT, () => {
  console.log(`🃏 Raja Rani Mantri Chor Sipahi server on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Client: http://localhost:${PORT}/  (serves client/)`);
});
