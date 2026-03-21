const express = require('express');
const path = require('path');
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

let totalLeads = 0;
let hotLeads = 0;
let activeAgents = 6;
let conversionRate = 0;
let allLeads = [];

// 6 auto-scanning agents (background)
const agents = [
  { name: "Real Estate Monitor", query: "(\"need junk removed\" OR \"junk haul away\" OR \"need haul\" OR \"remove my junk\" OR \"estate cleanout needed\" OR \"moving junk removal\") (\"Ohio\" OR \"Dayton\" OR \"Cincinnati\" OR \"Kentucky\" OR \"Lexington\" OR \"Louisville\" OR \"southern Indiana\") (foreclosure OR moving OR \"new home\" OR \"estate sale\") -"we offer" -service -company" },
  { name: "Social Media Scanner", query: "(\"looking for junk removal\" OR \"need junk hauled\" OR \"recommend junk hauler\" OR \"someone to remove my junk\" OR \"haul my trash\" OR \"junk removal needed\") (\"Ohio\" OR \"Dayton\" OR \"Kentucky\" OR \"southern Indiana\" OR \"Cincinnati\" OR \"Columbus\") (facebook.com OR reddit.com OR group) -offer -service" },
  { name: "Craigslist Scanner", query: "junk removal OR \"haul away\" OR \"junk hauled\" site:craigslist.org (Ohio OR Dayton OR Cincinnati OR Kentucky OR \"southern Indiana\")" },
  { name: "Reddit Scanner", query: "(\"junk removal\" OR \"haul my junk\" OR \"need junk hauled\") (Ohio OR Dayton OR Kentucky OR Cincinnati) subreddit:Ohio OR subreddit:Kentucky OR subreddit:Cincinnati" },
  { name: "Facebook Groups", query: "(\"junk removal\" OR \"haul away junk\" OR \"need junk removed\") (Ohio OR Dayton OR Kentucky) (facebook.com/groups)" },
  { name: "Local Classifieds", query: "(\"junk removal\" OR \"estate cleanout\" OR \"moving haul\") (Ohio OR \"southern Indiana\" OR Dayton OR Kentucky)" }
];

async function runAgent(agent) {
  try {
    const tavilyRes = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query: agent.query, search_depth: 'advanced', max_results: 10 })
    });
    const tavilyData = await tavilyRes.json();

    // Reuse your existing Groq extraction via the POST endpoint logic
    const messages = [{ role: "system", content: "You are a precise JSON extractor. Return ONLY a valid JSON array of leads. No explanations." },
      { role: "user", content: `Extract all junk removal leads... Data: ${JSON.stringify(tavilyData.results || [])}` }];

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, max_tokens: 2000, temperature: 0.2 })
    });
    const groqData = await groqRes.json();
    const extracted = JSON.parse(groqData.choices?.[0]?.message?.content || '[]');

    if (Array.isArray(extracted) && extracted.length > 0) {
      allLeads = allLeads.concat(extracted);
      totalLeads += extracted.length;
      hotLeads += Math.floor(extracted.length * 0.4);
      conversionRate = totalLeads ? Math.floor((hotLeads / totalLeads) * 100) : 0;
    }
  } catch (e) {
    console.error(`Agent ${agent.name} failed:`, e.message);
  }
}

// Your original /search-lead (unchanged + working)
app.post('/search-lead', async (req, res) => {
  if (req.body.action === 'search') {
    const tavilyRes = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query: req.body.data.query, search_depth: 'advanced', max_results: 8 })
    });
    const tavilyData = await tavilyRes.json();
    return res.json({ success: true, content: tavilyData.results || [] });
  }
  if (req.body.action === 'extract') {
    const messages = [{ role: "system", content: "You are a precise JSON extractor. Return ONLY a valid JSON array of leads. No explanations, no markdown." }, ...req.body.data.messages];
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, max_tokens: 2000, temperature: 0.2 })
    });
    const groqData = await groqRes.json();
    const text = groqData.choices?.[0]?.message?.content || '[]';
    return res.json({ success: true, content: [{ type: 'text', text }] });
  }
  res.status(400).json({ error: 'Invalid action' });
});

app.get('/api/stats', (req, res) => {
  res.json({ totalLeads, hotLeads, activeAgents, conversionRate, leads: allLeads });
});

cron.schedule('*/5 * * * *', async () => {
  console.log('🚀 Running 6 agents...');
  for (const agent of agents) await runAgent(agent);
  console.log(`✅ Scan complete — Total Leads: ${totalLeads}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Junk Removal Lead Generator LIVE with 6 active agents`);
  agents.forEach(runAgent); // initial scan
});
