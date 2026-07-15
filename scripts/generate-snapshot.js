// generate-snapshot.js
// Runs server-side in GitHub Actions — no CORS issues here!
// Fetches Yahoo Finance directly (no proxy needed server-side)

const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const fs = require('fs');

const TICKERS = [
  {t:'NVDA',n:'NVIDIA'},{t:'AVGO',n:'Broadcom'},{t:'AMD',n:'Advanced Micro Devices'},
  {t:'MU',n:'Micron Technology'},{t:'TSM',n:'Taiwan Semiconductor'},{t:'INTC',n:'Intel'},
  {t:'KLAC',n:'KLA Corporation'},{t:'LRCX',n:'Lam Research'},{t:'LSCC',n:'Lattice Semiconductor'},
  {t:'AMAT',n:'Applied Materials'},{t:'ASX',n:'ASE Technology'},{t:'QCOM',n:'Qualcomm'},
  {t:'MRVL',n:'Marvell Technology'},{t:'CRS',n:'Carpenter Technology'},{t:'CAMT',n:'Camtek'},
  {t:'CAT',n:'Caterpillar'},{t:'EME',n:'EMCOR Group'},{t:'FIX',n:'Comfort Systems USA'},
  {t:'FN',n:'Fabrinet'},{t:'AXON',n:'Axon Enterprise'},{t:'NVMI',n:'Nova Ltd'},
  {t:'PWR',n:'Quanta Services'},{t:'SNEX',n:'StoneX Group'},{t:'SPXC',n:'SPX Technologies'},
  {t:'STRL',n:'Sterling Infrastructure'},{t:'ASML',n:'ASML Holding'},{t:'ANET',n:'Arista Networks'},
  {t:'LLY',n:'Eli Lilly'},{t:'GE',n:'GE Aerospace'},{t:'HWM',n:'Howmet Aerospace'},
  {t:'BE',n:'Bloom Energy'},{t:'VRT',n:'Vertiv Holdings'},{t:'ARM',n:'ARM Holdings'},
  {t:'GEV',n:'GE Vernova'}
];

async function fetchQuote(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=2y`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('No result');

    const meta = result.meta;
    const price = meta.regularMarketPrice;

    const closes = result.indicators?.quote?.[0]?.close || [];
    const timestamps = result.timestamp || [];
    const valid = closes.map((c,i) => ({c, t: timestamps[i]})).filter(x => x.c != null);
    const n = valid.length;

    // FIX: chartPreviousClose is unreliable over long ranges — use the actual
    // second-to-last daily close from the price array instead
    const actualPrevClose = n >= 2 ? valid[n - 2].c : (meta.chartPreviousClose || meta.previousClose);
    const todayPct = actualPrevClose ? ((price - actualPrevClose) / actualPrevClose * 100) : null;

    function pctFrom(days) {
      if (n < days + 1) return null;
      const old = valid[n - 1 - days]?.c;
      return old ? ((price - old) / old * 100) : null;
    }

    return {
      ticker,
      price,
      todayPct,
      week1: pctFrom(5),
      week2: pctFrom(10),
      month1: pctFrom(21),
      week6: pctFrom(30),
      month3: pctFrom(63),
      month6: pctFrom(126),
      ttm: pctFrom(252)
    };
  } catch(e) {
    console.error(`Failed ${ticker}:`, e.message);
    return { ticker, price: null, todayPct: null, week1: null, week2: null, month1: null, week6: null, month3: null, month6: null, ttm: null };
  }
}

async function fetchEarnings(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=earningsHistory`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });
    if (!res.ok) return { status: 'inline' };
    const data = await res.json();
    const hist = data?.quoteSummary?.result?.[0]?.earningsHistory?.history;
    if (!hist || !hist.length) return { status: 'inline' };

    const latest = hist[hist.length - 1];
    const est = latest?.epsEstimate?.raw;
    const act = latest?.epsActual?.raw;
    const surp = latest?.surprisePercent?.raw;
    const quarter = latest?.period || '';
    if (est == null || act == null) return { status: 'inline' };

    let status = 'inline';
    if (surp != null) { if (surp > 3) status = 'beat'; else if (surp < -3) status = 'miss'; }
    else { if (act > est * 1.03) status = 'beat'; else if (act < est * 0.97) status = 'miss'; }

    return { status, quarter, epsEstimate: est?.toFixed(2), epsActual: act?.toFixed(2), surprisePct: surp?.toFixed(1) };
  } catch(e) { return { status: 'inline' }; }
}

