const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { parse: parseHtml } = require('node-html-parser');
const DomainCache = require('../models/DomainCache');

// Disguise the bot as a regular Chrome user on a Windows machine
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  // Override the strict security limits to allow large RSS feeds to parse safely
  processEntities: {
    maxTotalExpansions: 50000, // Default is only 1000
  }
});

const COMMON_FEED_PATHS = [
  '/feed', '/feed/', '/rss', '/rss.xml', '/atom.xml',
  '/index.xml', '/feed.xml', '/feeds/posts/default',
  '/?feed=rss2', '/blog/feed', '/news/feed',
];

const NOISE_SELECTORS = [
  'nav', 'header', 'footer', 'aside', 'script', 'style',
  'noscript', 'iframe', 'form', '.nav', '.header', '.footer',
  '.sidebar', '.menu', '.ad', '.advertisement', '.cookie',
  '.popup', '.modal', '.subscribe', '.newsletter', '#nav',
  '#header', '#footer', '#sidebar', '#menu',
];

const PAYWALL_SIGNALS = [
  /subscribe to (read|continue|access)/i,
  /this (article|content|story) is (for|available to) (subscribers|members)/i,
  /you('ve| have) reached your (free article|monthly) limit/i,
  /create a free account to continue/i,
  /sign in to read/i,
  /already a subscriber\?/i,
  /unlock (this|full) (article|story|content)/i,
  /premium content/i,
  /metered_paywall/i,
];

async function fetchText(url, timeout = 10000) {
  const res = await axios.get(url, {
    timeout,
    maxRedirects: 5,
    headers: { 'User-Agent': UA, Accept: '*/*' },
    responseType: 'text',
    transformResponse: [(d) => d],
    validateStatus: (s) => s >= 200 && s < 400,
  });
  return { data: res.data, contentType: res.headers['content-type'] || '' };
}

function isXmlContentType(ct) {
  return /xml|rss|atom/i.test(ct || '');
}

function looksLikeFeedXml(text) {
  if (!text) return false;
  const head = text.slice(0, 2000).toLowerCase();
  return head.includes('<rss') || head.includes('<feed') || head.includes('<rdf:rdf');
}

function originOf(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch { return null; }
}

function domainOf(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

async function discoverFeedUrl(websiteUrl) {
  try {
    const { data, contentType } = await fetchText(websiteUrl);
    if (isXmlContentType(contentType) || looksLikeFeedXml(data)) return websiteUrl;
    const root = parseHtml(data);
    const links = root.querySelectorAll('link[rel="alternate"]');
    for (const l of links) {
      const type = (l.getAttribute('type') || '').toLowerCase();
      const href = l.getAttribute('href');
      if (!href) continue;
      if (type.includes('rss') || type.includes('atom') || type.includes('xml')) {
        return new URL(href, websiteUrl).toString();
      }
    }
  } catch (e) { /* try common paths */ }

  const origin = originOf(websiteUrl);
  if (origin) {
    for (const p of COMMON_FEED_PATHS) {
      const candidate = origin + p;
      try {
        const { data, contentType } = await fetchText(candidate, 6000);
        if (isXmlContentType(contentType) || looksLikeFeedXml(data)) return candidate;
      } catch { /* keep trying */ }
    }
  }
  throw new Error('Could not discover RSS feed for ' + websiteUrl);
}

function pickFirst(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'object' && v['#text']) return String(v['#text']).trim();
  }
  return '';
}

function extractImage(item) {
  if (item.enclosure) {
    const enc = Array.isArray(item.enclosure) ? item.enclosure[0] : item.enclosure;
    const url = enc?.['@_url'];
    const type = enc?.['@_type'] || '';
    if (url && (!type || type.startsWith('image'))) return url;
  }
  const mt = item['media:thumbnail'] || item['media:content'];
  if (mt) {
    const m = Array.isArray(mt) ? mt[0] : mt;
    if (m?.['@_url']) return m['@_url'];
  }
  if (item['itunes:image']?.['@_href']) return item['itunes:image']['@_href'];
  const html = pickFirst(item['content:encoded'], item.content, item.description, item.summary);
  if (html) {
    const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m) return m[1];
  }
  return '';
}

