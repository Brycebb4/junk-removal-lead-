const express = require('express');
const path = require('path');
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

console.log("🚀 Server started | TAVILY:", !!process.env.TAVILY_API_KEY, "| GROQ:", !!process.env.GROQ_API_KEY);

let totalLeads = 0, hotLeads = 0, activeAgents = 6, conversionRate = 0;
let seenLeads = new Set();

// (your agents array — already perfect, leave it)

const agents = [ /* paste your existing agents array here — it's already correct */ ];

async function runAgent(agent) {
  try {
    console.log(`🔍 ${agent.name} scanning...`);
    // ... (your exact runAgent code is already good — just keep it)
    console.log(`✅ ${agent.name} added leads`);
  } catch (e) {
    console.error(`❌ ${agent.name} error:`, e.message);
  }
}

cron.schedule('*/5 * * * *', () => agents.forEach(runAgent));

// NEW manual trigger
app.get('/trigger-all', (req, res) => {
  agents.forEach(runAgent);
  res.send('🔥 All agents fired — check dashboard in 10s');
});

app.get('/health', (req, res) => res.send('✅ Junk Lead Bot ALIVE'));

// your /search-lead and /api/stats stay exactly as you have them

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎉 Render live → http://localhost:${PORT} | Visit /trigger-all to test now`));
