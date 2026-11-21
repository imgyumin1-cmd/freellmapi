import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from './index.js';
import {
  THREADS_API, composePost, generatePost, parseCsv, parsePosts, parseProducts, publishText, readNextIndex,
  runThreadsPost, threadsLength, type ThreadsDeps,
} from './threads.js';

const token = 'threads-secret-token';

interface Call { url: URL; init: RequestInit }

function deps(handler: (url: URL, init: RequestInit) => Response): ThreadsDeps & { calls: Call[]; lines: string[]; sleeps: number[] } {
  const calls: Call[] = [];
  const lines: string[] = [];
  const sleeps: number[] = [];
  return {
    calls, lines, sleeps,
    fetch: (async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      calls.push({ url, init });
      return handler(url, init);
    }) as typeof fetch,
    sleep: async ms => { sleeps.push(ms); },
    log: line => { lines.push(line); },
  };
}

const chatReply = (content: string) => Response.json({ choices: [{ message: { content } }] });
const base = { gatewayUrl: 'http://localhost:3001', apiKey: 'gw-key', prompt: 'write about coffee', dryRun: false };

function threadsHandler(statuses: string[], quota = { quota_usage: 3, config: { quota_total: 250 } }) {
  return (url: URL, init: RequestInit): Response => {
    if (url.href.startsWith('http://localhost:3001')) return chatReply('Morning coffee ☕ is a ritual.');
    const path = url.pathname.replace('/v1.0/', '');
    if (path === 'me/threads_publishing_limit') return Response.json({ data: [quota] });
    if (path === 'me/threads' && init.method === 'POST') return Response.json({ id: 'c1' });
    if (path === 'c1') return Response.json({ status: statuses.shift() ?? 'FINISHED', id: 'c1' });
    if (path === 'me/threads_publish') return Response.json({ id: 'm1' });
    throw new Error(`unexpected ${url.href}`);
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('threadsLength', () => {
  it('counts characters, and emojis as their UTF-8 bytes', () => {
    expect(threadsLength('hello')).toBe(5);
    expect(threadsLength('안녕')).toBe(2);
    expect(threadsLength('☕')).toBe(3);
    expect(threadsLength('😀')).toBe(4);
  });
});

describe('generatePost', () => {
  it('sends the prompt to the gateway and strips wrapping quotes', async () => {
    const d = deps(() => chatReply('"Hello Threads"'));
    expect(await generatePost({ ...base, model: 'm-1' }, d)).toBe('Hello Threads');
    const body = JSON.parse(String(d.calls[0].init.body));
    expect(d.calls[0].url.pathname).toBe('/v1/chat/completions');
    expect(body.model).toBe('m-1');
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'write about coffee' });
    expect(new Headers(d.calls[0].init.headers).get('Authorization')).toBe('Bearer gw-key');
  });

  it('asks once to shorten an over-long post', async () => {
    const replies = ['x'.repeat(600), 'short now'];
    const d = deps(() => chatReply(replies.shift()!));
    expect(await generatePost(base, d)).toBe('short now');
    expect(d.calls).toHaveLength(2);
  });

  it('refuses to post when the post is still too long', async () => {
    const d = deps(() => chatReply('x'.repeat(600)));
    await expect(generatePost(base, d)).rejects.toThrow(/over the Threads limit of 500/);
  });
});

