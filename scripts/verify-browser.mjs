/**
 * Proves the built extension really edits headers, in a real browser.
 *
 * Lint, tests and `verify-bundle.mjs` check artefacts; this checks behaviour. It
 * installs the extension the browser would install, creates a rule through the
 * real message contract, and reads the headers a real page received on a real
 * `fetch` POST and a real `XMLHttpRequest`.
 *
 * Run:  npm run build && npm run verify:browser
 *       For Edge, after `npm run build:edge`:
 *       CHROME=/opt/microsoft/msedge/msedge npm run verify:browser:edge
 * Exits 0 when every check passes, 1 on a failed check, 2 on a harness error.
 *
 * Several traps shape how it does that (see docs/architecture.md). Chrome 137+
 * ignores `--load-extension`, and a puppeteer-launched Chrome adds
 * `--disable-extensions`, so Chrome is launched directly and the extension goes
 * in over CDP with `Extensions.loadUnpacked`. A service worker cannot
 * `sendMessage` to its own `onMessage` listener, so every message-contract call
 * runs from the options page, as it does in life. And Chrome's
 * optional-permission confirmation is a native dialog headless Chrome never
 * resolves and CDP cannot click — so phase B runs against a copy of the build
 * whose manifest pre-grants `*://localhost/*`, which is exactly what the user's
 * click would produce. Nothing else differs: same compiler, engine, messages and
 * Chrome. Phase A is what proves the shipped manifest asks for nothing at
 * install, and that a rule without site access says so instead of pretending.
 */

import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const EXT_DIR = resolve(process.env.EXT_DIR ?? '.output/chrome-mv3');
const CHROME = process.env.CHROME ?? 'google-chrome';
const CDP_PORT = Number(process.env.CDP_PORT ?? 9333);
const ECHO_PORT = Number(process.env.ECHO_PORT ?? 8781);
const ECHO = `http://localhost:${ECHO_PORT}`;

// The Edge run proves nothing if it silently installs the Edge build in Chrome,
// and there is no portable path to an Edge binary to default to — so
// `verify:browser:edge` sets EXPECT_BROWSER and the caller has to name the
// binary rather than inheriting the Chrome default. What that binary turns out
// to be is settled after launch, by `assertExpectedBrowser()`: the path is a
// caller-authored string, routinely a wrapper script, and says nothing about
// what it execs.
const EXPECT_BROWSER = process.env.EXPECT_BROWSER ?? null;

