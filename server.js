const express = require('express');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// 1. ИНИЦИАЛИЗАЦИЯ И МИГРАЦИЯ БАЗЫ ДАННЫХ
// ============================================================================
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

function initAndMigrateDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      url TEXT NOT NULL,
      status TEXT DEFAULT 'new',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS source_health (
      source_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      http_status INTEGER,
      health_state TEXT DEFAULT 'unknown',
      last_checked DATETIME,
      items_found INTEGER DEFAULT 0,
      error_message TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const existingCols = db.prepare(`PRAGMA table_info(issues)`).all().map(c => c.name);

  const newColumns = [
    { name: 'canonical_url', type: 'TEXT' },
    { name: 'content_type', type: "TEXT DEFAULT 'discussion'" },
    { name: 'category', type: "TEXT DEFAULT 'XP / Paragon'" },
    { name: 'published_at', type: 'TEXT' },
    { name: 'discovered_at', type: 'TEXT' },
    { name: 'patch_version', type: "TEXT DEFAULT 'Unknown'" },
    { name: 'summary', type: 'TEXT' },
    { name: 'benefit_score', type: "TEXT DEFAULT 'Medium'" },
    { name: 'benefit_rank', type: 'INTEGER DEFAULT 2' },
    { name: 'confidence', type: "TEXT DEFAULT 'Community report'" },
    { name: 'freshness', type: "TEXT DEFAULT 'Unknown'" },
    { name: 'benefit_reason', type: 'TEXT' },
    { name: 'requirements', type: 'TEXT' }
  ];

  for (const col of newColumns) {
    if (!existingCols.includes(col.name)) {
      db.exec(`ALTER TABLE issues ADD COLUMN ${col.name} ${col.type}`);
    }
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_issues_canonical ON issues(canonical_url);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_issues_category ON issues(category);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_issues_benefit ON issues(benefit_rank);`);
}

initAndMigrateDB();

// ============================================================================
// 2. ДЕКОДИРОВАНИЕ HTML И НОРМАЛИЗАЦИЯ
// ============================================================================
function decodeHtmlEntities(text) {
  if (!text) return '';
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&hellip;/g, '…')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl.trim());
    u.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'context'].forEach(p => u.searchParams.delete(p));
    let clean = u.origin + u.pathname.replace(/\/+$/, '');
    const search = u.searchParams.toString();
    return search ? `${clean}?${search}` : clean;
  } catch {
    return (rawUrl || '').trim();
  }
}

function extractPatchOrSeason(text) {
  const combined = text || '';
  const patchMatch = combined.match(/\b(?:patch|hotfix|update|v)?\s*(\d+\.\d+\.\d+[a-z]?)\b/i);
  const seasonMatch = combined.match(/\b(?:season\s*(\d+)|s(\d{1,2}))\b/i);

  const parts = [];
  if (seasonMatch) parts.push(`Season ${seasonMatch[1] || seasonMatch[2]}`);
  if (patchMatch) parts.push(`Patch ${patchMatch[1]}`);
  return parts.length > 0 ? parts.join(' / ') : 'Unknown';
}

function extractRequirements(text) {
  if (!text) return 'Условия не уточнены';
  const reqs = [];
  const classes = [
    { rx: /\b(spiritborn|спиритборн)\b/i, label: 'Класс: Spiritborn' },
    { rx: /\b(barbarian|варвар)\b/i, label: 'Класс: Barbarian' },
    { rx: /\b(sorcerer|sorceress|волшебн)\b/i, label: 'Класс: Sorcerer' },
    { rx: /\b(rogue|разбойни)\b/i, label: 'Класс: Rogue' },
    { rx: /\b(necromancer|некромант)\b/i, label: 'Класс: Necromancer' },
    { rx: /\b(druid|друид)\b/i, label: 'Класс: Druid' }
  ];
  classes.forEach(c => { if (c.rx.test(text)) reqs.push(c.label); });
  const tormentMatch = text.match(/\b(torment\s*[1-4]|t[1-4])\b/i);
  if (tormentMatch) reqs.push(`Сложность: ${tormentMatch[1].toUpperCase()}`);
  return reqs.length > 0 ? reqs.join(' • ') : 'Условия не уточнены';
}

// ============================================================================
// 3. КЛАССИФИКАТОР И АНАЛИЗАТОР КАЧЕСТВА
// ============================================================================
function analyzeAndClassifyItem({ title, rawText, sourceUrl, sourceType, publishedAt }) {
  const cleanTitle = decodeHtmlEntities(title);
  const cleanBody = decodeHtmlEntities(rawText).slice(0, 500);
  const fullText = `${cleanTitle} ${cleanBody}`.toLowerCase();

  let isOfficial = sourceType === 'official' || sourceUrl.includes('news.blizzard.com');
  let confidence = isOfficial ? 'Official' : (sourceType === 'curated_guide' ? 'Verified by source' : 'Community report');

  if (sourceUrl.includes('us.forums.blizzard.com')) {
    isOfficial = false;
    confidence = 'Community report';
  }

  // Определение Content Type
  let contentType = 'discussion';
  if (/\b(patch notes|hotfix|balance update|hotfixes)\b/i.test(fullText) || isOfficial) {
    contentType = 'patch_notes';
  } else if (/\b(build|tier list|s-tier|skill tree|paragon board setup)\b/i.test(fullText)) {
    contentType = 'build';
  } else if (/\b(guide|how to farm|strategy|route|fastest way)\b/i.test(fullText)) {
    contentType = 'guide';
  } else if (/\b(farm|method|loop|rotations|aether|obducite farm)\b/i.test(fullText)) {
    contentType = 'farming_method';
  } else if (/\b(exploit|dupe|infinite|bugged interaction)\b/i.test(fullText)) {
    contentType = 'exploit';
  } else if (/\b(bug|crash|error|not working|stuck|lag|issue|broken)\b/i.test(fullText)) {
    contentType = 'bug_report';
  } else if (/\b(news|announcement|reveal)\b/i.test(fullText)) {
    contentType = 'news';
  }

  // Определение Категории (темы)
  let category = 'XP / Paragon';
  if (contentType === 'patch_notes') {
    category = 'Patch Changes';
  } else if (contentType === 'exploit') {
    category = 'Exploits';
  } else if (/\b(mythic|uber unique|shako|tyrael|ancestral|gear|item power)\b/i.test(fullText)) {
    category = 'Gear / Mythics';
  } else if (/\b(gold|million|billion|trade|diablo\.trade)\b/i.test(fullText)) {
    category = 'Gold';
  } else if (/\b(obducite|material|runes|rune|scattered prism|forgotten soul|boss mats)\b/i.test(fullText)) {
    category = 'Materials';
  } else if (/\b(speed farm|speedfarm|pit speed|helltide route|undercity)\b/i.test(fullText)) {
    category = 'Speed Farming';
  } else if (/\b(build|meta|tier list|class)\b/i.test(fullText)) {
    category = 'Builds / Meta';
  }

  // Защита от ложных находок: баг-репортам и жалобам не место в Speed Farming / Builds
  if (contentType === 'bug_report' || contentType === 'discussion') {
    if (category === 'Speed Farming' || category === 'Builds / Meta' || category === 'Gear / Mythics') {
      category = 'Patch Changes';
    }
  }

  // Оценка полезности (Benefit Score)
  let benefitScore = 'Low';
  let benefitRank = 1;
  let benefitReason = 'Общая информация или обсуждение.';

  if (contentType === 'bug_report' || contentType === 'discussion') {
    benefitScore = 'Low';
    benefitRank = 1;
    benefitReason = 'Сообщение о проблеме или жалоба без прямого практического руководства к действию.';
    confidence = 'Unverified';
  } else if (contentType === 'exploit') {
    benefitScore = 'Medium';
    benefitRank = 2;
    benefitReason = 'Непроверенная механическая особенность или эксплойт. Требует осторожности.';
    confidence = 'Unverified';
  } else if (contentType === 'patch_notes') {
    benefitScore = 'High';
    benefitRank = 3;
    benefitReason = 'Официальные изменения баланса или механик игры.';
  } else if (contentType === 'build' || contentType === 'guide' || contentType === 'farming_method') {
    benefitScore = 'High';
    benefitRank = 3;
    benefitReason = 'Практическое руководство или актуальный билд для развития персонажа.';
  }

  // Расчет свежести (Freshness)
  let freshness = 'Unknown';
  if (publishedAt) {
    const pubDate = new Date(publishedAt);
    if (!isNaN(pubDate.getTime())) {
      const ageDays = (Date.now() - pubDate.getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays <= 30) freshness = 'Current';
      else freshness = 'Possibly outdated';
    }
  }

  if (contentType === 'exploit' && /\b(fixed|patched|hotfixed)\b/i.test(fullText)) {
    freshness = 'Patched';
  }

  const summary = cleanBody ? `${cleanBody.slice(0, 200)}…` : `Материал: ${cleanTitle}`;

  return {
    isRelevant: !(contentType === 'bug_report' && benefitScore === 'Low'),
    contentType,
    category,
    benefitScore,
    benefitRank,
    confidence,
    freshness,
    benefitReason,
    patchVersion: extractPatchOrSeason(fullText),
    requirements: extractRequirements(fullText),
    summary: decodeHtmlEntities(summary)
  };
}

// ============================================================================
// 4. ИСТОЧНИКИ И ПАРСИНГ
// ============================================================================
const SOURCES = [
  {
    id: 'blizz_news',
    name: 'Blizzard Official News',
    url: 'https://news.blizzard.com/en-us/feed/diablo-iv',
    type: 'official',
    parser: 'rss'
  },
  {
    id: 'blizz_forum',
    name: 'Blizzard Forum Discussion',
    url: 'https://us.forums.blizzard.com/en/d4/c/pc-general-discussion/5.json',
    type: 'community',
    parser: 'discourse'
  },
  {
    id: 'icy_veins',
    name: 'Icy Veins Diablo IV',
    url: 'https://www.icy-veins.com/forums/forum/155-diablo-4.xml/',
    type: 'curated_guide',
    parser: 'rss'
  }
];

function parseRss(xmlText, sourceName) {
  const items = [];
  const itemBlocks = xmlText.match(/<item[\s\S]*?<\/item>/gi) || xmlText.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of itemBlocks.slice(0, 20)) {
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const linkMatch = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || block.match(/<link[^>]+href=["']([^"']+)["']/i);
    const descMatch = block.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
    const dateMatch = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || block.match(/<published[^>]*>([\s\S]*?)<\/published>/i);

    const title = titleMatch ? decodeHtmlEntities(titleMatch[1]) : '';
    const url = linkMatch ? decodeHtmlEntities(linkMatch[1].replace(/<\/?span[^>]*>/g, '')) : '';
    const rawText = descMatch ? decodeHtmlEntities(descMatch[1]) : '';
    const publishedAt = dateMatch ? new Date(decodeHtmlEntities(dateMatch[1])).toISOString() : null;

    if (title && url) {
      items.push({ title, url, rawText, publishedAt, sourceName });
    }
  }
  return items;
}

function parseDiscourse(jsonData, sourceName) {
  const topics = jsonData?.topic_list?.topics || [];
  const items = [];
  for (const t of topics.slice(0, 20)) {
    if (!t.title || !t.slug || !t.id) continue;
    const url = `https://us.forums.blizzard.com/en/d4/t/${t.slug}/${t.id}`;
    const rawText = t.excerpt ? decodeHtmlEntities(t.excerpt) : '';
    const publishedAt = t.created_at ? new Date(t.created_at).toISOString() : null;
    items.push({ title: decodeHtmlEntities(t.title), url, rawText, publishedAt, sourceName });
  }
  return items;
}

