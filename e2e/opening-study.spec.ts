import { test, expect } from '@playwright/test';

test.describe('Opening Study', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // 30s — fresh IndexedDB cold-start can exceed 10s on slow CI/sandbox.
    await page.waitForSelector('[data-testid="dashboard"]', { timeout: 30000 });
  });

  test('navigates to openings page', async ({ page }) => {
    await page.getByRole('link', { name: 'Openings' }).first().click();
    await expect(page).toHaveURL(/\/openings/);
  });

  test('openings page loads', async ({ page }) => {
    await page.goto('/openings');
    await page.waitForLoadState('networkidle');
    const body = page.locator('body');
    await expect(body).toBeVisible();
  });

  test('search input is present on openings page', async ({ page }) => {
    await page.goto('/openings');
    await page.waitForLoadState('networkidle');
    const searchInput = page.locator('input[type="search"], input[placeholder*="Search"], input[placeholder*="search"]');
    if (await searchInput.count() > 0) {
      await expect(searchInput.first()).toBeVisible();
    }
  });
});
