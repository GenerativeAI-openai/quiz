// quizHost.worker.js (type: module)

const BANNED_KEYWORDS = [
  "코딩","프로그래밍","자바스크립트","javascript","타입스크립트","typescript",
  "파이썬","python","java","c언어","c++","c#","html","css","리액트","react","vue",
  "노드","node","변수","상수","함수","메서드","클래스","객체","알고리즘","자료구조",
  "컴파일","런타임","디버깅","배열","해시","스택","큐","그래프","정렬",
  "programming","coding","algorithm","data structure","compile","runtime","debug",
  "function","class","object","variable","const","method","array","hash","stack","queue","graph","sort"
];

let fullQuiz = [];

function hasBanned(text){
  if (!text) return false;
  const s = String(text).toLowerCase();
  return BANNED_KEYWORDS.some(k => s.includes(k.toLowerCase()));
}

function isBannedQuestion(item){
  if (!item || typeof item.q !== "string" || !Array.isArray(item.opts)) return true;
  if (hasBanned(item.q)) return true;
  for (const o of item.opts) if (hasBanned(o)) return true;
  return false;
}

async function loadQuiz(url){
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`로드 실패: ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("JSON 루트는 배열이어야 합니다.");

  const cleaned = [];
  for (const q of data){
    if (typeof q?.q !== "string" || !Array.isArray(q?.opts) || typeof q?.a !== "number"){
      continue;
    }
    if (isBannedQuestion(q)) continue;
    cleaned.push({ q: q.q, opts: q.opts.slice(), a: q.a, t: q.t });
  }
  fullQuiz = cleaned;
  return { total: data.length, accepted: cleaned.length, filtered: data.length - cleaned.length };
}

function getPublicQuestion(index){
  const q = fullQuiz[index];
  if (!q) return null;
  const { q: title, opts, t } = q;
  return { q: title, opts: opts.slice(), t };
}

function score(index, submissions){
  const q = fullQuiz[index];
  if (!q) return { scored: [] };
  const correctIndex = q.a;
  const scored = [];
  for (const s of submissions){
    scored.push({ id: s.id, correct: Number(s.ans) === Number(correctIndex) });
  }
  return { scored };
}

self.onmessage = async (ev) => {
  const { type, payload, reqId } = ev.data || {};
  try {
    if (type === "LOAD") {
      const result = await loadQuiz(payload.url);
      self.postMessage({ ok: true, type, reqId, data: result });
    } else if (type === "GET_Q") {
      const q = getPublicQuestion(payload.index);
      self.postMessage({ ok: true, type, reqId, data: q });
    } else if (type === "SCORE") {
      const result = score(payload.index, payload.submissions);
      self.postMessage({ ok: true, type, reqId, data: result });
    } else if (type === "LEN") {
      self.postMessage({ ok: true, type, reqId, data: { length: fullQuiz.length } });
    } else if (type === "REVEAL") {
      const q = fullQuiz[payload.index];
      self.postMessage({ ok: true, type, reqId, data: q ? { a: q.a } : null });
    } else {
      self.postMessage({ ok: false, type, reqId, error: "Unknown message type" });
    }
  } catch (e) {
    self.postMessage({ ok: false, type, reqId, error: String(e?.message || e) });
  }
};
