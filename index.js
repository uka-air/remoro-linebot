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

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    const client = new line.Client(config);

    for (const event of events) {
      if (event.type !== "message") continue;
      if (event.message.type !== "file") continue;

      const msg = event.message;

      console.log("file:", msg.fileName);

      // ดาวน์โหลดไฟล์จาก LINE
      const stream = await client.getMessageContent(msg.id);

      fs.mkdirSync("downloads", { recursive: true });
      const savePath = path.join("downloads", msg.fileName);
      const writeStream = fs.createWriteStream(savePath);

      await new Promise((resolve, reject) => {
        stream.pipe(writeStream);
        stream.on("error", reject);
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
      });

      console.log("saved local:", savePath);

      // 👇 อัปโหลดขึ้น Google Drive
      const uploaded = await uploadFileToDrive(savePath, msg.fileName, new Date());
      console.log("uploaded to drive:", uploaded.webViewLink);

      // ตอบกลับใน LINE
      if (event.replyToken) {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: `อัปโหลดเรียบร้อย ✅`,
        });
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
