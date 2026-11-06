# 👑 Raja Rani Mantri Chor Sipahi

The classic Indian childhood paper-slip game — now a responsive web app for
**5–10 players**, with bots, realtime multiplayer, and a warm, nostalgic
notebook-paper look (turmeric yellow, maroon, cream, handwriting fonts).

> One phone per player, one folded slip each, and a lot of shouting
> “Arre, Chor kaun hai?!” — just like lunch break, but it works on phones.

## How to play

1. **Draw a slip.** Every round the slips are shuffled. You see **only your
   own** role. Only the **King (Raja)** is revealed at the start.
2. **Follow the chain.** King finds Queen → Queen finds Minister → … →
   Police finds Thief. Tap a player to guess they hold the next role.
3. **Wrong guess?** You and the player you guessed **swap slips**.
   The new holder of your role tries again — so a wrong guess can cost you
   the crown. Wrong guesses are shown to everyone.
4. **Round ends** when the Police correctly finds the Thief (both Thieves,
   if Two Thieves is on). Points are for your **final** role after all swaps.
   The Thief always scores **0**.
5. **Game:** 10 rounds by default (5 / 10 / 15). Highest total wins.
   A tie at the end means **one tie-breaker round**.

## Roles — how the list scales (5–10 players)

Police and Thief are **always the last two roles**. Only the first N roles
are used for N players.

| Players | Roles in rank order | Points |
|---|---|---|
| 5 | King, Queen, Minister, **Police, Thief** | 100, 90, 80, 70, 0 |
| 6 | King, Queen, Minister, Commander, **Police, Thief** | 100, 90, 80, 70, 60, 0 |
| 7 | King, Queen, Minister, Commander, Judge, **Police, Thief** | 100, 90, 80, 70, 60, 50, 0 |
| 8 | King, Queen, Minister, Commander, Judge, Doctor, **Police, Thief** | 100, 90, 80, 70, 60, 50, 40, 0 |
| 9 | King, Queen, Minister, Commander, Judge, Doctor, Merchant, **Police, Thief** | 100, 90, 80, 70, 60, 50, 40, 30, 0 |
| 10 | King, Queen, Minister, Commander, Judge, Doctor, Merchant, Farmer, **Police, Thief** | 100, 90, 80, 70, 60, 50, 40, 30, 20, 0 |

Role names (English / Hindi): King / Raja 👑, Queen / Rani 👸,
Minister / Mantri 🎩, Commander / Senapati ⚔️, Judge / Nyayadhish ⚖️,
Doctor / Vaidya 🩺, Merchant / Vyapari 💰, Farmer / Kisan 🌾,
Police / Sipahi 👮, Thief / Chor 🥷.

Points are **100 for rank 1, −10 per rank, Thief always 0** — and the point
table is editable per room (Lobby → Points table). Role names are editable
too, so groups can use their own family variants.

### House rules (toggles in the lobby)

- **Two Thieves (8+ players only):** both Thieves score 0 and the Police
  must find both. One middle role is dropped so the total stays N
  (e.g. 8 players: King, Queen, Minister, Commander, Judge, Police,
  Thief, Thief).
- **Wrong-guess penalty:** −5 or −10 points per wrong guess in that round
  (round points never go below 0).

## Project structure

```
raja-rani-mantri-chor-sipahi/
├── README.md                  # this file
├── LICENSE                    # MIT
├── package.json               # root scripts: npm test / npm run server
├── .gitignore
├── render.yaml              # Render free-tier web service (build/start commands)
├── server/
│   ├── package.json           # express + socket.io (socket.io-client is a dev dep, for the online test)
│   ├── server.js              # Express + Socket.IO, rooms, bots, reconnect, host transfer
│   ├── game.js                # PURE game engine (no I/O) — unit-testable
│   ├── test-game.js           # node test-game.js — full-round simulation
│   └── test-online.js         # node test-online.js — 2-client create/join/guess/rejoin test
├── client/
│   ├── index.html             # lobby (Create / Join / Solo) / game / round / final screens
│   ├── styles.css             # notebook paper, turmeric/maroon/cream, mobile-first
│   └── app.js                 # solo engine + Socket.IO online client (same UI)
└── docs/
    └── STATE_DIAGRAM.md       # state machine (Mermaid) + events + edge cases
```

## Run locally

**Solo / practice (no install needed) — fastest:**

```bash
# Option A: just open the file
open client/index.html          # macOS
# or:  python3 -m http.server --directory client 8080
# then open http://localhost:8080
```

