// quizHost.worker.js  (type: module)

// 코딩/프로그래밍 관련 금지 키워드 (대소문자 무시)
const BANNED_KEYWORDS = [
  // 한글
  "코딩","프로그래밍","자바스크립트","javascript","타입스크립트","typescript",
  "파이썬","python","java","c언어","c++","c#","html","css","리액트","react","vue",
  "노드","node","변수","상수","함수","메서드","클래스","객체","알고리즘","자료구조",
  "컴파일","런타임","디버깅","배열","해시","스택","큐","그래프","정렬",
  // 영문
  "programming","coding","algorithm","data structure","compile","runtime","debug",
  "function","class","object","variable","const","method","array","hash","stack","queue","graph","sort"
];

let fullQuiz = []; // [{ q, opts, a, t? }, ...]

// 금지어 검사
function hasBanned(text) {
  if (!text) return false;
  const s = String(text).toLowerCase();
  return BANNED_KEYWORDS.some(k => s.includes(k.toLowerCase()));
}

function isBannedQuestion(item) {
  if (!item || typeof item.q !== "string" || !Array.isArray(item.opts)) return true; // 형식 불량도 배제
  if (hasBanned(item.q)) return true;
  for (const o of item.opts) {
    if (hasBanned(o)) return true;
  }
  return false;
}

// 퀴즈 로드 (호스트 전용) — 전체 세트/정답은 워커 내부에만 저장
async function loadQuiz(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`로드 실패: ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("JSON 루트는 배열이어야 합니다.");

  const cleaned = [];
  for (const q of data) {
    if (typeof q?.q !== "string" || !Array.isArray(q?.opts) || typeof q?.a !== "number") {
      continue; // 형식 불량 스킵
    }
    if (isBannedQuestion(q)) continue; // 코딩 관련/금지어 스킵
    cleaned.push({ q: q.q, opts: q.opts.slice(), a: q.a, t: q.t });
  }
  fullQuiz = cleaned;
  return { total: data.length, accepted: cleaned.length, filtered: data.length - cleaned.length };
}

// 공개용 현재 문제 반환(정답 제외)
function getPublicQuestion(index) {
  const q = fullQuiz[index];
  if (!q) return null;
  const { q: title, opts, t } = q;
  return { q: title, opts: opts.slice(), t };
}

// 채점 (호스트 전용): submissions = [{ id, ans }]
function score(index, submissions) {
  const q = fullQuiz[index];
  if (!q) return { scored: [] };
  const correctIndex = q.a;
  const scored = [];
  for (const s of submissions) {
    scored.push({ id: s.id, correct: Number(s.ans) === Number(correctIndex) });
  }
  return { scored };
}

// (선택) 정답 공개용
function reveal(index) {
  const q = fullQuiz[index];
  return q ? { a: q.a } : null;
}

// 메시지 핸들러 (호스트 UI에서만 호출)
self.onmessage = async (ev) => {
  const { type, payload, reqId } = ev.data || {};
  try {
    let data = null;
    if (type === "LOAD") {
      data = await loadQuiz(payload.url);
    } else if (type === "GET_Q") {
      data = getPublicQuestion(payload.index);
    } else if (type === "SCORE") {
      data = score(payload.index, payload.submissions);
    } else if (type === "LEN") {
      data = { length: fullQuiz.length };
    } else if (type === "REVEAL") {
      data = reveal(payload.index);
    } else {
      throw new Error("Unknown message type");
    }
    self.postMessage({ ok: true, type, reqId, data });
  } catch (e) {
    self.postMessage({ ok: false, type, reqId, error: String(e?.message || e) });
  }
};
