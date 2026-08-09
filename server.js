require("dotenv").config();

// --- CRITICAL FIX: FORCES DISCORD TO USE IPv4 AND PREVENTS GATEWAY HANGS ---
const { setDefaultResultOrder } = require('node:dns');
setDefaultResultOrder('ipv4first');
// --------------------------------------------------------------------------

const express = require("express");
const cors = require("cors");
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { verifyKey } = require("discord-interactions"); 
const { Client, GatewayIntentBits } = require("discord.js");

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

// ==========================================
// --- LIVE SYNC TRACKING STATE (SSE) ---
// ==========================================
let currentSyncStatus = {
  active: false,
  totalDocChunks: 0,
  toAdd: 0,
  toDelete: 0,
  saved: 0,
  failed: 0,
  logs: [],
  complete: false
};

let syncClients = [];

function broadcastSyncUpdate(message, type = "info") {
  const timestamp = new Date().toLocaleTimeString();
  const formattedLog = `[${timestamp}] ${message}`;
  
  currentSyncStatus.logs.push(formattedLog);
  console.log(message); 

  syncClients.forEach(client => {
    client.res.write(`data: ${JSON.stringify({ ...currentSyncStatus, latestLog: formattedLog, logType: type })}\n\n`);
  });
}

app.get("/api/sync-stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  res.write(`data: ${JSON.stringify(currentSyncStatus)}\n\n`);

  const clientId = Date.now();
  syncClients.push({ id: clientId, res });

  req.on("close", () => {
    syncClients = syncClients.filter(c => c.id !== clientId);
  });
});

