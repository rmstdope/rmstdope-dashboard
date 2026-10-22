import { expect } from "@playwright/test";

export async function verifyTheme(page) {
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.locator("body").evaluate(node => getComputedStyle(node).backgroundColor)).toBe("rgb(246, 247, 248)");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.locator("body").evaluate(node => getComputedStyle(node).backgroundColor)).toBe("rgb(16, 18, 20)");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
