export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
    );
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

    if (action === 'extract') {
      const messages = [
        { role: "system", content: "You are a precise JSON extractor. Return ONLY a valid JSON array of leads. No explanations, no markdown." },
        ...data.messages
      ];

      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages,
          max_tokens: 2000,
          temperature: 0.2
        })
      });

      if (!groqRes.ok) throw new Error(`Groq error: ${groqRes.status}`);
      const groqData = await groqRes.json();
      const text = groqData.choices?.[0]?.message?.content || '[]';

      return new Response(
        JSON.stringify({ success: true, content: [{ type: 'text', text }] }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      );
    }

    return new Response(JSON.stringify({ error: 'Invalid action' }), { 
      status: 400, 
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } 
    });

  } catch (error) {
    console.error('Function error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error', message: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
    );
  }
}
