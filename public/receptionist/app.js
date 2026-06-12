// State Management
let queueState = {
  waitingList: [],
  activePatient: null,
  completedList: [],
  stats: {
    totalToday: 0,
    waiting: 0,
    completed: 0,
    currentServing: null
  },
  settings: {
    average_consultation_time: 5
  }
};

let ws = null;
let reconnectInterval = null;

// Audio Chime Synthesizer using Web Audio API
function playChime() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    
    // Low Chime: E5
    const osc1 = audioCtx.createOscillator();
    const gain1 = audioCtx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(659.25, audioCtx.currentTime); 
    gain1.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain1.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.6);
    osc1.connect(gain1);
    gain1.connect(audioCtx.destination);
    
    // High Chime: A5 (offset)
    const osc2 = audioCtx.createOscillator();
    const gain2 = audioCtx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880.00, audioCtx.currentTime + 0.12); 
    gain2.gain.setValueAtTime(0, audioCtx.currentTime);
    gain2.gain.setValueAtTime(0.08, audioCtx.currentTime + 0.12);
    gain2.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.72);
    osc2.connect(gain2);
    gain2.connect(audioCtx.destination);
    
    osc1.start(audioCtx.currentTime);
    osc1.stop(audioCtx.currentTime + 0.6);
    osc2.start(audioCtx.currentTime + 0.12);
    osc2.stop(audioCtx.currentTime + 0.72);
  } catch (e) {
    console.error('Audio initialization failed: ', e);
  }
}

