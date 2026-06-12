// ─── Chart.js Shared Config ───────────────────────────────────────────────
const CHART_DEFAULTS = {
  responsive: true, maintainAspectRatio: false,
  plugins: { legend: { display: false }, tooltip: {
    backgroundColor: 'rgba(15,23,42,0.95)',
    borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1,
    titleColor: '#fff', bodyColor: '#cbd5e1',
    padding: 10, cornerRadius: 8,
  }},
  scales: {
    x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b', font: { size: 11 } } },
    y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b', font: { size: 11 } }, beginAtZero: true },
  }
};

const TEAL = 'rgba(20, 184, 166, 1)';
const TEAL_FILL = 'rgba(20, 184, 166, 0.12)';
const MINT = 'rgba(16, 185, 129, 1)';
const MINT_FILL = 'rgba(16, 185, 129, 0.12)';
const AMBER = 'rgba(245, 158, 11, 1)';
const ROSE = 'rgba(239, 68, 68, 1)';
const BLUE = 'rgba(56, 189, 248, 1)';

let charts = {};
let currentPeriod = 'today';
let ws = null;

// ─── WebSocket ─────────────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.onopen = () => { setSyncStatus(true); };
  ws.onmessage = (evt) => {
    const data = JSON.parse(evt.data);
    if (data.event === 'QUEUE_UPDATE') loadAnalytics();
  };
  ws.onclose = () => { setSyncStatus(false); setTimeout(connectWS, 3000); };
}

function setSyncStatus(ok) {
  const dot = document.getElementById('sync-dot');
  const text = document.getElementById('sync-text');
  dot.className = ok ? 'sync-dot connected' : 'sync-dot';
  text.textContent = ok ? 'Live' : 'Offline';
}

// ─── Load & Render ─────────────────────────────────────────────────────────
async function loadAnalytics() {
  try {
    const res = await fetch(`/api/analytics?period=${currentPeriod}`);
    if (!res.ok) return;
    const data = await res.json();
    renderKPIs(data.stats);
    renderVolumeChart(data.registrationsOverTime, data.completionsOverTime);
    renderOutcomesChart(data.stats);
    renderDurationChart(data.avgDurationTrend);
    renderWaitChart(data.avgWaitTrend);
    renderPeakChart(data.peakHours);
  } catch (e) { console.error('Analytics load error:', e); }
}

// ─── KPIs ──────────────────────────────────────────────────────────────────
function renderKPIs(stats) {
  if (!stats) return;
  const total = stats.total || 0;
  const completed = stats.completed || 0;
  const skipped = stats.skipped || 0;
  const rate = total > 0 ? Math.round((completed / total) * 100) : 0;
  document.getElementById('kpi-total').textContent = total;
  document.getElementById('kpi-completed').textContent = completed;
  document.getElementById('kpi-completion-rate').textContent = `${rate}%`;
  document.getElementById('kpi-skipped').textContent = skipped;
}

// ─── Chart Helpers ─────────────────────────────────────────────────────────
function makeLabels(rows, key = 'time_bucket') {
  return rows.map(r => {
    const v = r[key];
    if (!v) return '?';
    if (currentPeriod === 'today') return `${v}:00`;
    return v;
  });
}

function destroyChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }

// ─── Volume Chart ──────────────────────────────────────────────────────────
function renderVolumeChart(regs, completions) {
  destroyChart('volume');
  const allLabels = [...new Set([...regs.map(r => r.time_bucket), ...completions.map(r => r.time_bucket)])].sort();
  const regMap = Object.fromEntries(regs.map(r => [r.time_bucket, r.count]));
  const compMap = Object.fromEntries(completions.map(r => [r.time_bucket, r.count]));
  const labels = allLabels.map(l => currentPeriod === 'today' ? `${l}:00` : l);
  const ctx = document.getElementById('chart-volume').getContext('2d');
  charts.volume = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Registrations', data: allLabels.map(l => regMap[l] || 0), backgroundColor: TEAL_FILL, borderColor: TEAL, borderWidth: 2, borderRadius: 4 },
        { label: 'Completed', data: allLabels.map(l => compMap[l] || 0), backgroundColor: MINT_FILL, borderColor: MINT, borderWidth: 2, borderRadius: 4 },
      ]
    },
    options: { ...CHART_DEFAULTS, plugins: { ...CHART_DEFAULTS.plugins, legend: { display: true, labels: { color: '#94a3b8', font: { size: 11 }, boxWidth: 12, padding: 16 } } } }
  });
}

