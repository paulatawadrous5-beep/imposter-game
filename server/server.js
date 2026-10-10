/**
 * Imposter game server — Node.js + Socket.IO
 *
 * Real-time 4-player social deduction:
 *  - private rooms with 4-char codes
 *  - one imposter, secret Egyptian-Arabic word for the other three
 *  - turn-based text clues, secret voting, final word-guess
 *  - disconnect / reconnect with seat reclaim (token based)
 *  - roles & words are NEVER sent to the wrong client
 */
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const WORDS = require("./words");

const PORT = process.env.PORT || 3000;
const FAST = process.env.FAST_TIMERS === "1"; // tiny timers for automated tests

const T = {
  clueTurn: FAST ? 4000 : 60000,
  vote: FAST ? 5000 : 60000,
  guess: FAST ? 5000 : 90000,
  round: FAST ? 20000 : 5 * 60 * 1000,
  rejoin: FAST ? 8000 : 120000,
  roomEmptyTTL: 10 * 60 * 1000,
};

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MAX_PLAYERS = 4;

const rooms = new Map(); // code -> room
const socketToPlayer = new Map(); // socket.id -> { code, playerId }

/* ---------------- helpers ---------------- */

function makeCode() {
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

function makeId() { return crypto.randomBytes(8).toString("hex"); }
function makeToken() { return crypto.randomBytes(16).toString("hex"); }

function cleanText(s, max) {
  if (typeof s !== "string") return "";
  return s.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, max);
}

function roomPlayers(room) {
  return room.order.map((pid) => room.players.get(pid)).filter(Boolean);
}

function publicPlayer(p, room) {
  return { id: p.id, name: p.name, ready: p.ready, connected: p.connected, host: room.hostId === p.id };
}

function emitLobby(room) {
  io.to(room.code).emit("lobby-update", {
    code: room.code,
    phase: "lobby",
    settings: room.settings,
    players: roomPlayers(room).map((p) => publicPlayer(p, room)),
  });
}

function getRoom(code) {
  if (!code) return null;
  return rooms.get(String(code).toUpperCase()) || null;
}

function findPlayerBySocket(socketId) {
  const ref = socketToPlayer.get(socketId);
  if (!ref) return null;
  const room = rooms.get(ref.code);
  if (!room) return null;
  const player = room.players.get(ref.playerId);
  if (!player) return null;
  return { room, player };
}

/* ---------------- timers (pausable) ---------------- */

function setPhaseTimer(game, ms, fn) {
  clearPhaseTimer(game);
  game.timerKind = fn.name || "timer";
  game.deadline = Date.now() + ms;
  game.timerMs = ms;
  game.timer = setTimeout(() => {
    game.timer = null;
    game.deadline = 0;
    fn();
  }, ms);
}

function clearPhaseTimer(game) {
  if (game && game.timer) { clearTimeout(game.timer); game.timer = null; }
  if (game) game.deadline = 0;
}

function pauseGame(room) {
  const g = room.game;
  if (!g || g.paused) return;
  if (g.timer) {
    g.pausedRemaining = Math.max(0, g.deadline - Date.now());
    g.pausedKind = g.timerKind;
    clearTimeout(g.timer);
    g.timer = null;
  } else {
    g.pausedRemaining = 0;
  }
  if (g.roundTimer) {
    g.roundRemaining = Math.max(0, (g.roundDeadline || 0) - Date.now());
    clearTimeout(g.roundTimer);
    g.roundTimer = null;
  }
  g.paused = true;
}

function resumeGame(room) {
  const g = room.game;
  if (!g || !g.paused) return;
  g.paused = false;
  const kind = g.pausedKind;
  const ms = g.pausedRemaining || 0;
  g.pausedRemaining = 0; g.pausedKind = null;
  if (kind === "onClueTimeout") setPhaseTimer(g, ms, () => onClueTimeout(room));
  else if (kind === "onVoteTimeout") setPhaseTimer(g, ms, () => onVoteTimeout(room));
  else if (kind === "onGuessTimeout") setPhaseTimer(g, ms, () => onGuessTimeout(room));
  if (g.roundRemaining) {
    g.roundDeadline = Date.now() + g.roundRemaining;
    g.roundTimer = setTimeout(() => onRoundTimeout(room), g.roundRemaining);
    g.roundRemaining = 0;
  }
  // re-broadcast current state so everyone (esp. the returner) is in sync
  syncGameState(room);
}

