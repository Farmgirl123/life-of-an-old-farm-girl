/**
 * Life of an Old Farm Girl - Node.js server (S3 version)
 * Features: static site, uploads to Amazon S3 (photos/videos/sponsors),
 * YouTube links, delete, session auth, analytics, and contact email.
 */
const express = require("express");
const cors = require("cors");
const fs = require("fs-extra");
const fsExtra = fs;
const path = require("path");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const nodemailer = require("nodemailer");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const ffmpegPath = require("ffmpeg-static");
const ffmpeg = require("fluent-ffmpeg");

const sharp = require("sharp");
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
app.set("trust proxy", 1); // needed for secure cookies behind proxies
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const SESSION_SECRET = process.env.SESSION_SECRET || "farmgirl_secret_key";

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: NODE_ENV === "production",
      sameSite: "lax",
      httpOnly: true
    }
  })
);

// Paths
const rootDir = __dirname;
const dataDir = path.join(rootDir, "data");
const publicDir = path.join(rootDir, "public");

fs.ensureDirSync(dataDir);

// Helpers for JSON files
async function readJSON(filePath, fallback = {}) {
  return (await fs.pathExists(filePath))
    ? JSON.parse(await fs.readFile(filePath))
    : fallback;
}
async function writeJSON(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}
function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
}

// Analytics file path
const analyticsFile = path.join(dataDir, "analytics.json");

// Admin credentials
const credsFile = path.join(dataDir, "admin.json");
async function ensureAdmin() {
  const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
  const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || "";
  const ADMIN_PASSWORD_PLAIN = process.env.ADMIN_PASSWORD_PLAIN || "";

  let finalHash = ADMIN_PASSWORD_HASH;
  if (!finalHash) {
    const pwd = ADMIN_PASSWORD_PLAIN || "farmgirl123";
    finalHash = await bcrypt.hash(pwd, 10);
    if (!process.env.ADMIN_PASSWORD_PLAIN && !process.env.ADMIN_PASSWORD_HASH) {
      console.log("Default admin created: username='admin', password='farmgirl123' (set env vars in production!)");
    }
  }
  await fs.writeFile(credsFile, JSON.stringify({ username: ADMIN_USERNAME, password: finalHash }, null, 2));
}
ensureAdmin();

// Serve static site
app.use(express.static(publicDir, { maxAge: "1d", etag: true }));

// Session utilities
app.get("/session", (req, res) => res.json({ loggedIn: !!req.session.user }));
app.get("/admin.html", (req, res, next) => {
  if (!req.session.user) return res.redirect("/login.html");
  next();
});

// ---------- AUTH ---------- //
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, message: "Missing fields" });
  try {
    const creds = JSON.parse(await fs.readFile(credsFile));
    const valid = creds.username === username && (await bcrypt.compare(password, creds.password));
    if (valid) {
      req.session.user = username;
      res.json({ success: true });
    } else {
      res.status(401).json({ success: false, message: "Invalid credentials" });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "Server error" });
  }
});
app.post("/logout", (req, res) => req.session.destroy(() => res.json({ success: true })));

function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(403).json({ success: false, message: "Unauthorized" });
  next();
}

// ---------- EMAIL (contact form) ---------- //
function hasSmtp() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.CONTACT_TO);
}
let transporter = null;
if (hasSmtp()) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}
app.post("/contact", async (req, res) => {
  try {
    const { name, email, message } = req.body || {};
    if (!name || !email || !message) return res.status(400).json({ success: false, message: "Missing fields." });
    if (!transporter) return res.status(501).json({ success: false, message: "Email not configured." });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || `"Life of an Old Farm Girl" <${process.env.SMTP_USER}>`,
      to: process.env.CONTACT_TO,
      subject: `Contact from ${name}`,
      text: `${message}\n\nFrom: ${name} <${email}>`,
    });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "Email send failed." });
  }
});

// ---------- S3 SETUP ---------- //
const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
const S3_BUCKET = process.env.S3_BUCKET;
const S3_PUBLIC_URL_BASE = process.env.S3_PUBLIC_URL_BASE || "";

function s3ObjectUrl(key) {
  if (S3_PUBLIC_URL_BASE) return `${S3_PUBLIC_URL_BASE.replace(/\/+$/,'')}/${key}`;
  const region = process.env.AWS_REGION || "us-east-1";
  const base = region === "us-east-1"
    ? `https://${S3_BUCKET}.s3.amazonaws.com`
    : `https://${S3_BUCKET}.s3.${region}.amazonaws.com`;
  return `${base}/${key}`;
}

