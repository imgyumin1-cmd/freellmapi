import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from './index.js';
import {
  THREADS_API, generatePost, publishText, runThreadsPost, threadsLength, type ThreadsDeps,
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
