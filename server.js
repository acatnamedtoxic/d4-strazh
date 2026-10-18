
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

// Add columns to existing databases without deleting old records.
const columns = new Set(
  db.prepare("PRAGMA table_info(issues)").all().map(c => c.name)
);

for (const [name, type] of [
  ["category", "TEXT NOT NULL DEFAULT 'OTHER'"],
  ["benefit", "TEXT NOT NULL DEFAULT ''"],
  ["checked_at", "TEXT NOT NULL DEFAULT ''"]
]) {
  if (!columns.has(name)) {
    db.exec(`ALTER TABLE issues ADD COLUMN ${name} ${type}`);
  }
}

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

// Public guide pages. These are best-effort checks, not full web searches.
const GUIDE_PAGES = [
  {
    name: "Icy Veins News",
    url: "https://www.icy-veins.com/news/",
    host: "www.icy-veins.com"
  },
  {
    name: "Icy Veins Leveling",
    url: "https://www.icy-veins.com/d4/guides/leveling-tier-list/",
    host: "www.icy-veins.com"
  },
  {
    name: "Icy Veins Speed Farming",
    url: "https://www.icy-veins.com/d4/guides/speed-farming-tier-list/",
    host: "www.icy-veins.com"
  },
  {
    name: "D4Guides",
    url: "https://d4guides.gg/",
    host: "d4guides.gg"
  }
];

function classify(text) {
  const s = String(text || "").toLowerCase();

  if (
    /\bdupe(?:d|s|ing)?\b|\bduplication\b|\bitem cloning\b|\bexploit\b|\bunintended interaction\b|\binfinite gold\b|\binfinite materials\b|\brollback\b/.test(s)
  ) {
    return {
      category: "EXPLOIT",
      severity: "HIGH",
      benefit: "Возможный эксплойт. Не подтверждён: проверь дату, патч и официальные сообщения."
    };
  }

  if (
    /\bparagon\b|\bexperience farm\b|\bexp farm\b|\bxp farm\b|\bleveling\b|\blevelling\b|\bfast leveling\b|\bleveling tier\b/.test(s)
  ) {
    return {
      category: "XP / PARAGON",
      severity: "MEDIUM",
      benefit: "Возможность быстрее получать XP или Paragon. Проверь актуальность для своего этапа игры."
    };
  }

  if (
    /\bmythic\b|\bmythics\b|\buber unique\b|\bunique farming\b|\bgear farming\b|\bloot farming\b|\bdrop rate\b|\bboss loot\b|\btarget farming\b|\btormented boss\b/.test(s)
  ) {
    return {
      category: "GEAR / MYTHICS",
      severity: "MEDIUM",
      benefit: "Возможность эффективнее добывать экипировку или Mythic-уникалки. Сверь источники лута и затраты."
    };
  }

  if (
    /\bgold farm\b|\bfarming gold\b|\bgold farming\b|\bgold\b|\btrading\b|\btrade economy\b/.test(s)
  ) {
    return {
      category: "GOLD / TRADE",
      severity: "MEDIUM",
      benefit: "Возможность заработать или сэкономить золото. Проверь цены и актуальные правила торговли."
    };
  }

  if (
    /\bmaterials? farm\b|\bfarming materials\b|\bcrafting materials\b|\bmasterworking materials\b|\bobducite\b|\bforgotten souls\b|\bveiled crystals\b|\bmaterial farming\b/.test(s)
  ) {
    return {
      category: "MATERIALS",
      severity: "MEDIUM",
      benefit: "Возможность быстрее собрать ресурсы для улучшения экипировки."
    };
  }

  if (
    /\bbuild guide\b|\bbest builds\b|\btier list\b|\bendgame build\b|\bleveling build\b|\bspeed farming\b|\bspeedfarm\b|\bfarm build\b|\bmeta build\b|\bclass guide\b/.test(s)
  ) {
    return {
      category: "BUILDS / FARM",
      severity: "LOW",
      benefit: "Полезный билд или фарм-маршрут. Проверь класс, сезон и версию патча."
    };
  }

  const progression =
    /\b(loot|drop|mythic|unique|gold|material|experience|paragon|leveling|crafting|boss|reward|stash|trade)\b/.test(s);

  const bug =
    /\bbug\b|\bglitch\b|\bnot working\b|\bdoesn't work\b|\bdoes not work\b|\bbroken\b|\bmissing loot\b|\bwrong amount\b|\bhotfix\b|\bfix(?:ed|es)?\b/.test(s);

  if (progression && bug) {
    return {
      category: "PROGRESSION BUG",
      severity: "MEDIUM",
      benefit: "Возможная проблема с добычей или прокачкой. Сообщение игрока не подтверждает её достоверность."
    };
  }

  return null;
}

async function fetchText(url, accept = "text/html,application/json") {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "D4-Strazh/3.0 (personal public-source monitor)",
      "Accept": accept
    },
    signal: AbortSignal.timeout(20000),
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.text();
}

