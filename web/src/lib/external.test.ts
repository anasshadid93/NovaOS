import { describe, expect, it } from 'vitest';
import { androidIntentUrl } from './external';

describe('androidIntentUrl', () => {
  it('hands the exact address to the browser app, with a web fallback', () => {
    const u = androidIntentUrl('https://my-server.tailnet.ts.net:20001/x/?a=1', 'com.android.chrome');
    expect(u).toBe(
      'intent://my-server.tailnet.ts.net:20001/x/?a=1#Intent;scheme=https;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;package=com.android.chrome;S.browser_fallback_url=https%3A%2F%2Fmy-server.tailnet.ts.net%3A20001%2Fx%2F%3Fa%3D1;end',
    );
  });
});
