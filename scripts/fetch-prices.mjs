// Downloads ~20 years of daily prices from Yahoo Finance's public chart endpoint into data/*.json.
// Prices are dividend- and split-adjusted (open is scaled by the same adjclose/close factor),
// so a backtest's returns include dividends. Run: node scripts/fetch-prices.mjs
import { writeFileSync } from "node:fs";

const TICKERS = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META", "JPM", "XOM", "KO", "GLD", "TLT", "^VIX"];
const START = Date.UTC(2005, 0, 1) / 1000;
const round = (x) => Math.round(x * 10000) / 10000;

for (const ticker of TICKERS) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${START}&period2=${Math.floor(Date.now() / 1000)}&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`${ticker}: HTTP ${res.status}`);
  const r = (await res.json()).chart.result[0];
  const q = r.indicators.quote[0];
  const adj = r.indicators.adjclose?.[0]?.adjclose ?? q.close;
  const out = { ticker: ticker.replace("^", ""), dates: [], open: [], close: [] };
  r.timestamp.forEach((t, i) => {
    if (q.open[i] == null || q.close[i] == null || adj[i] == null) return; // skip holes
    const factor = adj[i] / q.close[i];
    out.dates.push(new Date(t * 1000).toISOString().slice(0, 10));
    out.open.push(round(q.open[i] * factor));
    out.close.push(round(adj[i]));
  });
  writeFileSync(`data/${out.ticker}.json`, JSON.stringify(out));
  console.log(out.ticker, out.dates.length, out.dates[0], out.dates.at(-1));
}
