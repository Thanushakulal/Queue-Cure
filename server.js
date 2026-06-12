import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { db, initDatabase, generateNextToken } from './db.js';

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const server = createServer(app);
const wss = new WebSocketServer({ server });

let isDemoActive = false;
let demoInterval = null;

// Helper to get smart wait statistics based on last 10 completed consultations
async function getSmartWaitTimeStats(settings) {
  const defaultAvg = settings ? settings.average_consultation_time : 5;
  const last10 = await db.all(`
    SELECT consultation_duration 
    FROM patients 
    WHERE status = 'COMPLETED' 
      AND consultation_duration IS NOT NULL
    ORDER BY consultation_end DESC 
    LIMIT 10
  `);
  
  const count = last10.length;
  let avgDurationMinutes = defaultAvg;
  let predictionConfidence = 0;
  let avgDurationSeconds = defaultAvg * 60;
  
  if (count > 0) {
    const sum = last10.reduce((acc, row) => acc + row.consultation_duration, 0);
    avgDurationSeconds = sum / count;
    avgDurationMinutes = Number((avgDurationSeconds / 60).toFixed(1));
    
    if (count >= 3) {
      const mean = avgDurationSeconds;
      const sqDiffs = last10.map(x => Math.pow(x.consultation_duration - mean, 2));
      const varianceSum = sqDiffs.reduce((acc, val) => acc + val, 0);
      const variance = varianceSum / count;
      const stdDev = Math.sqrt(variance);
      
      const cv = mean > 0 ? stdDev / mean : 0;
      let varianceScore = 0;
      if (cv < 0.15) {
        varianceScore = 45; // very consistent (low CV)
      } else if (cv < 0.3) {
        varianceScore = 35;
      } else if (cv < 0.5) {
        varianceScore = 20;
      } else {
        varianceScore = 10; // high variability
      }
      
      const sampleScore = count * 5; // up to 50 points
      predictionConfidence = Math.min(95, sampleScore + varianceScore);
    } else {
      predictionConfidence = count * 20; // 20% for 1 patient, 40% for 2
    }
  }
  
  return {
    avgDurationSeconds,
    avgDurationMinutes,
    predictionConfidence: Math.round(predictionConfidence),
    count
  };
}

// Helper to compile current queue state for client synchronization
async function getQueueState() {
  const settings = await db.get(`SELECT * FROM settings WHERE id = 1`);
  
  // Get active patient (currently in consultation)
  const activePatient = await db.get(`
    SELECT * FROM patients 
    WHERE status = 'IN_CONSULTATION' 
    ORDER BY token_number DESC LIMIT 1
  `);
  
  // Get all currently waiting patients in chronological token order
  const waitingList = await db.all(`
    SELECT * FROM patients 
    WHERE status = 'WAITING' 
    ORDER BY token_number ASC
  `);
  
  // Get last 10 completed or skipped patients for receptionist logs and history
  const completedList = await db.all(`
    SELECT * FROM patients 
    WHERE status IN ('COMPLETED', 'SKIPPED') 
    ORDER BY id DESC LIMIT 10
  `);

  // Compute daily metrics
  const stats = {
    totalToday: 0,
    waiting: 0,
    completed: 0,
    currentServing: activePatient ? activePatient.token_number : null,
    avgDurationMinutes: settings ? settings.average_consultation_time : 5,
    predictionConfidence: 0,
    smartCount: 0,
    isDemoActive
  };

  const todayStats = await db.get(`
    SELECT 
      COUNT(*) as totalToday,
      SUM(CASE WHEN status = 'WAITING' THEN 1 ELSE 0 END) as waiting,
      SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completed
    FROM patients 
    WHERE date(created_at, 'localtime') = date('now', 'localtime')
  `);

  if (todayStats) {
    stats.totalToday = todayStats.totalToday || 0;
    stats.waiting = todayStats.waiting || 0;
    stats.completed = todayStats.completed || 0;
  }

  // Inject smart prediction values
  const smartStats = await getSmartWaitTimeStats(settings);
  stats.avgDurationMinutes = smartStats.avgDurationMinutes;
  stats.predictionConfidence = smartStats.predictionConfidence;
  stats.smartCount = smartStats.count;

  return {
    waitingList,
    activePatient,
    completedList,
    stats,
    settings
  };
}

