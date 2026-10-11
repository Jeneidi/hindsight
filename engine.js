// Hindsight engine: the deterministic half of the app.
// The AI never runs in this file. It only writes the JSON rule sheet ("spec") that
// validateSpec() checks and backtest() executes, so every number on screen comes from
// plain arithmetic you can read below, never from a model.

export const TICKERS = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META", "JPM", "XOM", "KO", "GLD", "TLT"];

export const INDICATORS = {
  price: { days: false, about: "closing price, adjusted for splits and dividends; only compare it with price or sma, never with a dollar amount" },
  sma: { days: true, about: "average closing price over the last N trading days; only compare it with price or sma, never with a dollar amount" },
  rsi: { days: true, about: "RSI momentum gauge from 0 to 100 (under 30 = oversold, over 70 = overbought), usually 14 days" },
  change: { days: true, about: "percent change in price over the last N trading days (-5 means down 5%)" },
  off_high: { days: true, about: "percent below the highest close of the last N trading days (0 at a new high, -20 means 20% below it)" },
  vix: { days: false, about: "VIX index close, the market's fear gauge (about 20 is normal, above 30 is panic)" },
  month: { days: false, about: "calendar month number, 1 = January to 12 = December" },
};

export const OPS = [">", "<", ">=", "<=", "crosses_above", "crosses_below", "in"];
export const DEFAULT_COST_PCT = 0.1; // charged on every buy and every sell: commission plus slippage

// Named market regimes (S&P 500 peak and trough dates for the two crashes).
export const REGIMES = [
  ["2008 financial crisis", "2007-10-09", "2009-03-09"],
  ["Post-crisis bull", "2009-03-10", "2015-12-31"],
  ["Low-volatility bull", "2016-01-01", "2019-12-31"],
  ["COVID crash", "2020-02-19", "2020-03-23"],
  ["Recovery rally", "2020-03-24", "2021-12-31"],
  ["Rate-hike bear", "2022-01-01", "2022-12-31"],
  ["AI-led bull", "2023-01-01", "2025-12-31"],
];

// ---------- 1. Validation: the guardrail between the AI and the engine ----------

export function validateSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return ["The answer is not a JSON object."];
  if (spec.supported === false) {
    if (typeof spec.reason !== "string" || !spec.reason) errors.push('An unsupported idea needs a "reason".');
    return errors;
  }
  if (spec.supported !== true) errors.push('"supported" must be true or false.');
  if (!TICKERS.includes(spec.ticker)) errors.push(`"ticker" must be one of ${TICKERS.join(", ")}.`);
  for (const key of ["name", "summary"]) {
    if (typeof spec[key] !== "string" || !spec[key] || spec[key].length > 300) errors.push(`"${key}" must be a short non-empty string.`);
  }
  if (!Array.isArray(spec.entry) || spec.entry.length < 1 || spec.entry.length > 5) errors.push('"entry" needs 1 to 5 conditions.');
  else spec.entry.forEach((c, i) => checkCondition(c, `entry[${i}]`, errors));
  const exit = spec.exit ?? [];
  if (!Array.isArray(exit) || exit.length > 5) errors.push('"exit" must be a list of at most 5 conditions.');
  else exit.forEach((c, i) => checkCondition(c, `exit[${i}]`, errors));
  checkNumber(spec.hold_days, "hold_days", 1, 2000, true, errors);
  checkNumber(spec.stop_loss_pct, "stop_loss_pct", 0.1, 99, false, errors);
  checkNumber(spec.take_profit_pct, "take_profit_pct", 0.1, 10000, false, errors);
  if (Array.isArray(exit) && !exit.length && spec.hold_days == null && spec.stop_loss_pct == null && spec.take_profit_pct == null) {
    errors.push("The strategy never sells: add an exit condition, hold_days, stop_loss_pct or take_profit_pct.");
  }
  if (!Array.isArray(spec.assumptions) || spec.assumptions.some((a) => typeof a !== "string")) {
    errors.push('"assumptions" must be a list of strings.');
  }
  return errors;
}

