// `freellmapi threads-post`: generate a post through the gateway, then publish
// it to the user's own Threads profile with the official Threads API.
//
// Facts below were checked against Meta's Threads API docs on 2026-11-21:
// - https://developers.facebook.com/docs/threads/posts
//   Text posts are a two-step process: POST /{threads-user-id}/threads with
//   media_type=TEXT and text, then POST /{threads-user-id}/threads_publish with
//   creation_id. "Wait about 30 seconds before publishing a Threads media
//   container." "Text posts are limited to 500 characters. Emojis are counted
//   as the number of UTF-8 bytes."
// - https://developers.facebook.com/docs/threads/overview
//   "The Threads API can be accessed by either graph.threads.com or
//   graph.threads.net." Profiles are limited to 250 API-published posts per
//   rolling 24 hours; GET /{threads-user-id}/threads_publishing_limit
//   (fields quota_usage, config{quota_total, quota_duration}) reports usage and
//   needs threads_basic + threads_content_publish.
// - https://developers.facebook.com/docs/threads/troubleshooting
//   GET /{container-id}?fields=status,error_message returns EXPIRED, ERROR,
//   FINISHED, IN_PROGRESS or PUBLISHED. "We recommend querying a container's
//   status once per minute, for no more than 5 minutes."
// - https://developers.facebook.com/docs/threads/threads-profiles
//   GET /v1.0/me is accepted in place of the numeric user id.
// - https://developers.facebook.com/docs/threads/get-started/long-lived-tokens
//   Long-lived tokens last 60 days and are refreshed with
//   GET /refresh_access_token?grant_type=th_refresh_token.

import fs from 'node:fs';

export const THREADS_API = 'https://graph.threads.net/v1.0';
export const THREADS_TEXT_LIMIT = 500;
const PUBLISH_WAIT_MS = 30_000;
const STATUS_POLL_MS = 60_000;
const STATUS_MAX_POLLS = 5;

export interface ThreadsPostOptions {
  gatewayUrl: string;
  apiKey: string;
  prompt: string;
  model?: string;
  threadsToken?: string;
  dryRun: boolean;
  /** Affiliate/product URL appended as the post's last line. */
  link?: string;
  /** Advertising disclosure placed as the post's first line. Required with a link. */
  disclosure?: string;
  /** CSV of products (name,link,info); one product per run, in rotation. */
  productsFile?: string;
}

export interface Product {
  name: string;
  link: string;
  info: string;
}

export interface ThreadsDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

const defaultDeps: ThreadsDeps = {
  fetch: (...args) => fetch(...args),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  log: line => { process.stdout.write(`${line}\n`); },
};

export function threadsHelp(): string {
  return [
    'Generate a post with the gateway and publish it to Threads:',
    '  freellmapi threads-post --prompt TEXT [--model ID] [--dry-run]',
    '  freellmapi threads-post --prompt TEXT --link URL --disclosure TEXT',
    '  freellmapi threads-post --products FILE.csv --disclosure TEXT [--prompt STYLE]',
    '',
    'Environment:',
    '  FREELLMAPI_API_KEY      unified gateway key (or --api-key)',
    '  THREADS_ACCESS_TOKEN    Threads user access token with threads_basic and',
    '                          threads_content_publish (long-lived tokens last 60 days)',
    '',
    '--dry-run prints the generated post and does not publish it.',
    '--link appends a URL as the last line; --disclosure (required with any link)',
    'is placed as the first line. Both are added by the CLI, never by the model.',
    '--products reads a CSV with a header row name,link,info and posts the next',
    'product each run. Progress is kept in FILE.csv.state and only advances after',
    'a successful publish (never on --dry-run). --prompt then sets tone/style.',
    `Posts longer than ${THREADS_TEXT_LIMIT} characters (emojis count as their UTF-8 bytes) are`,
    'sent back to the model once to shorten; still too long and nothing is posted.',
  ].join('\n');
}

/** Length as Threads counts it: one per character, except emojis, which count
 *  as their UTF-8 byte length. */
export function threadsLength(text: string): number {
  let length = 0;
  for (const char of text) {
    length += /\p{Extended_Pictographic}|\p{Regional_Indicator}|‍|️/u.test(char)
      ? Buffer.byteLength(char, 'utf8')
      : 1;
  }
  return length;
}

function systemPrompt(limit: number, affiliate: boolean): string {
  let prompt = `You write a single Threads post. Reply with the post text only: no preamble, `
    + `no quotes around it, no explanation. Keep it under ${limit} characters.`;
  if (affiliate) {
    // Fabricated first-person reviews are deceptive advertising; the link and
    // the disclosure are added by the CLI so the model cannot drop or alter them.
    prompt += ' This post promotes a product. Use only the facts given. Never invent a personal '
      + 'experience, review, rating, price or discount, and never claim to have used the product. '
      + 'Do not include any URL, link, or advertising disclosure; those are added separately.';
  }
  return prompt;
}