// ─── Outcomes Doughnut ─────────────────────────────────────────────────────
function renderOutcomesChart(stats) {
  destroyChart('outcomes');
  const completed = stats?.completed || 0;
  const skipped = stats?.skipped || 0;
  const waiting = stats?.waiting || 0;
  const ctx = document.getElementById('chart-outcomes').getContext('2d');
  charts.outcomes = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Completed', 'Skipped', 'Waiting'],
      datasets: [{ data: [completed, skipped, waiting], backgroundColor: [MINT, ROSE, AMBER], borderWidth: 0, hoverOffset: 6 }]
    },
    options: { responsive: true, maintainAspectRatio: false, cutout: '65%',
      plugins: { legend: { display: false }, tooltip: CHART_DEFAULTS.plugins.tooltip }
    }
  });
  document.getElementById('outcomes-legend').innerHTML = [
    { color: MINT, label: `Completed (${completed})` },
    { color: ROSE, label: `Skipped (${skipped})` },
    { color: AMBER, label: `Waiting (${waiting})` },
  ].map(i => `<div class="legend-item"><div class="legend-dot" style="background:${i.color}"></div>${i.label}</div>`).join('');
}

// ─── Duration Chart ────────────────────────────────────────────────────────
function renderDurationChart(data) {
  destroyChart('duration');
  if (!data || data.length === 0) return;
  const labels = data.map(r => currentPeriod === 'today' ? `${r.time_bucket}:00` : r.time_bucket);
  const values = data.map(r => r.avg_duration ? +r.avg_duration.toFixed(1) : 0);
  const ctx = document.getElementById('chart-duration').getContext('2d');
  charts.duration = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{ label: 'Avg Duration (min)', data: values, borderColor: BLUE, backgroundColor: 'rgba(56,189,248,0.08)', borderWidth: 2, fill: true, tension: 0.4, pointBackgroundColor: BLUE, pointRadius: 4 }]
    },
    options: CHART_DEFAULTS
  });
}

// ─── Wait Time Chart ───────────────────────────────────────────────────────
function renderWaitChart(data) {
  destroyChart('wait');
  if (!data || data.length === 0) return;
  const labels = data.map(r => currentPeriod === 'today' ? `${r.time_bucket}:00` : r.time_bucket);
  const values = data.map(r => r.avg_wait ? +r.avg_wait.toFixed(1) : 0);
  const ctx = document.getElementById('chart-wait').getContext('2d');
  charts.wait = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{ label: 'Avg Wait (min)', data: values, borderColor: AMBER, backgroundColor: 'rgba(245,158,11,0.08)', borderWidth: 2, fill: true, tension: 0.4, pointBackgroundColor: AMBER, pointRadius: 4 }]
    },
    options: CHART_DEFAULTS
  });
}

// ─── Peak Hours Chart ──────────────────────────────────────────────────────
function renderPeakChart(data) {
  destroyChart('peak');
  if (!data || data.length === 0) return;
  const allHours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
  const hourMap = Object.fromEntries(data.map(r => [r.hour, r.count]));
  const values = allHours.map(h => hourMap[h] || 0);
  const maxVal = Math.max(...values);
  const ctx = document.getElementById('chart-peak').getContext('2d');
  charts.peak = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: allHours.map(h => `${h}:00`),
      datasets: [{
        label: 'Patients', data: values,
        backgroundColor: values.map(v => v === maxVal && v > 0 ? 'rgba(20,184,166,0.7)' : 'rgba(255,255,255,0.07)'),
        borderColor: values.map(v => v === maxVal && v > 0 ? TEAL : 'rgba(255,255,255,0.1)'),
        borderWidth: 1, borderRadius: 4
      }]
    },
    options: { ...CHART_DEFAULTS, scales: { ...CHART_DEFAULTS.scales, x: { ...CHART_DEFAULTS.scales.x, ticks: { color: '#64748b', font: { size: 9 }, maxRotation: 45 } } } }
  });
}

// ─── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadAnalytics();
  connectWS();

  document.querySelectorAll('.period-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.period-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentPeriod = btn.dataset.period;
      loadAnalytics();
    });
  });
});
