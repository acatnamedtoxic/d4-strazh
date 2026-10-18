const express = require('express');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// 1. ИНИЦИАЛИЗАЦИЯ И БЕЗОПАСНАЯ МИГРАЦИЯ БАЗЫ ДАННЫХ SQLITE
// ============================================================================
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

function initAndMigrateDB() {
  // Базовая таблица (совместимость со старой схемой)
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

  // Таблица состояния источников
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

  // Таблица системного состояния (время проверки, текущий патч)
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Безопасное добавление новых колонок без потери данных
  const existingCols = db.prepare(`PRAGMA table_info(issues)`).all().map(c => c.name);

  const newColumns = [
    { name: 'canonical_url', type: 'TEXT' },
    { name: 'category', type: "TEXT DEFAULT 'XP / Paragon'" },
    { name: 'published_at', type: 'TEXT' },
    { name: 'discovered_at', type: 'TEXT' },
    { name: 'patch_version', type: "TEXT DEFAULT 'Unknown'" },
    { name: 'summary', type: 'TEXT' },
    { name: 'benefit_score', type: "TEXT DEFAULT 'Medium'" },
    { name: 'benefit_rank', type: 'INTEGER DEFAULT 2' }, // 3=High, 2=Medium, 1=Low, 0=Noise
    { name: 'confidence', type: "TEXT DEFAULT 'Community report'" },
    { name: 'freshness', type: "TEXT DEFAULT 'Current'" },
    { name: 'benefit_reason', type: 'TEXT' },
    { name: 'requirements', type: 'TEXT' }
  ];

  for (const col of newColumns) {
    if (!existingCols.includes(col.name)) {
      db.exec(`ALTER TABLE issues ADD COLUMN ${col.name} ${col.type}`);
    }
  }

  // Индексы для быстрой фильтрации и дедупликации
  db.exec(`CREATE INDEX IF NOT EXISTS idx_issues_canonical ON issues(canonical_url);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_issues_category ON issues(category);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_issues_benefit ON issues(benefit_rank);`);

  // Ретроспективная нормализация старых записей (если они ещё не классифицированы)
  const unmigrated = db.prepare(`SELECT * FROM issues WHERE canonical_url IS NULL`).all();
  if (unmigrated.length > 0) {
    const updateStmt = db.prepare(`
      UPDATE issues SET
        canonical_url = @canonical_url,
        category = @category,
        published_at = @published_at,
        discovered_at = @discovered_at,
        patch_version = @patch_version,
        summary = @summary,
        benefit_score = @benefit_score,
        benefit_rank = @benefit_rank,
        confidence = @confidence,
        freshness = @freshness,
        benefit_reason = @benefit_reason,
        requirements = @requirements,
        status = @status
      WHERE id = @id
    `);

    const migrateTx = db.transaction((rows) => {
      for (const row of rows) {
        const canonical = normalizeUrl(row.url);
        const analysis = analyzeAndClassifyItem({
          title: row.title,
          rawText: '',
          sourceName: row.source || 'Legacy',
          sourceType: 'community',
          url: row.url,
          publishedAt: row.created_at
        });

        updateStmt.run({
          id: row.id,
          canonical_url: canonical,
          category: analysis.isRelevant ? analysis.category : 'Filtered / Noise',
          published_at: row.created_at,
          discovered_at: row.created_at,
          patch_version: analysis.patchVersion,
          summary: analysis.summary,
          benefit_score: analysis.benefitScore,
          benefit_rank: analysis.isRelevant ? analysis.benefitRank : 0,
          confidence: analysis.confidence,
          freshness: analysis.freshness,
          benefit_reason: analysis.benefitReason,
          requirements: analysis.requirements,
          status: analysis.isRelevant ? (row.status || 'active') : 'archived_noise'
        });
      }
    });
    migrateTx(unmigrated);
  }
}

initAndMigrateDB();

