# Next-Token Prediction Demo

A small web demo for a screen-recorded teaching video (course demo **3.05a — Tokens and Next-Token Prediction**, setting up **3.10a — temperature / top-k / top-p**).

Type a prompt, see the model's true next-token probabilities (top 20), reshape them with temperature / top-k / top-p, and build text one token at a time. The OpenAI key stays server-side in two Netlify Functions and is never sent to the browser.

## Features

- **Prompt / Tokens tabs** — edit the prompt, or view it split into its exact tokens (`␣` = space, `⏎` = newline). The counter shows characters on the Prompt tab, tokens on the Tokens tab.
- **Live prediction** — no Predict button. Predicts on load and (debounced) as you type, always from `prompt + chosen tokens`. Editing the prompt keeps the chosen tokens.
- **Sampling meta-parameters** (collapsible) — Temperature (0–2), Top-k (1–20, default 5), Top-p (0.1–1.0). Sliders reshape the bars instantly, client-side. Excluded candidates are greyed.
- **Raw / Effective toggle** (default Raw) — sets which probability the bars and tooltips show:
  - **Raw** — temperature-reshaped over all candidates. Temperature changes the numbers; top-k/top-p only grey rows out.
  - **Effective** — after top-k/top-p too, renormalized over the kept rows (greyed = 0%).
  Greying is identical in both modes. **Next token always samples from Effective**; the toggle is display-only.
- **Build the text** — **Next token** samples one token (per temperature/top-k/top-p), or **click a candidate** to choose it yourself. Each commits and re-predicts.
- **Chosen-token breadcrumb** — gold = the model's top choice, magenta = a less-likely pick. Hover for its rank + probability. Each ✕ backs out to that point. This is the core teaching moment: higher temperature / wider top-k/top-p → more magenta.
- **End-of-text** — the model can predict `⟨end of text⟩`. Choosing it (or the model reaching it) finishes the sequence; Reset or ✕ to continue.
- **Reset** — restores the default prompt and defaults.

## Files

| File | What it is |
|------|------------|
| `index.html` | The page (markup + CSS). |
| `app.js` | Front-end: fetches candidates, reshapes/samples client-side, renders. |
| `netlify/functions/next-token.mjs` | Returns the top-20 next-token logprobs. Holds the API key. |
| `netlify/functions/tokenize.mjs` | Returns the prompt's exact token boundaries. |
| `netlify.toml` | Netlify config (no build step). |

## Run locally

