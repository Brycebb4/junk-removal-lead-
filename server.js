const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const cron = require('node-cron');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const PORT           = process.env.PORT           || 3000;
const SERPER_API_KEY = process.env.SERPER_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALERT_EMAIL    = process.env.ALERT_EMAIL    || 'junkboysremoval394@gmail.com';
const DATA_FILE      = './leads.json';

// ─── Persistent store (single agent: "leads" + manual entry) ─────────────────
let leadsData = fs.existsSync(DATA_FILE)
  ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  : { leads: [], manual: [] };

// Migrate old multi-agent format if needed
if (leadsData.realEstate || leadsData.socialMedia) {
  leadsData = { leads: [], manual: leadsData.manual || [] };
}

let seenLeadKeys = new Set(
  Object.values(leadsData).flat().map(l => l._key).filter(Boolean)
);

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(leadsData, null, 2));
}

// ─── LOCATIONS (full service radius) ─────────────────────────────────────────
const LOCATIONS = [
  'Cincinnati', 'Dayton', 'Northern Kentucky', 'Florence', 'Erlanger',
  'Covington', 'Newport', 'Hebron', 'Lawrenceburg', 'Greendale',
  'Petersburg', 'Independence', 'Cold Spring', 'Fort Thomas', 'Southgate',
  'Alexandria', 'Melbourne', 'Wilder', 'Silver Grove', 'Addyston',
  'Shawnee', 'Idlewild', 'Bullittsville', 'West Chester', 'Mason',
  'Fairfield', 'Norwood', 'Blue Ash', 'Milford', 'Anderson Township',
  'Loveland', 'Maineville', 'Hamilton', 'Middletown', 'Springboro',
  'Kettering', 'Miamisburg', 'Centerville', 'Huber Heights', 'Xenia',
];

// ─── Search queries — CUSTOMERS ONLY ────────────────────────────────────────
// Grouped by intent. Every query targets customer language, not business SEO.
const SEARCH_QUERIES = [

  // === CUSTOMERS SEARCHING GOOGLE for junk removal ===
  '"looking for junk removal" Cincinnati OR Dayton OR "Northern Kentucky"',
  '"need junk removal" Cincinnati OR Dayton OR Florence OR Covington',
  '"anyone know" "junk removal" Cincinnati OR Dayton OR "Northern Kentucky"',
  '"recommend" "junk removal" Cincinnati OR Dayton',
  '"who does junk removal" Cincinnati OR Dayton OR "Northern Kentucky"',
  '"junk removal near me" Cincinnati OR Dayton',

  // === HAULING / U-HAUL / MOVING keywords ===
  '"need someone to haul" Cincinnati OR Dayton OR "Northern Kentucky"',
  '"haul away" "need help" Cincinnati OR Dayton OR Covington',
  '"need a haul" Cincinnati OR Dayton furniture OR junk OR appliance',
  '"U-Haul" OR "Uhaul" Cincinnati "junk" OR "haul away" OR "clean out"',
  '"moving out" Cincinnati OR Dayton "need help" OR "junk removal"',
  '"moving" "need junk removed" Cincinnati OR Dayton OR Florence',
  '"help moving" Cincinnati OR Dayton furniture OR stuff OR hauling',

  // === FACEBOOK GROUP POSTS — people asking for help ===
  'site:facebook.com "need junk removal" Cincinnati OR Dayton',
  'site:facebook.com "anyone recommend" "junk removal" Cincinnati',
  'site:facebook.com "haul away" Cincinnati OR Dayton OR "Northern Kentucky"',
  'site:facebook.com "need help moving" Cincinnati OR Dayton',
  'site:facebook.com "looking for someone" junk OR haul OR remove Cincinnati',
  'site:facebook.com "clean out" Cincinnati OR Dayton "need" OR "looking for"',

  // === REDDIT / NEXTDOOR / CRAIGSLIST — community posts ===
  'site:reddit.com "junk removal" Cincinnati OR Dayton recommend',
  'site:craigslist.org "junk removal" Cincinnati OR Dayton',
  'site:craigslist.org "haul away" Cincinnati OR Dayton OR "Northern Kentucky"',
  'site:craigslist.org "need junk removed" Ohio OR Kentucky',
  'Nextdoor "junk removal" Cincinnati OR Dayton recommendation',

  // === REAL ESTATE — realtors, landlords, property managers needing cleanout ===
  '"realtor" OR "real estate agent" Cincinnati "need cleanout" OR "need junk removed"',
  '"landlord" Cincinnati OR Dayton "tenant left" OR "tenant moved out" junk OR cleanout',
  '"property manager" Cincinnati OR Dayton cleanout OR "junk removal" needed',
  '"eviction cleanout" Cincinnati OR Dayton OR "Northern Kentucky"',
  '"foreclosure" Cincinnati OR Dayton cleanout OR "junk removal"',
  '"estate cleanout" Cincinnati OR Dayton "need help" OR "looking for"',
  '"selling my house" Cincinnati OR Dayton "junk" OR "cleanout" OR "haul"',
  '"preparing to sell" OR "getting ready to list" Cincinnati cleanout OR junk',
  '"rental turnover" OR "rental cleanout" Cincinnati OR Dayton junk OR haul',
  '"flip" OR "flipping" Cincinnati OR Dayton "junk removal" OR cleanout OR debris',
];

