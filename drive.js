// drive.js (OAuth version - stable)
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const SCOPES = ["https://www.googleapis.com/auth/drive"];
const CREDENTIALS_PATH = process.env.OAUTH_CLIENT_SECRET_PATH || "./credentials.json";
const TOKEN_PATH = process.env.OAUTH_TOKEN_PATH || "./token.json";

// ---------- OAuth helpers ----------
function loadCredentials() {
  const raw = fs.readFileSync(CREDENTIALS_PATH, "utf8");
  const json = JSON.parse(raw);
  // รองรับทั้ง format "installed" และ "web"
  const creds = json.installed || json.web;
  if (!creds) {
    throw new Error("Invalid credentials.json: expected 'installed' or 'web' object");
  }
  return creds;
}

async function authorize() {
  // ถ้ามี token.json แล้ว ใช้เลย
  if (fs.existsSync(TOKEN_PATH)) {
    const creds = loadCredentials();
    const oAuth2Client = new google.auth.OAuth2(
      creds.client_id,
      creds.client_secret,
      (creds.redirect_uris && creds.redirect_uris[0]) || "http://localhost"
    );

    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
  }

  // ถ้ายังไม่มี token.json ให้ทำ flow แบบ "paste code" (ง่ายและชัวร์บน local)
  const creds = loadCredentials();
  const oAuth2Client = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    (creds.redirect_uris && creds.redirect_uris[0]) || "http://localhost"
  );

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.log("\nAuthorize this app by visiting this url:\n", authUrl, "\n");
  console.log("After approval, copy the code from the browser and paste it here.");

  // อ่าน code จาก stdin
  const readline = require("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise((resolve) => rl.question("Enter code: ", resolve));
  rl.close();

  const { tokens } = await oAuth2Client.getToken(code.trim());
  oAuth2Client.setCredentials(tokens);

  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log("Token stored to:", TOKEN_PATH);

  return oAuth2Client;
}

async function getDriveClient() {
  const auth = await authorize();
  return google.drive({ version: "v3", auth });
}

// ---------- Helpers ----------
function pad2(n) {
  return String(n).padStart(2, "0");
}

// 69 -> 2026 (1957 + 69)
function yyToYyyy(yy) {
  const offset = Number(process.env.YEAR_OFFSET || 1957);
  return offset + Number(yy);
}

function monthFolderName(yyyy, mm) {
  return `${yyyy}_${pad2(mm)}`;
}

// ---------- Filename parsing ----------
function classifyFile(fileName) {
  const m1 = /^(IV|RV)(\d{2})(\d{2})-(\d{4})\.pdf$/i.exec(fileName);
  if (m1) {
    const kind = m1[1].toUpperCase();
    const yy = Number(m1[2]);
    const mm = Number(m1[3]);
    const yyyy = yyToYyyy(yy);
    return { kind, yyyy, mm };
  }

  const m2 = /^WHT-(.+?)\s(\d{2})-(\d{4})(\sV(\d+))?\.pdf$/i.exec(fileName);
  if (m2) {
    const company = m2[1].trim();
    const mm = Number(m2[2]);
    const yyyy = Number(m2[3]);
    const version = m2[5] ? Number(m2[5]) : null;
    return { kind: "WHT", company, yyyy, mm, version };
  }

  return { kind: "UNKNOWN" };
}

// ---------- Drive folder ops ----------
async function findFolder(drive, parentId, name) {
  const safeName = name.replace(/'/g, "\\'");
  const q = [
    `'${parentId}' in parents`,
    `name='${safeName}'`,
    `mimeType='application/vnd.google-apps.folder'`,
    `trashed=false`,
  ].join(" and ");

  const res = await drive.files.list({
    q,
    fields: "files(id,name)",
    spaces: "drive",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  return res.data.files?.[0] || null;
}

async function getOrCreateFolder(drive, parentId, name) {
  const existing = await findFolder(drive, parentId, name);
  if (existing) return existing.id;

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
    supportsAllDrives: true,
  });

  return created.data.id;
}

async function fileExists(drive, parentId, name) {
  const safeName = name.replace(/'/g, "\\'");
  const q = [`'${parentId}' in parents`, `name='${safeName}'`, `trashed=false`].join(" and ");
  const res = await drive.files.list({
    q,
    fields: "files(id,name)",
    spaces: "drive",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return (res.data.files?.length || 0) > 0;
}

function withDupSuffix(fileName, n) {
  const idx = fileName.toLowerCase().lastIndexOf(".pdf");
  if (idx === -1) return `${fileName}_dup${n}`;
  return `${fileName.slice(0, idx)}_dup${n}.pdf`;
}

// ---------- Main upload ----------
async function uploadFileToDrive(localPath, fileName) {
  const drive = await getDriveClient();

  const rootId = process.env.DRIVE_ROOT_FOLDER_ID;
  if (!rootId) throw new Error("Missing DRIVE_ROOT_FOLDER_ID in .env");

  // debug: ให้เห็นว่า request มี identity แล้ว
  const rootInfo = await drive.files.get({
    fileId: rootId,
    fields: "id,name,driveId",
    supportsAllDrives: true,
  });
  console.log("ROOT_INFO:", rootInfo.data);

  const info = classifyFile(fileName);

  // โฟลเดอร์เดือน (YYYY_MM)
  const monthId =
    info.kind === "UNKNOWN"
      ? await getOrCreateFolder(drive, rootId, "Unsorted")
      : await getOrCreateFolder(drive, rootId, monthFolderName(info.yyyy, info.mm));

  // โฟลเดอร์ย่อยในเดือน
  let targetId = monthId;
  if (info.kind === "IV" || info.kind === "RV") {
    targetId = await getOrCreateFolder(drive, monthId, info.kind);
  } else if (info.kind === "WHT") {
    const whtRoot = await getOrCreateFolder(drive, monthId, "WHT");
    targetId = await getOrCreateFolder(drive, whtRoot, info.company);
  }

  // กันชื่อซ้ำ
  let finalName = fileName;
  if (await fileExists(drive, targetId, finalName)) {
    let n = 1;
    while (await fileExists(drive, targetId, withDupSuffix(fileName, n))) n += 1;
    finalName = withDupSuffix(fileName, n);
  }

  // upload
  const res = await drive.files.create({
    requestBody: { name: finalName, parents: [targetId] },
    media: { mimeType: "application/pdf", body: fs.createReadStream(localPath) },
    fields: "id,webViewLink,name",
    supportsAllDrives: true,
  });

  return res.data;
}

module.exports = { uploadFileToDrive };
