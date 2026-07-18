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
const EOT = "<|endoftext|>"; // the model's end-of-text (stop) token string
const EOT_LABEL = "⟨end of text⟩"; // how we display it

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
  metasHint: document.getElementById("metasHint"),
  nextBtn: document.getElementById("nextBtn"),
  resetBtn: document.getElementById("resetBtn"),
  status: document.getElementById("status"),
  candHead: document.getElementById("candHead"),
  bars: document.getElementById("bars"),
  tooltip: document.getElementById("tooltip"),
};

// State
let seed = ""; // the prompt text at the time of the first Predict
let committed = []; // [{ token, wasTop }] committed so far, in order
let baseCandidates = null; // [{ token, logprob }] for the CURRENT position, from the API
let finished = false; // true once end-of-text is reached — no more predictions
let busy = false;

// Debounce timers + request-id guards. Declared here (not next to their
// functions) so the on-load tokenizePrompt()/predictFromState() calls can access
// them — `let` bindings aren't hoisted like function declarations are.
let tokenizeTimer = null;
let tokenizeReqId = 0;
const TOKENIZE_DEBOUNCE_MS = 400;
let predictTimer = null;
let predictReqId = 0;
const PREDICT_DEBOUNCE_MS = 400;

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
  updateMetasHint();
  rerenderCandidates();
});
els.topk.addEventListener("input", () => {
  els.topkValue.textContent = els.topk.value;
  updateMetasHint();
  rerenderCandidates();
});
els.topp.addEventListener("input", () => {
  els.toppValue.textContent = Number(els.topp.value).toFixed(2);
  updateMetasHint();
  rerenderCandidates();
});

// Compact summary of the current sampling settings, shown next to the section
// title when the meta-parameters are collapsed.
function updateMetasHint() {
  els.metasHint.textContent =
    `temp ${Number(els.temp.value).toFixed(2)} · top-k ${els.topk.value} · top-p ${Number(els.topp.value).toFixed(2)}`;
}
updateMetasHint();

// Typing in the prompt box updates the counter and, after a short debounce,
// re-tokenizes AND re-predicts from the current state (prompt + committed
// tokens). There is no Predict button — the demo always reflects the live UI.
// Editing the text does NOT clear the chosen tokens; the user does that with ✕.
els.prompt.addEventListener("input", () => {
  updateCounter();
  scheduleTokenize();
  schedulePredict();
});

els.nextBtn.addEventListener("click", () => commitNextToken());
els.resetBtn.addEventListener("click", () => reset());

updateCounter();
tokenizePrompt(); // show the token split for the pre-filled prompt on load
predictFromState(); // and predict its next token right away

// ---- main actions ----

// Debounced re-predict, called as the user types in the prompt box.
function schedulePredict() {
  if (predictTimer) clearTimeout(predictTimer);
  predictTimer = setTimeout(predictFromState, PREDICT_DEBOUNCE_MS);
}

// Predict the next token from the current UI state: the prompt box text plus the
// tokens chosen so far. Does NOT clear the chosen tokens when the text changes —
// the user manages those with ✕ / Reset. If the sequence had finished, editing
// the text resumes prediction (drop the trailing end-of-text token first).
async function predictFromState() {
  seed = els.prompt.value;
  if (finished) {
    finished = false;
    if (committed.length && committed[committed.length - 1].eot) committed.pop();
    renderCommitted();
  }
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
  const stats = tokenStats(token); // { rank, prob, wasTop } from the base distribution

  // If the chosen token is end-of-text, the sequence is complete: commit it as
  // the stop token and finish, rather than trying to predict past it.
  if (token === EOT) {
    finish(
      stats,
      `You chose <strong>${EOT_LABEL}</strong> — the end-of-text token. That completes the text, so prediction stops here. Press <strong>Reset</strong> to start over.`,
      "Finished — end-of-text was chosen."
    );
    return;
  }

  committed.push({ token, ...stats });
  renderCommitted();
  await fetchCandidates();
}