/* ---------------- game flow ---------------- */

function startGame(room) {
  const players = roomPlayers(room).filter((p) => p.connected);
  if (players.length !== MAX_PLAYERS) return;
  const word = WORDS[Math.floor(Math.random() * WORDS.length)];
  const imposter = players[Math.floor(Math.random() * players.length)];
  // random turn order
  const turnOrder = players.map((p) => p.id);
  for (let i = turnOrder.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [turnOrder[i], turnOrder[j]] = [turnOrder[j], turnOrder[i]];
  }
  room.phase = "clue";
  room.game = {
    word,
    imposterId: imposter.id,
    turnOrder,
    turnIdx: 0,
    clues: [],
    votes: new Map(),
    subPhase: "clue",
    timer: null, deadline: 0, timerMs: 0, timerKind: null,
    paused: false, pausedRemaining: 0, pausedKind: null,
    result: null,
  };
  players.forEach((p) => { p.ready = false; });
  // personalized start: ONLY non-imposters receive the word
  for (const p of players) {
    const isImp = p.id === imposter.id;
    io.to(p.socketId).emit("game-started", {
      isImposter: isImp,
      word: isImp ? null : word,
      turnOrder: turnOrder.map((id) => ({ id, name: room.players.get(id).name })),
      turnIndex: 0,
      currentTurnId: turnOrder[0],
      roundSeconds: room.settings.roundMinutes > 0 ? room.settings.roundMinutes * 60 : 0,
    });
  }
  beginClueTurn(room);
  if (room.settings.roundMinutes > 0) {
    room.game.roundTimer = setTimeout(() => onRoundTimeout(room), T.round);
    room.game.roundDeadline = Date.now() + T.round;
  }
  emitLobby(room);
}

function beginClueTurn(room) {
  const g = room.game;
  if (!g || g.subPhase !== "clue") return;
  const currentId = g.turnOrder[g.turnIdx];
  const payload = {
    turnIndex: g.turnIdx,
    totalTurns: g.turnOrder.length,
    currentTurnId: currentId,
    currentTurnName: room.players.get(currentId).name,
    clues: g.clues.map((c) => ({ name: room.players.get(c.playerId).name, text: c.text })),
    deadline: Date.now() + T.clueTurn,
    roundDeadline: g.roundDeadline || 0,
  };
  io.to(room.code).emit("clue-turn", payload);
  setPhaseTimer(g, T.clueTurn, () => onClueTimeout(room));
}

function onClueTimeout(room) {
  const g = room.game;
  if (!g || g.subPhase !== "clue") return;
  // auto-submit empty clue for the silent player
  const pid = g.turnOrder[g.turnIdx];
  g.clues.push({ playerId: pid, text: "…" });
  advanceClue(room);
}

function submitClue(room, player, text) {
  const g = room.game;
  if (!g || g.subPhase !== "clue") return { ok: false, error: "not-clue-phase" };
  if (g.turnOrder[g.turnIdx] !== player.id) return { ok: false, error: "not-your-turn" };
  const t = cleanText(text, 40);
  if (!t) return { ok: false, error: "empty" };
  g.clues.push({ playerId: player.id, text: t });
  advanceClue(room);
  return { ok: true };
}

function advanceClue(room) {
  const g = room.game;
  g.turnIdx++;
  if (g.turnIdx >= g.turnOrder.length) {
    startVote(room);
  } else {
    beginClueTurn(room);
  }
}

function startVote(room) {
  const g = room.game;
  g.subPhase = "vote";
  g.votes = new Map();
  clearPhaseTimer(g);
  io.to(room.code).emit("vote-start", {
    candidates: roomPlayers(room)
      .filter((p) => p.connected)
      .map((p) => ({ id: p.id, name: p.name })),
    deadline: Date.now() + T.vote,
  });
  setPhaseTimer(g, T.vote, () => onVoteTimeout(room));
}

function onVoteTimeout(room) {
  resolveVotes(room);
}

function submitVote(room, player, suspectId) {
  const g = room.game;
  if (!g || g.subPhase !== "vote") return { ok: false, error: "not-vote-phase" };
  if (suspectId === player.id) return { ok: false, error: "no-self-vote" };
  if (!room.players.get(suspectId)) return { ok: false, error: "bad-suspect" };
  g.votes.set(player.id, suspectId);
  // secret: only counts are broadcast
  io.to(room.code).emit("votes-update", { count: g.votes.size, needed: connectedCount(room) });
  if (g.votes.size >= connectedCount(room)) resolveVotes(room);
  return { ok: true };
}

