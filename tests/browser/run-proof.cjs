'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const sourceRoot = process.env.OPTO_SYNC_SOURCE;
assert.ok(sourceRoot, 'OPTO_SYNC_SOURCE must point at the pinned source checkout');

const esbuild = require(path.join(sourceRoot, 'clients/ts/node_modules/esbuild'));
const { chromium } = require(path.join(
  sourceRoot,
  'clients/ts/node_modules/playwright',
));

async function main() {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opto-sync-proof-'));
  const bundle = path.join(outputDirectory, 'app.js');
  await esbuild.build({
    entryPoints: [path.join(process.cwd(), 'tests/browser/app.ts')],
    outfile: bundle,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    sourcemap: 'inline',
    logLevel: 'info',
  });

  let healthRequests = 0;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/health') {
      healthRequests += 1;
      response.writeHead(204, {
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      response.end();
      return;
    }
    if (url.pathname === '/probe-count') {
      response.writeHead(200, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store',
      });
      response.end(String(healthRequests));
      return;
    }
    if (url.pathname === '/app.js') {
      response.writeHead(200, {
        'Content-Type': 'text/javascript',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(bundle).pipe(response);
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-store',
    });
    response.end('<!doctype html><meta charset="utf-8"><script src="/app.js"></script>');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.stack || error.message));

    await page.goto(`http://127.0.0.1:${address.port}/`, {
      waitUntil: 'load',
    });
    await page.waitForFunction(() => window.__proof !== undefined, null, {
      timeout: 30_000,
    });
    const proof = await page.evaluate(() => window.__proof);

    assert.equal(proof.error, undefined, proof.stack || proof.error);
    assert.equal(proof.initialSaveCount, 3);
    assert.equal(proof.onlineSaveCount, 1);
    assert.equal(proof.pendingCount, 3);
    assert.equal(proof.payloadLeaked, false);
    assert.equal(proof.forcedOfflineProbeDelta, 0);
    assert.equal(proof.restoreWakeDelta, 1, 'restoring connectivity should wake once');
    assert.equal(proof.detectedOffline, 'offline');
    assert.equal(proof.stateAfterReconnect, 'internet');
    assert.equal(proof.stateAfterStop, 'internet');
    assert.ok(healthRequests >= 2, 'the real browser performed end-to-end probes');
    assert.deepEqual(consoleErrors, []);

    process.stdout.write(`${JSON.stringify({ proof, healthRequests }, null, 2)}\n`);
  } finally {
    await browser.close();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
