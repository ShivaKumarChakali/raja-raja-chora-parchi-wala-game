/**
 * Online test — run:  node test-online.js   (from server/)
 * Spawns server.js on port 3001, then drives TWO real Socket.IO clients:
 *  - Host (Shiva) creates a room
 *  - Priya joins with the room code (and a wrong code is rejected first)
 *  - Host fills with bots to 5, starts the game
 *  - Whenever it is a human's turn, that client makes a guess
 *  - Priya disconnects and rejoins with her saved playerId
 * Verifies: room code works, state never leaks hidden roles, a human
 * guess is accepted, and rejoin restores the seat.
 */
const { spawn } = require('child_process');
const http = require('http');
const { io } = require('socket.io-client');

const PORT = 3001;
const URL = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getHealth() {
  return new Promise((resolve) => {
    http.get(`${URL}/health`, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d));
    }).on('error', () => resolve(null));
  });
}

function emitAck(sock, event, payload, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: 'ack timeout' }), timeoutMs);
    sock.emit(event, payload, (res) => { clearTimeout(t); resolve(res || { ok: false, error: 'no reply' }); });
  });
}

async function main() {
  console.log('Raja Rani — online (2-client) test\n');
  const server = spawn('node', ['server.js'], {
    cwd: __dirname, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write('  [server] ' + d));
  server.stderr.on('data', (d) => process.stdout.write('  [server:err] ' + d));
  let ok = false;
  try {
    // Wait for the server to answer /health.
    let health = null;
    for (let i = 0; i < 40 && !health; i++) { health = await getHealth(); if (!health) await sleep(250); }
    console.log('  health:', health);
    if (!health) throw new Error('server did not start');

    const host = io(URL);
    const guest = io(URL);
    const states = { host: null, guest: null };
    host.on('state', (s) => { states.host = s; });
    guest.on('state', (s) => { states.guest = s; });
    host.on('guess_result', (r) => console.log('  host saw guess_result:', JSON.stringify(r)));
    await new Promise((r) => host.on('connect', r));
    await new Promise((r) => guest.on('connect', r));
    console.log('  both clients connected');

    // 1. Wrong code must be rejected.
    const bad = await emitAck(guest, 'join_room', { roomCode: 'XXXXX', name: 'Priya', avatar: '👸' });
    console.log('  join with wrong code ->', JSON.stringify(bad));
    if (bad.ok) throw new Error('wrong room code was accepted!');

    // 2. Host creates a room.
    const created = await emitAck(host, 'create_room', {
      name: 'Shiva', avatar: '👑',
      settings: { playerCount: 5, totalRounds: 5, twoThieves: false, wrongGuessPenalty: 0 },
    });
    console.log('  create_room ->', JSON.stringify(created));
    if (!created.ok || !created.roomCode) throw new Error('create_room failed');
    const code = created.roomCode;

    // 3. Guest joins with the real code.
    const joined = await emitAck(guest, 'join_room', { roomCode: code, name: 'Priya', avatar: '👸' });
    console.log('  join_room ->', JSON.stringify(joined));
    if (!joined.ok) throw new Error('join_room failed: ' + joined.error);

    // 4. Host fills empty seats with bots (2 humans + 3 bots = 5).
    const bots = await emitAck(host, 'add_bots', {});
    console.log('  add_bots ->', JSON.stringify(bots));
    await sleep(500);
    if (!states.host || states.host.players.length !== 5) {
      throw new Error('expected 5 players, got ' + (states.host && states.host.players.length));
    }
    console.log('  players:', states.host.players.map((p) => `${p.name}${p.isBot ? ' (bot)' : ''}`).join(', '));

    // 5. Host starts the game.
    const started = await emitAck(host, 'start_game', {});
    console.log('  start_game ->', JSON.stringify(started));
    if (!started.ok) throw new Error('start_game failed: ' + started.error);
    await sleep(500);
    if (states.host.phase !== 'guessing') throw new Error('expected guessing phase, got ' + states.host.phase);

    // 6. No hidden-role leak: each client sees only its own role.
    for (const [who, s] of Object.entries(states)) {
      const viewer = who === 'host' ? created.playerId : joined.playerId;
      const leaked = s.players.filter((p) => p.id !== viewer && !s.revealed.includes(p.id) && s.roles[p.id] !== null);
      if (leaked.length) throw new Error(`${who} state leaks hidden roles: ${leaked.map((p) => p.id)}`);
      console.log(`  ${who} sees only own role: ${s.myRole} (King revealed: ${s.revealed.length === 1})`);
    }

    // 7. Play: whenever a human is the guesser, that human guesses a
    //    random eligible target. Bots guess by themselves (server-driven).
    let humanGuesses = 0;
    const deadline = Date.now() + 90000;
    let guessInFlight = false;
    while (Date.now() < deadline) {
      const s = states.host;
      if (!s) { await sleep(300); continue; }
      if (s.phase === 'round-end' || s.phase === 'game-end') break;
      if (s.phase === 'guessing' && !guessInFlight) {
        const guesserId = s.currentGuesserId;
        const sock = guesserId === created.playerId ? host : guesserId === joined.playerId ? guest : null;
        if (sock) {
          const targets = s.players.filter((p) => p.id !== guesserId && !s.revealed.includes(p.id));
          if (targets.length) {
            guessInFlight = true;
            const target = targets[Math.floor(Math.random() * targets.length)];
            const who = guesserId === created.playerId ? 'Shiva' : 'Priya';
            const res = await emitAck(sock, 'make_guess', { targetId: target.id });
            console.log(`  ${who} guessed ${target.name} ->`, JSON.stringify(res));
            if (res.ok) humanGuesses += 1;
            guessInFlight = false;
          }
        }
      }
      await sleep(300);
    }
    console.log('  phase after play:', states.host.phase, '| human guesses accepted:', humanGuesses);
    if (humanGuesses < 1) throw new Error('no human guess was accepted');
    if (states.host.phase !== 'round-end' && states.host.phase !== 'game-end') {
      throw new Error('round did not finish in time; phase=' + states.host.phase);
    }
    if (states.host.roundScores.length) {
      console.log('  round scores:', JSON.stringify(states.host.roundScores[0].scores));
    }

    // 8. Rejoin: Priya disconnects, reconnects, restores her seat.
    guest.disconnect();
    await sleep(300);
    const guest2 = io(URL);
    const states2 = { s: null };
    guest2.on('state', (s) => { states2.s = s; });
    await new Promise((r) => guest2.on('connect', r));
    const rejoined = await emitAck(guest2, 'rejoin_room', { roomCode: code, playerId: joined.playerId });
    console.log('  rejoin_room ->', JSON.stringify(rejoined));
    if (!rejoined.ok) throw new Error('rejoin failed: ' + rejoined.error);
    await sleep(500);
    const priya = states2.s && states2.s.players.find((p) => p.id === joined.playerId);
    if (!priya || !priya.connected) throw new Error('rejoined seat is not connected');
    console.log('  Priya rejoined, seat connected:', priya.name, '| myRole restored:', states2.s.myRole);
    guest2.disconnect();
    host.disconnect();
    ok = true;
    console.log('\n✅ Online test PASSED — create, join (wrong code rejected), bots, start, human guess, no role leak, rejoin all work.');
  } finally {
    server.kill();
    if (!ok) { console.log('\n❌ Online test FAILED.'); process.exitCode = 1; }
  }
}
main().catch((e) => { console.error('❌ Online test FAILED:', e.message); process.exit(1); });
