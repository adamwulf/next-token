# Next-Token Prediction Demo

A small web demo for a screen-recorded teaching video (course demo **3.05a — Tokens and Next-Token Prediction**, setting up **3.10a — temperature / top-k / top-p**).

You type a prompt and see the model's **true** top next-token probabilities (up to 20 candidates) as a bar chart. Then the sampling **meta-parameters** — temperature, top-k, top-p — reshape that distribution live, and **Next token** samples one token from it, appends it, and predicts the next — building the text token by token. A breadcrumb of committed tokens lets you back out to any earlier point.

One HTML page + one JS file talking to a single Netlify Function. The OpenAI API key lives **only** on the server and is never sent to the browser.

## Features

- **Prompt box** with a live character counter and a hard 500-char limit (`maxlength` + `"123 / 500"`).
- **Your text as tokens** — as you type, the prompt is split into its exact tokens and shown as color-coded chips (leading spaces and newlines drawn as `␣` / `⏎`). This is the model's *real* tokenization, fetched server-side and debounced (see "Tokenizer" below).
- **Live prediction (no Predict button)** — the demo always predicts from the current UI state: the prompt box text **plus** the tokens chosen so far. It predicts on load and re-predicts (debounced) as you type. Editing the prompt does **not** clear the chosen tokens — you manage those with ✕ / Reset.
- **Sampling meta-parameters** (collapsible) — Temperature (0–2), Top-k (1–20, default 5), Top-p (0.1–1.0). Collapse the section to save space; a compact `temp · top-k · top-p` summary shows next to the title while collapsed. Dragging any slider reshapes the on-screen bars instantly, **client-side, with no server call** (the model's probabilities don't depend on these params — see below). Candidates ruled out by top-k / top-p are greyed out. Whatever the bars show is exactly what **Next token** samples from.
- **Next token →** — samples one token *from the reshaped distribution* (per the current temperature / top-k / top-p, so not always the argmax), commits it, and re-predicts from the new position.
- **Click a candidate** — instead of sampling, click any (non-excluded) candidate word to choose *that* token yourself. It's committed and the demo re-predicts from the new text.
- **Committed-token breadcrumb** — the tokens chosen so far, each with a ✕ that truncates the sequence back to before that token and re-predicts from there. Each chip is **gold if it was the model's most-probable token** and **magenta if it was a less-likely pick** — the core teaching moment: at higher temperature / wider top-k / top-p the model stops taking the obvious path, and the magenta chips show exactly when.
- **End-of-text / finished state** — the model can predict the special `⟨end of text⟩` token, meaning "the text is complete." It shows up two ways: as one of the candidates (you can choose it), and — when the model is sure the text is done — as *the* prediction. Either way the demo commits the stop token to the breadcrumb, shows a "finished" note, and stops predicting (press Reset or ✕ to continue). See "End-of-text" below.
- **Reset** clears the committed tokens, resets the meta-parameters, and **restores the default prompt** (`"The capital of France is"`) into the box, then re-predicts.

Every action that changes the **text** (typing in the box, choosing/sampling a token, removing one with ✕) re-predicts against `prompt + committed tokens`, so the candidate list is always the model's real distribution for the current sequence. Changing the **sampling** sliders does *not* re-predict — it only reshapes/filters the fixed distribution the model already returned.

## Files

| File | What it is |
|------|------------|
| `index.html` | The page: prompt + counter, breadcrumb, meta-param sliders, buttons, bar chart. |
| `app.js` | Front-end logic: fetches candidates, reshapes/samples the distribution client-side, renders bars + the token view. |
| `netlify/functions/next-token.mjs` | Server function: holds the API key, returns only the base top-20 logprobs. |
| `netlify/functions/tokenize.mjs` | Server function: returns the prompt's exact token boundaries (davinci-002 echo). |
| `netlify.toml` | Netlify config (no build step). |

## Setup

