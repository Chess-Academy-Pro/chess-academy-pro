/**
 * Visual smoke check for the new Learn/Practice/Play/Watch glow
 * highlights on the Opening Detail page. Loads a known opening
 * (Italian Game has main lines + variations) and takes screenshots
 * of the action-button trios in resting and hover states.
 */
import { test, expect } from '@playwright/test';

test.describe('Opening action-button glow — visual smoke', () => {
  test.setTimeout(120_000);

  test('Italian Game detail page shows glowing Learn/Practice/Play buttons in variations', async ({ page }) => {
    await page.goto('/openings');
    await page.waitForSelector('[data-testid="dashboard"], main', { timeout: 30_000 });

    // The Most Common tab usually has Italian Game.
    const italian = page.getByText(/Italian Game/i).first();
    await italian.waitFor({ timeout: 30_000 });
    await italian.click();
    await page.waitForLoadState('networkidle', { timeout: 30_000 });

    // Find at least one variation-learn button (these only render
    // when the opening has variations).
    const learnBtn = page.locator('[data-testid^="variation-learn-"]').first();
    await learnBtn.waitFor({ timeout: 30_000 });

    // Verify the glow class is on the DOM.
    const btnClass = await learnBtn.getAttribute('class');
    expect(btnClass).toContain('opening-action-glow');
    expect(btnClass).toContain('opening-action-glow-learn');

    const practiceClass = await page.locator('[data-testid^="variation-practice-"]').first().getAttribute('class');
    expect(practiceClass).toContain('opening-action-glow-practice');

    const playClass = await page.locator('[data-testid^="variation-play-"]').first().getAttribute('class');
    expect(playClass).toContain('opening-action-glow-play');

    const watchClass = await page.locator('[data-testid^="variation-walkthrough-"]').first().getAttribute('class');
    expect(watchClass).toContain('opening-action-glow-watch');

    // Compute the box-shadow at rest to confirm the glow renders.
    // jsdom-style assertion isn't enough; use page.evaluate to read
    // the computed style.
    const restingShadow = await learnBtn.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(restingShadow).not.toBe('none');
    // sky-400 channel signature for the learn glow.
    expect(restingShadow).toMatch(/56, 189, 248/);

    await page.screenshot({ path: 'test-results/opening-action-glow-rest.png', fullPage: false });

    // Hover the Learn button and screenshot the brighter halo.
    await learnBtn.hover();
    await page.waitForTimeout(300);
    const hoverShadow = await learnBtn.evaluate((el) => getComputedStyle(el).boxShadow);
    // Hover state has multiple shadow layers — check it's strictly different from rest.
    expect(hoverShadow).not.toBe(restingShadow);
    await page.screenshot({ path: 'test-results/opening-action-glow-hover.png', fullPage: false });
  });
});
