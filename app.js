// Next-token-prediction demo (course demo 3.05a / sets up 3.10a).
//
// Flow:
//   1. The Netlify function returns the model's TRUE top-5 next-token
//      distribution (base logprobs, neutral temperature 1.0).
//   2. The sampling meta-parameters — temperature, top-k, top-p — reshape and
//      sample that base distribution ENTIRELY CLIENT-SIDE, so dragging a slider
//      updates the on-screen bars instantly and the committed token is always
//      sampled from exactly the probabilities shown. (Temperature is applied
//      once, here, to avoid double-counting it against the API.)
//   3. "Next token" samples one token per the meta-params, appends it to the
//      sequence, and re-fetches the candidates for the new position — building
//      the text token by token. The breadcrumb lets you back out to any point.

const DEFAULTS = { temp: 1.0, topk: 5, topp: 1.0 };

const els = {
  prompt: document.getElementById("prompt"),
  counter: document.getElementById("counter"),
  committed: document.getElementById("committed"),
  temp: document.getElementById("temp"),
  topk: document.getElementById("topk"),
  topp: document.getElementById("topp"),
  tempValue: document.getElementById("tempValue"),
  topkValue: document.getElementById("topkValue"),
  toppValue: document.getElementById("toppValue"),
  predictBtn: document.getElementById("predictBtn"),
  nextBtn: document.getElementById("nextBtn"),
  resetBtn: document.getElementById("resetBtn"),
  status: document.getElementById("status"),
  candHead: document.getElementById("candHead"),
  bars: document.getElementById("bars"),
};

// State
let seed = ""; // the prompt text at the time of the first Predict
let committed = []; // token strings the user has committed, in order
let baseCandidates = null; // [{ token, logprob }] for the CURRENT position, from the API
let busy = false;

// ---- meta-parameter controls (live reshape, no refetch) ----

els.temp.addEventListener("input", () => {
  els.tempValue.textContent = Number(els.temp.value).toFixed(2);
  rerenderCandidates();
});
els.topk.addEventListener("input", () => {
  els.topkValue.textContent = els.topk.value;
  rerenderCandidates();
});
els.topp.addEventListener("input", () => {
  els.toppValue.textContent = Number(els.topp.value).toFixed(2);
  rerenderCandidates();
});

els.prompt.addEventListener("input", updateCounter);

els.predictBtn.addEventListener("click", () => startFresh());
els.nextBtn.addEventListener("click", () => commitNextToken());
els.resetBtn.addEventListener("click", () => reset());

updateCounter();

// ---- main actions ----

// Predict from the current prompt box: begin a fresh sequence and fetch the
// candidates for the first next-token position.
async function startFresh() {
  seed = els.prompt.value;
  committed = [];
  renderCommitted();
  await fetchCandidates();
}

// Sample one token per the meta-parameters, commit it, and fetch the next set.
async function commitNextToken() {
  if (!baseCandidates) return;
  const shaped = shapeDistribution(baseCandidates, metaParams());
  const pick = sampleFrom(shaped);
  if (!pick) {
    setStatus("No candidate to sample — try adjusting the meta-parameters.", true);
    return;
  }
  committed.push(pick.token);
  renderCommitted();
  await fetchCandidates();
}

// Truncate the committed sequence back to `keep` tokens, then re-predict from
// that point. Called by a breadcrumb chip's ✕ (keep = index of that token).
async function backOutTo(keep) {
  if (busy) return;
  committed = committed.slice(0, keep);
  renderCommitted();
  await fetchCandidates();
}

function reset() {
  if (busy) return;
  seed = "";
  committed = [];
  baseCandidates = null;
  els.prompt.value = "";
  els.temp.value = DEFAULTS.temp;
  els.topk.value = DEFAULTS.topk;
  els.topp.value = DEFAULTS.topp;
  els.tempValue.textContent = DEFAULTS.temp.toFixed(2);
  els.topkValue.textContent = String(DEFAULTS.topk);
  els.toppValue.textContent = DEFAULTS.topp.toFixed(2);
  els.bars.innerHTML = "";
  els.candHead.style.display = "none";
  els.nextBtn.disabled = true;
  renderCommitted();
  updateCounter();
  setStatus("");
}

