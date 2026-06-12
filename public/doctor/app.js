// ─── State ─────────────────────────────────────────────────────────────────
let queueState = { waitingList: [], activePatient: null, completedList: [], stats: {}, settings: { average_consultation_time: 5 } };
let ws = null;
let reconnectTimeout = null;
let stopwatchInterval = null;
let consultationStartTime = null;

// ─── Audio ──────────────────────────────────────────────────────────────────
function playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [[659.25, 0], [880.00, 0.15]].forEach(([freq, offset]) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + offset);
      gain.gain.setValueAtTime(0, ctx.currentTime + offset);
      gain.gain.linearRampToValueAtTime(0.08, ctx.currentTime + offset + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.7);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.7);
    });
  } catch (e) {}
}

// ─── Stopwatch ─────────────────────────────────────────────────────────────
function startStopwatch(startTime) {
  stopStopwatch();
  consultationStartTime = startTime ? new Date(startTime) : new Date();
  stopwatchInterval = setInterval(updateStopwatchDisplay, 1000);
  updateStopwatchDisplay();
}

function stopStopwatch() {
  if (stopwatchInterval) { clearInterval(stopwatchInterval); stopwatchInterval = null; }
  consultationStartTime = null;
  const el = document.getElementById('stopwatch-display');
  if (el) { el.textContent = '00:00'; el.className = 'stopwatch-display'; }
}

function updateStopwatchDisplay() {
  if (!consultationStartTime) return;
  const elapsed = Math.floor((Date.now() - consultationStartTime.getTime()) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const el = document.getElementById('stopwatch-display');
  if (el) {
    el.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    el.className = `stopwatch-display running${mins >= 10 ? ' long' : ''}`;
  }
}

// ─── WebSocket ──────────────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.onopen = () => {
    setSyncStatus(true);
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
  };
  ws.onmessage = (evt) => {
    const data = JSON.parse(evt.data);
    if (data.event === 'INITIAL_STATE' || data.event === 'QUEUE_UPDATE') {
      queueState = data.state;
      renderUI();
    } else if (data.event === 'CALL_PATIENT') {
      playChime();
    }
  };
  ws.onclose = () => { setSyncStatus(false); reconnectTimeout = setTimeout(connectWS, 3000); };
}

function setSyncStatus(ok) {
  const dot = document.getElementById('sync-dot');
  const text = document.getElementById('sync-text');
  dot.className = ok ? 'sync-dot connected' : 'sync-dot';
  text.textContent = ok ? 'Live Sync' : 'Offline. Retrying...';
}

