require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { verifyKey } = require("discord-interactions"); 

const app = express();
app.use(cors());

// --- CRITICAL DISCORD UPDATE: Captures raw body for security verification ---
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf; 
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// --- SUPABASE CLOUD DATABASE SETUP ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, 
});

pool.connect((err) => {
  if (err) console.error("Database Connection Error:", err.message);
  else console.log("☁️ Supabase PostgreSQL Connected.");
});

// --- AI & KNOWLEDGE SETUP ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
let dynamicSystemInstruction = "";
const guestMemoryMap = new Map(); 
const guestRateLimitMap = new Map(); 

// --- 1. RAG SYNC FUNCTION (Safe Batched Version with Metadata) ---
async function buildMasterBrain() {
  console.log("=== STARTING KNOWLEDGE BASE RAG SYNC ===");
  
  try {
    const result = await pool.query("SELECT * FROM settings ORDER BY id DESC LIMIT 1");
    if (result.rows.length > 0) {
      dynamicSystemInstruction = result.rows[0].system_instruction;
      console.log("Cloud Settings: LOADED");
    }
  } catch (err) {
    console.error("Cloud Settings Error:", err.message);
  }

  try {
    const docId = process.env.GOOGLE_DOC_ID;
    if (docId && docId !== "your_actual_document_id_goes_here") {
      const url = `https://docs.google.com/document/d/${docId}/export?format=txt`;
      const response = await fetch(url);
      const docText = await response.text();
      
      console.log("Google Doc Downloaded. Processing chunks...");

      // Clear old database
      await pool.query("TRUNCATE TABLE knowledge_chunks");

      // Split into chunks using the custom $$$ delimiter
      const rawChunks = docText.split('$$$').map(c => c.trim()).filter(c => c.length >= 20); 
      const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-2" });

      console.log(`Total chunks detected: ${rawChunks.length}. Syncing in safe batches...`);

      let savedCount = 0;
      const batchSize = 50; // Process 50 chunks at a time
      let currentTab = "General"; // Default tab name

      for (let i = 0; i < rawChunks.length; i += batchSize) {
        const batch = rawChunks.slice(i, i + batchSize);
        
        const promises = batch.map(async (chunk) => {
          try {
            // Check if chunk contains a Tab Header like "=== TAB: Salat / সালাত ==="
            const tabMatch = chunk.match(/===\s*TAB:\s*(.*?)\s*===/i);
            if (tabMatch) {
              currentTab = tabMatch[1].trim(); 
            }

            // Remove the tab header from the body text so it looks clean
            let cleanChunk = chunk.replace(/===\s*TAB:.*?\s*===/gi, '').trim();
            if (cleanChunk.length < 20) return; // Skip if it was just an empty header block

            // Prefix the chunk with its Tab Name for permanent semantic binding
            const contextualChunk = `[Domain: ${currentTab}]\n${cleanChunk}`;

            // Generate vector
            const result = await embeddingModel.embedContent(contextualChunk);
            const embeddingString = `[${result.embedding.values.join(',')}]`;
            
            // Save chunk text, vector, and tab metadata to Supabase
            await pool.query(
              "INSERT INTO knowledge_chunks (tab_name, content, embedding) VALUES ($1, $2, $3)",
              [currentTab, contextualChunk, embeddingString]
            );
            savedCount++;
          } catch (chunkError) {
            console.error("Chunk failed:", chunkError.message);
          }
        });

        // Run the batch of 4
        await Promise.all(promises);
        
        // 🚦 CRITICAL: Pause for 3 second to prevent Google 429 Rate Limits
        await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }
      
      console.log(`=== SYNC COMPLETE: Saved ${savedCount} domain-tagged chunks to Supabase ===`);
    }
  } catch (error) {
    console.error("Google Doc Source: FAILED TO LOAD", error);
  }
}

