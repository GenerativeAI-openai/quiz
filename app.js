import * as Y from "https://cdn.jsdelivr.net/npm/yjs@13.6.18/dist/yjs.mjs"
// import * as Y from "https://cdn.jsdelivr.net/npm/yjs@13.6.18/dist/yjs.mjs"
// ✅ y-webrtc CDN 경로 수정 (dist/... 아님)
import { WebrtcProvider } from "https://esm.sh/y-webrtc@10.3.0"
// import { WebrtcProvider } from "https://cdn.jsdelivr.net/npm/y-webrtc@10.3.0/y-webrtc.js"
console.log("✅이 메시지가 표시되면 정상 작동한 것입니다")
// 퀴즈 JSON URL 고정
const QUIZ_URL = "https://raw.githubusercontent.com/GenerativeAI-openai/quiz_json/refs/heads/main/quiz.json"
const $ = (id) => document.getElementById(id)

// UI refs
const roomInput = $("room")
const nameInput = $("name")
const joinBtn = $("join")
const lobby = $("lobby")
const roomLabel = $("roomLabel")
const peersEl = $("peers")
const beHostBtn = $("beHost")
const startGameBtn = $("startGame")
const hostPanel = $("hostPanel")
const loadFromUrlBtn = $("loadFromUrl")
const nextQBtn = $("nextQ")
const endGameBtn = $("endGame")
const play = $("play")
const timerEl = $("timer")
const qbox = $("qbox")
const optsEl = $("opts")
const myAnsEl = $("myAns")
const myScoreEl = $("myScore")
const result = $("result")
const rankingEl = $("ranking")

// Yjs shared structures
let doc, provider, awareness, stateMap, answersMap
let me = { id: "", name: "", host: false }
let tickInterval = null

// 호스트 전용 워커
let hostWorker = null
let reqSeq = 0
const pendingReq = new Map()

function show(el, on = true){ el.classList.toggle("hidden", !on) }
function getPhase(){ return stateMap.get("phase") || "lobby" }
function setPhase(p){ stateMap.set("phase", p) }
function getQIndex(){ return stateMap.get("qIndex") ?? -1 }
function setQIndex(i){ stateMap.set("qIndex", i) }
function getCurrentQShared(){ return stateMap.get("currentQ") || null } // { q, opts, t }
function isHost(){ return !!(answersMap.get(me.id)?.host) }
function now(){ return Date.now() }

function ensureMe(){
  const id = me.id
  const cur = answersMap.get(id) || { nickname: me.name, score: 0, lastAnswer: null, host: false, pending: null }
  if (!answersMap.has(id)) answersMap.set(id, cur)
  return cur
}

function renderPeers(){
  const peers = []
  answersMap.forEach((v, k) => peers.push({ id: k, ...v }))
  peers.sort((a,b) => b.score - a.score)
  peersEl.innerHTML = peers.map(p => `<span class="badge">\${p.nickname}\${p.host ? " ⭐" : ""} (\${p.score})</span>`).join("")
}

function stopTimerTick(){
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null }
  timerEl.textContent = ""
}
function startTimerIfNeeded(){
  stopTimerTick()
  const q = getCurrentQShared()
  const startedAt = stateMap.get("roundStartedAt")
  const limit = q?.t
  if (!q || !limit || !startedAt) return
  const renderTick = () => {
    const remain = Math.max(0, Math.ceil((startedAt + limit*1000 - now())/1000))
    timerEl.textContent = remain > 0 ? `남은 시간: \${remain}s` : "시간 종료"
    if (remain <= 0) stopTimerTick()
  }
  renderTick()
  tickInterval = setInterval(renderTick, 250)
}

function renderPhase(){
  const phase = getPhase()
  show(lobby, phase === "lobby")
  show(play, phase === "playing")
  show(result, phase === "result")
  show(hostPanel, isHost()) // 호스트면 패널 표시

  if (phase === "playing"){
    const q = getCurrentQShared()
    if (!q) {
      qbox.textContent = "문제가 없습니다"
      optsEl.innerHTML = ""
      return
    }
    qbox.textContent = q.q
    optsEl.innerHTML = ""
    q.opts.forEach((opt, idx) => {
      const btn = document.createElement("button")
      btn.textContent = `\${idx+1}. \${opt}`
      btn.onclick = () => submitAnswer(idx)
      optsEl.appendChild(btn)
    })
    startTimerIfNeeded()
  } else if (phase === "result") {
    stopTimerTick()
    const arr = []
    answersMap.forEach((v, k) => arr.push({ id:k, ...v }))
    arr.sort((a,b)=> b.score - a.score)
    rankingEl.innerHTML = arr.map(p => `<li>\${p.nickname} — \${p.score}점</li>`).join("")
  }
  renderPeers()
}

// ===== 워커 RPC 유틸 =====
function workerCall(type, payload){
  return new Promise((resolve, reject) => {
    if (!hostWorker) return reject(new Error("호스트 워커가 초기화되지 않았습니다."));
    const reqId = ++reqSeq;
    pendingReq.set(reqId, { resolve, reject });
    hostWorker.postMessage({ type, payload, reqId });
  });
}

