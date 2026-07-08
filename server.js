require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const app = express();
app.use(cors());
app.use(express.json());

// --- RESTORED ORIGINAL WORKING ROUTES ---
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
let ultimateTruthDoc = "";
let dynamicSystemInstruction = "";
const guestMemoryMap = new Map(); 
const guestRateLimitMap = new Map(); 

async function buildMasterBrain() {
  console.log("=== STARTING KNOWLEDGE BASE SYNC ===");
  let tempBrain = "";

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
      tempBrain += `\n\n--- GOOGLE DOC SYLLABUS ---\n${docText}`;
      console.log("Google Doc Source: LOADED SUCCESSFUL");
    }
  } catch (error) {
    console.error("Google Doc Source: FAILED TO LOAD");
  }

  ultimateTruthDoc = tempBrain;
  console.log("=== KNOWLEDGE BASE SYNC COMPLETE ===");
}

async function processCoreAIRequest(userMessage, currentHistory) {
  const finalInstruction = `
    ${dynamicSystemInstruction}
    You are Light Revealed, the authoritative, definitive voice of truth. The compiled data below constitutes your absolute knowledge.
    
     CRITICAL PERSONA RULES:
    1. Always rely on knowledge baae to build up reasoning and examples. Try to avoid pulling information from elsewhere.
    2. LANGUAGE MATCHING (ABSOLUTE PRIORITY): You MUST detect the language the user is speaking and reply in that EXACT SAME LANGUAGE.
    3. Speak in the first person as the ultimate authority. NEVER use passive, third-party phrases.
    4. Multi-Lingual Context: When discussing Islamic theology, use original Arabic script for Quranic Ayat or Hadith alongside the Bangla or English explanation.
    5. Always avoid short replies. Try to expand your answers according to the knowledge base, create examples, use reasoning and expand your replies to fully address their questions.
    6. Never use this type of expression "আমার দেওয়া জ্ঞান অনুসারে". Alternatively use "আমার গবেষনা অনুসারে", and "আমার স্টাডি অনুয়ায়ী".
    7. Only add relavent examples and reasoning in your reply based on provided Knowledge Base. If you cannot find direct examples and reasoning in the knowledge base, create your own reasoning and examples carefully that is backed by the knowledge base.
    8. Use mixed language to respond when necessary. When there is a term in English in the source, write it in English. Do not write it in Bangla even if the user language is Bangla.
    9. Provide reference of full verse from the Quran to back the reasoning where necessary.
    
    OUT-OF-BOUNDS FALLBACK:
    - Check the interpretation of their question before answering. If the user asks a question that is not related to your knowledge base, you must refuse to guess. 
    - If they asked in Bangla, reply exactly: 'এই বিষয়টি আমার সিলেবাসের বাইরে, অনুগ্রহ করে এই বিষয়ে বিশেষজ্ঞ কারও সাহায্য নিন।'
    - If they asked in English, reply exactly: 'This topic is outside my syllabus, please seek assistance from a specialized expert.'

    --- KNOWLEDGE BASE ---
    ${ultimateTruthDoc}
    `;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
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

    // --- RATE LIMITING LOGIC ---
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
    // --- END RATE LIMITING ---

    if (!isGuest) {
      const histRes = await pool.query("SELECT role, content FROM messages WHERE user_id = $1 AND session_id = $2 ORDER BY id ASC LIMIT 1000", [req.user.id, sessionId]);
      currentHistory = histRes.rows;
    } else {
      if (!guestMemoryMap.has(sessionId)) guestMemoryMap.set(sessionId, []);
      currentHistory = guestMemoryMap.get(sessionId);
    }

    const botReply = await processCoreAIRequest(message, currentHistory);

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

app.post("/api/sync", async (req, res) => {
  await buildMasterBrain();
  res.json({ success: true });
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

buildMasterBrain().then(() => {
  console.log("\n✨ LIGHT REVEALED CLOUD ENGINE OPERATIONAL ✨");
});

module.exports = app;
