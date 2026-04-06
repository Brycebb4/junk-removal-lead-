const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const { parseStringPromise } = require('xml2js');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(__dirname));

// ─── IN-MEMORY LEAD STORE ─────────────────────────────────────────
let leadsDB = { leads: [], watchdog: [], manual: [] };
const seenKeys = new Set(); // Prevent duplicate leads

function makeKey(platform, id) {
  return `${platform}::${id}`;
}

// ─── CITIES / REGIONS TO SCAN ────────────────────────────────────
const CRAIGSLIST_CITIES = [
  'cincinnati',
  'dayton',
  'lexington',
  'columbus',
];

// ─── JUNK REMOVAL KEYWORDS ────────────────────────────────────────
const LEAD_KEYWORDS = [
  'junk removal', 'junk hauling', 'haul away', 'haul junk',
  'cleanout', 'clean out', 'garage cleanout', 'basement cleanout',
  'moving help', 'need help moving', 'furniture removal',
  'appliance removal', 'old couch', 'old furniture',
  'mattress removal', 'hot tub removal', 'trash removal',
  'debris removal', 'estate cleanout', 'foreclosure cleanout',
  'junk picked up', 'stuff picked up', 'need someone to haul',
  'need junk removed', 'who hauls', 'who picks up',
];

const WATCHDOG_KEYWORDS = [
  'property cleanout', 'tenant cleanout', 'vacant property',
  'eviction cleanout', 'foreclosure cleanout', 'estate sale cleanout',
  'listing cleanout', 'pre-listing', 'flip cleanout',
  'rental cleanout', 'landlord cleanout',
  'need junk removal company', 'recommend junk removal',
  'any junk removal', 'good junk removal',
];

function containsKeyword(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

function classifyLead(text) {
  const lower = text.toLowerCase();
  if (lower.includes('phone') || lower.includes('call') || lower.includes('text me') ||
      lower.includes('asap') || lower.includes('today') || lower.includes('tomorrow') ||
      lower.includes('urgent') || lower.includes('right away') || lower.includes('quickly')) {
    return 'hot';
  }
  return 'cold';
}

// ─── CRAIGSLIST RSS SCANNER ───────────────────────────────────────
async function scanCraigslistCity(city, keywords, isWatchdog = false) {
  const newLeads = [];
  const sections = ['hss', 'lbg', 'zip', 'csd']; // services, labor/gigs, free stuff, community

  for (const section of sections) {
    for (const kw of keywords.slice(0, 5)) { // Limit to top 5 keywords per section to avoid rate limits
      const url = `https://${city}.craigslist.org/search/${section}?query=${encodeURIComponent(kw)}&format=rss`;
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadScanner/1.0)' },
          timeout: 8000,
        });
        if (!res.ok) continue;
        const xml = await res.text();
        const parsed = await parseStringPromise(xml, { explicitArray: false });
        const items = parsed?.rss?.channel?.item;
        if (!items) continue;
        const itemList = Array.isArray(items) ? items : [items];

        for (const item of itemList) {
          const title = item.title || '';
          const desc = (item.description || '').replace(/<[^>]+>/g, '').trim();
          const link = item.link || '';
          const pubDate = item.pubDate || new Date().toISOString();
          const combinedText = title + ' ' + desc;

          if (!containsKeyword(combinedText, isWatchdog ? keywords : LEAD_KEYWORDS)) continue;

          const key = makeKey(`craigslist-${city}`, link);
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);

          const temp = classifyLead(combinedText);
          newLeads.push({
            _key: key,
            name: 'Craigslist Post',
            title: title.substring(0, 120),
            description: desc.substring(0, 300),
            source: link,
            platform: `Craigslist (${city})`,
            address: city.charAt(0).toUpperCase() + city.slice(1),
            timestamp: new Date(pubDate).toISOString(),
            temp,
            taken: false,
            phone: '',
            email: '',
          });
        }
      } catch (e) {
        // Silently skip failed cities/sections
        console.log(`CL skip ${city}/${section}/${kw}: ${e.message}`);
      }
      await sleep(300); // Be polite
    }
  }
  return newLeads;
}

// ─── REDDIT SCANNER ───────────────────────────────────────────────
const REDDIT_SUBS = [
  'cincinnati', 'Dayton', 'lexington', 'Columbus',
  'northernkentucky', 'movingto', 'homeinspection',
];

async function scanReddit(keywords, isWatchdog = false) {
  const newLeads = [];

  for (const sub of REDDIT_SUBS) {
    for (const kw of keywords.slice(0, 3)) {
      const url = `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(kw)}&sort=new&restrict_sr=1&limit=25`;
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'JunkRemovalLeadBot/1.0 (by /u/junkremovalscanner)',
          },
          timeout: 8000,
        });
        if (!res.ok) continue;
        const data = await res.json();
        const posts = data?.data?.children || [];

        for (const { data: post } of posts) {
          const title = post.title || '';
          const body = post.selftext || '';
          const combinedText = title + ' ' + body;

          if (!containsKeyword(combinedText, isWatchdog ? keywords : LEAD_KEYWORDS)) continue;

          const key = makeKey(`reddit-${sub}`, post.id);
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);

          const temp = classifyLead(combinedText);
          const created = new Date(post.created_utc * 1000).toISOString();

          newLeads.push({
            _key: key,
            name: post.author || 'Reddit User',
            title: title.substring(0, 120),
            description: (body || title).substring(0, 300),
            source: `https://reddit.com${post.permalink}`,
            platform: `Reddit r/${sub}`,
            address: sub.charAt(0).toUpperCase() + sub.slice(1),
            timestamp: created,
            temp,
            taken: false,
            phone: '',
            email: '',
          });
        }
      } catch (e) {
        console.log(`Reddit skip r/${sub}/${kw}: ${e.message}`);
      }
      await sleep(500); // Reddit rate limit: be polite
    }
  }
  return newLeads;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── TRIGGER: LEAD SCANNER ────────────────────────────────────────
