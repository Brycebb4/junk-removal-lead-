export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { 
      status: 405, 
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } 
    });
  }

  try {
    const { action, data } = await req.json();

    if (action === 'search') {
      const tavilyRes = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query: data.query,
          search_depth: 'advanced',
          max_results: 8
        })
      });

      if (!tavilyRes.ok) throw new Error(`Tavily error: ${tavilyRes.status}`);
      const tavilyData = await tavilyRes.json();

      return new Response(
        JSON.stringify({ success: true, content: tavilyData.results || [] }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      );
    }

    // ... (the rest of the extract action + catch block – just copy the full block I gave you last message)

  } catch (error) {
    console.error('Function error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error', message: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
    );
  }
}