// Multer in-memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }
});

// Save metadata helper
async function saveMetadata(type, entry) {
  const filePath = path.join(dataDir, `${type}.json`);
  const existing = (await fs.pathExists(filePath))
    ? JSON.parse(await fs.readFile(filePath))
    : [];
  existing.unshift(entry);
  await fs.writeFile(filePath, JSON.stringify(existing, null, 2));
  return existing;
}

// ---------- UPLOAD FILE (to S3) ---------- //
app.post("/upload/:type", requireLogin, upload.single("file"), async (req, res) => {
  try {
    const type = req.params.type;
    if (!["photos","videos","sponsors"].includes(type)) {
      return res.status(400).json({ success: false, error: "Invalid type" });
    }
    if (!req.file) return res.status(400).json({ success: false, error: "No file" });
    if (!S3_BUCKET) return res.status(500).json({ success: false, error: "S3_BUCKET not set" });

    const safeName = req.file.originalname.replace(/\s+/g, "_");
    const key = `${type}/${Date.now()}-${safeName}`;

    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype
      // If using public bucket policy or CloudFront OAC, no ACL is needed.
      // ACL: "public-read"
    }));

    const entry = {
      id: Date.now().toString(),
      name: req.file.originalname,
      url: s3ObjectUrl(key),
      key,
      date: new Date().toISOString()
    };
    await saveMetadata(type, entry);

    // Analytics increment
    const analytics = await readJSON(analyticsFile, { pageViews: {}, uploads: {}, videoInteractions: {}, monthly: {} });
    const m = monthKey();
    analytics.uploads.total = (analytics.uploads.total || 0) + 1;
    analytics.uploads[type] = (analytics.uploads[type] || 0) + 1;
    analytics.monthly[m] = analytics.monthly[m] || { uploads: 0, views: 0, video: 0 };
    analytics.monthly[m].uploads += 1;
    await writeJSON(analyticsFile, analytics);

    res.json({ success: true, entry });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- YOUTUBE LINK ---------- //
