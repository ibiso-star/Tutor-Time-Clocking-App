import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("demo-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("tutor clocks in, takes a break, clocks out and requests a correction", async ({ page }) => {
  await signIn(page, "alan@example.com");
  await expect(page.getByRole("heading", { name: "Clocked out" })).toBeVisible();
  await expect(page.getByText("Ready to start your shift?")).toBeVisible();

  await page.getByRole("button", { name: "Clock in" }).click();
  await expect(page.getByRole("heading", { name: "Clocked in" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /Clocked in at/ })).toBeAttached();

  await page.getByRole("button", { name: "Start break" }).click();
  await expect(page.getByRole("heading", { name: "On break" })).toBeVisible();
  await expect(page.getByText("End your break before clocking out.")).toBeVisible();
  await page.getByRole("button", { name: "End break" }).click();
  await expect(page.getByRole("heading", { name: "Clocked in" })).toBeVisible();

  await page.getByRole("button", { name: "Clock out" }).click();
  await expect(page.getByRole("heading", { name: "Clocked out" })).toBeVisible();

  await page.getByRole("link", { name: "History", exact: true }).click();
  await page.locator(".list-row").first().click();
  await expect(page.getByText("Clocked in", { exact: true })).toBeVisible();
  await expect(page.getByText("Break started")).toBeVisible();
  await page.getByRole("button", { name: "Request a correction" }).click();
  await page.getByLabel("What happened?").fill("I stayed 15 minutes late to finish with a student.");
  await page.getByRole("button", { name: "Submit request" }).click();
  await expect(page.getByText("Your correction request is pending review. Your original time record has not changed.")).toBeVisible();

  await page.getByRole("link", { name: "Requests" }).click();
  await expect(page.getByText("Pending review").first()).toBeVisible();
});

test("offline state blocks clock actions and explains why", async ({ page, context }) => {
  await signIn(page, "ada@example.com");
  await expect(page.getByRole("button", { name: "Clock in" })).toBeEnabled();
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.getByText("You're offline.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Clock in" })).toBeDisabled();
  await context.setOffline(false);
});

test("tutor home has no horizontal scroll at phone width", async ({ page }) => {
  await signIn(page, "grace@example.com");
  await expect(page.getByRole("heading", { name: "Clocked in" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