// --- 1. SMART RAG SYNC FUNCTION (Live Streaming & Force Wipe Support) ---
async function buildMasterBrain(isForceSync = false) {
  broadcastSyncUpdate("⚙️ Initializing Smart Knowledge Base Sync...", "info");
  
  try {
    const result = await pool.query("SELECT * FROM settings ORDER BY id DESC LIMIT 1");
    if (result.rows.length > 0) {
      dynamicSystemInstruction = result.rows[0].system_instruction;
      broadcastSyncUpdate("✓ Dynamic System Instructions updated from settings table.", "info");
    }
  } catch (err) {
    broadcastSyncUpdate(`⚠️ Cloud Settings Error: ${err.message}`, "error");
  }

  try {
    const docId = process.env.GOOGLE_DOC_ID;
    if (!docId || docId === "your_actual_document_id_goes_here") {
       broadcastSyncUpdate("❌ Sync Aborted: GOOGLE_DOC_ID is missing in environment variables.", "error");
       currentSyncStatus.active = false;
       return;
    }

    broadcastSyncUpdate("📥 Downloading Google Document payload...", "info");
    const url = `https://docs.google.com/document/d/${docId}/export?format=txt`;
    const response = await fetch(url);
    const docText = await response.text();
    
    // 🔥 NEW LOGIC: Wipe the database completely if it's a Force Sync
    if (isForceSync) {
        broadcastSyncUpdate("⚠️ FORCE SYNC INITIATED: Wiping entire Supabase knowledge table...", "error");
        await pool.query("TRUNCATE TABLE knowledge_chunks");
        broadcastSyncUpdate("✓ Database purged. Rebuilding from scratch...", "info");
    }

    broadcastSyncUpdate("🔍 Diff Analysis: Comparing Google Doc with Supabase indices...", "info");

    let existingDbChunks = new Map();
    if (!isForceSync) {
        const existingRes = await pool.query("SELECT id, content FROM knowledge_chunks");
        existingDbChunks = new Map(existingRes.rows.map(row => [row.content, row.id]));
    }

    const rawChunks = docText.split('$$$').map(c => c.trim()).filter(c => c.length >= 20); 
    const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-2" });

    let currentTab = "General"; 
    const activeDocChunks = new Set();
    const chunksToAdd = [];

    for (const chunk of rawChunks) {
       const tabMatch = chunk.match(/===\s*TAB:\s*(.*?)\s*===/i);
       if (tabMatch) {
          currentTab = tabMatch[1].trim(); 
       }
       let cleanChunk = chunk.replace(/===\s*TAB:.*?\s*===/gi, '').trim();
       if (cleanChunk.length < 20) continue; 

       const contextualChunk = `[Domain: ${currentTab}]\n${cleanChunk}`;
       activeDocChunks.add(contextualChunk);
       
       if (!existingDbChunks.has(contextualChunk)) {
          chunksToAdd.push({ tab: currentTab, text: contextualChunk });
       }
    }

    const idsToDelete = [];
    for (const [dbContent, dbId] of existingDbChunks.entries()) {
       if (!activeDocChunks.has(dbContent)) {
          idsToDelete.push(dbId);
       }
    }

    currentSyncStatus.totalDocChunks = activeDocChunks.size;
    currentSyncStatus.toAdd = chunksToAdd.length;
    currentSyncStatus.toDelete = idsToDelete.length;

    broadcastSyncUpdate(`📊 Target Metrics: Doc Total: ${activeDocChunks.size} | New: ${chunksToAdd.length} | Obsolete: ${idsToDelete.length}`);

    if (idsToDelete.length > 0) {
       broadcastSyncUpdate(`🗑️ Flushing ${idsToDelete.length} obsolete chunks from Supabase...`);
       const deleteQuery = `DELETE FROM knowledge_chunks WHERE id = ANY($1::int[])`;
       await pool.query(deleteQuery, [idsToDelete]);
       broadcastSyncUpdate(`✓ Cache cleanup successful.`);
    }

    if (chunksToAdd.length === 0) {
      currentSyncStatus.active = false;
      currentSyncStatus.complete = true;
      broadcastSyncUpdate("✅ SYNC COMPLETE: Database matches your Google Doc perfectly. No embedding requests needed!", "success");
      return;
    }

    const batchSize = 10; 
    broadcastSyncUpdate(`🚀 Commencing Gemini API embedding calculations in blocks of ${batchSize}...`);
    
    for (let i = 0; i < chunksToAdd.length; i += batchSize) {
      const batch = chunksToAdd.slice(i, i + batchSize);
      
      try {
        const batchRequests = batch.map(item => ({
          content: { parts: [{ text: item.text }] }
        }));
        
        const result = await embeddingModel.batchEmbedContents({ requests: batchRequests });
        
        if (result.embeddings && result.embeddings.length === batch.length) {
            for (let j = 0; j < batch.length; j++) {
                const item = batch[j];
                const embeddingString = `[${result.embeddings[j].values.join(',')}]`;
                
                await pool.query(
                  "INSERT INTO knowledge_chunks (tab_name, content, embedding) VALUES ($1, $2, $3)",
                  [item.tab, item.text, embeddingString]
                );
                currentSyncStatus.saved++;
            }
            broadcastSyncUpdate(`⚡ Batch complete: Saved progress (${currentSyncStatus.saved}/${chunksToAdd.length} chunks calculated)`);
        } else {
             throw new Error("API returned mismatched array dimensional block lengths.");
        }
        
        if (i + batchSize < chunksToAdd.length) {
            broadcastSyncUpdate("⏳ Cooldown period triggered: Sleeping 15 seconds to stay under Token limits...", "info");
            await new Promise(resolve => setTimeout(resolve, 15000));
        }
        
      } catch (batchError) {
         currentSyncStatus.failed += batch.length;
         broadcastSyncUpdate(`❌ Rate-Limit/API Error processing block [index ${i}]: ${batchError.message}`, "error");
         broadcastSyncUpdate("⏳ Safety buffer activated: 30-second cooldown recovery sleep...", "info");
         await new Promise(resolve => setTimeout(resolve, 30000));
      }
    }
    
    currentSyncStatus.active = false;
    currentSyncStatus.complete = true;
    broadcastSyncUpdate(`✨ SYNC SESSION ENDED: Successfully verified ${currentSyncStatus.saved} saved | ${currentSyncStatus.failed} failed items. ✨`, "success");

  } catch (error) {
    currentSyncStatus.active = false;
    broadcastSyncUpdate(`🔥 Global sync processing pipeline crashed: ${error.message}`, "error");
  }
}