function checkNumber(value, name, low, high, wholeNumber, errors) {
  if (value == null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high || (wholeNumber && !Number.isInteger(value))) {
    errors.push(`"${name}" must be ${wholeNumber ? "a whole number" : "a number"} from ${low} to ${high}, or null.`);
  }
}

function checkIndicator(x, where, errors) {
  if (!x || typeof x !== "object" || !Object.hasOwn(INDICATORS, x.ind)) {
    errors.push(`${where}: unknown indicator ${JSON.stringify(x?.ind ?? x)}; use one of ${Object.keys(INDICATORS).join(", ")}.`);
  } else if (INDICATORS[x.ind].days) {
    if (!Number.isInteger(x.days) || x.days < 1 || x.days > 252) errors.push(`${where}: "${x.ind}" needs "days", a whole number from 1 to 252.`);
  } else if (x.days != null) {
    errors.push(`${where}: "${x.ind}" takes no "days".`);
  }
}

function checkCondition(c, where, errors) {
  if (!c || typeof c !== "object") return errors.push(`${where} must be an object.`);
  if (!OPS.includes(c.op)) errors.push(`${where}: "op" must be one of ${OPS.join(" ")}.`);
  checkIndicator(c.left, `${where}.left`, errors);
  if (c.op === "in") {
    const months = Array.isArray(c.right) && c.right.length && c.right.every((m) => Number.isInteger(m) && m >= 1 && m <= 12);
    if (c.left?.ind !== "month" || !months) errors.push(`${where}: "in" only works as month in a list of month numbers 1-12.`);
  } else if (typeof c.right === "number") {
    if (!Number.isFinite(c.right)) errors.push(`${where}: "right" must be a finite number.`);
  } else {
    checkIndicator(c.right, `${where}.right`, errors);
  }
  // Adjusted prices bake in splits and dividends that happened LATER, so "$100" in 2005 is not a price
  // anyone saw then. Price levels may only be compared with each other, which cancels the adjustment.
  const isLevel = (x) => x?.ind === "price" || x?.ind === "sma";
  if (c.op !== "in" && (isLevel(c.left) || isLevel(c.right)) && !(isLevel(c.left) && isLevel(c.right))) {
    errors.push(`${where}: price and sma can only be compared with price or sma (adjusted prices are not real dollar levels); use change or off_high for percentages.`);
  }
}

// ---------- 2. Indicators ----------

// data = { dates: ["2005-01-03", ...], open: [...], close: [...], vix?: { "2005-01-03": 14.08, ... } }
export function series(data, ind, cache = {}) {
  const key = `${ind.ind}:${ind.days ?? ""}`;
  if (cache[key]) return cache[key];
  const close = data.close, n = close.length, days = ind.days, out = new Array(n).fill(null);
  if (ind.ind === "price") {
    for (let i = 0; i < n; i++) out[i] = close[i];
  } else if (ind.ind === "sma") {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += close[i];
      if (i >= days) sum -= close[i - days];
      if (i >= days - 1) out[i] = sum / days;
    }
  } else if (ind.ind === "change") {
    for (let i = days; i < n; i++) out[i] = (close[i] / close[i - days] - 1) * 100;
  } else if (ind.ind === "off_high") {
    for (let i = days - 1; i < n; i++) out[i] = (close[i] / Math.max(...close.slice(i - days + 1, i + 1)) - 1) * 100;
  } else if (ind.ind === "rsi") {
    // Wilder's RSI: average gain vs average loss, smoothed over `days`.
    let gain = 0, loss = 0;
    for (let i = 1; i < n; i++) {
      const diff = close[i] - close[i - 1], up = Math.max(diff, 0), down = Math.max(-diff, 0);
      if (i <= days) { gain += up / days; loss += down / days; }
      else { gain = (gain * (days - 1) + up) / days; loss = (loss * (days - 1) + down) / days; }
      if (i >= days) out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  } else if (ind.ind === "vix") {
    data.dates.forEach((d, i) => { out[i] = data.vix?.[d] ?? null; });
  } else if (ind.ind === "month") {
    data.dates.forEach((d, i) => { out[i] = Number(d.slice(5, 7)); });
  }
  return (cache[key] = out);
}