async function getJson(url) {
  return JSON.parse(await fetchText(url, "application/json"));
}

function saveIssue(title, source, url, classification) {
  if (!title || !url || !classification) return false;
  if (!url.startsWith("https://")) return false;

  const existing = db.prepare(
    "SELECT id FROM issues WHERE url = ? AND url != ''"
  ).get(url);

  if (existing) {
    db.prepare(`
      UPDATE issues
      SET category = ?, benefit = ?, checked_at = ?
      WHERE id = ?
    `).run(
      classification.category,
      classification.benefit,
      new Date().toISOString(),
      existing.id
    );
    return false;
  }

  const taggedTitle =
    `[${classification.severity} · ${classification.category}] ${title}`;

  db.prepare(`
    INSERT INTO issues
      (title, source, url, status, category, benefit, checked_at)
    VALUES (?, ?, ?, 'Unverified', ?, ?, ?)
  `).run(
    taggedTitle.slice(0, 300),
    source,
    url,
    classification.category,
    classification.benefit,
    new Date().toISOString()
  );

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
    const text = [
      title,
      article.description,
      article.summary,
      article.shortDescription
    ].filter(Boolean).join(" ");

    const result = classify(text);

    if (
      result &&
      url.startsWith("https://news.blizzard.com/")
    ) {
      if (saveIssue(title, "Blizzard Official", url, result)) {
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
    const result = classify(`${title} ${topic.excerpt || ""}`);

    if (!result || !topic.id || !topic.slug) continue;

    const url =
      `https://us.forums.blizzard.com/en/d4/t/${topic.slug}/${topic.id}`;

    if (saveIssue(title, "Blizzard Forum · Unverified", url, result)) {
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

function decodeHtml(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, " ");
}

function stripTags(text) {
  return decodeHtml(String(text || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function extractLinks(html, pageUrl, allowedHost) {
  const results = [];
  const regex =
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while ((match = regex.exec(html)) !== null) {
    const title = stripTags(match[2]);
    if (title.length < 8 || title.length > 220) continue;

    let parsed;
    try {
      parsed = new URL(decodeHtml(match[1]), pageUrl);
    } catch {
      continue;
    }

    if (parsed.protocol !== "https:") continue;
    if (parsed.hostname !== allowedHost) continue;
    if (/\.(jpg|jpeg|png|gif|webp|svg|pdf)(\?|$)/i.test(parsed.pathname)) {
      continue;
    }

    results.push({
      title,
      url: parsed.href.split("#")[0]
    });
  }

  return results;
}

async function checkGuidePage(page) {
  const html = await fetchText(page.url);
  const links = extractLinks(html, page.url, page.host);

  let found = 0;
  let relevant = 0;

  for (const link of links) {
    const result = classify(link.title);
    if (!result) continue;

    relevant++;

    if (saveIssue(link.title, page.name, link.url, result)) {
      found++;
    }
  }

  return {
    checked: links.length,
    relevant,
    newItems: found
  };
}

async function checkGuides() {
  let found = 0;

  for (const page of GUIDE_PAGES) {
    try {
      const result = await checkGuidePage(page);

      monitor.sources[page.name] = {
        ok: true,
        ...result
      };

      found += result.newItems;
    } catch (error) {
      monitor.sources[page.name] = {
        ok: false,
        error: error.message
      };

      console.error(`D4 Страж ${page.name}:`, error.message);
    }
  }

  return found;
}

async function checkAllSources() {
  monitor.lastChecked = new Date().toISOString();
  monitor.lastFound = 0;
  monitor.error = null;

  const checks = [
    ["blizzard", checkBlizzardNews],
    ["forum", checkBlizzardForum],
    ["guides", checkGuides]
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

      console.error(`D4 Страж ${name}:`, error.message);
    }
  }

  if (successes === 0) {
    monitor.error = "Все источники недоступны";
  }

  console.log(
    `D4 Страж: новых находок ${monitor.lastFound}; ` +
    `доступно групп источников ${successes}/${checks.length}`
  );
}

app.get("/api/issues", (req, res) => {
  res.json(
    db.prepare(`
      SELECT * FROM issues
      WHERE status != 'Noise'
      ORDER BY id DESC
      LIMIT 250
    `).all()
  );
});

app.post("/api/issues", (req, res) => {
  const title = String(req.body.title || "").trim();

  if (!title || title.length > 300) {
    return res.status(400).json({ error: "Invalid title" });
  }

  const result = db.prepare(`
    INSERT INTO issues (title, source, category, benefit)
    VALUES (?, 'Manual', 'OTHER', '')
  `).run(title);

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

cron.schedule("*/15 * * * *", () => {
  checkAllSources().catch(error =>
    console.error("Scheduled check failed:", error.message)
  );
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`D4 Страж listening on port ${PORT}`);

  checkAllSources().catch(error =>
    console.error("Initial check failed:", error.message)
  );
});
