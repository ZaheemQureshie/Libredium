require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const cache = new NodeCache({ stdTTL: 600 }); // 10 min cache

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Known Medium domains (for better Scribe/Googlebot handling) ───────────────
const KNOWN_MEDIUM_DOMAINS = [
  'medium.com',
  'towardsdatascience.com',
  'betterhumans.pub',
  'betterprogramming.pub',
  'levelup.gitconnected.com',
  'medium.verylazytech.com',
];

function isKnownMediumDomain(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    return KNOWN_MEDIUM_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

// ─── Header sets ──────────────────────────────────────────────────────────────
const GOOGLEBOT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  Referer: 'https://www.google.com/',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Cache-Control': 'no-cache',
};

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};

// ─── Parse article HTML with Cheerio ──────────────────────────────────────────
function parseArticle(html, source) {
  const $ = cheerio.load(html);

  // Remove junk
  $('[data-testid="paywall"]').remove();
  $('.meteredContent').remove();
  $('script').remove();
  $('style').remove();
  $('[class*="paywall"]').remove();
  $('[id*="paywall"]').remove();
  $('footer').remove();
  $('nav').remove();
  $('[role="banner"]').remove();
  $('header').remove();
  $('iframe').remove();

  // Title
  const title =
    $('h1').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').text().trim() ||
    'Untitled';

  // Author
  const author =
    $('[data-testid="authorName"]').first().text().trim() ||
    $('meta[name="author"]').attr('content') ||
    $('a[rel="author"]').first().text().trim() ||
    $('[class*="author"]').first().text().trim() ||
    'Unknown';

  // Publish date
  const publishDate =
    $('meta[property="article:published_time"]').attr('content') ||
    $('time').attr('datetime') ||
    null;

  // Cover image
  const coverImage = $('meta[property="og:image"]').attr('content') || null;

  // Content — try multiple selectors
  let contentEl =
    $('.main-content').length                  ? $('.main-content') :
    $('article').length                       ? $('article') :
    $('[data-testid="post-content"]').length   ? $('[data-testid="post-content"]') :
    $('.post-content').length                  ? $('.post-content') :
    $('main').length                           ? $('main') :
    $('[role="main"]').length                  ? $('[role="main"]') :
    $('body');

  // Proxy all image URLs through /api/image
  contentEl.find('img').each((_, img) => {
    const src = $(img).attr('src') || $(img).attr('data-src');
    if (src && src.startsWith('http')) {
      $(img).attr('src', '/api/image?url=' + encodeURIComponent(src));
      $(img).removeAttr('data-src');
      $(img).removeAttr('loading');
    }
  });
  contentEl.find('source').each((_, source) => {
    const srcset = $(source).attr('srcset');
    if (srcset) {
      const proxied = srcset
        .split(',')
        .map((entry) => {
          const parts = entry.trim().split(/\s+/);
          if (parts[0]?.startsWith('http')) {
            parts[0] = '/api/image?url=' + encodeURIComponent(parts[0]);
          }
          return parts.join(' ');
        })
        .join(', ');
      $(source).attr('srcset', proxied);
    }
  });

  const content = contentEl.html() || '';

  return { title, author, publishDate, coverImage, content };
}

// Quick content check
function hasArticleContent(html) {
  if (!html || typeof html !== 'string' || html.length < 2000) return false;
  if (html.includes('Just a moment')) return false; // Cloudflare challenge
  const $ = cheerio.load(html);
  return $('p').length > 3 || $('article').length > 0 || $('.main-content').length > 0;
}

// ─── Method 1: Googlebot fetch ────────────────────────────────────────────────
async function fetchGooglebot(url) {
  const response = await axios.get(url, {
    headers: { ...GOOGLEBOT_HEADERS, 'X-Forwarded-For': '66.249.66.1' },
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: () => true,
  });
  if (!hasArticleContent(response.data)) {
    throw new Error(`Googlebot: no article content (status ${response.status})`);
  }
  return { html: response.data, status: response.status };
}

// ─── Method 2: ReadMedium.com (proxy service) ─────────────────────────────────
async function fetchReadMedium(url) {
  const baseUrl = process.env.READMEDIUM_URL || 'https://readmedium.com/en/';
  const proxyUrl = baseUrl + encodeURIComponent(url);
  const response = await axios.get(proxyUrl, {
    headers: BROWSER_HEADERS,
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: () => true,
  });
  if (response.status >= 400) {
    throw new Error(`ReadMedium returned status ${response.status}`);
  }
  if (!hasArticleContent(response.data)) {
    throw new Error('ReadMedium: no article content');
  }
  return { html: response.data, status: response.status };
}

