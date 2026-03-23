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

// FULL AGENTS WITH REAL QUERIES (this was the missing piece)
const agents = [
    { 
        id: "realEstate", 
        name: "Real Estate Monitor", 
        query: "(\"I need junk removed\" OR \"need someone to haul my junk\" OR \"looking for junk removal\" OR \"haul away my junk\" OR \"estate cleanout needed\" OR \"moving junk removal\" OR \"someone remove my trash\" OR \"got stuff to get rid of\" OR \"free junk\" OR \"unwanted items\") (Ohio OR Dayton OR Cincinnati OR Kentucky OR \"southern Indiana\" OR Florence OR Erlanger OR Covington OR Newport OR Bullittsville OR Hebron OR Lawrenceburg OR Greendale OR Petersburg OR Idlewild OR Shawnee OR Addyston OR Wilder OR Cold Spring OR Silver Grove OR Melbourne OR Alexandria OR Fort Thomas OR Southgate OR Independence) -\"we offer\" -service -company -\"junk removal service\" -business -loadup -gotjunk" 
    },
    { 
        id: "socialMedia", 
        name: "Social Media Scanner", 
        query: "(need junk hauled OR junk removal OR haul my trash OR estate cleanout OR garage cleanout OR \"need someone to haul\") (Facebook OR Reddit OR Nextdoor) (Cincinnati OR Dayton OR Florence OR Kentucky OR Ohio)" 
    },
    { 
        id: "marketplace", 
        name: "Marketplace Hunter", 
        query: "(junk removal OR haul junk OR clean out garage OR moving sale junk OR \"need junk hauled\") (OfferUp OR Letgo OR \"Facebook Marketplace\") (Cincinnati OR Dayton OR Florence OR Kentucky)" 
    },
    { 
        id: "eventSeason", 
        name: "Event & Seasonal Tracker", 
        query: "(garage sale OR moving sale OR estate sale OR spring cleanout OR fall cleanout OR \"need junk removed\" OR \"haul away\") (Cincinnati OR Dayton OR \"Northern Kentucky\" OR Florence)" 
    },
    { 
        id: "craigslist", 
        name: "Craigslist Scanner", 
        query: "(junk removal OR haul junk OR cleanout OR \"need junk hauled\") (Cincinnati OR Dayton OR Kentucky OR Florence) site:craigslist.org" 
    }
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

        const prompt = `Extract ONLY real homeowners needing junk removal right now. Return ONLY valid JSON array: [{"name":"...","phone":"...","email":"...","address":"...","description":"...","source":"full url","hot":true}]`;
        const groq = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json'},
            body: JSON.stringify({ 
                model: "llama-3.3-70b-versatile", 
                messages: [{role:"user", content: prompt + "\n\nRAW:\n" + JSON.stringify(data.results)}], 
                max_tokens: 2000 
            })
        });
        const g = await groq.json();
        let leads = [];
        try { leads = JSON.parse(g.choices[0].message.content || "[]"); } catch(e) {}
        
        leadsStore[agent.id] = leads.map(l => ({...l, createdAt: Date.now()}));
        console.log(`✅ ${agent.name} added ${leads.length} real leads`);
    } catch(e) { console.error(e.message); }
}

// Cron every 5 min + manual trigger
cron.schedule('*/5 * * * *', () => agents.forEach(runAgent));
app.get('/trigger-all', async (req, res) => { 
    await Promise.all(agents.map(runAgent)); 
    res.send('Real scan fired — refresh dashboard'); 
});
app.get('/api/leads', (req, res) => res.json(leadsStore));

app.listen(process.env.PORT || 3000, () => console.log('🚀 Server ready — real leads now flow to dashboard'));
