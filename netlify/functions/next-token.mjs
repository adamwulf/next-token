// Netlify Function: next-token
//
// Server-side proxy for the next-token-prediction demo (course demo 3.05a).
// The OpenAI API key lives ONLY here as an environment variable and is never
// sent to the browser. The browser calls /.netlify/functions/next-token with
// just { prompt }; everything else about the request is hard-coded so this
// endpoint can only run the demo — it can't be abused as a general proxy.
//
// This is a COMPLETIONS demo, not a chat demo. It uses the /v1/completions
// endpoint with a text-completion model (gpt-3.5-turbo-instruct), which
// CONTINUES the prompt text. So "The capital of France is" -> " Paris" (the
// intuitive next token), rather than a chat model, which would treat the
// prompt as a question to answer and start its reply with "The".
//
// It returns the model's NATURAL top-5 distribution for the next token
// (temperature 1.0 at the API). The demo's sampling meta-parameters
// (temperature / top-k / top-p) are applied CLIENT-SIDE to reshape that
// distribution and pick the committed token — so dragging the sliders updates
// the on-screen bars instantly, with no extra API call, and the selection is
// always consistent with the probabilities shown. See README.
//
// Netlify per-IP rate limiting is enabled below (see the `config` export). For
// a public deploy, also set an OpenAI project spend cap as the real cost
// backstop. Neither affects the local `netlify dev` recording workflow — the
// rate limit is only enforced on deployed Netlify.

const OPENAI_URL = "https://api.openai.com/v1/completions";

// Hard-coded so the caller can never change them:
const MODEL = "gpt-3.5-turbo-instruct"; // a text-COMPLETION model, not a chat model
const MAX_TOKENS = 1; // we only need the next single token's distribution
const LOGPROBS = 20; // completions API returns the top-N exact candidates; it caps at 20
const MAX_PROMPT_CHARS = 500; // truncate the prompt to bound cost/abuse

// Netlify per-IP rate limiting (declared here, not in netlify.toml). ~1 req/sec:
// 60 requests per 60-second sliding window per IP; the next request gets a 429.
// windowSize is in seconds (max 180). Enforced on deployed Netlify only.
export const config = {
  rateLimit: { windowSize: 60, windowLimit: 60, aggregateBy: ["ip"] },
};

export default async (req) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed. Use POST." }, 405);
  }

  if (!process.env.OPENAI_API_KEY) {
    return json(
      { error: "Server is missing OPENAI_API_KEY. See README for setup." },
      500
    );
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }

  const prompt = String(payload?.prompt ?? "").slice(0, MAX_PROMPT_CHARS);
  if (!prompt.trim()) {
    return json({ error: "Please provide a non-empty prompt." }, 400);
  }

  // Hard-code everything except the prompt. We ask for exactly one token's worth
  // of candidates; the client does the sampling from these top-5.
  const body = {
    model: MODEL,
    prompt, // completions API: continue this text
    max_tokens: MAX_TOKENS,
    logprobs: LOGPROBS,
    temperature: 1.0, // natural distribution; the demo reshapes it client-side
  };

  let openaiResp;
  try {
    openaiResp = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return json({ error: "Could not reach OpenAI: " + err.message }, 502);
  }

  if (!openaiResp.ok) {
    // Surface OpenAI's error message but never anything about the key.
    let detail = "";
    try {
      const errBody = await openaiResp.json();
      detail = errBody?.error?.message || "";
    } catch {
      /* ignore parse failure */
    }
    return json(
      { error: `OpenAI request failed (${openaiResp.status}). ${detail}`.trim() },
      openaiResp.status
    );
  }

  const data = await openaiResp.json();
  const choice = data?.choices?.[0];

  // Completions API shape: choices[0].logprobs.top_logprobs is an array (one
  // entry per generated token). Each entry is an OBJECT mapping token -> logprob,
  // e.g. { " Paris": -0.21, "\n\n": -3.0, ... }. We take the first position.
  const topLogprobs = choice?.logprobs?.top_logprobs?.[0];

  if (!topLogprobs || typeof topLogprobs !== "object") {
    // When the model decides the text is COMPLETE, the API halts before
    // emitting this position's logprobs and returns finish_reason:"stop" with
    // empty arrays. That's not an error — it's the model predicting end-of-text.
    // Report it as a finished state so the UI can show the stop token and stop
    // predicting, rather than surfacing a scary 502.
    if (choice?.finish_reason === "stop") {
      return json({ model: MODEL, candidates: [], finished: true });
    }
    return json({ error: "OpenAI response did not include token logprobs." }, 502);
  }

  // Normalize to the array shape the client expects: [ { token, logprob }, ... ],
  // sorted high -> low. Returning ONLY this, not a raw passthrough.
  const candidates = Object.entries(topLogprobs)
    .map(([token, logprob]) => ({ token, logprob }))
    .sort((a, b) => b.logprob - a.logprob);

  return json({ model: MODEL, candidates });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
