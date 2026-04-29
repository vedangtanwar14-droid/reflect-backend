import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Groq from "groq-sdk";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── SYSTEM PROMPT (this is where it goes) ────────────────────────────────────
const systemPrompt = `You are a daily journaling assistant for the app "Reflect".
Your job is to give honest, perceptive feedback on someone's journal entry.

Respond in 2-3 sentences minimum. Never give a one-liner.
Be direct and observational — not cheerleading, not therapy.
Match the tone to the mode:
- Easy: warm but honest, like a thoughtful friend
- Hard: direct, slightly challenging, no softening
- Extreme: blunt, no comfort, pattern-focused

At the end of your response, on a new line, add a MOOD tag like this:
MOOD:happy or MOOD:sad or MOOD:anxious or MOOD:motivated or MOOD:tired or MOOD:proud

Only output the response text + MOOD tag. No extra formatting.`;

// ─── GIPHY HELPER ─────────────────────────────────────────────────────────────
async function getGif(mood) {
  try {
    const queries = {
      happy:     "celebration success",
      sad:       "its okay sad",
      anxious:   "anxiety stress",
      motivated: "lets go motivation",
      tired:     "tired exhausted",
      proud:     "proud achievement",
      neutral:   "reflection thinking"
    };

    const query = queries[mood] || "reflection thinking";

    const res = await fetch(
      `https://api.giphy.com/v1/gifs/search?api_key=${process.env.GIPHY_API_KEY}&q=${encodeURIComponent(query)}&limit=10&rating=g`
    );
    const data = await res.json();
    const results = data.data;
    if (!results || results.length === 0) return null;
    const pick = results[Math.floor(Math.random() * results.length)];
    return pick.images.fixed_height.url;
  } catch (e) {
    console.error("Giphy error:", e);
    return null;
  }
}

// ─── AI REACTION ENDPOINT ─────────────────────────────────────────────────────
app.post("/ai", async (req, res) => {
  const { text, mode, lang } = req.body;

  if (!text) return res.status(400).json({ reply: null, gif: null });

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Mode: ${mode || "easy"}\nLanguage: ${lang || "en"}\n\nJournal entry:\n${text}` }
      ],
      max_tokens: 300
    });

    let raw = completion.choices[0].message.content.trim();

    // Extract MOOD tag
    let mood = "neutral";
    let moodMatch = raw.match(/MOOD:(\w+)/i);
    if (moodMatch) {
      mood = moodMatch[1].toLowerCase();
      raw = raw.replace(/MOOD:\w+/i, "").trim();
    }

    // Get gif based on mood
    let gif = await getGif(mood);

    res.json({ reply: raw, gif, mood });
  } catch (err) {
    console.error("AI error:", err);
    res.status(500).json({ reply: null, gif: null });
  }
});

// ─── TRANSLATION ENDPOINT ─────────────────────────────────────────────────────
app.post("/translate", async (req, res) => {
  const { lang, baseText } = req.body;

  if (!lang || !baseText) return res.status(400).json({ error: "Missing lang or baseText" });

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user",
        content: `Translate this JSON object to ${lang}. IMPORTANT: Return ONLY valid JSON that can be parsed. Keep all keys exactly the same, only translate the values. No markdown, no code blocks, no explanation.\n${JSON.stringify(baseText)}`
      }],
      max_tokens: 4000
    });

    const raw = completion.choices[0].message.content.trim();
    // Remove markdown code blocks if present
    let clean = raw.replace(/^```json\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    // Extract JSON safely
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start === -1 || end === -1) {
      console.error("JSON extraction failed. Raw response:", raw);
      throw new Error("No JSON found in response");
    }
    clean = clean.substring(start, end + 1);
    const translated = JSON.parse(clean);
    res.json({ translated });
  } catch (err) {
    console.error("Translation error:", err);
    res.status(500).json({ error: "Translation failed" });
  }
});

// ─── SINGLE TEXT TRANSLATION ENDPOINT ──────────────────────────────────────────
app.post("/translate-text", async (req, res) => {
  const { text, lang } = req.body;

  if (!text || !lang) {
    return res.json({ translated: text || "" });
  }

  if (lang === "en") {
    return res.json({ translated: text });
  }

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user",
        content: `Translate this text to ${lang}. Return ONLY the translated text, nothing else:\n\n${text}`
      }],
      max_tokens: 500
    });

    const translated = completion.choices[0].message.content.trim();
    res.json({ translated });
  } catch (err) {
    console.error("Text translation error:", err);
    res.json({ translated: text });
  }
});

