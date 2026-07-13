import { expect, test } from '@playwright/test';

test('opens about:blank as a Playwright wiring smoke test', async ({ page }) => {
  await page.goto('about:blank');
  expect(page.url()).toBe('about:blank');
});