// ─── Serper.dev Google Search ────────────────────────────────────────────────
async function searchSerper(query) {
  if (!SERPER_API_KEY) {
    console.warn('SERPER_API_KEY not set - skipping search');
    return [];
  }
  try {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, num: 10, tbs: 'qdr:w' }),
    });
    if (!response.ok) {
      console.error(`Serper error for "${query}":`, await response.text());
      return [];
    }
    const data = await response.json();
    return (data.organic || []).map(r => ({
      title:   r.title   || '',
      url:     r.link    || '',
      content: r.snippet || '',
    }));
  } catch (e) {
    console.error('Serper fetch error:', e.message);
    return [];
  }
}

// ─── BLOCKED DOMAINS — known businesses, directories, SEO pages ─────────────
const BLOCKED_DOMAINS = [
  'yelp.com', 'angi.com', 'thumbtack.com', 'homeadvisor.com', 'angieslist.com',
  'houzz.com', 'porch.com', '1800gotjunk.com', 'junk-king.com', 'collegehunks.com',
  'loadup.com', 'junkluggers.com', 'junkremoval.com', 'gotjunk.com', 'bagster.com',
  'dumpsters.com', 'wastepro.com', 'rumpke.com', 'republic-services.com', 'wm.com',
  'goodfellasjunk.com', 'holtshauling.com', 'tristatejunk.com', 'rubbish-works.com',
  'jdog.com', 'trashking.com', 'dimeo.com', 'bintheredumpthat.com',
  'yellowpages.com', 'bbb.org', 'manta.com', 'mapquest.com', 'superpages.com',
  'chamberofcommerce.com', 'birdeye.com', 'bark.com', 'hireahelper.com',
  'uhaul.com', 'pods.com', 'budgettruck.com', 'pensketruckrental.com',
];

// ─── BUSINESS SIGNALS — if ANY ONE matches, result is a business/contractor ──
const BUSINESS_SIGNALS = [
  // Corporate language
  'our team', 'we offer', 'we provide', 'our services', 'our company',
  'licensed and insured', 'fully licensed', 'fully insured',
  'family owned', 'locally owned', 'family-owned', 'locally-owned',
  'veteran owned', 'woman owned', 'black owned',
  'serving the greater', 'serving cincinnati', 'serving dayton', 'serving the tri',
  'free estimates', 'get a free estimate', 'get a free quote', 'free quote',
  'book online', 'book now', 'schedule a pickup', 'schedule online', 'schedule today',
  'pay my bill', 'we specialize in', 'our crew', 'our professionals',
  'contact us today', 'call us today', 'call us now', 'call for a free',
  'junk removal company', 'hauling company', 'removal service', 'hauling service',
  'removal services llc', 'hauling llc', 'junk removal llc',
  'visit our website', 'check out our', 'follow us on',
  'years of experience', 'years in business', 'since 20', 'established in',
  'top rated', 'top 10 best', '5 star', 'five star', '4.9', '4.8',
  'eco-friendly', 'eco friendly', 'customer centric',
  'skip to content', 'view schedule',

  // Independent contractors advertising in Facebook groups
  'does anyone need junk', 'does anyone need removal', 'anyone need junk',
  'need it gone? i got you', 'i got you', 'we got you',
  'we are out hauling', 'we are hauling', 'out hauling',
  'let us know if we can help', 'we can help you', 'let us help',
  'give us a call', 'give me a call', 'hit me up', 'hmu',
  'dm me', 'inbox me', 'message me', 'text me', 'call me',
  'affordable and reliable', 'affordable & reliable',
  'i am affordable', 'we are affordable',
  'dumpster rental', 'rent a dumpster',
  'junk removal today', 'hauling today', 'removal today',
  'same day pickup', 'same-day pickup',
  'we do junk', 'i do junk', 'we handle junk', 'i handle junk',
  'we remove junk', 'i remove junk', 'we haul junk', 'i haul junk',
  'offering junk removal', 'offering hauling', 'offering removal',
  'junk removal service available', 'services available',
  'demolition', 'we also do',
];