Pick a name + avatar, set players (5–10) and rounds, tap **Add a bot**
(or leave “Fill empty seats with bots” on), and **Start game**.
Tap your slip to unfold it. When it is your turn, tap a face-down player
to guess. Bots play automatically with a short delay.

**Realtime multiplayer (friends on different phones):**

```bash
cd server
npm install
npm start                     # http://localhost:3001  (also serves client/)
# In another terminal, from the repo root, to run the tests:
npm test
```

1. The host opens `http://localhost:3001`, creates a room and shares the
   5-letter room code / link.
2. Friends join with the code, a name and an avatar.
3. The host picks the player count, fills empty seats with bots if needed,
   and starts. The server is the source of truth: it never sends hidden
   roles to any client (`game.getPublicState()` — see `server/game.js`),
   so inspecting network traffic or the client cannot reveal other slips.

## Play online with friends (Create / Join)

The client (`client/app.js`) is a full Socket.IO client — no separate
frontend build is needed. Open the lobby and pick one of the three modes:

- **🏠 Create Room** — enter your name and avatar, set players (5–10),
  rounds, house rules and the points table, then tap **Create room**.
  The server gives you a real 5-letter room code (e.g. `FMSJS`) and a
  shareable invite link (`?room=FMSJS`). You are the host: add bots to
  fill empty seats, then tap **Start game**.
- **🔑 Join Room** — enter your name and avatar and the 5-letter code
  from your friend, then tap **Join room**. A wrong code, a full room,
  or a game that already started shows a clear error. Opening an invite
  link (`?room=FMSJS`) pre-fills Join mode with that code automatically.
- **🤖 Solo with bots** — the old practice mode, unchanged: everything
  runs locally in your browser, no server needed.

While you play online, everything comes from the server: your slip shows
only your own role, the guessing chain and leaderboard come from server
`state` events, guesses go out as `make_guess`, and chat goes out as
`chat`. If you reload mid-game, the client restores your seat with
`rejoin_room` (room code + player ID are kept in `sessionStorage`).
If the server is unreachable or the Socket.IO CDN fails to load, the
online buttons say so clearly and Solo mode keeps working.

Events used (exact names from `server/server.js`, see
`docs/STATE_DIAGRAM.md`): `create_room`, `join_room`, `rejoin_room`,
`add_bots`, `update_settings`, `start_game`, `make_guess`, `next_round`,
`play_again`, `chat` — and server emits `state`, `guess_result`,
`round_end`, `game_end`, `draw_slip`, `chat`. A React + Vite frontend
can be dropped in later without changing `server/game.js` — the engine
is transport-independent.

**Test it locally:** `cd server && npm install && npm run test:online`
spawns the server and drives two real clients through create → join →
bots → start → guesses → rejoin.

## Deployment

**Render (recommended, free tier):**

1. Push this repo to GitHub.
2. Render → New → Web Service → pick the repo.
3. Build command: `npm --prefix server install` · Start command:
   `node server/server.js` · Environment: `PORT=10000`
   (Render sets `PORT` itself; the server reads it).
4. The service serves both the API and `client/` at the same URL —
   share that link, no separate frontend deploy needed.

**Railway:** same idea — New Project → Deploy from GitHub, set the start
command to `node server/server.js`. Railway injects `PORT` automatically.

**Static solo version only:** deploy `client/` to Netlify / Vercel /
GitHub Pages as a static site. Solo-with-bots works; cross-device
multiplayer needs the Node server above.

## Design

- Notebook-paper background, hand-folded paper slips, chalk/pencil-style
  handwriting fonts, warm turmeric yellow / maroon / cream.
- Paper folding, shuffling and unfolding animations; swap / correct /
  wrong-guess animations on the table.
- Sound effects are generated with Web Audio (paper rustle, correct chime,
  wrong buzz, win fanfare) — no audio files — with a mute toggle.
- Mobile-first: big tap targets, the table reflows for 5–10 players.
- Language toggle: English ↔ Hindi role names (Raja, Rani, Mantri, …).
- In-game chat + emoji reactions, How-to-Play modal for the current
  player count, confetti on the final screen.

## Edge cases handled

See `docs/STATE_DIAGRAM.md` for the full list: invalid guesses (self,
already revealed, out of turn), double-tap / race-condition guard on the
server, wrong-guess swaps, disconnect + reconnect (seat and role restored,
bot takeover after 45 s), host leaving (host transfers to the next
connected player), player-count changes in the lobby, and ties
(tie-breaker round, max 3, then shared win).

## License

MIT — see `LICENSE`.
