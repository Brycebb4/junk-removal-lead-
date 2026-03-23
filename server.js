const express = require('express');
const path = require('path');
const cron = require('node-cron');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

console.log("🚀 SERVER LIVE | TAVILY:", !!process.env.TAVILY_API_KEY, "| GROQ:", !!process.env.GROQ_API_KEY);

let leadsStore = {
    realEstate: [], socialMedia: [], marketplace: [], eventSeason: [], craigslist: [], manual: []
};

const FULL_LOCATIONS = "Dayton OR Cincinnati OR Kentucky OR \"southern Indiana\" OR Florence OR Erlanger OR Covington OR Newport OR Bullittsville OR Hebron OR Lawrenceburg OR Greendale OR Petersburg OR Idlewild OR Shawnee OR Addyston OR Wilder OR \"Cold Spring\" OR \"Silver Grove\" OR Melbourne OR Alexandria OR \"Fort Thomas\" OR Southgate OR Independence OR Ohio";

const agents = [
    { id: "realEstate", name: "Real Estate Monitor", query: `("I need junk removed" OR "need someone to haul my junk" OR "looking for junk removal" OR "haul away my junk" OR "estate cleanout needed" OR "moving junk removal" OR "someone remove my trash" OR "got stuff to get rid of" OR "free junk" OR "unwanted items") (${FULL_LOCATIONS}) -"we offer" -service -company -"junk removal service" -business -loadup -gotjunk` },
    { id: "socialMedia", name: "Social Media Scanner", query: `(need junk hauled OR junk removal OR haul my trash OR estate cleanout OR garage cleanout OR "need someone to haul") (Facebook OR Reddit OR Nextdoor) (${FULL_LOCATIONS})` },
    { id: "marketplace", name: "Marketplace Hunter", query: `("facebook marketplace" OR offerup OR letgo) ("need junk hauled" OR "junk removal" OR "haul my junk" OR "garage cleanout" OR "estate cleanout" OR "moving sale junk") (${FULL_LOCATIONS})` },
    { id: "eventSeason", name: "Event & Seasonal Tracker", query: `(garage sale OR moving sale OR estate sale OR spring cleanout OR fall cleanout OR "need junk removed" OR "haul away") (${FULL_LOCATIONS})` },
    { id: "craigslist", name: "Craigslist Scanner", query: "DIRECT SCRAPE" },
    { id: "manual", name: "Manual Leads", query: "Manual entry only" }
];

const LEAD_PROMPT = `You are an expert junk removal lead extractor for Dayton/Cincinnati/Northern Kentucky. 
From the results below, extract EVERY potential homeowner or small business that might need junk hauled, estate cleanout, garage cleanout, or moving junk removed.
Ignore companies offering services.
Even if contact info is missing, still extract if the post implies they have junk to remove.

For each lead return JSON with:
- name, phone, email, address, description, source (full URL), hot (true ONLY if phone or email present)

Return ONLY a valid JSON array or exactly [].`;

// ==================== REAL TAVILY + GROQ ====================
async function tavilySearch(query) {
    try {
        const res = await axios.post('https://api.tavily.com/search', {
            api_key: process.env.TAVILY_API_KEY,
            query: query,
            search_depth: "advanced",
            max_results: 12,
            include_answer: true,
            include_images: false
        });
        return res.data.results || [];
    } catch (e) {
        console.error("Tavily error:", e.message);
        return [];
    }
}

async function extractLeadsWithGroq(rawText, sourceName) {
    try {
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify({
                model: "llama-3.3-70b-versatile",
                messages: [{ role: "user", content: LEAD_PROMPT + "\n\nSOURCE: " + sourceName + "\n\nRAW RESULTS:\n" + rawText }],
                max_tokens: 4000,
                temperature: 0.2
            })
        });

        const g = await groqRes.json();
        const rawLLM = g.choices?.[0]?.message?.content?.trim() || "[]";
        let leads = [];
        try { leads = JSON.parse(rawLLM); } catch(e) { leads = []; }
        if (!Array.isArray(leads)) leads = [];
        return leads;
    } catch (e) {
        console.error("Groq error:", e.message);
        return [];
    }
}

async function runAgent(agent) {
    console.log(`🚀 Real scan → ${agent.name}`);
    if (agent.id === 'manual') return;

    let rawResults = "";

    if (agent.id === 'craigslist') {
        // Keep your existing working Craigslist code
        await runCraigslistDirect();
        return;
    } else {
        // === REAL TAVILY ===
        const tavilyResults = await tavilySearch(agent.query);
        rawResults = tavilyResults.map(r => `${r.title}\n${r.content || r.snippet}\nURL: ${r.url}`).join("\n\n");
    }

    const leads = await extractLeadsWithGroq(rawResults, agent.name);

    leadsStore[agent.id] = leads.map(l => ({...l, createdAt: Date.now(), source: agent.name}));
    console.log(`✅ ${agent.name} added ${leads.length} real leads`);
}

async function runCraigslistDirect() {
    // ← Your original Craigslist code stays 100% unchanged (I kept it exactly)
    try {
        console.log('→ Craigslist Direct scraping...');
        const cities = ['cincinnati', 'dayton', 'louisville'];
        let rawPosts = '';

        for (const city of cities) {
            const url = `https://${city}.craigslist.org/search/zip`;
            const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 });
            const $ = cheerio.load(res.data);
            const posts = [];

            $('li.cl-static-search-result, li.result-row').each((i, el) => {
                const title = $(el).find('.cl-search-result-title, a.result-title').first().text().trim() || 'Free item';
                let link = $(el).find('a').first().attr('href');
                if (link && !link.startsWith('http')) link = `https://${city}.craigslist.org${link}`;
                const desc = $(el).text().trim().substring(0, 150) || 'Free stuff / curb alert';

                if (title.toLowerCase().match(/free|curb|junk|haul|cleanout|moving|estate|garage/i)) {
                    posts.push({ title, link, desc });
                }
            });

            rawPosts += `CITY ${city.toUpperCase()}:\n${JSON.stringify(posts)}\n\n`;
        }

        const leads = await extractLeadsWithGroq(rawPosts, "Craigslist");
        leadsStore.craigslist = leads.map(l => ({...l, createdAt: Date.now()}));
        console.log(`✅ Craigslist added ${leads.length} real leads`);
    } catch(e) {
        console.error('Craigslist error:', e.message);
    }
}

// ────── Triggers ──────
cron.schedule('*/5 * * * *', () => {
    console.log("⏰ Cron → scanning all");
    agents.forEach(agent => {
        if (agent.id !== 'manual') runAgent(agent);
    });
});

app.get('/trigger-all', async (req, res) => {
    agents.forEach(agent => { if (agent.id !== 'manual') runAgent(agent); });
    res.json({ status: 'scanning started' });
});

app.post('/api/add-lead', (req, res) => { /* your manual code stays exactly as before */ 
    const lead = { ...req.body, hot: !!req.body.hot, createdAt: Date.now(), source: 'Manual' };
    leadsStore.manual.unshift(lead);
    res.json({ success: true, lead });
});

app.get('/api/leads', (req, res) => res.json(leadsStore));

app.listen(process.env.PORT || 3000, () => {
    console.log('✅ Junk Removal Lead Generator LIVE with REAL Tavily + Groq');
});