function calcMomentum(d) {
  if (!d) return { losing: false, score: 0, signals: [] };
  const { todayPct: today, week1, month1, month3, month6, ttm } = d;
  const signals = [];
  let count = 0;
  if (week1 != null && month1 != null && week1 < month1 - 5) { signals.push({ label: '1wk vs 1mo', short: week1, long: month1 }); count++; }
  if (month1 != null && month3 != null && month1 < month3 - 8) { signals.push({ label: '1mo vs 3mo', short: month1, long: month3 }); count++; }
  if (today != null && week1 != null && today < -1 && week1 < -2) { signals.push({ label: 'Near-term', short: today, long: week1 }); count++; }
  if (ttm != null && month1 != null && ttm > 20 && month1 < -5) { signals.push({ label: 'TTM vs 1mo', short: month1, long: ttm }); count++; }
  return { losing: count >= 2, score: count, signals };
}

function fmtPct(v) {
  if (v == null) return '<span style="color:#64748b">–</span>';
  const color = v > 0 ? '#10b981' : v < 0 ? '#ef4444' : '#94a3b8';
  return `<span style="color:${color};font-weight:600">${v > 0 ? '+' : ''}${v.toFixed(2)}%</span>`;
}

function fmtPrice(v) {
  if (v == null) return '–';
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function generateHTML(quotes, earnings, momentums, snapshotDate) {
  const rows = TICKERS.map(tk => {
    const d = quotes[tk.t] || {};
    const e = earnings[tk.t] || { status: 'inline' };
    const m = momentums[tk.t] || { losing: false, score: 0 };

    const earnClass = e.status === 'beat' ? 'beat' : e.status === 'miss' ? 'miss' : '';
    const momClass = m.losing ? 'mom-loss' : '';
    const tickerColor = m.losing ? '#f97316' : '#60a5fa';
    const tickerBg = m.losing ? 'rgba(249,115,22,0.15)' : 'rgba(59,130,246,0.12)';
    const tickerBorder = m.losing ? 'rgba(249,115,22,0.4)' : 'rgba(59,130,246,0.25)';

    const earnBadge = e.status === 'beat'
      ? '<span style="background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.3);color:#10b981;border-radius:5px;font-size:10px;font-weight:700;padding:2px 7px">✦ BEAT</span>'
      : e.status === 'miss'
      ? '<span style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#ef4444;border-radius:5px;font-size:10px;font-weight:700;padding:2px 7px">✗ MISS</span>'
      : '<span style="background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);color:#f59e0b;border-radius:5px;font-size:10px;font-weight:700;padding:2px 7px">~ Inline</span>';

    const momBadge = m.losing
      ? '<span style="background:rgba(249,115,22,0.12);border:1px solid rgba(249,115,22,0.3);color:#f97316;border-radius:5px;font-size:10px;font-weight:700;padding:2px 7px">⬇ Fading</span>'
      : '<span style="background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.3);color:#10b981;border-radius:5px;font-size:10px;font-weight:700;padding:2px 7px">↑ Strong</span>';

    let rowStyle = 'background:#111827;';
    if (earnClass === 'beat') rowStyle = 'background:linear-gradient(90deg,rgba(16,185,129,0.09) 0%,#111827 35%);border-left:3px solid #10b981;';
    else if (earnClass === 'miss') rowStyle = 'background:linear-gradient(90deg,rgba(239,68,68,0.07) 0%,#111827 35%);border-left:3px solid #ef4444;';
    else if (momClass === 'mom-loss') rowStyle = 'background:linear-gradient(90deg,rgba(249,115,22,0.08) 0%,#111827 35%);border-left:3px solid #f97316;';

    return `<tr style="${rowStyle}">
      <td style="padding:11px 14px;border-bottom:1px solid rgba(99,179,237,0.1);">
        <div style="display:flex;align-items:center;gap:9px;">
          <span style="background:${tickerBg};border:1px solid ${tickerBorder};border-radius:5px;font-weight:700;font-size:11px;color:${tickerColor};padding:3px 7px;min-width:50px;text-align:center;letter-spacing:.4px">${tk.t}</span>
          <span style="font-size:11px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px">${tk.n}</span>
        </div>
      </td>
      <td style="padding:11px 12px;text-align:right;border-bottom:1px solid rgba(99,179,237,0.1);font-weight:600;color:#e8f0fe">${fmtPrice(d.price)}</td>
      <td style="padding:11px 12px;text-align:right;border-bottom:1px solid rgba(99,179,237,0.1)">${fmtPct(d.todayPct)}</td>
      <td style="padding:11px 12px;text-align:right;border-bottom:1px solid rgba(99,179,237,0.1)">${fmtPct(d.week1)}</td>
      <td style="padding:11px 12px;text-align:right;border-bottom:1px solid rgba(99,179,237,0.1)">${fmtPct(d.week2)}</td>
      <td style="padding:11px 12px;text-align:right;border-bottom:1px solid rgba(99,179,237,0.1)">${fmtPct(d.month1)}</td>
      <td style="padding:11px 12px;text-align:right;border-bottom:1px solid rgba(99,179,237,0.1)">${fmtPct(d.week6)}</td>
      <td style="padding:11px 12px;text-align:right;border-bottom:1px solid rgba(99,179,237,0.1)">${fmtPct(d.month3)}</td>
      <td style="padding:11px 12px;text-align:right;border-bottom:1px solid rgba(99,179,237,0.1)">${fmtPct(d.month6)}</td>
      <td style="padding:11px 12px;text-align:right;border-bottom:1px solid rgba(99,179,237,0.1)">${fmtPct(d.ttm)}</td>
      <td style="padding:11px 12px;text-align:right;border-bottom:1px solid rgba(99,179,237,0.1)">${momBadge}</td>
      <td style="padding:11px 12px;text-align:right;border-bottom:1px solid rgba(99,179,237,0.1)">${earnBadge}</td>
    </tr>`;
  }).join('');

  const beats = Object.values(earnings).filter(e => e?.status === 'beat').length;
  const misses = Object.values(earnings).filter(e => e?.status === 'miss').length;
  const fading = Object.values(momentums).filter(m => m?.losing).length;
  const todays = Object.values(quotes).map(d => d.todayPct).filter(v => v != null);
  const avgToday = todays.length ? todays.reduce((a,b) => a+b, 0) / todays.length : null;
  const top = TICKERS.filter(t => quotes[t.t]?.todayPct != null).sort((a,b) => (quotes[b.t]?.todayPct||0) - (quotes[a.t]?.todayPct||0))[0];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="LT35">
<meta name="theme-color" content="#0a0e1a">
<title>Long Term 35 — ${snapshotDate}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:#0a0e1a;color:#e8f0fe;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;font-size:14px;}
  .header{background:#0d1b2e;border-bottom:1px solid rgba(99,179,237,0.12);padding:18px 28px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;}
  .logo{width:38px;height:38px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;color:#fff;flex-shrink:0;}
  .stats{display:flex;gap:1px;background:rgba(99,179,237,0.12);border-bottom:1px solid rgba(99,179,237,0.12);}
  .stat{flex:1;background:#111827;padding:14px 20px;}
  .stat-label{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;}
  .stat-value{font-size:20px;font-weight:700;}
  .legend{display:flex;gap:20px;padding:9px 28px;background:#111827;border-bottom:1px solid rgba(99,179,237,0.12);flex-wrap:wrap;align-items:center;font-size:11px;color:#64748b;}
  .legend-dot{width:10px;height:10px;border-radius:2px;display:inline-block;margin-right:5px;}
  .table-wrap{padding:16px 28px 48px;overflow-x:auto;}
  table{width:100%;border-collapse:separate;border-spacing:0 4px;min-width:960px;}
  thead th{background:#111827;font-size:10px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.5px;padding:9px 12px;text-align:right;border-bottom:1px solid rgba(99,179,237,0.12);white-space:nowrap;}
  thead th:first-child{text-align:left;}
  .snapshot-badge{background:rgba(139,92,246,0.15);border:1px solid rgba(139,92,246,0.3);color:#a78bfa;border-radius:6px;font-size:11px;padding:4px 10px;font-weight:600;}
  @media(max-width:700px){
    .header{padding:12px 14px;}
    .stats{flex-wrap:wrap;}
    .stat{min-width:50%;}
    .table-wrap{padding:12px 12px 40px;}
    .legend{display:none;}
  }
</style>
</head>
<body>
<div class="header">
  <div style="display:flex;align-items:center;gap:14px;">
    <div class="logo">L35</div>
    <div>
      <div style="font-size:17px;font-weight:700;">Long Term 35 Portfolio</div>
      <div style="font-size:11px;color:#64748b;margin-top:2px;">End-of-day snapshot · ${snapshotDate} · Data from Yahoo Finance</div>
    </div>
  </div>
  <div style="display:flex;align-items:center;gap:10px;">
    <span class="snapshot-badge">📸 Snapshot</span>
    <a href="./index.html" style="background:rgba(139,92,246,0.2);border:1px solid rgba(139,92,246,0.4);color:#a78bfa;text-decoration:none;border-radius:6px;font-size:11px;font-weight:700;padding:4px 12px;white-space:nowrap;">⚡ Live Dashboard + Analysis →</a>
  </div>
</div>

<div class="stats">
  <div class="stat"><div class="stat-label">Stocks</div><div class="stat-value">${TICKERS.length}</div></div>
  <div class="stat"><div class="stat-label">Avg today</div><div class="stat-value" style="color:${avgToday==null?'#e8f0fe':avgToday>0?'#10b981':'#ef4444'}">${avgToday!=null?(avgToday>0?'+':'')+avgToday.toFixed(2)+'%':'–'}</div></div>
  <div class="stat"><div class="stat-label">Earnings beats</div><div class="stat-value" style="color:#10b981">${beats||'–'}</div></div>
  <div class="stat"><div class="stat-label">Earnings misses</div><div class="stat-value" style="color:#ef4444">${misses||'–'}</div></div>
  <div class="stat"><div class="stat-label">Losing momentum</div><div class="stat-value" style="color:#f97316">${fading||'–'}</div></div>
  <div class="stat"><div class="stat-label">Top performer</div><div class="stat-value" style="color:#10b981;font-size:14px">${top?`${top.t} +${quotes[top.t].todayPct.toFixed(2)}%`:'–'}</div><div style="font-size:10px;color:#64748b;margin-top:2px">${top?.n||''}</div></div>
</div>

<div style="background:rgba(139,92,246,0.08);border-bottom:1px solid rgba(139,92,246,0.2);padding:10px 28px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
  <span style="font-size:12px;color:#a78bfa;">⚡ Want full earnings analysis &amp; momentum breakdowns? Open the live dashboard and click any stock.</span>
  <a href="./index.html" style="background:rgba(139,92,246,0.25);border:1px solid rgba(139,92,246,0.4);color:#a78bfa;text-decoration:none;border-radius:6px;font-size:11px;font-weight:700;padding:5px 14px;white-space:nowrap;">Open Live Dashboard →</a>
</div>

<div class="legend">
  <span><span class="legend-dot" style="background:#10b981"></span>Earnings beat</span>
  <span><span class="legend-dot" style="background:#ef4444"></span>Earnings miss</span>
  <span><span class="legend-dot" style="background:#f59e0b"></span>Inline / pending</span>
  <span><span class="legend-dot" style="background:#f97316"></span>Losing momentum</span>
  <span style="margin-left:auto">Static snapshot — data locked at market close</span>
</div>

<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>Ticker</th>
        <th>Price</th>
        <th>Today</th>
        <th>1 Week</th>
        <th>2 Weeks</th>
        <th>1 Month</th>
        <th>6 Weeks</th>
        <th>3 Months</th>
        <th>6 Months</th>
        <th>TTM</th>
        <th>Momentum</th>
        <th>Earnings</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</div>
</body>
</html>`;
}

async function main() {
  console.log('Starting portfolio snapshot generation...');
  const now = new Date();
  const snapshotDate = now.toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric', timeZone:'America/New_York' });

  // Fetch all quotes in parallel batches of 5
  console.log('Fetching stock prices...');
  const quotes = {};
  const batchSize = 5;
  for (let i = 0; i < TICKERS.length; i += batchSize) {
    const batch = TICKERS.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(tk => fetchQuote(tk.t)));
    results.forEach(r => { quotes[r.ticker] = r; });
    console.log(`Prices: ${Math.min(i + batchSize, TICKERS.length)}/${TICKERS.length}`);
    await new Promise(r => setTimeout(r, 300));
  }

  // Fetch earnings in batches of 5
  console.log('Fetching earnings...');
  const earnings = {};
  for (let i = 0; i < TICKERS.length; i += batchSize) {
    const batch = TICKERS.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(tk => fetchEarnings(tk.t)));
    results.forEach((r, idx) => { earnings[batch[idx].t] = r; });
    console.log(`Earnings: ${Math.min(i + batchSize, TICKERS.length)}/${TICKERS.length}`);
    await new Promise(r => setTimeout(r, 300));
  }

  // Calculate momentum
  console.log('Calculating momentum...');
  const momentums = {};
  TICKERS.forEach(tk => { momentums[tk.t] = calcMomentum(quotes[tk.t]); });

  // Generate HTML
  console.log('Generating snapshot HTML...');
  const html = generateHTML(quotes, earnings, momentums, snapshotDate);
  fs.writeFileSync('snapshot.html', html);
  console.log('✅ snapshot.html written successfully');
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