// ─── BATCH TEXT TRANSLATION ENDPOINT ───────────────────────────────────────────
app.post("/translate-batch", async (req, res) => {
  const { texts, lang } = req.body;

  if (!texts || !Array.isArray(texts) || !lang) {
    return res.json({ translated: texts || [] });
  }

  if (lang === "en") {
    return res.json({ translated: texts });
  }

  try {
    // Split texts into chunks for efficiency (max 10 per request)
    const chunk = texts.slice(0, 10);
    const textList = chunk.map((t, i) => `${i + 1}. ${t}`).join("\n");

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user",
        content: `Translate these texts to ${lang}. Return ONLY the translated list in the same format, numbered 1-${chunk.length}:\n\n${textList}`
      }],
      max_tokens: 1000
    });

    const raw = completion.choices[0].message.content.trim();
    const lines = raw.split("\n").filter(line => line.trim());
    const translated = lines.map(line => line.replace(/^\d+\.\s*/, ""));

    res.json({ translated });
  } catch (err) {
    console.error("Batch translation error:", err);
    res.json({ translated: texts });
  }
});

// ─── NOTIFICATION MESSAGE ENDPOINT ───────────────────────────────────────────
app.post("/notify-message", async (req, res) => {
  const { type, mode, entryCount, streak } = req.body;

  const prompt = type === "morning"
    ? `You are Reflect, a daily journaling app. Write a single short morning message (1-2 sentences max) for someone on ${mode} mode with ${entryCount} journal entries and a ${streak}-day streak. Be direct, not cheesy. No emojis. Vary the tone — sometimes philosophical, sometimes blunt, sometimes quiet.`
    : `You are Reflect, a daily journaling app. Write a single short evening reminder to log today's reflection (1-2 sentences max) for someone on ${mode} mode. They ${entryCount > 0 ? "have been journaling" : "are new"}. Be direct. No emojis. Don't be generic.`;

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 80
    });
    res.json({ message: completion.choices[0].message.content.trim() });
  } catch (err) {
    console.error("Notify error:", err);
    res.json({ message: null });
  }
});

// ─── DAILY QUESTIONS ENDPOINT ─────────────────────────────────────────────────
app.post("/daily-questions", async (req, res) => {
  const { mode, lang, prevEntries } = req.body;

  const langNames = {
    en: "English", es: "Spanish", fr: "French", de: "German", pt: "Portuguese",
    hi: "Hindi", ar: "Arabic", zh: "Chinese", ja: "Japanese", ko: "Korean",
    ru: "Russian", it: "Italian", tr: "Turkish", id: "Indonesian",
    bn: "Bengali", sw: "Swahili", nl: "Dutch", pl: "Polish", vi: "Vietnamese", th: "Thai"
  };

  const langName = langNames[lang] || "English";
  const modeDesc = mode === "hard" ? "direct, challenging" : mode === "extreme" ? "blunt, no excuses" : "gentle, warm";

  const prompt = `You are generating daily journal reflection questions for a self-accountability app called Reflect.

Mode: ${mode} (${modeDesc})
Language: ${langName}
Date: ${new Date().toDateString()}

${prevEntries && prevEntries.length > 0 ? `Recent entries context (to AVOID repeating same themes):\n${prevEntries.map(e => `- ${e.date}: ${e.summary}`).join("\n")}` : "First time user."}

Generate exactly 4 journal questions. Rules:
1. Keep the same 4 THEMES in this exact order:
   Q1: About what happened/events today
   Q2: About avoidance/effort/discipline  
   Q3: About mood/emotions/mental state
   Q4: An observation/pattern/insight
2. VARY the phrasing every day — never repeat the same question from recent entries
3. Match the difficulty mode (${mode})
4. Write in ${langName}
5. Questions should be concise (under 12 words each)
6. Return ONLY a JSON array of 4 strings, nothing else. Example: ["Q1","Q2","Q3","Q4"]`;

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300
    });

    const raw = completion.choices[0].message.content.trim();
    const clean = raw.replace(/```json|```/g, "").trim();
    const startIdx = clean.indexOf("[");
    const endIdx = clean.lastIndexOf("]");
    
    if (startIdx !== -1 && endIdx !== -1) {
      const arr = JSON.parse(clean.substring(startIdx, endIdx + 1));
      if (Array.isArray(arr) && arr.length === 4) {
        return res.json({ questions: arr });
      }
    }
    
    res.status(400).json({ questions: null, error: "Invalid response format" });
  } catch (err) {
    console.error("Daily questions error:", err);
    res.status(500).json({ questions: null, error: "Failed to generate questions" });
  }
});
// ─── CHALLENGES ENDPOINT ──────────────────────────────────────────────────────
// Add this to your server.js before the health check route