// ============================================================================
// 2. УТИЛИТЫ НОРМАЛИЗАЦИИ И ИЗВЛЕЧЕНИЯ ДАННЫХ
// ============================================================================
function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl.trim());
    u.hash = '';
    const stripParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'context'];
    stripParams.forEach(p => u.searchParams.delete(p));
    let clean = u.origin + u.pathname.replace(/\/+$/, '');
    const search = u.searchParams.toString();
    return search ? `${clean}?${search}` : clean;
  } catch {
    return (rawUrl || '').trim();
  }
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPatchOrSeason(text) {
  const combined = text || '';
  const patchMatch = combined.match(/\b(?:patch|hotfix|update|v)?\s*(\d+\.\d+\.\d+[a-z]?)\b/i);
  const seasonMatch = combined.match(/\b(?:season\s*(\d+)|s(\d{1,2}))\b/i);

  const parts = [];
  if (seasonMatch) {
    const sNum = seasonMatch[1] || seasonMatch[2];
    parts.push(`Season ${sNum}`);
  }
  if (patchMatch) {
    parts.push(`Patch ${patchMatch[1]}`);
  }
  return parts.length > 0 ? parts.join(' / ') : 'Не указана в источнике';
}

function extractRequirements(text) {
  if (!text) return 'Нет особых условий в источнике';
  const reqs = [];

  const classes = [
    { rx: /\b(spiritborn|спиритборн|наследник духов)\b/i, label: 'Класс: Spiritborn' },
    { rx: /\b(barbarian|варвар|barb)\b/i, label: 'Класс: Barbarian' },
    { rx: /\b(sorcerer|sorceress|sorc|волшебн)\b/i, label: 'Класс: Sorcerer' },
    { rx: /\b(rogue|разбойни)\b/i, label: 'Класс: Rogue' },
    { rx: /\b(necromancer|necro|некромант)\b/i, label: 'Класс: Necromancer' },
    { rx: /\b(druid|друид)\b/i, label: 'Класс: Druid' }
  ];
  classes.forEach(c => { if (c.rx.test(text)) reqs.push(c.label); });

  const tormentMatch = text.match(/\b(torment\s*(?:1|2|3|4|I|II|III|IV)|t[1-4])\b/i);
  if (tormentMatch) reqs.push(`Сложность: ${tormentMatch[1].toUpperCase()}`);

  const pitMatch = text.match(/\b(pit\s*(?:tier\s*)?\d+|яма\s*\d+)\b/i);
  if (pitMatch) reqs.push(`Активность: ${pitMatch[1]}`);

  if (/\b(infernal hordes|адские орды)\b/i.test(text)) reqs.push('Активность: Infernal Hordes');
  if (/\b(undercity|kurast undercity|подземный город)\b/i.test(text)) reqs.push('Активность: Kurast Undercity');
  if (/\b(dark citadel|темная цитадель)\b/i.test(text)) reqs.push('Активность: Dark Citadel');
  if (/\b(helltide|адский натиск)\b/i.test(text)) reqs.push('Активность: Helltide');

  const resplendent = /\b(resplendent spark|ослепительная искра)\b/i.test(text);
  if (resplendent) reqs.push('Ресурс: Resplendent Spark');

  return reqs.length > 0 ? reqs.join(' • ') : 'Условия не уточнены в источнике';
}

