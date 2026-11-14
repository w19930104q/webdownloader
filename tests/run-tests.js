'use strict';

/**
 * End-to-end tests for web-downloader against 127.0.0.1-only fixtures.
 *
 * Each phase gets a FRESH fixture server so per-route request counts can be
 * asserted exactly, with no cross-phase pollution.
 *
 * Verifies:
 *   1. exact original bytes on disk (sha256 digests, fonts & images)
 *   2. references rewritten to stable relative paths (HTML attrs, srcset,
 *      inline <style>, style="", CSS url()/@import)
 *   3. query-string-distinct resources get distinct files (no overwrite)
 *   4. request counts: shared/cyclic/redirected resources fetched once
 *   5. failed resources keep their absolute URL; plain <a>/<link canonical>
 *      links are not downloaded or rewritten
 *   6. redirects resolved against the final URL; <base> respected
 *   7. re-running yields a byte-identical manifest with exactly doubled
 *      request counts
 *   8. cancellation tears everything down (AbortError, no active requests)
 *   9. the CLI itself works end to end, including SIGINT cancellation
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createServer } = require('./fixture-server');

const WebDownloader = require('../web-downloader');

// --- tiny test harness ------------------------------------------------------

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function manifest(dir) {
  const result = {};
  const walk = (d, rel) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, r);
      else result[r] = sha256(fs.readFileSync(full));
    }
  };
  walk(dir, '');
  return result;
}

function mktmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

function findBySuffix(dir, suffix) {
  const found = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(suffix)) found.push(full);
    }
  };
  walk(dir);
  return found;
}

async function freshFixture() {
  const fixture = createServer();
  const port = await fixture.start();
  return { fixture, base: `http://127.0.0.1:${port}` };
}

function assertLoopback(port) {
  return new Promise((resolve) => {
    const probe = net.connect(port, '127.0.0.1', () => {
      check('fixture reachable on 127.0.0.1', true);
      probe.end();
      resolve();
    });
    probe.on('error', (err) => {
      check('fixture reachable on 127.0.0.1', false, err.message);
      resolve();
    });
  });
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'web-downloader'), ...args]);
    child.on('error', reject);
    child.on('close', resolve);
  });
}

// ---------------------------------------------------------------------------

async function main() {
  // ===== Phase A: full index download, bytes, references, counts ===========
  {
    const { fixture, base } = await freshFixture();
    await assertLoopback(fixture.server.address().port);
    const out = mktmp('wd-a-');
    try {
      console.log('\n[A1] Full download of the fixture index page');
      const dl = new WebDownloader({ outputDir: out, timeout: 10000 });
      await dl.download(base + '/');

      const indexOnDisk = path.join(out, 'index.html');
      const savedIndex = fs.readFileSync(indexOnDisk, 'utf8');

      check('index page saved', fs.existsSync(indexOnDisk));
      check('all assets live under assets/',
        fs.readdirSync(out).every((e) => e === 'index.html' || e === 'assets'));

      console.log('\n[A2] Original bytes preserved (sha256 digests)');
      const onDiskHashes = new Set(Object.values(manifest(path.join(out, 'assets'))));
      const binaryRoutes = [
        '/img/logo.png', '/img/favicon.png', '/img/bg.png', '/img/div-bg.png',
        '/img/hero-320.png', '/img/hero-640.png', '/img/art.png', '/img/art-wide.png',
        '/css/img/relative.png', '/img/extra.png', '/fonts/body.woff2'
      ];
      for (const p of binaryRoutes) {
        check(`exact bytes for ${p}`, onDiskHashes.has(sha256(fixture.rawContent(p).body)));
      }
      const fontFiles = findBySuffix(out, '.woff2');
      check('font saved with .woff2 extension', fontFiles.length === 1);
      check('font bytes are the exact woff2 payload',
        fontFiles.length === 1 &&
        sha256(fs.readFileSync(fontFiles[0])) === sha256(fixture.rawContent('/fonts/body.woff2').body));

      console.log('\n[A3] Query-string variants are unique files, no overwrite');
      const logoName = dl.getAssetName(base + '/img/logo.png', 'image/png');
      const logoSmall = dl.getAssetName(base + '/img/logo.png?size=small', 'image/png');
      const logoLarge = dl.getAssetName(base + '/img/logo.png?size=large', 'image/png');
      check('hash includes query string (three distinct names)',
        new Set([logoName, logoSmall, logoLarge]).size === 3);
      check('both variants exist on disk',
        fs.existsSync(path.join(out, logoSmall)) && fs.existsSync(path.join(out, logoLarge)));
      check('both variants keep identical original bytes',
        sha256(fs.readFileSync(path.join(out, logoSmall))) ===
        sha256(fs.readFileSync(path.join(out, logoLarge))));
      check('index references both variants via distinct relative paths',
        new RegExp(`src="(?:\\./)?${logoSmall.replace(/[/.]/g, '\\$&')}"`).test(savedIndex) &&
        new RegExp(`src="(?:\\./)?${logoLarge.replace(/[/.]/g, '\\$&')}"`).test(savedIndex));

      console.log('\n[A4] References rewritten stably');
      check('img src rewritten relatively',
        new RegExp(`src="(?:\\./)?${logoSmall.replace(/[/.]/g, '\\$&')}"`).test(savedIndex));
      // The only absolute fixture URL allowed is the deliberately-broken one.
      check('no absolute fixture URL remains for successful resources',
        !/src="http:\/\/127\.0\.0\.1/.test(savedIndex.replace(/src="[^"]*missing\.png"/, '')) &&
        !/href="http:\/\/127\.0\.0\.1[^"]*\.(css|png|woff2|js)/.test(savedIndex));
      check('stylesheet link rewritten',
        /rel="stylesheet" href="(?:\.)?\/?assets\/[a-f0-9]+\.css"/.test(savedIndex));
      check('favicon link rewritten',
        /rel="icon" href="(?:\.)?\/?assets\/[a-f0-9]+\.png"/.test(savedIndex));
      check('preload font link rewritten',
        /as="font"[^>]*href="(?:\.)?\/?assets\/[a-f0-9]+\.woff2"/.test(savedIndex));
      check('script src rewritten',
        /src="(?:\.)?\/?assets\/[a-f0-9]+\.js"/.test(savedIndex));
      check('inline <style> keeps valid CSS with rewritten url()',
        /body \{ background: url\(["'][^"']*assets\/[a-f0-9]+\.png["']\) no-repeat; \}/.test(savedIndex));
      check('inline style attribute keeps valid CSS with rewritten url()',
        /style="background-image: url\(&#39;[^&]*assets\/[a-f0-9]+\.png&#39;\);"/.test(savedIndex) ||
        /style="background-image: url\('[^']*assets\/[a-f0-9]+\.png'\);"/.test(savedIndex));
      check('srcset rewritten, descriptors kept',
        /srcset="(?:\.)?\/?assets\/[a-f0-9]+\.png 320w,\s*(?:\.)?\/?assets\/[a-f0-9]+\.png 640w"/.test(savedIndex));
      check('picture <source> srcset rewritten',
        /<source srcset="(?:\.)?\/?assets\/[a-f0-9]+\.png 2x"/.test(savedIndex));

      console.log('\n[A5] Navigation / canonical links are not resources');
      check('<a href="/page2"> left untouched', savedIndex.includes('href="/page2"'));
      check('external anchor left untouched',
        savedIndex.includes('href="https://example.org/external"'));
      check('in-page anchor left untouched', savedIndex.includes('href="#section"'));
      check('canonical <link> left untouched',
        savedIndex.includes('href="http://placeholder.invalid/canonical"'));
      check('preconnect hint left untouched (not downloaded)',
        savedIndex.includes('rel="preconnect" href="https://cdn.thirdparty.example"'));
      check('dns-prefetch hint left untouched (not downloaded)',
        savedIndex.includes('rel="dns-prefetch" href="//fonts.thirdparty.example"'));
      check('cross-origin image keeps its absolute URL',
        savedIndex.includes('src="https://cdn.thirdparty.example/remote.png"'));
      check('page2 was never requested (no link following)',
        (fixture.counts.get('/page2') || 0) === 0);

      console.log('\n[A6] Failed resources keep their original absolute URL');
      check('missing img keeps absolute URL',
        savedIndex.includes(`src="${base}/img/missing.png"`));
      check('missing.png was attempted exactly once',
        (fixture.counts.get('/img/missing.png') || 0) === 1);

      console.log('\n[A7] Request counts (shared / cyclic / redirected = once)');
      const expectOnce = [
        '/', '/css/main.css', '/css/base.css', '/css/extra.css',
        '/img/bg.png', '/img/extra.png', '/css/img/relative.png',
        '/fonts/body.woff2', '/js/app.js',
        '/img/logo-redirect.png', '/img/favicon.png',
        '/img/logo.png?size=large', '/img/hero-320.png', '/img/hero-640.png',
        '/img/art.png', '/img/art-wide.png', '/img/div-bg.png'
      ];
      for (const p of expectOnce) {
        check(`${p} requested exactly once`, (fixture.counts.get(p) || 0) === 1,
          `got ${fixture.counts.get(p) || 0}`);
      }
      // Referenced from BOTH the HTML and main.css -> still one request.
      check('/img/logo.png?size=small requested once despite two references',
        (fixture.counts.get('/img/logo.png?size=small') || 0) === 1,
        `got ${fixture.counts.get('/img/logo.png?size=small') || 0}`);
      // Redirect chain, each hop once.
      check('redirect target /img/logo.png requested once',
        (fixture.counts.get('/img/logo.png') || 0) === 1);
      check('/css/moved/ redirect consumed once',
        (fixture.counts.get('/css/moved/') || 0) === 1);

      // Exact route set: every route must be hit exactly once, and the set
      // must be precisely what the fixture page graph references.
      const expectedRoutes = new Set([
        '/',
        '/css/main.css', '/css/moved/', '/css/base.css', '/css/extra.css',
        '/js/app.js',
        '/img/logo.png', '/img/logo-redirect.png',
        '/img/logo.png?size=small', '/img/logo.png?size=large',
        '/img/favicon.png', '/img/bg.png', '/img/div-bg.png',
        '/img/hero-320.png', '/img/hero-640.png',
        '/img/art.png', '/img/art-wide.png', '/img/extra.png', '/img/missing.png',
        '/css/img/relative.png', '/fonts/body.woff2'
      ]);
      const actualRoutes = new Set(fixture.counts.keys());
      const unexpected = [...actualRoutes].filter((r) => !expectedRoutes.has(r));
      const missing = [...expectedRoutes].filter((r) => !actualRoutes.has(r));
      check('exact route set (no extra, no missing)',
        unexpected.length === 0 && missing.length === 0,
        `unexpected: [${unexpected.join(', ')}]; missing: [${missing.join(', ')}]`);
      const allExactlyOnce = [...fixture.counts.values()].every((n) => n === 1);
      check('every requested route hit exactly once', allExactlyOnce,
        [...fixture.counts].filter(([, n]) => n !== 1).map(([r, n]) => `${r}=${n}`).join('; '));

      console.log('\n[A8] CSS url()/@import rewritten; cycle terminates');
      const mainCssName = dl.getAssetName(base + '/css/main.css', 'text/css');
      const baseCssName = dl.getAssetName(base + '/css/base.css', 'text/css');
      const extraCssName = dl.getAssetName(base + '/css/extra.css', 'text/css');
      const savedMain = fs.readFileSync(path.join(out, mainCssName), 'utf8');
      const savedBase = fs.readFileSync(path.join(out, baseCssName), 'utf8');
      const savedExtra = fs.readFileSync(path.join(out, extraCssName), 'utf8');

      check('@import through redirect rewritten to local base.css',
        new RegExp(`@import\\s+(url\\()?["']?(\\./)?assets/${path.basename(baseCssName).replace(/\./g, '\\.')}["']?\\)?`).test(savedMain) &&
        savedMain.includes(path.basename(baseCssName)));
      check('@import url() of extra.css rewritten',
        savedMain.includes(path.basename(extraCssName)));
      check('CSS url() with query string rewritten',
        savedMain.includes(path.basename(logoSmall)));
      check('relative CSS url() resolved against CSS final URL',
        savedMain.includes(path.basename(
          dl.getAssetName(base + '/css/img/relative.png', 'image/png'))));
      check('cyclic @import back to base.css rewritten, no infinite loop',
        savedExtra.includes(path.basename(baseCssName)));
      check('font url() inside CSS rewritten',
        savedBase.includes(path.basename(
          dl.getAssetName(base + '/fonts/body.woff2', 'font/woff2'))));
      check('all CSS references are relative (no 127.0.0.1 left)',
        !/127\.0\.0\.1/.test(savedMain + savedBase + savedExtra));
      check('redirected image stored under final-URL name',
        fs.existsSync(path.join(out, dl.getAssetName(base + '/img/logo.png', 'image/png'))));
      check('redirected img reference points at final-URL file',
        savedIndex.includes(path.basename(
          dl.getAssetName(base + '/img/logo.png', 'image/png'))));
    } finally {
      await fixture.stop();
    }
  }

  // ===== Phase B: base tag + page-level redirect ===========================
  {
    const { fixture, base } = await freshFixture();
    const out = mktmp('wd-b-');
    try {
      console.log('\n[B] Page redirect followed; <base> changes resolution');
      const dl = new WebDownloader({ outputDir: out, timeout: 10000 });
      await dl.download(base + '/page-redirect');

      check('page saved under final-URL path (page2.html)',
        fs.existsSync(path.join(out, 'page2.html')));
      const savedPage2 = fs.readFileSync(path.join(out, 'page2.html'), 'utf8');
      const staticLogoName = dl.getAssetName(base + '/static/logo.png', 'image/png');
      check('<base>-relative src resolved to /static/logo.png',
        new RegExp(`src="(?:\\./)?${staticLogoName.replace(/[/.]/g, '\\$&')}"`).test(savedPage2));
      check('base-resolved image keeps exact bytes',
        sha256(fs.readFileSync(path.join(out, staticLogoName))) ===
        sha256(fixture.rawContent('/static/logo.png').body));
      check('/static/logo.png requested once',
        (fixture.counts.get('/static/logo.png') || 0) === 1);
      check('/page-redirect redirect consumed once',
        (fixture.counts.get('/page-redirect') || 0) === 1);
      check('/page2 (final URL) requested once',
        (fixture.counts.get('/page2') || 0) === 1);
    } finally {
      await fixture.stop();
    }
  }

  // ===== Phase C: rerun determinism ========================================
  {
    const { fixture, base } = await freshFixture();
    const out1 = mktmp('wd-c1-');
    const out2 = mktmp('wd-c2-');
    try {
      console.log('\n[C] Re-run: identical manifest, exactly doubled counts');
      const dl1 = new WebDownloader({ outputDir: out1, timeout: 10000 });
      await dl1.download(base + '/');
      const firstCounts = new Map(fixture.counts);

      const dl2 = new WebDownloader({ outputDir: out2, timeout: 10000 });
      await dl2.download(base + '/');

      const m1 = manifest(out1);
      const m2 = manifest(out2);
      const keys1 = Object.keys(m1).sort();
      const keys2 = Object.keys(m2).sort();
      check('same relative file set on rerun', JSON.stringify(keys1) === JSON.stringify(keys2));
      check('identical sha256 for every file on rerun',
        keys1.length > 0 && keys1.every((k) => m1[k] === m2[k]));
      let countMismatch = [];
      for (const [route, first] of firstCounts) {
        const second = fixture.counts.get(route) || 0;
        if (second !== first * 2) countMismatch.push(`${route}: ${first}->${second}`);
      }
      check('every route requested exactly twice (once per run)',
        countMismatch.length === 0, countMismatch.join('; '));
      check('no unexpected routes on rerun',
        fixture.counts.size === firstCounts.size);
    } finally {
      await fixture.stop();
    }
  }

  // ===== Phase D: cancellation =============================================
  {
    const { fixture, base } = await freshFixture();
    const out = mktmp('wd-d-');
    try {
      console.log('\n[D] Cancellation aborts cleanly');
      const controller = new AbortController();
      const dlAbort = new WebDownloader({ outputDir: out, timeout: 10000, signal: controller.signal });
      let abortErr = null;
      const p = dlAbort.download(base + '/slow.bin').catch((e) => { abortErr = e; });
      await new Promise((r) => setTimeout(r, 200));
      controller.abort();
      await p;
      check('download rejects with AbortError', abortErr && abortErr.name === 'AbortError');
      check('no active requests remain after abort', dlAbort.activeRequests === 0);
      await new Promise((r) => setTimeout(r, 100));
      check('slow request was torn down after a single attempt',
        (fixture.counts.get('/slow.bin') || 0) === 1);

      const preController = new AbortController();
      preController.abort();
      const dlPre = new WebDownloader({ outputDir: mktmp('wd-d2-'), signal: preController.signal });
      let preErr = null;
      await dlPre.download(base + '/').catch((e) => { preErr = e; });
      check('pre-aborted signal fails immediately without a request',
        preErr && preErr.name === 'AbortError' && (fixture.counts.get('/') || 0) === 0);
    } finally {
      await fixture.stop();
    }
  }

  // ===== Phase E: CLI end to end ===========================================
  {
    const { fixture, base } = await freshFixture();
    const out = mktmp('wd-e-');
    try {
      console.log('\n[E] CLI end to end');
      const code = await runCli([base + '/', '-o', out]);
      check('CLI exits 0', code === 0, `exit code ${code}`);
      check('CLI wrote index.html', fs.existsSync(path.join(out, 'index.html')));
      check('CLI downloaded the asset graph',
        fs.existsSync(path.join(out, 'assets')) &&
        fs.readdirSync(path.join(out, 'assets')).length > 5);

      const outAbort = mktmp('wd-e2-');
      const cliAbort = spawn(process.execPath, [
        path.join(__dirname, '..', 'web-downloader'), base + '/slow.bin', '-o', outAbort
      ]);
      let cliStderr = '';
      cliAbort.stderr.on('data', (d) => { cliStderr += d; });
      await new Promise((r) => setTimeout(r, 300));
      cliAbort.kill('SIGINT');
      const cliCode = await new Promise((r) => cliAbort.on('close', r));
      check('CLI exits non-zero on SIGINT', cliCode !== 0, `exit code ${cliCode}`);
      check('CLI reports cancellation', /cancel/i.test(cliStderr));
    } finally {
      await fixture.stop();
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
