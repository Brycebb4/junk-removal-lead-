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
const SERPER_API_KEY  = process.env.SERPER_API_KEY;
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
    '"junk removal" Cincinnati',
    '"haul away" Cincinnati Facebook OR Nextdoor',
    '"need someone to remove" Cincinnati junk OR furniture OR appliances',
    '"anyone know junk removal" Cincinnati OR Dayton',
    '"looking for junk removal" Cincinnati Northern Kentucky',
    'Nextdoor "junk removal" Cincinnati recommendation',
    '"cleanout" Cincinnati moving help',
    '"garage cleanout" Cincinnati',
    '"need junk hauled" Cincinnati Dayton',
    '"junk removal" Florence KY OR Erlanger OR Covington',
  ],
  realEstate: [
    '"realtor" Cincinnati "need junk removed" OR "cleanout"',
    '"real estate agent" Cincinnati "haul away" OR "junk removal"',
    '"listing prep" Cincinnati "junk removal" OR "cleanout"',
    '"property manager" Cincinnati "need someone" cleanout OR junk',
    '"landlord" Cincinnati tenant "moved out" cleanout junk',
    '"selling my house" Cincinnati "junk removal" help',
    '"getting ready to sell" Cincinnati cleanout haul',
    '"preparing to list" Cincinnati junk cleanout haul',
  ],
  marketplace: [
    'Facebook Marketplace "junk removal" Cincinnati',
    'OfferUp "junk removal" Cincinnati OR Dayton',
    '"free pickup" Cincinnati furniture appliance junk',
    '"someone to haul" Cincinnati',
    'Reddit "junk removal" Cincinnati recommendation',
    'site:reddit.com "junk removal" Cincinnati OR Dayton',
  ],
  eventSeason: [
    '"spring cleanout" Cincinnati',
    '"moving" Cincinnati "junk removal"',
    '"clearing out" Cincinnati basement OR attic OR garage',
    '"storm debris" Cincinnati OR Dayton',
    '"renovation" Cincinnati "haul away" debris',
    '"home renovation" Cincinnati junk debris removal',
  ],
  manual: [
    '"need help moving" Cincinnati OR Dayton OR "Northern Kentucky"',
    '"moving out of my apartment" Cincinnati "need help"',
    '"anyone help me move" Cincinnati furniture haul',
    '"moving out" Cincinnati "looking for help" furniture',
    '"need someone to haul" Cincinnati apartment moving',
    '"college" Cincinnati OR Dayton "moving out" "need help"',
    '"single" Cincinnati apartment "need help" moving OR hauling',
    '"does anyone know" Cincinnati moving help haul furniture',
  ],
};

// ─── Call Serper.dev Google Search API ────────────────────────────────────────
async function searchSerper(query) {
  if (!SERPER_API_KEY) {
    console.warn('⚠️  SERPER_API_KEY not set – skipping search');
    return [];
  }

  try {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: query,
        num: 8,
        tbs: 'qdr:w',  // Limit to past week for freshness
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`Serper error for "${query}":`, err);
      return [];
    }

    const data = await response.json();
    // Normalize Serper results to match our expected format { title, url, content }
    const organic = data.organic || [];
    return organic.map(r => ({
      title:   r.title || '',
      url:     r.link  || '',
      content: r.snippet || '',
    }));
  } catch (e) {
    console.error('Serper fetch error:', e.message);
    return [];
  }
}