// ─── Render ──────────────────────────────────────────────────────────────────
function renderUI() {
  const avg = queueState.stats.avgDurationMinutes || queueState.settings.average_consultation_time || 5;
  const confidence = queueState.stats.predictionConfidence || 0;

  // Stats row
  document.getElementById('doc-completed').textContent = queueState.stats.completed || 0;
  document.getElementById('doc-avg-duration').textContent = avg ? `${avg} min` : '--';
  document.getElementById('doc-waiting').textContent = queueState.stats.waiting || 0;
  document.getElementById('doc-confidence').textContent = confidence ? `${confidence}%` : '--';

  // Current patient
  const active = queueState.activePatient;
  const noState = document.getElementById('no-patient-state');
  const activeState = document.getElementById('active-patient-state');
  const startBtn = document.getElementById('btn-start-consult');
  const endBtn = document.getElementById('btn-end-consult');
  const skipBtn = document.getElementById('btn-skip-consult');

  if (active) {
    noState.classList.add('hidden');
    activeState.classList.remove('hidden');
    document.getElementById('active-token-num').textContent = `#${active.token_number}`;
    document.getElementById('active-patient-name').textContent = active.patient_name;
    document.getElementById('active-patient-phone').textContent = active.phone_number || '';
    startBtn.dataset.id = active.id;
    endBtn.dataset.id = active.id;
    skipBtn.dataset.id = active.id;

    // If consultation_start is set, resume stopwatch
    if (active.consultation_start && !stopwatchInterval) {
      startStopwatch(active.consultation_start);
    } else if (!active.consultation_start && !stopwatchInterval) {
      stopStopwatch();
    }
  } else {
    noState.classList.remove('hidden');
    activeState.classList.add('hidden');
    stopStopwatch();
  }

  // Next patient preview
  const nextPatientInfo = document.getElementById('next-patient-info');
  const waiting = queueState.waitingList;
  if (waiting.length > 0) {
    const next = waiting[0];
    const estWait = (queueState.activePatient ? 1 : 0) * avg;
    nextPatientInfo.innerHTML = `
      <div class="next-patient-row">
        <div class="next-token-badge">#${next.token_number}</div>
        <div class="next-patient-details">
          <div class="next-patient-name">${next.patient_name}</div>
          <div class="next-patient-wait">${next.phone_number || ''} ${estWait > 0 ? `· ~${estWait} min wait` : '· Next up'}</div>
        </div>
      </div>
    `;
  } else {
    nextPatientInfo.innerHTML = '<div class="next-empty-msg">No patients waiting</div>';
  }

  // Queue count badge
  document.getElementById('queue-count-badge').textContent = `${waiting.length} waiting`;

  // Live queue list
  const queueList = document.getElementById('doc-queue-list');
  if (waiting.length === 0) {
    queueList.innerHTML = '<div class="empty-queue-msg">No patients waiting</div>';
  } else {
    queueList.innerHTML = waiting.map((p, i) => `
      <div class="queue-list-item">
        <div class="queue-pos">${i + 1}</div>
        <div class="queue-item-token">#${p.token_number}</div>
        <div class="queue-item-name">${p.patient_name}</div>
        <div class="queue-item-wait">~${(i + (active ? 1 : 0)) * avg} min</div>
      </div>
    `).join('');
  }

  // Consultation history (today's completed)
  const historyList = document.getElementById('doc-history-list');
  const completed = queueState.completedList.filter(p => p.status === 'COMPLETED');
  if (completed.length === 0) {
    historyList.innerHTML = '<div class="empty-queue-msg">No consultations yet today</div>';
  } else {
    historyList.innerHTML = completed.slice(0, 15).map(p => {
      const dur = p.consultation_duration ? `${Math.round(p.consultation_duration / 60)} min` : '--';
      const time = p.consultation_end ? new Date(p.consultation_end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      return `
        <div class="history-list-item">
          <div class="history-item-left">
            <div class="history-item-token">#${p.token_number}</div>
            <div class="history-item-name">${p.patient_name}</div>
          </div>
          <div style="display:flex;gap:12px;align-items:center;">
            <div class="history-item-duration">${dur}</div>
            <span class="badge badge-completed" style="font-size:0.7rem;">${time || 'Completed'}</span>
          </div>
        </div>
      `;
    }).join('');
  }
}

// ─── Actions ─────────────────────────────────────────────────────────────────
async function callNext() {
  const btn = document.getElementById('btn-call-next-doc');
  btn.disabled = true;
  try {
    const res = await fetch('/api/queue/next', { method: 'POST' });
    if (!res.ok) {
      const d = await res.json();
      alert(d.error || 'Failed to call next patient');
    }
  } catch (e) { console.error(e); }
  finally { btn.disabled = false; }
}

async function startConsultation(id) {
  try {
    const res = await fetch(`/api/patients/${id}/start-consultation`, { method: 'POST' });
    if (res.ok) {
      const d = await res.json();
      startStopwatch(d.consultation_start);
    }
  } catch (e) { console.error(e); }
}

async function endConsultation(id) {
  try {
    await fetch(`/api/patients/${id}/end-consultation`, { method: 'POST' });
    stopStopwatch();
  } catch (e) { console.error(e); }
}

async function skipPatient(id) {
  if (!confirm('Skip this patient?')) return;
  try {
    await fetch(`/api/patients/${id}/skip`, { method: 'POST' });
    stopStopwatch();
  } catch (e) { console.error(e); }
}

// ─── Init ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch('/api/queue');
    if (res.ok) { queueState = await res.json(); renderUI(); }
  } catch (e) {}
  connectWS();

  document.getElementById('btn-call-next-doc').addEventListener('click', callNext);

  document.getElementById('btn-start-consult').addEventListener('click', (e) => {
    const id = e.currentTarget.dataset.id;
    if (id) startConsultation(id);
  });
  document.getElementById('btn-end-consult').addEventListener('click', (e) => {
    const id = e.currentTarget.dataset.id;
    if (id) endConsultation(id);
  });
  document.getElementById('btn-skip-consult').addEventListener('click', (e) => {
    const id = e.currentTarget.dataset.id;
    if (id) skipPatient(id);
  });
});
