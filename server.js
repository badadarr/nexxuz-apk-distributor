const express = require("express");
const path = require("path");
const os = require("os");
const fs = require("fs");

const app = express();
const PORT = 3000;

// ─────────────────────────────────────────
//  CRASH PREVENTION
// ─────────────────────────────────────────
process.on("uncaughtException", (err) => console.error(`[UNCAUGHT EXCEPTION] ${err.message}`));
process.on("unhandledRejection", (reason) => console.error(`[UNHANDLED REJECTION]`, reason));

// ─────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────
const MAX_CONCURRENT_PER_FILE = 2; // Ganti angka ini jika butuh lebih banyak serentak per file
const TICKET_TIMEOUT_MS = 30000;   // 30 detik sebelum tiket hangus jika tidak di-download

// ─────────────────────────────────────────
//  QUEUE STATE
// ─────────────────────────────────────────
const tickets = new Map(); 
// map ticketId -> { id, file, ip, name, status: 'waiting'|'ready'|'downloading', timer }

const fileQueues = new Map();
// map filePath -> { active: Set<ticketId>, waiting: Array<ticketId> }

const getQueue = (file) => {
  if (!fileQueues.has(file)) fileQueues.set(file, { active: new Set(), waiting: [] });
  return fileQueues.get(file);
};

const generateTicketId = () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

// ── LOGGING CANTIK DI TERMINAL ──
const printQueueStatus = (file) => {
  const queue = fileQueues.get(file);
  if (!queue) return;
  
  const fileName = path.basename(file);
  console.log(`\n\x1b[36m┌── STATUS ANTRIAN: ${fileName} ───\x1b[0m`);
  
  if (queue.active.size === 0 && queue.waiting.length === 0) {
      console.log(`\x1b[36m│\x1b[0m (Kosong)`);
  } else {
      let count = 1;
      for (const tId of queue.active) {
          const t = tickets.get(tId);
          if (t) console.log(`\x1b[36m│\x1b[0m \x1b[32m▶ [AKTIF]\x1b[0m ${t.ip}`);
      }
      for (const tId of queue.waiting) {
          const t = tickets.get(tId);
          if (t) {
              console.log(`\x1b[36m│\x1b[0m \x1b[33m⏳ [ANTRI #${count}]\x1b[0m ${t.ip}`);
              count++;
          }
      }
  }
  console.log(`\x1b[36m└────────────────────────────────────────\x1b[0m`);
};

// ── LOMPATKAN ANTRIAN ──
const promoteNext = (file) => {
  const queue = fileQueues.get(file);
  if (!queue) return;

  let changed = false;
  while (queue.active.size < MAX_CONCURRENT_PER_FILE && queue.waiting.length > 0) {
      const nextId = queue.waiting.shift();
      const nextTicket = tickets.get(nextId);
      
      if (nextTicket && nextTicket.status === 'waiting') {
          nextTicket.status = 'ready';
          queue.active.add(nextId);
          changed = true;
          
          // Set timer supaya tidak nyangkut selamanya kalau client force close browser
          nextTicket.timer = setTimeout(() => {
              console.log(`\x1b[31m[TIMEOUT]\x1b[0m Tiket hangus untuk ${nextTicket.ip} (${path.basename(file)})`);
              releaseSlot(file, nextId);
          }, TICKET_TIMEOUT_MS);
      }
  }
  
  if (changed) printQueueStatus(file);
};

// ── BEBASKAN SLOT ──
const releaseSlot = (file, ticketId) => {
  const queue = fileQueues.get(file);
  if (!queue) return;

  queue.active.delete(ticketId);
  
  const wIdx = queue.waiting.indexOf(ticketId);
  if (wIdx > -1) queue.waiting.splice(wIdx, 1);
  
  const ticket = tickets.get(ticketId);
  if (ticket && ticket.timer) clearTimeout(ticket.timer);
  tickets.delete(ticketId);

  if (queue.active.size === 0 && queue.waiting.length === 0) {
      fileQueues.delete(file);
      console.log(`\x1b[32m[SELESAI]\x1b[0m Antrian bersih untuk ${path.basename(file)}`);
  } else {
      promoteNext(file);
  }
};

// ─────────────────────────────────────────
//  HELPER: IP & SIZE
// ─────────────────────────────────────────
const getLocalIp = () => {
  const interfaces = os.networkInterfaces();
  for (let devName in interfaces) {
    let iface = interfaces[devName];
    for (let i = 0; i < iface.length; i++) {
      let alias = iface[i];
      if (alias.family === "IPv4" && alias.address !== "127.0.0.1" && !alias.internal) {
        return alias.address;
      }
    }
  }
  return "127.0.0.1"; // Default localhost if no network
};

