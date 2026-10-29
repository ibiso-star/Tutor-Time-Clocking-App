import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("demo-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("supervisor reviews the roster and approves a correction", async ({ page }) => {
  await signIn(page, "supervisor@example.com");
  await expect(page.getByRole("heading", { name: "Live roster" })).toBeVisible();
  const table = page.getByRole("table");
  await expect(table.getByText("Grace Hopper")).toBeVisible();
  await expect(table.getByText("Alan Turing")).toHaveCount(0); // other team

  await page.getByRole("link", { name: /Corrections/ }).click();
  await page.getByRole("button", { name: "Review" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Approve" })).toBeDisabled();
  await dialog.getByLabel("Reason for your decision").fill("Confirmed with the site lead.");
  await dialog.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Nothing waiting for review.")).toBeVisible();
});

test("admin records a missed clock-out with preview and reason", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.getByRole("table").getByRole("link", { name: "Mary Jackson" }).click();
  await page.getByRole("button", { name: "Record clock-out time" }).click();
  const dialog = page.getByRole("dialog");
  const start = await page.evaluate(() => document.querySelector("h1 + p")?.textContent ?? "");
  expect(start).toContain("Session started");
  const end = dialog.getByLabel("When did the tutor actually stop working?");
  const value = await page.evaluate(() => {
    // Mary's seeded session started yesterday at 09:00 project time.
    const d = new Date(Date.now() - 24 * 3600_000);
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(d) + "T15:00";
  });
  await end.fill(value);
  await dialog.getByLabel("Reason").fill("Tutor confirmed they left at 3pm.");
  await dialog.getByRole("button", { name: "Preview change" }).click();
  await expect(dialog.getByText("This will close the open session.")).toBeVisible();
  await dialog.getByRole("button", { name: "Record clock-out" }).click();
  await expect(page.getByText("Clocked out", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("recorded during review by Avery Admin")).toBeVisible();
});

test("admin previews and generates a CSV export", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.getByRole("link", { name: "Exports", exact: true }).click();
  await page.getByRole("button", { name: "Preview totals" }).click();
  await expect(page.getByText(/across \d+ sessions/)).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Generate CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^timesheet_.*\.csv$/);
});