// Where `token` fell in the candidate list at the moment it was chosen: its
// 1-based rank, the number of candidates, and its DISPLAYED probability (`prob`
// — the raw, temperature-shaped value shown on the bar, NOT the renormalized
// sampleProb). Used for the breadcrumb colour and the per-chip hover tooltip, so
// the tooltip matches exactly what the bar showed.
function tokenStats(token) {
  if (!baseCandidates || baseCandidates.length === 0) return { rank: null, of: null, prob: null, wasTop: false };
  const rows = shapeDistribution(baseCandidates, metaParams()); // sorted high -> low, prob = displayed
  const idx = rows.findIndex((r) => r.token === token);
  if (idx === -1) return { rank: null, of: rows.length, prob: null, wasTop: false };
  return { rank: idx + 1, of: rows.length, prob: rows[idx].prob, wasTop: idx === 0 };
}

// Truncate the committed sequence back to `keep` tokens, then re-predict from
// that point. Called by a breadcrumb chip's ✕ (keep = index of that token).
// Backing out clears the finished state — removing the end-of-text token (or
// anything before it) means we're no longer at the end and predict again.
async function backOutTo(keep) {
  if (busy) return;
  committed = committed.slice(0, keep);
  finished = false;
  renderCommitted();
  await fetchCandidates();
}

function reset() {
  if (busy) return;
  if (predictTimer) clearTimeout(predictTimer); // drop any pending keystroke predict
  seed = "";
  committed = [];
  baseCandidates = null;
  finished = false;
  els.prompt.value = DEFAULT_PROMPT; // restore the default prompt, not blank
  els.temp.value = DEFAULTS.temp;
  els.topk.value = DEFAULTS.topk;
  els.topp.value = DEFAULTS.topp;
  els.tempValue.textContent = DEFAULTS.temp.toFixed(2);
  els.topkValue.textContent = String(DEFAULTS.topk);
  els.toppValue.textContent = DEFAULTS.topp.toFixed(2);
  updateMetasHint();
  els.bars.innerHTML = "";
  els.candHead.style.display = "none";
  els.nextBtn.disabled = true;
  renderCommitted();
  updateCounter();
  tokenizePrompt(); // re-tokenize the restored default prompt
  predictFromState(); // and predict its next token
  setStatus("");
}

// Fetch the base top-5 candidates for the current position (seed + committed).
// The predictReqId guard (declared with the module state up top) rejects
// out-of-order responses: since prediction now fires on every (debounced)
// keystroke, a slow earlier request must not overwrite a newer one's result.
async function fetchCandidates() {
  const reqId = ++predictReqId;
  const currentText = seed + committed.map((c) => c.token).join("");
  if (!currentText.trim()) {
    // Empty input — nothing to predict. Clear quietly (this fires on every
    // keystroke, so an empty box is a normal state, not an error).
    baseCandidates = null;
    els.bars.innerHTML = "";
    els.candHead.style.display = "none";
    els.nextBtn.disabled = true;
    setStatus("Type a prompt to see the model's next-token prediction.");
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
    if (reqId !== predictReqId) return; // a newer prediction superseded this one
    if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);

    // The model decided the text is complete: it predicted end-of-text and the
    // API returned no distribution. Enter the finished state — show the stop
    // token and stop predicting.
    if (data.finished || !Array.isArray(data.candidates) || data.candidates.length === 0) {
      // The API returns no distribution at a hard stop, so we have no probability
      // for end-of-text — but the model chose it, so it's effectively rank 1.
      finish(
        { wasTop: true, rank: 1, prob: null },
        `The model predicted <strong>${EOT_LABEL}</strong> — it considers the text complete, so prediction stops here. Press <strong>Reset</strong> to start over.`,
        "Finished — the model reached the end of the text."
      );
      return;
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
    if (reqId === predictReqId) setStatus(err.message, true);
  } finally {
    if (reqId === predictReqId) setBusy(false);
  }
}

// Reach end-of-text: append the stop token to the breadcrumb, show a "finished"
// note where the candidates were, and prevent further prediction. This is the
// teaching moment — the model itself decided the text is done. `chip` carries
// per-token fields (e.g. wasTop); `noteHtml` and `status` describe the finish.
function finish(chip, noteHtml, status) {
  finished = true;
  committed.push({ token: EOT, eot: true, ...chip });
  baseCandidates = null;
  renderCommitted();
  els.candHead.style.display = "none";
  els.bars.innerHTML = `<div class="finished-note">${noteHtml}</div>`;
  els.nextBtn.disabled = true;
  setStatus(status);
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

  // Attach and sort high -> low. `prob` is the DISPLAYED probability — the
  // temperature-reshaped weight over ALL candidates (it always sums to 1 across
  // the full list, and is NOT renormalized when top-k/top-p exclude rows). So
  // every row always shows its true (temperature-adjusted) probability; the
  // top-k/top-p cuts only FADE rows, they don't change the numbers shown.
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

  // 4. Separately compute the SAMPLING probability: renormalize the kept rows so
  //    they sum to 1. This is what "Next token" samples from — it never picks an
  //    excluded row — but it does NOT affect the `prob` shown on screen.
  const keptSum = rows.filter((r) => !r.excluded).reduce((a, r) => a + r.prob, 0);
  rows.forEach((r) => {
    r.sampleProb = r.excluded || keptSum <= 0 ? 0 : r.prob / keptSum;
  });
  return rows;
}

