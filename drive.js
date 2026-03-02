// drive.js (OAuth version - stable)
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const CREDENTIALS_PATH = process.env.OAUTH_CLIENT_SECRET_PATH || "./credentials.json";
const TOKEN_PATH = process.env.OAUTH_TOKEN_PATH || "./token.json";
const { getAuthClient } = require("./auth");

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

async function getDriveClient() {
  const auth = await getAuthClient();
  return google.drive({ version: "v3", auth });
}

// กัน create โฟลเดอร์ซ้ำจาก request ที่มาพร้อมกัน
const folderLocks = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  const key = `${parentId}::${name}`;

  // ถ้ามีงานสร้างโฟลเดอร์ชื่อนี้อยู่แล้ว ให้รอผลของอันนั้น
  if (folderLocks.has(key)) return folderLocks.get(key);

  const task = (async () => {
    // 1) หาอีกครั้งก่อนสร้าง
    const existing = await findFolder(drive, parentId, name);
    if (existing) return existing.id;

    // 2) สร้าง
    const created = await drive.files.create({
      requestBody: {
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      },
      fields: "id",
      supportsAllDrives: true,
    });

    const createdId = created.data.id;

    // 3) รอให้ Drive index ทัน แล้วค่อย “ยืนยัน” ว่ามีโฟลเดอร์นี้จริง (กันสร้างซ้ำจาก index delay)
    //    ถ้าเจอหลายอัน ให้เลือกอันแรก (หรือจะเลือก createdId ก็ได้)
    for (const waitMs of [150, 300, 600, 1200]) {
      await sleep(waitMs);
      const again = await findFolder(drive, parentId, name);
      if (again) return again.id;
    }

    // 4) ถ้ายังหาไม่เจอ (rare) คืน id ที่เพิ่งสร้างไปเลย
    return createdId;
  })();

  folderLocks.set(key, task);

  try {
    return await task;
  } finally {
    folderLocks.delete(key);
  }
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
  const ext = path.extname(fileName);
  if (!ext) return `${fileName}_dup${n}`;
  const baseName = fileName.slice(0, -ext.length);
  return `${baseName}_dup${n}${ext}`;
}

function monthFromDate(d) {
  const yyyy = d.getFullYear();
  const mm = d.getMonth() + 1;
  return monthFolderName(yyyy, mm); // YYYY_MM
}

function parseMonthFolder(fileName, receivedAt) {
  if (!/\.pdf$/i.test(fileName)) return null;

  // IV/RV: IV6902-0001.pdf, RV6902-0001.pdf
  const m1 = /^(IV|RV)(\d{2})(\d{2})-\d{4}\.pdf$/i.exec(fileName);
  if (m1) {
    const yy = Number(m1[2]);
    const mm = Number(m1[3]);
    const yyyy = yyToYyyy(yy);
    return monthFolderName(yyyy, mm);
  }

  // WHT ที่มีเดือนปี:
  // - WHT-ชื่อบริษัท 02-2026.pdf
  // - WHT ชื่อบริษัท 02-2026 V2.pdf
  const m2 = /^WHT(?:-|\s+).+?\s+(\d{2})-(\d{4})(?:\s*V\d+)?\.pdf$/i.exec(fileName);
  if (m2) {
    const mm = Number(m2[1]);
    const yyyy = Number(m2[2]);
    return monthFolderName(yyyy, mm);
  }

  // WHT ที่ไม่มีเดือนปี: ใช้เดือนปีตอนรับไฟล์
  if (/^WHT(?:-|\s+)/i.test(fileName)) {
    return monthFromDate(receivedAt);
  }

  return null;
}

function parseCategoryFolder(fileName) {
  if (!/\.pdf$/i.test(fileName)) return null;

  if (/^RV/i.test(fileName)) return "RV";
  if (/^IV/i.test(fileName)) return "IV";
  if (/^WHT/i.test(fileName)) return "WHT";

  return null;
}



function parseExpenseDate(value) {
  if (!value || typeof value !== "string") return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------- Main upload ----------
async function uploadFileToDrive(localPath, fileName, receivedAt = new Date(), options = {}) {

  const drive = await getDriveClient();

  const rootId = process.env.DRIVE_ROOT_FOLDER_ID;
  if (!rootId) throw new Error("Missing DRIVE_ROOT_FOLDER_ID in .env");

  const lowerName = fileName.toLowerCase();
  const isPdf = /\.pdf$/i.test(fileName);
  const isImg = /\.(jpg|jpeg|png|heic|heif)$/i.test(fileName);

  if (!isPdf && !isImg) {
    console.log("skip unsupported:", fileName);
    return null;
  }

  // 1) หาโฟลเดอร์เดือน
  const expenseDate = parseExpenseDate(options.expenseDate);
  const monthName = options.category === "expense"
    ? monthFromDate(expenseDate || receivedAt)
    : parseMonthFolder(fileName, receivedAt);

  // 2) สร้าง/หาโฟลเดอร์เดือน (ถ้า parse ไม่ได้ให้ลง Unsorted)
  const monthId = monthName
    ? await getOrCreateFolder(drive, rootId, monthName)
    : await getOrCreateFolder(drive, rootId, "Unsorted");

  // 3) แยกปลายทางตามประเภทงาน
  let targetFolderId;
  if (options.category === "expense") {
    targetFolderId = await getOrCreateFolder(drive, monthId, "expense");
  } else {
    const docsId = await getOrCreateFolder(drive, monthId, "docs");
    const categoryName = parseCategoryFolder(fileName);
    targetFolderId = categoryName
      ? await getOrCreateFolder(drive, docsId, categoryName)
      : docsId;
  }

  // 4) กันชื่อซ้ำ
  let finalName = fileName;
  if (await fileExists(drive, targetFolderId, finalName)) {
    let n = 1;
    while (await fileExists(drive, targetFolderId, withDupSuffix(fileName, n))) n += 1;
    finalName = withDupSuffix(fileName, n);
  }

  const mimeType = isPdf
    ? "application/pdf"
    : lowerName.endsWith(".png")
      ? "image/png"
      : lowerName.endsWith(".heic")
        ? "image/heic"
        : lowerName.endsWith(".heif")
          ? "image/heif"
          : "image/jpeg";

  // 5) อัปโหลด 
  const res = await drive.files.create({
    requestBody: { name: finalName, parents: [targetFolderId] },
    media: { mimeType, body: fs.createReadStream(localPath) },
    fields: "id,webViewLink,name",
    supportsAllDrives: true,
  });

  return res.data;
}

module.exports = { uploadFileToDrive };
