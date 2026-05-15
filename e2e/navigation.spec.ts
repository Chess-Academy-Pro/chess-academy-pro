import { test, expect } from '@playwright/test';

test.describe('Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // 30s — fresh IndexedDB cold-start can exceed 10s on slow machines.
    // App boots seed openings DB before the dashboard testid mounts.
    await page.waitForSelector('[data-testid="dashboard"]', { timeout: 30000 });
  });

  test('dashboard loads as home page', async ({ page }) => {
    await expect(page.getByTestId('dashboard')).toBeVisible();
  });

  test('navigates to tactics via sidebar', async ({ page }) => {
    await page.getByRole('link', { name: 'Tactics' }).first().click();
    await expect(page).toHaveURL(/\/tactics/);
  });

  test('navigates to openings via sidebar', async ({ page }) => {
    await page.getByRole('link', { name: 'Openings' }).first().click();
    await expect(page).toHaveURL(/\/openings/);
  });

  test('navigates to coach via sidebar', async ({ page }) => {
    await page.getByRole('link', { name: 'Coach' }).first().click();
    await expect(page).toHaveURL(/\/coach/);
  });

  test('navigates to weaknesses via sidebar', async ({ page }) => {
    await page.getByRole('link', { name: 'Weaknesses' }).first().click();
    await expect(page).toHaveURL(/\/weaknesses/);
  });

  test('navigates to kids mode via sidebar', async ({ page }) => {
    await page.getByRole('link', { name: 'Kids Mode' }).first().click();
    await expect(page).toHaveURL(/\/kid/);
  });

  test('navigates to settings via sidebar', async ({ page }) => {
    await page.getByRole('link', { name: 'Settings' }).first().click();
    await expect(page).toHaveURL(/\/settings/);
  });

  test('unknown routes redirect to dashboard', async ({ page }) => {
    await page.goto('/nonexistent-route');
    await expect(page).toHaveURL('/');
  });

  test('back navigation works after visiting a page', async ({ page }) => {
    await page.getByRole('link', { name: 'Tactics' }).first().click();
    await expect(page).toHaveURL(/\/tactics/);
    await page.goBack();
    await expect(page).toHaveURL('/');
  });
});