// Broadcast JSON message to all connected clients
function broadcast(message) {
  const payload = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  });
}

// REST APIs

// 1. Get entire queue state
app.get('/api/queue', async (req, res) => {
  try {
    const state = await getQueueState();
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Add patient (Generate Token, save in DB, broadcast update)
app.post('/api/patients', async (req, res) => {
  const { patient_name, phone_number } = req.body;
  if (!patient_name || patient_name.trim() === '') {
    return res.status(400).json({ error: 'Patient name is required' });
  }

  try {
    const token = await generateNextToken();
    const result = await db.run(
      `INSERT INTO patients (token_number, patient_name, phone_number, status) 
       VALUES (?, ?, ?, 'WAITING')`,
      [token, patient_name.trim(), phone_number && phone_number.trim() !== '' ? phone_number.trim() : null]
    );

    const state = await getQueueState();
    broadcast({ event: 'QUEUE_UPDATE', state });
    res.status(201).json({ id: result.id, token_number: token, patient_name, phone_number });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mutex lock to block duplicate "Call Next" requests
let isCallingNext = false;

// 3. Call next token (Move current to COMPLETED, WAITING to IN_CONSULTATION)
app.post('/api/queue/next', async (req, res) => {
  if (isCallingNext) {
    return res.status(409).json({ error: 'Another queue advancement is in progress' });
  }
  isCallingNext = true;

  try {
    await db.transaction(async () => {
      // Mark current in-consultation patient as COMPLETED with actual duration calculation
      const active = await db.get(`SELECT * FROM patients WHERE status = 'IN_CONSULTATION'`);
      if (active) {
        const endTime = new Date().toISOString();
        let duration = null;
        if (active.consultation_start) {
          duration = Math.max(0, Math.floor((new Date(endTime) - new Date(active.consultation_start)) / 1000));
        } else {
          duration = Math.max(0, Math.floor((new Date(endTime) - new Date(active.created_at)) / 1000));
        }
        await db.run(
          `UPDATE patients 
           SET status = 'COMPLETED', consultation_end = ?, consultation_duration = ? 
           WHERE id = ?`, 
          [endTime, duration, active.id]
        );
      }

      // Fetch next patient in line
      const nextPatient = await db.get(`
        SELECT * FROM patients 
        WHERE status = 'WAITING' 
        ORDER BY token_number ASC LIMIT 1
      `);

      if (nextPatient) {
        const startTime = new Date().toISOString();
        await db.run(
          `UPDATE patients 
           SET status = 'IN_CONSULTATION', consultation_start = ? 
           WHERE id = ?`, 
          [startTime, nextPatient.id]
        );
        
        const state = await getQueueState();
        broadcast({ event: 'QUEUE_UPDATE', state });
        broadcast({ 
          event: 'CALL_PATIENT', 
          patient: { 
            token_number: nextPatient.token_number, 
            patient_name: nextPatient.patient_name 
          } 
        });

        res.json({ success: true, calledPatient: nextPatient });
      } else {
        const state = await getQueueState();
        broadcast({ event: 'QUEUE_UPDATE', state });
        res.status(400).json({ error: 'No patients waiting' });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    isCallingNext = false;
  }
});

// 4. Mark patient as COMPLETED
app.post('/api/patients/:id/complete', async (req, res) => {
  const { id } = req.params;
  try {
    const patient = await db.get(`SELECT * FROM patients WHERE id = ?`, [id]);
    if (patient) {
      const endTime = new Date().toISOString();
      let duration = null;
      if (patient.consultation_start) {
        duration = Math.max(0, Math.floor((new Date(endTime) - new Date(patient.consultation_start)) / 1000));
      } else {
        duration = Math.max(0, Math.floor((new Date(endTime) - new Date(patient.created_at)) / 1000));
      }
      await db.run(
        `UPDATE patients 
         SET status = 'COMPLETED', consultation_end = ?, consultation_duration = ? 
         WHERE id = ?`,
        [endTime, duration, id]
      );
    } else {
      await db.run(`UPDATE patients SET status = 'COMPLETED' WHERE id = ?`, [id]);
    }
    const state = await getQueueState();
    broadcast({ event: 'QUEUE_UPDATE', state });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Skip patient
app.post('/api/patients/:id/skip', async (req, res) => {
  const { id } = req.params;
  try {
    const endTime = new Date().toISOString();
    await db.run(
      `UPDATE patients 
       SET status = 'SKIPPED', consultation_end = ? 
       WHERE id = ?`, 
      [endTime, id]
    );
    const state = await getQueueState();
    broadcast({ event: 'QUEUE_UPDATE', state });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5a. Start Doctor Consultation (logs start time)
app.post('/api/patients/:id/start-consultation', async (req, res) => {
  const { id } = req.params;
  try {
    const startTime = new Date().toISOString();
    await db.run(
      `UPDATE patients 
       SET status = 'IN_CONSULTATION', consultation_start = ? 
       WHERE id = ?`,
      [startTime, id]
    );
    const state = await getQueueState();
    broadcast({ event: 'QUEUE_UPDATE', state });
    broadcast({ event: 'CONSULTATION_STARTED', patientId: id, startTime });
    res.json({ success: true, consultation_start: startTime });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5b. End Doctor Consultation (logs end time and calculates duration)
app.post('/api/patients/:id/end-consultation', async (req, res) => {
  const { id } = req.params;
  try {
    const patient = await db.get(`SELECT * FROM patients WHERE id = ?`, [id]);
    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }
    const endTime = new Date().toISOString();
    const start = patient.consultation_start ? new Date(patient.consultation_start) : new Date(patient.created_at);
    const duration = Math.max(0, Math.floor((new Date(endTime) - start) / 1000));
    
    await db.run(
      `UPDATE patients 
       SET status = 'COMPLETED', consultation_end = ?, consultation_duration = ? 
       WHERE id = ?`,
      [endTime, duration, id]
    );
    const state = await getQueueState();
    broadcast({ event: 'QUEUE_UPDATE', state });
    res.json({ success: true, consultation_end: endTime, consultation_duration: duration });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5c. Fetch Analytics Data
app.get('/api/analytics', async (req, res) => {
  const period = req.query.period || 'today';
  let dateFilter = '';
  let groupBy = '';
  
  if (period === 'today') {
    dateFilter = "date(created_at, 'localtime') = date('now', 'localtime')";
    groupBy = "strftime('%H', created_at, 'localtime')";
  } else if (period === 'weekly') {
    dateFilter = "date(created_at, 'localtime') >= date('now', '-7 days')";
    groupBy = "date(created_at, 'localtime')";
  } else if (period === 'monthly') {
    dateFilter = "date(created_at, 'localtime') >= date('now', '-30 days')";
    groupBy = "date(created_at, 'localtime')";
  }
  
  try {
    const stats = await db.get(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'SKIPPED' THEN 1 ELSE 0 END) as skipped,
        SUM(CASE WHEN status = 'WAITING' THEN 1 ELSE 0 END) as waiting
      FROM patients
      WHERE ${dateFilter}
    `);
    
    const registrationsOverTime = await db.all(`
      SELECT ${groupBy} as time_bucket, COUNT(*) as count
      FROM patients
      WHERE ${dateFilter}
      GROUP BY time_bucket
      ORDER BY time_bucket ASC
    `);

    const completionsOverTime = await db.all(`
      SELECT ${period === 'today' ? "strftime('%H', consultation_end, 'localtime')" : "date(consultation_end, 'localtime')"} as time_bucket, COUNT(*) as count
      FROM patients
      WHERE ${dateFilter} AND status = 'COMPLETED' AND consultation_end IS NOT NULL
      GROUP BY time_bucket
      ORDER BY time_bucket ASC
    `);

    const avgWaitTrend = await db.all(`
      SELECT ${groupBy} as time_bucket, 
             AVG((strftime('%s', consultation_start) - strftime('%s', created_at)) / 60.0) as avg_wait
      FROM patients
      WHERE ${dateFilter} AND consultation_start IS NOT NULL
      GROUP BY time_bucket
      ORDER BY time_bucket ASC
    `);

    const avgDurationTrend = await db.all(`
      SELECT ${period === 'today' ? "strftime('%H', consultation_end, 'localtime')" : "date(consultation_end, 'localtime')"} as time_bucket, 
             AVG(consultation_duration / 60.0) as avg_duration
      FROM patients
      WHERE ${dateFilter} AND status = 'COMPLETED' AND consultation_duration IS NOT NULL
      GROUP BY time_bucket
      ORDER BY time_bucket ASC
    `);

    const peakHours = await db.all(`
      SELECT strftime('%H', created_at, 'localtime') as hour, COUNT(*) as count
      FROM patients
      WHERE ${dateFilter}
      GROUP BY hour
      ORDER BY hour ASC
    `);

    res.json({
      stats,
      registrationsOverTime,
      completionsOverTime,
      avgWaitTrend,
      avgDurationTrend,
      peakHours
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5d. Searchable History Logs API
app.get('/api/history', async (req, res) => {
  const { query, status, date } = req.query;
  let sql = `SELECT * FROM patients WHERE 1=1`;
  const params = [];
  
  if (query && query.trim() !== '') {
    sql += ` AND (patient_name LIKE ? OR token_number = ?)`;
    params.push(`%${query.trim()}%`);
    params.push(parseInt(query.trim(), 10) || -1);
  }
  
  if (status && status.trim() !== '') {
    sql += ` AND status = ?`;
    params.push(status);
  }
  
  if (date && date.trim() !== '') {
    sql += ` AND date(created_at, 'localtime') = date(?, 'localtime')`;
    params.push(date);
  }
  
  sql += ` ORDER BY created_at DESC LIMIT 200`;
  
  try {
    const rows = await db.all(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mock Names & Simulation Helpers for Demo Mode
const mockNames = [
  'Emma Watson', 'James Smith', 'Olivia Brown', 'William Jones', 'Sophia Miller', 
  'Benjamin Davis', 'Isabella Garcia', 'Lucas Rodriguez', 'Mia Wilson', 'Henry Martinez',
  'Amelia Anderson', 'Alexander Taylor', 'Charlotte Thomas', 'Daniel Moore', 'Harper Jackson',
  'Matthew Martin', 'Evelyn Lee', 'Jackson Perez', 'Abigail Thompson', 'Sebastian White'
];

async function seedMockData() {
  await db.transaction(async () => {
    await db.run(`DELETE FROM patients`);
    
    // Seed 40 patients spread over the last 30 days
    const now = new Date();
    for (let i = 30; i > 0; i--) {
      const dayDate = new Date();
      dayDate.setDate(now.getDate() - i);
      
      const patientsCount = Math.floor(Math.random() * 2) + 1;
      for (let p = 0; p < patientsCount; p++) {
        const name = mockNames[Math.floor(Math.random() * mockNames.length)];
        const duration = Math.floor(Math.random() * 400) + 180; // 3 to 9.6 mins
        
        const created = new Date(dayDate);
        created.setHours(9 + Math.floor(Math.random() * 6), Math.floor(Math.random() * 60), 0);
        
        const started = new Date(created);
        started.setMinutes(created.getMinutes() + Math.floor(Math.random() * 20) + 5);
        
        const ended = new Date(started);
        ended.setSeconds(started.getSeconds() + duration);
        
        await db.run(
          `INSERT INTO patients (token_number, patient_name, phone_number, status, consultation_start, consultation_end, consultation_duration, created_at)
           VALUES (?, ?, ?, 'COMPLETED', ?, ?, ?, ?)`,
          [
            p + 1,
            name,
            `555-01${Math.floor(10 + Math.random() * 90)}`,
            started.toISOString(),
            ended.toISOString(),
            duration,
            created.toISOString()
          ]
        );
      }
    }
    
    // Seed today's historical logs (completed/skipped)
    for (let p = 0; p < 5; p++) {
      const name = mockNames[Math.floor(Math.random() * mockNames.length)];
      const duration = Math.floor(Math.random() * 300) + 200; // 3.3 to 8.3 mins
      
      const created = new Date();
      created.setHours(now.getHours() - 3 + p, Math.floor(Math.random() * 40), 0);
      
      const started = new Date(created);
      started.setMinutes(created.getMinutes() + Math.floor(Math.random() * 15) + 5);
      
      const ended = new Date(started);
      ended.setSeconds(started.getSeconds() + duration);
      
      await db.run(
        `INSERT INTO patients (token_number, patient_name, phone_number, status, consultation_start, consultation_end, consultation_duration, created_at)
         VALUES (?, ?, ?, 'COMPLETED', ?, ?, ?, ?)`,
        [
          p + 1,
          name,
          `555-02${Math.floor(10 + Math.random() * 90)}`,
          started.toISOString(),
          ended.toISOString(),
          duration,
          created.toISOString()
        ]
      );
    }
    
    // 1 skipped today
    const skipCreated = new Date();
    skipCreated.setMinutes(now.getMinutes() - 40);
    await db.run(
      `INSERT INTO patients (token_number, patient_name, phone_number, status, created_at)
       VALUES (?, ?, ?, 'SKIPPED', ?)`,
      [6, 'Arthur Dent', '555-4242', skipCreated.toISOString()]
    );
    
    // Seed 4 waiting patients in queue
    const waitingNames = ['Zaphod Beeblebrox', 'Trillian Astra', 'Ford Prefect', 'Marvin Android'];
    for (let w = 0; w < waitingNames.length; w++) {
      const waitCreated = new Date();
      waitCreated.setMinutes(now.getMinutes() - (30 - w * 7));
      await db.run(
        `INSERT INTO patients (token_number, patient_name, phone_number, status, created_at)
         VALUES (?, ?, ?, 'WAITING', ?)`,
        [w + 7, waitingNames[w], `555-03${w}`, waitCreated.toISOString()]
      );
    }
  });
}

async function runSimulationStep() {
  try {
    const active = await db.get(`SELECT * FROM patients WHERE status = 'IN_CONSULTATION'`);
    const waiting = await db.all(`SELECT * FROM patients WHERE status = 'WAITING' ORDER BY token_number ASC`);
    
    if (active) {
      const endTime = new Date().toISOString();
      const mockDurationSeconds = Math.floor(Math.random() * 300) + 240; // 4 to 9 mins
      await db.run(
        `UPDATE patients 
         SET status = 'COMPLETED', consultation_end = ?, consultation_duration = ? 
         WHERE id = ?`,
        [endTime, mockDurationSeconds, active.id]
      );
      console.log(`Demo Simulation: Completed Token #${active.token_number} (${active.patient_name})`);
    } else {
      if (waiting.length > 0) {
        const nextPatient = waiting[0];
        const startTime = new Date().toISOString();
        await db.run(
          `UPDATE patients 
           SET status = 'IN_CONSULTATION', consultation_start = ? 
           WHERE id = ?`,
          [startTime, nextPatient.id]
        );
        console.log(`Demo Simulation: Started Consultation for Token #${nextPatient.token_number} (${nextPatient.patient_name})`);
        
        const state = await getQueueState();
        broadcast({ event: 'QUEUE_UPDATE', state });
        broadcast({ 
          event: 'CALL_PATIENT', 
          patient: { 
            token_number: nextPatient.token_number, 
            patient_name: nextPatient.patient_name 
          } 
        });
        return;
      }
    }
    
    // 15% chance to skip the second patient in waiting list (if queue exists)
    if (waiting.length > 1 && Math.random() < 0.15) {
      const patientToSkip = waiting[1];
      const skipTime = new Date().toISOString();
      await db.run(`UPDATE patients SET status = 'SKIPPED', consultation_end = ? WHERE id = ?`, [skipTime, patientToSkip.id]);
      console.log(`Demo Simulation: Skipped Token #${patientToSkip.token_number} (${patientToSkip.patient_name})`);
    }
    
    // Add new patient if waiting lobby has fewer than 6 patients
    const waitingAfter = await db.all(`SELECT * FROM patients WHERE status = 'WAITING'`);
    if (waitingAfter.length < 6 && (waitingAfter.length < 2 || Math.random() < 0.45)) {
      const name = mockNames[Math.floor(Math.random() * mockNames.length)];
      const token = await generateNextToken();
      await db.run(
        `INSERT INTO patients (token_number, patient_name, phone_number, status) 
         VALUES (?, ?, ?, 'WAITING')`,
        [token, name, `555-09${Math.floor(10 + Math.random() * 90)}`]
      );
      console.log(`Demo Simulation: Registered patient Token #${token} (${name})`);
    }
    
    const state = await getQueueState();
    broadcast({ event: 'QUEUE_UPDATE', state });
  } catch (err) {
    console.error('Demo simulation error:', err.message);
  }
}

// 5e. Simulation populate endpoint
app.post('/api/demo/populate', async (req, res) => {
  try {
    await seedMockData();
    const state = await getQueueState();
    broadcast({ event: 'QUEUE_UPDATE', state });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5f. Start simulation loop
app.post('/api/demo/start', async (req, res) => {
  if (isDemoActive) {
    return res.json({ success: true, message: 'Simulation already running' });
  }
  isDemoActive = true;
  runSimulationStep();
  demoInterval = setInterval(runSimulationStep, 10000);
  
  const state = await getQueueState();
  broadcast({ event: 'QUEUE_UPDATE', state });
  res.json({ success: true, isDemoActive: true });
});

// 5g. Stop simulation loop
app.post('/api/demo/stop', async (req, res) => {
  isDemoActive = false;
  if (demoInterval) {
    clearInterval(demoInterval);
    demoInterval = null;
  }
  const state = await getQueueState();
  broadcast({ event: 'QUEUE_UPDATE', state });
  res.json({ success: true, isDemoActive: false });
});

// 6. Recall previous token (Status change or Re-announcement)
app.post('/api/queue/recall-previous', async (req, res) => {
  try {
    await db.transaction(async () => {
      // Find the last completed or skipped patient
      const lastServed = await db.get(`
        SELECT * FROM patients 
        WHERE status IN ('COMPLETED', 'SKIPPED') 
        ORDER BY id DESC LIMIT 1
      `);

      if (!lastServed) {
        // If no finished patient exists, fall back to re-alerting current in-consultation patient
        const active = await db.get(`SELECT * FROM patients WHERE status = 'IN_CONSULTATION'`);
        if (active) {
          broadcast({ 
            event: 'RECALL_PATIENT', 
            patient: { 
              token_number: active.token_number, 
              patient_name: active.patient_name 
            } 
          });
          return res.json({ success: true, recalledPatient: active, statusChanged: false });
        }
        return res.status(400).json({ error: 'No recent patient to recall' });
      }

      // Re-consultation flow: move current active patient back to WAITING
      const active = await db.get(`SELECT * FROM patients WHERE status = 'IN_CONSULTATION'`);
      if (active) {
        await db.run(`UPDATE patients SET status = 'WAITING' WHERE id = ?`, [active.id]);
      }

      // Move last served patient back to IN_CONSULTATION
      await db.run(`UPDATE patients SET status = 'IN_CONSULTATION' WHERE id = ?`, [lastServed.id]);

      const state = await getQueueState();
      broadcast({ event: 'QUEUE_UPDATE', state });
      broadcast({ 
        event: 'CALL_PATIENT', 
        patient: { 
          token_number: lastServed.token_number, 
          patient_name: lastServed.patient_name 
        } 
      });

      res.json({ success: true, recalledPatient: lastServed, statusChanged: true });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Recall specific patient
app.post('/api/patients/:id/recall', async (req, res) => {
  const { id } = req.params;
  try {
    const patient = await db.get(`SELECT * FROM patients WHERE id = ?`, [id]);
    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }
    broadcast({ 
      event: 'RECALL_PATIENT', 
      patient: { 
        token_number: patient.token_number, 
        patient_name: patient.patient_name 
      } 
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Update Average Consultation Time
app.post('/api/settings', async (req, res) => {
  const { average_consultation_time } = req.body;
  const timeVal = parseInt(average_consultation_time, 10);
  
  if (isNaN(timeVal) || timeVal <= 0) {
    return res.status(400).json({ error: 'Average consultation time must be a positive integer' });
  }

  try {
    await db.run(`UPDATE settings SET average_consultation_time = ? WHERE id = 1`, [timeVal]);
    const state = await getQueueState();
    broadcast({ event: 'QUEUE_UPDATE', state });
    res.json({ success: true, average_consultation_time: timeVal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// WebSocket Server Event Handler
wss.on('connection', async (ws) => {
  console.log('WS Client connected');
  try {
    const state = await getQueueState();
    ws.send(JSON.stringify({ event: 'INITIAL_STATE', state }));
  } catch (err) {
    console.error('Error sending initial WS state:', err.message);
  }
});

// Initialize DB and start Server
async function startServer() {
  await initDatabase();
  server.listen(port, () => {
    console.log(`Queue Cure '26 Server listening at http://localhost:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Error starting server:', err.message);
});