describe('publishText', () => {
  it('checks quota, creates a TEXT container, waits, polls and publishes', async () => {
    const d = deps(threadsHandler(['IN_PROGRESS', 'FINISHED']));
    expect(await publishText(token, 'hi', d)).toBe('m1');
    expect(d.calls.map(c => `${c.init.method} ${c.url.pathname}`)).toEqual([
      'GET /v1.0/me/threads_publishing_limit',
      'POST /v1.0/me/threads',
      'GET /v1.0/c1',
      'GET /v1.0/c1',
      'POST /v1.0/me/threads_publish',
    ]);
    expect(d.calls[0].url.origin + '/v1.0').toBe(THREADS_API);
    const create = new URLSearchParams(String(d.calls[1].init.body));
    expect(Object.fromEntries(create)).toEqual({ media_type: 'TEXT', text: 'hi', access_token: token });
    expect(new URLSearchParams(String(d.calls[4].init.body)).get('creation_id')).toBe('c1');
    expect(d.sleeps).toEqual([30_000, 60_000]);
  });

  it('stops before creating anything when the quota is used up', async () => {
    const d = deps(threadsHandler([], { quota_usage: 250, config: { quota_total: 250 } }));
    await expect(publishText(token, 'hi', d)).rejects.toThrow(/quota used up \(250\/250/);
    expect(d.calls).toHaveLength(1);
  });

  it('does not publish an errored container', async () => {
    const d = deps(threadsHandler(['ERROR']));
    await expect(publishText(token, 'hi', d)).rejects.toThrow(/is ERROR/);
    expect(d.calls.some(c => c.url.pathname.endsWith('threads_publish'))).toBe(false);
  });

  it('gives up after five status checks', async () => {
    const d = deps(threadsHandler(Array(10).fill('IN_PROGRESS')));
    await expect(publishText(token, 'hi', d)).rejects.toThrow(/IN_PROGRESS/);
    expect(d.calls.filter(c => c.url.pathname === '/v1.0/c1')).toHaveLength(5);
  });

  it('never prints the token in an API error', async () => {
    const d = deps(() => new Response(`bad token ${token}`, { status: 400 }));
    const error = await publishText(token, 'hi', d).catch(e => e as Error);
    expect(error.message).toContain('HTTP 400');
    expect(error.message).not.toContain(token);
  });
});

describe('runThreadsPost', () => {
  it('dry run prints the post and never calls Threads', async () => {
    const d = deps(threadsHandler([]));
    expect(await runThreadsPost({ ...base, dryRun: true }, d)).toBe(0);
    expect(d.calls.every(c => c.url.host === 'localhost:3001')).toBe(true);
    expect(d.lines.join('\n')).toContain('not posted');
  });

  it('requires a Threads token unless dry run', async () => {
    const d = deps(threadsHandler([]));
    await expect(runThreadsPost(base, d)).rejects.toThrow(/THREADS_ACCESS_TOKEN/);
    expect(d.calls).toHaveLength(0);
  });

  it('publishes and reports the media id', async () => {
    const d = deps(threadsHandler([]));
    await runThreadsPost({ ...base, threadsToken: token }, d);
    expect(d.lines.join('\n')).toContain('media id m1');
    expect(d.lines.join('\n')).not.toContain(token);
  });
});

describe('CLI wiring', () => {
  it('rejects --prompt on other commands and requires it for threads-post', async () => {
    await expect(main(['list', '--prompt', 'x'])).rejects.toThrow(/only supported by threads-post/);
    await expect(main(['threads-post', '--api-key', 'k', '--dry-run'])).rejects.toThrow(/requires --prompt/);
  });

  it('prints threads-post help', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
    await main(['threads-post', '--help']);
    expect(output).toContain('THREADS_ACCESS_TOKEN');
  });
});

const disclosure = '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.';

describe('affiliate posts', () => {
  it('puts the disclosure first and the link last, and strips model URLs', async () => {
    const handler = threadsHandler([]);
    const d = deps((url, init) => (url.host === 'localhost:3001'
      ? chatReply('좋은 청소기 https://evil.example/x 입니다')
      : handler(url, init)));
    await runThreadsPost({ ...base, threadsToken: token, link: 'https://link.coupang.com/a/abc', disclosure }, d);
    const create = d.calls.find(c => c.url.pathname === '/v1.0/me/threads')!;
    const text = new URLSearchParams(String(create.init.body)).get('text')!;
    expect(text.startsWith(disclosure)).toBe(true);
    expect(text.endsWith('https://link.coupang.com/a/abc')).toBe(true);
    expect(text).not.toContain('evil.example');
    const system = JSON.parse(String(d.calls[0].init.body)).messages[0].content as string;
    expect(system).toMatch(/Never invent a personal experience/);
  });

  it('refuses a link without a disclosure', async () => {
    const d = deps(threadsHandler([]));
    await expect(runThreadsPost({ ...base, dryRun: true, link: 'https://link.coupang.com/a/abc' }, d))
      .rejects.toThrow(/advertising disclosure/);
    expect(d.calls).toHaveLength(0);
  });

  it('rejects a non-http link', async () => {
    const d = deps(threadsHandler([]));
    await expect(runThreadsPost({ ...base, dryRun: true, link: 'javascript:alert(1)', disclosure }, d))
      .rejects.toThrow(/http\(s\)/);
  });

  it('keeps the whole post within 500 characters', async () => {
    const replies = ['가'.repeat(480), '짧은 소개'];
    const d = deps(() => chatReply(replies.shift()!));
    const body = await generatePost(base, d, 120, true);
    expect(body).toBe('짧은 소개');
    expect(threadsLength(composePost(body, 'https://a.example/x', disclosure))).toBeLessThanOrEqual(500);
  });
});

