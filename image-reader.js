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

async function extractExpenseFromImage(localPath) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      status: "skipped",
      reason: "Missing GEMINI_API_KEY",
      data: null,
    };
  }

  const imageB64 = fs.readFileSync(localPath, { encoding: "base64" });
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";

  const prompt = `Read this expense receipt/invoice image and return ONLY JSON with this schema:
{
  "documentType": "receipt|invoice|unknown",
  "merchant": "string|null",
  "date": "YYYY-MM-DD|null",
  "totalAmount": number|null,
  "currency": "THB|USD|...|null",
  "taxAmount": number|null,
  "summary": "short string"
}
If a field is not visible, use null.`;

  const resp = await fetch(
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
                  mimeType: "image/jpeg",
                  data: imageB64,
                },
              },
            ],
          },
        ],
      }),
    }
  );

  if (!resp.ok) {
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

  return {
    status: "ok",
    reason: null,
    data: parsed,
  };
}

module.exports = { extractExpenseFromImage };