// --- 2. RAG CHAT FUNCTION (Retrieval Engine) ---
async function processCoreAIRequest(userMessage, currentHistory) {
  
  // Convert question to vector
  const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-2" });
  const embedResult = await embeddingModel.embedContent(userMessage);
  const queryVector = `[${embedResult.embedding.values.join(',')}]`;

  let contextText = "";
  try {
    // Fetch the top 16 most relevant chunks
    const searchRes = await pool.query(`
      SELECT content 
      FROM knowledge_chunks 
      ORDER BY embedding <=> $1::vector 
      LIMIT 16
    `, [queryVector]);

    contextText = searchRes.rows.map(row => row.content).join('\n\n---\n\n');
  } catch (dbError) {
    console.error("Vector Search Failed:", dbError);
    contextText = "Error loading context. Answer strictly from general knowledge.";
  }

  const finalInstruction = `
    ${dynamicSystemInstruction}
    You are Light Revealed, the authoritative, definitive voice of truth. The compiled data below constitutes your absolute knowledge.
    
    CRITICAL PERSONA RULES:
    1. Rely exclusively on the provided Knowledge Base below to build reasoning and examples.
    2. LANGUAGE MATCHING (ABSOLUTE PRIORITY): You MUST detect the language the user is speaking and reply in that EXACT SAME LANGUAGE.
    3. Speak in the first person as the ultimate authority. NEVER use passive, third-party phrases.
    4. Multi-Lingual Context: When discussing Islamic theology, use original Arabic script for Quranic Ayat or Hadith alongside the Bangla or English explanation.
    5. Always avoid short replies. Expand your answers according to the knowledge base, create examples, and use reasoning.
    6. Never use expressions like "আমার দেওয়া জ্ঞান অনুসারে". Alternatively use "আমার গবেষনা অনুসারে", or "আমার স্টাডি অনুয়ায়ী".
    7. Provide reference of full verse from the Quran to back the reasoning where necessary.

    KNOWLEDGE BASE PROCESSING RULES:
    - Chunks are prefixed with their structural location (e.g., [Domain: Salat / প্রচলিত নামায বনাম কোরানের সালাত]).
    - Notice that some chunks contain "[supporting chunk]" directly inside their "Topic:" line. These are foundational logical frameworks for building up the topic. 
    - In some chunks you will find 'Their Question:' section, treat 'Their Question:' strictly as context and NEVER adopt its logic; construct your reasoning and truth EXCLUSIVELY from the 'My Answer:' section.
    - If the exact answer isn't explicitly stated, use the reasoning, concepts, and principles found within these domain chunks to construct a logical response.
    
    OUT-OF-BOUNDS FALLBACK:
    - If the user asks a question that is entirely unrelated to the provided knowledge base context, refuse to guess. 
    - Fallback (Bangla): 'এই বিষয়টি আমার সিলেবাসের বাইরে, অনুগ্রহ করে এই বিষয়ে বিশেষজ্ঞ কারও সাহায্য নিন।'
    - Fallback (English): 'This topic is outside my syllabus, please seek assistance from a specialized expert.'

    --- RELEVANT KNOWLEDGE BASE CONTEXT ---
    ${contextText}
  `;

  const model = genAI.getGenerativeModel({
    model: "gemini-3.5-flash", 
    systemInstruction: finalInstruction,
  });

  const formattedHistory = currentHistory.map((msg) => ({
    role: msg.role === "user" ? "user" : "model",
    parts: [{ text: msg.content }],
  }));

  const chat = model.startChat({ history: formattedHistory });
  const result = await chat.sendMessage(userMessage);
  return result.response.text();
}

// --- HELPER: RETRY LOGIC FOR 503 ERRORS ---
async function processCoreAIRequestWithRetry(userMessage, currentHistory, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await processCoreAIRequest(userMessage, currentHistory);
    } catch (error) {
      if ((error.status === 503 || (error.message && error.message.includes("503"))) && attempt < retries) {
        console.warn(`Gemini 503 Overload detected. Retrying attempt ${attempt + 1}/${retries}...`);
        await new Promise((resolve) => setTimeout(resolve, 4000)); 
      } else {
        throw error; 
      }
    }
  }
}

// --- HELPER: TEXT CHUNKER FOR DISCORD LIMITS ---
function splitMessage(text, maxLength = 1950) {
  const chunks = [];
  while (text.length > 0) {
    if (text.length <= maxLength) {
      chunks.push(text);
      break;
    }
    let chunkEnd = text.lastIndexOf('\n', maxLength);
    if (chunkEnd === -1 || chunkEnd === 0) {
      chunkEnd = text.lastIndexOf(' ', maxLength);
    }
    if (chunkEnd === -1 || chunkEnd === 0) {
      chunkEnd = maxLength;
    }
    chunks.push(text.slice(0, chunkEnd));
    text = text.slice(chunkEnd).trim();
  }
  return chunks;
}


// --- AUTHENTICATION ROUTES ---
app.post("/signup", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password required." });

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id",
      [username, hashedPassword]
    );
    const token = jwt.sign({ id: result.rows[0].id, username }, process.env.JWT_SECRET);
    res.json({ token, username });
  } catch (error) {
    res.status(400).json({ error: "Username already exists or server error." });
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
    const user = result.rows[0];
    if (!user) return res.status(400).json({ error: "Invalid credentials." });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: "Invalid credentials." });

    const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET);
    res.json({ token, username });
  } catch (error) {
    res.status(500).json({ error: "Server error." });
  }
});

