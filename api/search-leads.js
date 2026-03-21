export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  try {
    const { action, data } = JSON.parse(req.body);

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
      const tavilyData = await tavilyRes.json();

      return new Response(JSON.stringify({ content: tavilyData.results || [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (action === 'extract') {
      const messages = [
        { role: "system", content: "You are a precise JSON extractor. Return ONLY a valid JSON array of leads. No explanations, no markdown, no extra text." },
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
          messages: messages,
          max_tokens: 2000,
          temperature: 0.2
        })
      });
      const groqData = await groqRes.json();
      const text = groqData.choices?.[0]?.message?.content || '[]';

      return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400 });
  } catch (error) {
    console.error('Function error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), { status: 500 });
  }
}
