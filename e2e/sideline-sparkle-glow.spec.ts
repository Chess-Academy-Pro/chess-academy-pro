import { test, expect } from '@playwright/test';

test('Sideline sparkle has purple line-glow', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/openings');
  await page.waitForSelector('[data-testid="dashboard"], main', { timeout: 30_000 });

  // Italian Game has variations w/ sparkle.
  const italian = page.getByText(/Italian Game/i).first();
  await italian.waitFor({ timeout: 30_000 });
  await italian.click();
  await page.waitForLoadState('networkidle', { timeout: 30_000 });

  // Scroll variations into view.
  const sparkle = page.locator('[data-testid="sideline-explain-btn"]').first();
  await sparkle.waitFor({ timeout: 30_000 });
  await sparkle.scrollIntoViewIfNeeded();

  // Verify the .sideline-sparkle-glow class is applied + filter is non-none.
  const svg = sparkle.locator('svg').first();
  const filter = await svg.evaluate((el) => getComputedStyle(el).filter);
  expect(filter).not.toBe('none');
  expect(filter).toMatch(/drop-shadow/i);

  // Capture for visual review.
  await page.screenshot({ path: 'test-results/sideline-sparkle-glow.png', fullPage: false });
});
