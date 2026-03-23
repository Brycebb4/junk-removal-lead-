const express = require('express');
const path = require('path');
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

console.log("SERVER LIVE | TAVILY:", !!process.env.TAVILY_API_KEY, "| GROQ:", !!process.env.GROQ_API_KEY);

let leadsStore = {
    realEstate: [], socialMedia: [], marketplace: [], eventSeason: [], craigslist: []
};

const agents = [ /* same array as before */ ];

async function runAgent(agent) {
    try {
        console.log(`→ ${agent.name} scanning live web...`);
        const tavily = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query: agent.query, search_depth: 'advanced', max_results: 20 })
        });
        const data = await tavily.json();

        const prompt = `Extract ONLY real homeowners needing junk removal. Return ONLY valid JSON array: [{"name":"...","phone":"...","email":"...","address":"...","description":"...","source":"full url","hot":true}]`;
        const groq = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json'},
            body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{role:"user", content: prompt + "\n\nRAW:\n" + JSON.stringify(data.results)}], max_tokens: 2000 })
        });
        const g = await groq.json();
        let leads = [];
        try { leads = JSON.parse(g.choices[0].message.content || "[]"); } catch(e) {}
        
        leadsStore[agent.id] = leads.map(l => ({...l, createdAt: Date.now()}));
        console.log(`✅ ${agent.name} added ${leads.length} real leads`);
    } catch(e) { console.error(e.message); }
}

// Cron + manual trigger
cron.schedule('*/5 * * * *', () => agents.forEach(runAgent));
app.get('/trigger-all', async (req, res) => { await Promise.all(agents.map(runAgent)); res.send('Real scan fired — refresh dashboard'); });
app.get('/api/leads', (req, res) => res.json(leadsStore));

app.listen(process.env.PORT || 3000, () => console.log('🚀 Server ready — real leads now flow to dashboard'));
