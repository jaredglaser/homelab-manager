import { test, expect } from './fixtures';

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
  const before = await back.boundingBox();
  await uid.focus();
  await uid.blur();
  await expect(page.getByText('Enter the number after uid= in the command output.')).toBeVisible();
  expect(await back.boundingBox()).toEqual(before);
});