// Fetch the base top-5 candidates for the current position (seed + committed).
async function fetchCandidates() {
  const currentText = seed + committed.join("");
  if (!currentText.trim()) {
    setStatus("Type a prompt first.", true);
    return;
  }
  setBusy(true);
  setStatus("Asking the model…");
  try {
    const resp = await fetch("/.netlify/functions/next-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: currentText }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
    if (!Array.isArray(data.candidates) || data.candidates.length === 0) {
      throw new Error("No candidates were returned for this text.");
    }
    baseCandidates = data.candidates;
    rerenderCandidates();
    els.nextBtn.disabled = false;
    setStatus(
      committed.length
        ? `${committed.length} token${committed.length === 1 ? "" : "s"} committed. Adjust the sampling and press “Next token”.`
        : "Here are the model's true next-token probabilities. Reshape them with the sliders, then press “Next token”."
    );
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    setBusy(false);
  }
}

// ---- distribution math (all client-side) ----

function metaParams() {
  return {
    temperature: Number(els.temp.value),
    topk: Number(els.topk.value),
    topp: Number(els.topp.value),
  };
}

// Given the base [{token, logprob}] and the meta-params, produce a display list
// [{ token, prob, excluded }] where prob is the reshaped sampling probability
// (0 for excluded candidates) and excluded flags top-k / top-p cuts. The kept
// probabilities are renormalized to sum to 1.
function shapeDistribution(candidates, { temperature, topk, topp }) {
  // 1. Temperature via softmax on logprobs / T. As T -> 0 this becomes greedy
  //    (argmax); larger T flattens the distribution.
  const logits = candidates.map((c) => c.logprob);
  let weights;
  if (temperature <= 0.001) {
    // Greedy: all mass on the single highest-logprob token.
    const maxIdx = logits.indexOf(Math.max(...logits));
    weights = logits.map((_, i) => (i === maxIdx ? 1 : 0));
  } else {
    const scaled = logits.map((l) => l / temperature);
    const maxScaled = Math.max(...scaled);
    const exps = scaled.map((s) => Math.exp(s - maxScaled)); // stable softmax
    const sum = exps.reduce((a, b) => a + b, 0);
    weights = exps.map((e) => e / sum);
  }

  // Attach and sort high -> low.
  let rows = candidates.map((c, i) => ({ token: c.token, prob: weights[i], excluded: false }));
  rows.sort((a, b) => b.prob - a.prob);

  // 2. Top-k: keep only the k highest-probability candidates.
  rows.forEach((r, i) => {
    if (i >= topk) r.excluded = true;
  });

  // 3. Top-p (nucleus): among the still-included rows, keep the smallest prefix
  //    whose cumulative probability reaches p; exclude the rest.
  if (topp < 1.0) {
    let cum = 0;
    let reached = false;
    for (const r of rows) {
      if (r.excluded) continue;
      if (reached) {
        r.excluded = true;
        continue;
      }
      cum += r.prob;
      if (cum >= topp) reached = true; // this row is the one that crosses p; keep it
    }
  }

  // 4. Renormalize the kept probabilities so they sum to 1 (the actual sampling
  //    distribution). Guard against everything being excluded.
  const keptSum = rows.filter((r) => !r.excluded).reduce((a, r) => a + r.prob, 0);
  if (keptSum > 0) {
    rows.forEach((r) => {
      r.prob = r.excluded ? 0 : r.prob / keptSum;
    });
  }
  return rows;
}

// Sample one row from a shaped distribution (already renormalized over kept).
function sampleFrom(rows) {
  const kept = rows.filter((r) => !r.excluded && r.prob > 0);
  if (kept.length === 0) return null;
  const r = randomUnit();
  let cum = 0;
  for (const row of kept) {
    cum += row.prob;
    if (r <= cum) return row;
  }
  return kept[kept.length - 1]; // floating-point fallback
}

// A uniform random number in [0, 1). Isolated so the sampling source is obvious.
function randomUnit() {
  return Math.random();
}

// ---- rendering ----

function rerenderCandidates() {
  if (!baseCandidates) return;
  const rows = shapeDistribution(baseCandidates, metaParams());
  const maxProb = rows.reduce((m, r) => Math.max(m, r.prob), 0) || 1;

  els.candHead.style.display = "block";
  els.bars.innerHTML = "";
  for (const row of rows) {
    const widthPct = (row.prob / maxProb) * 100;
    const rowEl = document.createElement("div");
    rowEl.className = "bar-row" + (row.excluded ? " excluded" : "");
    rowEl.innerHTML = `
      <div class="tok">${tokenHtml(row.token)}</div>
      <div class="track"><div class="fill" style="width:${widthPct.toFixed(1)}%"></div></div>
      <div class="pct ${row.excluded ? "excluded" : ""}">${(row.prob * 100).toFixed(1)}%</div>
    `;
    els.bars.appendChild(rowEl);
  }
}

function renderCommitted() {
  if (committed.length === 0) {
    els.committed.innerHTML =
      '<span class="committed-empty">None yet — press Predict, then Next token.</span>';
    return;
  }
  els.committed.innerHTML = "";
  committed.forEach((tok, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `<span>${tokenHtml(tok)}</span><button class="x" title="Back out to here" aria-label="Remove this token and everything after it">✕</button>`;
    chip.querySelector(".x").addEventListener("click", () => backOutTo(i));
    els.committed.appendChild(chip);
  });
}

// ---- helpers ----

function updateCounter() {
  const n = els.prompt.value.length;
  els.counter.textContent = `${n} / 500`;
  els.counter.className = "counter" + (n >= 500 ? " limit" : "");
}

function setBusy(b) {
  busy = b;
  els.predictBtn.disabled = b;
  els.resetBtn.disabled = b;
  els.nextBtn.disabled = b || !baseCandidates;
}

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.className = "status" + (isError ? " error" : "");
}

// Render a token with visible whitespace so learners can see tokens often
// carry a leading space or a newline.
function tokenHtml(token) {
  return escapeHtml(token)
    .replace(/ /g, '<span class="ws">␣</span>')
    .replace(/\n/g, '<span class="ws">⏎</span>');
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