// ============================================================================
// 3. УМНАЯ КЛАССИФИКАЦИЯ И ФИЛЬТРАЦИЯ ШУМА
// ============================================================================
function analyzeAndClassifyItem({ title, rawText, sourceName, sourceType, url, publishedAt }) {
  const cleanTitle = stripHtml(title);
  const cleanBody = stripHtml(rawText).slice(0, 600);
  const fullText = `${cleanTitle} ${cleanBody}`.toLowerCase();

  // 1. Отсев нерелевантных багов, жалоб и технических проблем
  const noisePatterns = [
    /\b(can't equip|cannot equip|unable to equip|won't let me equip)\b/i,
    /\b(crash|crashing|bsod|disconnect|error code|login failed|fps drop|stuttering|lagging)\b/i,
    /\b(transmog|cosmetic|shop rotation|mount trophy|voice acting|cutscene)\b/i,
    /\b(ban appeal|account suspended|refund|billing|launcher issue)\b/i,
    /\b(missing item|disappeared from stash|lost my character|rubberbanding)\b/i
  ];

  // Исключение: если это явный эксплойт/дюп или официальный патчноут — не блокируем как бытовую жалобу
  const isExploitSignal = /\b(exploit|dupe|duplication|infinite\s+(?:gold|xp|damage|materials)|bugged interaction|double dipping)\b/i.test(fullText);
  const isOfficialPatch = sourceType === 'official' || /\b(patch notes|hotfix|balance update)\b/i.test(fullText);

  if (!isExploitSignal && !isOfficialPatch) {
    for (const rx of noisePatterns) {
      if (rx.test(fullText)) {
        return { isRelevant: false, reason: 'Tech issue or equipment complaint' };
      }
    }
  }

  // 2. Проверка на PTR и устаревший контент
  const isPtr = /\b(ptr|public test realm|тестовый сервер)\b/i.test(fullText);
  let freshness = 'Current';
  if (publishedAt) {
    const pubDate = new Date(publishedAt);
    if (!isNaN(pubDate.getTime())) {
      const ageDays = (Date.now() - pubDate.getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays > 45) freshness = 'Possibly outdated';
    }
  } else {
    freshness = 'Unknown';
  }

  if (/\b(fixed an issue|patched|hotfixed|no longer works|nerfed|disabled trading)\b/i.test(fullText) && isExploitSignal) {
    freshness = 'Patched';
  }

  // Если это старый PTR материал (старше 14 дней) — отсеиваем
  if (isPtr && freshness === 'Possibly outdated') {
    return { isRelevant: false, reason: 'Outdated PTR material' };
  }

  // 3. Определение категории по строгим правилам намерения (Intent)
  let category = null;
  let benefitScore = 'Medium';
  let benefitRank = 2;
  let benefitReason = '';

  if (isOfficialPatch && /\b(patch|hotfix|update|notes|balance|drop rate|xp|experience)\b/i.test(fullText)) {
    category = 'Patch Changes';
    benefitScore = 'High';
    benefitRank = 3;
    benefitReason = 'Официальные изменения баланса, механик или шансов выпадения влияют на эффективность текущего фарма.';
  } else if (isExploitSignal) {
    category = 'Exploits';
    benefitScore = freshness === 'Patched' ? 'Low' : 'High';
    benefitRank = freshness === 'Patched' ? 1 : 3;
    benefitReason = 'Нестандартная механика, баг взаимодействия множителей или дюп, обсуждаемый сообществом (требует осторожности).';
  } else if (
    /\b(xp|experience|paragon|leveling|1-60|powerlevel|fast level|glyph xp|pit leveling)\b/i.test(fullText) &&
    /\b(guide|farm|fast|route|best|tier|efficiency|how to|method|strategy|buff|xp\/hr)\b/i.test(fullText)
  ) {
    category = 'XP / Paragon';
    benefitScore = /\b(paragon\s*2\d\d|paragon\s*300|fastest|best|route|tier)\b/i.test(fullText) ? 'High' : 'Medium';
    benefitRank = benefitScore === 'High' ? 3 : 2;
    benefitReason = 'Помогает ускорить прокачку уровней персонажа, глифов или Paragon-уровней.';
  } else if (
    /\b(mythic|uber unique|shako|harlequin|tyrael|starless|doombringer|andariel|duriel|tormented boss|lair boss|target farm|ancestral|greater affix|ga\b|unique drop)\b/i.test(fullText) &&
    !/\b(can't|cannot|missing|transmog)\b/i.test(fullText)
  ) {
    category = 'Gear / Mythics';
    benefitScore = /\b(mythic|target farm|drop rate|resplendent spark|boss loot|tribute)\b/i.test(fullText) ? 'High' : 'Medium';
    benefitRank = benefitScore === 'High' ? 3 : 2;
    benefitReason = 'Прямая информация о целевом фарме Mythic-предметов, боссов, искр (Sparks) или предметов с Greater Affixes.';
  } else if (
    /\b(obducite|masterwork|masterworking|forgotten soul|scattered prism|rawhide|iron chunk|gem fragment|runes|rune farm|boss mats|living steel|exquisite blood|distilled fear|malignant heart)\b/i.test(fullText)
  ) {
    category = 'Materials';
    benefitScore = /\b(obducite|rawhide|iron chunk|boss mats|best way|farm|fast)\b/i.test(fullText) ? 'High' : 'Medium';
    benefitRank = benefitScore === 'High' ? 3 : 2;
    benefitReason = 'Оптимизация сбора дефицитных ресурсов для Masterworking, крафта рун или призыва боссов.';
  } else if (
    /\b(gold|billion|million|trading|trade market|diablo\.trade|whisper cache|sell|economy)\b/i.test(fullText) &&
    /\b(farm|make|earn|fast|guide|method|trade|gold per hour|best)\b/i.test(fullText)
  ) {
    category = 'Gold';
    benefitScore = 'Medium';
    benefitRank = 2;
    benefitReason = 'Способ легального ускорения фарма золота или выгодной торговли предметами с игроками.';
  } else if (
    /\b(speedfarm|speed farm|farming route|helltide route|undercity tribute|infernal hordes|kurast|cinders|aether|pit speed|loop|rotation)\b/i.test(fullText)
  ) {
    category = 'Speed Farming';
    benefitScore = /\b(aether|tribute|tier|fastest|optimal|loop)\b/i.test(fullText) ? 'High' : 'Medium';
    benefitRank = benefitScore === 'High' ? 3 : 2;
    benefitReason = 'Оптимизация цикла зачистки активностей (Hordes, Undercity, Pit, Helltide) за минимальное время.';
  } else if (
    /\b(build|tier list|meta|endgame|starter|leveling build|s-tier|overpower|victimize|quill volley|evade|spiritborn|barbarian|sorcerer|necromancer|rogue|druid)\b/i.test(fullText) &&
    /\b(guide|tier|meta|best|update|build|setup|planner|maxroll|icy veins|wowhead)\b/i.test(fullText)
  ) {
    category = 'Builds / Meta';
    benefitScore = /\b(s-tier|meta|tier list|best|broken|top)\b/i.test(fullText) ? 'High' : 'Medium';
    benefitRank = benefitScore === 'High' ? 3 : 2;
    benefitReason = 'Актуальная сборка персонажа или изменение меты, повышающее урон и скорость зачистки контента.';
  }

  // Если запись не попала ни в одну из 8 практических категорий прогресса — отфильтровываем
  if (!category) {
    return { isRelevant: false, reason: 'No actionable progression value detected' };
  }

  // 4. Определение уровня достоверности (Confidence)
  let confidence = 'Community report';
  if (sourceType === 'official') {
    confidence = 'Official';
  } else if (sourceType === 'curated_guide') {
    confidence = 'Verified by source';
  } else if (category === 'Exploits') {
    confidence = 'Unverified';
  }

  // 5. Формирование краткого объяснения (без выдумывания цифр)
  let summary = cleanBody
    ? cleanBody.slice(0, 240) + (cleanBody.length > 240 ? '…' : '')
    : `Материал из источника «${sourceName}» по теме «${category}»: ${cleanTitle}. Откройте первоисточник для изучения точных параметров.`;

  if (category === 'Exploits' && confidence === 'Unverified') {
    summary = `[НЕПРОВЕРЕННАЯ ИНФОРМАЦИЯ / РИСК] ${summary}`;
  }

  return {
    isRelevant: true,
    category,
    benefitScore,
    benefitRank,
    confidence,
    freshness,
    benefitReason,
    patchVersion: extractPatchOrSeason(fullText),
    requirements: extractRequirements(fullText),
    summary
  };
}

// ============================================================================
// 4. ИСТОЧНИКИ И БЕЗОПАСНЫЙ СБОР ДАННЫХ (БЕЗ ОБХОДА ЗАЩИТ И 403)
// ============================================================================
const SOURCES = [
  {
    id: 'blizz_news',
    name: 'Blizzard Official News / Patch Notes',
    url: 'https://news.blizzard.com/en-us/feed/diablo-iv',
    fallbackUrl: 'https://us.forums.blizzard.com/en/d4/c/announcements/6.json',
    type: 'official',
    parser: 'blizz_official'
  },
  {
    id: 'blizz_forum_general',
    name: 'Blizzard Forum (General & Mechanics)',
    url: 'https://us.forums.blizzard.com/en/d4/c/pc-general-discussion/5.json',
    type: 'community',
    parser: 'discourse_json'
  },
  {
    id: 'blizz_forum_bugs',
    name: 'Blizzard Forum (Bug Report & Exploits)',
    url: 'https://us.forums.blizzard.com/en/d4/c/bug-report/7.json',
    type: 'community',
    parser: 'discourse_json'
  },
  {
    id: 'icy_veins_d4',
    name: 'Icy Veins (Diablo IV News & Guides)',
    url: 'https://www.icy-veins.com/forums/forum/155-diablo-4.xml/',
    type: 'curated_guide',
    parser: 'rss_xml'
  },
  {
    id: 'wowhead_d4',
    name: 'Wowhead D4 (Guides, Meta & Patch Analysis)',
    url: 'https://www.wowhead.com/diablo-4/news/rss',
    type: 'curated_guide',
    parser: 'rss_xml'
  },
  {
    id: 'maxroll_d4',
    name: 'Maxroll D4 (Builds & Farming Meta)',
    url: 'https://maxroll.gg/d4/news',
    type: 'curated_guide',
    parser: 'safe_html_or_rss'
  },
  {
    id: 'reddit_d4',
    name: 'Reddit r/diablo4 (Public Feed)',
    url: 'https://www.reddit.com/r/diablo4/hot.json?limit=25',
    type: 'community',
    parser: 'reddit_json'
  }
];

function parseRssXml(xmlText, sourceName) {
  const items = [];
  const itemBlocks = xmlText.match(/<item[\s\S]*?<\/item>/gi) || xmlText.match(/<entry[\s\S]*?<\/entry>/gi) || [];

  for (const block of itemBlocks.slice(0, 30)) {
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const linkMatch = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || block.match(/<link[^>]+href=["']([^"']+)["']/i);
    const descMatch = block.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
    const dateMatch = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || block.match(/<published[^>]*>([\s\S]*?)<\/published>/i) || block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i);

    const title = titleMatch ? stripHtml(titleMatch[1]) : '';
    const url = linkMatch ? stripHtml(linkMatch[1]) : '';
    const rawText = descMatch ? stripHtml(descMatch[1]) : '';
    const publishedAt = dateMatch ? new Date(stripHtml(dateMatch[1])).toISOString() : null;

    if (title && url) {
      items.push({ title, url, rawText, publishedAt, sourceName });
    }
  }
  return items;
}