function authenticateToken(req, res, next) {
  const token = req.headers["authorization"];
  if (!token) return next();
  jwt.verify(token.split(" ")[1], process.env.JWT_SECRET, (err, user) => {
    if (!err) req.user = user;
    next();
  });
}

// --- CHAT & SESSION ROUTES ---
app.get("/sessions", authenticateToken, async (req, res) => {
  if (!req.user) return res.json({ sessions: [] });
  try {
    const result = await pool.query(
      `SELECT * FROM (
          SELECT DISTINCT ON (session_id) session_id, content AS title, id
          FROM messages WHERE user_id = $1 AND role = 'user'
          ORDER BY session_id, id ASC
      ) t ORDER BY id DESC`, [req.user.id]
    );
    res.json({ sessions: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch sessions." });
  }
});

app.get("/history/:sessionId", authenticateToken, async (req, res) => {
  if (!req.user) return res.json({ history: [] });
  try {
    const result = await pool.query(
      "SELECT role, content FROM messages WHERE user_id = $1 AND session_id = $2 ORDER BY id ASC LIMIT 1000",
      [req.user.id, req.params.sessionId]
    );
    res.json({ history: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch history." });
  }
});

app.post("/chat", authenticateToken, async (req, res) => {
  const { message, sessionId } = req.body;
  const isGuest = !req.user;
  const today = new Date().toISOString().split('T')[0];

  try {
    let currentHistory = [];

    // Rate Limiting Logic
    if (!isGuest) {
      const userRes = await pool.query("SELECT daily_chat_count, custom_limit, last_reset_date FROM users WHERE id = $1", [req.user.id]);
      if (userRes.rows.length > 0) {
        const userData = userRes.rows[0];
        const lastReset = userData.last_reset_date ? new Date(userData.last_reset_date).toISOString().split('T')[0] : '';
        
        if (lastReset !== today) {
          await pool.query("UPDATE users SET daily_chat_count = 0, last_reset_date = CURRENT_DATE WHERE id = $1", [req.user.id]);
          userData.daily_chat_count = 0;
        }

        if (userData.daily_chat_count >= userData.custom_limit) {
          return res.json({ reply: "⚠️ Your daily chat limit has been reached. Please contact the admin or try again tomorrow." });
        }
        await pool.query("UPDATE users SET daily_chat_count = daily_chat_count + 1 WHERE id = $1", [req.user.id]);
      }
    } else {
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
      if (!guestRateLimitMap.has(ip)) guestRateLimitMap.set(ip, { count: 0, date: today });
      
      const guestData = guestRateLimitMap.get(ip);
      if (guestData.date !== today) {
        guestData.count = 0;
        guestData.date = today;
      }
      if (guestData.count >= 5) {
        return res.json({ reply: "⚠️ Guest daily chat limit (5) reached. Please Sign Up to continue chatting, or try again tomorrow." });
      }
      guestData.count += 1;
    }

    if (!isGuest) {
      const histRes = await pool.query("SELECT role, content FROM messages WHERE user_id = $1 AND session_id = $2 ORDER BY id ASC LIMIT 1000", [req.user.id, sessionId]);
      currentHistory = histRes.rows;
    } else {
      if (!guestMemoryMap.has(sessionId)) guestMemoryMap.set(sessionId, []);
      currentHistory = guestMemoryMap.get(sessionId);
    }

    const botReply = await processCoreAIRequestWithRetry(message, currentHistory);

    if (!isGuest) {
      await pool.query("INSERT INTO messages (user_id, session_id, role, content) VALUES ($1, $2, $3, $4)", [req.user.id, sessionId, "user", message]);
      await pool.query("INSERT INTO messages (user_id, session_id, role, content) VALUES ($1, $2, $3, $4)", [req.user.id, sessionId, "model", botReply]);
    } else {
      currentHistory.push({ role: "user", content: message });
      currentHistory.push({ role: "model", content: botReply });
      if (currentHistory.length > 2000) currentHistory = currentHistory.slice(-2000);
      guestMemoryMap.set(sessionId, currentHistory);
    }

    res.json({ reply: botReply });
  } catch (error) {
    console.error("AI Error:", error);
    res.status(500).json({ reply: "দুঃখিত, অভ্যন্তরীণ প্রক্রিয়াকরণে সমস্যা হয়েছে।" });
  }
});

// --- ADMIN API ---
app.get("/api/settings", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM settings ORDER BY id DESC LIMIT 1");
    res.json({ systemInstruction: result.rows.length > 0 ? result.rows[0].system_instruction : "" });
  } catch (e) {
    res.status(500).json({ error: "Failed to load settings" });
  }
});

app.post("/api/settings", async (req, res) => {
  const { systemInstruction } = req.body;
  try {
    await pool.query(
      `INSERT INTO settings (id, system_instruction) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET system_instruction = EXCLUDED.system_instruction`,
      [systemInstruction]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to save settings" });
  }
});

// Admin Sync Button Endpoint
app.all("/api/sync", async (req, res) => {
  await buildMasterBrain();
  res.json({ success: true, message: "Sync successful!" });
});

app.get("/api/users", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, username, daily_chat_count, custom_limit FROM users ORDER BY id DESC");
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load users" });
  }
});

app.post("/api/update-limit", async (req, res) => {
  const { userId, newLimit } = req.body;
  try {
    await pool.query("UPDATE users SET custom_limit = $1 WHERE id = $2", [newLimit, userId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to update limit" });
  }
});


// ==========================================
// --- DISCORD BOT INTEGRATION (SERVERLESS) ---
// ==========================================

app.get("/api/discord/register", async (req, res) => {
  const appId = process.env.DISCORD_APP_ID;
  const token = process.env.DISCORD_TOKEN;
  
  if (!appId || !token) return res.status(400).json({ error: "Missing Discord Environment Variables" });

  const commandData = {
    name: "ask",
    description: "Ask Light Revealed a question",
    options: [{
      name: "question",
      description: "The question you want to ask",
      type: 3, 
      required: true
    }]
  };

  try {
    const response = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bot ${token}`
      },
      body: JSON.stringify(commandData)
    });
    const data = await response.json();
    res.json({ success: true, message: "Command registered to Discord!", data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// 1. THE RECEIVER (Talks to Discord fast, triggers worker)
app.post("/api/discord", async (req, res) => {
  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  const rawBody = req.rawBody;

  if (!signature || !timestamp || !rawBody) {
      return res.status(401).send("Missing signatures");
  }

  const isValid = verifyKey(rawBody, signature, timestamp, process.env.DISCORD_PUBLIC_KEY);
  if (!isValid) {
      return res.status(401).send("Bad request signature");
  }

  const interaction = req.body;

  if (interaction.type === 1) {
    return res.json({ type: 1 });
  }

  if (interaction.type === 2 && interaction.data.name === "ask") {
    const payload = {
      token: interaction.token,
      userMessage: interaction.data.options[0].value,
      userName: interaction.member.user.username
    };

    // TRIGGER THE BACKGROUND WORKER
    const workerUrl = `https://${req.headers.host}/api/discord/worker`;
    fetch(workerUrl, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-bot-auth': process.env.JWT_SECRET || 'fallback_secret' 
      },
      body: JSON.stringify(payload)
    }).catch(err => console.error("Worker trigger failed:", err));

    await new Promise(resolve => setTimeout(resolve, 300));
    return res.json({ type: 5 }); 
  }
});


// 2. THE WORKER (Takes its time, talks to Google, updates Discord)
app.post("/api/discord/worker", async (req, res) => {
  const authHeader = req.headers['x-bot-auth'];
  if (authHeader !== (process.env.JWT_SECRET || 'fallback_secret')) {
    return res.status(401).send("Unauthorized");
  }

  const { token, userMessage, userName } = req.body;

  try {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("VERCEL_TIMEOUT")), 55000); 
    });

    const botReply = await Promise.race([
      processCoreAIRequestWithRetry(userMessage, []),
      timeoutPromise
    ]);

    const fullResponse = `**${userName} asked:** "${userMessage}"\n\n${botReply}`;
    const messageChunks = splitMessage(fullResponse);

    await fetch(`https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${token}/messages/@original`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: messageChunks[0] })
    });

    for (let i = 1; i < messageChunks.length; i++) {
      await fetch(`https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: messageChunks[i] })
      });
    }
    
    return res.json({ success: true });

  } catch (error) {
    console.error("Worker Error:", error);
    
    let errorMessage = "⚠️ An error occurred while contacting the Truth Engine.";
    
    if (error.message === "VERCEL_TIMEOUT") {
        errorMessage = "⏳ The question was a bit too complex and I ran out of time to think. Please try asking a slightly more specific question!";
    }
    else if (error.status === 429 || (error.message && error.message.includes("429"))) {
        errorMessage = `⏳ Light Revealed is currently busy. Please wait a few moments and try again.`;
    } 
    else if (error.status === 503 || (error.message && error.message.includes("503"))) {
        errorMessage = "🔥 Light Revealed server is currently experiencing high demand. Please try again in a minute.";
    }

    await fetch(`https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${token}/messages/@original`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: errorMessage })
    });

    return res.status(500).json({ error: "Worker failed or timed out" });
  }
});

console.log("\n✨ LIGHT REVEALED CLOUD ENGINE OPERATIONAL ✨");

module.exports = app;