function connectedCount(room) {
  return roomPlayers(room).filter((p) => p.connected).length;
}

function resolveVotes(room) {
  const g = room.game;
  if (!g || g.subPhase !== "vote") return;
  clearPhaseTimer(g);
  const tally = new Map();
  for (const suspectId of g.votes.values()) {
    tally.set(suspectId, (tally.get(suspectId) || 0) + 1);
  }
  let top = null, topCount = 0, tied = false;
  for (const [sid, n] of tally) {
    if (n > topCount) { top = sid; topCount = n; tied = false; }
    else if (n === topCount) { tied = true; }
  }
  const voteList = [...g.votes.entries()].map(([voterId, suspectId]) => ({
    voter: room.players.get(voterId).name,
    suspect: room.players.get(suspectId).name,
  }));

  if (!top || tied) {
    // no consensus -> imposter survives
    return finishGame(room, {
      winner: "imposter",
      reason: "tie",
      accusedId: null,
      votes: voteList,
    });
  }
  if (top === g.imposterId) {
    // caught! imposter gets one final guess
    g.subPhase = "guess";
    g.accusedId = top;
    g.votesList = voteList;
    io.to(room.code).emit("guess-start", {
      accusedName: room.players.get(top).name,
      deadline: Date.now() + T.guess,
    });
    const impSock = room.players.get(g.imposterId).socketId;
    if (impSock) io.to(impSock).emit("your-guess-turn", { deadline: Date.now() + T.guess });
    setPhaseTimer(g, T.guess, () => onGuessTimeout(room));
  } else {
    // innocent accused -> imposter wins immediately
    finishGame(room, {
      winner: "imposter",
      reason: "wrong-accusation",
      accusedId: top,
      votes: voteList,
    });
  }
}

function onGuessTimeout(room) {
  const g = room.game;
  if (!g || g.subPhase !== "guess") return;
  finishGame(room, {
    winner: "crew",
    reason: "guess-timeout",
    accusedId: g.accusedId,
    votes: g.votesList || [],
    guessCorrect: false,
  });
}

function norm(s) {
  return cleanText(s, 40).replace(/\s+/g, " ");
}

function submitGuess(room, player, text) {
  const g = room.game;
  if (!g || g.subPhase !== "guess") return { ok: false, error: "not-guess-phase" };
  if (player.id !== g.imposterId) return { ok: false, error: "not-imposter" };
  clearPhaseTimer(g);
  const correct = norm(text) === norm(g.word);
  finishGame(room, {
    winner: correct ? "imposter" : "crew",
    reason: correct ? "guess-correct" : "guess-wrong",
    accusedId: g.accusedId,
    votes: g.votesList || [],
    guessedWord: cleanText(text, 40),
    guessCorrect: correct,
  });
  return { ok: true };
}

function onRoundTimeout(room) {
  const g = room.game;
  if (!g || g.subPhase !== "clue") return;
  // round time up -> straight to voting
  startVote(room);
}

function finishGame(room, result) {
  const g = room.game;
  clearPhaseTimer(g);
  if (g.roundTimer) { clearTimeout(g.roundTimer); g.roundTimer = null; }
  g.subPhase = "result";
  g.result = result;
  room.phase = "result";
  io.to(room.code).emit("game-result", {
    winner: result.winner,
    reason: result.reason,
    word: g.word,
    imposterName: room.players.get(g.imposterId).name,
    accusedName: result.accusedId ? room.players.get(result.accusedId).name : null,
    votes: result.votes || [],
    guessedWord: result.guessedWord || null,
    guessCorrect: !!result.guessCorrect,
  });
}

function endToLobby(room, notice) {
  const g = room.game;
  if (g) {
    clearPhaseTimer(g);
    if (g.roundTimer) clearTimeout(g.roundTimer);
  }
  room.game = null;
  room.phase = "lobby";
  roomPlayers(room).forEach((p) => { p.ready = false; });
  emitLobby(room);
  if (notice) io.to(room.code).emit("notice", { text: notice });
}

