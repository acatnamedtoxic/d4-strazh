
const express = require("express");
const cron = require("node-cron");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const db = new Database(process.env.DB_PATH || "strazh.db");

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

db.exec(`
  CREATE TABLE IF NOT EXISTS issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'Manual',
    url TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Unverified',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

app.get("/api/issues", (req, res) => {
  res.json(db.prepare(
    "SELECT * FROM issues ORDER BY id DESC"
  ).all());
});

app.post("/api/issues", (req, res) => {
  const title = String(req.body.title || "").trim();
  if (!title || title.length > 300) {
    return res.status(400).json({ error: "Invalid title" });
  }

  const result = db.prepare(
    "INSERT INTO issues (title) VALUES (?)"
  ).run(title);

  res.status(201).json(
    db.prepare("SELECT * FROM issues WHERE id = ?")
      .get(result.lastInsertRowid)
  );
});

app.get("/api/state", (req, res) => {
  res.json({
    service: "D4 Страж",
    status: "online",
    monitoring: false,
    message: "Automatic monitoring is not configured yet."
  });
});

app.post("/api/refresh", (req, res) => {
  res.json({
    ok: true,
    message: "Manual refresh endpoint works; source monitoring is not configured."
  });
});

cron.schedule("*/15 * * * *", () => {
  console.log("D4 Страж is running. Automatic source monitoring is not configured.");
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`D4 Страж listening on port ${PORT}`);
});
