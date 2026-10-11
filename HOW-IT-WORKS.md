# How Hindsight works (a 15-minute read)

Written for someone who knows business but not trading code. By the end you should be able to explain every number the app shows and why each one can be trusted.

## The one-sentence version

You describe a trading idea in plain English, an AI turns it into a short rule sheet, code checks that rule sheet, a simple engine replays the rules over 20 years of real prices, and an honesty report tells you whether the result looks like skill or luck.

## Why this exists

Most people with a trading idea never test it, because testing means writing code. The few who do test it usually get a number that is too good to be true, because amateur backtests (a "backtest" is a replay of a strategy on past prices) make the same handful of mistakes: they peek at information that did not exist yet, they forget trading costs, they test on one lucky stretch of history, and they never ask whether random trading would have done just as well.

Hindsight lets anyone test an idea without code, and then it attacks its own result with each of those mistakes in mind.

## The pipeline in five steps

```
 "Buy Apple every time it drops 5% in a week"
        |
   1. AI translator (OpenAI or Claude)      -> writes a JSON rule sheet
        |
   2. Validator (engine.js)                 -> rejects anything the engine can't run; the AI gets one chance to fix it
        |
   3. Backtest engine (engine.js)           -> replays the rules day by day on real prices
        |
   4. Scoring (engine.js)                   -> return, worst drop, Sharpe, trades
        |
   5. Honesty report (engine.js)            -> peeking, costs, buy-and-hold, regimes, luck, sample size
```

The key design decision: **the AI only translates. It never sees a price and never calculates a result.** Every number on screen comes from about 350 lines of ordinary code in `engine.js`, which the tests in `test/engine.test.js` check against hand-calculated answers. If someone asks "how do you know the AI didn't make up the numbers?", the answer is that it is not allowed anywhere near them.

## Step 1: the AI translator (`ai.js`)

The AI receives a fixed set of instructions (the "system prompt" in `ai.js`) that lists exactly what the engine understands:

- 15 tickers it can trade (SPY, QQQ, AAPL, NVDA, TSLA and so on), and the VIX "fear gauge" as a signal only.
- 7 building blocks ("indicators"): price, moving average, RSI, percent change, percent below the recent high, VIX, and calendar month.
- 7 comparisons: above, below, at or above, at or below, crosses above, crosses below, and "is one of" (for months).
- Ways to exit: an exit rule, a holding period, a stop-loss, or a take-profit.

It must answer with a JSON rule sheet, and it must list every assumption it made. Here is the real answer it gave for "Buy Apple every time it drops 5% in a week":

```json
{
  "supported": true,
  "name": "AAPL 5% weekly dip buy",
  "summary": "Buy AAPL when it has fallen 5% over the last 5 trading days. Sell using a standard time limit since no exit was specified.",
  "ticker": "AAPL",
  "entry": [{"left": {"ind": "change", "days": 5}, "op": "<=", "right": -5}],
  "exit": [],
  "hold_days": 21,
  "stop_loss_pct": null,
  "take_profit_pct": null,
  "assumptions": [
    "Uses adjusted daily closing prices.",
    "Buys only when not already holding.",
    "A 1-week drop means a 5-trading-day percent change.",
    "Adds a 21-trading-day hold because no exit rule was provided."
  ]
}
```

Read it as: "Buy Apple when its 5-day price change is -5% or worse; sell 21 trading days later." The user never said when to sell, so the AI picked one month and said so. That openness is deliberate: a hidden assumption is how a test quietly answers a different question than the one asked.

If an idea needs data the app does not have, the AI must refuse instead of guessing. "Copy Nancy Pelosi's trades" comes back as unsupported, because there is no politician-trade data here, along with a testable alternative.

