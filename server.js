const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const fs = require('fs');
const cron = require('node-cron');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const PORT           = process.env.PORT           || 3000;
const SERPER_API_KEY = process.env.SERPER_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALERT_EMAIL    = process.env.ALERT_EMAIL    || 'junkboysremoval394@gmail.com';
const DATA_FILE      = path.join(__dirname, 'leads.json');

// ─── Persistent store (two agents: "leads" + "watchdog" + manual entry) ──────
let leadsData = fs.existsSync(DATA_FILE)
  ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  : { leads: [], watchdog: [], manual: [] };

// Migrate old formats
if (leadsData.realEstate || leadsData.socialMedia) {
  leadsData = { leads: [], watchdog: [], manual: leadsData.manual || [] };
}
if (!leadsData.watchdog) leadsData.watchdog = [];

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
  'Lexington', 'Northern Kentucky',
];

// ─── Search queries — COMMUNITY PLATFORMS ONLY (no Google organic) ───────────
// Only Facebook groups, Craigslist, Reddit, Nextdoor — where REAL customers post.
// Zero Google organic results (those are always businesses).
const SEARCH_QUERIES = [

  // === FACEBOOK GROUPS — junk removal requests ===
  'site:facebook.com/groups "need junk removal" Cincinnati OR Dayton OR Ohio OR Kentucky',
  'site:facebook.com/groups "anyone recommend" junk removal Cincinnati OR Dayton',
  'site:facebook.com/groups "anyone know" junk removal Cincinnati OR Dayton OR "Northern Kentucky"',
  'site:facebook.com/groups "looking for junk removal" Cincinnati OR Dayton OR Covington OR Florence',
  'site:facebook.com/groups "need someone to haul" Cincinnati OR Dayton OR Ohio',
  'site:facebook.com/groups "need junk removed" Cincinnati OR Dayton OR "Northern Kentucky"',
  'site:facebook.com/groups "who does junk removal" Cincinnati OR Dayton',
  'site:facebook.com/groups "junk removal" "any recommendations" Cincinnati OR Dayton OR Ohio',

  // === FACEBOOK GROUPS — hauling / moving / U-Haul requests ===
  'site:facebook.com/groups "need help moving" Cincinnati OR Dayton OR "Northern Kentucky"',
  'site:facebook.com/groups "haul away" Cincinnati OR Dayton OR Covington "need" OR "looking"',
  'site:facebook.com/groups "moving out" "need help" Cincinnati OR Dayton OR Ohio',
  'site:facebook.com/groups "need a truck" OR "need a trailer" Cincinnati OR Dayton haul OR move',
  'site:facebook.com/groups "U-Haul" OR "Uhaul" Cincinnati OR Dayton "help" OR "need"',
  'site:facebook.com/groups "getting rid of" furniture OR junk OR stuff Cincinnati OR Dayton',
  'site:facebook.com/groups "clean out" "my garage" OR "my basement" OR "my attic" Cincinnati OR Dayton',

  // === FACEBOOK GROUPS — real estate / property cleanout requests ===
  'site:facebook.com/groups "tenant left" junk OR trash OR cleanout Cincinnati OR Dayton',
  'site:facebook.com/groups "estate cleanout" OR "estate clean out" Cincinnati OR Dayton',
  'site:facebook.com/groups "foreclosure" cleanout OR cleanup Cincinnati OR Dayton OR Ohio',
  'site:facebook.com/groups "landlord" "clean out" OR "junk removal" Cincinnati OR Dayton',
  'site:facebook.com/groups "selling my house" junk OR cleanout OR haul Cincinnati OR Dayton',

  // === CRAIGSLIST — wanted section / people requesting services ===
  'site:craigslist.org "need junk removal" Cincinnati OR Dayton OR Ohio',
  'site:craigslist.org "need junk removed" Cincinnati OR Dayton OR Kentucky',
  'site:craigslist.org "haul away" "need" OR "looking for" Cincinnati OR Dayton',
  'site:craigslist.org "clean out" "need" OR "help" Cincinnati OR Dayton',
  'site:craigslist.org "free" "come pick up" OR "must pick up" Cincinnati OR Dayton furniture OR junk',

  // === REDDIT — people asking for recommendations ===
  'site:reddit.com "junk removal" Cincinnati OR Dayton recommend OR recommendation OR suggestions',
  'site:reddit.com "haul away" OR "hauling" Cincinnati OR Dayton "need" OR "looking for" OR "help"',
  'site:reddit.com "moving" Cincinnati OR Dayton "junk" OR "get rid of" OR "cleanout"',

  // === NEXTDOOR — neighborhood requests ===
  'site:nextdoor.com "junk removal" Cincinnati OR Dayton recommend OR "need" OR "looking for"',
  'site:nextdoor.com "haul away" OR "hauling" Cincinnati OR Dayton',
  'site:nextdoor.com "clean out" OR "cleanout" Cincinnati OR Dayton "need" OR "help"',
];

