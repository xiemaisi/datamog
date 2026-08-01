import { type Page, expect, test } from "@playwright/test";

// No SQL backend can run an example marked `native-only` (non-linear recursion
// or parity-stratified recursion). Loading one while a SQL backend is selected
// used to answer with a translation error instead of the program, so the app
// switches to the interpreter. `src/examples/index.ts` reads the flag by
// globbing the same `native-only` marker file the CLI example suite keys off,
// which is the part most likely to rot silently: a drift in the glob pattern
// flags nothing and this test goes red.

const EXAMPLE_SELECT = ".example-select";
const BACKEND_SELECT = ".backend-select";
const RUN_BUTTON = "button.btn-primary";

/** An example the marker applies to, and one it does not. */
const NATIVE_ONLY_EXAMPLE = "Constant Expressions";
const SQL_CAPABLE_EXAMPLE = "Transitive Closure";

/** Options are labelled `<name> — <description>`, so match on the name. */
async function loadExample(page: Page, name: string): Promise<void> {
  const value = await page
    .locator(`${EXAMPLE_SELECT} option`, { hasText: name })
    .first()
    .getAttribute("value");
  expect(value).not.toBeNull();
  await page.locator(EXAMPLE_SELECT).selectOption(value!);
}

test.describe("native-only examples", () => {
  test("switch the backend to an interpreter when loaded", async ({ page }) => {
    await page.goto("/#norun");
    await expect(page.locator(BACKEND_SELECT)).toBeVisible();

    await page.locator(BACKEND_SELECT).selectOption("sqlite");
    await expect(page.locator(BACKEND_SELECT)).toHaveValue("sqlite");

    await loadExample(page, NATIVE_ONLY_EXAMPLE);

    await expect(page.locator(BACKEND_SELECT)).toHaveValue("native");
  });

  test("leave the chosen backend alone for an example SQL can run", async ({ page }) => {
    await page.goto("/#norun");
    await expect(page.locator(BACKEND_SELECT)).toBeVisible();

    await page.locator(BACKEND_SELECT).selectOption("sqlite");
    await loadExample(page, SQL_CAPABLE_EXAMPLE);

    await expect(page.locator(BACKEND_SELECT)).toHaveValue("sqlite");
  });

  test("run a native-only example loaded over a SQL backend", async ({ page }) => {
    await page.goto("/#norun");
    await expect(page.locator(BACKEND_SELECT)).toBeVisible();
    await page.locator(BACKEND_SELECT).selectOption("sqlite");

    await loadExample(page, NATIVE_ONLY_EXAMPLE);
    await page.locator(RUN_BUTTON).click();

    // The folded expressions, not "Parity-stratified recursion is not
    // supported by sqlite".
    await expect(page.locator("table").first()).toContainText("mul_4");
  });
});