function holds(cond, t, get) {
  const left = get(cond.left), l = left[t];
  if (cond.op === "in") return cond.right.includes(l);
  const right = typeof cond.right === "number" ? null : get(cond.right);
  const r = right ? right[t] : cond.right;
  if (l == null || r == null) return false; // not enough history yet: no signal
  if (cond.op === ">") return l > r;
  if (cond.op === "<") return l < r;
  if (cond.op === ">=") return l >= r;
  if (cond.op === "<=") return l <= r;
  const lPrev = left[t - 1], rPrev = right ? right[t - 1] : r;
  if (lPrev == null || rPrev == null) return false;
  if (cond.op === "crosses_above") return l > r && lPrev <= rPrev;
  if (cond.op === "crosses_below") return l < r && lPrev >= rPrev;
  return false;
}

// ---------- 3. Backtest ----------

// Honest mode: a signal is computed from day t's close and filled at day t+1's open.
// peek mode reproduces the classic look-ahead bug on purpose: it fills at day t's open,
// before the close that produced the signal existed. Only used to show how much that bug changes the answer
// (it can push results up or down, which is exactly why a backtest with it cannot be trusted).
export function backtest(data, spec, { costPct = DEFAULT_COST_PCT, peek = false } = {}) {
  const { dates, open, close } = data, n = dates.length, cost = costPct / 100, cache = {};
  const get = (ind) => series(data, ind, cache);
  const equity = new Array(n), trades = [];
  let cash = 1, position = null, order = null, daysInMarket = 0;

  const exitReason = (t) => {
    const hit = (spec.exit ?? []).find((c) => holds(c, t, get));
    if (hit) return "exit rule";
    if (spec.stop_loss_pct != null && close[t] <= position.entryPrice * (1 - spec.stop_loss_pct / 100)) return "stop-loss";
    if (spec.take_profit_pct != null && close[t] >= position.entryPrice * (1 + spec.take_profit_pct / 100)) return "take-profit";
    if (spec.hold_days != null && t - position.signalDay >= spec.hold_days) return "holding period";
    return null;
  };

  const fill = (o, t) => {
    if (o.side === "buy") {
      const paid = open[t] * (1 + cost);
      position = { shares: cash / paid, paid, entryPrice: open[t], entryDay: t, signalDay: o.day };
      cash = 0;
    } else {
      const got = open[t] * (1 - cost);
      cash = position.shares * got;
      trades.push(tradeRecord(position, t, open[t], got, o.reason));
      position = null;
    }
  };
  const tradeRecord = (p, t, exitPrice, got, reason) => ({
    entryDate: dates[p.entryDay], exitDate: dates[t], entryPrice: p.entryPrice, exitPrice,
    returnPct: (got / p.paid - 1) * 100, days: t - p.entryDay, reason,
  });

  for (let t = 0; t < n; t++) {
    if (order) { fill(order, t); order = null; }
    let signal = null;
    if (!position && spec.entry.every((c) => holds(c, t, get))) signal = { side: "buy", day: t };
    else if (position) { const reason = exitReason(t); if (reason) signal = { side: "sell", day: t, reason }; }
    if (signal && peek) fill(signal, t);
    else if (signal && t + 1 < n) order = signal;
    equity[t] = position ? position.shares * close[t] : cash;
    if (position) daysInMarket++;
  }
  if (position) trades.push(tradeRecord(position, n - 1, close[n - 1], close[n - 1] * (1 - cost), "still open"));
  return { equity, trades, daysInMarket };
}

// ---------- 4. Scoring ----------

// Every curve starts from a $1 stake (strategy cash or buy-and-hold), so growth is measured from 1,
// not from day 0's value, which a peek-mode buy on day 0 would already have changed.
export function stats(equity, dates) {
  const n = equity.length, returns = [];
  for (let i = 0; i < n; i++) returns.push(equity[i] / (i ? equity[i - 1] : 1) - 1);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const sd = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length);
  let peak = 1, maxDrawdown = 0;
  for (const e of equity) { peak = Math.max(peak, e); maxDrawdown = Math.min(maxDrawdown, e / peak - 1); }
  const years = (Date.parse(dates[n - 1]) - Date.parse(dates[0])) / (365.25 * 864e5);
  const growth = equity[n - 1];
  return {
    totalPct: (growth - 1) * 100,
    cagrPct: (growth ** (1 / years) - 1) * 100,
    maxDrawdownPct: maxDrawdown * 100,
    sharpe: sd ? (mean / sd) * Math.sqrt(252) : 0, // risk-free rate taken as 0
    years,
  };
}