function extractYouTubeId(item) {
  if (item['yt:videoId']) return String(item['yt:videoId']).trim();
  const link = pickFirst(item.link?.['@_href'], item.link, item.guid);
  if (link) {
    const m =
      link.match(/[?&]v=([A-Za-z0-9_-]{11})/) ||
      link.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) ||
      link.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
  }
  return '';
}

function normalizeItems(parsed) {
  let title = '';
  let entries = [];
  if (parsed.rss?.channel) {
    const ch = parsed.rss.channel;
    title = pickFirst(ch.title);
    entries = Array.isArray(ch.item) ? ch.item : ch.item ? [ch.item] : [];
  } else if (parsed.feed) {
    title = pickFirst(parsed.feed.title);
    entries = Array.isArray(parsed.feed.entry)
      ? parsed.feed.entry
      : parsed.feed.entry ? [parsed.feed.entry] : [];
  } else if (parsed['rdf:RDF']) {
    const r = parsed['rdf:RDF'];
    title = pickFirst(r.channel?.title);
    entries = Array.isArray(r.item) ? r.item : r.item ? [r.item] : [];
  }
  return { title, entries };
}

function isValidUrl(s) {
  if (!s || typeof s !== 'string') return false;
  try {
    const u = new URL(s.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function extractLink(e) {
  const candidates = [];
  if (typeof e.link === 'string') candidates.push(e.link);
  else if (Array.isArray(e.link)) {
    candidates.push(e.link[0]?.['@_href']);
    candidates.push(typeof e.link[0] === 'string' ? e.link[0] : null);
  } else if (e.link?.['@_href']) candidates.push(e.link['@_href']);
  if (e.guid) {
    const g = typeof e.guid === 'string' ? e.guid : e.guid['#text'];
    candidates.push(g);
  }
  for (const c of candidates) {
    const trimmed = (c || '').trim();
    if (isValidUrl(trimmed)) return trimmed;
  }
  return null;
}

function extractPublishDate(root) {
  const ogDate = root.querySelector('meta[property="article:published_time"]');
  if (ogDate?.getAttribute('content')) {
    const d = new Date(ogDate.getAttribute('content'));
    if (!isNaN(d)) return d;
  }
  const metaDate = root.querySelector('meta[name="date"], meta[name="publish-date"], meta[name="pubdate"]');
  if (metaDate?.getAttribute('content')) {
    const d = new Date(metaDate.getAttribute('content'));
    if (!isNaN(d)) return d;
  }
  const timeEl = root.querySelector('time[datetime]');
  if (timeEl?.getAttribute('datetime')) {
    const d = new Date(timeEl.getAttribute('datetime'));
    if (!isNaN(d)) return d;
  }
  return null;
}

async function findBestContainer(root, domain) {
  const cached = await DomainCache.findOne({ domain }).lean();
  if (cached?.containerSelector) {
    const el = root.querySelector(cached.containerSelector);
    if (el) return el;
  }

  const candidates = [
    'article', 'main', '[role="main"]', '.article-body', '.article-content',
    '.post-body', '.post-content', '.entry-content', '.story-body',
    '.story-content', '.content-body', '.article__body', '.article__content',
    '.post__content', '#article-body', '#story-body', '#content',
  ];

  let bestEl = null;
  let bestScore = 0;
  let bestSelector = null;

  for (const sel of candidates) {
    const el = root.querySelector(sel);
    if (!el) continue;
    const pTags = el.querySelectorAll('p');
    const score = pTags.reduce((acc, p) => acc + p.text.trim().length, 0);
    if (score > bestScore) {
      bestScore = score;
      bestEl = el;
      bestSelector = sel;
    }
  }

  if (bestSelector && bestScore > 200) {
    await DomainCache.findOneAndUpdate(
      { domain },
      { domain, containerSelector: bestSelector, lastUpdated: new Date() },
      { upsert: true }
    );
  }

  return bestEl || root.querySelector('body') || root;
}

/**
 * Split a flat list of heading/paragraph nodes into logical sections.
 * Each section: { heading: string|null, paragraphs: string[] }
 */
function chunkIntoSections(elements) {
  const sections = [];
  let current = { heading: null, paragraphs: [] };

  for (const el of elements) {
    const tag = el.tagName?.toLowerCase() || '';
    const text = el.text.replace(/\s+/g, ' ').trim();
    if (!text || text.length < 20) continue;

    if (/^h[1-6]$/.test(tag)) {
      // Save current section if it has content
      if (current.paragraphs.length > 0 || current.heading) {
        sections.push(current);
      }
      current = { heading: text, paragraphs: [] };
    } else {
      current.paragraphs.push(text);
    }
  }

  if (current.paragraphs.length > 0 || current.heading) {
    sections.push(current);
  }

  return sections;
}

async function fetchArticleText(url) {
  try {
    const { data: html } = await fetchText(url, 15000);
    const root = parseHtml(html);

    for (const sel of NOISE_SELECTORS) {
      root.querySelectorAll(sel).forEach((el) => el.remove());
    }

    const paywallInHtml = PAYWALL_SIGNALS.some((re) => re.test(html));
    const pubDate = extractPublishDate(root);
    const domain = domainOf(url);
    const container = await findBestContainer(root, domain);

    // Extract og:image / twitter:image for feeds that don't embed images in RSS
    const ogImage =
      root.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
      root.querySelector('meta[name="twitter:image"]')?.getAttribute('content') ||
      root.querySelector('meta[name="twitter:image:src"]')?.getAttribute('content') ||
      '';

    const elements = container.querySelectorAll('h1, h2, h3, h4, h5, h6, p');
    const sections = chunkIntoSections(Array.from(elements));

    // Build flat text for length checks (cap at 8000 chars)
    const fullText = sections
      .flatMap((s) => [s.heading, ...s.paragraphs].filter(Boolean))
      .join(' ')
      .slice(0, 8000);

    if (paywallInHtml && fullText.length < 200) {
      return { text: '', sections: [], paywall: true, pubDate, ogImage };
    }

    if (fullText.length < 150) {
      return { text: '', sections: [], paywall: true, pubDate, ogImage };
    }

    return { text: fullText, sections, paywall: false, pubDate, ogImage };
  } catch (e) {
    console.warn(`[rss] fetchArticleText failed for ${url}: ${e.message}`);
    return { text: '', sections: [], paywall: false, pubDate: null, ogImage: '' };
  }
}

function stripHtml(s) {
  if (!s) return '';
  if (typeof s !== 'string') s = String(s);
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

async function fetchAndParseFeed(feedUrl) {
  const { data } = await fetchText(feedUrl, 15000);
  const parsed = xmlParser.parse(data);
  const { title, entries } = normalizeItems(parsed);

  const items = entries
    .map((e) => {
      const link = extractLink(e);
      const pub = pickFirst(e.pubDate, e.published, e.updated, e['dc:date']) || new Date().toISOString();
      
      // Extract un-sliced description and explicitly extract the full content
      const description = pickFirst(e.description, e.summary, e['content:encoded'], e.content);
      const content = pickFirst(e['content:encoded'], e.content, e.description, e.summary);

      return {
        title: pickFirst(e.title) || '(untitled)',
        link,
        description: stripHtml(description),
        content: stripHtml(content),
        pubDate: pub,
        imageUrl: extractImage(e),
        youtubeId: extractYouTubeId(e),
      };
    })
    .filter((item) => item.link);

  return { title, items };
}

async function discoverFavicon(websiteUrl) {
  try {
    const origin = originOf(websiteUrl);
    if (!origin) return '';
    // Try standard favicon locations
    const candidates = [
      `${origin}/favicon.ico`,
      `${origin}/favicon.png`,
    ];
    // Also check HTML <link rel="icon"> tags
    try {
      const { data } = await fetchText(websiteUrl, 8000);
      const root = parseHtml(data);
      const iconLinks = root.querySelectorAll('link[rel~="icon"], link[rel~="shortcut"]');
      for (const l of iconLinks) {
        const href = l.getAttribute('href');
        if (href) candidates.unshift(new URL(href, websiteUrl).toString());
      }
    } catch {}
    for (const url of candidates) {
      try {
        const res = await axios.head(url, { timeout: 5000, validateStatus: (s) => s < 400, headers: { 'User-Agent': UA } });
        if (res.status < 400) return url;
      } catch {}
    }
  } catch {}
  return '';
}

module.exports = { fetchAndParseFeed, fetchArticleText, discoverFeedUrl, discoverFavicon };
