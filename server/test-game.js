/**
 * Engine test — run:  node test-game.js   (from server/ or repo root via npm test)
 * Simulates a full 5-player round, including a WRONG guess + slip swap,
 * then correct guesses to the Thief, and checks scoring.
 * Uses a seeded RNG so the test is deterministic.
 */
const assert = require('assert');
const game = require('./game');

function seededRng(seed = 42) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('Raja Rani Mantri Chor Sipahi — engine tests\n');

// --- role scaling -------------------------------------------------------
check('5p roles = King,Queen,Minister,Police,Thief', () => {
  assert.deepStrictEqual(game.getRolesForPlayerCount(5), ['king', 'queen', 'minister', 'police', 'thief']);
});
check('7p roles = King,Queen,Minister,Commander,Judge,Police,Thief', () => {
  assert.deepStrictEqual(game.getRolesForPlayerCount(7), ['king', 'queen', 'minister', 'commander', 'judge', 'police', 'thief']);
});
check('10p roles include Farmer before Police/Thief', () => {
  assert.deepStrictEqual(game.getRolesForPlayerCount(10),
    ['king', 'queen', 'minister', 'commander', 'judge', 'doctor', 'merchant', 'farmer', 'police', 'thief']);
});
check('8p + 2 thieves drops one middle role, keeps 8 roles', () => {
  const r = game.getRolesForPlayerCount(8, { twoThieves: true });
  assert.strictEqual(r.length, 8);
  assert.deepStrictEqual(r.slice(-3), ['police', 'thief', 'thief']);
});
check('points: 5p = 100/90/80/70/0, thief always 0', () => {
  assert.deepStrictEqual(game.defaultPoints(game.getRolesForPlayerCount(5)),
    { king: 100, queen: 90, minister: 80, police: 70, thief: 0 });
});
check('invalid counts throw', () => {
  assert.throws(() => game.getRolesForPlayerCount(4));
  assert.throws(() => game.getRolesForPlayerCount(11));
  assert.throws(() => game.getRolesForPlayerCount(5, { twoThieves: true }));
});

// --- full 5-player round with a wrong guess ----------------------------
console.log('\nSimulating a full 5-player round (seeded):');
const g = game.createGame({ playerCount: 5, totalRounds: 5, wrongGuessPenalty: 5 });
['Asha', 'Ravi', 'Meena', 'Arjun', 'Kiran'].forEach((name, i) =>
  game.addPlayer(g, { id: `p${i + 1}`, name, avatar: '🙂' }));
const started = game.startRound(g, seededRng(7));
assert.ok(started.ok, started.error);
console.log('  Assignments (hidden in real play):', JSON.stringify(g.assignments));
console.log('  King is:', g.players.find((p) => p.id === g.currentGuesserId).name,
  '| target:', g.currentTargetRoleId);

check('only King revealed at start', () => {
  assert.strictEqual(g.revealed.length, 1);
  assert.strictEqual(g.assignments[g.revealed[0]], 'king');
});
check('invalid guesses are rejected (self / revealed / out of turn)', () => {
  assert.strictEqual(game.makeGuess(g, g.currentGuesserId, g.currentGuesserId).ok, false);
  assert.strictEqual(game.makeGuess(g, g.currentGuesserId, g.revealed[0]).ok, false);
  const other = g.players.find((p) => p.id !== g.currentGuesserId).id;
  assert.strictEqual(game.makeGuess(g, other, g.players[0].id).ok, false);
});

