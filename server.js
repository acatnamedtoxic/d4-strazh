
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
  error: null,
  sources: {}
};

const BLIZZARD_API =
  "https://news.blizzard.com/en-us/api/news/blizzard" +
  "?feedCxpProductIds%5B%5D=blt795c314400d7ded9";

const FORUM_URL =
  "https://us.forums.blizzard.com/en/d4/c/bug-report/7.json";

const REDDIT_URL =
  "https://www.reddit.com/r/diablo4/search.json?" +
  new URLSearchParams({
    q: "dupe OR duping OR duplication OR exploit OR gold bug",
    restrict_sr: "1",
    sort: "new",
    t: "month",
    limit: "50"
  });

function classify(text) {
  const s = String(text || "").toLowerCase();

  const duping =
    /\bdupe(?:d|s|ing)?\b|\bduplication\b|\bduplicat(?:e|ed|ing|ion)\b|\bitem cloning\b/.test(s);

  const economy =
    /\bgold\b|\bcurrency\b|\brunes?\b|\bgems?\b|\bkeys\b|\btrading\b|\btrade\b|\beconomy\b|\bmarket\b/.test(s);

  const exploit =
    /\bexploit\b|\babuse\b|\bbypass\b|\bunintended interaction\b|\binfinite\b|\bunlimited\b|\brollback\b/.test(s);

  const itemRelated =
    /\bitems?\b|\bgear\b|\bcrafting\b|\btransfigur\w*\b|\baffixes?\b|\bloot\b|\bstash\b|\bdrops?\b|\btrade\b|\bgold\b|\brunes?\b|\bgems?\b|\bkeys\b/.test(s);

  const bug =
    /\bbug(?:ged|s)?\b|\bglitch\b|\bnot working\b|\bdoesn't work\b|\bdoes not work\b|\bbroken\b|\bmissing loot\b|\bwrong amount\b/.test(s);

  if (duping && (economy || itemRelated)) {
    return { label: "DUPING / ECONOMY", severity: "HIGH" };
  }

  if (exploit && itemRelated) {
    return {
      label: economy ? "ECONOMY EXPLOIT" : "GAMEPLAY EXPLOIT",
      severity: economy ? "HIGH" : "MEDIUM"
    };
  }

  if (bug && itemRelated) {
    return { label: "ITEM / LOOT BUG", severity: "MEDIUM" };
  }

  return null;
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "D4Strazh/2.0 (public game issue monitoring)",
      "Accept": "application/json"
    },
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

function saveIssue(title, source, url, classification) {
  if (!title || !url || !classification) return false;

  const exists = db.prepare(
    "SELECT id FROM issues WHERE url = ? AND url != ''"
  ).get(url);

  if (exists) return false;

  const taggedTitle =
    `[${classification.severity} · ${classification.label}] ${title}`;

  db.prepare(`
    INSERT INTO issues (title, source, url, status)
    VALUES (?, ?, ?, 'Unverified')
  `).run(taggedTitle.slice(0, 300), source, url);

  return true;
}

function normalizeBlizzardUrl(value) {
  if (!value) return "";

  if (value.startsWith("/")) {
    return "https://news.blizzard.com" + value;
  }

  return value;
}

async function checkBlizzardNews() {
  const data = await getJson(BLIZZARD_API);
  const items = data?.feed?.contentItems;

  if (!Array.isArray(items)) {
    throw new Error("API response has no contentItems array");
  }

  let found = 0;

  for (const item of items) {
    const article = item?.properties;
    if (!article) continue;

    const title = String(article.title || "").trim();
    const url = normalizeBlizzardUrl(article.newsUrl);

    const searchable = [
      title,
      article.description,
      article.summary,
      article.shortDescription
    ].filter(Boolean).join(" ");

    const classification = classify(searchable);

    if (
      classification &&
      url.startsWith("https://news.blizzard.com/")
    ) {
      if (saveIssue(title, "Blizzard Official", url, classification)) {
        found++;
      }
    }
  }

  monitor.sources.blizzard = {
    ok: true,
    checked: items.length,
    newItems: found
  };

  return found;
}

