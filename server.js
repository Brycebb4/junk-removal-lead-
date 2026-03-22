const express = require('express');
const path = require('path');
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

console.log("🚀 Junk Lead Server LIVE | TAVILY key:", !!process.env.TAVILY_API_KEY, "| GROQ key:", !!process.env.GROQ_API_KEY);

let totalLeads = 0, hotLeads = 0, activeAgents = 6, conversionRate = 0;
let seenLeads = new Set();

const agents = [
  { id: "realEstate", name: "Real Estate Monitor", query: "(\"I need junk removed\" OR \"need someone to haul my junk\" OR \"looking for junk removal\" OR \"haul away my junk\" OR \"estate cleanout needed\" OR \"moving junk removal\" OR \"someone remove my trash\" OR \"got stuff to get rid of\" OR \"free junk\" OR \"unwanted items\") (Ohio OR Dayton OR Cincinnati OR Kentucky OR \"southern Indiana\" OR Florence OR Erlanger OR Covington OR Newport OR Bullittsville OR Hebron OR Lawrenceburg OR Greendale OR Petersburg OR Idlewild OR Shawnee OR Addyston OR Wilder OR Cold Spring OR Silver Grove OR Melbourne OR Alexandria OR Fort Thomas OR Southgate OR Independence) -\"we offer\" -service -company -\"junk removal service\" -business -loadup -gotjunk" },
  { id: "socialMedia", name: "Social Media Scanner", query: "(\"anyone haul my junk\" OR \"need junk removed\" OR \"recommend junk hauler\" OR \"looking for someone to remove junk\" OR \"junk removal help\" OR \"pickup my trash\" OR \"need junk hauled\" OR \"got stuff to get rid of\" OR \"free junk\" OR \"unwanted items\") (Ohio OR Dayton OR Cincinnati OR Kentucky OR \"southern Indiana\" OR Florence OR Erlanger OR Covington OR Newport OR Bullittsville OR Hebron OR Lawrenceburg OR Greendale OR Petersburg OR Idlewild OR Shawnee OR Addyston OR Wilder OR Cold Spring OR Silver Grove OR Melbourne OR Alexandria OR Fort Thomas OR Southgate OR Independence) (facebook.com OR reddit.com OR nextdoor.com) -\"we offer\" -service -company -business -loadup -gotjunk" },
  { id: "marketplace", name: "Marketplace Hunter", query: "(\"junk removal needed\" OR \"need junk hauled\" OR \"haul away junk\" OR \"remove my junk\" OR \"trash removal help\" OR \"got stuff to get rid of\" OR \"free junk\" OR \"unwanted items\") (Ohio OR Dayton OR Cincinnati OR Kentucky OR \"southern Indiana\" OR Florence OR Erlanger OR Covington OR Newport OR Bullittsville OR Hebron OR Lawrenceburg OR Greendale OR Petersburg OR Idlewild OR Shawnee OR Addyston OR Wilder OR Cold Spring OR Silver Grove OR Melbourne OR Alexandria OR Fort Thomas OR Southgate OR Independence) (craigslist.org OR facebook.com/marketplace OR nextdoor.com OR offerup.com OR letgo.com) -\"we offer\" -service -company -business -loadup -gotjunk" },
  { id: "eventSeason", name: "Event & Seasonal Tracker", query: "(\"spring cleaning junk\" OR \"moving junk removal\" OR \"estate sale junk\" OR \"garage cleanout needed\" OR \"need junk hauled\" OR \"got stuff to get rid of\" OR \"free junk\" OR \"unwanted items\") (Ohio OR Dayton OR Cincinnati OR Kentucky OR \"southern Indiana\" OR Florence OR Erlanger OR Covington OR Newport OR Bullittsville OR Hebron OR Lawrenceburg OR Greendale OR Petersburg OR Idlewild OR Shawnee OR Addyston OR Wilder OR Cold Spring OR Silver Grove OR Melbourne OR Alexandria OR Fort Thomas OR Southgate OR Independence) -\"we offer\" -service -company -business -loadup -gotjunk" },
  { id: "craigslist", name: "Craigslist Scanner", query: "(\"need junk removed\" OR \"junk haul\" OR \"remove my junk\" OR \"trash hauled\" OR \"scrap removal needed\" OR \"got stuff to get rid of\" OR \"free junk\" OR \"unwanted items\") (dayton OR cincinnati OR \"southern ohio\" OR kentucky OR florence OR erlanger OR covington OR newport OR bullittsville OR hebron OR lawrenceburg OR greendale OR petersburg OR idlewild OR shawnee OR addyston OR wilder OR cold spring OR silver grove OR melbourne OR alexandria OR fort thomas OR southgate OR independence) site:craigslist.org -\"we offer\" -service -company -business -loadup -gotjunk" }
];

async function runAgent(agent) {
  try {
    console.log(`🔍 ${agent.name} scanning...`);
    const tavilyRes = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query: agent.query, search_depth: 'advanced', max_results: 20 })
    });
    const tavilyData = await tavilyRes.json();

    const prompt = `Extract ONLY real individual homeowners/renters asking for junk removal (include borderline like "got stuff to get rid of", "free junk"). Ignore companies. Return ONLY valid JSON array: [{name,phone,email,address,description,source,hot}]`;
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{role:"user", content: prompt + "\n\nRAW: " + JSON.stringify(tavilyData.results || [])}], max_tokens: 2000, temperature: 0 })
    });
    const groq = await groqRes.json();
    let extracted = [];
    try { extracted = JSON.parse(groq.choices?.[0]?.message?.content || "[]"); } catch(e) {}
    console.log(`✅ ${agent.name} → ${extracted.length} leads`);
  } catch(e) { console.error(`❌ ${agent.name}:`, e.message); }
}

cron.schedule('*/3 * * * *', () => agents.forEach(runAgent));  // every 3 min for testing

app.get('/trigger-all', (req, res) => { agents.forEach(runAgent); res.send('🔥 All agents fired — check dashboard!'); });
app.get('/health', (req, res) => res.send('✅ Server healthy + scanning every 3 min'));

app.post('/search-lead', async (req, res) => {
  try {
    const { action, data } = req.body || {};
    if (action === 'search') {
      const t = await fetch('https://api.tavily.com/search', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({api_key:process.env.TAVILY_API_KEY, query:data?.query || "junk removal Cincinnati", max_results:15}) });
      return res.json(await t.json());
    }
    if (action === 'extract') {
      const g = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:'POST', headers:{'Authorization':`Bearer ${process.env.GROQ_API_KEY}`,'Content-Type':'application/json'},
        body:JSON.stringify({model:"llama-3.3-70b-versatile", messages:data.messages || [{role:"user",content:"return []"}], max_tokens:1500})
      });
      const gd = await g.json();
      return res.json({ content: [{ text: gd.choices?.[0]?.message?.content || "[]" }] });
    }
  } catch(e) { console.error("search-lead error:", e.message); }
  res.json({ content: [{ text: "[]" }] });
});

app.get('/api/stats', (req,res) => res.json({totalLeads, hotLeads, activeAgents, conversionRate}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎉 Listening on ${PORT} – visit /trigger-all or /health`));