const WEEKLY_CHALLENGE_POOL = [
  // Streak
  { id: 'w_streak_3',    title: '3-Day Streak',        desc: 'Journal 3 days in a row this week',         type: 'streak',  target: 3,  reward: 20 },
  { id: 'w_streak_5',    title: '5-Day Grind',          desc: 'Journal 5 days without breaking',           type: 'streak',  target: 5,  reward: 35 },
  { id: 'w_no_skip',     title: 'Skip-Free Week',       desc: 'Complete the week without using a skip',    type: 'no_skip', target: 1,  reward: 25 },
  // Rating
  { id: 'w_rating_7',    title: 'Quality Week',         desc: 'Get a 7+ rating three times this week',     type: 'rating',  target: 3,  reward: 30 },
  { id: 'w_rating_8',    title: 'High Standards',       desc: 'Get an 8+ rating twice this week',          type: 'rating8', target: 2,  reward: 25 },
  { id: 'w_perfect',     title: 'Perfect Score',        desc: 'Get a 10/10 rating once this week',         type: 'rating10',target: 1,  reward: 40 },
  // Volume
  { id: 'w_entries_4',   title: 'Four Days Solid',      desc: 'Log 4 entries this week',                   type: 'entries', target: 4,  reward: 20 },
  { id: 'w_entries_7',   title: 'Full Week',            desc: 'Log all 7 days this week',                  type: 'entries', target: 7,  reward: 50 },
  { id: 'w_novelist',    title: 'Deep Writer',          desc: 'Write 200 chars on all 4 answers once',     type: 'novelist',target: 1,  reward: 30 },
  // Coins
  { id: 'w_coins_30',    title: 'Coin Collector',       desc: 'Earn 30 coins from entries this week',      type: 'coins',   target: 30, reward: 15 },
  { id: 'w_coins_50',    title: 'Stacking Up',          desc: 'Earn 50 coins from entries this week',      type: 'coins',   target: 50, reward: 20 },
  // Consistency
  { id: 'w_comeback',    title: 'Comeback Kid',         desc: 'Journal after missing a day this week',     type: 'comeback',target: 1,  reward: 20 },
  { id: 'w_early_bird',  title: 'Early Bird',           desc: 'Submit 3 entries before noon this week',    type: 'early',   target: 3,  reward: 25 },
];

const MONTHLY_CHALLENGE_POOL = [
  { id: 'm_entries_20',  title: 'Twenty Strong',        desc: 'Log 20 entries this month',                 type: 'entries', target: 20, reward: 100 },
  { id: 'm_entries_28',  title: 'Almost Perfect',       desc: 'Log 28 entries this month',                 type: 'entries', target: 28, reward: 150 },
  { id: 'm_no_skip',     title: 'Skip-Free Month',      desc: 'Complete the month without any skips',      type: 'no_skip', target: 1,  reward: 120 },
  { id: 'm_avg_7',       title: 'Consistent Quality',   desc: 'Maintain a 7+ average rating this month',   type: 'avg',     target: 7,  reward: 130 },
  { id: 'm_streak_14',   title: 'Two Week Streak',      desc: 'Maintain a 14-day streak this month',       type: 'streak',  target: 14, reward: 110 },
  { id: 'm_coins_150',   title: 'Coin Hoarder',         desc: 'Earn 150 coins from entries this month',    type: 'coins',   target: 150,reward: 80  },
  { id: 'm_rating8_10',  title: 'Sharp Mind',           desc: 'Get 8+ rating at least 10 times',           type: 'rating8', target: 10, reward: 120 },
];