// --- 2. RAG CHAT FUNCTION (Retrieval Engine) ---
async function processCoreAIRequest(userMessage, currentHistory) {
  
  const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-2" });
  const embedResult = await embeddingModel.embedContent(userMessage);
  const queryVector = `[${embedResult.embedding.values.join(',')}]`;

  let contextText = "";
  try {
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
# ROLE & IDENTITY
You are the Founder of 'Light Revealed'—a deep-research foundation dedicated to religion, culture, and social behavior. You speak in an authoritative, scholarly, and definitive voice. You do not just recite facts; you break down core principles, analyze logic, and construct deep conceptual arguments.

# CORE REASONING & EXTRAPOLATION DIRECTIVES
1. CONCEPTUAL BRIDGING (HIGH PRIORITY): Do NOT look for exact keyword matches. If a user asks about a topic related to religion, social behavior, ethics, or theology, use the core philosophy, logical frameworks, and principles in the Knowledge Base to deduce and construct a well-reasoned answer.
2. SYNTHESIZE PRINCIPLES: If an exact query isn't explicitly written, apply the fundamental truths found in relevant domain chunks (especially [supporting chunk] and 'My Answer:' sections) to build a logical, cohesive response.
3. ZERO META-TALK: Never break character. Never mention "system instructions," "knowledge base," "context," "chunks," "provided data," "prompt," or "AI." Speak naturally as the Founder sharing your research.
4. FIRST-PERSON AUTHORITY: Speak exclusively in the first person ("I," "my research," "my findings").
   - BANGLA: Use "আমার গবেষণা অনুসারে" or "আমার স্টাডি অনুযায়ী".
   - NEVER USE: "আমার দেওয়া জ্ঞান অনুসারে" or "প্রদত্ত তথ্যের ভিত্তিতে".

# LANGUAGE & FORMATTING RULES
1. DYNAMIC LANGUAGE MATCHING (ABSOLUTE PRIORITY): Detect the primary language of the user's message and reply in that EXACT SAME LANGUAGE.
2. MULTI-LINGUAL ISLAMIC TEXTS:
   - When discussing Islamic theology or quoting Quran/Hadith, include the original Arabic script along with the translation/explanation in the user's primary language (Bangla or English).
   - Provide full verse citations (Surah Name/Number : Verse Number) where necessary.
3. EXPANDED REASONING: Avoid brief or surface-level answers. Unpack concepts, explain the logical build-up, and create examples based on your research principles.
4. COMPARATIVE STRUCTURES: Use Markdown tables whenever contrasting traditional views vs. core research findings, or comparing opposing concepts.

# KNOWLEDGE BASE PROCESSING RULES
- STRUCTURAL PREFIXES: Location markers (e.g., [Domain: Salat / প্রচলিত নামায বনাম কোরানের সালাত]) indicate topic domains.
- QUESTION VS. TRUTH HANDLING: In chunks containing "Their Question:":
  * Treat "Their Question:" strictly as context for what people ask. NEVER adopt its logic.
  * Construct all truth and reasoning EXCLUSIVELY from the "My Answer:" section.

# OUT-OF-BOUNDS & FALLBACK PROTOCOL
You must ONLY trigger the fallback response when a query is completely, unambiguously unrelated to religion, social behavior, culture, ethics, or the scope of your foundation (e.g., programming/coding, sports scores, recipes, pop culture, song lyrics, tech troubleshooting).

If—and ONLY IF—the question is completely off-topic from these core domains, reply exclusively with:
- IF BANGLA: "এই বিষয়টি আমার সিলেবাসের বাইরে, অনুগ্রহ করে এই বিষয়ে বিশেষজ্ঞ কারও সাহায্য নিন।"
- IF ENGLISH: "This topic is outside my syllabus, please seek assistance from a specialized expert."

--- RELEVANT KNOWLEDGE BASE CONTEXT ---
${contextText}
  `;

  const model = genAI.getGenerativeModel({
    model: "gemini-3.5-flash-lite", 
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
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: "All fields required." });

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO users (username, email, password) VALUES ($1, $2, $3) RETURNING id",
      [username, email.toLowerCase(), hashedPassword]
    );
    
    const token = jwt.sign({ id: result.rows[0].id, username }, process.env.JWT_SECRET);
    
    res.json({ token, username });

  } catch (error) {
    if (error.code === '23505') {
        res.status(400).json({ error: "Username or Email already exists." });
    } else {
        res.status(500).json({ error: "Database error occurred." });
    }
  }
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user) return res.status(400).json({ error: "Account not found." });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: "Invalid password." });

    const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET);
    res.json({ token, username: user.username });
  } catch (error) {
    res.status(500).json({ error: "Server error." });
  }
});

// --- NEW BREVO API PASSWORD RESET ---
// --- NEW BREVO API PASSWORD RESET ---
app.post("/request-reset", async (req, res) => {
  const { email } = req.body;
  console.log("DEBUG: Starting reset process for:", email);

  // 🔍 SAFETY CHECKPOINT: Let's see what Render is sending to the server
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
      console.error("DEBUG CRITICAL: BREVO_API_KEY is completely MISSING or blank in Render Environment settings!");
  } else {
      console.log(`DEBUG: BREVO_API_KEY found. Starts with: "${apiKey.substring(0, 5)}..." (Total length: ${apiKey.length} characters)`);
  }

  try {
    const result = await pool.query("SELECT id, username FROM users WHERE email = $1", [email.toLowerCase()]);
    if (result.rows.length === 0) {
        console.log("DEBUG: Email not found.");
        return res.status(400).json({ error: "Email not found." });
    }

    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    await pool.query("UPDATE users SET reset_code = $1 WHERE email = $2", [resetCode, email.toLowerCase()]);

    console.log("DEBUG: Attempting to send email via Brevo API...");
    
    const brevoResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
            'accept': 'application/json',
            'api-key': apiKey, // Using validated key variable
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            sender: { name: "Light Revealed", email: process.env.EMAIL_USER },
            to: [{ email: email.toLowerCase() }],
            subject: "Password Reset Code",
            htmlContent: `<p>Hello ${result.rows[0].username},</p><p>Your 6-digit password reset code is: <strong>${resetCode}</strong></p><p>If you didn't request this, you can ignore this email.</p>`
        })
    });

    if (!brevoResponse.ok) {
        const errorData = await brevoResponse.json();
        console.error("DEBUG CRITICAL: Brevo API Error:", errorData);
        return res.status(500).json({ error: "Failed to send email API request." });
    }

    console.log("DEBUG: Email function completed successfully!");
    res.json({ success: true, message: "Code sent!" });

  } catch (error) {
    console.error("DEBUG: FAILED at:", error); 
    res.status(500).json({ error: "Failed to process: " + error.message });
  }
});