app.get('/trigger-all', async (req, res) => {
  console.log('[Scanner] Starting lead scan...');
  const newLeads = [];

  // Craigslist scan
  for (const city of CRAIGSLIST_CITIES) {
    const leads = await scanCraigslistCity(city, LEAD_KEYWORDS, false);
    newLeads.push(...leads);
    await sleep(500);
  }

  // Reddit scan
  const redditLeads = await scanReddit(LEAD_KEYWORDS, false);
  newLeads.push(...redditLeads);

  leadsDB.leads.push(...newLeads);

  io.emit('leadsUpdated', leadsDB);
  console.log(`[Scanner] Found ${newLeads.length} new leads`);
  res.json({ success: true, message: `Lead Scanner - ${newLeads.length} new leads`, totalNew: newLeads.length });
});

// ─── TRIGGER: WATCHDOG ────────────────────────────────────────────
app.get('/trigger-watchdog', async (req, res) => {
  console.log('[Watchdog] Starting network scan...');
  const newLeads = [];

  for (const city of CRAIGSLIST_CITIES) {
    const leads = await scanCraigslistCity(city, WATCHDOG_KEYWORDS, true);
    newLeads.push(...leads);
    await sleep(500);
  }

  const redditLeads = await scanReddit(WATCHDOG_KEYWORDS, true);
  newLeads.push(...redditLeads);

  // Tag watchdog leads with professional type
  newLeads.forEach(l => {
    const lower = (l.title + l.description).toLowerCase();
    if (lower.includes('realtor') || lower.includes('listing') || lower.includes('pre-listing')) l.professionalType = 'Realtor';
    else if (lower.includes('landlord') || lower.includes('rental') || lower.includes('tenant')) l.professionalType = 'Landlord';
    else if (lower.includes('estate')) l.professionalType = 'Estate';
    else if (lower.includes('flip') || lower.includes('investor')) l.professionalType = 'Investor';
    else if (lower.includes('property manager')) l.professionalType = 'Property Mgr';
    else l.professionalType = 'Pro';
  });

  leadsDB.watchdog.push(...newLeads);

  io.emit('leadsUpdated', leadsDB);
  console.log(`[Watchdog] Found ${newLeads.length} new leads`);
  res.json({ success: true, message: `Watchdog - ${newLeads.length} network leads`, totalNew: newLeads.length });
});

// ─── GET ALL LEADS ────────────────────────────────────────────────
app.get('/api/leads', (req, res) => {
  res.json(leadsDB);
});

// ─── ADD MANUAL LEAD ──────────────────────────────────────────────
app.post('/api/add-lead', (req, res) => {
  const lead = {
    ...req.body,
    _key: `manual::${Date.now()}`,
    platform: 'Manual',
    timestamp: new Date().toISOString(),
    taken: false,
  };
  leadsDB.manual.push(lead);
  io.emit('leadsUpdated', leadsDB);
  res.json({ success: true });
});

// ─── MARK TAKEN / UNTAKEN ─────────────────────────────────────────
app.post('/api/leads/:key/taken', (req, res) => {
  const key = decodeURIComponent(req.params.key);
  for (const list of [leadsDB.leads, leadsDB.watchdog, leadsDB.manual]) {
    const lead = list.find(l => l._key === key);
    if (lead) lead.taken = true;
  }
  io.emit('leadsUpdated', leadsDB);
  res.json({ success: true });
});

app.post('/api/leads/:key/untaken', (req, res) => {
  const key = decodeURIComponent(req.params.key);
  for (const list of [leadsDB.leads, leadsDB.watchdog, leadsDB.manual]) {
    const lead = list.find(l => l._key === key);
    if (lead) lead.taken = false;
  }
  io.emit('leadsUpdated', leadsDB);
  res.json({ success: true });
});

// ─── DELETE SINGLE LEAD ───────────────────────────────────────────
app.delete('/api/leads/:key', (req, res) => {
  const key = decodeURIComponent(req.params.key);
  leadsDB.leads = leadsDB.leads.filter(l => l._key !== key);
  leadsDB.watchdog = leadsDB.watchdog.filter(l => l._key !== key);
  leadsDB.manual = leadsDB.manual.filter(l => l._key !== key);
  io.emit('leadsUpdated', leadsDB);
  res.json({ success: true });
});

// ─── DELETE ALL LEADS ─────────────────────────────────────────────
app.delete('/api/leads', (req, res) => {
  leadsDB = { leads: [], watchdog: [], manual: [] };
  seenKeys.clear();
  io.emit('leadsUpdated', leadsDB);
  res.json({ success: true });
});

// ─── Serve dashboard for any unmatched GET ───────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── START SERVER ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Junk Removal Lead Scanner running on port ${PORT}`);
  console.log(`📡 Scanning: Craigslist (${CRAIGSLIST_CITIES.join(', ')}) + Reddit`);
});
