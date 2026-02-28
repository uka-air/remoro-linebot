const fs = require("fs");

function stripCodeFence(s = "") {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function safeParseJson(raw) {
  try {
    return JSON.parse(stripCodeFence(raw));
  } catch {
    return null;
  }
}

function normalizeExpenseData(data) {
  return {
    date: data?.date ?? null,
    merchant: data?.merchant ?? null,
    totalAmount: data?.totalAmount ?? null,
  };
}

function mimeTypeFromPath(localPath, fallback = "image/jpeg") {
  const lower = localPath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".heif")) return "image/heif";
  return fallback;
}

function shouldRetryWithFallbackModel(status, bodyText = "") {
  return Number(status) === 404 && /no longer available|not available|NOT_FOUND/i.test(bodyText);
}

async function callGemini(model, apiKey, finalMimeType, imageB64, prompt) {
  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: finalMimeType,
                  data: imageB64,
                },
              },
            ],
          },
        ],
      }),
    }
  );
}

async function extractExpenseFromImage(localPath, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("[gemini] skip: GEMINI_API_KEY is missing");
    return {
      status: "skipped",
      reason: "Missing GEMINI_API_KEY",
      data: null,
    };
  }

  const imageB64 = fs.readFileSync(localPath, { encoding: "base64" });
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const finalMimeType = mimeType || mimeTypeFromPath(localPath);

  const prompt = `Read this expense receipt/invoice image and return ONLY JSON with this schema:
{
  "date": "YYYY-MM-DD|null",
  "merchant": "string|null",
  "totalAmount": number|null
}
If a field is not visible, use null.`;

  let currentModel = model;
  let resp = await callGemini(currentModel, apiKey, finalMimeType, imageB64, prompt);

  if (!resp.ok) {
    const body = await resp.text();
    if (shouldRetryWithFallbackModel(resp.status, body) && currentModel !== "gemini-2.5-flash") {
      console.warn(`[gemini] model ${currentModel} unavailable, retrying with gemini-2.5-flash`);
      currentModel = "gemini-2.5-flash";
      resp = await callGemini(currentModel, apiKey, finalMimeType, imageB64, prompt);
    } else {
      console.error("[gemini] request failed:", resp.status);
      return {
        status: "error",
        reason: `Gemini API error: ${resp.status} ${body}`,
        data: null,
      };
    }
  }

  if (!resp.ok) {
    console.error("[gemini] request failed:", resp.status);
    const body = await resp.text();
    return {
      status: "error",
      reason: `Gemini API error: ${resp.status} ${body}`,
      data: null,
    };
  }

  const json = await resp.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const parsed = safeParseJson(text);

  if (!parsed) {
    return {
      status: "error",
      reason: "Could not parse Gemini response as JSON",
      data: null,
      raw: text,
    };
  }

  const normalized = normalizeExpenseData(parsed);

  return {
    status: "ok",
    reason: null,
    data: normalized,
  };
}

module.exports = { extractExpenseFromImage };
