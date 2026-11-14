'use strict';

/**
 * Local test fixture for web-downloader.
 *
 * Binds EXCLUSIVELY to 127.0.0.1 — it is never reachable from any other
 * host. Serves a small, deterministic "site" exercising every feature the
 * downloader must handle, and records per-URL request counts.
 */

const http = require('http');
const crypto = require('crypto');

// --- Deterministic binary payloads -----------------------------------------

function makePng(seed) {
  // Minimal valid 1x1 PNG; different seed -> different bytes / digest.
  const crcTable = (() => {
    const table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: RGB
  // one filter byte (0) + one RGB pixel derived from the seed
  const pixel = crypto.createHash('md5').update(seed).digest().slice(0, 3);
  const idatData = Buffer.concat([Buffer.from([0]), pixel]);
  const zlib = require('zlib');
  const idat = zlib.deflateSync(idatData);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function makeFont(seed) {
  // woff2 magic + deterministic payload (not a real font, but exact bytes
  // are all the downloader must preserve).
  const body = crypto.createHash('sha256').update('font:' + seed).digest();
  return Buffer.concat([Buffer.from('wOF2'), body]);
}

const REDIRECTS = {
  '/img/logo-redirect.png': '/img/logo.png',
  '/css/moved/': '/css/base.css',
  '/page-redirect': '/page2'
};

const SLOW_PATHS = new Set(['/slow.bin']);

// Content served, keyed by pathname (query strings are intentionally part of
// real routes below so same-path/different-query collisions can be tested).
function buildContent() {
  const indexHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Fixture Index</title>
  <link rel="canonical" href="http://placeholder.invalid/canonical">
  <link rel="preconnect" href="https://cdn.thirdparty.example">
  <link rel="dns-prefetch" href="//fonts.thirdparty.example">
  <link rel="stylesheet" href="/css/main.css">
  <link rel="icon" href="/img/favicon.png">
  <link rel="preload" as="font" type="font/woff2" href="/fonts/body.woff2" crossorigin>
  <style>
    body { background: url(/img/bg.png) no-repeat; }
  </style>
</head>
<body>
  <h1>Fixture</h1>
  <!-- navigation links are NOT resources and must stay untouched -->
  <a href="/page2">Page 2</a>
  <a href="https://example.org/external">External</a>
  <a href="#section">Anchor</a>

  <img src="/img/logo.png?size=small" alt="small">
  <img src="/img/logo.png?size=large" alt="large">
  <img
    srcset="/img/hero-320.png 320w,
            /img/hero-640.png 640w"
    src="/img/hero-640.png" alt="hero">
  <picture>
    <source srcset="/img/art-wide.png 2x" media="(min-width: 800px)">
    <img src="/img/art.png" alt="art">
  </picture>
  <img src="/img/missing.png" alt="missing">
  <img src="/img/logo-redirect.png" alt="redirected">
  <img src="https://cdn.thirdparty.example/remote.png" alt="cross-origin">
  <div style="background-image: url('/img/div-bg.png');">box</div>
  <script src="/js/app.js"></script>
  <script>console.log('inline stays');</script>
</body>
</html>
`;

  const page2Html = `<!DOCTYPE html>
<html>
<head><base href="/static/"></head>
<body>
  <h1>Page 2 uses a base tag</h1>
  <img src="logo.png" alt="base-resolved">
  <a href="/">home</a>
</body>
</html>
`;

  const mainCss = [
    '/* main.css imports base.css through a redirect */',
    '@import "/css/moved/";',
    "@import url('/css/extra.css');",
    'body { color: red; }',
    '.logo { background-image: url(/img/logo.png?size=small); }',
    '@media print { .x { background: url("img/relative.png"); } }'
  ].join('\n');

  // Cycle: base.css imports extra.css, extra.css imports base.css.
  const baseCss = [
    '/* base.css */',
    "@import url('/css/extra.css');",
    '@font-face { font-family: Body; src: url(/fonts/body.woff2); }',
    '.bg { background: url(/img/bg.png); }'
  ].join('\n');

  const extraCss = [
    '/* extra.css cycles back into base.css */',
    '@import "/css/base.css";',
    '.extra { background-image: url(/img/extra.png); }'
  ].join('\n');

  return {
    '/': { type: 'text/html; charset=utf-8', body: indexHtml },
    '/page2': { type: 'text/html; charset=utf-8', body: page2Html },
    '/css/main.css': { type: 'text/css', body: mainCss },
    '/css/base.css': { type: 'text/css', body: baseCss },
    '/css/extra.css': { type: 'text/css', body: extraCss },
    '/js/app.js': { type: 'application/javascript', body: "console.log('app');\n" },
    '/img/logo.png': { type: 'image/png', body: makePng('logo') },
    '/img/favicon.png': { type: 'image/png', body: makePng('favicon') },
    '/img/bg.png': { type: 'image/png', body: makePng('bg') },
    '/img/div-bg.png': { type: 'image/png', body: makePng('div-bg') },
    '/img/hero-320.png': { type: 'image/png', body: makePng('hero-320') },
    '/img/hero-640.png': { type: 'image/png', body: makePng('hero-640') },
    '/img/art.png': { type: 'image/png', body: makePng('art') },
    '/img/art-wide.png': { type: 'image/png', body: makePng('art-wide') },
    '/css/img/relative.png': { type: 'image/png', body: makePng('relative') },
    '/img/extra.png': { type: 'image/png', body: makePng('extra') },
    '/static/logo.png': { type: 'image/png', body: makePng('static-logo') },
    '/fonts/body.woff2': { type: 'font/woff2', body: makeFont('body') },
    '/slow.bin': { type: 'application/octet-stream', body: makeFont('slow') }
  };
}

function createServer() {
  const content = buildContent();
  const counts = new Map();      // full path (path+query) -> request count
  const sockets = new Set();

  const count = (key) => counts.set(key, (counts.get(key) || 0) + 1);

  const server = http.createServer((req, res) => {
    count(req.url);
    const u = new URL(req.url, 'http://127.0.0.1');

    // Redirects (Location resolved by client against request URL).
    if (REDIRECTS[u.pathname]) {
      res.writeHead(302, { Location: REDIRECTS[u.pathname] });
      return res.end();
    }

    if (SLOW_PATHS.has(u.pathname)) {
      const timer = setTimeout(() => {
        res.writeHead(200, { 'Content-Type': content['/slow.bin'].type });
        res.end(content['/slow.bin'].body);
      }, 3000);
      req.on('close', () => clearTimeout(timer));
      return;
    }

    const entry = content[u.pathname];
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': entry.type });
    res.end(entry.body);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return {
    server,
    counts,
    start() {
      return new Promise((resolve) => {
        // Explicit loopback bind: nothing listens on any external interface.
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    stop() {
      return new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      });
    },
    url(pathAndQuery) {
      const port = server.address().port;
      return `http://127.0.0.1:${port}${pathAndQuery}`;
    },
    rawContent(pathname) {
      return content[pathname];
    }
  };
}

module.exports = { createServer, makePng, makeFont, REDIRECTS };
