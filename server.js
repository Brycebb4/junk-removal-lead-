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

// FULL EXACT LIST YOU SPECIFIED FOR EVERY AGENT
const FULL_LOCATIONS = "Dayton OR Cincinnati OR Kentucky OR \"southern Indiana\" OR Florence OR Erlanger OR Covington OR Newport OR Bullittsville OR Hebron OR Lawrenceburg OR Greendale OR Petersburg OR Idlewild OR Shawnee OR Addyston OR Wilder OR \"Cold Spring\" OR \"Silver Grove\" OR Melbourne OR Alexandria OR \"Fort Thomas\" OR Southgate OR Independence OR Ohio";

const agents = [
    { id: "realEstate", name: "Real Estate Monitor", query: `("I need junk removed" OR "need someone to haul my junk" OR "looking for junk removal" OR "haul away my junk" OR "estate cleanout needed" OR "moving junk removal" OR "someone remove my trash" OR "got stuff to get rid of" OR "free junk" OR "unwanted items") (${FULL_LOCATIONS}) -"we offer" -service -company -"junk removal service" -business -loadup -gotjunk` },
    { id: "socialMedia", name: "Social Media Scanner", query: `(need junk hauled OR junk removal OR haul my trash OR estate cleanout OR garage cleanout OR "need someone to haul") (Facebook OR Reddit OR Nextdoor) (${FULL_LOCATIONS})` },
    { id: "marketplace", name: "Marketplace Hunter", query: `(junk removal OR haul junk OR clean out garage OR moving sale junk OR "need junk hauled") (OfferUp OR Letgo OR "Facebook Marketplace") (${FULL_LOCATIONS})` },
    { id: "eventSeason", name: "Event & Seasonal Tracker", query: `(garage sale OR moving sale OR estate sale OR spring cleanout OR fall cleanout OR "need junk removed" OR "haul away") (${FULL_LOCATIONS})` },
    { id: "craigslist", name: "Craigslist Scanner", query: `(junk removal OR haul junk OR cleanout OR "need junk hauled") (${FULL_LOCATIONS}) site:craigslist.org` }
];

async function runAgent(agent) {
    try {
        console.log(`→ ${agent.name} scanning live web...`);
        const tavily = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ 
                api_key: process.env.TAVILY_API_KEY, 
                query: agent.query, 
                search_depth: 'advanced', 
                max_results: 20 
            })
        });
        const data = await tavily.json();

        const prompt = `You are an expert junk removal lead extractor.
From these Tavily results, extract EVERY potential homeowner who needs junk hauled/removed/estate cleanout (ignore companies offering services).
For each lead:
- name: first name or "Anonymous"
- phone: exact if mentioned, else "N/A"
- email: exact if mentioned, else "N/A"
- address: city or address mentioned
- description: short summary
- source: full url
- hot: true ONLY if phone or email is NOT "N/A"

Return ONLY valid JSON array like [{"name":...,"phone":...,"email":...,"address":...,"description":...,"source":...,"hot":true/false}] or exactly [] if none.
No extra text, no explanations.`;

        const groq = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json'},
            body: JSON.stringify({ 
                model: "llama-3.3-70b-versatile", 
                messages: [{role:"user", content: prompt + "\n\nRAW SEARCH RESULTS:\n" + JSON.stringify(data.results)}], 
                max_tokens: 2000 
            })
        });
        const g = await groq.json();
        
        const rawLLM = g.choices[0].message.content || "[]";
        console.log(`🔍 ${agent.name} RAW LLM RESPONSE:`, rawLLM);

        let leads = [];
        try { leads = JSON.parse(rawLLM); } catch(e) { console.log(`Parse failed for ${agent.name}`); }
        
        leadsStore[agent.id] = leads.map(l => ({...l, createdAt: Date.now()}));
        console.log(`✅ ${agent.name} added ${leads.length} real leads`);
    } catch(e) { 
        console.error(`ERROR ${agent.name}:`, e.message); 
    }
}

// ────── AUTO-RUN EVERY 5 MINUTES ──────
cron.schedule('*/5 * * * *', () => {
    console.log("⏰ Cron triggered — scanning all agents");
    agents.forEach(runAgent);
});

// ────── MANUAL TRIGGER (Scan Now buttons) ──────
app.get('/trigger-all', async (req, res) => {
    agents.forEach(runAgent);
    res.json({ status: 'scanning started' });
});

app.get('/api/leads', (req, res) => {
    res.json(leadsStore);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
