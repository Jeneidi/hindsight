// Hindsight page logic: wires the form to ai.js (translate) and engine.js (analyze), then draws results.
// Every string that came from a model is inserted with textContent, never as HTML.
import { analyze, describe } from "./engine.js";
import { translate, PROVIDERS } from "./ai.js";

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
const pct = (x, digits = 1) => `${x >= 0 ? "+" : ""}${x.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
const KEY_NAME = "hindsight_key"; // sessionStorage slot name, not the secret itself

let examples = [], current = null, versions = [];

// ---------- data ----------
const files = new Map();
const loadFile = (name) => {
  if (!files.has(name)) files.set(name, fetch(`data/${name}.json`).then((r) => { if (!r.ok) throw new Error(`Could not load ${name} data.`); return r.json(); }));
  return files.get(name);
};
let vixByDate = null;
async function loadData(spec) {
  const data = { ...(await loadFile(spec.ticker)) };
  if (JSON.stringify(spec).includes('"vix"')) {
    if (!vixByDate) { const v = await loadFile("VIX"); vixByDate = Object.fromEntries(v.dates.map((d, i) => [d, v.close[i]])); }
    data.vix = vixByDate;
  }
  return data;
}

// ---------- settings (bring your own key) ----------
function initSettings() {
  for (const [id, p] of Object.entries(PROVIDERS)) $("provider").append(el("option", { value: id, textContent: p.label }));
  $("model").value = PROVIDERS.openai.defaultModel;
  $("provider").addEventListener("change", () => { $("model").value = PROVIDERS[$("provider").value].defaultModel; });
  try { $("key").value = sessionStorage.getItem(KEY_NAME) || ""; } catch {}
  $("key").addEventListener("input", () => { try { sessionStorage.setItem(KEY_NAME, $("key").value.trim()); } catch {} });
}
const settings = () => ({ provider: $("provider").value, model: $("model").value.trim(), apiKey: $("key").value.trim() });

function status(text, isError = false) { $("status").textContent = text; $("status").classList.toggle("error", isError); }
function busy(on) { document.querySelectorAll("button").forEach((b) => { b.disabled = on; }); }

// ---------- flows ----------
async function runLive(idea, previous = null) {
  const s = settings();
  if (!s.apiKey) { $("ask").querySelector("details").open = true; return status("Pick an example, or add an API key under AI settings to test your own idea.", true); }
  busy(true); status(`Asking ${s.model} to turn that into rules...`);
  try {
    const { spec, attempts } = await translate(idea, s, previous);
    const fixed = attempts.length > 1 ? ` The engine rejected its first answer (${attempts[0].errors.join(" ")}) and it fixed it.` : "";
    await show(spec, `Live answer from ${s.model}`, idea);
    status(`Done.${fixed}`);
  } catch (e) {
    status(e.message, true);
  } finally { busy(false); }
}

async function runExample(example, label = example.idea) {
  $("idea").value = example.refines == null ? example.idea : examples[example.refines].idea;
  busy(true); status("Running the backtest in your browser...");
  try {
    await show(example.spec, `Recorded answer from ${example.model}, ${example.recordedAt}`, label);
    status("Done. The AI's answer was recorded ahead of time; the backtest above just ran live in your browser.");
  } catch (e) { status(e.message, true); } finally { busy(false); }
}

async function show(spec, source, idea) {
  current = { spec, idea };
  $("results").hidden = false;
  $("source").textContent = source;
  const ok = spec.supported;
  $("unsupported").hidden = ok;
  $("analysis").hidden = !ok;
  for (const id of ["spec-rules", "spec-assumptions"]) $(id).replaceChildren();
  $("spec-json").textContent = JSON.stringify(spec, null, 2);
  if (!ok) {
    $("spec-name").textContent = "Can't test this one honestly";
    $("spec-summary").textContent = "";
    $("unsupported-reason").textContent = spec.reason;
    $("unsupported-closest").textContent = spec.closest ? `Closest testable version: ${spec.closest}` : "";
    $("spec-rules").append(el("li", { textContent: "None. The AI refused instead of guessing, which is the right call when the data isn't there." }));
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  $("spec-name").textContent = spec.name;
  $("spec-summary").textContent = spec.summary;
  describe(spec).forEach((line) => $("spec-rules").append(el("li", { textContent: line })));
  const assumptions = spec.assumptions?.length ? spec.assumptions : ["None stated."];
  assumptions.forEach((a) => $("spec-assumptions").append(el("li", { textContent: a })));
  const result = await renderAnalysis();
  versions.push({ idea, spec, result });
  renderVersions();
  $("results").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function renderAnalysis() {
  const { spec } = current;
  const data = await loadData(spec);
  const costPct = Math.min(Math.max(Number($("cost").value) || 0, 0), 5);
  const r = analyze(data, spec, { costPct });
  renderMetrics(r, spec);
  $("chart").innerHTML = chartSvg(data.dates, r.run.equity, r.holdEquity);
  $("checks").replaceChildren(...r.checks.map((c) => el("li", { className: "check" },
    el("span", { className: `badge badge--${c.status}`, textContent: c.status }),
    el("div", {}, el("strong", { textContent: c.name }), el("p", { textContent: c.detail })))));
  renderTable($("regimes"), ["Regime", "Dates", "Strategy", "Buy and hold", "Beat holding?"],
    r.regimes.map((g) => [g.name, `${g.start} to ${g.end}`, pct(g.strategyPct), pct(g.holdPct), g.strategyPct > g.holdPct ? "Yes" : "No"]), [2, 3]);
  $("trades-summary").textContent = `Every trade (${r.tradeCount})`;
  renderTable($("trades"), ["#", "Bought", "Buy price", "Sold", "Sell price", "Days", "Return", "Why sold"],
    r.run.trades.map((t, i) => [i + 1, t.entryDate, t.entryPrice.toFixed(2), t.exitDate, t.exitPrice.toFixed(2), t.days, pct(t.returnPct), t.reason]), [0, 2, 4, 5, 6]);
  return r;
}

function renderMetrics(r, spec) {
  const s = r.strategy, h = r.hold, money = (x) => `$${Math.round(10000 * (1 + x / 100)).toLocaleString("en-US")}`;
  const items = [
    [pct(s.totalPct, 0), `total return · holding ${spec.ticker}: ${pct(h.totalPct, 0)}`, s.totalPct],
    [money(s.totalPct), `$10,000 became · holding: ${money(h.totalPct)}`, s.totalPct],
    [pct(s.cagrPct), `per year · holding: ${pct(h.cagrPct)}`, s.cagrPct],
    [pct(s.maxDrawdownPct), `worst drop · holding: ${pct(h.maxDrawdownPct)}`, -1],
    [s.sharpe.toFixed(2), `Sharpe (return per unit of bumpiness) · holding: ${h.sharpe.toFixed(2)}`, 0],
    [String(r.tradeCount), `trades · ${r.winRatePct.toFixed(0)}% made money · invested ${r.timeInMarketPct.toFixed(0)}% of days`, 0],
  ];
  $("metrics").replaceChildren(...items.map(([big, small, sign]) => el("div", { className: "metric" },
    el("b", { textContent: big, className: sign > 0 ? "up" : sign < 0 ? "down" : "" }), el("span", { textContent: small }))));
}

function renderTable(table, head, rows, numericCols) {
  const cell = (tag, v, i) => el(tag, { textContent: String(v), className: numericCols.includes(i) ? "num" : "" });
  table.replaceChildren(el("thead", {}, el("tr", {}, ...head.map((h, i) => cell("th", h, i)))),
    el("tbody", {}, ...rows.map((row) => el("tr", {}, ...row.map((v, i) => cell("td", v, i))))));
}

function renderVersions() {
  renderTable($("versions"), ["Version", "Idea", "Return", "Holding", "Worst drop", "Sharpe", "Luck test"],
    versions.map((v, i) => [`v${i + 1}`, v.idea.length > 48 ? `${v.idea.slice(0, 47)}…` : v.idea, pct(v.result.strategy.totalPct, 0), pct(v.result.hold.totalPct, 0),
      pct(v.result.strategy.maxDrawdownPct, 0), v.result.strategy.sharpe.toFixed(2), v.result.luck ? `${(v.result.luck.shareAsGood * 100).toFixed(1)}% as good` : "n/a"]), [2, 3, 4, 5, 6]);
}

// Growth of $10,000 on a log scale, so a 2x move looks the same size in 2006 and in 2026.
function chartSvg(dates, a, b) {
  const W = 900, H = 300, L = 54, R = 10, T = 10, B = 24, n = dates.length;
  let lo = Infinity, hi = -Infinity;
  for (const v of [...a, ...b]) { const g = Math.log(v); lo = Math.min(lo, g); hi = Math.max(hi, g); }
  if (hi - lo < 1e-9) hi = lo + 1;
  const x = (i) => L + (i / (n - 1)) * (W - L - R), y = (v) => T + ((hi - Math.log(v)) / (hi - lo)) * (H - T - B);
  const step = Math.max(1, Math.floor(n / 700)), line = (s) => {
    let d = ""; for (let i = 0; i < n; i += step) d += `${x(i).toFixed(1)},${y(s[i]).toFixed(1)} `;
    return d + `${x(n - 1).toFixed(1)},${y(s[n - 1]).toFixed(1)}`;
  };
  const factor = hi - lo > Math.log(64) ? 10 : 2, grid = [];
  for (let v = factor ** Math.floor(lo / Math.log(factor)); v <= Math.exp(hi) * 1.0001; v *= factor) {
    if (Math.log(v) < lo - 1e-9) continue;
    const label = (v * 10000) >= 1e6 ? `$${+(v * 10000 / 1e6).toPrecision(3)}M` : `$${+(v * 10000 / 1e3).toPrecision(3)}k`;
    grid.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${label}</text>`);
  }
  const years = [], span = Number(dates[n - 1].slice(0, 4)) - Number(dates[0].slice(0, 4)), every = span > 12 ? 4 : span > 6 ? 2 : 1;
  for (let i = 1; i < n; i++) {
    const yr = Number(dates[i].slice(0, 4));
    if (yr !== Number(dates[i - 1].slice(0, 4)) && yr % every === 0) years.push(`<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${yr}</text>`);
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Growth of $10,000: strategy versus buy and hold">${grid.join("")}${years.join("")}<polyline class="hold" points="${line(b)}"/><polyline class="strategy" points="${line(a)}"/></svg>`;
}

// ---------- wiring ----------
initSettings();
$("ask").addEventListener("submit", (e) => {
  e.preventDefault();
  const idea = $("idea").value.trim();
  if (!idea) return status("Type an idea first, or pick an example.", true);
  const example = examples.find((x) => x.idea.toLowerCase() === idea.toLowerCase() && x.refines == null);
  example ? runExample(example) : runLive(idea);
});
$("refine").addEventListener("submit", (e) => {
  e.preventDefault();
  const tweak = $("tweak").value.trim();
  if (!tweak) return status("Describe the change first, for example: add a 10% stop-loss.", true);
  if (!current?.spec.supported) return status("Test a supported idea first, then change it.", true);
  runLive(tweak, current.spec);
});
$("cost").addEventListener("change", () => { if (current?.spec.supported) renderAnalysis().catch((e) => status(e.message, true)); });

fetch("data/examples.json").then((r) => r.json()).then((list) => {
  examples = list;
  for (const ex of list) {
    const label = ex.refines == null ? ex.idea : `${list[ex.refines].idea}, then: "${ex.idea}"`;
    $("examples").append(el("button", { type: "button", className: "chip", textContent: label, onclick: () => runExample(ex, label) }));
  }
}).catch(() => status("Could not load the example ideas.", true));