app.post("/challenges", async (req, res) => {
  const { mode, lang, stats } = req.body;
  // stats: { weekEntries, weekStreak, weekCoins, weekRating8, weekRating10, weekNovelist, monthEntries, monthAvg, monthCoins, monthRating8, monthNoSkip, monthStreak }

  // Deterministic selection based on week number + month
  const now = new Date();
  const weekNum = Math.floor((now - new Date(now.getFullYear(), 0, 1)) / (7 * 24 * 60 * 60 * 1000));
  const monthNum = now.getMonth() + now.getFullYear() * 12;

  // Pick 3 weekly challenges (rotate based on week number, no repeats)
  const weeklyPicked = [];
  const pool = [...WEEKLY_CHALLENGE_POOL];
  for (let i = 0; i < 3; i++) {
    const idx = (weekNum + i * 4) % pool.length;
    weeklyPicked.push(pool.splice(idx % pool.length, 1)[0]);
  }

  // Pick 1 monthly challenge
  const monthlyPicked = MONTHLY_CHALLENGE_POOL[monthNum % MONTHLY_CHALLENGE_POOL.length];

  // Calculate progress for each challenge
  function getProgress(challenge, stats) {
    switch (challenge.type) {
      case 'entries': return { current: stats?.weekEntries ?? 0, target: challenge.target };
      case 'streak':  return { current: stats?.weekStreak ?? 0,  target: challenge.target };
      case 'no_skip': return { current: stats?.weekNoSkip ? 1 : 0, target: 1 };
      case 'rating':  return { current: stats?.weekRating7 ?? 0, target: challenge.target };
      case 'rating8': return { current: stats?.weekRating8 ?? 0, target: challenge.target };
      case 'rating10':return { current: stats?.weekRating10 ?? 0,target: challenge.target };
      case 'coins':   return { current: stats?.weekCoins ?? 0,   target: challenge.target };
      case 'novelist':return { current: stats?.weekNovelist ?? 0,target: challenge.target };
      case 'comeback':return { current: stats?.weekComeback ? 1 : 0, target: 1 };
      case 'early':   return { current: stats?.weekEarly ?? 0,   target: challenge.target };
      case 'avg':     return { current: stats?.monthAvg ?? 0,    target: challenge.target };
      default:        return { current: 0, target: challenge.target };
    }
  }

  function getMonthlyProgress(challenge, stats) {
    switch (challenge.type) {
      case 'entries': return { current: stats?.monthEntries ?? 0, target: challenge.target };
      case 'no_skip': return { current: stats?.monthNoSkip ? 1 : 0, target: 1 };
      case 'avg':     return { current: Math.min(stats?.monthAvg ?? 0, challenge.target), target: challenge.target };
      case 'streak':  return { current: stats?.monthStreak ?? 0,  target: challenge.target };
      case 'coins':   return { current: stats?.monthCoins ?? 0,   target: challenge.target };
      case 'rating8': return { current: stats?.monthRating8 ?? 0, target: challenge.target };
      default:        return { current: 0, target: challenge.target };
    }
  }

  const weekly = weeklyPicked.map(c => ({
    ...c,
    progress: getProgress(c, stats),
    completed: getProgress(c, stats).current >= c.target,
  }));

  const monthly = {
    ...monthlyPicked,
    progress: getMonthlyProgress(monthlyPicked, stats),
    completed: getMonthlyProgress(monthlyPicked, stats).current >= monthlyPicked.target,
  };

  // Wombi comment based on overall progress
  const completedCount = weekly.filter(c => c.completed).length;
  let wombiPrompt;
  if (completedCount === 3) {
    wombiPrompt = `The user completed all 3 weekly challenges in the Reflect journal app. Write a 2-sentence reaction as Wombi (their journal coach). Mode: ${mode}. Be ${mode === 'Deep' ? 'sharp and push them harder' : mode === 'Balanced' ? 'direct and acknowledging' : 'warm and encouraging'}. No emojis. No generic lines.`;
  } else if (completedCount > 0) {
    wombiPrompt = `The user completed ${completedCount} out of 3 weekly challenges in the Reflect journal app. Write a 2-sentence reaction as Wombi (their journal coach). Mode: ${mode}. Be ${mode === 'Deep' ? 'blunt about what they left unfinished' : mode === 'Balanced' ? 'neutral, note progress and what remains' : 'encouraging but honest'}. No emojis.`;
  } else {
    wombiPrompt = `The user hasn't completed any weekly challenges yet in the Reflect journal app. Write a 2-sentence reaction as Wombi (their journal coach). Mode: ${mode}. Be ${mode === 'Deep' ? 'direct and challenging' : mode === 'Balanced' ? 'matter-of-fact' : 'gentle but motivating'}. No emojis.`;
  }

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: wombiPrompt }],
      max_tokens: 120,
    });
    const wombiComment = completion.choices[0].message.content.trim();
    res.json({ weekly, monthly, wombiComment });
  } catch (err) {
    console.error("Challenges error:", err);
    res.json({ weekly, monthly, wombiComment: null });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── FAVICON ROUTE ────────────────────────────────────────────────────────────
app.get("/favicon.ico", (_req, res) => {
  res.status(204).end();
});

process.on('uncaughtException', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('Port 3000 is busy. Kill the existing process and retry.');
    process.exit(1);
  }
});

app.listen(3000, () => console.log("✦ Reflect server running on http://localhost:3000"));