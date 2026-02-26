require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");

const { uploadFileToDrive } = require("./drive"); // 👈 สำคัญ

const config = {
  channelSecret: process.env.CHANNEL_SECRET,
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
};

const app = express();
const path = require("path");
const fs = require("fs");
const line = require("@line/bot-sdk");
const { uploadFileToDrive } = require("./drive");

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

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    const client = new line.Client(config);

    for (const event of events) {
      if (event.type !== "message") continue;

      const msg = event.message;
      const receivedAt = new Date(); // ใช้เวลาที่บอทได้รับ

      // ---------- FILE (PDF) ----------
      if (msg.type === "file") {
        const stream = await client.getMessageContent(msg.id);

        fs.mkdirSync("downloads", { recursive: true });
        const savePath = path.join("downloads", msg.fileName);
        const ws = fs.createWriteStream(savePath);

        await new Promise((resolve, reject) => {
          stream.pipe(ws);
          stream.on("error", reject);
          ws.on("finish", resolve);
          ws.on("error", reject);
        });

        const uploaded = await uploadFileToDrive(savePath, msg.fileName, receivedAt);
        console.log("uploaded:", uploaded?.webViewLink);

        continue;
      }

      // ---------- IMAGE (expense) ----------
      if (msg.type === "image") {
        const stream = await client.getMessageContent(msg.id);

        // เดาจาก content-type เพื่อเลือกนามสกุล
        const contentType = stream.headers?.["content-type"] || "";
        const ext = contentType.includes("png") ? ".png" : ".jpg";

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