You need [Node.js](https://nodejs.org) and the Netlify CLI. **Deployment is deferred** — the demo is designed to run locally with `netlify dev` while you screen-record, which has zero public-abuse surface.

```bash
# 1. Install the Netlify CLI (once, globally)
npm install -g netlify-cli

# 2. Set your OpenAI API key for this shell session
export OPENAI_API_KEY="sk-...your key..."

# 3. Run it — serves the page + function together on http://localhost:8888
netlify dev
```

Then open the URL Netlify prints (usually **http://localhost:8888**), type a prompt, and press **Predict**.

> `netlify dev` picks up `OPENAI_API_KEY` from your shell environment. If you prefer, put it in a `.env` file at the repo root (`OPENAI_API_KEY=sk-...`) — `netlify dev` loads that automatically. **Do not commit your key** (`.env` is git-ignored).

## How it works

```
Browser (index.html + app.js)
   │  POST /.netlify/functions/next-token  { prompt }
   ▼
Netlify Function (next-token.mjs)  ← OPENAI_API_KEY lives here, never sent to the browser
   │  calls OpenAI with model + logprobs hard-coded, at neutral temperature 1.0
   ▼
OpenAI Completions API  (/v1/completions)
```

The function **hard-codes** everything except the prompt, so the endpoint can only ever run this demo:

- `model: "gpt-3.5-turbo-instruct"` — a **text-completion** model (see below)
- `max_tokens: 1` (we only need the next single token's distribution)
- `logprobs: 20` — the completions API returns the top-N exact alternatives per token (`logprobs` is an integer count here; the endpoint silently caps it at **20**)
- `temperature: 1.0` — **neutral**, on purpose (see below)
- prompt truncated to 500 chars

It returns **only** the top-20 candidates `[{ token, logprob }, …]`, sorted high → low, not a raw passthrough. (The completions API gives `top_logprobs` as a `{ token: logprob }` object; the function normalizes it to this array so the front-end stays simple.)

## Design decision: a completion model, not a chat model

This is a **completions** demo — it uses the `/v1/completions` endpoint with `gpt-3.5-turbo-instruct`, a text-completion model that **continues** your text. So `The capital of France is` → ` Paris` (~81%), the intuitive next token.

A **chat** model (`gpt-4o-mini`, `gpt-4o` via `/v1/chat/completions`) would instead treat the prompt as a *question to answer* and begin composing a reply — for `The capital of France is` its literal next token is `The` (as in "*The* capital of France is Paris"), which is correct chat behavior but the wrong story for a next-token-prediction demo. Completion models are the right tool here.

*(Other completion-endpoint models if you want to experiment: `davinci-002` / `babbage-002` are raw base models — their distributions are flatter and less confident, e.g. ` Paris` at ~32% with more spread in the tail, which can make the temperature / top-k / top-p reshaping more visually dramatic. Swap `MODEL` in `next-token.mjs` to try them.)*

## Design decision: sampling is client-side

The meta-parameters (temperature, top-k, top-p) are applied **entirely in the browser**, on top of the model's true base distribution. Two reasons:

1. **The API can't do it.** OpenAI's `logprobs` are the model's *raw* next-token probabilities and **do not change with `temperature` / `top_p`** — those parameters only affect which token gets *sampled/generated*, not the reported distribution. (Verified: calling the completions API for the same prompt at `temperature` 0.1 vs 1.0 returns byte-identical logprobs.) So the function asks OpenAI at neutral **temperature 1.0** purely to get "the real probabilities," and every reshaping the demo shows *has* to happen client-side. There's also no `top_k` parameter on OpenAI's API at all — it's inherently a client-side selection filter.
2. **It's the whole teaching point.** Students see the model's *true, fixed* next-token probabilities, then watch temperature / top-k / top-p transform how those probabilities are turned into a choice — with no hidden step and no round-trip lag when a slider moves. The accurate mental model is "the model gives fixed probabilities; the sampling knobs decide how we pick from them," and doing the reshaping visibly in the browser teaches exactly that.

The math, in `app.js` → `shapeDistribution()`:

- **Temperature** — `softmax(logprob / T)`. As `T → 0` it becomes greedy (argmax); larger `T` flattens the distribution.
- **Top-k** — keep only the `k` highest-probability candidates.
- **Top-p (nucleus)** — keep the smallest set of candidates whose cumulative probability reaches `p`.
- **What the bars show vs. what's sampled.** The bars always show each candidate's **raw, true** probability — the temperature-reshaped softmax over **all** candidates (it sums to 1 across the whole list and is *not* renormalized when top-k/top-p exclude rows). So an excluded candidate still shows its real probability; it's just **faded** to signal it was pulled out of sampling. Internally, **Next token** samples from the kept rows renormalized to 1 (`sampleProb`) — it never picks a faded row — but that renormalization never changes the numbers on screen.

*(Note: top-k maxes at 20 because the completions endpoint returns at most 20 exact candidates. The slider defaults to 5.)*

## Tokenizer: why the token view calls the API (and uses davinci-002)

The "your text as tokens" view shows the model's **exact** token boundaries. Getting that exactly right is trickier than it looks:

- **`gpt-3.5-turbo-instruct` does *not* use `cl100k_base`** — despite what most "GPT-3.5 uses cl100k_base" references say. That's true of the *chat* model (`gpt-3.5-turbo`), but the `-instruct` variant inherits the older **p50k-style** tokenizer from the davinci base models it descends from. Verified by comparing the API's own `usage.prompt_tokens` against the tokenizer libraries on strings where they disagree — e.g. `"Don't"` is one token in `cl100k_base` but splits `Don`|`'t` here; `gpt-3.5-turbo-instruct` matched `davinci-002` exactly (6/6) and `cl100k_base` on only 2/6.
- **No offline JS tokenizer library is byte-exact for it.** Even the p50k/r50k libraries (and OpenAI's own [tokenizer page](https://platform.openai.com/tokenizer), which uses them) diverge on some tokens — e.g. `"CamelCase"` → the model splits `Cam`|`el` and keeps `_case` as one token, while the p50k library gives `C`|`amel` and `_`|`case`.
- **So the only exact source is the OpenAI API itself.** `davinci-002` shares `gpt-3.5-turbo-instruct`'s exact tokenizer *and* supports `echo: true` (the instruct model refuses `echo` + `logprobs` together), so `tokenize.mjs` asks `davinci-002` to echo the prompt back split into its tokens (`choices[0].logprobs.tokens`). The front-end debounces this (~400 ms) so it isn't called on every keystroke.

Edge cases the function handles: a 1-token prompt (the API needs ≥2 tokens for `max_tokens: 0`, so it retries with `max_tokens: 1` and drops the generated token) and multi-byte characters (emoji, CJK), which `echo` returns as raw `bytes:\xNN` fragments — the UI shows those as a hatched "raw bytes" chip rather than garbled text.

## End-of-text (the "finished" state)

The model can predict `<|endoftext|>` — the special token that means "this text is complete." The demo surfaces it as a first-class token in the token-by-token flow, but the OpenAI API exposes it in two different shapes:

- **As one of the candidates** (`finish_reason: "length"`): near a natural ending, `<|endoftext|>` shows up in `top_logprobs` with a real probability (e.g. `"The capital of France is Paris."` → `<|endoftext|>` ~84%). It renders as a clear `⟨end of text⟩` chip; choose it and the demo finishes.
- **As a bare stop** (`finish_reason: "stop"`): when the model is certain the text is done, the API **halts before emitting this position's logprobs** and returns *empty* arrays — no distribution at all, not even the stop token's own probability. (It's odd that the API doesn't just return a list with `<|endoftext|>` on top, but that's the behavior, and `logit_bias` can't override it for `gpt-3.5-turbo-instruct`.) The function reports this as `{ finished: true }` (a 200, **not** an error), and the UI interprets it as "the model reached the end of the text."

In both cases the demo commits the `⟨end of text⟩` token to the breadcrumb and stops predicting — a teaching beat showing that *the model itself* decides when the text is done. Press **Reset**, or ✕ the stop token, to continue.

(We can't "predict past" the stop token exactly: doing so requires appending the real end-of-text **token id**, but OpenAI never exposes token ids for this model and no offline tokenizer matches its vocabulary exactly — so we treat end-of-text as a terminal state rather than guessing ids.)

## Deploying publicly (optional — TODO, deferred)

The local `netlify dev` workflow above is the recommended way to record the video — nothing is on the internet, so there's no abuse surface.

If this is ever deployed publicly so students can play with it, add these first:

1. **OpenAI spend cap** — set a low monthly usage limit on the project key. This is the real backstop; even if the public function URL is abused, damage is bounded.
2. **Per-IP rate limiting** — Netlify has built-in rate limiting you can put on the function so no single visitor can hammer it.

(Neither is implemented here, since the demo runs locally.)
