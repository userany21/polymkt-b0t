import express, { Request, Response } from 'express';
import * as dotenv from 'dotenv';
dotenv.config();

import fetchData from '../utils/fetchData';
import getMyBalance from '../utils/getMyBalance';
import { ENV } from '../config/env';

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;
const PROXY_WALLET = ENV.PROXY_WALLET;
const CACHE_TTL = 5000; // 5 seconds

interface Position {
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    initialValue: number;
    currentValue: number;
    cashPnl: number;
    percentPnl: number;
    totalBought: number;
    realizedPnl: number;
    curPrice: number;
    title?: string;
    slug?: string;
    outcome?: string;
}

interface Activity {
    proxyWallet: string;
    timestamp: number;
    conditionId: string;
    type: string;
    size: number;
    usdcSize: number;
    transactionHash: string;
    price: number;
    asset: string;
    side: 'BUY' | 'SELL';
    title?: string;
    outcome?: string;
}

interface CacheEntry {
    data: unknown;
    timestamp: number;
}

let cache: CacheEntry | null = null;

app.get('/api/stats', async (_req: Request, res: Response) => {
    try {
        const now = Date.now();
        if (cache && now - cache.timestamp < CACHE_TTL) {
            return res.json(cache.data);
        }

        const [balance, positions, activities] = await Promise.all([
            getMyBalance(PROXY_WALLET),
            fetchData(`https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`),
            fetchData(
                `https://data-api.polymarket.com/activity?user=${PROXY_WALLET}&type=TRADE&limit=20`
            ),
        ]);

        const data = {
            balance,
            positions: (positions as Position[]) || [],
            activities: (activities as Activity[]) || [],
            wallet: PROXY_WALLET,
            fetchedAt: now,
        };

        cache = { data, timestamp: now };
        return res.json(data);
    } catch (error) {
        return res.status(500).json({ error: String(error) });
    }
});

app.get('/', (_req: Request, res: Response) => {
    res.send(getDashboardHTML());
});

app.listen(PORT, () => {
    console.log(`\n🚀 Dashboard running at http://localhost:${PORT}`);
    console.log(`📍 Wallet: ${PROXY_WALLET}`);
    console.log(`🔄 Data refreshes every 5 seconds\n`);
    console.log('Press Ctrl+C to stop the dashboard\n');
});

function getDashboardHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Polymarket Bot Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: #0d0f14;
      color: #e2e8f0;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      min-height: 100vh;
    }

    header {
      background: #13161e;
      border-bottom: 1px solid #1e2330;
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 18px;
      font-weight: 700;
      color: #fff;
    }

    .logo span { color: #6366f1; }

    .header-right {
      display: flex;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
    }

    .wallet-badge {
      background: #1e2330;
      border: 1px solid #2a2f3e;
      border-radius: 8px;
      padding: 6px 12px;
      font-size: 12px;
      color: #94a3b8;
      font-family: monospace;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #22c55e;
      display: inline-block;
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    .last-updated {
      font-size: 12px;
      color: #64748b;
    }

    main { padding: 24px; max-width: 1400px; margin: 0 auto; }

    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 28px;
    }

    .card {
      background: #13161e;
      border: 1px solid #1e2330;
      border-radius: 12px;
      padding: 20px;
    }

    .card-label {
      font-size: 12px;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 8px;
    }

    .card-value {
      font-size: 26px;
      font-weight: 700;
      color: #fff;
    }

    .card-value.positive { color: #22c55e; }
    .card-value.negative { color: #ef4444; }
    .card-value.neutral  { color: #94a3b8; }

    .card-sub {
      font-size: 12px;
      color: #64748b;
      margin-top: 4px;
    }

    section {
      background: #13161e;
      border: 1px solid #1e2330;
      border-radius: 12px;
      margin-bottom: 24px;
      overflow: hidden;
    }

    .section-header {
      padding: 16px 20px;
      border-bottom: 1px solid #1e2330;
      font-size: 14px;
      font-weight: 600;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .table-wrap { overflow-x: auto; }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    thead th {
      background: #0d0f14;
      padding: 10px 16px;
      text-align: left;
      font-size: 11px;
      font-weight: 600;
      color: #475569;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      white-space: nowrap;
    }

    tbody tr {
      border-bottom: 1px solid #1a1e2b;
      transition: background 0.1s;
    }

    tbody tr:last-child { border-bottom: none; }
    tbody tr:hover { background: #171b26; }

    tbody td {
      padding: 12px 16px;
      vertical-align: middle;
      white-space: nowrap;
    }

    .market-name {
      max-width: 280px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #e2e8f0;
    }

    .outcome-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
    }

    .outcome-yes { background: rgba(34,197,94,0.15); color: #22c55e; }
    .outcome-no  { background: rgba(239,68,68,0.15);  color: #ef4444; }
    .outcome-other { background: rgba(99,102,241,0.15); color: #818cf8; }

    .side-buy  { color: #22c55e; font-weight: 600; }
    .side-sell { color: #ef4444; font-weight: 600; }

    .pnl-positive { color: #22c55e; }
    .pnl-negative { color: #ef4444; }

    .mono { font-family: monospace; color: #94a3b8; font-size: 12px; }

    .empty-state {
      padding: 40px;
      text-align: center;
      color: #475569;
      font-size: 14px;
    }

    .loader {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 60px;
      color: #475569;
      gap: 10px;
    }

    .spinner {
      width: 20px; height: 20px;
      border: 2px solid #1e2330;
      border-top-color: #6366f1;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .error-banner {
      background: rgba(239,68,68,0.1);
      border: 1px solid rgba(239,68,68,0.3);
      border-radius: 8px;
      padding: 12px 16px;
      color: #f87171;
      font-size: 13px;
      margin-bottom: 24px;
      display: none;
    }
  </style>
</head>
<body>

<header>
  <div class="logo">
    <span>◆</span> Polymarket Bot
  </div>
  <div class="header-right">
    <div class="wallet-badge" id="wallet-addr">Loading...</div>
    <span class="status-dot" id="status-dot"></span>
    <span class="last-updated" id="last-updated">Fetching...</span>
  </div>
</header>

<main>
  <div class="error-banner" id="error-banner"></div>

  <div id="content">
    <div class="loader"><div class="spinner"></div> Loading dashboard...</div>
  </div>
</main>

<script>
  let firstLoad = true;

  function fmt(n) {
    if (n === null || n === undefined || isNaN(n)) return '$0.00';
    const abs = Math.abs(n);
    const str = abs.toFixed(2).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
    return (n < 0 ? '-$' : '$') + str;
  }

  function fmtPct(n) {
    if (n === null || n === undefined || isNaN(n)) return '0.00%';
    return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  function pnlClass(n) {
    return n >= 0 ? 'pnl-positive' : 'pnl-negative';
  }

  function outcomeClass(outcome) {
    if (!outcome) return 'outcome-other';
    const lower = outcome.toLowerCase();
    if (lower === 'yes') return 'outcome-yes';
    if (lower === 'no')  return 'outcome-no';
    return 'outcome-other';
  }

  function timeAgo(ts) {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60)   return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  function render(data) {
    const positions = data.positions || [];
    const activities = data.activities || [];

    document.getElementById('wallet-addr').textContent =
      data.wallet.slice(0, 6) + '...' + data.wallet.slice(-4);

    document.getElementById('last-updated').textContent =
      'Updated ' + timeAgo(data.fetchedAt);

    const totalValue    = positions.reduce((s, p) => s + (p.currentValue || 0), 0);
    const totalInitial  = positions.reduce((s, p) => s + (p.initialValue || 0), 0);
    const unrealizedPnl = positions.reduce((s, p) => s + (p.cashPnl || 0), 0);
    const realizedPnl   = positions.reduce((s, p) => s + (p.realizedPnl || 0), 0);
    const unrealizedPct = totalInitial > 0 ? (unrealizedPnl / totalInitial) * 100 : 0;

    const positionsHTML = positions.length === 0
      ? '<div class="empty-state">No open positions</div>'
      : \`<div class="table-wrap"><table>
          <thead><tr>
            <th>Market</th>
            <th>Outcome</th>
            <th>Shares</th>
            <th>Avg Price</th>
            <th>Cur Price</th>
            <th>Value</th>
            <th>P&L</th>
            <th>P&L %</th>
          </tr></thead>
          <tbody>
            \${positions
              .sort((a, b) => (b.currentValue || 0) - (a.currentValue || 0))
              .map(p => \`<tr>
                <td><div class="market-name" title="\${p.title || ''}">\${p.title || 'Unknown'}</div></td>
                <td><span class="outcome-badge \${outcomeClass(p.outcome)}">\${p.outcome || 'N/A'}</span></td>
                <td class="mono">\${(p.size || 0).toFixed(2)}</td>
                <td class="mono">$\${(p.avgPrice || 0).toFixed(3)}</td>
                <td class="mono">$\${(p.curPrice || 0).toFixed(3)}</td>
                <td class="mono">\${fmt(p.currentValue)}</td>
                <td class="\${pnlClass(p.cashPnl)}">\${fmt(p.cashPnl)}</td>
                <td class="\${pnlClass(p.percentPnl)}">\${fmtPct(p.percentPnl)}</td>
              </tr>\`).join('')}
          </tbody>
        </table></div>\`;

    const tradesHTML = activities.length === 0
      ? '<div class="empty-state">No recent trades</div>'
      : \`<div class="table-wrap"><table>
          <thead><tr>
            <th>Time</th>
            <th>Market</th>
            <th>Outcome</th>
            <th>Side</th>
            <th>Volume</th>
            <th>Price</th>
            <th>TX</th>
          </tr></thead>
          <tbody>
            \${activities.map(t => \`<tr>
              <td class="mono">\${timeAgo(t.timestamp * 1000)}</td>
              <td><div class="market-name" title="\${t.title || ''}">\${t.title || 'Unknown'}</div></td>
              <td><span class="outcome-badge \${outcomeClass(t.outcome)}">\${t.outcome || 'N/A'}</span></td>
              <td class="\${t.side === 'BUY' ? 'side-buy' : 'side-sell'}">\${t.side}</td>
              <td class="mono">\${fmt(t.usdcSize)}</td>
              <td class="mono">$\${(t.price || 0).toFixed(3)}</td>
              <td class="mono"><a href="https://polygonscan.com/tx/\${t.transactionHash}" target="_blank" style="color:#6366f1;text-decoration:none;">\${t.transactionHash.slice(0,8)}…</a></td>
            </tr>\`).join('')}
          </tbody>
        </table></div>\`;

    document.getElementById('content').innerHTML = \`
      <div class="cards">
        <div class="card">
          <div class="card-label">USDC Balance</div>
          <div class="card-value">\${fmt(data.balance)}</div>
          <div class="card-sub">Available to trade</div>
        </div>
        <div class="card">
          <div class="card-label">Portfolio Value</div>
          <div class="card-value">\${fmt(totalValue)}</div>
          <div class="card-sub">\${positions.length} open position\${positions.length !== 1 ? 's' : ''}</div>
        </div>
        <div class="card">
          <div class="card-label">Unrealized P&L</div>
          <div class="card-value \${pnlClass(unrealizedPnl)}">\${fmt(unrealizedPnl)}</div>
          <div class="card-sub">\${fmtPct(unrealizedPct)}</div>
        </div>
        <div class="card">
          <div class="card-label">Realized P&L</div>
          <div class="card-value \${pnlClass(realizedPnl)}">\${fmt(realizedPnl)}</div>
          <div class="card-sub">Closed positions</div>
        </div>
        <div class="card">
          <div class="card-label">Total Invested</div>
          <div class="card-value neutral">\${fmt(totalInitial)}</div>
          <div class="card-sub">Initial position cost</div>
        </div>
      </div>

      <section>
        <div class="section-header">Open Positions (\${positions.length})</div>
        \${positionsHTML}
      </section>

      <section>
        <div class="section-header">Recent Trades (last 20)</div>
        \${tradesHTML}
      </section>
    \`;
  }

  async function fetchStats() {
    try {
      const res = await fetch('/api/stats');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      document.getElementById('error-banner').style.display = 'none';
      document.getElementById('status-dot').style.background = '#22c55e';
      render(data);
      firstLoad = false;
    } catch (err) {
      document.getElementById('status-dot').style.background = '#ef4444';
      const banner = document.getElementById('error-banner');
      banner.style.display = 'block';
      banner.textContent = '⚠ Failed to fetch data: ' + err.message;
      if (firstLoad) {
        document.getElementById('content').innerHTML =
          '<div class="empty-state">Could not load data. Retrying...</div>';
      }
    }
  }

  fetchStats();
  setInterval(fetchStats, 5000);
</script>
</body>
</html>`;
}
