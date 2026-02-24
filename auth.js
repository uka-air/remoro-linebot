// auth.js
require("dotenv").config();
const fs = require("fs");
const { google } = require("googleapis");
const { authenticate } = require("@google-cloud/local-auth");

const SCOPES = ["https://www.googleapis.com/auth/drive"];
const TOKEN_PATH = process.env.OAUTH_TOKEN_PATH || "./token.json";
const CREDENTIALS_PATH = process.env.OAUTH_CLIENT_SECRET_PATH || "./credentials.json";

async function getAuthClient() {
  // ถ้ามี token แล้ว ใช้เลย (ไม่เด้ง browser ไม่ต้องทำ manual)
  if (fs.existsSync(TOKEN_PATH)) {
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
    const info = creds.installed || creds.web;
    const oAuth2Client = new google.auth.OAuth2(
      info.client_id,
      info.client_secret,
      info.redirect_uris?.[0]
    );

    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
  }

  // ครั้งแรกเท่านั้น: เด้ง browser ให้กด Allow แล้วจะได้ token
  const client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });

  fs.writeFileSync(TOKEN_PATH, JSON.stringify(client.credentials, null, 2));
  console.log("Token stored to:", TOKEN_PATH);
  return client;
}

module.exports = { getAuthClient };