Needs [Node.js](https://nodejs.org) and the Netlify CLI. This is all you need to record the video — nothing is exposed on the internet.

```bash
npm install -g netlify-cli
export OPENAI_API_KEY="sk-...your key..."
netlify dev              # serves the page + functions, usually on http://localhost:8888
```

`netlify dev` reads `OPENAI_API_KEY` from your shell (or a `.env` file at the repo root — git-ignored, never commit it). Open the URL and start typing.

## How it works

```
Browser → POST /.netlify/functions/next-token { prompt }
        → next-token.mjs  (OPENAI_API_KEY lives here)
        → OpenAI /v1/completions
```

The function hard-codes everything but the prompt, so the endpoint can only run this demo:

- `model: "gpt-3.5-turbo-instruct"` — a **completion** model (see below)
- `max_tokens: 1`, `logprobs: 20` (the completions cap), `temperature: 1.0`, prompt truncated to 500 chars

It returns only the top-20 `[{ token, logprob }, …]`, sorted high → low.

## Why a completion model, not a chat model

`gpt-3.5-turbo-instruct` **continues** your text: `The capital of France is` → ` Paris`. A chat model (`gpt-4o-mini`) would *answer* the prompt instead — its next token is `The` ("*The* capital of France is Paris") — which is the wrong story for next-token prediction.

## Why sampling is client-side

OpenAI's `logprobs` are the model's raw probabilities and **don't change with `temperature`/`top_p`** (verified: identical logprobs at temperature 0.1 vs 1.0). There's no `top_k` param at all. So the function fetches the true distribution once (at neutral temperature 1.0), and the demo does all reshaping in the browser — which is also the teaching point: fixed probabilities, and the knobs decide how you pick from them.

`app.js` → `shapeDistribution()`:

- **Temperature** — `softmax(logprob / T)`. `T → 0` = greedy; larger `T` flattens.
- **Top-k** — keep the `k` highest.
- **Top-p** — keep the smallest set whose cumulative probability reaches `p`.
- **`prob`** (Raw) = temperature-reshaped over all candidates. **`sampleProb`** (Effective) = `prob` renormalized over the kept rows; **Next token** samples from this and never picks a greyed row.

## Tokenizer (why it calls the API, and uses davinci-002)

The Tokens view shows the model's exact boundaries — and getting them exact is subtle:

- `gpt-3.5-turbo-instruct` does **not** use `cl100k_base` (contrary to most docs). It uses a p50k-like tokenizer, matching `davinci-002` exactly. Verified via `usage.prompt_tokens` on strings where the tokenizers disagree (e.g. `"Don't"` → `Don`|`'t`).
- No offline JS library is byte-exact for it (the model keeps `_case` as one token; p50k libraries split it).
- So `tokenize.mjs` asks **`davinci-002`** — same tokenizer, and it supports `echo` (the instruct model refuses `echo` + `logprobs`) — to echo the prompt split into tokens. Debounced ~400 ms.

Edge cases handled: 1-token prompts (retry with `max_tokens: 1`, drop the generated token) and multi-byte characters (echoed as raw `bytes:\xNN` → shown as a "raw bytes" chip).

## End-of-text

The model can predict `<|endoftext|>`. The API returns it two ways:

- **A candidate** (`finish_reason: "length"`) — near an ending it appears in the list with a real probability; choose it to finish.
- **A bare stop** (`finish_reason: "stop"`) — when the model is sure it's done, the API returns *empty* logprobs (no distribution). The function reports `{ finished: true }` (a 200, not an error).

Either way the demo commits `⟨end of text⟩` and stops. Reset or ✕ to continue. (We can't predict *past* it exactly — that needs the real token id, which OpenAI doesn't expose for this model and no offline tokenizer replicates.)

## Deploy to Netlify

Only needed if you want a live URL for students; recording just uses `netlify dev`. No build step — `netlify.toml` handles it.

**From Git:** push the repo, then in Netlify **Add new site → Import an existing project** and pick it (empty build command, publish dir `.`).

**From the CLI:**

```bash
netlify login
netlify init
netlify env:set OPENAI_API_KEY "sk-...your key..."
netlify deploy --prod
```

**Add the key** (either path): Netlify **Site configuration → Environment variables → Add** `OPENAI_API_KEY`, scope **Functions**, then redeploy. The functions read `process.env.OPENAI_API_KEY`; it never reaches the browser.

### Before going public

The function URLs are public — visitors can't see the key but can spend your credits. Set up both:

**1. OpenAI spend cap** (the real backstop — do this first).
platform.openai.com → **Settings → Organization → [Limits](https://platform.openai.com/settings/organization/limits)**. Set a low **monthly hard limit** (e.g. $5) — OpenAI stops serving requests at the cap. Put the demo's key in its own [project](https://platform.openai.com/settings/organization/projects) so the cap only affects the demo.

**2. Netlify rate limiting** (per-IP). Add a `config` export to each function (it can't go in `netlify.toml`):

```js
// max 30 requests/min per IP; 429 after that
export const config = {
  rateLimit: { windowSize: 60, windowLimit: 30, aggregateBy: ["ip"] },
};
```

`windowSize` is in seconds (max 180). Redeploy after adding it. See [Netlify rate limiting](https://docs.netlify.com/manage/security/secure-access-to-sites/rate-limiting/). Left out by default so local `netlify dev` stays unthrottled.