// Force a WRONG guess: pick an eligible target who is NOT the Queen.
const kingId = g.currentGuesserId;
const wrongTarget = game.eligibleTargets(g).find((id) => g.assignments[id] !== 'queen');
const roleBeforeKing = g.assignments[kingId];
const roleBeforeTarget = g.assignments[wrongTarget];
const wrong = game.makeGuess(g, kingId, wrongTarget);
check('wrong guess swaps slips and new King holder tries again', () => {
  assert.strictEqual(wrong.ok, true);
  assert.strictEqual(wrong.correct, false);
  assert.strictEqual(wrong.swapped, true);
  assert.strictEqual(g.assignments[kingId], roleBeforeTarget);
  assert.strictEqual(g.assignments[wrongTarget], roleBeforeKing);
  assert.strictEqual(g.currentGuesserId, wrongTarget);
  assert.strictEqual(g.currentTargetRoleId, 'queen');
  assert.ok(g.revealed.includes(wrongTarget));
  assert.ok(!g.revealed.includes(kingId));
  console.log(`  Wrong guess: ${kingId} (${roleBeforeKing}) <-> ${wrongTarget} (${roleBeforeTarget}) swapped; new guesser ${wrongTarget}`);
});

// Now play correctly to the end: the current guesser always picks the
// player who actually holds the wanted role (a perfect-information oracle,
// only used here to drive the test to completion).
let guard = 0;
while (g.phase === 'guessing' && guard++ < 50) {
  const wanted = g.currentTargetRoleId;
  const holder = g.players.find((p) => g.assignments[p.id] === wanted && !g.revealed.includes(p.id));
  assert.ok(holder, `no holder for ${wanted}`);
  const res = game.makeGuess(g, g.currentGuesserId, holder.id);
  assert.ok(res.ok, res.error);
  assert.strictEqual(res.correct, true);
  console.log(`  Correct: ${holder.name} revealed as ${wanted}${res.roundEnded ? ' — ROUND END' : ''}`);
}
check('round ends when Police finds Thief', () => {
  assert.strictEqual(g.phase, 'round-end');
  assert.strictEqual(g.roundScores.length, 1);
});
check('scoring: thief 0, wrong guesser lost 5 points', () => {
  const summary = game.getRoundSummary(g);
  const thiefRow = summary.rows.find((r) => r.role === 'thief');
  assert.strictEqual(thiefRow.points, 0);
  const wrongGuesserRow = summary.rows.find((r) => r.id === kingId);
  // kingId now holds roleBeforeTarget; its base minus 5 penalty.
  const base = g.settings.points[wrongGuesserRow.role];
  assert.strictEqual(wrongGuesserRow.points, Math.max(0, base - 5));
  console.log('  Round scores:', summary.rows.map((r) => `${r.name}=${r.role}:${r.points} (total ${r.total})`).join(', '));
});
check('public state never leaks hidden roles', () => {
  const view = game.getPublicState(g, 'p1');
  // In round-end the summary reveals roles, but during guessing hidden
  // roles must be null. Re-run a fresh guessing game to check that:
  const g2 = game.createGame({ playerCount: 5 });
  ['A', 'B', 'C', 'D', 'E'].forEach((n, i) => game.addPlayer(g2, { id: `q${i}`, name: n }));
  game.startRound(g2, seededRng(3));
  const v2 = game.getPublicState(g2, 'q0');
  const hidden = g2.players.filter((p) => p.id !== 'q0' && !g2.revealed.includes(p.id));
  assert.ok(hidden.length > 0);
  hidden.forEach((p) => assert.strictEqual(v2.roles[p.id], null));
  assert.strictEqual(v2.myRole, g2.assignments.q0);
});

// --- tie-breaker ---------------------------------------------------------
check('tie at final round triggers a tie-breaker', () => {
  const gt = game.createGame({ playerCount: 5, totalRounds: 5 });
  ['A', 'B', 'C', 'D', 'E'].forEach((n, i) => game.addPlayer(gt, { id: `t${i}`, name: n }));
  gt.round = 5; gt.phase = 'round-end';
  gt.players[0].score = 100; gt.players[1].score = 100;
  const adv = game.advanceAfterRound(gt);
  assert.strictEqual(adv.next, 'tie-breaker');
});

console.log(`\n✅ All ${passed} checks passed.`);