/** send a full personalized snapshot (used on rejoin / resume) */
function syncGameState(room) {
  const g = room.game;
  if (!g) { emitLobby(room); return; }
  for (const p of roomPlayers(room)) {
    if (!p.connected || !p.socketId) continue;
    const isImp = p.id === g.imposterId;
    io.to(p.socketId).emit("state-sync", {
      phase: g.subPhase,
      paused: g.paused,
      isImposter: isImp,
      word: isImp ? null : g.word,
      turnOrder: g.turnOrder.map((id) => ({ id, name: room.players.get(id).name })),
      turnIndex: g.turnIdx,
      currentTurnId: g.subPhase === "clue" ? g.turnOrder[g.turnIdx] : null,
      clues: g.clues.map((c) => ({ name: room.players.get(c.playerId).name, text: c.text })),
      votesCount: g.votes ? g.votes.size : 0,
      votesNeeded: connectedCount(room),
      youVoted: g.votes ? g.votes.has(p.id) : false,
      deadline: g.deadline || 0,
      roundDeadline: g.roundDeadline || 0,
      accusedName: g.accusedId ? room.players.get(g.accusedId).name : null,
      result: g.result ? {
        winner: g.result.winner,
        reason: g.result.reason,
        word: g.word,
        imposterName: room.players.get(g.imposterId).name,
        accusedName: g.result.accusedId ? room.players.get(g.result.accusedId).name : null,
        votes: g.result.votes || [],
        guessedWord: g.result.guessedWord || null,
        guessCorrect: !!g.result.guessCorrect,
      } : null,
    });
  }
}

/* ---------------- express + socket.io ---------------- */

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.get("/health", (req, res) => res.json({ ok: true, rooms: rooms.size }));
app.get("/", (req, res) => res.send("Imposter game server — connect with the web client."));

