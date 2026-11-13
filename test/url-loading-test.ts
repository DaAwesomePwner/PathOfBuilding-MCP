/**
 * Offline tests for build URL / build-code handling (no network, no PoB, no LuaJIT).
 * globalThis.fetch is stubbed per case and always restored.
 */
import assert from 'node:assert/strict';
import { deflateRawSync, deflateSync } from 'node:zlib';
import {
  BUILD_FETCH_MAX_BYTES,
  decodeBuildCode,
  encodeBuildCode,
  fetchBuildFromURL,
  MAX_BUILD_CODE_LENGTH,
  MAX_DECODED_BUILD_BYTES,
} from '../src/build-source.js';
import { BuildSession } from '../src/build-session.js';
import type { LuaBridge } from '../src/lua-bridge.js';
import { decodeBuildCode as reexportedDecode } from '../src/lua-bridge.js';
import { parseBuildURL, UserError, validateBuildSource } from '../src/validation.js';

const XML = '<?xml version="1.0"?><PathOfBuilding><Build level="90" className="Witch"/></PathOfBuilding>';
const CODE = encodeBuildCode(XML);

type FetchFn = typeof globalThis.fetch;
interface FetchCall {
  url: string;
  init?: RequestInit;
}

let failures = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
}

async function withFetch(impl: (url: string, init?: RequestInit) => Promise<Response>, fn: (calls: FetchCall[]) => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: Parameters<FetchFn>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return impl(url, init);
  }) as FetchFn;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