// ─── NETWORK WATCHDOG — track realtors, property managers, estate pros, etc. ─
// These people are REFERRAL GOLDMINES — they regularly need junk removal.
const WATCHDOG_KEYWORDS = [
  'junk removal', 'junk haul', 'cleanout', 'estate cleanout', 'house cleanup',
  'debris removal', 'haul away', 'trash out', 'pre-listing clean', 'eviction cleanup',
  'tenant left', 'property cleanout', 'foreclosure cleanup', 'hoarder cleanout',
  'estate sale leftovers', 'move out cleanout', 'garage cleanout', 'basement cleanout',
  'appliance removal', 'furniture removal', 'construction debris',
];

const WATCHDOG_PROFILES = [
  // Types of professionals to track (search patterns, not specific usernames)
  'realtor', 'real estate agent', 'property manager', 'landlord',
  'estate sale', 'probate attorney', 'probate lawyer',
  'general contractor', 'home flipper', 'house flipper',
  'property management', 'rental property', 'apartment manager',
  'home inspector', 'closing agent', 'title company',
];

const WATCHDOG_QUERIES = [
  // === REALTORS needing cleanout before listing ===
  'site:facebook.com/groups realtor OR "real estate agent" "cleanout" OR "junk removal" OR "haul away" Cincinnati OR Dayton OR Ohio',
  'site:facebook.com/groups "pre-listing" OR "getting listed" cleanout OR "junk removal" Cincinnati OR Dayton',
  'site:facebook.com/groups realtor OR agent "need someone to clean out" OR "need junk removed" Cincinnati OR Dayton',
  'site:facebook.com/groups "listing this house" OR "listing this property" junk OR cleanout OR haul Cincinnati OR Dayton',

  // === PROPERTY MANAGERS / LANDLORDS with tenant turnovers ===
  'site:facebook.com/groups landlord OR "property manager" "tenant left" OR "moved out" OR "eviction" junk OR trash OR cleanout Cincinnati OR Dayton',
  'site:facebook.com/groups "rental property" OR "rental unit" cleanout OR "junk removal" OR "haul away" Cincinnati OR Dayton',
  'site:facebook.com/groups landlord "clean out" OR "trash out" OR "debris" Cincinnati OR Dayton OR "Northern Kentucky"',
  'site:facebook.com/groups "tenant trashed" OR "tenant destroyed" OR "tenant abandoned" Cincinnati OR Dayton',

  // === ESTATE SALES / PROBATE — leftovers after sale ===
  'site:facebook.com/groups "estate sale" "leftovers" OR "what\'s left" OR "haul away" OR "cleanout" Cincinnati OR Dayton',
  'site:facebook.com/groups "estate cleanout" OR "estate clean out" Cincinnati OR Dayton OR Ohio "need" OR "looking"',
  'site:facebook.com/groups "probate" OR "inherited house" cleanout OR junk OR "haul away" Cincinnati OR Dayton',
  'site:facebook.com/groups "deceased" OR "passed away" house OR property cleanout OR junk Cincinnati OR Dayton',

  // === HOME FLIPPERS needing demo/cleanout ===
  'site:facebook.com/groups "house flip" OR "home flip" OR "flipping" cleanout OR "junk removal" OR demolition Cincinnati OR Dayton',
  'site:facebook.com/groups "rehab property" OR "fixer upper" cleanout OR "haul away" OR debris Cincinnati OR Dayton',

  // === CRAIGSLIST — professional referral posts ===
  'site:craigslist.org realtor OR landlord OR "property manager" cleanout OR "junk removal" Cincinnati OR Dayton',
  'site:craigslist.org "estate sale" leftovers OR cleanout OR "haul away" Cincinnati OR Dayton',
  'site:craigslist.org "tenant left" OR "eviction" cleanout OR junk Cincinnati OR Dayton',

  // === REDDIT — professional referral posts ===
  'site:reddit.com realtor OR landlord OR "property manager" "junk removal" OR cleanout Cincinnati OR Dayton',
  'site:reddit.com "estate sale" OR "estate cleanout" Cincinnati OR Dayton "need" OR "recommend"',

  // === NEXTDOOR — professional referral posts ===
  'site:nextdoor.com realtor OR landlord "junk removal" OR cleanout OR "haul away" Cincinnati OR Dayton',
  'site:nextdoor.com "estate sale" OR "estate cleanout" OR "tenant left" Cincinnati OR Dayton',

  // === LINKEDIN — find realtors, property managers, estate pros directly ===
  'site:linkedin.com/in realtor OR "real estate agent" Cincinnati OR Dayton "cleanout" OR "junk removal"',
  'site:linkedin.com/in "property manager" Cincinnati OR Dayton OR Ohio',
  'site:linkedin.com/in "real estate agent" Cincinnati OR Dayton OR "Northern Kentucky"',
  'site:linkedin.com/in realtor Cincinnati OR Dayton "property" OR "listing" OR "homes"',
  'site:linkedin.com/in "estate sale" OR "estate liquidator" Cincinnati OR Dayton OR Ohio',
  'site:linkedin.com/in "property management" Cincinnati OR Dayton OR Ohio',
  'site:linkedin.com/in "probate attorney" OR "probate lawyer" Cincinnati OR Dayton',
  'site:linkedin.com/in "house flipper" OR "real estate investor" Cincinnati OR Dayton',
  'site:linkedin.com/posts realtor OR "real estate" cleanout OR "junk removal" OR "haul away" Cincinnati OR Dayton',
  'site:linkedin.com/posts "property manager" OR landlord cleanout OR junk Cincinnati OR Dayton',
];

