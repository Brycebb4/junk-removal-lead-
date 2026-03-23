const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const PORT = process.env.PORT || 3000;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const DATA_FILE = './leads.json';

// Load persistent data
let leadsData = fs.existsSync(DATA_FILE) 
  ? JSON.parse(fs.readFileSync(DATA_FILE)) 
  : { realEstate: [], socialMedia: [], marketplace: [], eventSeason: [], craigslist: [], manual: [] };

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(leadsData, null, 2));
}

// (SEARCH_QUERIES, searchTavily, extractLeadFromResult, extractLocation functions remain EXACTLY the same as your current server.js – I kept them untouched for brevity. Just paste them here from your old file.)

app.get('/trigger-all', async (req, res) => {
  // ... (your exact scanning logic stays 100% the same)
  // After successful scan:
  saveData();
  io.emit('leadsUpdated', leadsData);   // ← REAL-TIME BROADCAST
  res.json({ success: true, message: 'Scan completed' });
});

app.get('/api/leads', (req, res) => res.json(leadsData));

app.post('/api/add-lead', (req, res) => {
  const lead = { ...req.body, timestamp: new Date().toISOString() };
  leadsData.manual.push(lead);
  saveData();
  io.emit('leadsUpdated', leadsData);
  res.json({ success: true });
});

app.delete('/api/leads', (req, res) => {
  leadsData = { realEstate: [], socialMedia: [], marketplace: [], eventSeason: [], craigslist: [], manual: [] };
  saveData();
  io.emit('leadsUpdated', leadsData);
  res.json({ success: true });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', tavilyConfigured: !!TAVILY_API_KEY, leadsCount: Object.values(leadsData).reduce((a, b) => a + b.length, 0) });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT} with real-time + persistence`);
});