// ─── Extract a structured lead from a Tavily result ──────────────────────────
function extractLeadFromResult(result, agentKey) {
  const text    = `${result.title || ''} ${result.content || ''}`;
  const url     = result.url || '';
  const title   = result.title || '';
  const snippet = result.content || '';

  // Skip known service/business websites
  const spamDomains = [
    'yelp.com', 'angi.com', 'thumbtack.com', 'homeadvisor.com',
    'angieslist.com', 'houzz.com', 'porch.com', '1800gotjunk.com', 'junk-king.com',
    'collegehunks.com', 'loadup.com', 'junkluggers.com', 'junkremoval.com',
    'gotjunk.com', 'bagster.com', 'dumpsters.com', 'wastepro.com',
    'rumpke.com', 'republic-services.com', 'wm.com', 'cms-junk.com',
    'goodfellasjunk.com', 'holtshauling.com', 'tristatejunk.com',
  ];
  if (spamDomains.some(d => url.includes(d))) return null;

  // Filter out results that are clearly from junk removal businesses promoting themselves
  const businessSignals = [
    'our team', 'we offer', 'we provide', 'our services', 'our company',
    'licensed and insured', 'fully licensed', 'fully insured',
    'family owned', 'locally owned', 'family-owned', 'locally-owned',
    'serving the greater', 'serving cincinnati', 'serving dayton',
    'free estimates', 'get a free estimate', 'book online', 'schedule a pickup',
    'schedule online', 'pay my bill', 'we specialize in', 'our crew',
    'our professionals', 'contact us today', 'call us today',
    'junk removal company', 'hauling company', 'removal service',
    'visit our website', 'check out our', 'follow us on',
  ];
  const businessHits = businessSignals.filter(k => text.toLowerCase().includes(k)).length;
  if (businessHits >= 2) return null;

  // Must contain customer-need keywords to be relevant
  const needKeywords = [
    'need', 'looking for', 'anyone', 'recommend', 'help', 'want', 'hire',
    'haul away', 'pick up', 'remove', 'cleanout', 'clean out', 'dispose',
    'get rid', 'junk', 'clutter', 'debris', 'furniture', 'appliance',
    'moving', 'clearing out', 'too much stuff', 'overwhelmed',
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
      const results = await searchSerper(query);

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

// ─── Auto-scan 2x daily to stay within Serper free tier ─────────────────────
// Runs at: 8am and 6pm daily (~96 queries/day = ~2,880/month)
cron.schedule('0 8,18 * * *', () => {
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

// ─── Diagnostic endpoint — shows raw Tavily results vs filtered ──────────────
app.get('/api/debug-scan', async (req, res) => {
  const testQuery = '"junk removal" Cincinnati';

  // Direct API call to see the FULL response including errors
  let rawApiResponse = null;
  let rawApiError = null;
  try {
    const directRes = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: testQuery,
        num: 5,
        tbs: 'qdr:w',
      }),
    });
    rawApiResponse = {
      status: directRes.status,
      statusText: directRes.statusText,
      body: await directRes.json().catch(() => directRes.text()),
    };
  } catch (e) {
    rawApiError = e.message;
  }

  const rawResults = (rawApiResponse?.body?.organic || []).map(r => ({
    title: r.title || '', url: r.link || '', content: r.snippet || '',
  }));
  const filtered = rawResults.map(r => {
    const text = `${r.title || ''} ${r.content || ''}`;
    const url = r.url || '';

    // Check spam domains
    const spamDomains = [
      'yelp.com', 'angi.com', 'thumbtack.com', 'homeadvisor.com',
      'angieslist.com', 'houzz.com', 'porch.com', '1800gotjunk.com', 'junk-king.com',
      'collegehunks.com', 'loadup.com', 'junkluggers.com', 'junkremoval.com',
      'gotjunk.com', 'bagster.com', 'dumpsters.com', 'wastepro.com',
      'rumpke.com', 'republic-services.com', 'wm.com', 'cms-junk.com',
      'goodfellasjunk.com', 'holtshauling.com', 'tristatejunk.com',
    ];
    const blockedByDomain = spamDomains.some(d => url.includes(d));

    // Check business signals
    const businessSignals = [
      'our team', 'we offer', 'we provide', 'our services', 'our company',
      'licensed and insured', 'fully licensed', 'fully insured',
      'family owned', 'locally owned', 'family-owned', 'locally-owned',
      'serving the greater', 'serving cincinnati', 'serving dayton',
      'free estimates', 'get a free estimate', 'book online', 'schedule a pickup',
      'schedule online', 'pay my bill', 'we specialize in', 'our crew',
      'our professionals', 'contact us today', 'call us today',
      'junk removal company', 'hauling company', 'removal service',
      'visit our website', 'check out our', 'follow us on',
    ];
    const businessHits = businessSignals.filter(k => text.toLowerCase().includes(k));

    // Check need keywords
    const needKeywords = [
      'need', 'looking for', 'anyone', 'recommend', 'help', 'want', 'hire',
      'haul away', 'pick up', 'remove', 'cleanout', 'clean out', 'dispose',
      'get rid', 'junk', 'clutter', 'debris', 'furniture', 'appliance',
      'moving', 'clearing out', 'too much stuff', 'overwhelmed',
    ];
    const matchedNeeds = needKeywords.filter(k => text.toLowerCase().includes(k));

    return {
      title: r.title,
      url: r.url,
      snippet: (r.content || '').substring(0, 150),
      blockedByDomain,
      businessHits: businessHits,
      businessBlocked: businessHits.length >= 2,
      matchedNeeds,
      passesNeedFilter: matchedNeeds.length > 0,
      wouldBeKept: !blockedByDomain && businessHits.length < 2 && matchedNeeds.length > 0,
    };
  });

  res.json({
    query: testQuery,
    serperConfigured: !!SERPER_API_KEY,
    serperKeyPrefix: SERPER_API_KEY ? SERPER_API_KEY.substring(0, 12) + '...' : 'NOT SET',
    rawApiResponse,
    rawApiError,
    rawResultCount: rawResults.length,
    rawResults: rawResults.map(r => ({ title: r.title, url: r.url, snippet: (r.content || '').substring(0, 150) })),
    filterAnalysis: filtered,
    keptCount: filtered.filter(f => f.wouldBeKept).length,
  });
});

app.get('/health', (req, res) => {
  res.json({
    status:           'ok',
    serperConfigured: !!SERPER_API_KEY,
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
  console.log(`   Serper: ${SERPER_API_KEY ? '✅ configured' : '❌ MISSING – set SERPER_API_KEY'}`);
  console.log(`   Resend: ${RESEND_API_KEY ? '✅ configured' : '⚠️  not set – emails disabled'}`);
  console.log(`   Auto-scan: 8am and 6pm daily`);

  // Run one scan on startup so you get leads immediately
  if (SERPER_API_KEY) {
    setTimeout(() => runScan().catch(console.error), 5000);
  }
});
