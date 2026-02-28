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
  listMonthlyExpenseImages,
  downloadDriveFile,
  appendExpenseTotalRow,
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


function mimeTypeFromExtension(ext = "") {
  if (ext === ".png") return "image/png";
  if (ext === ".heic") return "image/heic";
  if (ext === ".heif") return "image/heif";
  return "image/jpeg";
}


function extFromMimeType(mimeType = "") {
  if (mimeType.includes("png")) return ".png";
  if (mimeType.includes("heic")) return ".heic";
  if (mimeType.includes("heif")) return ".heif";
  return ".jpg";
}


function isGeminiMissing(parsedExpense) {
  return parsedExpense?.status === "skipped" && /GEMINI_API_KEY/i.test(parsedExpense?.reason || "");
}

async function safeExtractExpenseFromImage(savePath, mimeType) {
  try {
    const result = await extractExpenseFromImage(savePath, mimeType);
    return result;
  } catch (err) {
    console.error("expense parse failed:", err?.message || err);
    return {
      status: "error",
      reason: `Parse failed: ${err?.message || "unknown error"}`,
      data: null,
    };
  }
}

async function convertImageToJpg(sourcePath) {
  let sharp;
  try {
    // optional dependency in environments where image conversion is enabled
    sharp = require("sharp");
  } catch (err) {
    console.warn("sharp is not installed, skip jpg conversion:", err?.message || err);
    return sourcePath;
  }

  const parsed = path.parse(sourcePath);
  const sourceExt = parsed.ext.toLowerCase();
  if (sourceExt === ".jpg") {
    return sourcePath;
  }

  const jpgPath = path.join(parsed.dir, `${parsed.name}.jpg`);

  await sharp(sourcePath)
    .jpeg({ quality: 90 })
    .toFile(jpgPath);

  if (jpgPath !== sourcePath && fs.existsSync(sourcePath)) {
    fs.unlinkSync(sourcePath);
  }

  return jpgPath;
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
          console.log("manual report command received");

          const files = await listMonthlyExpenseImages(receivedAt);
          console.log(`found ${files.length} expense images in Drive month folder`);

          let processed = 0;
          let skippedMissingGemini = 0;
          let totalAmount = 0;
          for (const file of files) {
            const ext = extFromMimeType(file.mimeType || "");
            const savePath = path.join("downloads", `drive_${file.id}${ext}`);
            fs.mkdirSync("downloads", { recursive: true });

            await downloadDriveFile(file.id, savePath);
            const parsedExpense = await safeExtractExpenseFromImage(savePath, file.mimeType || mimeTypeFromExtension(ext));

            if (isGeminiMissing(parsedExpense)) {
              skippedMissingGemini += 1;
              console.warn("skip row append due to missing GEMINI_API_KEY for", file.name);
              continue;
            }

            await appendExpenseReportRow(receivedAt, { name: file.name, webViewLink: file.webViewLink }, parsedExpense);
            console.log("expense row payload:", parsedExpense?.data, "from", file.name);
            const amount = Number(parsedExpense?.data?.totalAmount);
            if (Number.isFinite(amount)) totalAmount += amount;
            processed += 1;
          }

          if (processed > 0) {
            await appendExpenseTotalRow(receivedAt, totalAmount);
            console.log("expense total row appended:", totalAmount);
          }

          await client.replyMessage(event.replyToken, {
            type: "text",
            text: `Done. Expense report sheet is ready for ${receivedAt.getFullYear()}_${pad2(receivedAt.getMonth() + 1)} (sheet id: ${report.spreadsheetId}). Processed ${processed} image(s). Total ${totalAmount}.${skippedMissingGemini ? ` Skipped ${skippedMissingGemini} image(s): missing GEMINI_API_KEY.` : ""}`,
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

        let uploadPath = savePath;
        let uploadName = originalName;

        if (isImageFile) {
          uploadPath = await convertImageToJpg(savePath);
          uploadName = path.extname(uploadPath).toLowerCase() === ".jpg"
            ? `${path.parse(originalName).name}.jpg`
            : originalName;
        }

        const uploaded = await uploadFileToDrive(
          uploadPath,
          uploadName,
          receivedAt,
          isImageFile ? { category: "expense" } : {}
        );

        if (isImageFile && uploaded) {
          const parsedExpense = await safeExtractExpenseFromImage(savePath, mimeTypeFromExtension(ext));
          if (isGeminiMissing(parsedExpense)) {
            console.warn("skip row append: GEMINI_API_KEY is missing");
          } else try {
            const report = await appendExpenseReportRow(receivedAt, uploaded, parsedExpense);
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

        const jpgPath = await convertImageToJpg(savePath);
        const jpgName = path.extname(jpgPath).toLowerCase() === ".jpg"
          ? `${path.parse(fileName).name}.jpg`
          : fileName;

        // ส่ง flag ว่าเป็น expense
        const uploaded = await uploadFileToDrive(savePath, fileName, receivedAt, { category: "expense" });

        if (uploaded) {
          const parsedExpense = await safeExtractExpenseFromImage(savePath, mimeTypeFromExtension(ext));
          if (isGeminiMissing(parsedExpense)) {
            console.warn("skip row append: GEMINI_API_KEY is missing");
          } else try {
            const report = await appendExpenseReportRow(receivedAt, uploaded, parsedExpense);
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
