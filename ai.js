// Hindsight AI layer: plain English in, a validated JSON rule sheet out.
// The model is a translator only. It never sees prices and never computes a result;
// engine.js checks its answer with validateSpec() and runs the numbers itself.
// Works in the browser (bring your own key, sent straight to the provider) and in Node.

import { TICKERS, INDICATORS, OPS, validateSpec } from "./engine.js";

export const PROVIDERS = {
  openai: { label: "OpenAI", defaultModel: "gpt-5.4-mini", url: "https://api.openai.com/v1/chat/completions" },
  anthropic: { label: "Anthropic (Claude)", defaultModel: "claude-haiku-5-5", url: "https://api.anthropic.com/v1/messages" },
};

const indicatorList = Object.entries(INDICATORS)
  .map(([name, x]) => `- ${name}${x.days ? ' (needs "days")' : ""}: ${x.about}`)
  .join("\n");

export const SYSTEM_PROMPT = `You turn a trader's plain-English idea into a JSON rule sheet for a backtester. You never compute results; the backtester does that.

Return ONLY one JSON object. No prose, no code fences.

If the idea can be tested with the data below, return:
{
  "supported": true,
  "name": "short title, max 60 characters",
  "summary": "one or two plain-English sentences saying exactly what will be tested",
  "ticker": one of ${TICKERS.join(", ")},
  "entry": [condition, ...],      // 1-5 conditions; ALL must be true to buy (only when not already holding)
  "exit": [condition, ...],       // 0-5 conditions; ANY true sells
  "hold_days": whole number or null,       // sell after this many trading days
  "stop_loss_pct": number or null,         // sell if the close falls this % below the buy price
  "take_profit_pct": number or null,       // sell if the close rises this % above the buy price
  "assumptions": ["every choice the user did not state, in plain English"]
}
condition = {"left": indicator, "op": one of ${OPS.join(" ")}, "right": number or indicator or list}
indicator = {"ind": name} or {"ind": name, "days": N} with N from 1 to 252
"in" is only for months: {"left": {"ind": "month"}, "op": "in", "right": [11, 12, 1]}
crosses_above / crosses_below are true only on the day the left side crosses the right side.

Indicators:
${indicatorList}

Data: daily prices from 2005 to 2026 (TSLA from 2010, META from 2012). VIX can be used in conditions but cannot be bought.

Rules:
- Long only: the strategy either holds the ticker or sits in cash, one position at a time.
- "The market" or "the S&P 500" means SPY, "the Nasdaq" QQQ, "small caps" IWM, "gold" GLD, "long-term bonds" TLT.
- A week is 5 trading days, a month 21, three months 63, a year 252.
- Every strategy needs a way out: an exit condition, hold_days, stop_loss_pct or take_profit_pct. If the user gave none, pick a sensible one and list it in assumptions.
- Do not add rules the user did not ask for, except that required way out.
- Prices are adjusted for later splits and dividends, so a dollar level ("below $150") is not a price anyone saw at the time. Never compare price or sma with a number. Compare them with each other, or use change or off_high for percentage moves. If the idea depends on a dollar level, return supported false with a percentage-based closest version.
- Always include "assumptions", even if it is an empty list.

If the idea needs anything not listed above (another ticker, several stocks at once, short selling, options, leverage, earnings or other fundamentals, news, insider or politician trades, intraday data), return:
{"supported": false, "reason": "what is missing, in one sentence", "closest": "a testable version using only the data above, in one sentence, or an empty string"}

Example. Idea: "buy the S&P when it closes above its 200-day average, sell when it closes back below"
{"supported": true, "name": "S&P 500 above its 200-day average", "summary": "Hold SPY while its price is above the 200-day average; sell when it falls below.", "ticker": "SPY", "entry": [{"left": {"ind": "price"}, "op": ">", "right": {"ind": "sma", "days": 200}}], "exit": [{"left": {"ind": "price"}, "op": "<", "right": {"ind": "sma", "days": 200}}], "hold_days": null, "stop_loss_pct": null, "take_profit_pct": null, "assumptions": ["Uses closing prices for both signals."]}`;

async function post(url, headers, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || `HTTP ${res.status}`;
    throw new Error(res.status === 401 ? "The provider rejected this API key." : message);
  }
  return data;
}

// One chat turn. Returns the model's text plus token usage as reported by the provider.
export async function callModel({ provider, model, apiKey }, messages) {
  if (provider === "openai") {
    const data = await post(PROVIDERS.openai.url, { Authorization: `Bearer ${apiKey}` }, {
      model,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      response_format: { type: "json_object" },
      max_completion_tokens: 4000,
    });
    return { text: data.choices?.[0]?.message?.content ?? "", inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens };
  }
  if (provider === "anthropic") {
    const data = await post(PROVIDERS.anthropic.url, {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    }, { model, max_tokens: 2000, system: SYSTEM_PROMPT, messages });
    return { text: (data.content ?? []).map((b) => b.text ?? "").join(""), inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens };
  }
  throw new Error(`Unknown provider: ${provider}`);
}

// Pull the first {...} block out of a reply, in case a model wraps it in prose or fences.
export function parseJson(text) {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The model did not return JSON.");
  return JSON.parse(text.slice(start, end + 1));
}

// idea -> validated spec. If the first answer fails validation, the model gets the exact
// errors back once and must fix them. Anything still invalid is refused, never run.
// `previous` is the current spec when the user is refining ("add a 10% stop-loss").
export async function translate(idea, settings, previous = null) {
  const ask = previous
    ? `Current rule sheet:\n${JSON.stringify(previous)}\n\nChange it as follows, keep everything else the same, and add any new assumption: ${idea}`
    : `Idea: ${idea}`;
  const messages = [{ role: "user", content: ask }];
  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await callModel(settings, messages);
    let spec = null, errors;
    try { spec = parseJson(reply.text); errors = validateSpec(spec); } catch (e) { errors = [e.message]; }
    attempts.push({ errors, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens });
    if (!errors.length) return { spec, attempts };
    messages.push({ role: "assistant", content: reply.text }, { role: "user", content: `That JSON has problems:\n- ${errors.join("\n- ")}\nReturn the corrected JSON object only.` });
  }
  const error = new Error(`The AI's rule sheet failed validation twice: ${attempts.at(-1).errors.join(" ")}`);
  error.attempts = attempts;
  throw error;
}