function parseDiscourseJson(jsonData, baseUrl, sourceName) {
  const topics = jsonData?.topic_list?.topics || [];
  const items = [];

  for (const t of topics.slice(0, 35)) {
    if (!t.title || !t.slug || !t.id) continue;
    const url = `https://us.forums.blizzard.com/en/d4/t/${t.slug}/${t.id}`;
    const rawText = t.excerpt ? stripHtml(t.excerpt) : `Просмотров: ${t.views || 0}, Ответов: ${t.posts_count || 1}.`;
    const publishedAt = t.created_at ? new Date(t.created_at).toISOString() : null;
    items.push({
      title: t.title,
      url,
      rawText,
      publishedAt,
      sourceName
    });
  }
  return items;
}

function parseRedditJson(jsonData, sourceName) {
  const children = jsonData?.data?.children || [];
  const items = [];
  for (const child of children) {
    const d = child?.data;
    if (!d || d.stickied) continue;
    const publishedAt = d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null;
    items.push({
      title: d.title,
      url: `https://www.reddit.com${d.permalink}`,
      rawText: (d.selftext || '').slice(0, 500),
      publishedAt,
      sourceName
    });
  }
  return items;
}

function parseSafeHtmlLinks(htmlText, baseOrigin, sourceName) {
  const items = [];
  const anchorRegex = /<a[^>]+href=["']([^"']*\/d4\/(?:news|build-guides|resources|tierlists)\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  const seen = new Set();

  while ((match = anchorRegex.exec(htmlText)) !== null && items.length < 25) {
    let href = match[1];
    if (href.startsWith('/')) href = baseOrigin + href;
    if (seen.has(href)) continue;
    seen.add(href);

    const text = stripHtml(match[2]);
    if (text && text.length > 12) {
      items.push({
        title: text,
        url: href,
        rawText: '',
        publishedAt: null,
        sourceName
      });
    }
  }
  return items;
}

async function fetchWithTimeout(url, timeoutMs = 10000) {
  return fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'User-Agent': 'D4Strazh-ProgressionDashboard/2.0 (+https://d4-strazh.onrender.com)',
      'Accept': 'application/json, application/rss+xml, application/xml, text/xml, text/html;q=0.8'
    }
  });
}