const URL_PATTERN = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;

/** Disclosure first (so it is seen), body, link last. */
export function composePost(body: string, link?: string, disclosure?: string): string {
  return [disclosure?.trim(), body.trim(), link?.trim()].filter(Boolean).join('\n\n');
}

/** Characters the CLI adds around the generated body. */
export function reservedLength(link?: string, disclosure?: string): number {
  const fixed = composePost('', link, disclosure);
  return fixed ? threadsLength(fixed) + 2 : 0;
}

function validateLink(link: string): string {
  let url: URL;
  try { url = new URL(link.trim()); } catch { throw new Error(`Not a valid link: '${link}'`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`Link must be http(s): '${link}'`);
  return url.href;
}

/** Minimal RFC 4180 CSV parser: quoted fields, doubled quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (quoted) throw new Error('CSV has an unterminated quoted field');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(cells => cells.some(cell => cell.trim() !== ''));
}

export function parseProducts(text: string): Product[] {
  const [header, ...rows] = parseCsv(text);
  const columns = (header ?? []).map(cell => cell.trim().toLowerCase());
  const index = (name: string): number => {
    const at = columns.indexOf(name);
    if (at < 0) throw new Error(`Products CSV needs a header row with name,link,info (missing '${name}')`);
    return at;
  };
  const [nameAt, linkAt, infoAt] = [index('name'), index('link'), index('info')];
  const products = rows.map((cells, row) => {
    const name = cells[nameAt]?.trim() ?? '';
    if (!name) throw new Error(`Products CSV row ${row + 2} has no name`);
    return { name, link: validateLink(cells[linkAt] ?? ''), info: cells[infoAt]?.trim() ?? '' };
  });
  if (!products.length) throw new Error('Products CSV has no product rows');
  return products;
}

function statePath(productsFile: string): string {
  return `${productsFile}.state`;
}

export function readNextIndex(productsFile: string): number {
  try {
    const next = Number((JSON.parse(fs.readFileSync(statePath(productsFile), 'utf8')) as { next?: unknown }).next);
    return Number.isSafeInteger(next) && next >= 0 ? next : 0;
  } catch {
    return 0;
  }
}

export function writeNextIndex(productsFile: string, next: number): void {
  fs.writeFileSync(statePath(productsFile), `${JSON.stringify({ next })}\n`);
}

export function productPrompt(product: Product, style?: string): string {
  return [
    `Product: ${product.name}`,
    product.info ? `Facts: ${product.info}` : 'Facts: (none given; describe only what the name states)',
    style?.trim() ? `Style: ${style.trim()}` : 'Style: a short, friendly recommendation in the language of the product name.',
  ].join('\n');
}

async function chat(
  options: ThreadsPostOptions,
  messages: Array<{ role: string; content: string }>,
  deps: ThreadsDeps,
): Promise<string> {
  const response = await deps.fetch(`${options.gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: options.model ?? 'auto', messages }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Gateway chat request failed (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`);
  }
  const body = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
  const text = body.choices?.[0]?.message?.content?.trim().replace(/^"([\s\S]*)"$/, '$1').trim();
  if (!text) throw new Error('The gateway returned an empty post');
  return text;
}

/** Ask the gateway for a post, and once more to shorten it if it is over the
 *  Threads limit. Throws rather than truncating mid-sentence. */
export async function generatePost(
  options: ThreadsPostOptions,
  deps: ThreadsDeps = defaultDeps,
  reserved = 0,
  affiliate = false,
): Promise<string> {
  const limit = THREADS_TEXT_LIMIT - reserved;
  // Leave headroom: models count characters loosely and emojis cost bytes.
  const target = limit - 50;
  if (target < 50) {
    throw new Error(`The link and disclosure take ${reserved} of ${THREADS_TEXT_LIMIT} characters, leaving no room for a post.`);
  }
  const clean = (text: string): string => (affiliate ? text.replace(URL_PATTERN, '').replace(/[ \t]+\n/g, '\n').trim() : text);
  const messages = [
    { role: 'system', content: systemPrompt(target, affiliate) },
    { role: 'user', content: options.prompt },
  ];
  let text = clean(await chat(options, messages, deps));
  if (threadsLength(text) > limit) {
    text = clean(await chat(options, [
      ...messages,
      { role: 'assistant', content: text },
      { role: 'user', content: `That is ${threadsLength(text)} characters. Rewrite it under ${target} characters.` },
    ], deps));
  }
  if (!text) throw new Error('The gateway returned an empty post');
  const length = threadsLength(text) + reserved;
  if (length > THREADS_TEXT_LIMIT) {
    throw new Error(`The generated post is ${length} characters, over the Threads limit of ${THREADS_TEXT_LIMIT}. Nothing was posted.`);
  }
  return text;
}

async function threadsCall<T>(
  deps: ThreadsDeps,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`${THREADS_API}/${path}`);
  const form = new URLSearchParams(params);
  let init: RequestInit = { method, signal: AbortSignal.timeout(30_000) };
  if (method === 'GET') {
    for (const [key, value] of form) url.searchParams.set(key, value);
    url.searchParams.set('access_token', token);
  } else {
    form.set('access_token', token);
    init = { ...init, body: form };
  }
  const response = await deps.fetch(url.href, init);
  const text = await response.text();
  if (!response.ok) {
    // Meta's error bodies do not echo the token, but scrub it anyway so a
    // failure can never print a credential.
    throw new Error(`Threads API ${method} /${path} failed (HTTP ${response.status}): ${text.split(token).join('[redacted]').slice(0, 300)}`);
  }
  return JSON.parse(text) as T;
}

