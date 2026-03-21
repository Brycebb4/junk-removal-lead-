const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '.'))); // serves index.html + assets

// === YOUR ORIGINAL BACKEND LOGIC (now on Render) ===
app.post('/search-lead', async (req, res) => {
  if (req.body.action === 'search') {
    const tavilyRes = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query: req.body.data.query,
        search_depth: 'advanced',
        max_results: 8
      })
    });
    const tavilyData = await tavilyRes.json();
    return res.json({ success: true, content: tavilyData.results || [] });
  }

  if (req.body.action === 'extract') {
    const messages = [
      { role: "system", content: "You are a precise JSON extractor. Return ONLY a valid JSON array of leads. No explanations, no markdown." },
      ...req.body.data.messages
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
    const groqData = await groqRes.json();
    const text = groqData.choices?.[0]?.message?.content || '[]';

    return res.json({ success: true, content: [{ type: 'text', text }] });
  }

  res.status(400).json({ error: 'Invalid action' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Junk Removal Lead Generator running on port ${PORT}`));
