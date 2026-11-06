/**
 * Raja Rani Mantri Chor Sipahi — pure, server-authoritative game engine.
 *
 * No Socket.IO / Express / DOM code in this file, so it is unit-testable
 * with plain `node`. The server (server.js) is the only place that calls
 * these functions, and it never sends hidden roles to a client — see
 * getPublicState() below.
 *
 * KEY RULE — wrong-guess swap:
 *   The guessing ROLE follows the slip, not the person. If the King
 *   guesses the wrong player as Queen, the two players swap slips.
 *   The wrongly-guessed player now HOLDS the King slip, so *they*
 *   become the active guesser and try again for the Queen. The original
 *   guesser now holds the other player's (still hidden) role and is
 *   un-revealed again. This is the traditional paper-slip behaviour
 *   and is what makes a wrong guess costly: you lose the crown.
 */

// ---------------------------------------------------------------- roles
const ROLE_DEFS = [
  { id: 'king',      en: 'King',      hi: 'Raja',       emoji: '👑' },
  { id: 'queen',     en: 'Queen',     hi: 'Rani',       emoji: '👸' },
  { id: 'minister',  en: 'Minister',  hi: 'Mantri',     emoji: '🎩' },
  { id: 'commander', en: 'Commander', hi: 'Senapati',   emoji: '⚔️' },
  { id: 'judge',     en: 'Judge',     hi: 'Nyayadhish', emoji: '⚖️' },
  { id: 'doctor',    en: 'Doctor',    hi: 'Vaidya',     emoji: '🩺' },
  { id: 'merchant',  en: 'Merchant',  hi: 'Vyapari',    emoji: '💰' },
  { id: 'farmer',    en: 'Farmer',    hi: 'Kisan',      emoji: '🌾' },
  { id: 'police',    en: 'Police',    hi: 'Sipahi',     emoji: '👮' },
  { id: 'thief',     en: 'Thief',     hi: 'Chor',       emoji: '🥷' },
];

// The 8 "middle" roles in rank order, before Police / Thief.
const MIDDLE_ROLES = ROLE_DEFS.slice(0, 8);

function roleDef(id) { return ROLE_DEFS.find((r) => r.id === id); }

/**
 * Roles for N players (5..10). Police and Thief are ALWAYS the last two.
 * With 2 thieves (8+ players only) Police + 2x Thief are the last three,
 * so one middle role is dropped to keep the total at N.
 *
 *   5p: King, Queen, Minister, Police, Thief
 *   6p: King, Queen, Minister, Commander, Police, Thief
 *   7p: King, Queen, Minister, Commander, Judge, Police, Thief
 *   8p: King, Queen, Minister, Commander, Judge, Doctor, Police, Thief
 *   8p + 2 thieves: King, Queen, Minister, Commander, Judge, Police, Thief, Thief
 *   9p: King..Merchant, Police, Thief
 *  10p: King..Farmer, Police, Thief
 *  10p + 2 thieves: King..Merchant, Police, Thief, Thief
 */
function getRolesForPlayerCount(n, opts = {}) {
  if (!Number.isInteger(n) || n < 5 || n > 10) {
    throw new Error('Player count must be an integer between 5 and 10');
  }
  const twoThieves = Boolean(opts.twoThieves);
  if (twoThieves && n < 8) {
    throw new Error('Two Thieves is only allowed with 8+ players');
  }
  const tailCount = twoThieves ? 3 : 2; // Police + Thief(s)
  const middleCount = n - tailCount;
  const roles = MIDDLE_ROLES.slice(0, middleCount).map((r) => r.id);
  roles.push('police');
  roles.push('thief');
  if (twoThieves) roles.push('thief');
  return roles;
}

/** Default points: rank 1 = 100, -10 per rank, Thief always 0. */
function defaultPoints(roles) {
  const points = {};
  roles.forEach((roleId, i) => {
    points[roleId] = roleId === 'thief' ? 0 : Math.max(0, 100 - i * 10);
  });
  return points;
}

function getPointsForRole(settings, roleId) {
  if (settings.points && typeof settings.points[roleId] === 'number') {
    return settings.points[roleId];
  }
  return roleId === 'thief' ? 0 : 0;
}