describe('CSV products', () => {
  it('parses quoted fields, doubled quotes, CRLF and a BOM', () => {
    expect(parseCsv('﻿name,link,info\r\n"A, B",https://x.example,"say ""hi"""\r\n\r\n'))
      .toEqual([['name', 'link', 'info'], ['A, B', 'https://x.example', 'say "hi"']]);
  });

  it('requires the header columns and valid links', () => {
    expect(() => parseProducts('title,link\nA,https://x.example')).toThrow(/missing 'name'/);
    expect(() => parseProducts('name,link,info\nA,not a url,x')).toThrow(/Not a valid link/);
    expect(() => parseProducts('name,link,info\n')).toThrow(/no product rows/);
    expect(parseProducts('Info,LINK,name\nfacts,https://x.example/p,청소기'))
      .toEqual([{ name: '청소기', link: 'https://x.example/p', info: 'facts' }]);
  });

  function productsFile(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-products-'));
    const file = path.join(dir, 'products.csv');
    fs.writeFileSync(file, 'name,link,info\n청소기 A,https://link.coupang.com/a/1,무게 1.2kg\n텀블러 B,https://link.coupang.com/a/2,보온 12시간\n');
    return file;
  }

  it('posts products in rotation and advances only after publishing', async () => {
    const file = productsFile();
    const d = deps(threadsHandler([]));
    await runThreadsPost({ ...base, prompt: '', dryRun: true, productsFile: file, disclosure }, d);
    expect(readNextIndex(file)).toBe(0);
    expect(JSON.parse(String(d.calls[0].init.body)).messages[1].content).toContain('청소기 A');

    for (const [expected, next] of [['https://link.coupang.com/a/1', 1], ['https://link.coupang.com/a/2', 0]] as const) {
      const run = deps(threadsHandler([]));
      await runThreadsPost({ ...base, prompt: '', threadsToken: token, productsFile: file, disclosure }, run);
      const create = run.calls.find(c => c.url.pathname === '/v1.0/me/threads')!;
      expect(new URLSearchParams(String(create.init.body)).get('text')).toContain(expected);
      expect(readNextIndex(file)).toBe(next);
    }
  });

  it('does not advance when publishing fails', async () => {
    const file = productsFile();
    const d = deps(threadsHandler(['ERROR']));
    await expect(runThreadsPost({ ...base, prompt: '', threadsToken: token, productsFile: file, disclosure }, d))
      .rejects.toThrow(/ERROR/);
    expect(readNextIndex(file)).toBe(0);
  });

  it('requires a disclosure and rejects --link alongside --products', async () => {
    const file = productsFile();
    await expect(runThreadsPost({ ...base, prompt: '', dryRun: true, productsFile: file }, deps(threadsHandler([]))))
      .rejects.toThrow(/advertising disclosure/);
    await expect(runThreadsPost({ ...base, dryRun: true, productsFile: file, disclosure, link: 'https://x.example' }, deps(threadsHandler([]))))
      .rejects.toThrow(/cannot be combined/);
  });

  it('accepts the new flags only on threads-post', async () => {
    await expect(main(['list', '--products', 'x.csv'])).rejects.toThrow(/--products is only supported by threads-post/);
    await expect(main(['list', '--link', 'https://x.example'])).rejects.toThrow(/--link is only supported/);
  });
});

describe('direct OpenAI-compatible provider (GitHub Actions setup)', () => {
  it('sends chat to <base>/chat/completions for a base URL ending in /openai/v1', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
      seen.push(input);
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer provider-key');
      expect(JSON.parse(String(init.body)).model).toBe('openai/gpt-oss-120b');
      return chatReply('짧은 소개');
    }));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await main(['threads-post', '--url', 'https://api.groq.com/openai/v1', '--api-key', 'provider-key',
        '--model', 'openai/gpt-oss-120b', '--prompt', 'x', '--dry-run']);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(seen).toEqual(['https://api.groq.com/openai/v1/chat/completions']);
  });
});

describe('pasted secrets', () => {
  it('trims a trailing newline from the API key before sending it', async () => {
    let auth: string | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_input: string, init: RequestInit = {}) => {
      auth = new Headers(init.headers).get('Authorization');
      return chatReply('짧은 소개');
    }));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.stubEnv('FREELLMAPI_API_KEY', 'gsk_key\n');
    try {
      await main(['threads-post', '--url', 'https://api.groq.com/openai/v1', '--model', 'm', '--prompt', 'x', '--dry-run']);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(auth).toBe('Bearer gsk_key');
  });
});

