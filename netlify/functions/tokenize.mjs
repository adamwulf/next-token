// Netlify Function: tokenize
//
// Returns the EXACT token boundaries the demo's next-token model uses, so the
// UI can highlight how the typed prompt is split into tokens (the first half of
// the 3.05a lesson: text becomes tokens).
//
// Why davinci-002: the next-token demo runs gpt-3.5-turbo-instruct, which does
// NOT use cl100k_base (contrary to common docs) — it uses a p50k-like tokenizer
// that no offline JS library replicates byte-for-byte. The only exact source of
// its token boundaries is the OpenAI API itself. davinci-002 shares that exact
// tokenizer (verified: identical token counts to gpt-3.5-turbo-instruct across
// many strings) and, unlike the instruct model, supports `echo` — so we ask it
// to echo the prompt back split into its tokens.
//
// The API key lives ONLY here as an env var, never sent to the browser. Model
// and params are hard-coded so this endpoint can only tokenize, nothing else.
//
// Netlify per-IP rate limiting is enabled below (see the `config` export). For
// a public deploy, also set an OpenAI project spend cap as the real cost
// backstop.

const OPENAI_URL = "https://api.openai.com/v1/completions";

const MODEL = "davinci-002"; // shares gpt-3.5-turbo-instruct's exact tokenizer, and supports echo
const MAX_PROMPT_CHARS = 500; // match the next-token demo's cap

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
    return json({ error: "Server is missing OPENAI_API_KEY. See README for setup." }, 500);
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }

  const text = String(payload?.text ?? "").slice(0, MAX_PROMPT_CHARS);
  if (text.length === 0) {
    return json({ tokens: [] }); // empty input -> no tokens (not an error)
  }

  // echo:true makes davinci-002 return the prompt split into its exact tokens
  // (in choices[0].logprobs.tokens). max_tokens:0 means "don't generate, just
  // echo". logprobs:0 keeps the response minimal. The API requires the prompt to
  // be at least 2 tokens for max_tokens:0; we retry a 1-token prompt with
  // max_tokens:1 and ignore the generated token.
  const attempt = async (maxTokens) => {
    const resp = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        prompt: text,
        max_tokens: maxTokens,
        logprobs: 0,
        echo: true,
      }),
    });
    return resp;
  };

  let openaiResp;
  try {
    openaiResp = await attempt(0);
    // A too-short (1-token) prompt fails with a specific 400; retry echoing with
    // one generated token, then drop it so only the prompt's tokens remain.
    if (openaiResp.status === 400) {
      const retry = await attempt(1);
      if (retry.ok) {
        const data = await retry.json();
        const all = data?.choices?.[0]?.logprobs?.tokens ?? [];
        return json({ tokens: cleanTokens(all.slice(0, -1)) }); // drop the generated token
      }
      openaiResp = retry; // fall through to error handling with the retry's status
    }
  } catch (err) {
    return json({ error: "Could not reach OpenAI: " + err.message }, 502);
  }

  if (!openaiResp.ok) {
    let detail = "";
    try {
      detail = (await openaiResp.json())?.error?.message || "";
    } catch {
      /* ignore */
    }
    return json({ error: `OpenAI request failed (${openaiResp.status}). ${detail}`.trim() }, openaiResp.status);
  }

  const data = await openaiResp.json();
  const tokens = data?.choices?.[0]?.logprobs?.tokens;
  if (!Array.isArray(tokens)) {
    return json({ error: "OpenAI response did not include tokens." }, 502);
  }

  return json({ tokens: cleanTokens(tokens) });
};

// The echo API represents bytes that aren't valid standalone UTF-8 (parts of a
// multi-byte character like an emoji or a CJK glyph) as strings like
// "bytes:\\xf0\\x9f". Those aren't printable text, so we mark them for the UI
// with a flag instead of a display string. Normal text tokens pass through.
function cleanTokens(tokens) {
  return tokens.map((t) => {
    if (typeof t === "string" && t.startsWith("bytes:")) {
      return { text: "�", bytes: true }; // replacement char; UI shows a "raw bytes" chip
    }
    return { text: t, bytes: false };
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