// ─── WATCHDOG-specific customer signals (must be a NEED or a professional profile) ─
const WATCHDOG_CUSTOMER_SIGNALS = [
  'need', 'looking for', 'anyone', 'recommend', 'help', 'want', 'hire',
  'tenant left', 'tenant moved', 'eviction', 'foreclosure', 'estate',
  'cleanout', 'clean out', 'haul away', 'debris', 'junk',
  'pre-listing', 'getting listed', 'listing this', 'show ready',
  'leftovers', 'what\'s left', 'inherited', 'probate', 'deceased',
  'trashed', 'destroyed', 'abandoned', 'moved out', 'move out',
  'flip', 'rehab', 'fixer upper', 'renovation',
  // LinkedIn profile signals (the person IS the lead — they're a realtor/PM/etc.)
  'realtor', 'real estate agent', 'real estate', 'property manager',
  'property management', 'broker', 'listing agent', 'estate liquidat',
  'estate sale', 'probate attorney', 'probate lawyer',
  'house flipper', 'real estate investor', 'landlord',
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
  'a901 licensed', 'usdot',
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

  // Business names / branded posts (company advertising)
  'junkremoval.com', 'junk removal llc', 'hauling llc', 'removal llc',
  'your estate cleanout specialists', 'your junk removal', 'your hauling',
  'one call does it all', 'does it all', 'all your junk',
  'residential and commercial', 'commercial and residential',
  'apartments/condos', 'condos/townhomes',
  'hot tub removal', 'hot tubs', 'shed removals',
  'home services', 'home service', 'cleaning service', 'cleanup crew',
  'property services', 'property service',

  // Business advertising TO realtors/landlords (they ARE the business)
  'realtors & property', 'property owners —', 'need a reliable cleanup',
  'reliable cleanup crew', 'we help you get it', 'market-ready',
  'perfect for:', 'perfect for realtors', 'perfect for landlords',
  'message me for a quote', 'message us for a quote',
  'fast turnaround', 'dependable, and easy', 'easy to work with',
  'punch list', 'home repairs', 'exterior cleanup',
  'on q home', 'home services llc',

  // Phone number in title/ad = business promoting themselves
  'call shamrock', 'call junk', 'call 1-800', 'call 800',

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

  // Marketing / promotional language
  'specials are on', 'spring special', 'spring clean', 'time to clear the clutter',
  'reclaim your', 'start fresh', 'done right', 'we make cleanouts',
  'muscles. manners', 'professional service', 'real people who care',
  'show up on time', 'treat your home', 'clean slate',
  'not some big', 'not a franchise', 'we\'re local', 'we are local',
  'heavy lifting done', 'we do the heavy', 'we handle the heavy',
  'just call', 'just text', 'reach out to us', 'get in touch',
  'before and after', 'check out this', 'look at this job',
  'another satisfied', 'happy customer', 'great job today',
  'job we did', 'job we completed', 'finished this', 'completed this',
  'here\'s a job', 'today\'s job', 'today\'s haul', 'today\'s load',
  'we cleared', 'we hauled', 'we removed', 'we cleaned out',
  'booking now', 'spots available', 'slots available', 'openings available',
  'starting at $', 'prices start', 'as low as $',
  'mention this post', 'use code', 'discount', '% off',

  // Contractor "I'm available" posts
  'truck and trailer available', 'trailer available', 'truck available',
  'available all evening', 'available all day', 'available now',
  'available today', 'available this week', 'available tomorrow',
  'for hire', 'for any moving', 'for any hauling',
  'award winning', 'don\'t strike out',
  'free estimate', 'before & after', 'before &amp; after',
  'serving greater', 'serving the',
  'trailer for rent', 'trailer rental', 'utility trailer',
];

