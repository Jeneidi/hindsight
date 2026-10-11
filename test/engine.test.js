// Run: node --test
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { series, backtest, validateSpec, luckTest, analyze, describe, stats } from "../engine.js";

const load = (t) => JSON.parse(readFileSync(new URL(`../data/${t}.json`, import.meta.url)));
// Tiny hand-made market: opens and closes chosen so every fill price is easy to check by eye.
const days = (n) => Array.from({ length: n }, (_, i) => `2020-01-${String(i + 1).padStart(2, "0")}`);
const toy = { dates: days(6), open: [10, 11, 12, 13, 14, 15], close: [10, 12, 13, 14, 15, 16] };
const buyOnDay1 = { ticker: "SPY", entry: [{ left: { ind: "price" }, op: ">=", right: 12 }], exit: [], hold_days: 2 };

test("sma and change match hand math", () => {
  assert.deepEqual(series(toy, { ind: "sma", days: 2 }), [null, 11, 12.5, 13.5, 14.5, 15.5]);
  assert.ok(Math.abs(series(toy, { ind: "change", days: 1 })[1] - 20) < 1e-9);
});

test("rsi is 100 when price only rises", () => {
  assert.equal(series(toy, { ind: "rsi", days: 3 })[5], 100);
});

test("no peeking: a signal on day 1's close fills at day 2's open", () => {
  const { trades } = backtest(toy, buyOnDay1, { costPct: 0 });
  assert.equal(trades[0].entryDate, toy.dates[2]);
  assert.equal(trades[0].entryPrice, 12);
});

test("peek mode fills one day earlier, the look-ahead bug it exists to demonstrate", () => {
  const { trades } = backtest(toy, buyOnDay1, { costPct: 0, peek: true });
  assert.equal(trades[0].entryDate, toy.dates[1]);
  assert.equal(trades[0].entryPrice, 11);
});

test("hold_days keeps the position exactly that many trading days", () => {
  const { trades } = backtest(toy, buyOnDay1, { costPct: 0 });
  assert.equal(trades[0].days, 2);
  assert.equal(trades[0].exitDate, toy.dates[4]);
});

test("costs are charged on both the buy and the sell", () => {
  const { trades } = backtest(toy, buyOnDay1, { costPct: 1 });
  const expected = ((14 * 0.99) / (12 * 1.01) - 1) * 100;
  assert.ok(Math.abs(trades[0].returnPct - expected) < 1e-9);
});

test("validation rejects what the engine cannot run", () => {
  const ok = { supported: true, name: "x", summary: "y", ...buyOnDay1 };
  assert.deepEqual(validateSpec(ok), []);
  assert.ok(validateSpec({ ...ok, ticker: "DOGE" }).length);
  assert.ok(validateSpec({ ...ok, entry: [{ left: { ind: "constructor" }, op: ">", right: 1 }] }).length);
  assert.ok(validateSpec({ ...ok, entry: [{ left: { ind: "sma" }, op: ">", right: 1 }] }).length, "sma without days");
  assert.ok(validateSpec({ ...ok, hold_days: null }).length, "never sells");
  assert.ok(validateSpec({ ...ok, entry: [{ left: { ind: "price" }, op: "in", right: [1] }] }).length);
  assert.deepEqual(validateSpec({ supported: false, reason: "needs congress data" }), []);
});

test("real data is split-adjusted: no fake one-day crashes from stock splits", () => {
  for (const t of ["AAPL", "NVDA", "TSLA", "GOOGL", "AMZN"]) {
    const { close } = load(t);
    for (let i = 1; i < close.length; i++) assert.ok(close[i] / close[i - 1] > 0.5, `${t} day ${i}`);
  }
});

test("luck test is reproducible and bounded", () => {
  const spy = load("SPY");
  const spec = { ticker: "SPY", entry: [{ left: { ind: "change", days: 5 }, op: "<=", right: -5 }], exit: [], hold_days: 21 };
  const { trades, equity } = backtest(spy, spec);
  const total = stats(equity, spy.dates).totalPct;
  const a = luckTest(spy, trades, total), b = luckTest(spy, trades, total);
  assert.deepEqual(a, b);
  assert.ok(a.shareAsGood >= 0 && a.shareAsGood <= 1);
});

test("analyze returns every check and a readable description", () => {
  const spy = load("SPY");
  const vix = load("VIX");
  spy.vix = Object.fromEntries(vix.dates.map((d, i) => [d, vix.close[i]]));
  const spec = { ticker: "SPY", entry: [{ left: { ind: "vix" }, op: ">", right: 30 }], exit: [], hold_days: 63 };
  const r = analyze(spy, spec, { sims: 200 });
  assert.equal(r.checks.length, 7);
  assert.ok(r.tradeCount > 0);
  assert.match(describe(spec).join(" "), /Buy when the VIX is above 30/);
});

test("a buy never spends more cash than the account has, costs included", () => {
  const spy = load("SPY");
  const spec = { ticker: "SPY", entry: [{ left: { ind: "rsi", days: 14 }, op: "<", right: 35 }], exit: [], hold_days: 10 };
  const { equity, trades } = backtest(spy, spec, { costPct: 0.5 });
  const firstBuy = spy.dates.indexOf(trades[0].entryDate);
  // Equity right after the fill = shares x close; shares were sized from cash / (open x (1 + cost)), so
  // marked at the fill price the position is worth less than the cash spent, never more.
  assert.ok(equity[firstBuy] / spy.close[firstBuy] * spy.open[firstBuy] < equity[firstBuy - 1]);
});

test("every recorded AI example passes validation and runs", () => {
  const examples = JSON.parse(readFileSync(new URL("../data/examples.json", import.meta.url)));
  const vix = load("VIX"), vixByDate = Object.fromEntries(vix.dates.map((d, i) => [d, vix.close[i]]));
  for (const ex of examples) {
    assert.deepEqual(validateSpec(ex.spec), [], ex.idea);
    if (!ex.spec.supported) continue;
    const r = analyze({ ...load(ex.spec.ticker), vix: vixByDate }, ex.spec, { sims: 100 });
    assert.ok(r.tradeCount > 0, ex.idea);
  }
});