**Why a rule sheet and not code?** Some tools let the AI write Python and then run it. That is powerful, but it means running code nobody has checked, and AI-written strategy code is where subtle cheating (peeking at tomorrow's price) creeps in. A rule sheet can only say things the engine already knows how to do safely. The trade-off is that you can express fewer ideas. For a tool whose whole point is trustworthy answers, that is the right trade.

## Step 2: the validator (`validateSpec` in `engine.js`)

Before anything runs, code checks the rule sheet: Is the ticker on the list? Is every indicator real? Does a moving average say how many days it covers? Is there at least one way to sell? (A strategy that never sells is not a strategy.)

If anything is wrong, the exact error messages go back to the AI once ("ticker must be one of SPY, QQQ, ..."), and it gets one chance to fix them. If the second answer is still wrong, Hindsight refuses to run it. This is the guardrail that lets an unpredictable AI sit safely in front of predictable code. It is the same idea as validating a form before saving it to a database.

The page also shows the rules in plain English **written by code, not by the AI** (the `describe` function). So you can compare the AI's own summary with what the engine will actually do. If the AI misunderstood you, the two will disagree on screen.

## Step 3: the backtest engine (`backtest` in `engine.js`)

The engine walks through history one trading day at a time, like someone reading yesterday's newspaper every morning:

1. **At the close of day t**, it computes the indicators using prices up to and including that day, and checks the rules.
2. **If a rule fires**, it places an order that fills at the **open of day t+1**, the first price a real trader could actually get after seeing the signal.
3. **Costs are charged on every buy and every sell** (0.1% each by default, covering commission plus slippage, which is the gap between the price you see and the price you get). The cost is included when deciding how many shares to buy, so the account can never spend more cash than it has. A test checks this.
4. **One position at a time, long only.** You either own the stock or hold cash.
5. The account value is recorded every day, which produces the chart.

Prices come from Yahoo Finance and are **adjusted for splits and dividends**, so a 4-for-1 stock split does not look like a 75% crash, and dividends count toward returns. A test checks that no adjusted stock ever "falls" more than 50% in a day.

## Step 4: the scorecard

| Number | Plain meaning |
|---|---|
| Total return | How much $1 became, minus the $1. Shown next to simply buying and holding the same ticker. |
| $10,000 became | The same thing in dollars. |
| Per year (CAGR) | The steady yearly growth rate that would produce the same total. |
| Worst drop (max drawdown) | The biggest fall from a high point to a later low. This is the pain you would have had to sit through. |
| Sharpe ratio | Return divided by how bumpy the ride was. Higher is better; around 1 is good for a single stock strategy. |
| Trades, % that made money, % of days invested | How active the strategy was. |

## Step 5: the honesty report (`analyze` in `engine.js`)

This is the part that answers "should I believe this?". Each check gets PASS, WARN or FAIL.

1. **No peeking at the future.** The engine never uses a price before it existed (step 3). To show why this matters, Hindsight also runs the same rules with the most common backtesting bug switched on: trading at the morning open using that afternoon's close. The report shows how much that bug would have changed the answer. It can push results up or down. For the VIX panic idea the bug turns +269% into +149%. Either way, a backtest with the bug is answering a question no real trader could act on.
2. **Trading costs included.** Shows the result with costs set to zero. Strategies that trade often can look great before costs and lose money after. You can change the cost in the Results box and everything recalculates.
3. **Beats simply holding.** The most humbling check. Most ideas lose to buying the stock once and doing nothing. If the strategy earns less but with a smoother ride (better Sharpe), it gets a WARN instead of a FAIL, because some people would happily trade return for less pain.
4. **Holds up across market regimes.** One 20-year number can hide a strategy that only works in one kind of market. Hindsight splits history into named periods (the 2008 financial crisis, the post-crisis bull run, the calm 2016-2019 bull, the COVID crash, the recovery rally, the 2022 rate-hike bear market, the AI-led bull) and compares the strategy with buy-and-hold in each.
5. **Skill or luck (the luck test).** This is a Monte Carlo test, which means "run many random simulations and see where the real result lands." Hindsight creates 1,000 random traders. Each one makes the same number of trades as the strategy, holds each trade for the same number of days, on the same stock, with the same costs, but picks the dates at random. If only a few percent of random traders did as well, the timing rule probably adds something real. If half of them did, the result is indistinguishable from throwing darts. The random generator uses a fixed seed, so the same idea always gets the same answer.
6. **Enough trades to judge.** Under about 30 trades, a couple of lucky ones can decide everything. This is a rule of thumb and the app labels it as one.
7. **Data caveat.** Always shown. The 15 tickers are well-known companies that survived to today. Testing only survivors flatters results ("survivorship bias"), because the companies that went bankrupt are not in the list. Production systems fix this with point-in-time data that includes delisted companies; this project states the limitation instead.

## A worked example: "Buy the market when everyone panics"

Idea: buy SPY (the S&P 500 fund) when the VIX fear gauge closes above 30, hold three months. Data: January 2005 to October 2026.

- The AI wrote: buy SPY when VIX > 30, sell after 63 trading days. It listed "three months = 63 trading days" as an assumption.
- Result: **+269%**, 24 trades, 79% of them profitable, worst drop -46.5%.
- Buy-and-hold SPY over the same years: **+862%**. FAIL on "beats simply holding": the strategy sat in cash 72% of the time and missed most of the long bull market.
- Luck test: only **0.6%** of 1,000 random traders with the same trade count and lengths did as well (the typical one made +77%). PASS: buying during panics really did beat random timing.
- Regimes: beat holding in 3 of 7 periods. It lost less in the 2008 crisis (-40% vs -55%), the COVID crash and the 2022 bear market, and lagged in every bull run.
- Trade count: 24, so WARN.

**How to say it in one breath:** "Buying during panics is a genuinely good *entry* signal, it beats random timing by a wide margin, but as a whole strategy it loses to just holding the index, because it spends most of its life in cash. And with 24 trades, I'd want more evidence before betting on it."

That is the kind of nuanced answer the tool is built to produce: not "this works" or "this doesn't", but which part works and how sure we can be.

## What is deliberately left out

- **Live or paper trading.** The engine is built so it could be added (the rule sheet is separate from where orders go), but sending real orders is out of scope for a portfolio project.
- **Several stocks at once, short selling, leverage, options, fundamentals, news.** Each would mean more indicators and more ways to get things wrong. The AI is told to refuse these rather than fake them.
- **Parameter optimization.** Searching for the "best" RSI threshold is the fastest way to fit a strategy to the past (overfitting). The version table lets you compare tweaks by hand instead, so you can see whether a change helped in most regimes or just repainted one stretch of history.

## The files

| File | What it does | Size |
|---|---|---|
| `engine.js` | Validation, indicators, backtest, scoring, honesty checks, plain-English description | ~350 lines |
| `ai.js` | System prompt, OpenAI and Anthropic calls, JSON parsing, validate-and-repair loop | ~120 lines |
| `app.js` | Page logic: settings, examples, tables, chart | ~200 lines |
| `test/engine.test.js` | 12 tests: hand-checked math, no peeking, costs, sizing, validation, split adjustment, recorded examples | |
| `scripts/fetch-prices.mjs` | Downloads and adjusts the price data | |
| `scripts/record-examples.mjs` | Runs the example ideas through the real AI so visitors can try them without a key | |

## Questions you should be ready for

**Is the AI deciding trades?** No. It converts words into a rule sheet once. The engine makes every decision with fixed code.

**What if the AI misunderstands me?** Three defenses: it must list its assumptions, code re-describes the rules independently of the AI, and the raw rule sheet is one click away. You can also type a correction ("hold for 10 days instead") and the AI edits the existing rule sheet.

**What stops the AI from returning garbage?** The validator. Unknown tickers, made-up indicators, missing exits and impossible numbers are rejected, the AI gets the exact errors back once, and anything still invalid is refused.

**Why should I trust the backtest?** Signals use only information that existed at the time, fills happen at the next open, costs are charged both ways and included in position sizing, prices are split- and dividend-adjusted, and each of these is covered by a test with a hand-calculated answer.

**Then why can't I trust it completely?** Survivorship bias in the ticker list, free data, 0.1% costs that may be optimistic for some traders, and the fact that the past is not the future. The report says so on every run.

**Where does my API key go?** It stays in the browser tab (session storage, cleared when the tab closes) and is sent only to the provider you choose. There is no server.

**What does it cost to run?** Nothing to host (static site). Each live translation is one or two small model calls on your own key, typically a fraction of a cent.
