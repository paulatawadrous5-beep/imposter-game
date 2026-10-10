/* Imposter game client — Arabic RTL, mobile-first */
"use strict";

// سيرفر اللعبة — غيّر الرابط ده لرابط سيرفرك بعد ما ترفعه على Render
// (أو جرّب سيرفر تاني مؤقتًا بإضافة ?server=https://... لرابط اللعبة)
const SERVER_URL =
  new URLSearchParams(location.search).get("server") ||
  "https://imposter-game-server.onrender.com";

const $ = (id) => document.getElementById(id);
const SCREENS = ["homeScreen", "lobbyScreen", "roleScreen", "clueScreen", "voteScreen", "guessScreen", "resultScreen"];

const S = {
  socket: null,
  code: null, playerId: null, token: null, name: null,
  myId: null, isImposter: false, word: null,
  turnOrder: [], clues: [],
  candidates: [],
  deadlines: {}, // {clue, round, vote, guess}
  ready: false,
};

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function show(id) {
  SCREENS.forEach((s) => $(s).classList.toggle("hidden", s !== id));
  window.scrollTo(0, 0);
}

function toast(msg, ms) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), ms || 2600);
}

function fmtTime(ms) {
  if (ms == null || ms < 0) ms = 0;
  const s = Math.ceil(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

setInterval(() => {
  const now = Date.now();
  [["clueTimer", "clue"], ["roundTimer", "round"], ["voteTimer", "vote"], ["guessTimer", "guess"]].forEach(([el, k]) => {
    const e = $(el);
    if (!e || !S.deadlines[k]) return;
    const left = S.deadlines[k] - now;
    e.textContent = (k === "round" ? "⏱ " : "⏳ ") + fmtTime(left);
    e.classList.toggle("low", left < 15000);
  });
}, 500);

/* ---------------- socket ---------------- */

function connect() {
  const socket = io(SERVER_URL, { reconnection: true, reconnectionDelay: 1000, timeout: 15000 });
  S.socket = socket;

  socket.on("connect", () => {
    $("connBar").classList.add("hidden");
    const sess = loadSession();
    if (sess && sess.code && sess.token) {
      socket.emit("rejoin", { code: sess.code, token: sess.token }, (r) => {
        if (r && r.ok) {
          S.code = r.code; S.playerId = r.playerId; S.token = sess.token; S.name = r.name || sess.name;
          toast("رجعت الغرفة ✅");
        } else {
          clearSession();
        }
      });
    }
  });

  socket.on("disconnect", () => $("connBar").classList.remove("hidden"));
  socket.on("connect_error", () => $("connBar").classList.remove("hidden"));

  socket.on("lobby-update", (d) => renderLobby(d));
  socket.on("game-started", (d) => onGameStarted(d));
  socket.on("clue-turn", (d) => onClueTurn(d));
  socket.on("vote-start", (d) => onVoteStart(d));
  socket.on("votes-update", (d) => { $("voteStatus").textContent = `صوّت ${d.count} من ${d.needed}…`; });
  socket.on("guess-start", (d) => onGuessStart(d, false));
  socket.on("your-guess-turn", (d) => onGuessStart(d, true));
  socket.on("game-result", (d) => onResult(d));
  socket.on("state-sync", (d) => onStateSync(d));
  socket.on("notice", (d) => toast(d.text, 3200));
}

function saveSession() {
  try {
    sessionStorage.setItem("imposter-session", JSON.stringify({ code: S.code, token: S.token, name: S.name }));
  } catch (e) {}
}
function loadSession() {
  try { return JSON.parse(sessionStorage.getItem("imposter-session") || "null"); }
  catch (e) { return null; }
}
function clearSession() {
  try { sessionStorage.removeItem("imposter-session"); } catch (e) {}
}

/* ---------------- home ---------------- */

function myName() {
  const n = $("nameInput").value.trim().slice(0, 14);
  if (!n) { $("homeError").textContent = "اكتب اسمك الأول 😊"; return null; }
  $("homeError").textContent = "";
  return n;
}

$("create5Btn").onclick = () => {
  const name = myName(); if (!name) return;
  S.socket.emit("create-room", { name, roundMinutes: 5 }, onCreated);
};
$("createInfBtn").onclick = () => {
  const name = myName(); if (!name) return;
  S.socket.emit("create-room", { name, roundMinutes: 0 }, onCreated);
};
function onCreated(r) {
  if (!r || !r.ok) { $("homeError").textContent = "مش عارف أعمل غرفة، حاول تاني"; return; }
  S.code = r.code; S.playerId = r.playerId; S.token = r.token;
  S.name = $("nameInput").value.trim().slice(0, 14);
  saveSession();
}
$("joinBtn").onclick = () => {
  const name = myName(); if (!name) return;
  const code = $("codeInput").value.trim().toUpperCase();
  if (code.length !== 4) { $("homeError").textContent = "الكود ٤ حروف"; return; }
  S.socket.emit("join-room", { code, name }, (r) => {
    if (!r || !r.ok) {
      $("homeError").textContent = r && r.error === "no-room" ? "مفيش غرفة بالكود ده" :
        r && r.error === "room-full" ? "الغرفة مليانة" :
        r && r.error === "game-in-progress" ? "اللعبة شغالة… استنى الجولة تخلص" : "مش عارف ادخل، حاول تاني";
      return;
    }
    S.code = r.code; S.playerId = r.playerId; S.token = r.token;
    S.name = name;
    saveSession();
  });
};
$("codeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("joinBtn").click(); });

/* ---------------- lobby ---------------- */

function renderLobby(d) {
  S.code = d.code;
  show("lobbyScreen");
  $("roomCode").textContent = d.code;
  $("lobbySettings").textContent = d.settings.roundMinutes > 0
    ? `⏱ الجولة ${d.settings.roundMinutes} دقايق` : "⏱ بدون وقت";
  const me = d.players.find((p) => p.id === S.playerId);
  S.myId = S.playerId;
  S.ready = !!(me && me.ready);
  $("playerList").innerHTML = d.players.map((p) => `
    <div class="player ${p.connected ? "online" : "off"} ${p.ready ? "ready" : ""} ${p.id === S.playerId ? "me" : ""}">
      <span class="dot"></span>
      <span class="nm">${esc(p.name)}${p.host ? " 👑" : ""}${p.id === S.playerId ? " (انت)" : ""}</span>
      <span class="st">${!p.connected ? "انقطع…" : p.ready ? "جاهز ✅" : "مستني…"}</span>
    </div>`).join("");
  const readyCount = d.players.filter((p) => p.ready && p.connected).length;
  $("lobbyStatus").textContent = d.players.length < 4
    ? `مستنيين ${4 - d.players.length} لاعب كمان…`
    : readyCount < 4 ? `جاهزين ${readyCount}/4 — دوس "أنا جاهز"` : "كلهم جاهزين… يلا! 🎮";
  const rb = $("readyBtn");
  rb.textContent = S.ready ? "❌ مش جاهز" : "✅ أنا جاهز";
  rb.disabled = !me || !me.connected;
}
$("roomCode").onclick = () => {
  const c = $("roomCode").textContent;
  if (navigator.clipboard) navigator.clipboard.writeText(c).then(() => toast("اتنسخ الكود 📋"));
  else toast("الكود: " + c);
};
$("readyBtn").onclick = () => {
  S.socket.emit("set-ready", { ready: !S.ready });
};
function leaveRoom() {
  S.socket.emit("leave-room");
  clearSession();
  S.code = S.token = S.playerId = null;
  show("homeScreen");
}
$("leaveBtn").onclick = leaveRoom;
$("resultLeaveBtn").onclick = leaveRoom;

/* ---------------- game: role ---------------- */

function onGameStarted(d) {
  S.isImposter = d.isImposter;
  S.word = d.word;
  S.turnOrder = d.turnOrder;
  S.clues = [];
  S.deadlines.round = d.roundSeconds ? Date.now() + d.roundSeconds * 1000 : 0;
  show("roleScreen");
  $("roleCard").className = "role-card" + (d.isImposter ? " imposter" : "");
  $("roleCard").innerHTML = d.isImposter
    ? `<div class="role-big">😈</div>
       <h2>انت المحتال!</h2>
       <p class="role-sub">محدش عارف الكلمة السرية غير الـ ٣ التانيين.<br>خمن من التلميحات، ومتتكشفش 👀</p>`
    : `<div class="role-sub">الكلمة السرية:</div>
       <div class="role-word">${esc(d.word)}</div>
       <p class="role-sub">ادّي تلميح يوضحها من غير ما تكشفها للمحتال 🤫</p>`;
}
$("roleOkBtn").onclick = () => { /* wait for first clue-turn event */ };

/* ---------------- game: clues ---------------- */

function onClueTurn(d) {
  show("clueScreen");
  S.clues = d.clues;
  S.deadlines.clue = d.deadline;
  if (d.roundDeadline) S.deadlines.round = d.roundDeadline;
  renderClues(d);
}

function renderClues(d) {
  const me = d.currentTurnId === S.playerId;
  const tb = $("turnBanner");
  tb.className = "turn-banner" + (me ? " me" : "");
  tb.textContent = me ? "✍️ دورك! اكتب تلميح من كلمة واحدة" : `دور ${d.currentTurnName}… (${d.turnIndex + 1}/${d.totalTurns})`;
  $("clueList").innerHTML = d.clues.length
    ? d.clues.map((c) => `<div class="clue"><span class="who">${esc(c.name)}:</span><span>${esc(c.text)}</span></div>`).join("")
    : `<p class="muted">لسه مفيش تلميحات…</p>`;
  $("clueForm").classList.toggle("hidden", !me);
  if (me) { $("clueInput").value = ""; setTimeout(() => $("clueInput").focus(), 300); }
  const mw = $("myWord");
  if (S.isImposter) { mw.className = "my-word imposter"; mw.textContent = "😈 انت المحتال — خمّن من التلميحات"; }
  else { mw.className = "my-word"; mw.textContent = "🔑 " + S.word; }
}

function sendClue() {
  const t = $("clueInput").value.trim();
  if (!t) return;
  $("clueSendBtn").disabled = true;
  S.socket.emit("submit-clue", { text: t }, (r) => {
    $("clueSendBtn").disabled = false;
    if (!r || !r.ok) toast("مش دورك دلوقتي");
  });
}
$("clueSendBtn").onclick = sendClue;
$("clueInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendClue(); });

/* ---------------- game: voting ---------------- */

function onVoteStart(d) {
  show("voteScreen");
  S.candidates = d.candidates;
  S.deadlines.vote = d.deadline;
  $("voteStatus").textContent = "اختار اللي شاكك فيه…";
  $("candidateList").innerHTML = d.candidates
    .filter((c) => c.id !== S.playerId)
    .map((c) => `
      <div class="player candidate online" data-id="${c.id}">
        <span class="dot"></span><span class="nm">${esc(c.name)}</span><span class="st">🗳️</span>
      </div>`).join("");
  document.querySelectorAll(".player.candidate").forEach((el) => {
    el.onclick = () => {
      document.querySelectorAll(".player.candidate").forEach((x) => x.classList.remove("picked"));
      el.classList.add("picked");
      S.socket.emit("submit-vote", { suspectId: el.getAttribute("data-id") }, (r) => {
        if (r && r.ok) {
          $("voteStatus").textContent = "تم التصويت ✅ مستنيين الباقي…";
          document.querySelectorAll(".player.candidate").forEach((x) => { x.onclick = null; x.style.opacity = x === el ? 1 : .4; });
        } else if (r && r.error === "no-self-vote") {
          toast("مينفعش تصوّت لنفسك 😅");
        }
      });
    };
  });
}

/* ---------------- game: final guess ---------------- */

function onGuessStart(d, isMe) {
  show("guessScreen");
  S.deadlines.guess = d.deadline;
  $("guessBody").innerHTML = isMe
    ? `<div class="role-card imposter">
         <div class="role-big">😈</div>
         <h2>اتكشفت!</h2>
         <p class="role-sub">عندك فرصة أخيرة: خمّن الكلمة السرية صح تكسب 🏆</p>
       </div>
       <div class="clue-form">
         <input id="guessInput" class="input" maxlength="40" placeholder="الكلمة السرية…" autocomplete="off">
         <button id="guessBtn" class="btn btn-primary">خمّن 🎯</button>
       </div>`
    : `<div class="role-card">
         <div class="role-big">🤔</div>
         <h2>${esc(d.accusedName)} طلع المحتال!</h2>
         <p class="role-sub">بيحاول يخمن الكلمة السرية دلوقتي…<br>لو خمنها صح هو اللي هيكسب 😱</p>
       </div>`;
  if (isMe) {
    const go = () => {
      const t = $("guessInput").value.trim();
      if (!t) return;
      $("guessBtn").disabled = true;
      S.socket.emit("submit-guess", { text: t }, (r) => {
        if (!r || !r.ok) { $("guessBtn").disabled = false; toast("حصل حاجة غلط، حاول تاني"); }
      });
    };
    $("guessBtn").onclick = go;
    $("guessInput").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    setTimeout(() => $("guessInput").focus(), 300);
  }
}

/* ---------------- game: result ---------------- */

function onResult(d) {
  show("resultScreen");
  S.deadlines = {};
  const crewWin = d.winner === "crew";
  $("resultBanner").className = "result-banner " + d.winner;
  const reasonTxt = {
    "guess-correct": "المحتال خمّن الكلمة صح! 😈",
    "guess-wrong": "المحتال خمّن غلط 🎉",
    "guess-timeout": "المحتال ملحقش يخمن 🎉",
    "wrong-accusation": `اتهمتوا ${esc(d.accusedName)} وهو بريء! 😈`,
    "tie": "مفيش إجماع… المحتال نجا 😈",
  }[d.reason] || "";
  $("resultBanner").innerHTML = (crewWin ? "🎉 الفريق كسب!" : "😈 المحتال كسب!") + `<br><span style="font-size:16px;font-weight:400">${reasonTxt}</span>`;
  $("resultDetails").innerHTML = `
    <div class="vote-row"><span>🔑 الكلمة كانت:</span><b>${esc(d.word)}</b></div>
    <div class="vote-row"><span>😈 المحتال:</span><b>${esc(d.imposterName)}</b></div>
    ${d.accusedName ? `<div class="vote-row"><span>🎯 المتهم:</span><b>${esc(d.accusedName)}</b></div>` : ""}
    ${d.guessedWord ? `<div class="vote-row"><span>🤔 تخمينه:</span><b>${esc(d.guessedWord)}</b></div>` : ""}
    <div style="margin-top:8px;color:var(--muted)">التصويت:</div>
    ${d.votes.map((v) => `<div class="vote-row"><span>${esc(v.voter)}</span><span>← ${esc(v.suspect)}</span></div>`).join("") || '<div class="muted">محدش صوّت</div>'}
  `;
}
$("againBtn").onclick = () => S.socket.emit("play-again");

/* ---------------- rejoin mid-game ---------------- */

function onStateSync(d) {
  if (d.paused) toast("⏸ اللعبة واقفة — مستنيين لاعب يرجع…", 3000);
  S.isImposter = d.isImposter;
  S.word = d.word;
  S.turnOrder = d.turnOrder;
  if (d.deadline) {
    if (d.phase === "clue") S.deadlines.clue = d.deadline;
    if (d.phase === "vote") S.deadlines.vote = d.deadline;
    if (d.phase === "guess") S.deadlines.guess = d.deadline;
  }
  if (d.roundDeadline) S.deadlines.round = d.roundDeadline;
  if (d.phase === "clue") {
    onClueTurn({
      turnIndex: d.turnIndex, totalTurns: d.turnOrder.length,
      currentTurnId: d.currentTurnId,
      currentTurnName: (d.turnOrder.find((t) => t.id === d.currentTurnId) || {}).name || "",
      clues: d.clues, deadline: d.deadline, roundDeadline: d.roundDeadline,
    });
  } else if (d.phase === "vote") {
    if (!d.youVoted) {
      onVoteStart({
        candidates: d.turnOrder,
        deadline: d.deadline,
      });
      $("voteStatus").textContent = `صوّت ${d.votesCount} من ${d.votesNeeded}…`;
    } else {
      show("voteScreen");
      $("candidateList").innerHTML = "";
      $("voteStatus").textContent = `تم التصويت ✅ (${d.votesCount}/${d.votesNeeded}) مستنيين الباقي…`;
    }
  } else if (d.phase === "guess") {
    onGuessStart({ accusedName: d.accusedName, deadline: d.deadline }, d.isImposter);
  } else if (d.phase === "result" && d.result) {
    onResult(d.result);
  }
}

/* ---------------- boot ---------------- */

connect();
show("homeScreen");
