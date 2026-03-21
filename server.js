const express = require('express');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));   // serves your index.html

// This is the exact endpoint your frontend is calling
app.post('/api/search-leads', async (req, res) => {
  try {
    const { action, data } = req.body;

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

      return res.json({ success: true, content: tavilyData.results || [] });
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

      return res.json({ success: true, content: [{ type: 'text', text }] });
    }

    res.status(400).json({ error: 'Invalid action' });
  } catch (error) {
    console.error('API error:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});