// ─── CUSTOMER NEED signals — at least one must match ─────────────────────────
const CUSTOMER_SIGNALS = [
  'need', 'looking for', 'anyone', 'recommend', 'help', 'want', 'hire',
  'haul away', 'pick up', 'remove', 'cleanout', 'clean out', 'dispose',
  'get rid', 'junk', 'clutter', 'debris', 'furniture', 'appliance',
  'moving', 'clearing out', 'overwhelmed', 'too much stuff',
  'tenant left', 'tenant moved', 'eviction', 'foreclosure', 'estate',
  'selling my house', 'preparing to sell', 'getting ready to list',
  'landlord', 'property manager', 'rental turnover', 'flip',
];

// ─── Extract a lead from a search result ─────────────────────────────────────
function extractLead(result) {
  const text  = `${result.title || ''} ${result.content || ''}`.toLowerCase();
  const url   = result.url || '';
  const title = result.title || '';
  const snippet = result.content || '';

  // 1. Block known business/directory domains
  if (BLOCKED_DOMAINS.some(d => url.toLowerCase().includes(d))) return null;

  // 2. Block if ANY business signal matches (aggressive — zero tolerance)
  if (BUSINESS_SIGNALS.some(sig => text.includes(sig))) return null;

  // 3. Must contain at least one customer-need signal
  if (!CUSTOMER_SIGNALS.some(sig => text.includes(sig))) return null;

  // 4. Deduplicate by URL or title
  const key = url || title.substring(0, 60);
  if (seenLeadKeys.has(key)) return null;
  seenLeadKeys.add(key);

  // Extract contact info
  const phoneMatch = text.match(/(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/);
  const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  const phone = phoneMatch ? phoneMatch[1] : null;
  const email = emailMatch ? emailMatch[0] : null;

  // Extract location
  const location = LOCATIONS.find(loc => text.includes(loc.toLowerCase())) || 'Cincinnati Area';

  // Platform label
  let platform = 'Google';
  if (url.includes('facebook'))  platform = 'Facebook';
  else if (url.includes('reddit'))    platform = 'Reddit';
  else if (url.includes('craigslist')) platform = 'Craigslist';
  else if (url.includes('nextdoor'))  platform = 'Nextdoor';
  else if (url.includes('offerup'))   platform = 'OfferUp';

  return {
    _key:        key,
    name:        'Potential Customer',
    description: snippet.substring(0, 200),
    address:     location,
    phone:       phone || '',
    email:       email || '',
    source:      url,
    platform,
    hot:         !!(phone || email),
    title,
    timestamp:   new Date().toISOString(),
    agentKey:    'leads',
  };
}

// ─── Send email alert ────────────────────────────────────────────────────────
async function sendEmailAlert(newLeads) {
  if (!RESEND_API_KEY || !newLeads.length) return;
  const leadRows = newLeads.map((l, i) => `
    <div style="border-left:4px solid #28a745;padding:12px 16px;margin:12px 0;background:#f8f9fa;border-radius:4px;">
      <strong>${i + 1}. ${l.title || l.description?.substring(0, 80)}</strong><br/>
      ${l.address} | ${l.platform}<br/>
      ${l.phone ? `Phone: <a href="tel:${l.phone}">${l.phone}</a><br/>` : ''}
      ${l.email ? `Email: <a href="mailto:${l.email}">${l.email}</a><br/>` : ''}
      ${l.source ? `<a href="${l.source}" style="color:#e74c3c;">View Original Post</a>` : ''}
    </div>`).join('');

  const html = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
    <h2 style="color:#28a745;">${newLeads.length} New Junk Removal Lead${newLeads.length > 1 ? 's' : ''} Found!</h2>
    <hr/><p>Your scanner found new potential customers:</p>${leadRows}
    <a href="https://junk-removal-lead-2.onrender.com" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#28a745;color:white;border-radius:8px;text-decoration:none;font-weight:700;">View Dashboard</a>
  </div>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Lead Scanner <onboarding@resend.dev>',
        to: [ALERT_EMAIL],
        subject: `${newLeads.length} New Junk Removal Lead${newLeads.length > 1 ? 's' : ''}!`,
        html,
      }),
    });
    if (res.ok) console.log(`Email alert sent for ${newLeads.length} leads`);
    else console.error('Resend error:', await res.text());
  } catch (e) {
    console.error('Email send failed:', e.message);
  }
}

