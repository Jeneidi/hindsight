// Runs the example ideas through the real AI layer (ai.js, same code the page uses) and saves the
// validated answers to data/examples.json, so visitors can see real translations without a key.
// Run: OPENAI_API_KEY=... node scripts/record-examples.mjs   (or ANTHROPIC_API_KEY=...)
import { writeFileSync } from "node:fs";
import { translate, PROVIDERS } from "../ai.js";

const provider = process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai";
const settings = { provider, model: process.env.MODEL || PROVIDERS[provider].defaultModel, apiKey: process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY };
if (!settings.apiKey) throw new Error("Set OPENAI_API_KEY or ANTHROPIC_API_KEY");

const IDEAS = [
  { idea: "Buy Apple every time it drops 5% in a week" },
  { idea: "Same idea, but add an 8% stop-loss", refines: 0 },
  { idea: "Buy the market when everyone panics (VIX above 30) and hold for three months" },
  { idea: "Sell in May and go away, buy back in November" },
  { idea: "Buy Nvidia when its 50-day average crosses above its 200-day average, sell when it crosses back below" },
  { idea: "Buy Tesla when RSI drops under 30 and sell when it gets above 70, with a 10% stop-loss" },
  { idea: "Copy Nancy Pelosi's trades" },
];

const examples = [];
for (const item of IDEAS) {
  const previous = item.refines != null ? examples[item.refines].spec : null;
  const { spec, attempts } = await translate(item.idea, settings, previous);
  examples.push({ idea: item.idea, refines: item.refines ?? null, provider, model: settings.model, recordedAt: new Date().toISOString().slice(0, 10), attempts: attempts.length, rejected: attempts.flatMap((a) => a.errors), spec });
  console.log(`${item.idea}\n  -> ${spec.supported ? spec.name : "UNSUPPORTED: " + spec.reason} (attempts: ${attempts.length})`);
}
writeFileSync("data/examples.json", JSON.stringify(examples, null, 2) + "\n");