app.post("/reset-password", async (req, res) => {
  const { email, code, newPassword } = req.body;
  try {
    const result = await pool.query("SELECT id FROM users WHERE email = $1 AND reset_code = $2", [email.toLowerCase(), code]);
    if (result.rows.length === 0) return res.status(400).json({ error: "Invalid or expired reset code." });

    const newHashedPassword = await bcrypt.hash(newPassword, 10);
    
    await pool.query("UPDATE users SET password = $1, reset_code = NULL WHERE email = $2", [newHashedPassword, email.toLowerCase()]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to reset password." });
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

// --- OPTIMIZED BOOKMARK ROUTES ---
app.get("/bookmarks", authenticateToken, async (req, res) => {
  if (!req.user) return res.json({ bookmarks: [] });
  try {
    // This clever SQL grabs the bookmarked bot reply AND the user prompt right above it
    const result = await pool.query(`
      WITH CTE AS (
        SELECT id, role, content, is_bookmarked,
               LAG(content) OVER (PARTITION BY session_id ORDER BY id ASC) as user_prompt
        FROM messages
        WHERE user_id = $1
      )
      SELECT id, user_prompt as prompt, content as response 
      FROM CTE 
      WHERE is_bookmarked = true AND role = 'model'
      ORDER BY id DESC
    `, [req.user.id]);
    
    res.json({ bookmarks: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch bookmarks." });
  }
});

app.post("/bookmarks", authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  
  const { response } = req.body;
  if (!response) return res.status(400).json({ error: "Missing required fields" });

  try {
    // Check if the message is currently bookmarked
    const checkRes = await pool.query(
      "SELECT is_bookmarked FROM messages WHERE user_id = $1 AND role = 'model' AND content = $2 LIMIT 1", 
      [req.user.id, response]
    );
    
    if (checkRes.rows.length > 0) {
      const currentState = checkRes.rows[0].is_bookmarked;
      // Toggle it to the opposite state (true to false, or false to true)
      await pool.query(
        "UPDATE messages SET is_bookmarked = $1 WHERE user_id = $2 AND role = 'model' AND content = $3", 
        [!currentState, req.user.id, response]
      );
      res.json({ success: true, action: currentState ? "removed" : "added" });
    } else {
      res.status(404).json({ error: "Message not found in history." });
    }
  } catch (err) {
    console.error("Bookmark Error:", err);
    res.status(500).json({ error: "Failed to toggle bookmark." });
  }
});

app.post("/chat", authenticateToken, async (req, res) => {
  const { message, sessionId } = req.body;
  const isGuest = !req.user;
  const today = new Date().toISOString().split('T')[0];

  try {
    let currentHistory = [];

    const now = Date.now();
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    
    if (!isGuest) {
      // Check logged-in user limits (NOW FETCHING custom_limit)
      const userRes = await pool.query("SELECT burst_count, last_message_time, custom_limit FROM users WHERE id = $1", [req.user.id]);
      
      if (userRes.rows.length > 0) {
        const userData = userRes.rows[0];
        const lastMessageTime = userData.last_message_time ? new Date(userData.last_message_time).getTime() : 0;
        
        // Use their assigned limit from the admin panel, or default to 5 if blank
        const allowedBurstLimit = userData.custom_limit || 5; 
        
        let currentBurstCount = userData.burst_count || 0;

        // Reset the burst count if 2 hours have passed since their last message
        if (now - lastMessageTime >= TWO_HOURS_MS) {
          currentBurstCount = 0;
        }

        // Check against their dynamic limit, not a hardcoded 5
        if (currentBurstCount >= allowedBurstLimit) {
          const minutesLeft = Math.ceil((TWO_HOURS_MS - (now - lastMessageTime)) / 60000);
          return res.json({ reply: `⚠️ You've sent ${allowedBurstLimit} messages. Please wait ${minutesLeft} minutes to catch your breath before chatting again.` });
        }

        // Increment count and update timestamp
        await pool.query(
          "UPDATE users SET burst_count = $1, last_message_time = CURRENT_TIMESTAMP WHERE id = $2",
          [currentBurstCount + 1, req.user.id]
        );
      }
    } else {
      // Check guest limits (IP based)
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
      
      if (!guestRateLimitMap.has(ip)) {
        guestRateLimitMap.set(ip, { count: 0, lastMessageTime: 0 });
      }
      const guestData = guestRateLimitMap.get(ip);
      
      // Reset guest count if 2 hours have passed
      if (now - guestData.lastMessageTime >= TWO_HOURS_MS) {
        guestData.count = 0;
      }

      if (guestData.count >= 5) {
        const minutesLeft = Math.ceil((TWO_HOURS_MS - (now - guestData.lastMessageTime)) / 60000);
        return res.json({ reply: `⚠️ Guest limit reached. Please wait ${minutesLeft} minutes or Sign Up to continue.` });
      }

      guestData.count += 1;
      guestData.lastMessageTime = now;
    }

    if (!isGuest) {
      const histRes = await pool.query(`
        SELECT role, content FROM (
          SELECT id, role, content FROM messages 
          WHERE user_id = $1 AND session_id = $2 
          ORDER BY id DESC LIMIT 6
        ) subquery ORDER BY id ASC
      `, [req.user.id, sessionId]);
      currentHistory = histRes.rows;
    } else {
      if (!guestMemoryMap.has(sessionId)) guestMemoryMap.set(sessionId, []);
      currentHistory = guestMemoryMap.get(sessionId);
    }

    const botReply = await processCoreAIRequestWithRetry(message, currentHistory);

    if (!isGuest) {
      await pool.query("INSERT INTO messages (user_id, session_id, role, content) VALUES ($1, $2, $3, $4)", [req.user.id, sessionId, "user", message]);
      await pool.query("INSERT INTO messages (user_id, session_id, role, content) VALUES ($1, $2, $3, $4)", [req.user.id, sessionId, "model", botReply]);
      
      // Delete old messages, but NEVER delete ones that are bookmarked
      await pool.query(`
        DELETE FROM messages 
        WHERE id IN (
          SELECT id FROM messages 
          WHERE user_id = $1 AND is_bookmarked = false
          ORDER BY id DESC 
          OFFSET 1000
        )
      `, [req.user.id]);
    } else {
      currentHistory.push({ role: "user", content: message });
      currentHistory.push({ role: "model", content: botReply });
      if (currentHistory.length > 6) currentHistory = currentHistory.slice(-6);
      guestMemoryMap.set(sessionId, currentHistory);
    }

    res.json({ reply: botReply });
  } catch (error) {
    console.error("AI Error:", error);
    res.status(500).json({ reply: "দুঃখিত, অভ্যন্তরীণ প্রক্রিয়াকরণে সমস্যা হয়েছে।" });
  }
});

// --- ADMIN API ---

// 1. Secure Admin Login Route
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign({ role: "admin" }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: "Access Denied" });
  }
});

// 2. Admin Security Middleware
function authenticateAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err || decoded.role !== "admin") return res.status(403).json({ error: "Forbidden" });
    next();
  });
}

