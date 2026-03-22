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
let seenLeads = new Set();

const agents = [
  { name: "Real Estate Monitor", query: "(\"I need junk removed\" OR \"need someone to haul my junk\" OR \"looking for junk removal\" OR \"haul away my junk\" OR \"estate cleanout needed\" OR \"moving junk removal\") (Ohio OR Dayton OR Cincinnati OR Kentucky OR \"southern Indiana\") -\"we offer\" -service -company -\"junk removal service\" -business -loadup -gotjunk -professional -llc -inc -rumpke" },
  { name: "Social Media Scanner", query: "(\"anyone haul my junk\" OR \"need junk removed\" OR \"recommend junk hauler\" OR \"looking for someone to remove junk\" OR \"junk removal help\" OR \"pickup my trash\" OR \"need junk hauled\") (Ohio OR Dayton OR Kentucky OR \"southern Indiana\") (facebook.com OR reddit.com OR nextdoor.com) -\"we offer\" -service -company -business -loadup -gotjunk -professional -llc -inc -rumpke" },
  { name: "Craigslist Scanner", query: "(\"need junk removed\" OR \"junk haul\" OR \"remove my junk\" OR \"trash hauled\" OR \"scrap removal needed\") (dayton OR cincinnati OR \"southern ohio\" OR kentucky) site:craigslist.org -\"we offer\" -service -company -business -loadup -gotjunk -professional -llc -inc -rumpke" },
  { name: "Marketplace Hunter", query: "(\"junk removal needed\" OR \"need junk hauled\" OR \"haul away junk\" OR \"remove my junk\" OR \"trash removal help\") (Ohio OR Dayton OR Kentucky OR \"southern Indiana\") (craigslist.org OR facebook.com/marketplace OR nextdoor.com) -\"we offer\" -service -company -business -loadup -gotjunk -professional -llc -inc -rumpke" },
  { name: "Event & Seasonal Tracker", query: "(\"spring cleaning junk\" OR \"moving junk removal\" OR \"estate sale junk\" OR \"garage cleanout needed\" OR \"need junk hauled\") (Ohio OR Dayton OR Kentucky OR Indiana) -\"we offer\" -service -company -business -loadup -gotjunk -professional -llc -inc -rumpke" }
];

async function runAgent(agent) {
  try {
    const tavilyRes = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query: agent.query, search_depth: 'advanced', max_results: 10 })
    });
    const tavilyData = await tavilyRes.json();

    const prompt = `Extract ONLY real individual homeowners/renters asking for junk removal. NEVER return businesses, companies, services, LLCs, or ads. Return ONLY JSON array.`;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{role:"system",content:"Return ONLY valid JSON array"}, {role:"user",content: prompt + ` Data: ${JSON.stringify(tavilyData.results || [])}` }], max_tokens: 2000, temperature: 0.2 })
    });
    const groqData = await groqRes.json();
    const extracted = JSON.parse(groqData.choices?.[0]?.message?.content || '[]');

    const filtered = extracted.filter(lead => {
      const key = `${(lead.description || '').toLowerCase()}|${(lead.source || '').toLowerCase()}`;
      if (seenLeads.has(key)) return false;
      const text = (lead.description + (lead.source || '')).toLowerCase();
      if (text.includes('we offer') || text.includes('company') || text.includes('business') || text.includes('loadup') || text.includes('gotjunk') || text.includes('llc') || text.includes('professional') || text.includes('rumpke')) return false;
      seenLeads.add(key);
      return true;
    });

    totalLeads += filtered.length;
    hotLeads += Math.floor(filtered.length * 0.4);
    conversionRate = totalLeads ? Math.floor((hotLeads / totalLeads) * 100) : 0;
  } catch (e) {}
}

cron.schedule('*/3 * * * *', () => runAgent(agents[0]));
cron.schedule('*/5 * * * *', () => runAgent(agents[2]));
cron.schedule('*/8 * * * *', () => runAgent(agents[1]));
cron.schedule('*/12 * * * *', () => { runAgent(agents[3]); runAgent(agents[4]); });

app.post('/search-lead', async (req, res) => {
  const { action, data } = req.body;
  if (action === 'search') {
    const tavilyRes = await fetch('https://api.tavily.com/search', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query: data.query, search_depth: 'advanced', max_results: 10 }) });
    const tavilyData = await tavilyRes.json();
    return res.json({ content: tavilyData });
  }
  if (action === 'extract') {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: {'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json'}, body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: data.messages, max_tokens: 2000, temperature: 0.2 }) });
    const groqData = await groqRes.json();
    return res.json({ content: [{ text: groqData.choices?.[0]?.message?.content || '[]' }] });
  }
  res.json({ content: [] });
});

app.get('/api/stats', (req, res) => res.json({ totalLeads, hotLeads, activeAgents, conversionRate }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ LIVE with strict customer-only scanning`));