// WebSocket Connection Setup
function connectWebSocket() {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}`;
  
  ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    console.log('WS Connection established');
    updateSyncStatus(true);
    if (reconnectInterval) {
      clearInterval(reconnectInterval);
      reconnectInterval = null;
    }
  };
  
  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log('Received WebSocket event:', data.event);
      
      if (data.event === 'INITIAL_STATE' || data.event === 'QUEUE_UPDATE') {
        queueState = data.state;
        updateUI();
      } else if (data.event === 'CALL_PATIENT' || data.event === 'RECALL_PATIENT') {
        playChime();
      }
    } catch (err) {
      console.error('Failed to parse WS message:', err);
    }
  };
  
  ws.onclose = () => {
    console.warn('WS Connection lost. Retrying...');
    updateSyncStatus(false);
    if (!reconnectInterval) {
      reconnectInterval = setInterval(connectWebSocket, 3000);
    }
  };
}

// REST Call Helpers
async function fetchQueueState() {
  try {
    const res = await fetch('/api/queue');
    if (res.ok) {
      queueState = await res.json();
      updateUI();
    }
  } catch (err) {
    console.error('Failed to fetch initial state:', err);
  }
}

// UI State Sync
function updateSyncStatus(connected) {
  const dot = document.getElementById('sync-dot');
  const text = document.getElementById('sync-text');
  if (connected) {
    dot.className = 'sync-dot connected';
    text.textContent = 'Live Sync Connected';
  } else {
    dot.className = 'sync-dot';
    text.textContent = 'Offline. Retrying...';
  }
}

function updateUI() {
  // Update stats counts
  document.getElementById('val-current-serving').textContent = 
    queueState.stats.currentServing ? `Token #${queueState.stats.currentServing}` : 'None';
  document.getElementById('val-waiting-count').textContent = queueState.stats.waiting;
  document.getElementById('val-completed-count').textContent = queueState.stats.completed;
  document.getElementById('val-total-count').textContent = queueState.stats.totalToday;
  
  // Update Settings field
  document.getElementById('consult-time').value = queueState.settings.average_consultation_time;

  // Update Demo Mode controls & banners
  const btnToggleDemo = document.getElementById('btn-toggle-demo');
  const demoBanner = document.getElementById('demo-banner');
  if (btnToggleDemo && demoBanner) {
    if (queueState.stats.isDemoActive) {
      btnToggleDemo.innerHTML = '<span class="demo-icon">⚡</span> Stop Demo Mode';
      btnToggleDemo.classList.add('active');
      demoBanner.classList.remove('hidden');
    } else {
      btnToggleDemo.innerHTML = '<span class="demo-icon">⚡</span> Setup Demo Mode';
      btnToggleDemo.classList.remove('active');
      demoBanner.classList.add('hidden');
    }
  }

  // Update Callout UI for current active patient
  const activeCallout = document.getElementById('active-callout');
  const completeActiveBtn = document.getElementById('btn-complete-active');
  
  if (queueState.activePatient) {
    document.getElementById('callout-token-num').textContent = `Token #${queueState.activePatient.token_number}`;
    document.getElementById('callout-patient-name').textContent = queueState.activePatient.patient_name;
    activeCallout.classList.remove('hidden');
    completeActiveBtn.disabled = false;
  } else {
    activeCallout.classList.add('hidden');
    completeActiveBtn.disabled = true;
  }

  // Update Table Body
  const tbody = document.getElementById('queue-tbody');
  const emptyBadge = document.getElementById('queue-empty-msg');
  
  if (queueState.waitingList.length === 0 && !queueState.activePatient) {
    emptyBadge.classList.remove('hidden');
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="table-loading">No patients waiting in the queue.</td>
      </tr>
    `;
    return;
  }
  
  emptyBadge.classList.add('hidden');
  tbody.innerHTML = '';

  // Render current consultation patient at the top of the table (if exists)
  if (queueState.activePatient) {
    renderTableRow(tbody, queueState.activePatient, true);
  }

  // Render all waiting patients
  queueState.waitingList.forEach(patient => {
    renderTableRow(tbody, patient, false);
  });
}

function renderTableRow(tbody, patient, isActive) {
  const tr = document.createElement('tr');
  if (isActive) tr.className = 'row-active';

  const statusBadge = isActive 
    ? '<span class="badge badge-consultation">In Consultation</span>'
    : '<span class="badge badge-waiting">Waiting</span>';

  const phoneText = patient.phone_number 
    ? `<span class="patient-phone-text">${patient.phone_number}</span>`
    : '';

  // Actions change based on status
  let actionButtons = '';
  if (isActive) {
    actionButtons = `
      <button class="btn-success btn-complete" data-id="${patient.id}">Complete</button>
      <button class="btn-warning btn-skip" data-id="${patient.id}">Skip</button>
      <button class="btn-secondary btn-recall" data-id="${patient.id}">Recall</button>
    `;
  } else {
    actionButtons = `
      <button class="btn-secondary btn-recall" data-id="${patient.id}">Recall</button>
      <button class="btn-warning btn-skip" data-id="${patient.id}">Skip</button>
    `;
  }

  tr.innerHTML = `
    <td><span class="patient-token">#${patient.token_number}</span></td>
    <td>
      <span class="patient-name-text">${patient.patient_name}</span>
      ${phoneText}
    </td>
    <td>${statusBadge}</td>
    <td>
      <div class="action-cell">
        ${actionButtons}
      </div>
    </td>
  `;

  // Event delegation hookups
  tr.querySelector('.btn-recall').onclick = () => handleRecall(patient.id);
  tr.querySelector('.btn-skip').onclick = () => handleSkip(patient.id);
  
  if (isActive) {
    tr.querySelector('.btn-complete').onclick = () => handleComplete(patient.id);
  }

  tbody.appendChild(tr);
}

// API Operation handlers

async function handleCallNext() {
  const btn = document.getElementById('btn-call-next');
  btn.disabled = true;
  try {
    const res = await fetch('/api/queue/next', { method: 'POST' });
    if (!res.ok) {
      const data = await res.json();
      alert(data.error || 'Failed to call next patient');
    }
  } catch (err) {
    console.error('Call next API error:', err);
  } finally {
    btn.disabled = false;
  }
}

async function handleRecallPrevious() {
  const btn = document.getElementById('btn-recall-prev');
  btn.disabled = true;
  try {
    const res = await fetch('/api/queue/recall-previous', { method: 'POST' });
    if (!res.ok) {
      const data = await res.json();
      alert(data.error || 'Failed to recall previous token');
    }
  } catch (err) {
    console.error('Recall previous API error:', err);
  } finally {
    btn.disabled = false;
  }
}

async function handleCompleteActive() {
  if (!queueState.activePatient) return;
  await handleComplete(queueState.activePatient.id);
}

async function handleComplete(id) {
  try {
    const res = await fetch(`/api/patients/${id}/complete`, { method: 'POST' });
    if (!res.ok) alert('Failed to mark patient as completed');
  } catch (err) {
    console.error('Complete patient error:', err);
  }
}

async function handleSkip(id) {
  try {
    const res = await fetch(`/api/patients/${id}/skip`, { method: 'POST' });
    if (!res.ok) alert('Failed to mark patient as skipped');
  } catch (err) {
    console.error('Skip patient error:', err);
  }
}

async function handleRecall(id) {
  try {
    const res = await fetch(`/api/patients/${id}/recall`, { method: 'POST' });
    if (!res.ok) alert('Failed to recall patient');
  } catch (err) {
    console.error('Recall patient error:', err);
  }
}

async function handleAddPatient(e) {
  e.preventDefault();
  const nameInput = document.getElementById('patient-name');
  const phoneInput = document.getElementById('patient-phone');
  
  const payload = {
    patient_name: nameInput.value,
    phone_number: phoneInput.value
  };

  try {
    const res = await fetch('/api/patients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (res.ok) {
      const data = await res.json();
      nameInput.value = '';
      phoneInput.value = '';
      showRegistrationModal(data);
    } else {
      const data = await res.json();
      alert(data.error || 'Failed to add patient');
    }
  } catch (err) {
    console.error('Add patient error:', err);
  }
}

// Show Registration Success Modal with QR Code
function showRegistrationModal(patient) {
  document.getElementById('modal-patient-name').textContent = patient.patient_name;
  document.getElementById('modal-token-number').textContent = `#${patient.token_number}`;
  const phoneEl = document.getElementById('modal-patient-phone');
  if (patient.phone_number) {
    phoneEl.textContent = `Phone: ${patient.phone_number}`;
    phoneEl.style.display = 'block';
  } else {
    phoneEl.style.display = 'none';
  }
  
  const trackUrl = `${window.location.protocol}//${window.location.host}/patient/track.html?id=${patient.id}&token=${patient.token_number}`;
  document.getElementById('modal-qr-url').textContent = trackUrl;
  
  const qrContainer = document.getElementById('qrcode-display');
  qrContainer.innerHTML = '';
  
  try {
    const qr = qrcode(0, 'M');
    qr.addData(trackUrl);
    qr.make();
    qrContainer.innerHTML = qr.createImgTag(5, 10);
  } catch (e) {
    console.error('QR code generation failed:', e);
    qrContainer.textContent = 'Failed to generate QR Code';
  }
  
  document.getElementById('registration-modal').classList.remove('hidden');
}