// ─── Method 2.5: Freedium Mirror ─────────────────────────────────────────────
async function fetchFreediumMirror(url) {
  const baseUrl = process.env.FREEDIUM_URL || 'https://freedium-mirror.cfd/';
  const proxyUrl = baseUrl + encodeURIComponent(url);
  const response = await axios.get(proxyUrl, {
    headers: BROWSER_HEADERS,
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: () => true,
  });
  if (response.status >= 400) {
    throw new Error(`Freedium Mirror returned status ${response.status}`);
  }
  if (!hasArticleContent(response.data)) {
    throw new Error('Freedium Mirror: no article content');
  }
  return { html: response.data, status: response.status };
}

// ─── Method 3: Scribe.rip ────────────────────────────────────────────────────
async function fetchScribe(url) {
  const parsed = new URL(url);
  const baseUrl = process.env.SCRIBE_URL || 'https://scribe.rip';
  const scribeUrl = baseUrl + parsed.pathname;
  const response = await axios.get(scribeUrl, {
    headers: BROWSER_HEADERS,
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: () => true,
  });
  if (response.status >= 400) {
    throw new Error(`Scribe returned status ${response.status}`);
  }
  const $ = cheerio.load(response.data);
  if ($('article').length === 0 && $('p').length < 2) {
    throw new Error('Scribe: no article content found');
  }
  return { html: response.data, status: response.status };
}

// ─── Method 4: Archive.org ────────────────────────────────────────────────────
async function fetchArchive(url) {
  const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
  const check = await axios.get(apiUrl, { timeout: 15000 });
  const snapshot = check.data?.archived_snapshots?.closest;
  if (!snapshot || !snapshot.available) {
    throw new Error('No Archive.org snapshot available');
  }
  const snapshotUrl = snapshot.url.replace(/^http:/, 'https:');
  const response = await axios.get(snapshotUrl, {
    timeout: 15000,
    headers: BROWSER_HEADERS,
    maxRedirects: 5,
    validateStatus: () => true,
  });
  if (response.status >= 400) {
    throw new Error(`Archive.org returned status ${response.status}`);
  }
  if (!hasArticleContent(response.data)) {
    throw new Error('Archive.org: no article content');
  }
  return { html: response.data, status: response.status };
}

// ─── Method chain ─────────────────────────────────────────────────────────────
const METHODS = [
  { name: 'googlebot',   fn: fetchGooglebot },
  { name: 'freedium',    fn: fetchFreediumMirror },
  { name: 'readmedium',  fn: fetchReadMedium },
  { 
    name: 'scribe',      
    fn: (url) => {
      // Scribe usually only works for known Medium-hosted paths
      if (!isKnownMediumDomain(url)) throw new Error('Scribe: domain not in whitelist');
      return fetchScribe(url);
    } 
  },
  { name: 'archive',     fn: fetchArchive },
];

// ─── GET /api/test ────────────────────────────────────────────────────────────
app.get('/api/test', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── GET /api/article ─────────────────────────────────────────────────────────
app.get('/api/article', async (req, res) => {
  const startTime = Date.now();
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ success: false, error: 'Missing "url" query parameter' });
  }

  // We now allow any URL, but we track if it's a known Medium domain
  const knownMedium = isKnownMediumDomain(url);

  // Check cache
  const cached = cache.get(url);
  if (cached) {
    return res.json({ ...cached, debug: { ...cached.debug, cached: true } });
  }

  let html = null;
  let methodWorked = null;
  let statusCode = null;
  const methodTried = [];

  for (const { name, fn } of METHODS) {
    try {
      methodTried.push(name);
      const result = await fn(url);
      html = result.html;
      statusCode = result.status;
      methodWorked = name;
      break;
    } catch (err) {
      // Log failure if needed
    }
  }

  if (!html) {
    const timeTaken = Date.now() - startTime;
    return res.status(502).json({
      success: false,
      error: 'Failed to fetch article from all sources. Tried: ' + methodTried.join(', '),
      debug: { urlFetched: url, statusCode: null, methodTried, methodWorked: null, timeTaken },
    });
  }

  try {
    const parsed = parseArticle(html, methodWorked);
    const timeTaken = Date.now() - startTime;

    const result = {
      success: true,
      method: methodWorked,
      title: parsed.title,
      author: parsed.author,
      publishDate: parsed.publishDate,
      coverImage: parsed.coverImage
        ? '/api/image?url=' + encodeURIComponent(parsed.coverImage)
        : null,
      content: parsed.content,
      debug: { urlFetched: url, statusCode, methodTried, methodWorked, timeTaken },
    };

    cache.set(url, result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Failed to parse article: ' + err.message,
    });
  }
});

// ─── GET /api/image  (proxy) ──────────────────────────────────────────────────
app.get('/api/image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing "url" query parameter');

  try {
    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 15000,
      headers: {
        'User-Agent': BROWSER_HEADERS['User-Agent'],
        Referer: 'https://medium.com/',
      },
    });
    const contentType = response.headers['content-type'];
    if (contentType) res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    response.data.pipe(res);
  } catch (err) {
    res.status(502).send('Failed to proxy image');
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Libredium server running at http://localhost:${PORT}\n`);
});