io.on("connection", (socket) => {
  // ---------- create room ----------
  socket.on("create-room", ({ name, roundMinutes } = {}, cb) => {
    const cleanName = cleanText(name, 14) || "Player";
    const code = makeCode();
    const playerId = makeId();
    const player = {
      id: playerId, name: cleanName, token: makeToken(),
      socketId: socket.id, connected: true, ready: false,
    };
    const room = {
      code,
      hostId: playerId,
      players: new Map([[playerId, player]]),
      order: [playerId],
      phase: "lobby",
      settings: { roundMinutes: roundMinutes === 0 ? 0 : 5 },
      game: null,
      createdAt: Date.now(),
      emptyTimer: null,
    };
    rooms.set(code, room);
    socket.join(code);
    socketToPlayer.set(socket.id, { code, playerId });
    if (typeof cb === "function") cb({ ok: true, code, playerId, token: player.token });
    emitLobby(room);
  });

  // ---------- join room ----------
  socket.on("join-room", ({ code, name } = {}, cb) => {
    const room = getRoom(code);
    const done = (r) => { if (typeof cb === "function") cb(r); };
    if (!room) return done({ ok: false, error: "no-room" });
    if (room.phase !== "lobby") return done({ ok: false, error: "game-in-progress" });
    if (room.order.length >= MAX_PLAYERS) return done({ ok: false, error: "room-full" });
    let cleanName = cleanText(name, 14) || "Player";
    const taken = new Set(roomPlayers(room).map((p) => p.name));
    if (taken.has(cleanName)) {
      let i = 2;
      while (taken.has(cleanName + i)) i++;
      cleanName = (cleanName + i).slice(0, 14);
    }
    const playerId = makeId();
    const player = {
      id: playerId, name: cleanName, token: makeToken(),
      socketId: socket.id, connected: true, ready: false,
    };
    room.players.set(playerId, player);
    room.order.push(playerId);
    if (room.emptyTimer) { clearTimeout(room.emptyTimer); room.emptyTimer = null; }
    socket.join(code);
    socketToPlayer.set(socket.id, { code: room.code, playerId });
    done({ ok: true, code: room.code, playerId, token: player.token });
    emitLobby(room);
  });

  // ---------- rejoin with token ----------
  socket.on("rejoin", ({ code, token } = {}, cb) => {
    const room = getRoom(code);
    const done = (r) => { if (typeof cb === "function") cb(r); };
    if (!room || !token) return done({ ok: false, error: "no-room" });
    const player = roomPlayers(room).find((p) => p.token === token);
    if (!player) return done({ ok: false, error: "bad-token" });
    // drop any stale socket mapping
    for (const [sid, ref] of socketToPlayer) {
      if (ref.code === room.code && ref.playerId === player.id) socketToPlayer.delete(sid);
    }
    player.socketId = socket.id;
    player.connected = true;
    if (room.emptyTimer) { clearTimeout(room.emptyTimer); room.emptyTimer = null; }
    if (player.rejoinTimer) { clearTimeout(player.rejoinTimer); player.rejoinTimer = null; }
    socket.join(room.code);
    socketToPlayer.set(socket.id, { code: room.code, playerId: player.id });
    done({ ok: true, code: room.code, playerId: player.id, name: player.name });
    if (room.phase === "lobby") {
      emitLobby(room);
    } else {
      if (room.game && room.game.paused && roomPlayers(room).every((p) => p.connected)) {
        resumeGame(room);
      } else {
        syncGameState(room);
      }
      io.to(room.code).emit("notice", { text: player.name + " رجع للعبة" });
    }
  });

  // ---------- ready ----------
  socket.on("set-ready", ({ ready } = {}) => {
    const found = findPlayerBySocket(socket.id);
    if (!found || found.room.phase !== "lobby") return;
    found.player.ready = !!ready;
    emitLobby(found.room);
    const ps = roomPlayers(found.room);
    if (ps.length === MAX_PLAYERS && ps.every((p) => p.ready && p.connected)) {
      startGame(found.room);
    }
  });

  // ---------- host removes a disconnected player (lobby only) ----------
  socket.on("remove-player", ({ playerId } = {}) => {
    const found = findPlayerBySocket(socket.id);
    if (!found || found.room.phase !== "lobby") return;
    const { room, player } = found;
    if (room.hostId !== player.id) return;
    const target = room.players.get(playerId);
    if (!target || target.connected || target.id === player.id) return;
    room.players.delete(playerId);
    room.order = room.order.filter((id) => id !== playerId);
    emitLobby(room);
  });

  // ---------- leave ----------
  socket.on("leave-room", () => {
    const found = findPlayerBySocket(socket.id);
    if (!found) return;
    const { room, player } = found;
    handleLeave(room, player, false);
  });

  // ---------- game actions ----------
  socket.on("submit-clue", ({ text } = {}, cb) => {
    const found = findPlayerBySocket(socket.id);
    const done = (r) => { if (typeof cb === "function") cb(r); };
    if (!found) return done({ ok: false, error: "no-room" });
    done(submitClue(found.room, found.player, text));
  });

  socket.on("submit-vote", ({ suspectId } = {}, cb) => {
    const found = findPlayerBySocket(socket.id);
    const done = (r) => { if (typeof cb === "function") cb(r); };
    if (!found) return done({ ok: false, error: "no-room" });
    done(submitVote(found.room, found.player, suspectId));
  });

  socket.on("submit-guess", ({ text } = {}, cb) => {
    const found = findPlayerBySocket(socket.id);
    const done = (r) => { if (typeof cb === "function") cb(r); };
    if (!found) return done({ ok: false, error: "no-room" });
    done(submitGuess(found.room, found.player, text));
  });

  socket.on("play-again", () => {
    const found = findPlayerBySocket(socket.id);
    if (!found || found.room.phase !== "result") return;
    endToLobby(found.room, null);
  });

  // ---------- disconnect ----------
  socket.on("disconnect", () => {
    const found = findPlayerBySocket(socket.id);
    socketToPlayer.delete(socket.id);
    if (!found) return;
    const { room, player } = found;
    handleLeave(room, player, true);
  });
});

function handleLeave(room, player, isDisconnect) {
  player.connected = false;
  player.socketId = null;
  if (room.hostId === player.id) {
    const next = roomPlayers(room).find((p) => p.connected);
    if (next) room.hostId = next.id;
  }
  if (room.phase === "lobby") {
    emitLobby(room);
    if (!roomPlayers(room).some((p) => p.connected)) {
      room.emptyTimer = setTimeout(() => rooms.delete(room.code), T.roomEmptyTTL);
    }
    return;
  }
  // mid-game: pause and wait for rejoin
  pauseGame(room);
  io.to(room.code).emit("notice", { text: player.name + " انقطع الاتصال… مستنيينه يرجع" });
  syncGameState(room);
  player.rejoinTimer = setTimeout(() => {
    if (!player.connected && rooms.get(room.code) === room) {
      endToLobby(room, player.name + " مرجعش — اللعبة اتلغت");
    }
  }, T.rejoin);
}

server.listen(PORT, () => {
  console.log("Imposter server listening on port " + PORT + (FAST ? " [FAST_TIMERS]" : ""));
});