if (EXPECT_BROWSER === 'edge' && !process.env.CHROME) {
  console.error(
    'verify:browser:edge will not fall back to the Chrome default: a green run against Chrome ' +
      'proves nothing about Edge.\nRun: CHROME=/opt/microsoft/msedge/msedge npm run verify:browser:edge',
  );
  process.exit(2);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// The two request kinds header editors most often get wrong.
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>header test</title></head><body><pre id="out"></pre>
<script>
(async () => {
  const results = {};
  const post = await fetch('/echo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  });
  results.postRequestHeaders = await post.json();
  results.postResponseInjected = post.headers.get('x-injected');

  const xhr = await new Promise((done) => {
    const request = new XMLHttpRequest();
    request.open('GET', '/echo');
    request.onload = () => done({
      body: JSON.parse(request.responseText),
      injected: request.getResponseHeader('x-injected'),
    });
    request.send();
  });
  results.xhrRequestHeaders = xhr.body;
  results.xhrResponseInjected = xhr.injected;

  document.getElementById('out').textContent = JSON.stringify(results, null, 2);
  window.__results = results;
})();
</script></body></html>`;

function startEchoServer() {
  const server = createServer((request, response) => {
    if (request.url === '/echo') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(request.headers));
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(PAGE);
  });
  return new Promise((done) => server.listen(ECHO_PORT, '127.0.0.1', () => done(server)));
}

// A very small CDP client. `ws` is not a dependency; Node has WebSocket.
let nextId = 1;

function connect(url) {
  return new Promise((done, fail) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    const events = [];

    socket.addEventListener('open', () => done(api));
    socket.addEventListener('error', fail);
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const waiter = message.id ? pending.get(message.id) : undefined;
      if (waiter) {
        pending.delete(message.id);
        if (message.error) waiter.fail(new Error(`${message.error.message} (${message.error.code})`));
        else waiter.done(message.result);
        return;
      }
      events.push(message);
    });

    const api = {
      send(method, params = {}, sessionId) {
        const id = nextId++;
        socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
        return new Promise((done2, fail2) => {
          pending.set(id, { done: done2, fail: fail2 });
          setTimeout(() => {
            if (pending.delete(id)) fail2(new Error(`timed out: ${method}`));
          }, 20_000);
        });
      },
      events,
      close: () => socket.close(),
    };
  });
}

// The rule under test, created through the real message contract.
const RESOURCE_TYPES = JSON.stringify([
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other',
]);

const ADD_RULE = `(async () => {
  const send = (type, payload) => chrome.runtime.sendMessage({ protocol: 1, type, payload });
  const current = await send('rules:getState', {});
  if (!current.ok) return { error: current.error };
  const document = current.data.document;
  const id = () => crypto.randomUUID();
  document.profiles[0].rules.push({
    id: id(),
    name: 'Verification rule',
    enabled: true,
    match: [{ id: id(), enabled: true, kind: 'domain', value: 'localhost' }],
    exclude: [{ id: id(), enabled: true, kind: 'regex', value: '.*/never-match.*' }],
    sites: [],
    resourceTypes: ${RESOURCE_TYPES},
    requestMethods: [],
    headers: [
      { id: id(), enabled: true, target: 'request', operation: 'set', name: 'X-Debug', value: 'headerman' },
      { id: id(), enabled: true, target: 'response', operation: 'set', name: 'X-Injected', value: 'yes' }
    ],
    notes: ''
  });
  const saved = await send('rules:save', { document });
  const dnr = await chrome.declarativeNetRequest.getDynamicRules();
  return { saved: saved.data, error: saved.ok ? null : saved.error, dnr };
})()`;

/**
 * A rule whose sites cannot be worked out at all. The rule above matches on a
 * domain, which derives an origin, so it only exercises the needs-permission
 * path. A bare regex derives nothing, and that is where the badge and the
 * browser could disagree: reported "unsupported", installed anyway, and then
 * applied on every host granted for some other rule. It also arrives through the
 * shipped ModHeader import — a `urlRegex` with no dotted hostname — so it is
 * checked in a real Chrome, not only in the unit tests.
 */
const ADD_UNDECIDABLE_RULE = `(async () => {
  const send = (type, payload) => chrome.runtime.sendMessage({ protocol: 1, type, payload });
  const current = await send('rules:getState', {});
  if (!current.ok) return { error: current.error };
  const document = current.data.document;
  const id = () => crypto.randomUUID();
  document.profiles[0].rules.push({
    id: id(),
    name: 'Undecidable site rule',
    enabled: true,
    match: [{ id: id(), enabled: true, kind: 'regex', value: 'http://localhost:3000/.*' }],
    exclude: [],
    sites: [],
    resourceTypes: ${RESOURCE_TYPES},
    requestMethods: [],
    headers: [
      { id: id(), enabled: true, target: 'request', operation: 'set', name: 'Authorization', value: 'Bearer never-send-me' }
    ],
    notes: ''
  });
  const saved = await send('rules:save', { document });
  const dnr = await chrome.declarativeNetRequest.getDynamicRules();
  return { saved: saved.data, error: saved.ok ? null : saved.error, dnr };
})()`;

/**
 * Two rules saved together: one Chrome would refuse, one that must keep working.
 *
 * `updateDynamicRules` is atomic, so a header value Chrome will not accept used
 * to make it reject the entire batch — every rule stopped applying while every
 * badge still read "Active. The browser is applying this rule". The value is caught
 * before Chrome is asked now, so the cost is the one rule that owns it. This
 * replaces the profile's rules rather than appending, so the two statuses below
 * are the only ones and their order is the order written here.
 */
const ADD_MIXED_VALIDITY_RULES = `(async () => {
  const send = (type, payload) => chrome.runtime.sendMessage({ protocol: 1, type, payload });
  const current = await send('rules:getState', {});
  if (!current.ok) return { error: current.error };
  const document = current.data.document;
  const id = () => crypto.randomUUID();
  const mk = (name, headerName, headerValue) => ({
    id: id(),
    name,
    enabled: true,
    match: [{ id: id(), enabled: true, kind: 'domain', value: 'localhost' }],
    exclude: [],
    sites: [],
    resourceTypes: ${RESOURCE_TYPES},
    requestMethods: [],
    headers: [
      { id: id(), enabled: true, target: 'request', operation: 'set', name: headerName, value: headerValue }
    ],
    notes: ''
  });
  document.profiles[0].rules = [
    mk('Benign rule', 'X-Benign', 'reaches-the-request'),
    mk('Poisoned rule', 'X-Token', 'abc\\r\\nX-Injected: evil')
  ];
  const saved = await send('rules:save', { document });
  const dnr = await chrome.declarativeNetRequest.getDynamicRules();
  return { saved: saved.data, error: saved.ok ? null : saved.error, dnr };
})()`;

async function main() {
  const failures = [];
  const check = (name, ok, detail) => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures.push(name);
  };

  const echoServer = await startEchoServer();
  const profileDir = mkdtempSync(join(tmpdir(), 'headerman-profile-'));
  const overlayDir = mkdtempSync(join(tmpdir(), 'headerman-granted-'));

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const exited = new Promise((done) => chrome.once('exit', done));

  /** Never let tidying up turn a passing run into a failure. */
  const cleanUp = async () => {
    chrome.kill();
    echoServer.close();
    // Chrome writes to its profile as it shuts down, so removing it first races
    // and throws ENOTEMPTY.
    await Promise.race([exited, sleep(5000)]);
    for (const directory of [profileDir, overlayDir]) {
      try {
        rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (cause) {
        console.warn(`  (could not remove ${directory}: ${cause.message})`);
      }
    }
  };

  try {
    const version = await waitForCdp();
    assertExpectedBrowser(version);
    const browser = await connect(version.webSocketDebuggerUrl);

    const evaluate = async (expression, session) => {
      const result = await browser.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        session,
      );
      if (result.exceptionDetails) {
        throw new Error(
          `evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
        );
      }
      return result.result.value;
    };

    const attach = async (targetId) => {
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
      await browser.send('Runtime.enable', {}, sessionId);
      await browser.send('Log.enable', {}, sessionId);
      return sessionId;
    };

    const openPage = async (url) => {
      const { targetId } = await browser.send('Target.createTarget', { url });
      return attach(targetId);
    };

    const install = async (path) => {
      const { id } = await browser.send('Extensions.loadUnpacked', { path });
      await browser.send('Target.setDiscoverTargets', { discover: true });
      await sleep(1500);
      const { targetInfos } = await browser.send('Target.getTargets');
      const worker = targetInfos.find(
        (target) => target.type === 'service_worker' && target.url.includes(id),
      );
      if (!worker) throw new Error(`no service worker target for ${id} — the background never started`);
      const session = await attach(worker.targetId);
      const page = await openPage(`chrome-extension://${id}/options.html`);
      await sleep(1500);
      return { id, session, page };
    };

    console.log('\n--- Phase A: the shipped build ------------------------------');
    const shipped = await install(EXT_DIR);
    console.log(`  extension id ${shipped.id}`);

    const manifest = await evaluate('chrome.runtime.getManifest()', shipped.session);
    check(
      'no debugger permission anywhere in the manifest',
      !JSON.stringify(manifest).includes('"debugger"'),
    );
    check(
      'no host permissions granted at install',
      (manifest.host_permissions ?? []).length === 0,
      JSON.stringify(manifest.permissions),
    );
    check(
      'uses declarativeNetRequestWithHostAccess, not the warning-triggering variant',
      manifest.permissions.includes('declarativeNetRequestWithHostAccess') &&
        !manifest.permissions.includes('declarativeNetRequest'),
    );

    const beforeGrant = await evaluate(ADD_RULE, shipped.page);
    if (beforeGrant.error) throw new Error(`rules:save failed: ${JSON.stringify(beforeGrant.error)}`);
    const shippedStatus = beforeGrant.saved.statuses.at(-1);
    check(
      'a rule with no site access reports needs-permission, not active',
      shippedStatus.state === 'needs-permission',
      shippedStatus.summary,
    );
    check(
      'and installs no browser rules while it cannot work',
      beforeGrant.dnr.length === 0,
      `${beforeGrant.dnr.length} dynamic rule(s)`,
    );

    const undecidable = await evaluate(ADD_UNDECIDABLE_RULE, shipped.page);
    if (undecidable.error) {
      throw new Error(`rules:save failed: ${JSON.stringify(undecidable.error)}`);
    }
    const undecidableStatus = undecidable.saved.statuses.at(-1);
    check(
      'a rule whose sites cannot be derived reports unsupported',
      undecidableStatus.state === 'unsupported',
      undecidableStatus.summary,
    );
    check(
      'and installs nothing, so the badge and the browser cannot disagree',
      undecidable.dnr.length === 0,
      `${undecidable.dnr.length} dynamic rule(s)`,
    );

    for (const page of ['popup.html', 'options.html', 'welcome.html']) {
      const session = await openPage(`chrome-extension://${shipped.id}/${page}`);
      await sleep(1500);
      const text = await evaluate('document.body.innerText', session);
      check(`${page} renders`, text.trim().length > 0, text.split('\n')[0]);
    }

    console.log('\n--- Phase B: with site access granted ------------------------');
    cpSync(EXT_DIR, overlayDir, { recursive: true });
    const overlayManifest = JSON.parse(readFileSync(join(overlayDir, 'manifest.json'), 'utf8'));
    overlayManifest.host_permissions = ['*://localhost/*'];
    writeFileSync(join(overlayDir, 'manifest.json'), JSON.stringify(overlayManifest));

    const granted = await install(overlayDir);
    console.log(`  extension id ${granted.id}`);

    const afterGrant = await evaluate(ADD_RULE, granted.page);
    if (afterGrant.error) throw new Error(`rules:save failed: ${JSON.stringify(afterGrant.error)}`);
    const grantedStatus = afterGrant.saved.statuses.at(-1);
    check(
      'the same rule reports active once access exists',
      grantedStatus.state === 'active',
      grantedStatus.summary,
    );
    check('the browser kept exactly what we installed', afterGrant.saved.verification.ok === true);
    check('the engine reported no error', afterGrant.saved.engineError === null);
    check(
      'a regex exclusion compiles to a higher-priority allow rule',
      afterGrant.dnr.some(
        (rule) =>
          rule.action.type === 'allow' &&
          rule.condition.regexFilter &&
          rule.priority >
            Math.max(
              ...afterGrant.dnr
                .filter((other) => other.action.type === 'modifyHeaders')
                .map((other) => other.priority),
            ),
      ),
    );

    // A status nobody can see is the same as no status at all.
    const workbench = await openPage(`chrome-extension://${granted.id}/options.html`);
    await sleep(2000);
    const workbenchText = await evaluate('document.body.innerText', workbench);
    check('the options page lists the rule', workbenchText.includes('Verification rule'));
    check('and shows its state', workbenchText.includes('Active'));

    const popup = await openPage(`chrome-extension://${granted.id}/popup.html`);
    await sleep(2000);
    const popupText = await evaluate('document.body.innerText', popup);
    check('the popup lists the rule', popupText.includes('Verification rule'));
    check('and reports what the browser is applying', /browser rule\(s\) applied/.test(popupText));

    const pageSession = await openPage(`${ECHO}/page.html`);
    await sleep(3000);
    const results = await evaluate('window.__results ?? null', pageSession);

    check(
      'POST fetch carries the injected request header',
      results?.postRequestHeaders?.['x-debug'] === 'headerman',
    );
    check('POST fetch sees the injected response header', results?.postResponseInjected === 'yes');
    check(
      'XHR carries the injected request header',
      results?.xhrRequestHeaders?.['x-debug'] === 'headerman',
    );
    check('XHR sees the injected response header', results?.xhrResponseInjected === 'yes');

    // One rule Chrome would refuse, saved alongside one that must survive it.
    const mixed = await evaluate(ADD_MIXED_VALIDITY_RULES, granted.page);
    if (mixed.error) throw new Error(`rules:save failed: ${JSON.stringify(mixed.error)}`);
    const benign = mixed.saved.statuses[0];
    const poisoned = mixed.saved.statuses[1];

    check(
      'a header value the browser would refuse is caught before the browser sees it',
      poisoned?.state === 'unsupported' &&
        poisoned.problems.some((problem) => problem.code === 'invalid-header-value'),
      poisoned?.summary,
    );
    check(
      'so the rule set was never refused',
      mixed.saved.engineError === null && mixed.saved.verification.ok === true,
      JSON.stringify(mixed.saved.engineError),
    );
    check(
      'and the good rule saved beside it is still applied',
      benign?.state === 'active' && mixed.dnr.length === 1,
      `${benign?.state}, ${mixed.dnr.length} dynamic rule(s)`,
    );

    const afterMixed = await openPage(`${ECHO}/page.html`);
    await sleep(3000);
    const mixedResults = await evaluate('window.__results ?? null', afterMixed);
    const mixedHeaders = mixedResults?.postRequestHeaders ?? {};
    check(
      "the good rule's header still reaches a real request, with the bad rule parked",
      mixedHeaders['x-benign'] === 'reaches-the-request' && mixedHeaders['x-token'] === undefined,
      JSON.stringify({ 'x-benign': mixedHeaders['x-benign'] ?? null, 'x-token': mixedHeaders['x-token'] ?? null }),
    );

    await sleep(500);
    const consoleErrors = [];
    for (const event of browser.events) {
      if (event.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(
          event.params.exceptionDetails?.exception?.description ?? event.params.exceptionDetails?.text,
        );
      }
      if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error') {
        consoleErrors.push(event.params.entry.text);
      }
      if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') {
        consoleErrors.push(event.params.args.map((arg) => arg.value ?? arg.description).join(' '));
      }
    }

    console.log('\n--- console -------------------------------------------------');
    check('zero console errors', consoleErrors.length === 0, JSON.stringify(consoleErrors));

    browser.close();
  } finally {
    await cleanUp();
  }

  console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `FAILED: ${failures.join(', ')}`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

/**
 * The browser that actually opened the debugging port, from its own mouth.
 *
 * `/json/version` reports `Edg/151.0.4129.93` for Edge and `Chrome/...` for
 * Chrome. Asserting on that rather than on `CHROME` is the difference between
 * proving the Edge build runs in Edge and proving the caller typed a path with
 * "edge" in it.
 */
function assertExpectedBrowser(version) {
  if (EXPECT_BROWSER !== 'edge') return;
  const brand = version.Browser ?? '(none reported)';
  if (!brand.startsWith('Edg/')) {
    throw new Error(
      `EXPECT_BROWSER=edge, but the browser at ${CHROME} identifies itself as "${brand}". ` +
        'Point CHROME at Microsoft Edge — a run against anything else proves nothing about Edge.',
    );
  }
  console.log(`  ok  the browser under test is ${brand}`);
}

async function waitForCdp() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      return await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`No debugging port opened on ${CDP_PORT}. Is ${CHROME} installed?`);
}

main().catch((cause) => {
  console.error('VERIFICATION ERRORED:', cause);
  process.exit(2);
});