function handleDownloadQR() {
  const img = document.querySelector('#qrcode-display img');
  if (!img) return;
  const link = document.createElement('a');
  link.href = img.src;
  link.download = `token_${document.getElementById('modal-token-number').textContent.replace('#', '')}_qr.png`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function handlePrintQR() {
  const patientName = document.getElementById('modal-patient-name').textContent;
  const tokenNum = document.getElementById('modal-token-number').textContent;
  const qrImgSrc = document.querySelector('#qrcode-display img').src;
  const trackUrl = document.getElementById('modal-qr-url').textContent;
  
  const printWindow = window.open('', '_blank', 'width=600,height=600');
  printWindow.document.write(`
    <html>
    <head>
      <title>Print Token ${tokenNum}</title>
      <style>
        body { font-family: sans-serif; text-align: center; padding: 40px; color: #333; }
        .ticket { border: 2px dashed #ccc; padding: 30px; border-radius: 10px; display: inline-block; max-width: 400px; }
        h1 { font-size: 3rem; margin: 10px 0; color: #0d9488; }
        h2 { margin: 5px 0; font-size: 1.5rem; }
        p { font-size: 0.9rem; color: #666; margin: 5px 0; }
        .qr { margin: 20px 0; }
        .url { font-size: 0.75rem; color: #999; word-break: break-all; }
        .footer { margin-top: 30px; font-size: 0.8rem; border-top: 1px dashed #eee; padding-top: 15px; }
      </style>
    </head>
    <body>
      <div class="ticket">
        <p>Queue Cure '26 Receipt</p>
        <h2>${patientName}</h2>
        <p>Your Token Number</p>
        <h1>${tokenNum}</h1>
        <div class="qr"><img src="${qrImgSrc}" width="150" height="150" /></div>
        <p>Scan to track your position in real-time:</p>
        <div class="url">${trackUrl}</div>
        <div class="footer">Please wait for your call in the lobby.</div>
      </div>
      <script>
        window.onload = function() {
          window.print();
          window.close();
        }
      <\/script>
    </body>
    </html>
  `);
  printWindow.document.close();
}

async function toggleDemoMode() {
  const active = queueState.stats.isDemoActive;
  if (!active) {
    const confirmPopulate = confirm("Would you like to seed the database with mock historical and active clinic data for demonstration? This will clear the current patient records.");
    if (confirmPopulate) {
      try {
        await fetch('/api/demo/populate', { method: 'POST' });
      } catch (e) {
        console.error('Failed to populate demo data:', e);
      }
    }
    try {
      await fetch('/api/demo/start', { method: 'POST' });
    } catch (e) {
      console.error('Failed to start demo mode:', e);
    }
  } else {
    try {
      await fetch('/api/demo/stop', { method: 'POST' });
    } catch (e) {
      console.error('Failed to stop demo mode:', e);
    }
  }
}

async function handleStopDemoMode() {
  try {
    await fetch('/api/demo/stop', { method: 'POST' });
  } catch (e) {
    console.error('Failed to stop demo mode:', e);
  }
}

async function handleSaveSettings() {
  const input = document.getElementById('consult-time');
  const payload = {
    average_consultation_time: parseInt(input.value, 10)
  };

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const data = await res.json();
      alert(data.error || 'Failed to save settings');
    }
  } catch (err) {
    console.error('Save settings error:', err);
  }
}

// Event Bindings
document.addEventListener('DOMContentLoaded', () => {
  // Initial Fetches
  fetchQueueState();
  connectWebSocket();
  
  // Buttons
  document.getElementById('btn-call-next').addEventListener('click', handleCallNext);
  document.getElementById('btn-recall-prev').addEventListener('click', handleRecallPrevious);
  document.getElementById('btn-complete-active').addEventListener('click', handleCompleteActive);
  document.getElementById('btn-save-settings').addEventListener('click', handleSaveSettings);
  
  // Demo Mode bindings
  document.getElementById('btn-toggle-demo').addEventListener('click', toggleDemoMode);
  document.getElementById('btn-stop-demo-banner').addEventListener('click', handleStopDemoMode);

  // Modal actions
  document.getElementById('btn-close-modal').onclick = () => {
    document.getElementById('registration-modal').classList.add('hidden');
  };
  document.getElementById('btn-download-qr').onclick = handleDownloadQR;
  document.getElementById('btn-print-qr').onclick = handlePrintQR;
  
  // Registration Form
  document.getElementById('form-add-patient').addEventListener('submit', handleAddPatient);
});