async function expectUserError(p: Promise<unknown> | (() => unknown), pattern?: RegExp): Promise<UserError> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (err) {
    assert(err instanceof UserError, `expected UserError, got ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    if (pattern) assert.match(err.message, pattern);
    return err;
  }
  assert.fail('expected a UserError, but the call succeeded');
}

/** A fetch stub that never answers until aborted, like a hung server. */
function hangingFetch(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

async function main(): Promise<void> {
  // ----------------------------------------------------------------
  // URL allowlist: rejected before any fetch
  // ----------------------------------------------------------------
  const rejected = [
    'http://169.254.169.254/?pobb.in',
    'https://evil.example/pobb.in/abc',
    'https://pobb.in.evil.example/abc',
    'https://pobb.in@evil.example/abc',
    'https://user:secret@pobb.in/abc',
    'https://pobb.in:8443/abc',
    'https://pastebin.com/../x',
    'https://pastebin.com/./x',
    'https://pobb.in\\..\\x',
    'file:///etc/passwd',
    'https://pobb.in/',
    'https://pobb.in',
    'https://pastebin.com/raw/',
    'https://pastebin.com/raw',
    'https://pobb.in/pob/',
    'https://pastebin.com/a/b',
    'https://pastebin.com/abc_def',
    'https://pobb.in/a%2Fb',
    'https://pobb.in./abc',
    'ftp://pobb.in/abc',
    'javascript:alert(1)',
    'https://[::1]/abc',
    'https://poe.ninja/builds/x',
  ];
  for (const url of rejected) {
    await test(`rejects ${url} before any fetch`, async () => {
      await withFetch(
        () => Promise.reject(new Error('fetch must not be called')),
        async (calls) => {
          await expectUserError(() => parseBuildURL(url));
          await expectUserError(() => validateBuildSource(url));
          await expectUserError(fetchBuildFromURL(url));
          assert.equal(calls.length, 0, 'fetch was called');
        },
      );
    });
  }

  await test('error text echoes only the hostname and names the accepted sites', async () => {
    const err = await expectUserError(() => parseBuildURL('https://pobb.in@evil.example/secret-path?token=hunter2'));
    assert.match(err.message, /"evil\.example"/);
    assert.match(err.message, /pobb\.in/);
    assert.match(err.message, /pastebin\.com/);
    assert.doesNotMatch(err.message, /secret-path|hunter2/);
    const err2 = await expectUserError(() => parseBuildURL('https://pobb.in:8443/abc?token=hunter2'));
    assert.doesNotMatch(err2.message, /hunter2|8443/);
    const err3 = await expectUserError(() => parseBuildURL('file:///etc/passwd'));
    assert.doesNotMatch(err3.message, /passwd/);
  });

  // ----------------------------------------------------------------
  // Accepted forms request exactly the canonical download URL
  // ----------------------------------------------------------------
  const accepted: Array<[string, string]> = [
    ['https://pobb.in/AbC_123', 'https://pobb.in/pob/AbC_123'],
    ['https://pobb.in/pob/AbC_123', 'https://pobb.in/pob/AbC_123'],
    ['https://www.pobb.in/AbC_123/', 'https://pobb.in/pob/AbC_123'],
    ['https://POBB.IN/AbC_123', 'https://pobb.in/pob/AbC_123'],
    ['pobb.in/AbC_123', 'https://pobb.in/pob/AbC_123'],
    ['https://pobb.in/AbC_123?ref=x#frag', 'https://pobb.in/pob/AbC_123'],
    ['https://pastebin.com/AbC123', 'https://pastebin.com/raw/AbC123'],
    ['https://pastebin.com/raw/AbC123', 'https://pastebin.com/raw/AbC123'],
    ['https://www.pastebin.com/AbC123', 'https://pastebin.com/raw/AbC123'],
    ['https://pastebin.com:443/AbC123', 'https://pastebin.com/raw/AbC123'],
    // http:// to an allowed host is upgraded: the request is always https.
    ['http://pastebin.com/AbC123', 'https://pastebin.com/raw/AbC123'],
  ];
  for (const [input, expected] of accepted) {
    await test(`${input} requests ${expected}`, async () => {
      assert.equal(validateBuildSource(input), input.trim());
      await withFetch(
        async () => new Response(CODE, { status: 200 }),
        async (calls) => {
          assert.equal(await fetchBuildFromURL(input), XML);
          assert.equal(calls.length, 1);
          assert.equal(calls[0].url, expected);
          assert.equal(calls[0].init?.redirect, 'error', 'redirects must not be followed');
          assert(calls[0].init?.signal, 'fetch must get an abort signal');
        },
      );
    });
  }

  // ----------------------------------------------------------------
  // Fetch failure modes
  // ----------------------------------------------------------------
  await test('redirect response to another host is not followed', async () => {
    await withFetch(
      async () => new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data' } }),
      async (calls) => {
        await expectUserError(fetchBuildFromURL('https://pobb.in/abc'), /redirect/i);
        assert.equal(calls.length, 1, 'redirect target must not be requested');
      },
    );
  });

  await test('fetch rejecting on redirect: "error" is a UserError', async () => {
    await withFetch(
      async () => {
        throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
      },
      async () => {
        await expectUserError(fetchBuildFromURL('https://pastebin.com/abc'), /redirect|network/i);
      },
    );
  });

  await test('a fetch that never completes times out as a UserError', async () => {
    await withFetch(hangingFetch, async (calls) => {
      const started = Date.now();
      await expectUserError(fetchBuildFromURL('https://pobb.in/abc', { timeoutMs: 50 }), /timed out.*paste the build code/is);
      assert(Date.now() - started < 1000, 'timeout took too long');
      assert(calls[0].init?.signal?.aborted, 'request must be aborted on timeout');
    });
  });

  await test('a body that stalls mid-stream times out as a UserError', async () => {
    await withFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode(CODE.slice(0, 10)));
              // never closes
            },
          }),
        ),
      async () => {
        await expectUserError(fetchBuildFromURL('https://pobb.in/abc', { timeoutMs: 50 }), /timed out/);
      },
    );
  });

  await test('a body larger than the cap is refused without buffering it all', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(65);
    await withFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              pulled++;
              if (pulled > 10_000) c.close(); // safety net (~640 MB)
              else c.enqueue(chunk);
            },
          }),
        ),
      async () => {
        await expectUserError(fetchBuildFromURL('https://pobb.in/abc', { maxBytes: 256 * 1024 }), /larger than/);
        assert(pulled < 20, `read ${pulled} chunks; the cap must stop reading early`);
      },
    );
  });

  await test('the default body cap is enforced while streaming (no Content-Length)', async () => {
    let sent = 0;
    const chunk = new Uint8Array(256 * 1024).fill(65);
    await withFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              sent += chunk.byteLength;
              if (sent > 64 * BUILD_FETCH_MAX_BYTES) c.close();
              else c.enqueue(chunk);
            },
          }),
        ),
      async () => {
        await expectUserError(fetchBuildFromURL('https://pastebin.com/abc'), /larger than/);
        assert(sent <= BUILD_FETCH_MAX_BYTES + 4 * chunk.byteLength, `streamed ${sent} bytes past the cap`);
      },
    );
  });

  await test('a declared Content-Length over the cap is refused before reading', async () => {
    await withFetch(
      async () => new Response('x', { headers: { 'Content-Length': String(BUILD_FETCH_MAX_BYTES + 1) } }),
      async () => {
        await expectUserError(fetchBuildFromURL('https://pastebin.com/abc'), /larger than/);
      },
    );
  });

  await test('non-2xx and network failures are UserErrors suggesting the build code', async () => {
    await withFetch(
      async () => new Response('nope', { status: 404, statusText: 'Not Found' }),
      async () => {
        await expectUserError(fetchBuildFromURL('https://pobb.in/abc'), /HTTP 404.*paste the build code/is);
      },
    );
    await withFetch(
      async () => {
        throw new TypeError('fetch failed');
      },
      async () => {
        await expectUserError(fetchBuildFromURL('https://pobb.in/abc'), /could not download.*paste the build code/is);
      },
    );
  });

  await test('an HTML page instead of a build code is a UserError', async () => {
    await withFetch(
      async () => new Response('<!doctype html><html><body>hi</body></html>'),
      async () => {
        await expectUserError(fetchBuildFromURL('https://pobb.in/abc'), /invalid build code/i);
      },
    );
  });

  // ----------------------------------------------------------------
  // Build-code decoding
  // ----------------------------------------------------------------
  await test('valid code round-trips through encode/decode (and the lua-bridge re-export)', () => {
    assert.equal(decodeBuildCode(CODE), XML);
    assert.equal(reexportedDecode(CODE), XML);
    assert.equal(decodeBuildCode(`  ${CODE.slice(0, 20)}\n${CODE.slice(20)}  `), XML);
    // zlib-wrapped (non-raw) codes still decode through the fallback.
    const zlibCode = deflateSync(Buffer.from(XML)).toString('base64');
    assert.equal(decodeBuildCode(zlibCode), XML);
  });

  await test('a code that inflates past the cap is a UserError', async () => {
    const bomb = deflateRawSync(Buffer.alloc(MAX_DECODED_BUILD_BYTES + 1024, 0x20), { level: 9 });
    const code = bomb.toString('base64');
    assert(code.length < MAX_BUILD_CODE_LENGTH, 'bomb fixture must fit the encoded length cap');
    await expectUserError(() => decodeBuildCode(code), /more than/);
  });

  await test('random base64 that is not deflate data is a UserError', async () => {
    // Deterministic pseudo-random bytes.
    const bytes = Buffer.alloc(600);
    let x = 0x12345678;
    for (let i = 0; i < bytes.length; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      bytes[i] = x & 0xff;
    }
    await expectUserError(() => decodeBuildCode(bytes.toString('base64')), /invalid build code/i);
    await expectUserError(() => decodeBuildCode('A'.repeat(64)), /invalid build code/i);
    await expectUserError(() => decodeBuildCode('not a code!'), /invalid build code/i);
    await expectUserError(() => decodeBuildCode(''), /empty/i);
  });

  await test('deflate data that is not a PoB build is a UserError', async () => {
    await expectUserError(() => decodeBuildCode(encodeBuildCode('hello world, not xml')), /not to a Path of Building build/);
  });

  await test('an over-long code is refused before decoding', async () => {
    await expectUserError(() => decodeBuildCode('A'.repeat(MAX_BUILD_CODE_LENGTH + 1)), /too long/);
  });

  // ----------------------------------------------------------------
  // BuildSession.loadBuild: fetch happens outside the session lock
  // ----------------------------------------------------------------
  await test('loadBuild does not hold the session lock during the fetch', async () => {
    const loaded: string[] = [];
    const fakeBridge = {
      async loadBuildXML(xml: string) {
        loaded.push(xml);
        return { class: 'Witch', level: 90 };
      },
    } as unknown as LuaBridge;
    const session = new BuildSession(fakeBridge);
    const mutex = (session as unknown as { mutex: { acquire(): Promise<() => void> } }).mutex;

    let respond: ((r: Response) => void) | undefined;
    let fetchStarted: () => void = () => {};
    const started = new Promise<void>((r) => (fetchStarted = r));
    await withFetch(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
          fetchStarted();
        }),
      async () => {
        const loading = session.loadBuild('https://pobb.in/abc');
        await started;
        // While the download is pending the lock must be free.
        const release = await Promise.race([
          mutex.acquire(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('lock held during fetch')), 200)),
        ]);
        release();
        respond!(new Response(CODE));
        const info = await loading;
        assert.equal(info.class, 'Witch');
        assert.deepEqual(loaded, [XML]);
      },
    );
  });

  await test('loadBuild surfaces bad codes as UserErrors without touching the engine', async () => {
    let calls = 0;
    const fakeBridge = {
      async loadBuildXML() {
        calls++;
        return {};
      },
    } as unknown as LuaBridge;
    const session = new BuildSession(fakeBridge);
    await expectUserError(session.loadBuild('A'.repeat(64)), /invalid build code/i);
    await expectUserError(session.loadBuild('https://pobb.in.evil.example/abc'), /pobb\.in/);
    assert.equal(calls, 0);
  });

  console.log(failures === 0 ? '\nAll URL-loading tests passed.' : `\n${failures} URL-loading test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