// ---------------------------------------------------------------- helpers
function shuffle(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function validateSettings(input = {}) {
  const playerCount = input.playerCount ?? 5;
  if (!Number.isInteger(playerCount) || playerCount < 5 || playerCount > 10) {
    throw new Error('playerCount must be 5..10');
  }
  const totalRounds = input.totalRounds ?? 10;
  if (![5, 10, 15].includes(totalRounds)) {
    throw new Error('totalRounds must be 5, 10 or 15');
  }
  const twoThieves = Boolean(input.twoThieves);
  if (twoThieves && playerCount < 8) {
    throw new Error('Two Thieves needs 8+ players');
  }
  const wrongGuessPenalty = Number(input.wrongGuessPenalty ?? 0);
  if (!Number.isFinite(wrongGuessPenalty) || wrongGuessPenalty < 0) {
    throw new Error('wrongGuessPenalty must be >= 0');
  }
  const roles = getRolesForPlayerCount(playerCount, { twoThieves });
  const points = { ...defaultPoints(roles), ...(input.points || {}) };
  // Thief is always 0, even if a custom table tries otherwise.
  points.thief = 0;
  return {
    playerCount, totalRounds, twoThieves, wrongGuessPenalty,
    points, language: input.language || 'en',
    roleNames: input.roleNames || {},
  };
}

function createGame(settingsInput = {}) {
  const settings = validateSettings(settingsInput);
  return {
    id: settingsInput.id || null,
    settings,
    players: [], // {id,name,avatar,isBot,isHost,connected,score,wrongGuesses}
    phase: 'lobby', // lobby -> draw -> guessing -> round-end -> game-end
    round: 0,
    assignments: {}, // playerId -> roleId (current, after swaps)
    revealed: [], // playerIds whose role is public
    currentGuesserId: null,
    currentTargetRoleId: null,
    thievesFound: 0,
    thievesTotal: settings.twoThieves ? 2 : 1,
    lastGuess: null,
    log: [],
    roundScores: [], // [{round, scores:{playerId:points}, roles:{playerId:roleId}}]
    winners: [],
    tieBreaker: false,
    tieBreakerCount: 0,
  };
}

function addPlayer(game, player) {
  if (game.phase !== 'lobby') return { ok: false, error: 'Game already started' };
  if (game.players.length >= game.settings.playerCount) {
    return { ok: false, error: 'Room is full' };
  }
  if (game.players.some((p) => p.id === player.id)) {
    return { ok: false, error: 'Player already in room' };
  }
  const p = {
    id: player.id,
    name: (player.name || 'Player').slice(0, 20),
    avatar: player.avatar || '🙂',
    isBot: Boolean(player.isBot),
    isHost: game.players.length === 0,
    connected: true,
    score: 0,
    wrongGuesses: 0,
  };
  game.players.push(p);
  return { ok: true, player: p };
}

function removePlayer(game, playerId) {
  const idx = game.players.findIndex((p) => p.id === playerId);
  if (idx === -1) return { ok: false, error: 'Player not found' };
  const wasHost = game.players[idx].isHost;
  game.players.splice(idx, 1);
  if (wasHost && game.players.length > 0) {
    // Host transfer: earliest remaining player becomes host.
    game.players[0].isHost = true;
  }
  return { ok: true, newHostId: game.players[0]?.id || null };
}

function fillWithBots(game, botNames) {
  const names = botNames || ['Chintu', 'Bunty', 'Pinky', 'Raju', 'Meena', 'Golu'];
  let i = 0;
  while (game.players.length < game.settings.playerCount) {
    const name = names[i % names.length] + (i >= names.length ? ` ${Math.floor(i / names.length) + 1}` : '');
    addPlayer(game, { id: `bot-${Date.now()}-${i}`, name, avatar: ['🤖', '🦊', '🐼', '🦁', '🐸', '🦄'][i % 6], isBot: true });
    i++;
  }
  return game.players;
}

// ---------------------------------------------------------------- rounds
function startRound(game, rng = Math.random) {
  if (game.players.length !== game.settings.playerCount) {
    return { ok: false, error: `Need ${game.settings.playerCount} players to start (have ${game.players.length})` };
  }
  const roles = getRolesForPlayerCount(game.settings.playerCount, {
    twoThieves: game.settings.twoThieves,
  });
  const shuffled = shuffle(roles, rng);
  game.assignments = {};
  game.players.forEach((p, i) => { game.assignments[p.id] = shuffled[i]; });
  const kingId = game.players.find((p) => game.assignments[p.id] === 'king').id;
  game.revealed = [kingId];
  game.currentGuesserId = kingId;
  game.currentTargetRoleId = 'queen';
  game.thievesFound = 0;
  game.lastGuess = null;
  game.log = [{ type: 'round-start', round: game.round + 1, kingId }];
  game.players.forEach((p) => { p.wrongGuesses = 0; });
  game.round += 1;
  game.phase = 'guessing';
  return { ok: true, kingId };
}

function eligibleTargets(game) {
  return game.players
    .filter((p) => p.id !== game.currentGuesserId && !game.revealed.includes(p.id))
    .map((p) => p.id);
}

/** Next role to find after `roleId` in this game's role list. */
function nextTargetAfter(game, roleId) {
  const roles = getRolesForPlayerCount(game.settings.playerCount, {
    twoThieves: game.settings.twoThieves,
  });
  if (roleId === 'thief') {
    // With 2 thieves, after the first thief the target is the 2nd thief.
    return game.thievesFound < game.thievesTotal ? 'thief' : null;
  }
  const idx = roles.indexOf(roleId);
  return idx >= 0 && idx + 1 < roles.length ? roles[idx + 1] : null;
}

function endRound(game) {
  const scores = {};
  const rolesSnapshot = { ...game.assignments };
  game.players.forEach((p) => {
    const roleId = game.assignments[p.id];
    const base = game.settings.points[roleId] ?? 0;
    const penalty = game.settings.wrongGuessPenalty * (p.wrongGuesses || 0);
    const gained = Math.max(0, base - penalty);
    scores[p.id] = gained;
    p.score += gained;
  });
  game.roundScores.push({ round: game.round, scores, roles: rolesSnapshot, tieBreaker: game.tieBreaker });
  game.phase = 'round-end';
  game.log.push({ type: 'round-end', round: game.round, scores });
  return { ok: true, scores, roles: rolesSnapshot };
}

function leaders(game) {
  const max = Math.max(...game.players.map((p) => p.score), 0);
  return game.players.filter((p) => p.score === max);
}

function advanceAfterRound(game) {
  // Returns 'next-round' | 'tie-breaker' | 'game-end'
  if (game.phase !== 'round-end') return { ok: false, error: 'Not at round end' };
  const isFinalScheduledRound = game.round >= game.settings.totalRounds;
  if (!isFinalScheduledRound) return { ok: true, next: 'next-round' };
  const top = leaders(game);
  if (top.length > 1 && game.tieBreakerCount < 3) {
    game.tieBreaker = true;
    game.tieBreakerCount += 1;
    game.log.push({ type: 'tie-breaker', tied: top.map((p) => p.id) });
    return { ok: true, next: 'tie-breaker', tied: top.map((p) => p.id) };
  }
  game.winners = top.map((p) => p.id);
  game.tieBreaker = false;
  game.phase = 'game-end';
  game.log.push({ type: 'game-end', winners: game.winners });
  return { ok: true, next: 'game-end', winners: game.winners };
}

// ---------------------------------------------------------------- guessing
function makeGuess(game, guesserId, targetId) {
  // --- validation: invalid guesses, out-of-turn, race conditions ---
  if (game.phase !== 'guessing') {
    return { ok: false, error: 'Not in guessing phase' };
  }
  if (guesserId !== game.currentGuesserId) {
    return { ok: false, error: 'Not your turn to guess' };
  }
  if (guesserId === targetId) {
    return { ok: false, error: 'You cannot guess yourself' };
  }
  const target = game.players.find((p) => p.id === targetId);
  if (!target) return { ok: false, error: 'Unknown player' };
  if (game.revealed.includes(targetId)) {
    return { ok: false, error: 'That player is already revealed' };
  }
  if (!eligibleTargets(game).includes(targetId)) {
    return { ok: false, error: 'That player cannot be guessed now' };
  }

  const guesser = game.players.find((p) => p.id === guesserId);
  const targetRole = game.assignments[targetId];
  const wanted = game.currentTargetRoleId;
  const correct = targetRole === wanted;

  if (correct) {
    game.revealed.push(targetId);
    game.lastGuess = { guesserId, targetId, correct: true, roleId: targetRole, at: Date.now() };
    game.log.push({ ...game.lastGuess, type: 'guess-correct' });
    if (targetRole === 'thief') {
      game.thievesFound += 1;
      if (game.thievesFound >= game.thievesTotal) {
        const ended = endRound(game);
        return { ok: true, correct: true, roundEnded: true, revealedRole: targetRole, scores: ended.scores };
      }
      // First thief found (2-thief game): the thief now hunts the 2nd thief.
      game.currentGuesserId = targetId;
      game.currentTargetRoleId = 'thief';
      return { ok: true, correct: true, roundEnded: false, revealedRole: targetRole, nextGuesserId: targetId, nextTargetRoleId: 'thief', thievesFound: game.thievesFound };
    }
    game.currentGuesserId = targetId;
    game.currentTargetRoleId = nextTargetAfter(game, targetRole);
    return { ok: true, correct: true, roundEnded: false, revealedRole: targetRole, nextGuesserId: targetId, nextTargetRoleId: game.currentTargetRoleId };
  }

  // --- WRONG GUESS: swap slips, guesser role moves to the target ---
  guesser.wrongGuesses = (guesser.wrongGuesses || 0) + 1;
  const guesserRole = game.assignments[guesserId];
  game.assignments[guesserId] = targetRole;
  game.assignments[targetId] = guesserRole;
  // Revealed follows the guessing role: target is now revealed as guesserRole,
  // original guesser is hidden again with their new role.
  game.revealed = game.revealed.filter((id) => id !== guesserId);
  if (!game.revealed.includes(targetId)) game.revealed.push(targetId);
  game.currentGuesserId = targetId; // new holder of the guessing role tries again
  // currentTargetRoleId is unchanged — still hunting the same next role.
  game.lastGuess = {
    guesserId, targetId, correct: false,
    guesserRole, targetRole, swapped: true, at: Date.now(),
  };
  game.log.push({ ...game.lastGuess, type: 'guess-wrong' });
  return {
    ok: true, correct: false, roundEnded: false,
    swapped: true, guesserRole, targetRole,
    nextGuesserId: targetId, nextTargetRoleId: game.currentTargetRoleId,
  };
}

/** Bot pick: random eligible target, avoiding an immediate repeat if possible. */
function chooseBotGuess(game, rng = Math.random) {
  const eligible = eligibleTargets(game);
  if (!eligible.length) return null;
  const last = game.lastGuess;
  const filtered = last && !last.correct && eligible.length > 1
    ? eligible.filter((id) => id !== last.targetId) : eligible;
  const pool = filtered.length ? filtered : eligible;
  return pool[Math.floor(rng() * pool.length)];
}

// ------------------------------------------------------- public (safe) view
/**
 * Server-authoritative view for ONE player. Hidden roles are NEVER included:
 * a viewer sees only their own role, plus roles of revealed players.
 * Inspecting network traffic / client code cannot leak hidden roles.
 */
function getPublicState(game, viewerId) {
  const viewerRole = game.assignments[viewerId] || null;
  const rolesPublic = {};
  game.players.forEach((p) => {
    if (game.revealed.includes(p.id)) rolesPublic[p.id] = game.assignments[p.id];
    else if (p.id === viewerId) rolesPublic[p.id] = viewerRole;
    else rolesPublic[p.id] = null; // hidden
  });
  return {
    id: game.id,
    settings: game.settings,
    phase: game.phase,
    round: game.round,
    players: game.players.map((p) => ({
      id: p.id, name: p.name, avatar: p.avatar, isBot: p.isBot,
      isHost: p.isHost, connected: p.connected, score: p.score,
      wrongGuesses: p.wrongGuesses,
    })),
    myRole: viewerRole,
    roles: rolesPublic,
    revealed: [...game.revealed],
    currentGuesserId: game.currentGuesserId,
    currentTargetRoleId: game.currentTargetRoleId,
    thievesFound: game.thievesFound,
    thievesTotal: game.thievesTotal,
    lastGuess: game.lastGuess,
    roundScores: game.roundScores,
    winners: game.winners,
    tieBreaker: game.tieBreaker,
    // Full log is safe: it only ever names revealed roles / guesses.
    log: game.log.slice(-30),
  };
}

function getRoundSummary(game) {
  const last = game.roundScores[game.roundScores.length - 1];
  if (!last) return null;
  return {
    round: last.round,
    tieBreaker: last.tieBreaker,
    rows: game.players.map((p) => ({
      id: p.id, name: p.name, avatar: p.avatar,
      role: last.roles[p.id], points: last.scores[p.id], total: p.score,
    })).sort((a, b) => b.total - a.total),
  };
}

module.exports = {
  ROLE_DEFS, MIDDLE_ROLES, roleDef,
  getRolesForPlayerCount, defaultPoints, getPointsForRole,
  validateSettings, createGame, addPlayer, removePlayer, fillWithBots,
  startRound, eligibleTargets, nextTargetAfter, makeGuess, chooseBotGuess,
  endRound, advanceAfterRound, leaders,
  getPublicState, getRoundSummary, shuffle,
};