// Sample one row from a shaped distribution, using each row's sampleProb
// (renormalized over the kept, non-excluded rows).
function sampleFrom(rows) {
  const kept = rows.filter((r) => !r.excluded && r.sampleProb > 0);
  if (kept.length === 0) return null;
  const r = randomUnit();
  let cum = 0;
  for (const row of kept) {
    cum += row.sampleProb;
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
      '<span class="committed-empty">None yet — pick a candidate or press Next token.</span>';
    return;
  }
  els.committed.innerHTML = "";
  committed.forEach((c, i) => {
    const chip = document.createElement("span");
    // The end-of-text token gets its own "stop" style; otherwise colour by
    // whether this was the model's most-probable token (a "non-top" chip is the
    // teaching moment: the model didn't take the obvious path).
    chip.className = "chip" + (c.eot ? " eot" : c.wasTop ? " top" : " nontop");
    chip.innerHTML = `<span>${tokenHtml(c.token)}</span><button class="x" title="Back out to here" aria-label="Remove this token and everything after it">✕</button>`;
    chip.querySelector(".x").addEventListener("click", () => {
      hideTooltip(); // the chip is about to be removed — dismiss its tooltip
      backOutTo(i);
    });
    // Rich, instant hover tooltip: rank + true (displayed) probability.
    chip.addEventListener("mouseenter", () => showTooltip(chip, c));
    chip.addEventListener("mousemove", () => positionTooltip(chip));
    chip.addEventListener("mouseleave", hideTooltip);
    els.committed.appendChild(chip);
  });
}

// ---- rich hover tooltip for chosen tokens (instant, no native-title delay) ----

function tooltipHtml(c) {
  const kind = c.eot ? "eot" : c.wasTop ? "top" : "nontop";
  const rankLine = c.rank == null
    ? ""
    : c.wasTop
    ? `<div class="tt-rank">Rank 1 — the model's top choice</div>`
    : `<div class="tt-rank">Rank ${c.rank}${c.of ? ` of ${c.of}` : ""} — a less-likely choice</div>`;
  const probLine = c.prob == null
    ? ""
    : `<div><span class="tt-prob ${kind}">${(c.prob * 100).toFixed(2)}%</span> probability</div>`;
  const eotLine = c.eot ? `<div class="tt-rank">end-of-text — the model completed the text here</div>` : "";
  return `<div class="tt-token">${tokenHtml(c.token)}</div>${rankLine}${probLine}${eotLine}`;
}

function showTooltip(chip, c) {
  els.tooltip.innerHTML = tooltipHtml(c);
  els.tooltip.classList.add("show");
  positionTooltip(chip);
}

// Place the tooltip just above the chip, clamped to the viewport.
function positionTooltip(chip) {
  const r = chip.getBoundingClientRect();
  const tt = els.tooltip;
  const ttRect = tt.getBoundingClientRect();
  let left = r.left + r.width / 2 - ttRect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - ttRect.width - 8));
  let top = r.top - ttRect.height - 8;
  if (top < 8) top = r.bottom + 8; // flip below if no room above
  tt.style.left = `${left}px`;
  tt.style.top = `${top}px`;
}

function hideTooltip() {
  els.tooltip.classList.remove("show");
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
  els.resetBtn.disabled = b;
  els.nextBtn.disabled = b || !baseCandidates || finished;
}

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.className = "status" + (isError ? " error" : "");
}

// Render a token with visible whitespace so learners can see tokens often
// carry a leading space or a newline. The end-of-text token gets a clear label
// instead of its raw "<|endoftext|>" string.
function tokenHtml(token) {
  if (token === EOT) return `<span class="eot">${EOT_LABEL}</span>`;
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
