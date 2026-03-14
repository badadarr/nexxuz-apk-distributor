const cluster = require("cluster");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const compression = require("compression");

// ─── CLUSTER SETUP ────────────────────────────────────────────────────────────
const NUM_CPUS = Math.min(os.cpus().length, 4); // Max 4 workers

if (cluster.isMaster) {
  console.log(`
  =================================================
  🚀  SERVER DISTRIBUTOR APK AKTIF  🚀
  📦  Workers: ${NUM_CPUS} proses berjalan
  =================================================`);

  for (let i = 0; i < NUM_CPUS; i++) {
    cluster.fork();
  }

  cluster.on("exit", (worker, code) => {
    console.warn(
      `[Worker ${worker.process.pid}] mati — menghidupkan kembali...`,
    );
    cluster.fork(); // Auto-restart worker yang mati
  });

  return;
}

// ─── WORKER PROCESS ───────────────────────────────────────────────────────────
const app = express();
const PORT = 3000;

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

// Gzip compression untuk semua response
app.use(compression());

// Rate limiter sederhana (tanpa library eksternal)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 menit
const RATE_LIMIT_MAX = 60; // maks 60 request/menit per IP

const rateLimiter = (req, res, next) => {
  const ip = req.ip;
  const now = Date.now();

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return next();
  }

  const data = rateLimitMap.get(ip);
  if (now - data.start > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return next();
  }

  if (data.count >= RATE_LIMIT_MAX) {
    return res
      .status(429)
      .json({ error: "Terlalu banyak request. Tunggu sebentar." });
  }

  data.count++;
  next();
};

app.use(rateLimiter);

// Bersihkan rate limit map setiap 5 menit agar tidak memory leak
setInterval(
  () => {
    const now = Date.now();
    for (const [ip, data] of rateLimitMap.entries()) {
      if (now - data.start > RATE_LIMIT_WINDOW) rateLimitMap.delete(ip);
    }
  },
  5 * 60 * 1000,
);

// Logging download
app.use((req, res, next) => {
  if (req.url.endsWith(".apk")) {
    console.log(
      `[${new Date().toLocaleTimeString()}] [PID ${process.pid}] Download: ${req.url} dari ${req.ip}`,
    );
  }
  next();
});

// Static files dengan aggressive caching untuk APK
app.use(
  express.static("public", {
    maxAge: "1h", // Cache APK di browser selama 1 jam
    etag: true, // Support ETag untuk conditional request
    lastModified: true,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".apk")) {
        res.setHeader("Cache-Control", "public, max-age=3600");
        res.setHeader("Content-Disposition", "attachment");
      }
    },
  }),
);

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const getLocalIp = () => {
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    for (const alias of interfaces[devName]) {
      if (
        alias.family === "IPv4" &&
        alias.address !== "127.0.0.1" &&
        !alias.internal
      ) {
        return alias.address;
      }
    }
  }
  return "localhost";
};

// Cache checksum MD5 agar tidak dihitung ulang tiap request
const checksumCache = new Map();
const getChecksum = (filePath) => {
  try {
    if (checksumCache.has(filePath)) return checksumCache.get(filePath);
    const hash = crypto
      .createHash("md5")
      .update(fs.readFileSync(filePath))
      .digest("hex");
    checksumCache.set(filePath, hash);
    return hash;
  } catch {
    return null;
  }
};

// Bersihkan checksum cache jika file berubah (polling ringan tiap 30 detik)
setInterval(() => {
  for (const [filePath] of checksumCache.entries()) {
    if (!fs.existsSync(filePath)) checksumCache.delete(filePath);
  }
}, 30 * 1000);

const readApkDir = (dir, urlPrefix) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".apk"))
    .sort()
    .map((apk) => {
      const filePath = path.join(dir, apk);
      const stats = fs.statSync(filePath);
      return {
        name: apk,
        url: `${urlPrefix}/${encodeURIComponent(apk)}`,
        size: stats.size, // bytes
        sizeLabel: formatSize(stats.size),
        checksum: getChecksum(filePath), // MD5 untuk verifikasi
        modified: stats.mtime.toISOString(),
      };
    });
};

const formatSize = (bytes) => {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// ─── API ROUTES ───────────────────────────────────────────────────────────────

// Daftar APK
app.get("/api/apks", (req, res) => {
  try {
    const coreDir = path.join(__dirname, "public", "Core");
    const memberDir = path.join(__dirname, "public", "Member");

    const core = readApkDir(coreDir, "/Core");
    const member = readApkDir(memberDir, "/Member");

    res.setHeader("Cache-Control", "no-store"); // Selalu segar
    res.json({ core, member, total: core.length + member.length });
  } catch (err) {
    console.error("Error membaca direktori:", err);
    res.status(500).json({ error: "Gagal membaca direktori APK" });
  }
});

// Health check (untuk monitoring)
app.get("/api/health", (req, res) => {
  const coreDir = path.join(__dirname, "public", "Core");
  const memberDir = path.join(__dirname, "public", "Member");
  const coreCount = fs.existsSync(coreDir)
    ? fs.readdirSync(coreDir).filter((f) => f.endsWith(".apk")).length
    : 0;
  const memberCount = fs.existsSync(memberDir)
    ? fs.readdirSync(memberDir).filter((f) => f.endsWith(".apk")).length
    : 0;
  res.json({
    status: "ok",
    worker: process.pid,
    uptime: process.uptime(),
    apks: { core: coreCount, member: memberCount },
    memory: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB`,
  });
});

// Fallback ke index.html (SPA)
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  const localIp = getLocalIp();
  console.log(
    `[Worker ${process.pid}] Listening — buka http://${localIp}:${PORT} di HP`,
  );
});
