# Hindsight

**Live demo: https://hindsight.mjeneidi.com**

Describe a trading idea in plain English. An LLM turns it into a JSON rule sheet, code validates that rule sheet, a transparent engine backtests it on 20 years of daily prices, and an honesty report asks whether the result was skill or luck.

![tests](https://img.shields.io/badge/tests-12%2F12%20passing-brightgreen)
![data](https://img.shields.io/badge/data-15%20tickers%20%2B%20VIX%2C%202005--2026-blue)
![stack](https://img.shields.io/badge/stack-vanilla%20JS%2C%20no%20build%2C%20no%20server-blue)
![license](https://img.shields.io/badge/license-MIT-green)

## Why

Testing a trading idea usually takes code, and amateur backtests lie in predictable ways: they peek at prices that did not exist yet, skip trading costs, lean on one lucky stretch of history, and never compare against random timing. Hindsight removes the code and then checks its own answer for each of those mistakes.

On the bundled examples it is mostly bad news, which is the point. "Buy Apple every time it drops 5% in a week" made +578% from 2005 to October 2026, but buying once and holding made +35,467%, and 62.9% of 1,000 random traders with the same number and length of trades did at least as well. "Buy the S&P 500 when the VIX is above 30" also loses to holding (+269% vs +862%), yet only 0.6% of random traders matched it, so panic is a real entry signal even though the full strategy sits in cash too long.

## How it works

```
plain English -> ai.js (OpenAI or Claude) -> JSON rule sheet -> validateSpec -> backtest -> honesty report
```

- **The AI only translates.** It never sees a price or computes a result. It must list every assumption it makes, and it must refuse ideas the data cannot support ("Copy Nancy Pelosi's trades") instead of guessing.
- **Validate, repair once, or refuse.** `validateSpec` rejects unknown tickers, made-up indicators, missing exits and out-of-range numbers. The exact errors go back to the model once; anything still invalid is never run.
- **Code re-describes the rules.** The page shows the AI's summary next to a plain-English description generated from the JSON by code, so a misread idea is visible.
- **No look-ahead.** Signals use day t's close and fill at day t+1's open. Costs (0.1% per side by default, adjustable) are charged on both sides and included in position sizing, so a buy never spends more cash than the account has.
- **Honesty report.** Look-ahead comparison (the same rules with the classic one-day bug switched on), result before costs, buy-and-hold comparison, seven named market regimes, a seeded Monte Carlo luck test with 1,000 random traders, a trade-count check, and a survivorship-bias caveat on every run.
- **Versions.** Refine an idea in plain English ("add an 8% stop-loss"); every version stays in a table so you can see whether a tweak helped or just repainted history.

The full plain-language walkthrough, with a worked example, is in [HOW-IT-WORKS.md](HOW-IT-WORKS.md).

## Run it

No build step and no dependencies. Serve the folder with any static server:

```
python3 -m http.server 8000
```

The seven example ideas use AI answers recorded with `gpt-5.4-mini` (the backtest itself always runs live in the browser). To test your own idea, open **AI settings** and paste an OpenAI or Anthropic key. The key stays in session storage and is sent only to that provider.

```
npm test                                         # node --test, 12 tests
node scripts/fetch-prices.mjs                    # refresh data/*.json from Yahoo Finance
OPENAI_API_KEY=... node scripts/record-examples.mjs   # re-record the examples (or ANTHROPIC_API_KEY)
```

## Files

| File | Role |
|---|---|
| `engine.js` | Validation, indicators (price, SMA, RSI, % change, % off high, VIX, month), backtest, stats, regimes, luck test, honesty checks |
| `ai.js` | System prompt, OpenAI and Anthropic calls, JSON parsing, validate-and-repair loop |
| `app.js` | Page logic, tables, SVG chart |
| `test/engine.test.js` | Hand-checked math, no-peeking fills, costs, sizing, validation, split adjustment, recorded examples |

## Limits

Long only, one ticker at a time, daily bars, 15 large tickers that survived to today (survivorship bias), free Yahoo Finance data. No live or paper trading and no parameter optimization. Educational project, not investment advice.

Inspired by Limex's [Ziplime](https://ziplime.limex.com/home); not affiliated with Limex.
