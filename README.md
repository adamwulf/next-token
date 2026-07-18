# Next-Token Prediction Demo

A small web demo for a screen-recorded teaching video (course demo **3.05a — Tokens and Next-Token Prediction**, setting up **3.10a — temperature / top-k / top-p**).

You type a prompt and see the model's **true** top-5 next-token probabilities as a bar chart. Then the sampling **meta-parameters** — temperature, top-k, top-p — reshape that distribution live, and **Next token** samples one token from it, appends it, and predicts the next — building the text token by token. A breadcrumb of committed tokens lets you back out to any earlier point.

One HTML page + one JS file talking to a single Netlify Function. The OpenAI API key lives **only** on the server and is never sent to the browser.

## Features

- **Prompt box** with a live character counter and a hard 500-char limit (`maxlength` + `"123 / 500"`).
- **Predict** — fetch the model's true top-5 next-token candidates, sorted by probability, each with a bar (`exp(logprob)` as %).
- **Sampling meta-parameters** — Temperature (0–2), Top-k (1–5), Top-p (0.1–1.0). Dragging any slider reshapes the on-screen bars instantly (no extra API call). Candidates ruled out by top-k / top-p are greyed out.
- **Next token →** — samples one token *from the reshaped distribution* (not always the argmax), commits it, and re-predicts from the new position.
- **Committed-token breadcrumb** — the tokens chosen so far, each with a ✕ that truncates the sequence back to before that token and re-predicts from there.
- **Reset** — blanks the prompt, the committed tokens, and the meta-parameters back to defaults.

## Files

| File | What it is |
|------|------------|
| `index.html` | The page: prompt + counter, breadcrumb, meta-param sliders, buttons, bar chart. |
| `app.js` | Front-end logic: fetches candidates, reshapes/samples the distribution client-side, renders. |
| `netlify/functions/next-token.js` | Server function: holds the API key, returns only the base top-5 logprobs. |
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
Netlify Function (next-token.js)   ← OPENAI_API_KEY lives here, never sent to the browser
   │  calls OpenAI with model + logprobs + top_logprobs hard-coded, at neutral temperature 1.0
   ▼
OpenAI Chat Completions API
```

The function **hard-codes** everything except the prompt, so the endpoint can only ever run this demo:

- `model: "gpt-4o-mini"`
- `max_tokens: 1` (we only need the next single token's distribution)
- `logprobs: true`, `top_logprobs: 5` *(OpenAI caps `top_logprobs` at 5)*
- `temperature: 1.0` — **neutral**, on purpose (see below)
- prompt truncated to 500 chars

It returns **only** the top-5 candidates `[{ token, logprob }, …]`, not a raw passthrough.

## Design decision: sampling is client-side

The meta-parameters (temperature, top-k, top-p) are applied **entirely in the browser**, on top of the model's true base distribution. Two reasons:

1. **Avoid double-counting temperature.** If the API applied temperature *and* the browser reshaped again, temperature would be applied twice and the on-screen distribution would be wrong. So the function asks OpenAI at neutral **temperature 1.0** — its job is just "give me the real probabilities" — and all reshaping happens once, visibly, client-side.
2. **It's the whole teaching point.** Students see the model's *true* next-token probabilities, then watch temperature / top-k / top-p transform them and drive the actual token that gets picked — with no hidden step and no round-trip lag when a slider moves.

The math, in `app.js` → `shapeDistribution()`:

- **Temperature** — `softmax(logprob / T)`. As `T → 0` it becomes greedy (argmax); larger `T` flattens the distribution.
- **Top-k** — keep only the `k` highest-probability candidates.
- **Top-p (nucleus)** — keep the smallest set of candidates whose cumulative probability reaches `p`.
- The kept probabilities are **renormalized to sum to 1**, and **Next token** samples from exactly that distribution — so the token chosen is always consistent with the bars on screen.

*(Note: top-k here maxes at 5 because the display only ever has the API's top-5 candidates. That's plenty for the teaching demo.)*

## Deploying publicly (optional — TODO, deferred)

The local `netlify dev` workflow above is the recommended way to record the video — nothing is on the internet, so there's no abuse surface.

If this is ever deployed publicly so students can play with it, add these first:

1. **OpenAI spend cap** — set a low monthly usage limit on the project key. This is the real backstop; even if the public function URL is abused, damage is bounded.
2. **Per-IP rate limiting** — Netlify has built-in rate limiting you can put on the function so no single visitor can hammer it.

(Neither is implemented here, since the demo runs locally.)
