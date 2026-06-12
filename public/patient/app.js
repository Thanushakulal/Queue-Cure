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
let trackedToken = localStorage.getItem('tracked_token') ? parseInt(localStorage.getItem('tracked_token'), 10) : null;
let lastAnnouncedToken = null;
let lastCalledTime = null;
let lastCalledInterval = null;
let prevServingToken = null;

// Audio Chime Synthesizer using Web Audio API
function playChime() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    
    // E5 Note
    const osc1 = audioCtx.createOscillator();
    const gain1 = audioCtx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(659.25, audioCtx.currentTime); 
    gain1.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain1.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.6);
    osc1.connect(gain1);
    gain1.connect(audioCtx.destination);
    
    // A5 Note
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
    console.error('Audio initialization failed:', e);
  }
}

// Text-to-Speech Announcement
function announcePatient(tokenNumber, patientName, isRecall = false) {
  // Play chime
  playChime();
  
  // Voice announcement using browser Web Speech API
  if ('speechSynthesis' in window) {
    // Cancel active synthesis to prevent overlaying
    window.speechSynthesis.cancel();
    
    const prefix = isRecall ? "Recalling, " : "";
    const text = `${prefix}Token number ${tokenNumber}, ${patientName}. Please proceed to the consultation room.`;
    
    const utterance = new SpeechSynthesisUtterance(text);
    
    // Attempt to load standard natural English voice
    const voices = window.speechSynthesis.getVoices();
    const enVoice = voices.find(v => v.lang.startsWith('en'));
    if (enVoice) {
      utterance.voice = enVoice;
    }
    
    utterance.rate = 0.85; // Slightly slower for public clarity
    utterance.pitch = 1.0;
    
    // Display announcement text on screen for visual accessibility
    const voiceStatus = document.getElementById('voice-status');
    if (voiceStatus) {
      voiceStatus.textContent = `🗣️ Calling: "Token #${tokenNumber} - ${patientName}"`;
      voiceStatus.style.opacity = 1;
      setTimeout(() => {
        voiceStatus.style.opacity = 0;
      }, 7000);
    }
    
    window.speechSynthesis.speak(utterance);
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
      } else if (data.event === 'CALL_PATIENT') {
        announcePatient(data.patient.token_number, data.patient.patient_name, false);
      } else if (data.event === 'RECALL_PATIENT') {
        announcePatient(data.patient.token_number, data.patient.patient_name, true);
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

// REST Call to synchronize initial state
async function fetchQueueState() {
  try {
    const res = await fetch('/api/queue');
    if (res.ok) {
      queueState = await res.json();
      updateUI();
    }
  } catch (err) {
    console.error('Failed to fetch initial queue state:', err);
  }
}

// UI Rendering
function updateSyncStatus(connected) {
  const dot = document.getElementById('sync-dot');
  const text = document.getElementById('sync-text');
  if (connected) {
    dot.className = 'sync-dot connected';
    text.textContent = 'Live Sync Connected';
  } else {
    dot.className = 'sync-dot';
    text.textContent = 'Offline. Reconnecting...';
  }
}

function updateUI() {
  // 1. Hero Card: Now Serving with pop animation
  const heroToken = document.getElementById('hero-token-num');
  const heroName = document.getElementById('hero-patient-name');
  const currentServing = queueState.stats.currentServing;

  if (queueState.activePatient) {
    const newText = `Token #${queueState.activePatient.token_number}`;
    if (heroToken.textContent !== newText) {
      heroToken.textContent = newText;
      heroToken.classList.remove('pop');
      void heroToken.offsetWidth; // force reflow
      heroToken.classList.add('pop');
      lastCalledTime = new Date();
      startLastCalledTimer();
      // Trigger alert if tracked token is being called
      if (trackedToken && queueState.activePatient.token_number === trackedToken) {
        showTokenCalledAlert();
      }
    }
    heroName.textContent = queueState.activePatient.patient_name;
  } else {
    heroToken.textContent = '--';
    heroName.textContent = 'All caught up! No active consultation.';
  }

  // Progress bar
  const total = queueState.stats.totalToday || 0;
  const done = queueState.stats.completed || 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const fillEl = document.getElementById('progress-fill');
  const rightLabel = document.getElementById('progress-label-right');
  if (fillEl) fillEl.style.width = `${pct}%`;
  if (rightLabel) rightLabel.textContent = `${done} / ${total} served (${pct}%)`;

  // 2. Personal Token Tracker Section
  renderTracker();

  // 3. Upcoming Queue
  const upcomingGrid = document.getElementById('upcoming-tokens-grid');
  if (queueState.waitingList.length === 0) {
    upcomingGrid.innerHTML = '<div class="empty-list-text">No patients waiting</div>';
  } else {
    upcomingGrid.innerHTML = '';
    queueState.waitingList.slice(0, 10).forEach(patient => {
      const bubble = document.createElement('div');
      bubble.className = 'upcoming-token-bubble';
      bubble.innerHTML = `
        <span class="bubble-val">#${patient.token_number}</span>
        <span class="bubble-label">${patient.patient_name.split(' ')[0]}</span>
      `;
      upcomingGrid.appendChild(bubble);
    });
  }

  // 4. Recent Activity
  const historyList = document.getElementById('history-tokens-list');
  if (queueState.completedList.length === 0) {
    historyList.innerHTML = '<div class="empty-list-text">No recent activity</div>';
  } else {
    historyList.innerHTML = '';
    queueState.completedList.slice(0, 5).forEach(patient => {
      const item = document.createElement('div');
      item.className = 'history-item';
      const badgeClass = patient.status === 'COMPLETED' ? 'badge-completed' : 'badge-skipped';
      const statusLabel = patient.status === 'COMPLETED' ? 'Completed' : 'Skipped';
      item.innerHTML = `
        <div>
          <span class="history-token">#${patient.token_number}</span>
          <span class="history-name">${patient.patient_name}</span>
        </div>
        <span class="badge ${badgeClass}">${statusLabel}</span>
      `;
      historyList.appendChild(item);
    });
  }
}

function startLastCalledTimer() {
  if (lastCalledInterval) clearInterval(lastCalledInterval);
  lastCalledInterval = setInterval(updateLastCalledDisplay, 10000);
  updateLastCalledDisplay();
}

function updateLastCalledDisplay() {
  const el = document.getElementById('last-called-text');
  if (!el || !lastCalledTime) return;
  const diffMs = Date.now() - lastCalledTime.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffSecs = Math.floor((diffMs % 60000) / 1000);
  if (diffMins < 1) {
    el.textContent = `Last called ${diffSecs}s ago`;
  } else {
    el.textContent = `Last called ${diffMins}m ago`;
  }
}

function showTokenCalledAlert() {
  const voiceEl = document.getElementById('voice-status');
  if (voiceEl) {
    voiceEl.textContent = '🚨 YOUR TOKEN IS BEING CALLED! Please proceed to the consultation room NOW.';
    voiceEl.style.opacity = 1;
    voiceEl.style.color = 'var(--teal-400)';
    voiceEl.style.fontWeight = '700';
  }
}

function renderTracker() {
  const onboardingCard = document.getElementById('tracker-onboarding');
  const detailsCard = document.getElementById('tracker-details');
  
  if (trackedToken === null) {
    onboardingCard.classList.remove('hidden');
    detailsCard.classList.add('hidden');
    return;
  }
  
  onboardingCard.classList.add('hidden');
  detailsCard.classList.remove('hidden');
  
  document.getElementById('track-user-token').textContent = `#${trackedToken}`;

  // Find user's patient item in the active state
  // Check active consultation first
  if (queueState.activePatient && queueState.activePatient.token_number === trackedToken) {
    updateTrackerState({
      statusText: 'In Consultation',
      statusClass: 'status-consultation',
      tokensAhead: 0,
      waitTime: '0 mins',
      message: '🚨 It is your turn! Please proceed to the consultation room now.'
    });
    return;
  }

  // Check waiting list
  const index = queueState.waitingList.findIndex(p => p.token_number === trackedToken);
  if (index !== -1) {
    const tokensAhead = index;
    // Smart wait: use rolling average if available, else fallback
    const smartAvg = queueState.stats.avgDurationMinutes || queueState.settings.average_consultation_time || 5;
    const confidence = queueState.stats.predictionConfidence || 0;
    const estWait = Math.round(tokensAhead * smartAvg);
    const confidenceLabel = confidence >= 70 ? ` (${confidence}% confidence)` : confidence >= 40 ? ` (~${confidence}% confidence)` : '';
    const waitDisplay = tokensAhead === 0 ? '< 1 min' : `~${estWait} min${confidenceLabel}`;

    let trackerMsg = 'Please stay in the waiting lobby. You will be notified via chime and voice when it is your turn.';
    if (tokensAhead === 0) {
      trackerMsg = '⭐ You are next in line! Please stand by near the consultation doorway and be ready.';
    } else if (tokensAhead <= 2) {
      trackerMsg = `⏰ Only ${tokensAhead} patient${tokensAhead > 1 ? 's' : ''} ahead of you. Please move closer to the consultation room.`;
    }

    updateTrackerState({
      statusText: tokensAhead === 0 ? 'You Are Next!' : tokensAhead <= 2 ? 'Approaching' : 'Waiting',
      statusClass: tokensAhead <= 2 ? 'status-consultation' : 'status-waiting',
      tokensAhead: tokensAhead,
      waitTime: waitDisplay,
      message: trackerMsg
    });
    return;
  }

  // Check completed list or database history
  const completedItem = queueState.completedList.find(p => p.token_number === trackedToken);
  if (completedItem) {
    if (completedItem.status === 'COMPLETED') {
      updateTrackerState({
        statusText: 'Completed',
        statusClass: 'status-completed',
        tokensAhead: '-',
        waitTime: '-',
        message: '✅ Your consultation is complete. Thank you!'
      });
    } else if (completedItem.status === 'SKIPPED') {
      updateTrackerState({
        statusText: 'Skipped',
        statusClass: 'status-skipped',
        tokensAhead: '-',
        waitTime: '-',
        message: '⚠️ You were marked as skipped. Please speak with the receptionist to recall your token.'
      });
    }
    return;
  }

  // Fallback: If not found in current local list chunks (e.g. invalid token or expired)
  updateTrackerState({
    statusText: 'Not Found',
    statusClass: 'status-skipped',
    tokensAhead: '-',
    waitTime: '-',
    message: '🔍 Token number not found for today. Please double-check your receipt or register at reception.'
  });
}

function updateTrackerState(data) {
  const statusBox = document.getElementById('user-status-box');
  const statusBadge = document.getElementById('track-status-val');
  
  statusBox.className = `user-status-card ${data.statusClass}`;
  statusBadge.textContent = data.statusText;
  
  document.getElementById('track-tokens-ahead').textContent = data.tokensAhead;
  document.getElementById('track-wait-time').textContent = data.waitTime;
  document.getElementById('tracker-message').textContent = data.message;
}

// Handlers
function handleTrackSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('track-token-input');
  const tokenNum = parseInt(input.value, 10);
  
  if (!isNaN(tokenNum) && tokenNum > 0) {
    trackedToken = tokenNum;
    localStorage.setItem('tracked_token', tokenNum);
    input.value = '';
    renderTracker();
  }
}

function handleClearTrack() {
  trackedToken = null;
  localStorage.removeItem('tracked_token');
  renderTracker();
}

// Event Bindings
document.addEventListener('DOMContentLoaded', () => {
  // Init
  fetchQueueState();
  connectWebSocket();
  
  // Track Form
  document.getElementById('form-track-token').addEventListener('submit', handleTrackSubmit);
  document.getElementById('btn-clear-track').addEventListener('click', handleClearTrack);
  
  // Trigger loading voices for synthesis (safari/chrome fix)
  if ('speechSynthesis' in window) {
    window.speechSynthesis.getVoices();
  }
});
