/**
 * Headless 4-client integration test for the Imposter game server.
 * Each TestClient = a separate socket.io connection (like a separate phone).
 * Run: FAST_TIMERS=1 node test.js   (server must be started separately with FAST_TIMERS=1)
 */
const { io } = require("socket.io-client");

const URL = process.env.SERVER_URL || "http://localhost:3000";
let failures = 0;
function ok(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); }
  else { failures++; console.log("  ✗ FAIL: " + msg); }
}

class C {
  constructor(name) {
    this.name = name;
    this.events = {};      // event -> [payloads]
    this.waiters = {};     // event -> [resolve]
    this.allPayloads = []; // every payload received (for leak scan)
    this.socket = io(URL, { reconnection: false, timeout: 8000 });
    this.socket.onAny((ev, ...args) => {
      const p = args[0];
      this.allPayloads.push({ ev, p });
      (this.events[ev] = this.events[ev] || []).push(p);
      const ws = this.waiters[ev] || [];
      this.waiters[ev] = [];
      ws.forEach((w) => w(p));
    });
  }
  wait(ev, ms = 12000) {
    const q = this.events[ev] || [];
    if (q.length) return Promise.resolve(q.shift());
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("timeout waiting " + ev + " for " + this.name)), ms);
      (this.waiters[ev] = this.waiters[ev] || []).push((p) => { clearTimeout(to); resolve(p); });
    });
  }
  clear(ev) { this.events[ev] = []; }
  emit(ev, data) {
    return new Promise((resolve) => this.socket.emit(ev, data, (r) => resolve(r)));
  }
  fire(ev, data) { this.socket.emit(ev, data); }
  drop() { this.socket.disconnect(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newGame(clients) {
  // clients[0] creates, rest join; all ready; returns { code, started: [payloads] }
  const r = await clients[0].emit("create-room", { name: clients[0].name, roundMinutes: 5 });
  ok(r.ok && r.code && r.token, "room created with code+token");
  const code = r.code;
  clients[0].token = r.token; clients[0].playerId = r.playerId;
  for (let i = 1; i < clients.length; i++) {
    const j = await clients[i].emit("join-room", { code, name: clients[i].name });
    ok(j.ok, clients[i].name + " joined");
    clients[i].token = j.token; clients[i].playerId = j.playerId;
  }
  clients.forEach((c) => c.clear("game-started"));
  clients.forEach((c) => c.fire("set-ready", { ready: true }));
  const started = [];
  for (const c of clients) started.push(await c.wait("game-started"));
  return { code, started };
}

function imposterIdx(started) {
  return started.findIndex((s) => s.isImposter);
}

async function playClues(clients, started, opts = {}) {
  // opts.skipTurnFor: client index to NOT answer (tests auto-timeout)
  for (let t = 0; t < 4; t++) {
    const turn = await clients[0].wait("clue-turn");
    clients.forEach((c) => c.clear("clue-turn"));
    const curId = turn.currentTurnId;
    const cur = clients.find((c) => c.playerId === curId);
    ok(!!cur, "turn " + (t + 1) + " assigned to a connected client");
    // out-of-turn submission must be rejected
    const other = clients.find((c) => c !== cur);
    const bad = await other.emit("submit-clue", { text: "sneaky" });
    ok(!bad.ok && bad.error === "not-your-turn", "out-of-turn clue rejected");
    const empty = await cur.emit("submit-clue", { text: "   " });
    ok(!empty.ok && empty.error === "empty", "empty clue rejected");
    if (opts.skipTurnFor === clients.indexOf(cur)) {
      await sleep(5200); // FAST_TIMERS clueTurn=4s -> auto "…" 
    } else {
      const good = await cur.emit("submit-clue", { text: "clue" + t });
      ok(good.ok, "clue " + (t + 1) + " accepted from " + cur.name);
    }
  }
  const vs = await clients[0].wait("vote-start");
  clients.forEach((c) => c.clear("vote-start"));
  return vs;
}
async function voteAll(clients, started, targetIdx) {
  const targetId = clients[targetIdx].playerId;
  for (const c of clients) {
    c.clear("game-result"); c.clear("guess-start"); c.clear("your-guess-turn");
  }
  // self-vote must be rejected
  const selfBad = await clients[0].emit("submit-vote", { suspectId: clients[0].playerId });
  ok(!selfBad.ok && selfBad.error === "no-self-vote", "self-vote rejected");
  for (let i = 0; i < clients.length; i++) {
    // a voter who IS the target can't vote for themselves -> vote elsewhere
    const vid = clients[i].playerId === targetId ? clients[(i + 2) % 4].playerId : targetId;
    const r = await clients[i].emit("submit-vote", { suspectId: vid });
    ok(r.ok, clients[i].name + " voted");
  }
}

async function main() {
  console.log("== connecting 4 clients ==");
  const names = ["Paul", "Gloria", "Meme", "Johny"];
  const clients = names.map((n) => new C(n));
  await sleep(1500);

  console.log("== Test 0: join validations ==");
  {
    const tmp = new C("Tmp");
    await sleep(800);
    const badCode = await tmp.emit("join-room", { code: "ZZZZ", name: "X" });
    ok(!badCode.ok && badCode.error === "no-room", "wrong code rejected");
    const r = await tmp.emit("create-room", { name: "Solo", roundMinutes: 0 });
    ok(r.ok, "second room created (isolation)");
    const r2 = await tmp.emit("create-room", { name: "Solo2", roundMinutes: 0 });
    tmp.drop();
  }

  console.log("== Test 1: imposter caught, guesses right -> imposter wins ==");
  let { code, started } = await newGame(clients);
  // attach playerIds to started payloads for mapping
  started.forEach((s, i) => { s.pid = clients[i].playerId; });
  const imp = imposterIdx(started);
  ok(imp >= 0, "exactly one imposter assigned");
  const words = started.filter((s) => !s.isImposter).map((s) => s.word);
  ok(words.every((w) => w && w === words[0]), "3 crew got the same word");
  ok(started[imp].word === null, "imposter got NO word");
  // leak scan: imposter's pre-result payloads must not contain the word
  const w0 = words[0];
  const impClient = clients[imp];
  const leak = impClient.allPayloads.some(({ ev, p }) =>
    ev !== "game-result" && JSON.stringify(p).includes(w0));
  ok(!leak, "no word leak to imposter before result");
  const tokenLeak = clients.some((c) => c.allPayloads.some(({ p }) =>
    JSON.stringify(p).includes(clients.find((x) => x !== c).token || "###")));
  ok(!tokenLeak, "no token leak across clients");

  await playClues(clients, started);
  await voteAll(clients, started, imp);
  const gs = await clients[0].wait("guess-start");
  ok(!!gs.accusedName, "guess phase started after catching imposter");
  let gotPrivate = false;
  for (let i = 0; i < clients.length; i++) {
    if (i === imp) continue;
    try { await clients[i].wait("your-guess-turn", 1500); gotPrivate = true; } catch (e) {}
  }
  ok(!gotPrivate, "your-guess-turn sent ONLY to imposter");
  await impClient.wait("your-guess-turn");
  const gr = await impClient.emit("submit-guess", { text: w0 });
  ok(gr.ok, "imposter submitted guess");
  const res = await clients[0].wait("game-result");
  ok(res.winner === "imposter" && res.reason === "guess-correct", "imposter wins on correct guess");
  ok(res.word === w0 && res.imposterName === clients[imp].name, "result reveals word+imposter");
  // all clients see the same result
  for (let i = 1; i < clients.length; i++) {
    const r2 = await clients[i].wait("game-result");
    ok(r2.winner === "imposter" && r2.word === w0, "result synced to " + clients[i].name);
  }

  console.log("== Test 2: wrong accusation -> imposter wins ==");
  clients.forEach((c) => c.fire("play-again"));
  await sleep(800);
  ({ started } = await (async () => {
    clients.forEach((c) => c.clear("game-started"));
    clients.forEach((c) => c.fire("set-ready", { ready: true }));
    const st = [];
    for (const c of clients) st.push(await c.wait("game-started"));
    st.forEach((s, i) => { s.pid = clients[i].playerId; });
    return { started: st };
  })());
  const imp2 = imposterIdx(started);
  const innocent = (imp2 + 1) % 4;
  await playClues(clients, started);
  await voteAll(clients, started, innocent);
  const res2 = await clients[0].wait("game-result");
  ok(res2.winner === "imposter" && res2.reason === "wrong-accusation", "imposter wins on wrong accusation");

  console.log("== Test 3: tie vote -> imposter wins ==");
  clients.forEach((c) => c.fire("play-again"));
  await sleep(800);
  {
    clients.forEach((c) => c.clear("game-started"));
    clients.forEach((c) => c.fire("set-ready", { ready: true }));
    const st = [];
    for (const c of clients) st.push(await c.wait("game-started"));
    st.forEach((s, i) => { s.pid = clients[i].playerId; });
    started = st;
  }
  await playClues(clients, started);
  // 1-1-1-1 tie: each votes next player
  for (const c of clients) { c.clear("game-result"); c.clear("guess-start"); }
  for (let i = 0; i < clients.length; i++) {
    await clients[i].emit("submit-vote", { suspectId: clients[(i + 1) % 4].playerId });
  }
  const res3 = await clients[0].wait("game-result");
  ok(res3.winner === "imposter" && res3.reason === "tie", "tie -> imposter wins");

  console.log("== Test 4: disconnect + reconnect mid-game ==");
  clients.forEach((c) => c.fire("play-again"));
  await sleep(800);
  {
    clients.forEach((c) => c.clear("game-started"));
    clients.forEach((c) => c.fire("set-ready", { ready: true }));
    const st = [];
    for (const c of clients) st.push(await c.wait("game-started"));
    st.forEach((s, i) => { s.pid = clients[i].playerId; });
    started = st;
  }
  // play one clue, then drop client 2 mid-turn
  const turn1 = await clients[0].wait("clue-turn");
  clients.forEach((c) => c.clear("clue-turn"));
  const cur1 = clients.find((c) => c.playerId === turn1.currentTurnId);
  await cur1.emit("submit-clue", { text: "first" });
  const victim = clients[2];
  const victimToken = victim.token, victimCode = code;
  clients.forEach((c) => c.clear("notice"));
  victim.drop();
  const notice = await clients[0].wait("notice", 8000);
  ok(/انقطع/.test(notice.text), "others notified of disconnect: " + notice.text);
  // reconnect with token on a FRESH socket
  const back = new C("Meme");
  back.name = "Meme";
  const rj = await back.emit("rejoin", { code: victimCode, token: victimToken });
  ok(rj.ok, "rejoined with token");
  back.token = victimToken; back.playerId = victim.playerId;
  const sync = await back.wait("state-sync", 8000);
  ok(sync.phase === "clue", "returner got full state sync (clue phase)");
  clients[2] = back; // swap in
  // finish the game: play remaining clues (driver assists turns)
  for (let t = 0; t < 3; t++) {
    const turn = await clients[0].wait("clue-turn", 15000);
    clients.forEach((c) => { if (c !== back) c.clear("clue-turn"); });
    back.clear("clue-turn");
    const cur = clients.find((c) => c.playerId === turn.currentTurnId);
    if (cur) await cur.emit("submit-clue", { text: "c" + t });
  }
  await clients[0].wait("vote-start", 15000);
  ok(true, "game resumed and reached voting after reconnect");
  // finish this game so play-again works in the next test
  for (let i = 0; i < clients.length; i++) {
    await clients[i].emit("submit-vote", { suspectId: clients[(i + 1) % 4].playerId });
  }
  await clients[0].wait("game-result", 15000);
  ok(true, "reconnected game finished cleanly");

  console.log("== Test 5: clue timeout auto-advances ==");
  clients.forEach((c) => c.fire("play-again"));
  await sleep(800);
  {
    clients.forEach((c) => c.clear("game-started"));
    clients.forEach((c) => c.fire("set-ready", { ready: true }));
    const st = [];
    for (const c of clients) st.push(await c.wait("game-started"));
    st.forEach((s, i) => { s.pid = clients[i].playerId; });
    started = st;
  }
  // never submit: 4 turns x 4s FAST timers -> should auto-advance to vote
  const vs = await clients[0].wait("vote-start", 30000);
  ok(!!vs, "clue timeouts auto-advanced to voting");

  console.log(failures === 0 ? "\nALL TESTS PASSED ✓" : `\n${failures} FAILURES ✗`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exit(1); });