const delay = (ms) => new Promise(res => setTimeout(res, ms));

let isRefreshing = false;

// Переоценка старых записей при выходе нового официального патча
function reEvaluateExistingOnNewPatch(patchTitle, patchText) {
  const combined = `${patchTitle} ${patchText}`.toLowerCase();
  const isHotfixOrPatch = /\b(patch|hotfix|update|notes)\b/i.test(combined);
  if (!isHotfixOrPatch) return;

  // Если патчноут явно упоминает исправление эксплойтов/багов, помечаем старые Unverified Exploits как Possibly outdated или Patched
  if (/\b(fixed an issue|exploit|stability|duplication|damage scaling)\b/i.test(combined)) {
    db.prepare(`
      UPDATE issues
      SET freshness = 'Patched'
      WHERE category = 'Exploits' AND freshness = 'Current'
    `).run();
  }

  // Помечаем гайды старше 45 дней как Possibly outdated
  db.prepare(`
    UPDATE issues
    SET freshness = 'Possibly outdated'
    WHERE freshness = 'Current'
      AND published_at IS NOT NULL
      AND julianday('now') - julianday(published_at) > 45
  `).run();
}

async function runMonitoringCycle() {
  if (isRefreshing) {
    return { skipped: true, message: 'Цикл проверки уже выполняется' };
  }

  isRefreshing = true;
  let newAddedCount = 0;
  let updatedCount = 0;

  const upsertHealthStmt = db.prepare(`
    INSERT INTO source_health (source_id, name, url, http_status, health_state, last_checked, items_found, error_message)
    VALUES (@source_id, @name, @url, @http_status, @health_state, @last_checked, @items_found, @error_message)
    ON CONFLICT(source_id) DO UPDATE SET
      http_status = excluded.http_status,
      health_state = excluded.health_state,
      last_checked = excluded.last_checked,
      items_found = excluded.items_found,
      error_message = excluded.error_message
  `);

  const findByCanonicalStmt = db.prepare(`SELECT id, title, summary, freshness FROM issues WHERE canonical_url = ?`);

  const insertIssueStmt = db.prepare(`
    INSERT INTO issues (
      title, source, url, canonical_url, status, created_at,
      category, published_at, discovered_at, patch_version,
      summary, benefit_score, benefit_rank, confidence,
      freshness, benefit_reason, requirements
    ) VALUES (
      @title, @source, @url, @canonical_url, 'new', @discovered_at,
      @category, @published_at, @discovered_at, @patch_version,
      @summary, @benefit_score, @benefit_rank, @confidence,
      @freshness, @benefit_reason, @requirements
    )
  `);

  const updateExistingStmt = db.prepare(`
    UPDATE issues SET
      freshness = @freshness,
      patch_version = CASE WHEN @patch_version != 'Не указана в источнике' THEN @patch_version ELSE patch_version END
    WHERE id = @id
  `);

  try {
    for (const src of SOURCES) {
      const nowIso = new Date().toISOString();
      let rawItems = [];
      let httpStatus = 0;
      let healthState = 'ok';
      let errorMsg = null;

      try {
        let res = await fetchWithTimeout(src.url, 10000);
        httpStatus = res.status;

        // Если основной RSS Blizzard недоступен, используем официальный JSON-форум анонсов Blizzard
        if (!res.ok && src.fallbackUrl) {
          res = await fetchWithTimeout(src.fallbackUrl, 10000);
          httpStatus = res.status;
        }

        if (res.status === 403 || res.status === 401 || res.status === 429) {
          healthState = 'restricted';
          errorMsg = `HTTP ${res.status}: Доступ ограничен защитой сайта (WAF / Rate Limit). Обход блокировок отключён по правилам безопасности.`;
        } else if (!res.ok) {
          healthState = 'error';
          errorMsg = `HTTP ${res.status}: Ошибка ответа сервера`;
        } else {
          const bodyText = await res.text();
          if (src.parser === 'discourse_json') {
            rawItems = parseDiscourseJson(JSON.parse(bodyText), src.url, src.name);
          } else if (src.parser === 'reddit_json') {
            rawItems = parseRedditJson(JSON.parse(bodyText), src.name);
          } else if (src.parser === 'rss_xml') {
            rawItems = parseRssXml(bodyText, src.name);
          } else if (src.parser === 'blizz_official') {
            if (bodyText.trim().startsWith('{')) {
              rawItems = parseDiscourseJson(JSON.parse(bodyText), src.fallbackUrl, src.name);
            } else {
              rawItems = parseRssXml(bodyText, src.name);
            }
          } else if (src.parser === 'safe_html_or_rss') {
            rawItems = parseSafeHtmlLinks(bodyText, 'https://maxroll.gg', src.name);
          }
        }
      } catch (err) {
        healthState = 'error';
        errorMsg = err.name === 'TimeoutError' ? 'Таймаут запроса (10 сек)' : (err.message || 'Ошибка сети');
      }

      let acceptedForSource = 0;

      for (const item of rawItems) {
        const canonical = normalizeUrl(item.url);
        if (!canonical) continue;

        const analysis = analyzeAndClassifyItem({
          title: item.title,
          rawText: item.rawText,
          sourceName: src.name,
          sourceType: src.type,
          url: item.url,
          publishedAt: item.publishedAt
        });

        if (!analysis.isRelevant) continue;
        acceptedForSource++;

        const existing = findByCanonicalStmt.get(canonical);
        if (existing) {
          updateExistingStmt.run({
            id: existing.id,
            freshness: analysis.freshness,
            patch_version: analysis.patchVersion
          });
          updatedCount++;
        } else {
          insertIssueStmt.run({
            title: item.title,
            source: src.name,
            url: item.url,
            canonical_url: canonical,
            discovered_at: nowIso,
            published_at: item.publishedAt || null,
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
          newAddedCount++;

          if (analysis.category === 'Patch Changes') {
            reEvaluateExistingOnNewPatch(item.title, item.rawText);
          }
        }
      }

      upsertHealthStmt.run({
        source_id: src.id,
        name: src.name,
        url: src.url,
        http_status: httpStatus,
        health_state: healthState,
        last_checked: nowIso,
        items_found: acceptedForSource,
        error_message: errorMsg
      });

      // Вежливая пауза между запросами к внешним сайтам (Rate Limiting)
      await delay(1200);
    }

    const finishedIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO app_meta (key, value) VALUES ('last_check', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(finishedIso);

    db.prepare(`
      INSERT INTO app_meta (key, value) VALUES ('last_new_count', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(newAddedCount));

    return {
      skipped: false,
      newAddedCount,
      updatedCount,
      lastCheck: finishedIso
    };
  } finally {
    isRefreshing = false;
  }
}

// ============================================================================
// 5. HTTP МАРШРУТЫ API (С СОХРАНЕНИЕМ ОБРАТНОЙ СОВМЕСТИМОСТИ)
// ============================================================================

// GET /api/issues — поддержка фильтрации, поиска и умной сортировки
app.get('/api/issues', (req, res) => {
  try {
    const {
      category,
      benefit,
      confidence,
      freshness,
      q,
      sort = 'smart',
      include_noise = 'false'
    } = req.query;

    const conditions = [];
    const params = {};

    if (include_noise !== 'true') {
      conditions.push(`status != 'archived_noise' AND benefit_rank > 0`);
    }
    if (category && category !== 'ALL') {
      conditions.push(`category = @category`);
      params.category = category;
    }
    if (benefit && benefit !== 'ALL') {
      conditions.push(`benefit_score = @benefit`);
      params.benefit = benefit;
    }
    if (confidence && confidence !== 'ALL') {
      conditions.push(`confidence = @confidence`);
      params.confidence = confidence;
    }
    if (freshness && freshness !== 'ALL') {
      conditions.push(`freshness = @freshness`);
      params.freshness = freshness;
    }
    if (q && q.trim() !== '') {
      conditions.push(`(title LIKE @q OR summary LIKE @q OR benefit_reason LIKE @q OR requirements LIKE @q)`);
      params.q = `%${q.trim()}%`;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    let orderClause = `ORDER BY benefit_rank DESC, COALESCE(published_at, discovered_at, created_at) DESC`;
    if (sort === 'date') {
      orderClause = `ORDER BY COALESCE(published_at, discovered_at, created_at) DESC`;
    } else if (sort === 'benefit') {
      orderClause = `ORDER BY benefit_rank DESC, id DESC`;
    }

    const rows = db.prepare(`
      SELECT
        id, title, source, url, canonical_url, status, created_at,
        category, published_at, discovered_at, patch_version,
        summary, benefit_score, benefit_rank, confidence,
        freshness, benefit_reason, requirements
      FROM issues
      ${whereClause}
      ${orderClause}
      LIMIT 250
    `).all(params);

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка чтения находок из базы данных', details: err.message });
  }
});

// GET /api/state — сводка состояния, статус источников, время проверки, счётчики
app.get('/api/state', (req, res) => {
  try {
    const lastCheckRow = db.prepare(`SELECT value FROM app_meta WHERE key = 'last_check'`).get();
    const lastNewRow = db.prepare(`SELECT value FROM app_meta WHERE key = 'last_new_count'`).get();
    const sources = db.prepare(`SELECT * FROM source_health ORDER BY name ASC`).all();

    const totalUseful = db.prepare(`SELECT COUNT(*) as cnt FROM issues WHERE status != 'archived_noise' AND benefit_rank > 0`).get().cnt;
    const newUnread = db.prepare(`SELECT COUNT(*) as cnt FROM issues WHERE status = 'new' AND benefit_rank > 0`).get().cnt;

    const byCategory = db.prepare(`
      SELECT category, COUNT(*) as count
      FROM issues
      WHERE status != 'archived_noise' AND benefit_rank > 0
      GROUP BY category
    `).all();

    res.json({
      isRefreshing,
      lastCheck: lastCheckRow ? lastCheckRow.value : null,
      lastCycleNewCount: lastNewRow ? Number(lastNewRow.value) : 0,
      totalUsefulCount: totalUseful,
      newFindingsCount: newUnread,
      categoriesBreakdown: byCategory,
      sources
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка получения состояния системы', details: err.message });
  }
});

// POST и GET /api/refresh — ручной запуск обновления с защитой от параллельных вызовов
async function handleRefresh(req, res) {
  try {
    if (isRefreshing) {
      return res.status(429).json({
        ok: false,
        isRefreshing: true,
        message: 'Проверка уже выполняется в фоновом режиме. Подождите завершения.'
      });
    }
    const result = await runMonitoringCycle();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Ошибка при обновлении источников', details: err.message });
  }
}

app.post('/api/refresh', handleRefresh);
app.get('/api/refresh', handleRefresh);

// Отметка находки как прочитанной (опционально для удобства в UI)
app.post('/api/issues/:id/seen', (req, res) => {
  try {
    db.prepare(`UPDATE issues SET status = 'seen' WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Фоновое расписание: каждые 30 минут
cron.schedule('*/30 * * * *', () => {
  runMonitoringCycle().catch(err => console.error('[CRON ERROR]', err.message));
});

app.listen(PORT, () => {
  console.log(`[D4 Страж] Progression Intelligence Dashboard запущен на порту ${PORT}`);
  // Первичный неблокирующий запуск при старте, если источники ещё ни разу не проверялись
  const checkedCount = db.prepare(`SELECT COUNT(*) as c FROM source_health`).get().c;
  if (checkedCount === 0) {
    runMonitoringCycle().catch(err => console.error('[INITIAL SYNC ERROR]', err.message));
  }
});
