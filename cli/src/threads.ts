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
    '',
    'Environment:',
    '  FREELLMAPI_API_KEY      unified gateway key (or --api-key)',
    '  THREADS_ACCESS_TOKEN    Threads user access token with threads_basic and',
    '                          threads_content_publish (long-lived tokens last 60 days)',
    '',
    '--dry-run prints the generated post and does not publish it.',
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

function systemPrompt(limit: number): string {
  return `You write a single Threads post. Reply with the post text only: no preamble, `
    + `no quotes around it, no explanation. Keep it under ${limit} characters.`;
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
export async function generatePost(options: ThreadsPostOptions, deps: ThreadsDeps = defaultDeps): Promise<string> {
  // Leave headroom: models count characters loosely and emojis cost bytes.
  const target = THREADS_TEXT_LIMIT - 50;
  const messages = [
    { role: 'system', content: systemPrompt(target) },
    { role: 'user', content: options.prompt },
  ];
  let text = await chat(options, messages, deps);
  if (threadsLength(text) > THREADS_TEXT_LIMIT) {
    text = await chat(options, [
      ...messages,
      { role: 'assistant', content: text },
      { role: 'user', content: `That is ${threadsLength(text)} characters. Rewrite it under ${target} characters.` },
    ], deps);
  }
  const length = threadsLength(text);
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
  if (!options.prompt.trim()) throw new Error('threads-post requires --prompt');
  if (!options.dryRun && !options.threadsToken) {
    throw new Error('Set THREADS_ACCESS_TOKEN to a Threads user access token (or pass --dry-run to only generate).');
  }
  const text = await generatePost(options, deps);
  deps.log(text);
  if (options.dryRun) {
    deps.log(`\n(dry run: ${threadsLength(text)}/${THREADS_TEXT_LIMIT} characters, not posted)`);
    return 0;
  }
  const id = await publishText(options.threadsToken!, text, deps);
  deps.log(`\nPublished to Threads (media id ${id})`);
  return 0;
}
