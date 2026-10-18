
const express = require("express");
const cron = require("node-cron");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const db = new Database(process.env.DB_PATH || "strazh.db");

const FEED_URL = "https://news.blizzard.com/en-us/feed/diablo-4";

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

function decodeXml(value = "") {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function getTag(block, name) {
  const tag = new RegExp(
    `<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}\\s*>`,
    "i"
  );
  return decodeXml(block.match(tag)?.[1] || "");
}

function getLink(block) {
  const linkTag = block.match(/<(?:[\w.-]+:)?link\b[^>]*>/i);
  if (linkTag) {
    const href = linkTag[0].match(/\bhref=["']([^"']+)["']/i);
    if (href) return href[1];

    const textLink = block.match(
      /<(?:[\w.-]+:)?link\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?link\s*>/i
    );
    if (textLink) return decodeXml(textLink[1]);
  }
  return "";
}

async function checkFeed() {
  monitor.lastChecked = new Date().toISOString();
  monitor.lastFound = 0;
  monitor.error = null;

  try {
    const response = await fetch(FEED_URL, {
      headers: { "User-Agent": "D4Strazh/1.0 personal-news-monitor" },
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      throw new Error(`Blizzard feed HTTP ${response.status}`);
    }

    const xml = await response.text();
    const entries = xml.match(
      /<(?:item|entry)\b[^>]*>[\s\S]*?<\/(?:item|entry)\s*>/gi
    ) || [];

    if (!entries.length) {
      throw new Error("В ленте не найдены записи; формат мог измениться");
    }

    const insert = db.prepare(`
      INSERT INTO issues (title, source, url, status)
      VALUES (?, ?, ?, ?)
    `);

    const exists = db.prepare(
      "SELECT id FROM issues WHERE url = ? AND url != ''"
    );

    const saveEntries = db.transaction(items => {
      let added = 0;

      for (const entry of items) {
        const title = getTag(entry, "title");
        const url = getLink(entry);
        const description =
          getTag(entry, "description") || getTag(entry, "summary");

        if (!title || !url || !/^https:\/\//i.test(url)) continue;

        const text = `${title} ${description}`.toLowerCase();
        const relevant =
          /patch notes|hotfix|exploit|vulnerab|security|cve|bug fix|bug fixes|known issue|security update/.test(text);

        if (!relevant || exists.get(url)) continue;

        insert.run(title.slice(0, 300), "Blizzard News", url, "Unverified");
        added++;
      }

      return added;
    });

    monitor.lastFound = saveEntries(entries);
    console.log(
      `D4 Страж: проверка завершена, новых записей: ${monitor.lastFound}`
    );
  } catch (error) {
    monitor.error = error.message;
    console.error("D4 Страж monitoring error:", error.message);
  }
}

app.get("/api/issues", (req, res) => {
  res.json(db.prepare("SELECT * FROM issues ORDER BY id DESC").all());
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
    message: monitor.error
      ? "Последняя проверка завершилась ошибкой."
      : "Мониторинг официальной ленты Blizzard."
  });
});

app.post("/api/refresh", async (req, res) => {
  await checkFeed();

  res.json({
    ok: !monitor.error,
    message: monitor.error || "Проверка завершена.",
    lastFound: monitor.lastFound
  });
});

cron.schedule("*/15 * * * *", () => {
  checkFeed();
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`D4 Страж listening on port ${PORT}`);
  checkFeed();
});
