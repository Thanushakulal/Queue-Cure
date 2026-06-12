let allRows = [];

function formatTime(iso) {
  if (!iso) return '--';
  try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '--';
  const m = Math.floor(seconds / 60), s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function statusBadge(status) {
  const map = {
    COMPLETED: 'badge-completed',
    SKIPPED: 'badge-skipped',
    WAITING: 'badge-waiting',
    IN_CONSULTATION: 'badge-consultation',
  };
  const labels = { COMPLETED: 'Completed', SKIPPED: 'Skipped', WAITING: 'Waiting', IN_CONSULTATION: 'In Consult' };
  return `<span class="badge ${map[status] || ''}">${labels[status] || status}</span>`;
}

async function loadHistory(query = '', status = '', date = '') {
  const tbody = document.getElementById('history-tbody');
  tbody.innerHTML = '<tr><td colspan="8" class="table-loading">Loading...</td></tr>';
  try {
    const params = new URLSearchParams();
    if (query) params.set('query', query);
    if (status) params.set('status', status);
    if (date) params.set('date', date);
    const res = await fetch(`/api/history?${params}`);
    if (!res.ok) throw new Error('Failed');
    allRows = await res.json();
    renderTable(allRows);
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="8" class="table-empty">Failed to load records. Please retry.</td></tr>';
  }
}

function renderTable(rows) {
  const tbody = document.getElementById('history-tbody');
  document.getElementById('results-count').textContent = `${rows.length} record${rows.length !== 1 ? 's' : ''} found`;
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="table-empty">No records match your search.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(p => `
    <tr>
      <td><span class="token-cell">#${p.token_number}</span></td>
      <td><span class="name-cell">${p.patient_name}</span></td>
      <td>${p.phone_number || '--'}</td>
      <td>${statusBadge(p.status)}</td>
      <td>${formatTime(p.created_at)}</td>
      <td>${formatTime(p.consultation_start)}</td>
      <td>${formatTime(p.consultation_end)}</td>
      <td><span class="duration-cell">${formatDuration(p.consultation_duration)}</span></td>
    </tr>
  `).join('');
}

function exportCSV() {
  const rows = allRows;
  if (rows.length === 0) return alert('No data to export.');
  const headers = ['Token', 'Patient Name', 'Phone', 'Status', 'Registered', 'Consult Start', 'Consult End', 'Duration (s)'];
  const csv = [headers, ...rows.map(p => [
    p.token_number, p.patient_name, p.phone_number || '',
    p.status, p.created_at || '', p.consultation_start || '',
    p.consultation_end || '', p.consultation_duration || ''
  ])].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `queue_cure_history_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function doSearch() {
  const query = document.getElementById('search-query').value.trim();
  const status = document.getElementById('filter-status').value;
  const date = document.getElementById('filter-date').value;
  loadHistory(query, status, date);
}

function clearFilters() {
  document.getElementById('search-query').value = '';
  document.getElementById('filter-status').value = '';
  document.getElementById('filter-date').value = '';
  loadHistory();
}

// WebSocket for live refresh
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}`);
  ws.onopen = () => {
    const dot = document.getElementById('sync-dot');
    dot.className = 'sync-dot connected';
    document.getElementById('sync-text').textContent = 'Live';
  };
  ws.onmessage = (evt) => {
    const data = JSON.parse(evt.data);
    if (data.event === 'QUEUE_UPDATE') doSearch();
  };
  ws.onclose = () => {
    document.getElementById('sync-dot').className = 'sync-dot';
    setTimeout(connectWS, 3000);
  };
}

document.addEventListener('DOMContentLoaded', () => {
  loadHistory();
  connectWS();
  document.getElementById('btn-search').addEventListener('click', doSearch);
  document.getElementById('btn-clear-filters').addEventListener('click', clearFilters);
  document.getElementById('btn-export-csv').addEventListener('click', exportCSV);
  document.getElementById('search-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  // Set today's date as default
  document.getElementById('filter-date').value = new Date().toISOString().slice(0, 10);
});