const formatSize = (bytes) => {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// ─────────────────────────────────────────
//  EXPRESS MIDDLEWARE
// ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────

// 1. API: Daftar APK
app.get("/api/apks", (req, res) => {
  try {
    const dirs = {
      core: path.join(__dirname, "public", "Core"),
      member: path.join(__dirname, "public", "Member"),
      rnd: path.join(__dirname, "public", "RND"),
    };

    for (const dir of Object.values(dirs)) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    const mapApks = (dirKey) => {
      const dir = dirs[dirKey];
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".apk"))
        .sort()
        .map((apk) => {
          const size = fs.statSync(path.join(dir, apk)).size;
          const folderName = dirKey.charAt(0).toUpperCase() + dirKey.slice(1);
          return {
            name: apk,
            url: `/${folderName}/${apk}`,
            sizeLabel: formatSize(size),
            sizeBytes: size,
          };
        });
    };

    res.json({
      core: mapApks("core"),
      member: mapApks("member"),
      rnd: mapApks("rnd"),
    });
  } catch (err) {
    res.status(500).json({ error: "Gagal membaca direktori APK" });
  }
});

// 2. API: Minta Tiket (Enqueue)
app.get("/api/request-ticket", (req, res) => {
  const file = req.query.file;
  if (!file) return res.status(400).json({ error: "No file specified" });

  const absPath = path.resolve(path.join(__dirname, "public", file));
  const publicRoot = path.resolve(path.join(__dirname, "public"));
  if (!absPath.startsWith(publicRoot + path.sep) && absPath !== publicRoot) {
    return res.status(403).json({ error: "Access denied" });
  }
  if (!fs.existsSync(absPath)) return res.status(404).json({ error: "File not found" });

  const ticketId = generateTicketId();
  const ticket = { id: ticketId, file, ip: req.ip, name: path.basename(file), status: 'waiting' };
  tickets.set(ticketId, ticket);

  const queue = getQueue(file);
  queue.waiting.push(ticketId);
  
  // Langsung cek apa bisa promote
  promoteNext(file);
  
  const position = queue.waiting.indexOf(ticketId) + 1;
  res.json({ ticketId, status: ticket.status, position });
});

// 3. API: Cek Posisi Tiket
app.get("/api/check-ticket", (req, res) => {
  const tId = req.query.ticketId;
  const ticket = tickets.get(tId);
  
  if (!ticket) return res.json({ status: 'expired' });
  if (ticket.status === 'ready' || ticket.status === 'downloading') {
      return res.json({ status: ticket.status, position: 0 });
  }
  
  const queue = fileQueues.get(ticket.file);
  const position = queue ? queue.waiting.indexOf(tId) + 1 : 0;
  res.json({ status: ticket.status, position });
});

// 3b. API: Batalkan Tiket (Cancel Download)
app.get("/api/cancel-ticket", (req, res) => {
  const tId = req.query.ticketId;
  if (!tId) return res.status(400).json({ error: "No ticketId specified" });
  
  const ticket = tickets.get(tId);
  if (ticket) {
      console.log(`\x1b[33m[CANCEL]\x1b[0m Dibatalkan user: ${ticket.ip} (${ticket.name})`);
      releaseSlot(ticket.file, tId);
  }
  res.json({ success: true });
});

// 4. API: Download File dengan Tiket
app.get("/download", (req, res) => {
  const tId = req.query.ticketId;
  const ticket = tickets.get(tId);
  
  if (!ticket) return res.status(400).json({ error: "Tiket tidak valid atau hangus" });
  if (ticket.status !== 'ready') return res.status(403).json({ error: "Belum giliran Anda" });

  // Clear timeout karena user sudah konek
  if (ticket.timer) clearTimeout(ticket.timer);
  ticket.status = 'downloading';

  const file = ticket.file;
  const absPath = path.resolve(path.join(__dirname, "public", file));
  const fileName = ticket.name;
  const stat = fs.statSync(absPath);

  res.set({
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
    "Content-Length": stat.size,
  });

  const stream = fs.createReadStream(absPath);
  let released = false;

  const safeRelease = () => {
    if (!released) {
      released = true;
      releaseSlot(file, tId);
    }
  };

  stream.on("error", (err) => {
    console.error(`[STREAM ERROR] ${fileName}: ${err.message}`);
    safeRelease();
    if (!res.headersSent) res.status(500).end();
    else res.destroy();
  });

  res.on("close", () => {
    stream.destroy();
    safeRelease();
  });

  stream.pipe(res);
});

// 5. API: Status Global Queue
app.get("/api/queue-all", (req, res) => {
  const result = {};
  for (const [file, queue] of fileQueues.entries()) {
    result[file] = {
      active: queue.active.size,
      waiting: queue.waiting.length
    };
  }
  res.json({ queues: result, maxConcurrent: MAX_CONCURRENT_PER_FILE });
});

// Fallback index html
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─────────────────────────────────────────
//  START
// ─────────────────────────────────────────
const localIp = getLocalIp();
app.listen(PORT, "0.0.0.0", () => {
  console.log(`
  =================================================
  🚀 SERVER DISTRIBUTOR APK AKTIF! 🚀
  -------------------------------------------------
  📱 Buka di HP Anda:
  ✨ http://${localIp}:${PORT} ✨
  
  ⚙ Pengaturan Saat Ini:
  - Max Serentak: ${MAX_CONCURRENT_PER_FILE} HP per file
  - Tiket Expire: ${TICKET_TIMEOUT_MS / 1000} detik
  =================================================
  `);
});
