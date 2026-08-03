import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sendTeamsNotification } from '../../src/services/teams-notifier.service';

let originalFetch: typeof fetch;
let originalWebhookUrl: string | undefined;

beforeEach(() => {
  originalFetch = global.fetch;
  originalWebhookUrl = process.env.TEAMS_WEBHOOK_URL;
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalWebhookUrl === undefined) {
    delete process.env.TEAMS_WEBHOOK_URL;
  } else {
    process.env.TEAMS_WEBHOOK_URL = originalWebhookUrl;
  }
});

describe('sendTeamsNotification', () => {
  test('does nothing and does not call fetch when TEAMS_WEBHOOK_URL is unset', async () => {
    delete process.env.TEAMS_WEBHOOK_URL;
    let called = false;
    global.fetch = (async () => {
      called = true;
      return { ok: true } as Response;
    }) as typeof fetch;

    await sendTeamsNotification('title', 'details');

    assert.equal(called, false);
  });

  test('POSTs a JSON body containing the title and details to the configured webhook URL', async () => {
    process.env.TEAMS_WEBHOOK_URL = 'https://example.test/webhook';
    let capturedUrl: string | undefined;
    let capturedOptions: RequestInit | undefined;
    global.fetch = (async (url: string | URL, options?: RequestInit) => {
      capturedUrl = String(url);
      capturedOptions = options;
      return { ok: true } as Response;
    }) as typeof fetch;

    await sendTeamsNotification('My Title', 'My details');

    assert.equal(capturedUrl, 'https://example.test/webhook');
    assert.equal(capturedOptions?.method, 'POST');
    const body = JSON.parse(String(capturedOptions?.body));
    assert.match(body.text, /My Title/);
    assert.match(body.text, /My details/);
  });

  test('does not throw or reject when the webhook responds with a non-OK status', async () => {
    process.env.TEAMS_WEBHOOK_URL = 'https://example.test/webhook';
    global.fetch = (async () => ({
      ok: false,
      status: 500,
      text: async () => 'boom'
    } as Response)) as typeof fetch;

    await assert.doesNotReject(() => sendTeamsNotification('title', 'details'));
  });
});
