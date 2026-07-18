// Next-token-prediction demo (course demo 3.05a / sets up 3.10a).
//
// Flow:
//   1. The Netlify function returns the model's TRUE top-5 next-token logprobs
//      for (prompt + committed tokens). These raw logprobs are what the model
//      actually assigns — OpenAI's API returns them unchanged by temperature
//      (temperature only affects sampling, not the reported logprobs), so all
//      reshaping is done here, client-side.
//   2. The sampling meta-parameters — temperature, top-k, top-p — reshape and
//      sample that base distribution CLIENT-SIDE, so dragging a slider updates
//      the on-screen bars instantly and the committed token is always sampled
//      from exactly the probabilities shown.
//   3. A token gets committed either by SAMPLING it ("Next token") or by the
//      user CLICKING a candidate word. Either way it's appended to the sequence
//      and the candidates are re-predicted for the new position — building the
//      text token by token. The breadcrumb's ✕ backs out to any point, which
//      also re-predicts. So the shown candidates always match (prompt +
//      committed tokens).

const DEFAULTS = { temp: 1.0, topk: 5, topp: 1.0 };
const DEFAULT_PROMPT = "The capital of France is"; // Reset restores this

const els = {
  prompt: document.getElementById("prompt"),
  counter: document.getElementById("counter"),
  tokenview: document.getElementById("tokenview"),
  tokenCount: document.getElementById("tokenCount"),
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
let committed = []; // [{ token, wasTop }] committed so far, in order
let baseCandidates = null; // [{ token, logprob }] for the CURRENT position, from the API
let busy = false;

// Token-view state (declared here so the on-load tokenizePrompt() call, which
// runs before the token-view section below, can access them — `let` bindings
// aren't hoisted like function declarations are).
let tokenizeTimer = null;
let tokenizeReqId = 0;
const TOKENIZE_DEBOUNCE_MS = 400;

// ---- meta-parameter controls (live client-side reshape, no server refetch) ----
//
// These params don't change the model's logprobs — OpenAI returns the same raw
// distribution regardless of temperature/top-p (they affect sampling, not the
// reported probabilities). So changing a slider only reshapes the fixed base
// distribution on-screen; it never re-hits the server. The reshaped result is
// exactly what "Next token" samples from, so the sliders directly control how
// the next token is chosen.

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

els.prompt.addEventListener("input", () => {
  updateCounter();
  scheduleTokenize();
});

els.predictBtn.addEventListener("click", () => startFresh());
els.nextBtn.addEventListener("click", () => commitNextToken());
els.resetBtn.addEventListener("click", () => reset());

updateCounter();
tokenizePrompt(); // show the token split for the pre-filled prompt on load

// ---- main actions ----

// Predict from the current prompt box. Keeps any tokens already chosen (Predict
// re-reads the prompt as the new seed but does NOT clear the breadcrumb), and
// fetches the candidates for the next position after (prompt + committed).
async function startFresh() {
  seed = els.prompt.value;
  await fetchCandidates();
}

// Sample one token per the meta-parameters, commit it, and fetch the next set.
async function commitNextToken() {
  if (busy || !baseCandidates) return;
  const shaped = shapeDistribution(baseCandidates, metaParams());
  const pick = sampleFrom(shaped);
  if (!pick) {
    setStatus("No candidate to sample — try adjusting the meta-parameters.", true);
    return;
  }
  await commitToken(pick.token);
}

// Commit a specific token the user picked by clicking it in the candidate list,
// then re-predict from the new sequence. (Same commit path as sampling, just
// with the token chosen explicitly instead of sampled.)
async function commitCandidate(token) {
  if (busy || !baseCandidates) return;
  await commitToken(token);
}

// Append `token` to the committed sequence and re-predict, so the candidate
// list always reflects (prompt + committed tokens). We record whether it was
// the model's top (most-probable) candidate at the moment it was chosen, so the
// breadcrumb can colour "took the obvious path" differently from "picked a
// less-likely token" (which is what temperature / top-k / top-p enable).
async function commitToken(token) {
  const wasTop = token === topCandidateToken();
  committed.push({ token, wasTop });
  renderCommitted();
  await fetchCandidates();
}

// The model's single most-probable next token (argmax of the base distribution),
// independent of the sampling meta-parameters. null if we haven't predicted yet.
function topCandidateToken() {
  if (!baseCandidates || baseCandidates.length === 0) return null;
  return baseCandidates.reduce((best, c) => (c.logprob > best.logprob ? c : best)).token;
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
  els.prompt.value = DEFAULT_PROMPT; // restore the default prompt, not blank
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
  tokenizePrompt(); // re-tokenize the restored default prompt
  setStatus("");
}

// Fetch the base top-5 candidates for the current position (seed + committed).
async function fetchCandidates() {
  const currentText = seed + committed.map((c) => c.token).join("");
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
        ? `${committed.length} token${committed.length === 1 ? "" : "s"} committed. Click a word or press “Next token” to keep going.`
        : "Here are the model's true next-token probabilities. Click a word to choose it, or press “Next token” to sample one."
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
    const clickable = !row.excluded; // excluded (top-k/top-p ruled out) can't be chosen
    const rowEl = document.createElement("div");
    rowEl.className =
      "bar-row" + (row.excluded ? " excluded" : "") + (clickable ? " clickable" : "");
    rowEl.innerHTML = `
      <div class="tok">${tokenHtml(row.token)}</div>
      <div class="track"><div class="fill" style="width:${widthPct.toFixed(1)}%"></div></div>
      <div class="pct ${row.excluded ? "excluded" : ""}">${(row.prob * 100).toFixed(1)}%</div>
    `;
    if (clickable) {
      rowEl.title = "Click to choose this token";
      rowEl.addEventListener("click", () => commitCandidate(row.token));
    }
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
  committed.forEach((c, i) => {
    const chip = document.createElement("span");
    // Colour by whether this was the model's most-probable token. A "non-top"
    // chip is the teaching moment: the model didn't take the obvious path.
    chip.className = "chip" + (c.wasTop ? " top" : " nontop");
    chip.title = c.wasTop
      ? "The model's most-probable token"
      : "NOT the most-probable token — a less-likely choice";
    chip.innerHTML = `<span>${tokenHtml(c.token)}</span><button class="x" title="Back out to here" aria-label="Remove this token and everything after it">✕</button>`;
    chip.querySelector(".x").addEventListener("click", () => backOutTo(i));
    els.committed.appendChild(chip);
  });
}

// ---- token view (how the typed prompt splits into tokens) ----
//
// Tokenization is done server-side via the tokenize function (davinci-002 echo,
// the exact tokenizer gpt-3.5-turbo-instruct uses), debounced so we don't hit
// the API on every keystroke. A monotonically increasing request id (declared
// with the other module state near the top) guards against out-of-order
// responses overwriting a newer one.

function scheduleTokenize() {
  if (tokenizeTimer) clearTimeout(tokenizeTimer);
  tokenizeTimer = setTimeout(tokenizePrompt, TOKENIZE_DEBOUNCE_MS);
}

async function tokenizePrompt() {
  const text = els.prompt.value;
  const reqId = ++tokenizeReqId;

  if (text.length === 0) {
    renderTokens([]);
    return;
  }

  try {
    const resp = await fetch("/.netlify/functions/tokenize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await resp.json();
    if (reqId !== tokenizeReqId) return; // a newer request superseded this one
    if (!resp.ok) throw new Error(data.error || `Tokenize failed (${resp.status})`);
    renderTokens(data.tokens || []);
  } catch (err) {
    if (reqId !== tokenizeReqId) return;
    els.tokenCount.textContent = "";
    els.tokenview.innerHTML = `<span class="tokenview-empty">Couldn't tokenize: ${escapeHtml(err.message)}</span>`;
  }
}

// Render the tokens as colored chips with visible whitespace. Colors cycle so
// adjacent tokens always differ, making the boundaries pop.
function renderTokens(tokens) {
  if (!tokens.length) {
    els.tokenCount.textContent = "";
    els.tokenview.innerHTML =
      '<span class="tokenview-empty">Type above to see how it splits into tokens.</span>';
    return;
  }
  els.tokenCount.textContent = `— ${tokens.length} token${tokens.length === 1 ? "" : "s"}`;
  els.tokenview.innerHTML = "";
  tokens.forEach((t, i) => {
    const span = document.createElement("span");
    if (t.bytes) {
      span.className = "tk bytes";
      span.title = "Part of a multi-byte character (raw bytes)";
      span.textContent = "▪";
    } else {
      span.className = `tk c${i % 5}`;
      span.title = JSON.stringify(t.text); // exact token text on hover
      span.innerHTML = tokenHtml(t.text);
    }
    els.tokenview.appendChild(span);
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
