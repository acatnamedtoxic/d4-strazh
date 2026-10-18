
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

const FEED_URL = "https://news.blizzard.com/en-us/feed/diablo-4";

function saveIssue(title, source, url) {
  if (!title || !url) return false;

  const exists = db.prepare(
    "SELECT id FROM issues WHERE url = ? AND url != ''"
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
    const response = await fetch(FEED_URL, {
      headers: { "User-Agent": "D4Strazh/1.0" },
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      throw new Error(`Blizzard feed HTTP ${response.status}`);
    }

    const body = await response.text();
    const entries = body.match(
      /<(item|entry)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
    ) || [];

    if (!entries.length) {
      throw new Error(
        "Blizzard feed format is unsupported or contains no entries"
      );
    }

    for (const entry of entries) {
      const titleMatch = entry.match(
        /<(?:[\w.-]+:)?title\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?title\s*>/i
      );

      const title = (titleMatch?.[1] || "")
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/<[^>]*>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .trim();

      const linkTag = entry.match(/<link\b[^>]*>/i);
      const href = linkTag?.[0].match(/\bhref=["']([^"']+)["']/i);
      const textLink = entry.match(
        /<link\b[^>]*>([\s\S]*?)<\/link\s*>/i
      );

      const url = href?.[1] || textLink?.[1]?.trim() || "";

      const searchable = entry
        .replace(/<[^>]*>/g, " ")
        .toLowerCase();

      const relevant =
        /diablo iv|diablo 4|patch notes|hotfix|exploit|vulnerab|security|cve|known issue/.test(
          `${title.toLowerCase()} ${searchable}`
        );

      if (
        relevant &&
        title &&
        /^https:\/\/news\.blizzard\.com\//i.test(url)
      ) {
        if (saveIssue(title, "Blizzard News", url)) {
          monitor.lastFound++;
        }
      }
    }

    console.log(
      `D4 Страж: проверка завершена, новых записей: ${monitor.lastFound}`
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
    message: monitor.error ||
      "Monitoring official Blizzard news feed"
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