function initHostWorker(){
  if (hostWorker) return;
  try {
    hostWorker = new Worker("./quizHost.worker.js", { type: "module" });
    hostWorker.onmessage = (ev) => {
      const { ok, reqId, data, error } = ev.data || {}
      if (!reqId || !pendingReq.has(reqId)) return
      const { resolve, reject } = pendingReq.get(reqId)
      pendingReq.delete(reqId)
      if (ok) resolve(data); else reject(new Error(error || "Worker error"))
    }
  } catch (e) {
    alert("워커 초기화 실패: " + e.message)
  }
}

// ===== 호스트 전용 라운드 제어 =====
async function hostLoadQuiz(url){
  initHostWorker();
  return workerCall("LOAD", { url });
}
async function hostPushRound(index){
  const pubQ = await workerCall("GET_Q", { index });
  stateMap.set("currentQ", pubQ); // {q, opts, t}
  stateMap.set("qIndex", index);
  stateMap.set("roundStartedAt", now());
}
async function hostScoreNow(){
  const idx = getQIndex();
  const submissions = [];
  answersMap.forEach((v, k) => {
    if (typeof v?.pending === "number") submissions.push({ id: k, ans: v.pending });
  });
  if (!submissions.length) return;

  const result = await workerCall("SCORE", { index: idx, submissions });
  for (const s of result.scored){
    const rec = answersMap.get(s.id);
    if (!rec) continue;
    if (s.correct) rec.score = (rec.score || 0) + 1;
    rec.pending = null;
    answersMap.set(s.id, rec);
  }
}

// ===== 제출 =====
function submitAnswer(idx){
  const q = getCurrentQShared()
  if (!q) return
  const my = ensureMe()

  const startedAt = stateMap.get("roundStartedAt")
  const limit = q?.t
  const expired = limit && (now() > startedAt + limit*1000)
  if (expired) return

  my.pending = idx
  my.lastAnswer = idx
  answersMap.set(me.id, my)

  myAnsEl.textContent = idx+1
  myScoreEl.textContent = my.score ?? 0
}

// ===== 이벤트 바인딩 =====
joinBtn.onclick = () => {
  try {
    const room = roomInput.value.trim()
    const name = nameInput.value.trim() || "Player"
    if (!room) return alert("방 코드를 입력하세요")

    me.id = crypto.randomUUID()
    me.name = name

    doc = new Y.Doc()
    provider = new WebrtcProvider(room, doc, {})
    awareness = provider.awareness

    stateMap = doc.getMap("state")
    answersMap = doc.getMap("answers")

    if (!stateMap.get("phase")) stateMap.set("phase", "lobby")
    if (stateMap.get("qIndex") === undefined) stateMap.set("qIndex", -1)

    const cur = answersMap.get(me.id) || { nickname: me.name, score: 0, lastAnswer: null, host: false, pending: null }
    answersMap.set(me.id, cur)

    awareness.setLocalStateField("user", { id: me.id, name: me.name })

    stateMap.observe(renderPhase)
    answersMap.observe(async () => {
      renderPeers(); renderPhase();
      if (isHost()) { try { await hostScoreNow(); } catch {} }
    })

    roomLabel.textContent = room
    show(lobby, true)
    renderPhase()
  } catch (e) {
    alert("입장 중 오류: " + e.message)
    console.error(e)
  }
}

beHostBtn.onclick = () => {
  const meObj = ensureMe()
  meObj.host = true
  answersMap.set(me.id, meObj)
  alert("호스트 권한을 가졌습니다.")
  renderPhase()
}

startGameBtn.onclick = async () => {
  if (!isHost()) return alert("호스트만 시작할 수 있습니다.")
  try {
    initHostWorker();
    const res = await workerCall("LEN", {}).catch(() => null)
    if (!res || !res.length) return alert("먼저 '퀴즈 로드'를 눌러 문제를 불러오세요.")
    setPhase("playing")
    setQIndex(0)
    await hostPushRound(0)
  } catch (e) {
    alert("시작 실패: " + e.message)
  }
}

loadFromUrlBtn.onclick = async () => {
  if (!isHost()) return alert("호스트만 로드할 수 있습니다.")
  try {
    const res = await hostLoadQuiz(QUIZ_URL)
    alert(`퀴즈 로드 완료: 총 \${res.total}개 중 사용 \${res.accepted}개 (필터링 \${res.filtered}개)`)
  } catch (e) {
    alert("로드 실패: " + e.message)
  }
}

nextQBtn.onclick = async () => {
  if (!isHost()) return alert("호스트만 넘길 수 있습니다.")
  try {
    await hostScoreNow();
    const next = getQIndex() + 1
    const lenInfo = await workerCall("LEN", {});
    if (next >= (lenInfo?.length || 0)) {
      setPhase("result")
    } else {
      setQIndex(next)
      await hostPushRound(next)
    }
  } catch (e) {
    alert("다음 문제로 이동 실패: " + e.message)
  }
}

endGameBtn.onclick = async () => {
  if (!isHost()) return alert("호스트만 종료할 수 있습니다.")
  try { await hostScoreNow(); } catch {}
  setPhase("result")
}

// 내 점수/답 표시 주기 업데이트
setInterval(() => {
  const my = answersMap?.get?.(me?.id)
  if (my){
    myAnsEl.textContent = (my.lastAnswer != null) ? (my.lastAnswer+1) : "-"
    myScoreEl.textContent = my.score ?? 0
  }
}, 400);
