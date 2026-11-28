import type { Locator } from '@playwright/test';
import { test, expect, rejectServerFn } from './fixtures';

// Read in one call and from the step's own top, because the cards above the wizard are still loading and move all of it.
function offsetWithinStep(button: Locator, stepTestId: string): Promise<number> {
  return button.evaluate(
    (el, id) => el.getBoundingClientRect().top - document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().top,
    stepTestId,
  );
}

test('the Configuration note keeps the variable name inside its sentence', async ({ page }) => {
  await page.goto('/settings');
  await page.getByLabel('Host Name').fill('dev-box');
  const next = page.getByRole('button', { name: 'Next' });
  await next.click();
  await expect(page.getByText('docker-compose.yml').first()).toBeVisible();
  await next.click();

  const name = page.getByTestId('step-env').getByRole('alert').locator('code');
  await expect(name).toHaveText('AGENT_TRUSTED_PUBKEY');
  const followsItsSentence = await name.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el.previousSibling as Node);
    const lines = range.getClientRects();
    const before = lines[lines.length - 1];
    const own = el.getBoundingClientRect();
    return Math.abs(before.top - own.top) < own.height / 2 && own.left >= before.right - 1;
  });
  expect(followsItsSentence).toBe(true);
});

test('a message under a field does not move the wizard buttons', async ({ page }) => {
  await page.goto('/settings');
  await page.getByLabel('Host Name').fill('dev-box');
  await page.getByLabel('ZFS capability').click();
  await page.getByRole('button', { name: 'Next' }).click();
  const uid = page.getByLabel('ZFS user ID');
  await expect(uid).toBeVisible();

  const back = page.getByRole('button', { name: 'Back' });
  const before = await offsetWithinStep(back, 'step-zfs-setup');
  await uid.focus();
  await uid.blur();
  await expect(page.getByText('Enter the number after uid= in the command output.')).toBeVisible();
  expect(await offsetWithinStep(back, 'step-zfs-setup')).toBe(before);
});

test('the capability message does not move the wizard buttons', async ({ page }) => {
  await page.goto('/settings');
  const next = page.getByRole('button', { name: 'Next' });
  const before = await offsetWithinStep(next, 'step-capabilities');
  await page.getByLabel('Docker capability').click();
  await expect(page.getByText('Select at least one capability.')).toBeVisible();
  expect(await offsetWithinStep(next, 'step-capabilities')).toBe(before);
});

test('a host name the server says is taken is reported under the name field', async ({ page }) => {
  await rejectServerFn(page, 'createPendingHost', {
    code: 'name_taken',
    field: 'name',
    message: 'A host named "dev-box" already exists. Choose another name.',
  });
  await page.goto('/settings');
  const name = page.getByLabel('Host Name');
  await name.fill('dev-box');
  await page.getByRole('button', { name: 'Next' }).click();

  await expect(page.getByTestId('step-capabilities').getByRole('alert')).toHaveText(
    'A host with this name already exists. Choose another name.',
  );
  await expect(name).toHaveAttribute('aria-invalid', 'true');
});
