
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

const monitor = {
  enabled: true,
  lastChecked: null,
  lastFound: 0,
  error: null
};

const API_URL =
  "https://news.blizzard.com/en-us/api/news/blizzard" +
  "?feedCxpProductIds%5B%5D=blt795c314400d7ded9";

function saveIssue(title, source, url) {
  if (!title || !url) return false;

  const exists = db.prepare(
    "SELECT id FROM issues WHERE url = ?"
  ).get(url);

  if (exists) return false;

  db.prepare(`
    INSERT INTO issues (title, source, url, status)
    VALUES (?, ?, ?, 'Unverified')
  `).run(title.slice(0, 300), source, url);

  return true;
}

async function checkFeed() {
  monitor.lastChecked = new Date().toISOString();
  monitor.lastFound = 0;
  monitor.error = null;

  try {
    const response = await fetch(API_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 D4Strazh/1.0",
        "Accept": "application/json"
      },
      signal: AbortSignal.timeout(20000)
    });

    if (!response.ok) {
      throw new Error(`Blizzard API HTTP ${response.status}`);
    }

    const data = await response.json();
    const items = data?.feed?.contentItems;

    if (!Array.isArray(items)) {
      throw new Error(
        "Blizzard API response has no feed.contentItems array"
      );
    }

    for (const item of items) {
      const article = item?.properties;
      if (!article) continue;

      const title = String(article.title || "").trim();
      let url = String(article.newsUrl || "").trim();

      if (url.startsWith("/")) {
        url = "https://news.blizzard.com" + url;
      }

      if (
        !title ||
        !url.startsWith("https://news.blizzard.com/")
      ) {
        continue;
      }

      if (saveIssue(title, "Blizzard News", url)) {
        monitor.lastFound++;
      }
    }

    console.log(
      `D4 Страж: API OK; статей получено: ${items.length}; новых: ${monitor.lastFound}`
    );
  } catch (error) {
    monitor.error = error.message;
    console.error("D4 Страж monitoring error:", error.message);
  }
}

app.get("/api/issues", (req, res) => {
  res.json(
    db.prepare("SELECT * FROM issues ORDER BY id DESC").all()
  );
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
    monitoring: monitor.enabled,
    lastChecked: monitor.lastChecked,
    lastFound: monitor.lastFound,
    error: monitor.error,
    message: monitor.error || "Checking official Blizzard news API"
  });
});

app.post("/api/refresh", async (req, res) => {
  await checkFeed();

  res.json({
    ok: !monitor.error,
    message: monitor.error || "Проверка завершена",
    lastFound: monitor.lastFound
  });
});

cron.schedule("*/15 * * * *", checkFeed);

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`D4 Страж listening on port ${PORT}`);
  checkFeed();
});
