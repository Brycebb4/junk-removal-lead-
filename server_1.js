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

const PORT            = process.env.PORT            || 3000;
const TAVILY_API_KEY  = process.env.TAVILY_API_KEY;
const RESEND_API_KEY  = process.env.RESEND_API_KEY;
const ALERT_EMAIL     = process.env.ALERT_EMAIL     || 'junkremovalguys394@gmail.com';
const DATA_FILE       = './leads.json';

// ─── Persistent store ────────────────────────────────────────────────────────
let leadsData = fs.existsSync(DATA_FILE)
  ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  : { realEstate: [], socialMedia: [], marketplace: [], eventSeason: [], craigslist: [], manual: [] };

// Track seen URLs/titles so we never show duplicate leads
let seenLeadKeys = new Set(
  Object.values(leadsData).flat().map(l => l._key).filter(Boolean)
);

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(leadsData, null, 2));
}

// ─── Search queries (Cincinnati / Dayton / NKY / Southern Indiana) ───────────
//   Each query is paired with the agent key it belongs to.
//   We use VERY specific language people actually type when they need junk removed.
const SEARCH_QUERIES = {
  craigslist: [
    'site:craigslist.org "junk removal" Cincinnati',
    'site:craigslist.org "haul away" Cincinnati',
    'site:craigslist.org "cleanout" Cincinnati OR Dayton OR "Northern Kentucky"',
    'site:craigslist.org "junk removal" Dayton Ohio',
    'site:craigslist.org "free furniture" Cincinnati pickup',
    'site:craigslist.org "need junk removed" Ohio',
  ],
  socialMedia: [
    '"junk removal" Cincinnati 2026',
    '"haul away" Cincinnati Facebook OR Nextdoor 2026',
    '"need someone to remove" Cincinnati junk OR furniture OR appliances',
    '"anyone know junk removal" Cincinnati OR Dayton',
    '"looking for junk removal" Cincinnati Northern Kentucky',
    'Nextdoor "junk removal" Cincinnati recommendation',
    '"cleanout" Cincinnati moving help 2026',
    '"garage cleanout" Cincinnati 2026',
    '"need junk hauled" Cincinnati Dayton',
    '"junk removal" Florence KY OR Erlanger OR Covington 2026',
  ],
  realEstate: [
    '"estate cleanout" Cincinnati OR Dayton 2026',
    '"foreclosure cleanout" Cincinnati Ohio 2026',
    '"hoarder cleanout" Cincinnati OR Dayton',
    '"property cleanout" Cincinnati real estate 2026',
    '"eviction cleanout" Cincinnati Ohio',
    '"rental cleanout" Cincinnati OR Northern Kentucky 2026',
    '"estate sale" Cincinnati "junk removal" 2026',
    '"moving out" Cincinnati "haul away" 2026',
  ],
  marketplace: [
    'Facebook Marketplace "junk removal" Cincinnati 2026',
    'OfferUp "junk removal" Cincinnati OR Dayton 2026',
    '"free pickup" Cincinnati furniture appliance junk 2026',
    '"someone to haul" Cincinnati 2026',
    'Reddit "junk removal" Cincinnati recommendation 2026',
    'site:reddit.com "junk removal" Cincinnati OR Dayton',
  ],
  eventSeason: [
    '"spring cleanout" Cincinnati 2026',
    '"moving" Cincinnati "junk removal" 2026',
    '"clearing out" Cincinnati basement OR attic OR garage 2026',
    '"storm debris" Cincinnati OR Dayton 2026',
    '"renovation" Cincinnati "haul away" debris 2026',
    '"home renovation" Cincinnati junk debris removal 2026',
  ],
};

// ─── Call Tavily with freshness filter ───────────────────────────────────────
async function searchTavily(query) {
  if (!TAVILY_API_KEY) {
    console.warn('⚠️  TAVILY_API_KEY not set – skipping search');
    return [];
  }

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key:        TAVILY_API_KEY,
        query,
        search_depth:  'advanced',
        max_results:    8,
        include_answer: false,
        // Only pull results from the last 3 days — this is the KEY fix for stale leads
        days:           3,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`Tavily error for "${query}":`, err);
      return [];
    }

    const data = await response.json();
    return data.results || [];
  } catch (e) {
    console.error('Tavily fetch error:', e.message);
    return [];
  }
}

