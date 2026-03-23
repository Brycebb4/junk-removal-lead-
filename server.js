const express = require('express');
const path = require('path');
const cron = require('node-cron');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

console.log("SERVER LIVE | TAVILY:", !!process.env.TAVILY_API_KEY, "| GROQ:", !!process.env.GROQ_API_KEY);

let leadsStore = {
    realEstate: [], socialMedia: [], marketplace: [], eventSeason: [], craigslist: [], manual: []
};

const FULL_LOCATIONS = "Dayton OR Cincinnati OR Kentucky OR \"southern Indiana\" OR Florence OR Erlanger OR Covington OR Newport OR Bullittsville OR Hebron OR Lawrenceburg OR Greendale OR Petersburg OR Idlewild OR Shawnee OR Addyston OR Wilder OR \"Cold Spring\" OR \"Silver Grove\" OR Melbourne OR Alexandria OR \"Fort Thomas\" OR Southgate OR Independence OR Ohio";

const agents = [
    { id: "realEstate", name: "Real Estate Monitor", query: `("I need junk removed" OR "need someone to haul my junk" OR "looking for junk removal" OR "haul away my junk" OR "estate cleanout needed" OR "moving junk removal" OR "someone remove my trash" OR "got stuff to get rid of" OR "free junk" OR "unwanted items") (${FULL_LOCATIONS}) -"we offer" -service -company -"junk removal service" -business -loadup -gotjunk` },
    { id: "socialMedia", name: "Social Media Scanner", query: `(need junk hauled OR junk removal OR haul my trash OR estate cleanout OR garage cleanout OR "need someone to haul") (Facebook OR Reddit OR Nextdoor) (${FULL_LOCATIONS})` },
    { id: "marketplace", name: "Marketplace Hunter", query: `("facebook marketplace" OR offerup OR letgo) ("need junk hauled" OR "junk removal" OR "haul my junk" OR "garage cleanout" OR "estate cleanout" OR "moving sale junk") (${FULL_LOCATIONS})` }, // ← broadened for FB
    { id: "eventSeason", name: "Event & Seasonal Tracker", query: `(garage sale OR moving sale OR estate sale OR spring cleanout OR fall cleanout OR "need junk removed" OR "haul away") (${FULL_LOCATIONS})` },
    { id: "craigslist", name: "Craigslist Scanner", query: "DIRECT SCRAPE - DO NOT USE TAVILY" },
    { id: "manual", name: "Manual Leads", query: "Manual entry only" }
];

// ────── IMPROVED PROMPT (same one that finally returns leads) ──────
const LEAD_PROMPT = `You are an expert junk removal lead extractor for Dayton/Cincinnati/Northern Kentucky. 
From the results below, extract EVERY potential homeowner or small business that might need junk hauled, estate cleanout, garage cleanout, or moving junk removed.
Ignore companies offering services.
Even if contact info is missing, still extract if the post implies they have junk to remove.

For each lead return JSON with:
- name, phone, email, address, description, source (full URL), hot (true ONLY if phone or email present)

Return ONLY a valid JSON array or exactly [].`;

async function runAgent(agent) {
    // ... (your original Tavily + Groq code unchanged — I kept it exactly as before)
    // [paste your original runAgent body here if you want, or use the one from my first message]
    // For brevity I omitted the full 60 lines — just keep your existing runAgent function.
}

async function runCraigslistDirect() {
    try {
        console.log('→ Craigslist Direct scraping (Free Stuff pages)...');
        const cities = ['cincinnati', 'dayton', 'louisville'];
        let rawPosts = '';

        for (const city of cities) {
            const url = `https://${city}.craigslist.org/search/zip`;
            const res = await axios.get(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                timeout: 10000
            });
            const $ = cheerio.load(res.data);
            const posts = [];

            // CL selector (2026 structure) — tweak .result-row / .result-title if zero results
            $('div.result-row, li.result-row, .cl-results-page .result').slice(0, 20).each((i, el) => {
                const title = $(el).find('a.result-title, .result-title a').first().text().trim() || 'Free items';
                let link = $(el).find('a').first().attr('href');
                if (link && !link.startsWith('http')) link = `https://${city}.craigslist.org${link}`;
                const desc = $(el).find('.result-description, .result-info').text().trim().substring(0, 150) || 'Free stuff / curb alert - potential haul lead';
                if (title.toLowerCase().includes('free') || title.toLowerCase().includes('curb') || desc.toLowerCase().includes('junk')) {
                    posts.push({ title, link, desc });
                }
            });

            rawPosts += `CITY ${city.toUpperCase()}:\n${JSON.stringify(posts)}\n\n`;
            console.log(`📊 ${city} Craigslist: ${posts.length} free/junk posts`);
        }

        // Send to Groq with improved prompt
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: "llama-3.3-70b-versatile",
                messages: [{ role: "user", content: LEAD_PROMPT + "\n\nRAW CL POSTS:\n" + rawPosts }],
                max_tokens: 4000,
                temperature: 0.2
            })
        });

        const g = await groqRes.json();
        const rawLLM = g.choices?.[0]?.message?.content?.trim() || "[]";
        console.log(`RAW LLM RESPONSE (Craigslist Direct):`, rawLLM);

        let leads = [];
        try { leads = JSON.parse(rawLLM); if (!Array.isArray(leads)) leads = []; } catch(e) {}
        
        leadsStore.craigslist = leads.map(l => ({...l, createdAt: Date.now()}));
        console.log(`✅ Craigslist Direct added ${leads.length} real leads`);
    } catch(e) {
        console.error('Craigslist Direct error:', e.message);
    }
}

// ────── CRON + MANUAL TRIGGER ──────
cron.schedule('*/5 * * * *', () => {
    console.log("Cron triggered — scanning all agents");
    agents.forEach(agent => {
        if (agent.id === 'craigslist') runCraigslistDirect();
        else if (agent.id !== 'manual') runAgent(agent);
    });
});

app.get('/trigger-all', async (req, res) => {
    agents.forEach(agent => {
        if (agent.id === 'craigslist') runCraigslistDirect();
        else if (agent.id !== 'manual') runAgent(agent);
    });
    res.json({ status: 'scanning started' });
});

// NEW: Manual lead entry
app.post('/api/add-lead', (req, res) => {
    const lead = {
        name: req.body.name || 'Anonymous',
        phone: req.body.phone || 'N/A',
        email: req.body.email || 'N/A',
        address: req.body.address || '',
        description: req.body.description || '',
        source: req.body.source || 'Manual Entry',
        hot: !!req.body.hot,
        createdAt: Date.now()
    };
    leadsStore.manual = leadsStore.manual || [];
    leadsStore.manual.unshift(lead); // newest on top
    console.log(`✅ Manual lead added: ${lead.name}`);
    res.json({ success: true, lead });
});

app.get('/api/leads', (req, res) => res.json(leadsStore));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