// 3. Protected Admin Routes
app.get("/api/settings", authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM settings ORDER BY id DESC LIMIT 1");
    res.json({ systemInstruction: result.rows.length > 0 ? result.rows[0].system_instruction : "" });
  } catch (e) {
    res.status(500).json({ error: "Failed to load settings" });
  }
});

app.post("/api/settings", authenticateAdmin, async (req, res) => {
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

app.post("/api/sync", authenticateAdmin, async (req, res) => {
  if (currentSyncStatus.active) {
    return res.status(429).json({ error: "A sync process is already running in the background." });
  }
  const isForceSync = req.body.force === true;
  currentSyncStatus = { active: true, totalDocChunks: 0, toAdd: 0, toDelete: 0, saved: 0, failed: 0, logs: [], complete: false };
  res.json({ success: true, message: "Sync engine initialized." });
  buildMasterBrain(isForceSync).catch(err => {
    broadcastSyncUpdate(`🔴 Critical Engine Failure: ${err.message}`, "error");
    currentSyncStatus.active = false;
  });
});

app.get("/api/users", authenticateAdmin, async (req, res) => {
  try {
    // UPDATED: Now fetches burst_count instead of daily_chat_count
    const result = await pool.query(`
      SELECT 
        u.id, u.username, u.burst_count, u.custom_limit,
        (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id AND m.role = 'user') as cc_total,
        (SELECT MAX(created_at) FROM messages m WHERE m.user_id = u.id) as last_active
      FROM users u ORDER BY u.id DESC
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load users" });
  }
});

app.post("/api/update-limit", authenticateAdmin, async (req, res) => {
  const { userId, newLimit } = req.body;
  try {
    await pool.query("UPDATE users SET custom_limit = $1 WHERE id = $2", [newLimit, userId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to update limit" });
  }
});

app.post("/api/admin/users/limit-all", authenticateAdmin, async (req, res) => {
  const { newLimit } = req.body;
  try {
    await pool.query("UPDATE users SET custom_limit = $1", [newLimit]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "Update failed" }); }
});

app.get("/api/admin/stats", authenticateAdmin, async (req, res) => {
  try {
    const usersCount = await pool.query("SELECT COUNT(*) FROM users");
    const chunksCount = await pool.query("SELECT COUNT(*) FROM knowledge_chunks");
    const msgsCount = await pool.query("SELECT COUNT(*) FROM messages");
    
    const dbSizeRes = await pool.query("SELECT pg_database_size(current_database()) as bytes");
    const bytes = parseInt(dbSizeRes.rows[0].bytes);
    const mbSize = (bytes / (1024 * 1024)).toFixed(2);

    res.json({
        users: parseInt(usersCount.rows[0].count),
        chunks: parseInt(chunksCount.rows[0].count),
        messages: parseInt(msgsCount.rows[0].count),
        dbSizeMB: parseFloat(mbSize)
    });
  } catch (e) { res.status(500).json({ error: "Stats error" }); }
});

app.post("/api/admin/users/delete", authenticateAdmin, async (req, res) => {
  const { userIds } = req.body;
  try {
    await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [userIds]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "Delete failed" }); }
});

app.post("/api/admin/users/reset", authenticateAdmin, async (req, res) => {
  const { userIds } = req.body;
  try {
    // UPDATED: Resets both burst count and the time lock
    await pool.query("UPDATE users SET burst_count = 0, last_message_time = NULL WHERE id = ANY($1::int[])", [userIds]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "Reset failed" }); }
});

app.post("/api/admin/users/download", authenticateAdmin, async (req, res) => {
  const { userIds } = req.body;
  try {
    const result = await pool.query(`
      SELECT u.username, m.role, m.content, m.created_at 
      FROM messages m JOIN users u ON m.user_id = u.id 
      WHERE m.user_id = ANY($1::int[]) ORDER BY m.user_id, m.id ASC
    `, [userIds]);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: "Download failed" }); }
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
    console.error("❌ Worker Technical Failure Details:");
    console.error(JSON.stringify({
      message: error.message,
      status: error.status,
      errorDetails: error.errorDetails || error.response || null,
      stack: error.stack
    }, null, 2));
    
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


// ==========================================
// --- DISCORD BOT (NATIVE PERSISTENT CHAT) ---
// ==========================================

console.log("🔍 DIAGNOSTIC: Checking for Discord Token...");
if (!process.env.DISCORD_TOKEN) {
    console.log("❌ DIAGNOSTIC FAILED: The server sees DISCORD_TOKEN as BLANK or MISSING.");
} else {
    console.log(`✅ DIAGNOSTIC PASSED: Token found (Starts with: ${process.env.DISCORD_TOKEN.substring(0, 5)}...)`);
}

if (process.env.DISCORD_TOKEN) {
  const discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages
    ]
  });

  // FIXED: The event is 'ready', not 'clientReady'
  discordClient.on('ready', () => {
    console.log(`🤖 Discord Bot connected as: ${discordClient.user.tag}`);
  });

  // NEW: Deep Debugging Trackers - Forces Discord to reveal silent errors
  discordClient.on('error', error => console.error("❌ Discord Client Error:", error));
  discordClient.on('warn', warning => console.warn("⚠️ Discord Client Warning:", warning));
  discordClient.on('debug', info => console.log("🔍 Discord Debug:", info));

  discordClient.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (process.env.DISCORD_CHANNEL_ID && message.channel.id !== process.env.DISCORD_CHANNEL_ID) {
      return; 
    }

    await message.channel.sendTyping();
    
    const typingInterval = setInterval(() => {
        message.channel.sendTyping().catch(console.error);
    }, 9000);

    try {
      const userQuery = message.content.replace(/<@!?\d+>/g, '').trim();
      if (!userQuery) {
          clearInterval(typingInterval);
          return;
      }

      // Context aware Discord chat history
      const fetchedMessages = await message.channel.messages.fetch({ limit: 7 });
      let currentHistory = [];

      fetchedMessages.reverse().forEach(msg => {
          if (msg.id === message.id) return; 
          if (msg.author.id === discordClient.user.id) {
              currentHistory.push({ role: "model", content: msg.content });
          } else if (!msg.author.bot) { 
              currentHistory.push({ role: "user", content: msg.content });
          }
      });

      const botReply = await processCoreAIRequestWithRetry(userQuery, currentHistory);
      const chunks = splitMessage(botReply);

      clearInterval(typingInterval);

      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } catch (error) {
      clearInterval(typingInterval);
      
      console.error("❌ Native Chat Technical Failure Details:");
      console.error(JSON.stringify({
        message: error.message,
        status: error.status,
        errorDetails: error.errorDetails || error.response || null,
        stack: error.stack
      }, null, 2));
      
      let errorMessage = "⚠️ An error occurred while processing your request.";
      if (error.status === 429 || (error.message && error.message.includes("429"))) {
          errorMessage = "⏳ Light Revealed is currently busy. Please wait a few moments and try again.";
      } 
      else if (error.status === 503 || (error.message && error.message.includes("503"))) {
          errorMessage = "🔥 Light Revealed server is currently experiencing high demand. Please try again in a minute.";
      }

      await message.reply(errorMessage);
    }
  });

  discordClient.login(process.env.DISCORD_TOKEN).catch(err => {
    console.error("❌ Discord Bot Login Failed:", err.message);
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✨ LIGHT REVEALED CLOUD ENGINE OPERATIONAL ON PORT ${PORT} ✨`);
});

module.exports = app;
