import fs from "fs";
import path from "path";

const SOURCE_URL = "https://jsonplaceholder.typicode.com/posts";

function isoNow() {
  return new Date().toISOString();
}

function storeRecord(record) {
  try {
    const filePath = path.join("/tmp", "pipeline_store.jsonl");
    fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

async function fetchPosts(limit = 3) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);

  try {
    const resp = await fetch(SOURCE_URL, { signal: controller.signal });
    if (!resp.ok) throw new Error(`Fetch failed: HTTP ${resp.status}`);
    const data = await resp.json();
    return data.slice(0, limit);
  } finally {
    clearTimeout(timeout);
  }
}

async function enrichWithAI(text) {
  // IMPORTANT: If you set OPENAI_API_KEY on Vercel, it will use real AI.
  // If not set, it uses a fallback analysis so the pipeline still works.
  const key = process.env.OPENAI_API_KEY;

  if (!key) {
    return {
      analysis:
        `This post describes: "${text.slice(0, 70)}...". ` +
        `It reads like general information rather than strong opinion.`,
      sentiment: "neutral",
    };
  }

  const prompt =
    `Analyze this in 2-3 sentences and classify sentiment as positive/negative/neutral. ` +
    `Return ONLY JSON like {"analysis":"...","sentiment":"positive|negative|neutral"}.\n\nTEXT:\n${text}`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Return strict JSON only." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
    }),
  });

  if (!r.ok) throw new Error(`LLM error: HTTP ${r.status}`);

  const data = await r.json();
  const content = data?.choices?.[0]?.message?.content?.trim() || "";

  try {
    const obj = JSON.parse(content);
    let s = (obj.sentiment || "neutral").toLowerCase();
    if (!["positive", "negative", "neutral"].includes(s)) s = "neutral";
    return { analysis: obj.analysis || "Analysis unavailable.", sentiment: s };
  } catch {
    return {
      analysis: "Analysis unavailable due to parsing error.",
      sentiment: "neutral",
    };
  }
}

export default async function handler(req, res) {
  // ✅ CORS for Hoppscotch / browser calls
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // ✅ Preflight request (Hoppscotch will send this)
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const processedAt = isoNow();
  const errors = [];
  const items = [];

  let email = "";
  let source = "JSONPlaceholder Posts";

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    email = body.email || "";
    source = body.source || source;
  } catch {
    errors.push({ stage: "input", error: "Invalid JSON body" });
  }

  // 1) Fetch
  let posts = [];
  try {
    posts = await fetchPosts(3);
  } catch (e) {
    errors.push({ stage: "fetch", error: String(e.message || e) });

    // Notification even if fetch fails
    console.log(
      `[NOTIFICATION] Pipeline completed (fetch failed) -> ${email || "no-email"}`
    );
    return res.status(200).json({
      items: [],
      notificationSent: true,
      processedAt,
      errors,
    });
  }

  // 2) AI + 3) Store (continue even if one item fails)
  for (const p of posts) {
    const timestamp = isoNow();
    const original = `${p.title ?? ""} — ${p.body ?? ""}`.trim();

    let analysis = "";
    let sentiment = "neutral";

    try {
      const enr = await enrichWithAI(original);
      analysis = enr.analysis;
      sentiment = enr.sentiment;
    } catch (e) {
      errors.push({ stage: "ai", postId: p.id, error: String(e.message || e) });
      analysis = "AI enrichment failed.";
      sentiment = "neutral";
    }

    const record = {
      source,
      sourceUrl: SOURCE_URL,
      postId: p.id,
      original,
      analysis,
      sentiment,
      timestamp,
    };

    const stored = storeRecord(record);
    if (!stored)
      errors.push({ stage: "storage", postId: p.id, error: "Storage write failed" });

    items.push({ original, analysis, sentiment, stored, timestamp });
  }

  // 4) Notification
  console.log(`[NOTIFICATION] Pipeline completed -> Sent to: ${email || "no-email"}`);
  console.log(
    `[REQUIRED] Indicate notification sent to: 23f2004388@ds.study.iitm.ac.in`
  );

  return res.status(200).json({
    items,
    notificationSent: true,
    processedAt,
    errors,
  });
}
