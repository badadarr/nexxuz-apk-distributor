const express = require("express");
const path = require("path");
const os = require("os");
const fs = require("fs");

const app = express();
const PORT = 3000;

// Agar file APK bisa diakses langsung via URL
app.use((req, res, next) => {
    if (req.url.endsWith('.apk')) {
        console.log(`[${new Date().toLocaleTimeString()}] Download dimulai: ${req.url} dari ${req.ip}`);
    }
    next();
});
app.use(express.static("public"));

// Mendapatkan IP Lokal Laptop kamu
const getLocalIp = () => {
  const interfaces = os.networkInterfaces();
  for (let devName in interfaces) {
    let iface = interfaces[devName];
    for (let i = 0; i < iface.length; i++) {
      let alias = iface[i];
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

const localIp = getLocalIp();

// API endpoint untuk mendapatkan daftar APK
app.get("/api/apks", (req, res) => {
  try {
    const coreDir = path.join(__dirname, "public", "Core");
    const memberDir = path.join(__dirname, "public", "Member");
    
    // Pastikan folder ada
    if (!fs.existsSync(coreDir)) fs.mkdirSync(coreDir, { recursive: true });
    if (!fs.existsSync(memberDir)) fs.mkdirSync(memberDir, { recursive: true });

    const coreApks = fs.readdirSync(coreDir).filter(file => file.endsWith('.apk'));
    const memberApks = fs.readdirSync(memberDir).filter(file => file.endsWith('.apk'));

    res.json({
      core: coreApks.map(apk => ({ name: apk, url: `/Core/${apk}` })),
      member: memberApks.map(apk => ({ name: apk, url: `/Member/${apk}` }))
    });
  } catch (err) {
    console.error("Error membaca direktori APK:", err);
    res.status(500).json({ error: "Gagal membaca direktori APK" });
  }
});

// Jika tidak ada rute yang cocok, kirim ke index.html
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`
    =================================================
    🚀 SERVER DISTRIBUTOR APK AKTIF! 🚀
    
    Silakan ketik alamat berikut di BROWSER HP Anda:
    
    ✨  http://${localIp}:${PORT}  ✨
    
    Penting: Pastikan HP dan PC ini terhubung 
             ke jaringan WiFi atau hotspot yang sama.
    =================================================
  `);
});
