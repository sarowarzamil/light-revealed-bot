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

// --- ADMIN AUTH VAULT ---
function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Basic (.*)$/i);

  if (!match) {
    res.set('WWW-Authenticate', 'Basic realm="Admin Control Panel"');
    return res.status(401).send('Access Denied: Authentication required.');
  }

  const [username, password] = Buffer.from(match[1], 'base64').toString().split(':');

  // Checks the password against your Vercel Environment Variable
  if (username === 'admin' && password === process.env.ADMIN_PASSWORD) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Admin Control Panel"');
  return res.status(401).send('Access Denied: Invalid credentials.');
}

// 1. Protect the HTML Page (Notice we removed 'public' from the path!)
app.get('/admin.html', adminAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// --- SUPABASE CLOUD DATABASE SETUP ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Required for secure cloud connections
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

async function buildMasterBrain() {
  console.log("=== STARTING KNOWLEDGE BASE SYNC ===");
  let tempBrain = "";

  // 1. Fetch live settings and instructions from Supabase
  try {
    const result = await pool.query(
      "SELECT * FROM settings ORDER BY id DESC LIMIT 1",
    );
    if (result.rows.length > 0) {
      dynamicSystemInstruction = result.rows[0].system_instruction;
      console.log("Cloud Settings: LOADED");
    }
  } catch (err) {
    console.error("Cloud Settings Error:", err.message);
  }

  // 2. Fetch Google Doc Syllabus
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
  // Combine the admin's custom instructions with the strict knowledge base rules
  const finalInstruction = `
    ${dynamicSystemInstruction}
    You are Light Revealed, the authoritative, definitive voice of truth. The compiled data below constitutes your absolute knowledge.
    
     CRITICAL PERSONA RULES:
    1. LANGUAGE MATCHING (ABSOLUTE PRIORITY): You MUST detect the language the user is speaking and reply in that EXACT SAME LANGUAGE. If the user asks in English, you must translate the facts from your Bangla knowledge base and reply completely in English. If they ask in Bangla, reply in Bangla.
    2. Speak in the first person as the ultimate authority. NEVER use passive, third-party phrases like "প্রদত্ত উৎস অনুযায়ী" (According to the source) or "উৎসে বলা হয়েছে" (The source says) or "উৎসে দেখানো হয়েছে" (The source illustrated) or "উৎসে প্রমান করা হয়েছে" (The source proved) or anything similar to this. State the facts directly as your own indisputable knowledge.
    3. Multi-Lingual Context: When discussing Islamic theology, use original Arabic script for Quranic Ayat or Hadith alongside the Bangla or English explanation. Seamlessly weave English terminology into Bangla explanations if it clarifies the concept.
    4. Always avoid short replies. Understand their question deeply, build up your reasoning and references according the ultimate truth you've been given.
    5. Never use this type of expression "আমার দেওয়া জ্ঞান অনুসারে". Alternatively use "আমার জ্ঞান অনুযায়ী", or "আমার গবেষনা অনুসারে".
    
    OUT-OF-BOUNDS FALLBACK:
    If the user asks a question outside your knowledge base, you must refuse to guess. 
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

// --- AUTHENTICATION ROUTES (PostgreSQL Updated) ---
app.post("/signup", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "Username and password required." });

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id",
      [username, hashedPassword],
    );
    const token = jwt.sign(
      { id: result.rows[0].id, username },
      process.env.JWT_SECRET,
    );
    res.json({ token, username });
  } catch (error) {
    res.status(400).json({ error: "Username already exists or server error." });
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [
      username,
    ]);
    const user = result.rows[0];
    if (!user) return res.status(400).json({ error: "Invalid credentials." });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: "Invalid credentials." });

    const token = jwt.sign(
      { id: user.id, username: user.username },
      process.env.JWT_SECRET,
    );
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

// --- CHAT & SESSION ROUTES (PostgreSQL Updated) ---
app.get("/sessions", authenticateToken, async (req, res) => {
  if (!req.user) return res.json({ sessions: [] });
  try {
    const result = await pool.query(
      `
            SELECT * FROM (
                SELECT DISTINCT ON (session_id) session_id, content AS title, id
                FROM messages
                WHERE user_id = $1 AND role = 'user'
                ORDER BY session_id, id ASC
            ) t ORDER BY id DESC
        `,
      [req.user.id],
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
      [req.user.id, req.params.sessionId],
    );
    res.json({ history: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch history." });
  }
});

app.post("/chat", authenticateToken, async (req, res) => {
  const { message, sessionId } = req.body;
  const isGuest = !req.user;

  try {
    let currentHistory = [];

    if (!isGuest) {
      const histRes = await pool.query(
        "SELECT role, content FROM messages WHERE user_id = $1 AND session_id = $2 ORDER BY id ASC LIMIT 1000",
        [req.user.id, sessionId],
      );
      currentHistory = histRes.rows;
    } else {
      if (!guestMemoryMap.has(sessionId)) guestMemoryMap.set(sessionId, []);
      currentHistory = guestMemoryMap.get(sessionId);
    }

    const botReply = await processCoreAIRequest(message, currentHistory);

    if (!isGuest) {
      await pool.query(
        "INSERT INTO messages (user_id, session_id, role, content) VALUES ($1, $2, $3, $4)",
        [req.user.id, sessionId, "user", message],
      );
      await pool.query(
        "INSERT INTO messages (user_id, session_id, role, content) VALUES ($1, $2, $3, $4)",
        [req.user.id, sessionId, "model", botReply],
      );
    } else {
      currentHistory.push({ role: "user", content: message });
      currentHistory.push({ role: "model", content: botReply });
      if (currentHistory.length > 2000)
        currentHistory = currentHistory.slice(-2000);
      guestMemoryMap.set(sessionId, currentHistory);
    }

    res.json({ reply: botReply });
  } catch (error) {
    console.error("AI Error:", error);
    res
      .status(500)
      .json({ reply: "দুঃখিত, অভ্যন্তরীণ প্রক্রিয়াকরণে সমস্যা হয়েছে।" });
  }
});

// --- ADMIN API (Cloud Configured) ---
app.get("/api/settings", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM settings ORDER BY id DESC LIMIT 1",
    );
    if (result.rows.length > 0) {
      res.json({ systemInstruction: result.rows[0].system_instruction });
    } else {
      res.json({ systemInstruction: "" });
    }
  } catch (e) {
    res.status(500).json({ error: "Failed to load settings" });
  }
});

app.post("/api/settings", adminAuth, async (req, res) => {
  const { systemInstruction } = req.body;
  try {
    await pool.query(
      `
            INSERT INTO settings (id, system_instruction)
            VALUES (1, $1)
            ON CONFLICT (id) DO UPDATE 
            SET system_instruction = EXCLUDED.system_instruction
        `,
      [systemInstruction],
    );

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to save settings" });
  }
});

app.post("/api/sync", adminAuth, async (req, res) => {
  await buildMasterBrain();
  res.json({ success: true });
});

// --- INITIALIZATION (VERCEL SERVERLESS MODE) ---
// Build the brain immediately when the serverless function spins up
buildMasterBrain().then(() => {
  console.log("\n✨ LIGHT REVEALED CLOUD ENGINE OPERATIONAL ✨");
});

// Export the Express app so Vercel can run it
module.exports = app;