export function regimeTable(dates, equity, benchmark) {
  return REGIMES.flatMap(([name, start, end]) => {
    if (dates[0] > start || dates.at(-1) < end) return []; // ticker did not trade through the whole regime
    const i0 = dates.findIndex((d) => d >= start), i1 = dates.findLastIndex((d) => d <= end), base = Math.max(i0 - 1, 0);
    return [{ name, start, end, strategyPct: (equity[i1] / equity[base] - 1) * 100, holdPct: (benchmark[i1] / benchmark[base] - 1) * 100 }];
  });
}

// Small seeded random generator so the luck test gives the same answer every run.
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// Luck test: 1,000 random traders make the same number of trades, each held exactly as long as
// the strategy held its trades, on the same ticker with the same costs, but on random dates.
// If many of them did as well, the strategy's timing may be luck rather than skill.
export function luckTest(data, trades, strategyTotalPct, { sims = 1000, costPct = DEFAULT_COST_PCT, seed = 42 } = {}) {
  const lengths = trades.map((t) => t.days).filter((d) => d > 0);
  if (!lengths.length) return null;
  const open = data.open, cost = costPct / 100, free = open.length - 1 - lengths.reduce((a, b) => a + b, 0);
  if (free < 0) return null;
  const rand = mulberry32(seed), results = [];
  for (let s = 0; s < sims; s++) {
    const order = lengths.slice();
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    // Random idle gaps between trades that add up to at most `free` days, so trades never overlap.
    const cuts = order.map(() => Math.floor(rand() * (free + 1))).sort((a, b) => a - b);
    let growth = 1, day = 0, previousCut = 0;
    order.forEach((len, i) => {
      day += cuts[i] - previousCut; previousCut = cuts[i];
      growth *= (open[day + len] * (1 - cost)) / (open[day] * (1 + cost));
      day += len;
    });
    results.push((growth - 1) * 100);
  }
  results.sort((a, b) => a - b);
  const asGood = results.filter((r) => r >= strategyTotalPct).length;
  return { sims, shareAsGood: asGood / sims, medianPct: results[Math.floor(sims / 2)] };
}

// ---------- 5. Everything the page shows, in one call ----------

const pct = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;