/** Publish a text post: check quota, create the container, wait until it is
 *  FINISHED, publish. Returns the published media id. */
export async function publishText(token: string, text: string, deps: ThreadsDeps = defaultDeps): Promise<string> {
  const limit = await threadsCall<{ data?: Array<{ quota_usage?: number; config?: { quota_total?: number } }> }>(
    deps, token, 'GET', 'me/threads_publishing_limit', { fields: 'quota_usage,config' },
  );
  const usage = limit.data?.[0];
  if (usage?.config?.quota_total !== undefined && usage.quota_usage !== undefined
    && usage.quota_usage >= usage.config.quota_total) {
    throw new Error(`Threads publishing quota used up (${usage.quota_usage}/${usage.config.quota_total} in the last 24 hours). Nothing was posted.`);
  }

  const container = await threadsCall<{ id: string }>(deps, token, 'POST', 'me/threads', { media_type: 'TEXT', text });
  await deps.sleep(PUBLISH_WAIT_MS);
  for (let poll = 0; ; poll += 1) {
    const { status, error_message: error } = await threadsCall<{ status?: string; error_message?: string }>(
      deps, token, 'GET', container.id, { fields: 'status,error_message' },
    );
    if (status === 'FINISHED') break;
    if (status !== 'IN_PROGRESS' || poll + 1 >= STATUS_MAX_POLLS) {
      throw new Error(`Threads container ${container.id} is ${status ?? 'in an unknown state'}${error ? ` (${error})` : ''}. Nothing was posted.`);
    }
    await deps.sleep(STATUS_POLL_MS);
  }
  const published = await threadsCall<{ id: string }>(deps, token, 'POST', 'me/threads_publish', { creation_id: container.id });
  return published.id;
}

export async function runThreadsPost(options: ThreadsPostOptions, deps: ThreadsDeps = defaultDeps): Promise<number> {
  let { prompt, link } = options;
  let product: { file: string; next: number; total: number; item: Product } | undefined;
  if (options.productsFile) {
    if (options.link) throw new Error('--link and --products cannot be combined; each product row has its own link');
    const products = parseProducts(fs.readFileSync(options.productsFile, 'utf8'));
    const next = readNextIndex(options.productsFile);
    const item = products[next % products.length];
    product = { file: options.productsFile, next, total: products.length, item };
    prompt = productPrompt(item, options.prompt);
    link = item.link;
  } else if (!prompt.trim()) {
    throw new Error('threads-post requires --prompt (or --products)');
  }
  if (link) link = validateLink(link);
  const disclosure = options.disclosure?.trim() || undefined;
  if (link && !disclosure) {
    throw new Error('A post with a link must carry an advertising disclosure: pass --disclosure TEXT.');
  }
  if (!options.dryRun && !options.threadsToken) {
    throw new Error('Set THREADS_ACCESS_TOKEN to a Threads user access token (or pass --dry-run to only generate).');
  }
  if (product) deps.log(`Product ${(product.next % product.total) + 1}/${product.total}: ${product.item.name}\n`);
  const body = await generatePost({ ...options, prompt }, deps, reservedLength(link, disclosure), Boolean(link));
  const text = composePost(body, link, disclosure);
  deps.log(text);
  if (options.dryRun) {
    deps.log(`\n(dry run: ${threadsLength(text)}/${THREADS_TEXT_LIMIT} characters, not posted)`);
    return 0;
  }
  const id = await publishText(options.threadsToken!, text, deps);
  deps.log(`\nPublished to Threads (media id ${id})`);
  if (product) writeNextIndex(product.file, (product.next + 1) % product.total);
  return 0;
}
