import { expect, type Locator, type Page } from '@playwright/test';

// TID-074: the list's filters live in a slide-out panel opened from the header's Filters button.

/** Opens the filter panel and returns its locator. */
export async function openFilters(page: Page) {
  await page.getByRole('button', { name: 'Filters' }).click();
  const panel = page.getByRole('dialog', { name: 'Filters' });
  await expect(panel).toBeVisible();
  return panel;
}

/** Closes it with Escape and waits for the slide-out to finish. */
export async function closeFilters(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Filters' })).toHaveCount(0);
  // The panel leaves the accessibility tree at once and the DOM when its slide-out ends.
  await expect(page.locator('.filter-panel')).toHaveCount(0);
}

/**
 * Puts a switch in the wanted state. Clicks, then waits for the app to catch up (a controlled
 * checkbox flips back until the router and the setting have updated, which `check()` would flag).
 */
export async function setSwitch(sw: Locator, on: boolean) {
  if ((await sw.isChecked()) === on) return;
  await sw.click();
  if (on) await expect(sw).toBeChecked();
  else await expect(sw).not.toBeChecked();
}

/** Switches Unread only on or off from the panel, then closes it. */
export async function setUnreadOnly(page: Page, on: boolean) {
  const panel = await openFilters(page);
  const sw = panel.getByRole('switch', { name: 'Unread only' });
  await setSwitch(sw, on);
  await closeFilters(page);
}