describe('ready-written posts (--posts)', () => {
  function postsFile(body = 'text\n"첫 번째 글\n\n두 줄째"\n두 번째 글\n'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-posts-'));
    const file = path.join(dir, 'posts.csv');
    fs.writeFileSync(file, body);
    return file;
  }

  it('parses multi-line quoted posts and rejects links, empties and over-long posts', () => {
    expect(parsePosts('text\n"a\n\nb"\nc\n')).toEqual(['a\n\nb', 'c']);
    expect(() => parsePosts('body\nx')).toThrow(/'text' column/);
    expect(() => parsePosts('text\n')).toThrow(/no posts/);
    expect(() => parsePosts('text\nsee https://x.example')).toThrow(/contains a link/);
    expect(() => parsePosts(`text\n${'가'.repeat(501)}`)).toThrow(/over the Threads limit/);
  });

  it('posts verbatim without calling the model, and rotates only after publishing', async () => {
    const file = postsFile();
    const preview = deps(threadsHandler([]));
    await runThreadsPost({ ...base, prompt: '', dryRun: true, postsFile: file }, preview);
    expect(preview.calls).toHaveLength(0);
    expect(preview.lines.join('\n')).toContain('첫 번째 글\n\n두 줄째');
    expect(readNextIndex(file)).toBe(0);

    for (const [expected, next] of [['첫 번째 글\n\n두 줄째', 1], ['두 번째 글', 0]] as const) {
      const run = deps(threadsHandler([]));
      await runThreadsPost({ ...base, prompt: '', threadsToken: token, postsFile: file }, run);
      expect(run.calls.some(c => c.url.host === 'localhost:3001')).toBe(false);
      const create = run.calls.find(c => c.url.pathname === '/v1.0/me/threads')!;
      expect(new URLSearchParams(String(create.init.body)).get('text')).toBe(expected);
      expect(readNextIndex(file)).toBe(next);
    }
  });

  it('refuses to mix --posts with generation options', async () => {
    const file = postsFile();
    await expect(runThreadsPost({ ...base, dryRun: true, postsFile: file }, deps(threadsHandler([]))))
      .rejects.toThrow(/cannot be combined/);
  });

  it('needs no API key from the CLI', async () => {
    vi.stubEnv('FREELLMAPI_API_KEY', '');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(main(['threads-post', '--posts', postsFile(), '--dry-run'])).resolves.toBe(0);
  });
});

describe('readable formatting', () => {
  it('asks the model for short, casual, human-sounding lines', async () => {
    const d = deps(() => chatReply('ok'));
    await generatePost(base, d);
    const system = JSON.parse(String(d.calls[0].init.body)).messages[0].content as string;
    expect(system).toMatch(/line break between thoughts/);
    expect(system).toMatch(/real person posting casually/);
    expect(system).toMatch(/hashtags/);
  });
});

describe('buyer reviews', () => {
  it('reads an optional reviews column and passes it as attributed buyer reviews', async () => {
    expect(parseProducts('name,link,info\nA,https://x.example/a,f')[0].reviews).toBeUndefined();
    const [product] = parseProducts('name,link,info,reviews\nA,https://x.example/a,f,"따뜻해요, 세탁해도 보풀 없음"');
    expect(product.reviews).toBe('따뜻해요, 세탁해도 보풀 없음');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-reviews-'));
    const file = path.join(dir, 'products.csv');
    fs.writeFileSync(file, 'name,link,info,reviews\n담요,https://link.coupang.com/a/1,극세사,"생각보다 두꺼움, 보풀 적음"\n');
    const d = deps(threadsHandler([]));
    await runThreadsPost({ ...base, prompt: '', dryRun: true, productsFile: file, disclosure }, d);
    const body = JSON.parse(String(d.calls[0].init.body));
    expect(body.messages[1].content).toContain('Buyer reviews (real, copied from buyers): 생각보다 두꺼움, 보풀 적음');
    expect(body.messages[0].content).toMatch(/always attribute it to buyers/);
    expect(body.messages[0].content).toMatch(/never claim to have used the product/);
  });
});

describe('--extra-body', () => {
  it('merges provider fields into the chat request without overriding model or messages', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: string, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body));
      expect(body.max_completion_tokens).toBe(800);
      expect(body.reasoning_effort).toBe('none');
      expect(body.model).toBe('qwen/qwen3.8-27b');
      expect(Array.isArray(body.messages)).toBe(true);
      return chatReply('짧은 소개');
    }));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await main(['threads-post', '--url', 'https://api.groq.com/openai/v1', '--api-key', 'k', '--model', 'qwen/qwen3.8-27b',
        '--extra-body', '{"max_completion_tokens":800,"reasoning_effort":"none","model":"evil","messages":[]}',
        '--prompt', 'x', '--dry-run']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects anything but a JSON object', async () => {
    await expect(main(['threads-post', '--api-key', 'k', '--extra-body', '[1]', '--prompt', 'x', '--dry-run'])).rejects.toThrow(/JSON object/);
    await expect(main(['threads-post', '--api-key', 'k', '--extra-body', 'nope', '--prompt', 'x', '--dry-run'])).rejects.toThrow(/JSON object/);
  });
});