async function checkBlizzardForum() {
  const data = await getJson(FORUM_URL);
  const topics = data?.topic_list?.topics;

  if (!Array.isArray(topics)) {
    throw new Error("Forum response has no topic list");
  }

  let found = 0;

  for (const topic of topics) {
    const title = String(topic.title || "").trim();
    const searchable = `${title} ${topic.excerpt || ""}`;
    const classification = classify(searchable);

    if (!classification || !topic.id || !topic.slug) continue;

    const url =
      `https://us.forums.blizzard.com/en/d4/t/${topic.slug}/${topic.id}`;

    if (
      saveIssue(
        title,
        "Blizzard Forum · Unverified report",
        url,
        classification
      )
    ) {
      found++;
    }
  }

  monitor.sources.forum = {
    ok: true,
    checked: topics.length,
    newItems: found
  };

  return found;
}

async function checkReddit() {
  const data = await getJson(REDDIT_URL);
  const posts = data?.data?.children;

  if (!Array.isArray(posts)) {
    throw new Error("Reddit response has no posts list");
  }

  let found = 0;

  for (const entry of posts) {
    const post = entry?.data;
    if (!post) continue;

    const title = String(post.title || "").trim();
    const searchable = `${title} ${post.selftext || ""}`;
    const classification = classify(searchable);

    if (!classification || !post.permalink) continue;

    const url = post.permalink.startsWith("http")
      ? post.permalink
      : "https://www.reddit.com" + post.permalink;

    if (
      saveIssue(
        title,
        "Reddit · Unverified report",
        url,
        classification
      )
    ) {
      found++;
    }
  }

  monitor.sources.reddit = {
    ok: true,
    checked: posts.length,
    newItems: found
  };

  return found;
}

async function checkAllSources() {
  monitor.lastChecked = new Date().toISOString();
  monitor.lastFound = 0;
  monitor.error = null;

  const checks = [
    ["blizzard", checkBlizzardNews],
    ["forum", checkBlizzardForum],
    ["reddit", checkReddit]
  ];

  let successes = 0;

  for (const [name, check] of checks) {
    try {
      monitor.lastFound += await check();
      successes++;
    } catch (error) {
      monitor.sources[name] = {
        ok: false,
        error: error.message
      };

      console.error(
        `D4 Страж ${name} error:`,
        error.message
      );
    }
  }

  if (successes === 0) {
    monitor.error = "Все источники недоступны";
  }

  console.log(
    `D4 Страж: проверка завершена; новых находок: ${monitor.lastFound}; источники доступны: ${successes}/3`
  );
}

// Hide old ordinary news without deleting records.
function hideOldNoise() {
  const rows = db.prepare(
    "SELECT id, title, source FROM issues WHERE source = 'Blizzard News'"
  ).all();

  const update = db.prepare(
    "UPDATE issues SET status = ? WHERE id = ?"
  );

  const transaction = db.transaction(() => {
    for (const row of rows) {
      const classification = classify(row.title);
      update.run(classification ? "Unverified" : "Noise", row.id);
    }
  });

  transaction();
}

app.get("/api/issues", (req, res) => {
  res.json(
    db.prepare(`
      SELECT * FROM issues
      WHERE status != 'Noise'
      ORDER BY id DESC
    `).all()
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
    sources: monitor.sources
  });
});

app.post("/api/refresh", async (req, res) => {
  await checkAllSources();

  res.json({
    ok: !monitor.error,
    message: monitor.error || "Проверка завершена",
    lastFound: monitor.lastFound,
    sources: monitor.sources
  });
});

cron.schedule("*/15 * * * *", checkAllSources);

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`D4 Страж listening on port ${PORT}`);
  hideOldNoise();
  checkAllSources();
});