app.post("/upload/youtube", requireLogin, async (req, res) => {
  try {
    const { url } = req.body;
    const match = url && url.match(/(?:v=|\/)([0-9A-Za-z_-]{11})/);
    if (!match) return res.status(400).json({ success: false, error: "Invalid YouTube URL" });
    const youtubeId = match[1];
    const entry = {
      id: Date.now().toString(),
      youtubeId,
      url,
      date: new Date().toISOString()
    };
    await saveMetadata("videos", entry);

    const analytics = await readJSON(analyticsFile, { pageViews: {}, uploads: {}, videoInteractions: {}, monthly: {} });
    const m = monthKey();
    analytics.uploads.total = (analytics.uploads.total || 0) + 1;
    analytics.uploads.videos = (analytics.uploads.videos || 0) + 1;
    analytics.monthly[m] = analytics.monthly[m] || { uploads: 0, views: 0, video: 0 };
    analytics.monthly[m].uploads += 1;
    await writeJSON(analyticsFile, analytics);

    res.json({ success: true, entry });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- GET DATA LIST ---------- //
app.get("/data/:type", async (req, res) => {
  try {
    const type = req.params.type;
    const filePath = path.join(dataDir, `${type}.json`);
    const content = (await fs.pathExists(filePath)) ? JSON.parse(await fs.readFile(filePath)) : [];
    res.json(content);
  } catch {
    res.json([]);
  }
});

// ---------- DELETE CONTENT (and S3 object if any) ---------- //
app.delete("/delete/:type/:id", requireLogin, async (req, res) => {
  try {
    const { type, id } = req.params;
    const filePath = path.join(dataDir, `${type}.json`);
    if (!(await fs.pathExists(filePath))) return res.status(404).json({ success: false });
    const list = JSON.parse(await fs.readFile(filePath));
    const index = list.findIndex(item => item.id === id);
    if (index === -1) return res.status(404).json({ success: false });
    const [deleted] = list.splice(index, 1);
    await fs.writeFile(filePath, JSON.stringify(list, null, 2));

    if (deleted && deleted.key && process.env.S3_BUCKET) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: deleted.key }));
      } catch (e) {
        console.warn("S3 delete warn:", e.message);
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- ANALYTICS ---------- //
app.post("/analytics/event", async (req, res) => {
  const { kind, page, videoType } = req.body || {};
  const analytics = await readJSON(analyticsFile, { pageViews: {}, uploads: {}, videoInteractions: {}, monthly: {} });
  const m = monthKey();
  analytics.monthly[m] = analytics.monthly[m] || { uploads: 0, views: 0, video: 0 };

  if (kind === "pageview" && page) {
    analytics.pageViews[page] = (analytics.pageViews[page] || 0) + 1;
    analytics.monthly[m].views += 1;
  }
  if (kind === "video") {
    const vt = videoType || "unknown";
    analytics.videoInteractions[vt] = (analytics.videoInteractions[vt] || 0) + 1;
    analytics.monthly[m].video += 1;
  }
  await writeJSON(analyticsFile, analytics);
  res.json({ success: true });
});
app.get("/analytics/summary", async (req, res) => {
  if (!req.session.user) return res.status(403).json({ success: false, message: "Unauthorized" });
  const analytics = await readJSON(analyticsFile, { pageViews: {}, uploads: {}, videoInteractions: {}, monthly: {} });
  res.json({ success: true, analytics });
});
app.delete("/analytics", async (req, res) => {
  if (!req.session.user) return res.status(403).json({ success: false, message: "Unauthorized" });
  await writeJSON(analyticsFile, { pageViews: {}, uploads: {}, videoInteractions: {}, monthly: {} });
  res.json({ success: true });
});


// ---------- DIRECT-TO-S3 PRESIGNED UPLOADS ---------- //
// Request a presigned URL to PUT directly to S3, then call /upload/complete to save metadata.
app.post("/upload/presign/:type", requireLogin, async (req, res) => {
  try {
    const type = req.params.type;
    if (!["photos","videos","sponsors"].includes(type)) {
      return res.status(400).json({ success: false, error: "Invalid type" });
    }
    const { filename, contentType } = req.body || {};
    if (!filename || !contentType) return res.status(400).json({ success: false, error: "Missing filename/contentType" });

    const safe = String(filename).replace(/\s+/g, "_");
    // cache-busting key includes timestamp
    const key = `${type}/${Date.now()}-${safe}`;

    const putCmd = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      ContentType: contentType
    });
    const uploadUrl = await getSignedUrl(s3, putCmd, { expiresIn: 900 });
    const url = s3ObjectUrl(key);
    res.json({ success: true, uploadUrl, key, url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Client calls this after upload succeeds to persist entry + analytics
app.post("/upload/complete", requireLogin, async (req, res) => {
  try {
    const { type, key, name, contentType } = req.body || {};
    if (!["photos","videos","sponsors","videos"].includes(type)) {
      return res.status(400).json({ success: false, error: "Invalid type" });
    }
    if (!key) return res.status(400).json({ success: false, error: "Missing key" });

    const entry = {
      id: Date.now().toString(),
      name: name || key.split("/").pop(),
      url: s3ObjectUrl(key),
      key,
      contentType,
      date: new Date().toISOString()
    };
    await saveMetadata(type, entry);

    const analytics = await readJSON(analyticsFile, { pageViews: {}, uploads: {}, videoInteractions: {}, monthly: {} });
    const m = monthKey();
    analytics.uploads.total = (analytics.uploads.total || 0) + 1;
    analytics.uploads[type] = (analytics.uploads[type] || 0) + 1;
    analytics.monthly[m] = analytics.monthly[m] || { uploads: 0, views: 0, video: 0 };
    analytics.monthly[m].uploads += 1;
    await writeJSON(analyticsFile, analytics);

    res.json({ success: true, entry });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---------- IMAGE OPTIMIZATION & CACHING ---------- //
// GET /img/<key>?w=800&h=0&f=webp&q=82
// Generates an optimized object, stores it at optimized/<w>x<h>/<key>.ext, then redirects to its URL.
app.get("/img/*", async (req, res) => {
  try {
    const rawKey = req.params[0]; // original S3 key
    if (!rawKey) return res.status(400).send("Missing key");
    const w = Math.max(0, parseInt(req.query.w || "0", 10));
    const h = Math.max(0, parseInt(req.query.h || "0", 10));
    const fmt = (req.query.f || "webp").toLowerCase(); // webp|jpeg|png
    const q = Math.max(1, Math.min(100, parseInt(req.query.q || "82", 10)));
    const ext = fmt === "jpg" ? "jpeg" : fmt;

    const baseName = rawKey.split("/").pop().replace(/\.[^.]+$/, "");
    const optimizedKey = `optimized/${w}x${h}/${baseName}.${ext}`;

    // Check if optimized object already exists
    try {
      await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: optimizedKey }));
      res.set("Cache-Control", "public, max-age=31536000, immutable");
      return res.redirect(302, s3ObjectUrl(optimizedKey));
    } catch {}

    // Fetch original
    const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: rawKey }));
    const buf = await streamToBuffer(obj.Body);

    let pipeline = sharp(buf);
    if (w || h) pipeline = pipeline.resize(w || null, h || null, { fit: "inside", withoutEnlargement: true });
    if (ext === "webp") pipeline = pipeline.webp({ quality: q });
    else if (ext === "jpeg") pipeline = pipeline.jpeg({ quality: q });
    else if (ext === "png") pipeline = pipeline.png();
    const out = await pipeline.toBuffer();

    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: optimizedKey,
      Body: out,
      ContentType: contentTypeForExt(ext),
      CacheControl: "public, max-age=31536000, immutable"
    }));

    res.set("Cache-Control", "public, max-age=31536000, immutable");
    return res.redirect(302, s3ObjectUrl(optimizedKey));
  } catch (e) {
    console.error(e);
    res.status(500).send("Image processing error");
  }
});