// ─── Extract a structured lead from a Tavily result ──────────────────────────
function extractLeadFromResult(result, agentKey) {
  const text    = `${result.title || ''} ${result.content || ''}`;
  const url     = result.url || '';
  const title   = result.title || '';
  const snippet = result.content || '';

  // Skip if the result looks like a service provider's own website (ads/SEO spam)
  const spamDomains = ['yelp.com', 'angi.com', 'thumbtack.com', 'homeadvisor.com',
    'angieslist.com', 'houzz.com', 'porch.com', '1800gotjunk.com', 'junk-king.com',
    'collegehunks.com', 'loadup.com'];
  if (spamDomains.some(d => url.includes(d))) return null;

  // Must contain junk-need keywords to be relevant
  const needKeywords = [
    'need', 'looking for', 'anyone', 'recommend', 'help', 'want', 'hire',
    'haul away', 'pick up', 'remove', 'cleanout', 'clean out', 'dispose',
    'get rid', 'junk', 'clutter', 'debris', 'furniture', 'appliance',
  ];
  const hasNeedKeyword = needKeywords.some(k => text.toLowerCase().includes(k));
  if (!hasNeedKeyword) return null;

  // Deduplicate
  const key = url || title.substring(0, 60);
  if (seenLeadKeys.has(key)) return null;
  seenLeadKeys.add(key);

  // Extract phone
  const phoneMatch = text.match(/(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/);
  const phone      = phoneMatch ? phoneMatch[1] : null;

  // Extract email
  const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  const email      = emailMatch ? emailMatch[0] : null;

  // Extract location
  const location = extractLocation(text) || 'Cincinnati Area';

  // Determine platform label
  let platform = 'Web';
  if (url.includes('craigslist')) platform = 'Craigslist';
  else if (url.includes('reddit'))    platform = 'Reddit';
  else if (url.includes('facebook'))  platform = 'Facebook';
  else if (url.includes('nextdoor'))  platform = 'Nextdoor';
  else if (url.includes('offerup'))   platform = 'OfferUp';

  const isHot = !!(phone || email);

  return {
    _key:        key,
    name:        'Homeowner',
    description: snippet.substring(0, 200),
    address:     location,
    phone:       phone || '',
    email:       email || '',
    source:      url,
    platform,
    hot:         isHot,
    title,
    timestamp:   new Date().toISOString(),
    agentKey,
  };
}

// ─── Extract location from text ──────────────────────────────────────────────
function extractLocation(text) {
  const locations = [
    'Cincinnati', 'Dayton', 'Northern Kentucky', 'Florence', 'Erlanger',
    'Covington', 'Newport', 'Hebron', 'Lawrenceburg', 'Greendale',
    'Petersburg', 'Independence', 'Cold Spring', 'Fort Thomas', 'Southgate',
    'Alexandria', 'Melbourne', 'Wilder', 'Silver Grove', 'Addyston',
    'Shawnee', 'Idlewild', 'Bullittsville', 'West Chester', 'Mason',
    'Fairfield', 'Norwood', 'Blue Ash', 'Milford', 'Anderson Township',
    'Loveland', 'Maineville', 'Hamilton', 'Middletown', 'Springboro',
    'Kettering', 'Miamisburg', 'Centerville', 'Huber Heights', 'Xenia',
  ];
  for (const loc of locations) {
    if (text.toLowerCase().includes(loc.toLowerCase())) return loc;
  }
  // Ohio / Kentucky / Indiana zip codes
  const zipMatch = text.match(/\b(4[0-5]\d{3}|4[7-9]\d{3})\b/);
  if (zipMatch) return `ZIP ${zipMatch[0]}`;
  return null;
}

// ─── Send Resend email alert ──────────────────────────────────────────────────
async function sendEmailAlert(newLeads) {
  if (!RESEND_API_KEY || !newLeads.length) return;

  const leadRows = newLeads
    .map((l, i) => `
      <div style="border-left:4px solid #28a745;padding:12px 16px;margin:12px 0;background:#f8f9fa;border-radius:4px;">
        <strong>${i + 1}. ${l.title || l.description?.substring(0, 80)}</strong><br/>
        📍 ${l.address} &nbsp;|&nbsp; 📱 ${l.platform}<br/>
        ${l.phone ? `📞 <a href="tel:${l.phone}">${l.phone}</a><br/>` : ''}
        ${l.email ? `✉️ <a href="mailto:${l.email}">${l.email}</a><br/>` : ''}
        ${l.source ? `<a href="${l.source}" style="color:#e74c3c;">View Original Post →</a>` : ''}
      </div>`)
    .join('');

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#28a745;">🚛 ${newLeads.length} New Junk Removal Lead${newLeads.length > 1 ? 's' : ''} Found!</h2>
      <hr style="border-color:#28a745;"/>
      <p>Your automated scanner just found new potential customers:</p>
      ${leadRows}
      <a href="https://ohio-junk-scan.lovable.app" 
         style="display:inline-block;margin-top:16px;padding:12px 24px;background:#28a745;color:white;border-radius:8px;text-decoration:none;font-weight:700;">
        View Dashboard
      </a>
      <p style="color:#999;font-size:0.8em;margin-top:24px;">Automated scan by Junk Removal Boys Lead Scanner</p>
    </div>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    'Lead Scanner <onboarding@resend.dev>',
        to:      [ALERT_EMAIL],
        subject: `🚛 ${newLeads.length} New Junk Removal Lead${newLeads.length > 1 ? 's' : ''} Found!`,
        html,
      }),
    });
    if (res.ok) console.log(`📧 Email alert sent for ${newLeads.length} leads`);
    else        console.error('Resend error:', await res.text());
  } catch (e) {
    console.error('Email send failed:', e.message);
  }
}

