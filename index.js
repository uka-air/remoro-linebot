require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");

const { uploadFileToDrive } = require("./drive"); // 👈 สำคัญ
const { extractExpenseFromImage } = require("./image-reader");
const {
  appendExpenseReportRow,
  ensureMonthlyExpenseSheet,
  isSheetsApiDisabledError,
} = require("./sheets");

const config = {
  channelSecret: process.env.CHANNEL_SECRET,
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
};

const app = express();

function pad2(n) { return String(n).padStart(2, "0"); }

function makeImageName(receivedAt, messageId, ext) {
  const yyyy = receivedAt.getFullYear();
  const mm = pad2(receivedAt.getMonth() + 1);
  const dd = pad2(receivedAt.getDate());
  const hh = pad2(receivedAt.getHours());
  const mi = pad2(receivedAt.getMinutes());
  const ss = pad2(receivedAt.getSeconds());
  return `${yyyy}-${mm}-${dd}_${hh}${mi}${ss}_${messageId}${ext}`;
}

function extFromContentType(contentType = "") {
  if (contentType.includes("heic")) return ".heic";
  if (contentType.includes("heif")) return ".heif";
  if (contentType.includes("png")) return ".png";
  return ".jpg";
}

function isCreateExpenseSheetCommand(text = "") {
  const normalized = text.trim().toLowerCase();
  return [
    "create expense report",
    "make expense report",
    "create google sheet",
  ].includes(normalized);
}


function buildSheetsSetupMessage(err) {
  const base = "Google Sheets API is not enabled yet for this project.";
  const url = err?.enableUrl;
  if (url) return `${base} Enable it here, wait a few minutes, then try again: ${url}`;
  return `${base} Please enable Sheets API in Google Cloud Console, wait a few minutes, then try again.`;
}


async function safeExtractExpenseFromImage(savePath) {
  try {
    return await extractExpenseFromImage(savePath);
  } catch (err) {
    console.error("expense parse failed:", err?.message || err);
    return {
      status: "error",
      reason: `Parse failed: ${err?.message || "unknown error"}`,
      data: null,
    };
  }
}

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    const client = new line.Client(config);

    for (const event of events) {
      if (event.type !== "message") continue;

      const msg = event.message;
      const receivedAt = new Date(); // ใช้เวลาที่บอทได้รับ

      // ---------- TEXT (create monthly expense sheet) ----------
      if (msg.type === "text" && isCreateExpenseSheetCommand(msg.text || "")) {
        try {
          const report = await ensureMonthlyExpenseSheet(receivedAt);
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: `Done. Expense report sheet is ready for ${receivedAt.getFullYear()}_${pad2(receivedAt.getMonth() + 1)} (sheet id: ${report.spreadsheetId})`,
          });
        } catch (err) {
          if (isSheetsApiDisabledError(err)) {
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: buildSheetsSetupMessage(err),
            });
            console.warn("Sheets API disabled:", err?.originalMessage || err?.message);
          } else {
            throw err;
          }
        }
        continue;
      }

      // ---------- FILE (PDF) ----------
      if (msg.type === "file") {
        const stream = await client.getMessageContent(msg.id);
        const originalName = msg.fileName || `file_${msg.id}`;
        const ext = path.extname(originalName).toLowerCase();
        const isImageFile = [".jpg", ".jpeg", ".png", ".heic", ".heif"].includes(ext);

        fs.mkdirSync("downloads", { recursive: true });
        const savePath = path.join("downloads", originalName);
        const ws = fs.createWriteStream(savePath);

        await new Promise((resolve, reject) => {
          stream.pipe(ws);
          stream.on("error", reject);
          ws.on("finish", resolve);
          ws.on("error", reject);
        });

        const uploaded = await uploadFileToDrive(
          savePath,
          originalName,
          receivedAt,
          isImageFile ? { category: "expense" } : {}
        );
        console.log("uploaded:", uploaded?.webViewLink);

        if (isImageFile && uploaded) {
          const parsedExpense = await safeExtractExpenseFromImage(savePath);
          try {
            const report = await appendExpenseReportRow(receivedAt, uploaded, parsedExpense);
            console.log("expense report updated:", report?.spreadsheetId);
          } catch (err) {
            if (isSheetsApiDisabledError(err)) {
              console.warn("Sheets API disabled. Skip expense report row for now:", err?.originalMessage || err?.message);
            } else {
              throw err;
            }
          }
        }

        continue;
      }

      // ---------- IMAGE (expense) ----------
      if (msg.type === "image") {
        const stream = await client.getMessageContent(msg.id);

        // เดาจาก content-type เพื่อเลือกนามสกุล
        const contentType = stream.headers?.["content-type"] || "";
        const ext = extFromContentType(contentType);

        const fileName = makeImageName(receivedAt, msg.id, ext);

        fs.mkdirSync("downloads", { recursive: true });
        const savePath = path.join("downloads", fileName);
        const ws = fs.createWriteStream(savePath);

        await new Promise((resolve, reject) => {
          stream.pipe(ws);
          stream.on("error", reject);
          ws.on("finish", resolve);
          ws.on("error", reject);
        });

        // ส่ง flag ว่าเป็น expense
        const uploaded = await uploadFileToDrive(savePath, fileName, receivedAt, { category: "expense" });
        console.log("uploaded image:", uploaded?.webViewLink);

        if (uploaded) {
          const parsedExpense = await safeExtractExpenseFromImage(savePath);
          try {
            const report = await appendExpenseReportRow(receivedAt, uploaded, parsedExpense);
            console.log("expense report updated:", report?.spreadsheetId);
          } catch (err) {
            if (isSheetsApiDisabledError(err)) {
              console.warn("Sheets API disabled. Skip expense report row for now:", err?.originalMessage || err?.message);
            } else {
              throw err;
            }
          }
        }

        continue;
      }
    }

    res.status(200).end();
  } catch (err) {
    console.error("ERROR:", err);
    res.status(500).end();
  }
});


app.listen(process.env.PORT || 3000, () =>
  console.log("listening on", process.env.PORT || 3000)
);
