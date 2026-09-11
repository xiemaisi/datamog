import { expect, test } from "@playwright/test";

for (const invalid of [false, true]) {
  test(`Ctrl-click navigates to a type alias${invalid ? " in an invalid program" : ""}`, async ({
    page,
  }) => {
    const source = [
      "type Age = integer.",
      "input predicate people(age: Age).",
      ...(invalid ? ["type Broken = Unknown."] : []),
    ].join("\n");
    await page.goto(`/#p=${encodeURIComponent(source)}&norun`);
    const reference = page.locator(".cm-pred-ref").filter({ hasText: /^Age$/ });
    await expect(reference).toBeVisible();
    await reference.click({ modifiers: ["Control"] });
    await expect
      .poll(() =>
        page
          .locator(".cm-content")
          .evaluate(
            () =>
              window.getSelection()?.anchorNode?.parentElement?.closest(".cm-line")?.textContent,
          ),
      )
      .toBe("type Age = integer.");
  });
}