// ─── Core scan ───────────────────────────────────────────────────────────────
async function runScan() {
  console.log(`[${new Date().toLocaleTimeString()}] Starting scan (${SEARCH_QUERIES.length} queries)...`);
  const newLeads = [];

  for (const query of SEARCH_QUERIES) {
    const results = await searchSerper(query);
    for (const result of results) {
      const lead = extractLead(result);
      if (lead) newLeads.push(lead);
    }
    // Respect rate limits
    await new Promise(r => setTimeout(r, 300));
  }

  if (newLeads.length) {
    leadsData.leads = [...newLeads, ...leadsData.leads].slice(0, 200);
    saveData();
    io.emit('leadsUpdated', leadsData);
    await sendEmailAlert(newLeads);
    console.log(`Scan complete - ${newLeads.length} new leads found`);
  } else {
    console.log('Scan complete - no new leads this cycle');
  }

  return { totalNew: newLeads.length, leads: newLeads };
}

// ─── Auto-scan 2x daily (8am + 6pm) ─────────────────────────────────────────
cron.schedule('0 8,18 * * *', () => {
  console.log('Cron-triggered scan');
  runScan().catch(console.error);
});

// ─── Routes ──────────────────────────────────────────────────────────────────
app.get('/trigger-all', async (req, res) => {
  try {
    const result = await runScan();
    res.json({ success: true, message: `Scan complete - ${result.totalNew} new leads`, totalNew: result.totalNew });
  } catch (e) {
    console.error('Scan error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/leads', (req, res) => res.json(leadsData));

app.post('/api/add-lead', (req, res) => {
  const lead = {
    ...req.body,
    _key: `manual-${Date.now()}`,
    timestamp: new Date().toISOString(),
    agentKey: 'manual',
  };
  leadsData.manual.unshift(lead);
  saveData();
  io.emit('leadsUpdated', leadsData);
  res.json({ success: true });
});

app.delete('/api/leads', (req, res) => {
  leadsData = { leads: [], manual: [] };
  seenLeadKeys.clear();
  saveData();
  io.emit('leadsUpdated', leadsData);
  res.json({ success: true });
});

app.delete('/api/leads/:key', (req, res) => {
  const key = decodeURIComponent(req.params.key);
  for (const agentKey of Object.keys(leadsData)) {
    leadsData[agentKey] = leadsData[agentKey].filter(l => l._key !== key);
  }
  seenLeadKeys.delete(key);
  saveData();
  io.emit('leadsUpdated', leadsData);
  res.json({ success: true });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    serperConfigured: !!SERPER_API_KEY,
    resendConfigured: !!RESEND_API_KEY,
    leadsCount: leadsData.leads.length + leadsData.manual.length,
    seenKeys: seenLeadKeys.size,
    queryCount: SEARCH_QUERIES.length,
    time: new Date().toISOString(),
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  console.log(`  Serper: ${SERPER_API_KEY ? 'configured' : 'MISSING - set SERPER_API_KEY'}`);
  console.log(`  Resend: ${RESEND_API_KEY ? 'configured' : 'not set - emails disabled'}`);
  console.log(`  Queries: ${SEARCH_QUERIES.length} | Auto-scan: 8am + 6pm daily`);

  if (SERPER_API_KEY) {
    setTimeout(() => runScan().catch(console.error), 5000);
  }
});
