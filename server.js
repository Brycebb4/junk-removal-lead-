const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.')); // Serve static files

const PORT = process.env.PORT || 3000;

// Get API keys from environment variables (set in Render)
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

// Store leads in memory (use database for production)
let leadsData = {
  realEstate: [],
  socialMedia: [],
  marketplace: [],
  eventSeason: [],
  craigslist: [],
  manual: []
};

// Search queries for each agent
const SEARCH_QUERIES = {
  realEstate: [
    'junk removal Cincinnati estate cleanout',
    'property cleanout Northern Kentucky',
    'foreclosure cleanout Dayton'
  ],
  socialMedia: [
    'need junk removal Cincinnati Facebook',
    'looking for junk haulers Northern Kentucky',
    'trash removal help Dayton'
  ],
  marketplace: [
    'junk removal Cincinnati Craigslist',
    'hauling services Northern Kentucky marketplace',
    'cleanout services Dayton OfferUp'
  ],
  eventSeason: [
    'spring cleaning junk removal Cincinnati',
    'moving cleanout Northern Kentucky',
    'estate sale cleanup Dayton'
  ],
  craigslist: [
    'junk removal wanted Cincinnati site:craigslist.org',
    'cleanout needed Northern Kentucky site:craigslist.org',
    'hauling services Dayton site:craigslist.org'
  ]
};

// Function to search with Tavily
async function searchTavily(query) {
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: query,
        search_depth: 'basic',
        include_answer: false,
        include_images: false,
        include_raw_content: false,
        max_results: 5
      })
    });

    if (!response.ok) {
      console.error(`Tavily API error: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json();
    return data.results || [];
  } catch (error) {
    console.error('Error calling Tavily API:', error);
    return null;
  }
}

// Function to extract lead information from search results
function extractLeadFromResult(result, agentKey) {
  // Extract potential contact info and details
  const content = `${result.title} ${result.content}`.toLowerCase();
  
  // Try to find phone numbers (basic pattern)
  const phoneMatch = content.match(/(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/);
  const emailMatch = content.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/);
  
  // Check if it's actually a relevant junk removal lead
  const relevantKeywords = ['junk', 'removal', 'cleanout', 'haul', 'trash', 'debris', 'furniture', 'appliance', 'moving', 'estate'];
  const isRelevant = relevantKeywords.some(keyword => content.includes(keyword));
  
  if (!isRelevant) {
    return null;
  }

  return {
    name: result.title || 'Potential Lead',
    description: result.content.substring(0, 200) + '...',
    address: extractLocation(content),
    phone: phoneMatch ? phoneMatch[0] : '',
    email: emailMatch ? emailMatch[0] : '',
    source: result.url,
    hot: !!(phoneMatch || emailMatch),
    timestamp: new Date().toISOString()
  };
}

// Helper function to extract location from content
function extractLocation(content) {
  const locations = ['cincinnati', 'dayton', 'covington', 'florence', 'hebron', 'northern kentucky'];
  for (const loc of locations) {
    if (content.includes(loc)) {
      return loc.charAt(0).toUpperCase() + loc.slice(1);
    }
  }
  return 'Local Area';
}

// Endpoint to trigger all agent scans
app.get('/trigger-all', async (req, res) => {
  console.log('🔍 Starting scan for all agents...');
  
  if (!TAVILY_API_KEY) {
    console.error('❌ TAVILY_API_KEY not set!');
    return res.status(500).json({ error: 'Tavily API key not configured' });
  }

  try {
    // Scan each agent type
    for (const [agentKey, queries] of Object.entries(SEARCH_QUERIES)) {
      console.log(`Scanning ${agentKey}...`);
      
      for (const query of queries) {
        const results = await searchTavily(query);
        
        if (results && results.length > 0) {
          console.log(`  Found ${results.length} results for: ${query}`);
          
          // Process each result and extract leads
          for (const result of results) {
            const lead = extractLeadFromResult(result, agentKey);
            
            if (lead) {
              // Check if we already have this lead (avoid duplicates)
              const exists = leadsData[agentKey].some(l => l.source === lead.source);
              
              if (!exists) {
                leadsData[agentKey].push(lead);
                console.log(`  ✅ Added new lead: ${lead.name}`);
              }
            }
          }
        }
        
        // Small delay between searches to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    console.log('✅ Scan complete!');
    res.json({ success: true, message: 'Scan completed' });
    
  } catch (error) {
    console.error('❌ Error during scan:', error);
    res.status(500).json({ error: 'Scan failed', details: error.message });
  }
});

// Endpoint to get all leads
app.get('/api/leads', (req, res) => {
  res.json(leadsData);
});

// Endpoint to add manual lead
app.post('/api/add-lead', (req, res) => {
  const lead = {
    ...req.body,
    timestamp: new Date().toISOString()
  };
  
  leadsData.manual.push(lead);
  console.log('📝 Manual lead added:', lead.name);
  res.json({ success: true, lead });
});

// Endpoint to clear all leads
app.delete('/api/leads', (req, res) => {
  leadsData = {
    realEstate: [],
    socialMedia: [],
    marketplace: [],
    eventSeason: [],
    craigslist: [],
    manual: []
  };
  res.json({ success: true, message: 'All leads cleared' });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    tavilyConfigured: !!TAVILY_API_KEY,
    leadsCount: Object.values(leadsData).reduce((sum, arr) => sum + arr.length, 0)
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Tavily API: ${TAVILY_API_KEY ? '✅ Configured' : '❌ Not configured'}`);
});