function contentTypeForExt(ext){
  switch(ext){
    case "webp": return "image/webp";
    case "jpeg": return "image/jpeg";
    case "png": return "image/png";
    default: return "application/octet-stream";
  }
}
async function streamToBuffer(stream){
  return await new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}


// ---------- VIDEO POSTER GENERATION ---------- //
// Generate a poster image (JPG) from a video stored in S3 by key.
// Saves to S3 under thumbnails/<basename>.jpg and updates videos.json entry (posterKey/posterUrl).
app.post("/video/poster", requireLogin, async (req, res) => {
  try {
    const { key, id } = req.body || {};
    if (!key) return res.status(400).json({ success: false, error: "Missing key" });
    // Fetch video
    const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    const inputBuf = await streamToBuffer(obj.Body);
    // Prepare temp files
    const os = require("os"); const path = require("path"); const fs = require("fs");
    const tmpIn = path.join(os.tmpdir(), `vid-${Date.now()}.mp4`);
    const tmpOut = path.join(os.tmpdir(), `thumb-${Date.now()}.jpg`);
    fs.writeFileSync(tmpIn, inputBuf);
    ffmpeg.setFfmpegPath(ffmpegPath);
    // Extract a frame at 00:00:02 (fallback to first frame if short)
    await new Promise((resolve, reject) => {
      ffmpeg(tmpIn).on("end", resolve).on("error", reject)
        .screenshots({ timestamps: [2], filename: path.basename(tmpOut), folder: path.dirname(tmpOut), size: "640x?" });
    });
    const outBuf = require("fs").readFileSync(tmpOut);
    const baseName = key.split("/").pop().replace(/\.[^.]+$/, "");
    const thumbKey = `thumbnails/${baseName}.jpg`;
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET, Key: thumbKey, Body: outBuf, ContentType: "image/jpeg",
      CacheControl: "public, max-age=31536000, immutable"
    }));
    const thumbUrl = s3ObjectUrl(thumbKey);
    // Update videos.json entry if id provided
    const filePath = require("path").join(dataDir, "videos.json");
    if (id && await fsExtra.pathExists(filePath)) {
      const list = JSON.parse(await fsExtra.readFile(filePath));
      const it = list.find(x => x.id === id || x.key === key);
      if (it) {
        it.posterKey = thumbKey;
        it.posterUrl = thumbUrl;
        await fsExtra.writeFile(filePath, JSON.stringify(list, null, 2));
      }
    }
    res.json({ success: true, posterKey: thumbKey, posterUrl: thumbUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// SPA fallback
app.get("*", (req, res) => res.sendFile(path.join(publicDir, "index.html")));

app.listen(PORT, () => console.log(`✅ Life of an Old Farm Girl (S3) running at http://localhost:${PORT}`));