export function analyze(data, spec, { costPct = DEFAULT_COST_PCT, sims = 1000 } = {}) {
  const run = backtest(data, spec, { costPct });
  const strategy = stats(run.equity, data.dates);
  const holdEquity = data.close.map((c) => c / data.close[0]);
  const hold = stats(holdEquity, data.dates);
  const peeked = stats(backtest(data, spec, { costPct, peek: true }).equity, data.dates);
  const noCosts = stats(backtest(data, spec, { costPct: 0 }).equity, data.dates);
  const regimes = regimeTable(data.dates, run.equity, holdEquity);
  const luck = luckTest(data, run.trades, strategy.totalPct, { sims, costPct });
  // The luck test keeps a still-open position (it is real exposure), but counts and win rate use finished trades only.
  const finished = run.trades.filter((t) => t.reason !== "still open");
  const tradeCount = finished.length, stillOpen = run.trades.length - tradeCount;
  const wins = finished.filter((t) => t.returnPct > 0).length;
  const regimeWins = regimes.filter((r) => r.strategyPct > r.holdPct).length;

  const checks = [
    {
      name: "No peeking at the future", status: "pass",
      detail: `Signals use each day's closing data and trades fill at the next day's open. With the classic one-day look-ahead bug (trading at the open, before the close that triggered the signal existed), the same rules would report ${pct(peeked.totalPct)} instead of ${pct(strategy.totalPct)}.`,
    },
    {
      name: "Trading costs included", status: noCosts.totalPct > 0 && strategy.totalPct <= 0 ? "warn" : "pass",
      detail: `${costPct}% is charged on every buy and every sell. Without costs the result would be ${pct(noCosts.totalPct)}.`,
    },
    {
      name: "Beats simply holding", status: strategy.totalPct > hold.totalPct ? "pass" : strategy.sharpe > hold.sharpe ? "warn" : "fail",
      detail: `${pct(strategy.totalPct)} vs ${pct(hold.totalPct)} for buying ${spec.ticker} once and holding.${strategy.totalPct <= hold.totalPct && strategy.sharpe > hold.sharpe ? " Lower return, but a smoother ride (better Sharpe)." : ""}`,
    },
    {
      name: "Holds up across market regimes", status: !regimes.length ? "warn" : regimeWins * 2 > regimes.length ? "pass" : "warn",
      detail: regimes.length ? `Beat buy-and-hold in ${regimeWins} of ${regimes.length} named market periods.` : "Not enough history to cover any named market period.",
    },
    luck
      ? {
          name: "Skill or luck", status: luck.shareAsGood < 0.05 ? "pass" : luck.shareAsGood < 0.2 ? "warn" : "fail",
          detail: `${(luck.shareAsGood * 100).toFixed(1)}% of ${luck.sims.toLocaleString("en-US")} random traders (same number and length of trades, random dates) did at least as well. The typical one made ${pct(luck.medianPct)}.`,
        }
      : { name: "Skill or luck", status: "fail", detail: "No completed trades, so there is nothing to test." },
    {
      name: "Enough trades to judge", status: tradeCount >= 30 ? "pass" : tradeCount >= 10 ? "warn" : "fail",
      detail: `${tradeCount} finished trade${tradeCount === 1 ? "" : "s"}${stillOpen ? " (plus one still open)" : ""}. Rule of thumb: under 30 trades, a few lucky ones can decide the whole result.`,
    },
    {
      name: "Data caveat", status: "info",
      detail: "Free Yahoo Finance prices for 15 well-known tickers that are still alive today. Picking survivors flatters results (survivorship bias); a production engine uses point-in-time data that includes delisted companies.",
    },
  ];

  return {
    run, strategy, hold, holdEquity, regimes, luck, checks,
    tradeCount, stillOpen, winRatePct: tradeCount ? (wins / tradeCount) * 100 : 0,
    timeInMarketPct: (run.daysInMarket / data.dates.length) * 100,
  };
}

// ---------- 6. Plain-English description written by code, not by the AI ----------
// Shown next to the AI's own summary, so a reader can catch the AI misreading the idea.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const OP_WORDS = { ">": "is above", "<": "is below", ">=": "is at or above", "<=": "is at or below", crosses_above: "crosses above", crosses_below: "crosses below", in: "is one of" };

function indicatorWords(x) {
  if (typeof x === "number") return String(x);
  return {
    price: "the price", sma: `the ${x.days}-day average price`, rsi: `the ${x.days}-day RSI`, change: `the ${x.days}-day % change`,
    off_high: `the % below its ${x.days}-day high`, vix: "the VIX", month: "the month",
  }[x.ind];
}

export function conditionWords(c) {
  const right = c.op === "in" ? c.right.map((m) => MONTHS[m - 1]).join(", ")
    : typeof c.right === "number" && ["change", "off_high"].includes(c.left.ind) ? `${c.right}%`
    : indicatorWords(c.right);
  return `${indicatorWords(c.left)} ${OP_WORDS[c.op]} ${right}`;
}

export function describe(spec) {
  const lines = [`Trade ${spec.ticker}, long only, one position at a time.`];
  lines.push(`Buy when ${spec.entry.map(conditionWords).join(" and ")}.`);
  const outs = (spec.exit ?? []).map(conditionWords);
  if (spec.stop_loss_pct != null) outs.push(`it closes ${spec.stop_loss_pct}% below the buy price (stop-loss)`);
  if (spec.take_profit_pct != null) outs.push(`it closes ${spec.take_profit_pct}% above the buy price (take-profit)`);
  if (spec.hold_days != null) outs.push(`${spec.hold_days} trading days have passed`);
  lines.push(`Sell when ${outs.join(", or ")}.`);
  return lines;
}
