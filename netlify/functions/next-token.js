// Netlify Function: next-token
//
// Server-side proxy for the next-token-prediction demo (course demo 3.05a).
// The OpenAI API key lives ONLY here as an environment variable and is never
// sent to the browser. The browser calls /.netlify/functions/next-token with
// just { prompt }; everything else about the request is hard-coded so this
// endpoint can only run the demo — it can't be abused as a general chat proxy.
//
// This returns the model's NATURAL top-5 distribution for the next token
// (temperature 1.0 at the API). The demo's sampling meta-parameters
// (temperature / top-k / top-p) are applied CLIENT-SIDE to reshape that
// distribution and to pick the committed token — so dragging the sliders
// updates the on-screen bars instantly, with no extra API call, and the
// selection is always consistent with the probabilities shown. See README.
//
// TODO (future public deploy only): if this is ever deployed publicly rather
// than run locally with `netlify dev`, add (1) an OpenAI project spend cap as
// the real backstop, and (2) Netlify per-IP rate limiting on this function.
// Neither is needed for the local screen-recording workflow.

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// Hard-coded so the caller can never change them:
const MODEL = "gpt-4o-mini"; // you pick the model, not the caller
const MAX_TOKENS = 1; // we only need the next single token's distribution
const TOP_LOGPROBS = 5; // OpenAI caps this at 5 (integer 0-5); do not exceed
const MAX_PROMPT_CHARS = 500; // truncate the prompt to bound cost/abuse

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
    messages: [{ role: "user", content: prompt }],
    max_tokens: MAX_TOKENS,
    logprobs: true,
    top_logprobs: TOP_LOGPROBS,
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
  const step = data?.choices?.[0]?.logprobs?.content?.[0];

  if (!step || !Array.isArray(step.top_logprobs)) {
    return json({ error: "OpenAI response did not include token logprobs." }, 502);
  }

  // Return ONLY the top-5 candidates for the next position, not a raw
  // passthrough: [ { token, logprob }, ... ]. The client converts logprob to a
  // probability and applies the sampling meta-parameters.
  return json({
    model: MODEL,
    candidates: step.top_logprobs.map((c) => ({
      token: c.token,
      logprob: c.logprob,
    })),
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