// ─── Core scan function ───────────────────────────────────────────────────────
async function runScan() {
  console.log(`🔍 [${new Date().toLocaleTimeString()}] Starting scan…`);
  let totalNew = 0;
  const allNewLeads = [];

  for (const [agentKey, queries] of Object.entries(SEARCH_QUERIES)) {
    const newForAgent = [];

    for (const query of queries) {
      const results = await searchTavily(query);

      for (const result of results) {
        const lead = extractLeadFromResult(result, agentKey);
        if (lead) {
          newForAgent.push(lead);
          allNewLeads.push(lead);
        }
      }

      // Respect Tavily rate limits (5 req/sec on free tier)
      await new Promise(r => setTimeout(r, 250));
    }

    if (newForAgent.length) {
      // Prepend newest leads, keep last 50 per agent
      leadsData[agentKey] = [...newForAgent, ...leadsData[agentKey]].slice(0, 50);
      totalNew += newForAgent.length;
      console.log(`  ✅ ${agentKey}: +${newForAgent.length} leads`);
    }
  }

  if (totalNew > 0) {
    saveData();
    io.emit('leadsUpdated', leadsData);
    await sendEmailAlert(allNewLeads);
    console.log(`✅ Scan complete — ${totalNew} new leads found & emailed`);
  } else {
    console.log('ℹ️  Scan complete — no new leads this cycle');
  }

  return { totalNew, leads: allNewLeads };
}

// ─── Auto-scan every 3 hours ──────────────────────────────────────────────────
// Runs at: 6am, 9am, 12pm, 3pm, 6pm, 9pm daily
cron.schedule('0 6,9,12,15,18,21 * * *', () => {
  console.log('⏰ Cron-triggered scan');
  runScan().catch(console.error);
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/trigger-all', async (req, res) => {
  try {
    const result = await runScan();
    res.json({ success: true, message: `Scan complete — ${result.totalNew} new leads`, totalNew: result.totalNew });
  } catch (e) {
    console.error('Scan error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/leads', (req, res) => res.json(leadsData));

app.post('/api/add-lead', (req, res) => {
  const lead = {
    ...req.body,
    _key:      `manual-${Date.now()}`,
    timestamp: new Date().toISOString(),
    agentKey:  'manual',
  };
  leadsData.manual.unshift(lead);
  saveData();
  io.emit('leadsUpdated', leadsData);
  res.json({ success: true });
});

app.delete('/api/leads', (req, res) => {
  leadsData = { realEstate: [], socialMedia: [], marketplace: [], eventSeason: [], craigslist: [], manual: [] };
  seenLeadKeys.clear();
  saveData();
  io.emit('leadsUpdated', leadsData);
  res.json({ success: true });
});

// Delete a single lead by key
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
    status:           'ok',
    tavilyConfigured: !!TAVILY_API_KEY,
    resendConfigured: !!RESEND_API_KEY,
    leadsCount:       Object.values(leadsData).reduce((a, arr) => a + arr.length, 0),
    seenKeys:         seenLeadKeys.size,
    time:             new Date().toISOString(),
  });
});

// Manual test email route
app.post('/api/test-email', async (req, res) => {
  const testLead = {
    title:       'TEST: Someone needs junk removed in Cincinnati',
    description: 'This is a test lead to verify email delivery.',
    address:     'Cincinnati, OH',
    phone:       '513-555-0000',
    email:       '',
    source:      'https://ohio-junk-scan.lovable.app',
    platform:    'Test',
  };
  await sendEmailAlert([testLead]);
  res.json({ success: true, message: 'Test email sent' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  console.log(`   Tavily: ${TAVILY_API_KEY ? '✅ configured' : '❌ MISSING – set TAVILY_API_KEY'}`);
  console.log(`   Resend: ${RESEND_API_KEY ? '✅ configured' : '⚠️  not set – emails disabled'}`);
  console.log(`   Auto-scan: every 3 hrs (6am, 9am, 12pm, 3pm, 6pm, 9pm)`);

  // Run one scan on startup so you get leads immediately
  if (TAVILY_API_KEY) {
    setTimeout(() => runScan().catch(console.error), 5000);
  }
});