// ─── IRRELEVANT TOPIC filters — these have NOTHING to do with junk removal ──
const IRRELEVANT_SIGNALS = [
  // Legal / attorney posts
  'attorney', 'lawyer', 'lawsuit', 'lawsuit', 'legal advice', 'legal help',
  'wrongful eviction', 'tenant defense', 'tenant rights', 'compensatory damages',
  'self-help eviction', 'court case', 'court date', 'sue', 'suing',
  'harassment, intimidation', 'police-documented', 'restraining order',

  // Animal control / pets (not junk)
  'animal control', 'deceased animals', 'dead animal', 'bury him', 'bury her',
  'bury it', 'stray cat', 'stray dog', 'lost pet', 'found pet',

  // Political / news / off-topic
  'vote for', 'election', 'ballot', 'political', 'protest', 'rally',
  'breaking news', 'shooting', 'accident report', 'crime report',

  // Medical / health
  'disabled', 'bad back and knees', 'surgery', 'hospital', 'medical',

  // Job seeking (person looking for work, not a customer)
  'looking for work', 'looking for a job', 'hiring', 'now hiring',
  'job opening', 'help wanted', 'resume',
];

// ─── REGEX patterns for business detection (catches phone-in-title ads) ─────
const BUSINESS_REGEX_PATTERNS = [
  /call\s+\w+\s+\d{3}[-.]?\d{3}[-.]?\d{4}/i,        // "Call Shamrock 973-343-6017"
  /\d{3}[-.]?\d{3}[-.]?\d{4}.*(?:removal|hauling|junk|cleanout)/i, // phone followed by service word
  /(?:removal|hauling|junk|cleanout).*\d{3}[-.]?\d{3}[-.]?\d{4}/i, // service word followed by phone
  /\w+(?:junk|removal|hauling|haul)\w*\.com/i,        // "shamrockjunkremoval.com"
  /www\.\w+\.com/i,                                    // any www.xxx.com = business
  /(?:llc|inc|ltd|corp)(?:\s|$|\.)/i,                 // LLC, Inc, Ltd, Corp
  /(?:owned and operated|veteran[- ]owned)/i,          // "Veteran Owned and Operated"
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

// ─── ALLOWED PLATFORMS — only these domains can produce leads ────────────────
const ALLOWED_PLATFORMS = [
  'facebook.com', 'reddit.com', 'craigslist.org', 'nextdoor.com',
];

// Watchdog gets LinkedIn too (for finding realtors/professionals directly)
const WATCHDOG_ALLOWED_PLATFORMS = [
  'facebook.com', 'reddit.com', 'craigslist.org', 'nextdoor.com', 'linkedin.com',
];

// ─── Extract a lead from a search result ─────────────────────────────────────
function extractLead(result) {
  const text  = `${result.title || ''} ${result.content || ''}`.toLowerCase();
  const url   = result.url || '';
  const title = result.title || '';
  const snippet = result.content || '';

  // 0. HARD FILTER — result MUST be from an allowed community platform
  if (!ALLOWED_PLATFORMS.some(p => url.toLowerCase().includes(p))) return null;

  // 1. Block known business/directory domains
  if (BLOCKED_DOMAINS.some(d => url.toLowerCase().includes(d))) return null;

  // 2. Block if ANY business signal matches (aggressive — zero tolerance)
  if (BUSINESS_SIGNALS.some(sig => text.includes(sig))) return null;

  // 2b. Block if any regex business pattern matches (phone-in-title ads, .com domains)
  if (BUSINESS_REGEX_PATTERNS.some(rx => rx.test(text))) return null;

  // 2c. Block irrelevant topics (legal, animal control, politics, etc.)
  if (IRRELEVANT_SIGNALS.some(sig => text.includes(sig))) return null;

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

// ─── Extract a WATCHDOG lead (from professional network posts) ──────────────
function extractWatchdogLead(result) {
  const text  = `${result.title || ''} ${result.content || ''}`.toLowerCase();
  const url   = result.url || '';
  const title = result.title || '';
  const snippet = result.content || '';

  // 0. Must be from allowed platform (includes LinkedIn for watchdog)
  if (!WATCHDOG_ALLOWED_PLATFORMS.some(p => url.toLowerCase().includes(p))) return null;

  // 1. Block known business/directory domains
  if (BLOCKED_DOMAINS.some(d => url.toLowerCase().includes(d))) return null;

  // 2. Block business ads (same filter)
  if (BUSINESS_SIGNALS.some(sig => text.includes(sig))) return null;

  // 2b. Block regex business patterns
  if (BUSINESS_REGEX_PATTERNS.some(rx => rx.test(text))) return null;

  // 2c. Block irrelevant topics
  if (IRRELEVANT_SIGNALS.some(sig => text.includes(sig))) return null;

  // 3. Must contain at least one watchdog customer signal
  if (!WATCHDOG_CUSTOMER_SIGNALS.some(sig => text.includes(sig))) return null;

  // 4. Deduplicate
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
  if (url.includes('facebook'))       platform = 'Facebook';
  else if (url.includes('reddit'))    platform = 'Reddit';
  else if (url.includes('craigslist')) platform = 'Craigslist';
  else if (url.includes('nextdoor'))  platform = 'Nextdoor';
  else if (url.includes('linkedin'))  platform = 'LinkedIn';

  // Detect the professional type
  let professionalType = 'Professional';
  if (text.includes('realtor') || text.includes('real estate agent') || text.includes('real estate') || text.includes('listing agent') || text.includes('broker'))
    professionalType = 'Realtor/Agent';
  else if (text.includes('landlord') || text.includes('property manager') || text.includes('property management') || text.includes('tenant'))
    professionalType = 'Landlord/PM';
  else if (text.includes('estate sale') || text.includes('estate liquidat') || text.includes('probate') || text.includes('deceased') || text.includes('inherited'))
    professionalType = 'Estate/Probate';
  else if (text.includes('flip') || text.includes('rehab') || text.includes('fixer') || text.includes('investor'))
    professionalType = 'House Flipper';

  // For LinkedIn profiles, try to extract the person's name from the title
  let displayName = professionalType;
  if (url.includes('linkedin.com/in/')) {
    // LinkedIn titles are usually "FirstName LastName - Title | LinkedIn"
    const nameMatch = title.match(/^([^-|]+)/);
    if (nameMatch) displayName = nameMatch[1].trim();
  }

  return {
    _key:            key,
    name:            displayName,
    description:     snippet.substring(0, 200),
    address:         location,
    phone:           phone || '',
    email:           email || '',
    source:          url,
    platform,
    hot:             !!(phone || email),
    title,
    timestamp:       new Date().toISOString(),
    agentKey:        'watchdog',
    professionalType,
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

// ─── Classify lead temperature based on age ────────────────────────────────
function classifyLeadTemp(lead) {
  const ageMs = Date.now() - new Date(lead.timestamp).getTime();
  const sixHours = 6 * 60 * 60 * 1000;
  return ageMs <= sixHours ? 'hot' : 'cold';
}

// ─── Core Lead Scanner scan ─────────────────────────────────────────────────
async function runScan() {
  console.log(`[${new Date().toLocaleTimeString()}] Starting Lead Scanner (${SEARCH_QUERIES.length} queries)...`);
  const newLeads = [];

  for (const query of SEARCH_QUERIES) {
    const results = await searchSerper(query);
    for (const result of results) {
      const lead = extractLead(result);
      if (lead) {
        lead.temperature = 'hot'; // just found = hot
        newLeads.push(lead);
      }
    }
    await new Promise(r => setTimeout(r, 300));
  }

  if (newLeads.length) {
    leadsData.leads = [...newLeads, ...leadsData.leads].slice(0, 200);
    saveData();
    io.emit('leadsUpdated', leadsData);
    await sendEmailAlert(newLeads);
    console.log(`Lead Scanner complete - ${newLeads.length} new leads found`);
  } else {
    console.log('Lead Scanner complete - no new leads this cycle');
  }

  return { totalNew: newLeads.length, leads: newLeads };
}

// ─── Network Watchdog scan ──────────────────────────────────────────────────
async function runWatchdogScan() {
  console.log(`[${new Date().toLocaleTimeString()}] Starting Network Watchdog (${WATCHDOG_QUERIES.length} queries)...`);
  const newLeads = [];

  for (const query of WATCHDOG_QUERIES) {
    const results = await searchSerper(query);
    for (const result of results) {
      const lead = extractWatchdogLead(result);
      if (lead) {
        lead.temperature = 'hot'; // just found = hot
        newLeads.push(lead);
      }
    }
    await new Promise(r => setTimeout(r, 300));
  }

  if (newLeads.length) {
    leadsData.watchdog = [...newLeads, ...leadsData.watchdog].slice(0, 200);
    saveData();
    io.emit('leadsUpdated', leadsData);
    await sendEmailAlert(newLeads);
    console.log(`Network Watchdog complete - ${newLeads.length} new leads found`);
  } else {
    console.log('Network Watchdog complete - no new leads this cycle');
  }

  return { totalNew: newLeads.length, leads: newLeads };
}

// ─── Reclassify old leads as cold (runs every hour) ─────────────────────────
function reclassifyTemperatures() {
  const sixHours = 6 * 60 * 60 * 1000;
  for (const key of ['leads', 'watchdog']) {
    for (const lead of leadsData[key]) {
      const age = Date.now() - new Date(lead.timestamp).getTime();
      lead.temperature = age <= sixHours ? 'hot' : 'cold';
    }
  }
  saveData();
  io.emit('leadsUpdated', leadsData);
}

// ─── Auto-scan every 30 min (6am–11pm) — catch leads FAST ──────────────────
// Lead Scanner runs at :00, Watchdog runs at :15 (staggered to spread API usage)
cron.schedule('0,30 6-23 * * *', () => {
  console.log('Cron: Lead Scanner triggered');
  runScan().catch(console.error);
});
cron.schedule('15,45 6-23 * * *', () => {
  console.log('Cron: Network Watchdog triggered');
  runWatchdogScan().catch(console.error);
});

// Reclassify temperatures every hour
cron.schedule('0 * * * *', () => reclassifyTemperatures());

// ─── Routes ──────────────────────────────────────────────────────────────────
app.get('/trigger-all', async (req, res) => {
  try {
    const result = await runScan();
    res.json({ success: true, message: `Lead Scanner - ${result.totalNew} new leads`, totalNew: result.totalNew });
  } catch (e) {
    console.error('Lead scan error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/trigger-watchdog', async (req, res) => {
  try {
    const result = await runWatchdogScan();
    res.json({ success: true, message: `Network Watchdog - ${result.totalNew} new leads`, totalNew: result.totalNew });
  } catch (e) {
    console.error('Watchdog scan error:', e);
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
  leadsData = { leads: [], watchdog: [], manual: [] };
  seenLeadKeys.clear();
  saveData();
  io.emit('leadsUpdated', leadsData);
  res.json({ success: true });
});

// Mark a lead as "taken" (grabbed by competitor)
app.post('/api/leads/:key/taken', (req, res) => {
  const key = decodeURIComponent(req.params.key);
  for (const agentKey of Object.keys(leadsData)) {
    for (const lead of leadsData[agentKey]) {
      if (lead._key === key) {
        lead.taken = true;
        lead.takenAt = new Date().toISOString();
      }
    }
  }
  saveData();
  io.emit('leadsUpdated', leadsData);
  res.json({ success: true });
});

// Unmark a lead as taken
app.post('/api/leads/:key/untaken', (req, res) => {
  const key = decodeURIComponent(req.params.key);
  for (const agentKey of Object.keys(leadsData)) {
    for (const lead of leadsData[agentKey]) {
      if (lead._key === key) {
        lead.taken = false;
        lead.takenAt = null;
      }
    }
  }
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
    leadsCount: leadsData.leads.length + leadsData.watchdog.length + leadsData.manual.length,
    watchdogCount: leadsData.watchdog.length,
    seenKeys: seenLeadKeys.size,
    queryCount: SEARCH_QUERIES.length + WATCHDOG_QUERIES.length,
    time: new Date().toISOString(),
  });
});

// ─── Serve dashboard for any unmatched GET ───────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Start ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  console.log(`  Serper: ${SERPER_API_KEY ? 'configured' : 'MISSING - set SERPER_API_KEY'}`);
  console.log(`  Resend: ${RESEND_API_KEY ? 'configured' : 'not set - emails disabled'}`);
  console.log(`  Lead queries: ${SEARCH_QUERIES.length} | Watchdog queries: ${WATCHDOG_QUERIES.length}`);
  console.log(`  Auto-scan: every 30 min (6am-11pm) — Lead Scanner at :00/:30, Watchdog at :15/:45`);

  if (SERPER_API_KEY) {
    setTimeout(() => runScan().catch(console.error), 5000);
    setTimeout(() => runWatchdogScan().catch(console.error), 65000); // stagger
  }
});
