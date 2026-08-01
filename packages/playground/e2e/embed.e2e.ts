import { expect, test } from "@playwright/test";

// Drives the standalone embed demo page (served by the dev server at
// /embed-demo.html). Proves the inline affordances end to end: a run marker
// next to each query (whose result opens in a popover), and a data chip next to
// each `extensional` that opens an editable popover.
test.describe("embed mini-playground", () => {
  test("mounts an editor, a run marker, and a data chip per block", async ({ page }) => {
    await page.goto("/embed-demo.html");
    await expect(page.locator(".datamog-embed .cm-editor")).toHaveCount(2);
    // One query and one extensional per demo block → one marker + one chip each.
    await expect(page.locator(".datamog-embed-runquery")).toHaveCount(2);
    await expect(page.locator(".datamog-embed-chip")).toHaveCount(2);
  });

  test("syntax highlighting is applied and coloured", async ({ page }) => {
    await page.goto("/embed-demo.html");
    // `input` / `predicate` are keywords → get the .tok-keyword class...
    const keyword = page.locator(".datamog-embed .cm-editor .tok-keyword").first();
    await expect(keyword).toBeVisible();
    // ...and embed.css colours it (rgb of #7c3aed), proving the CSS is wired.
    await expect(keyword).toHaveCSS("color", "rgb(124, 58, 237)");
  });

  test("a query's run marker opens a result popover", async ({ page }) => {
    await page.goto("/embed-demo.html");
    await page.locator(".datamog-embed").first().locator(".datamog-embed-runquery").click();

    const popover = page.locator(".datamog-embed-result-popover");
    const table = popover.locator(".datamog-embed-table");
    await expect(table).toBeVisible();
    // Reachability from "a" over a,b,c,d (+ disconnected x,y) → b, c, d.
    await expect(table.locator("tbody tr")).toHaveCount(3);
    for (const value of ["b", "c", "d"]) {
      await expect(table.locator("tbody td", { hasText: value })).toBeVisible();
    }

    // The popover is dismissable via the close "×".
    await popover.locator(".datamog-embed-popover-x").click();
    await expect(popover).toHaveCount(0);
  });

  test("a satisfied ground query answers yes", async ({ page }) => {
    await page.goto("/embed-demo.html");
    await page.locator(".datamog-embed").nth(1).locator(".datamog-embed-runquery").click();
    await expect(
      page.locator(".datamog-embed-result-popover .datamog-embed-answer-yes"),
    ).toHaveText("yes");
  });

  test("editing a predicate's data via the chip changes the result", async ({ page }) => {
    await page.goto("/embed-demo.html");
    const first = page.locator(".datamog-embed").first();

    await first.locator(".datamog-embed-chip").click();
    const dataPopover = page.locator(".datamog-embed-popover");
    await expect(dataPopover).toBeVisible();

    // Add an edge d->e so reachability now also reaches "e".
    await dataPopover.locator(".datamog-embed-popover-text").fill("src,dst\na,b\nb,c\nc,d\nd,e");
    await dataPopover.locator(".datamog-embed-popover-apply").click();
    await expect(dataPopover).toHaveCount(0);

    await first.locator(".datamog-embed-runquery").click();
    const table = page.locator(".datamog-embed-result-popover .datamog-embed-table");
    await expect(table.locator("tbody tr")).toHaveCount(4);
    await expect(table.locator("tbody td", { hasText: "e" })).toBeVisible();
  });

  test("the result popover dismisses on an outside click", async ({ page }) => {
    await page.goto("/embed-demo.html");
    const popover = page.locator(".datamog-embed-result-popover");
    await page.locator(".datamog-embed").first().locator(".datamog-embed-runquery").click();
    await expect(popover.locator(".datamog-embed-table")).toBeVisible();
    // Click an element well away from the popover and its anchor. A raw
    // `mouse.click(5, 5)` is dispatched at viewport coordinates with no
    // actionability wait, and was intermittently not delivered at all.
    await page.getByRole("heading", { name: "Datamog embed" }).click();
    await expect(popover).toHaveCount(0);
  });

  test("the data popover uses the predicate's fixed format (no selector)", async ({ page }) => {
    await page.goto("/embed-demo.html");
    const first = page.locator(".datamog-embed").first();
    await first.locator(".datamog-embed-chip").click();
    const popover = page.locator(".datamog-embed-popover");
    await expect(popover).toBeVisible();
    // No format <select>; the format is shown in the title instead.
    await expect(popover.locator("select")).toHaveCount(0);
    await expect(popover.locator(".datamog-embed-popover-title")).toContainText("CSV");
  });
});