async function runMonitoringCycle() {
  const nowIso = new Date().toISOString();
  let added = 0;

  const findStmt = db.prepare(`SELECT id FROM issues WHERE canonical_url = ?`);
  const insertStmt = db.prepare(`
    INSERT INTO issues (
      title, source, url, canonical_url, status, created_at,
      content_type, category, published_at, discovered_at, patch_version,
      summary, benefit_score, benefit_rank, confidence,
      freshness, benefit_reason, requirements
    ) VALUES (
      @title, @source, @url, @canonical_url, 'new', @discovered_at,
      @content_type, @category, @published_at, @discovered_at, @patch_version,
      @summary, @benefit_score, @benefit_rank, @confidence,
      @freshness, @benefit_reason, @requirements
    )
  `);

  for (const src of SOURCES) {
    try {
      const res = await fetch(src.url, { headers: { 'User-Agent': 'D4Strazh-Bot/2.0' } });
      if (!res.ok) continue;
      const text = await res.text();
      let rawItems = [];

      if (src.parser === 'rss') rawItems = parseRss(text, src.name);
      else if (src.parser === 'discourse') rawItems = parseDiscourse(JSON.parse(text), src.name);

      for (const item of rawItems) {
        const canonical = normalizeUrl(item.url);
        if (!canonical) continue;

        const analysis = analyzeAndClassifyItem({
          title: item.title,
          rawText: item.rawText,
          sourceUrl: item.url,
          sourceType: src.type,
          publishedAt: item.publishedAt
        });

        if (!analysis.isRelevant) continue;

        const existing = findStmt.get(canonical);
        if (!existing) {
          insertStmt.run({
            title: item.title,
            source: src.name,
            url: item.url,
            canonical_url: canonical,
            discovered_at: nowIso,
            published_at: item.publishedAt || null,
            content_type: analysis.contentType,
            category: analysis.category,
            patch_version: analysis.patchVersion,
            summary: analysis.summary,
            benefit_score: analysis.benefitScore,
            benefit_rank: analysis.benefitRank,
            confidence: analysis.confidence,
            freshness: analysis.freshness,
            benefit_reason: analysis.benefitReason,
            requirements: analysis.requirements
          });
          added++;
        }
      }
    } catch (e) {
      console.error(`Error fetching source ${src.id}:`, e.message);
    }
  }

  db.prepare(`
    INSERT INTO app_meta (key, value) VALUES ('last_check', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(nowIso);

  return { added };
}

// ============================================================================
// 5. API МАРШРУТЫ
// ============================================================================
app.get('/api/issues', (req, res) => {
  try {
    const { category, benefit, q } = req.query;
    let query = `SELECT * FROM issues WHERE benefit_rank > 0`;
    const params = {};

    if (category && category !== 'ALL') {
      query += ` AND category = @category`;
      params.category = category;
    }
    if (benefit && benefit !== 'ALL') {
      query += ` AND benefit_score = @benefit`;
      params.benefit = benefit;
    }
    if (q && q.trim()) {
      query += ` AND (title LIKE @q OR summary LIKE @q)`;
      params.q = `%${q.trim()}%`;
    }

    query += ` ORDER BY benefit_rank DESC, COALESCE(published_at, discovered_at) DESC LIMIT 100`;
    res.json(db.prepare(query).all(params));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/state', (req, res) => {
  try {
    const lastCheck = db.prepare(`SELECT value FROM app_meta WHERE key = 'last_check'`).get();
    const totalUseful = db.prepare(`SELECT COUNT(*) as cnt FROM issues WHERE benefit_rank > 0`).get().cnt;
    res.json({ lastCheck: lastCheck ? lastCheck.value : null, totalUsefulCount: totalUseful });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/refresh', async (req, res) => {
  try {
    const result = await runMonitoringCycle();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

cron.schedule('*/30 * * * *', () => {
  runMonitoringCycle().catch(err => console.error(err));
});

app.listen(PORT, () => {
  console.log(`[D4 Страж] Server running on port ${PORT}`);
});
