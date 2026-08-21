import { expect, test, type Page } from "@playwright/test";

const account = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Débito principal",
  alias: "Débito",
  kind: "debit",
  currency: "MXN",
  opening_balance: "10000.00",
  institution: "Banco local",
  last_four: "1234",
  balance: "9200.00",
  created_at: "2026-08-01T12:00:00Z",
};

const transaction = {
  id: "22222222-2222-4222-8222-222222222222",
  occurred_on: "2026-08-18",
  description: "Compra de despensa",
  merchant: "Mercado local",
  category: "Supermercado",
  source: "manual",
  kind: "expense",
  reconciled: false,
  tags: [],
  postings: [
    { id: "p1", account_id: account.id, amount: "-800.00", currency: "MXN" },
    { id: "p2", account_id: "internal", amount: "800.00", currency: "MXN", category: "Supermercado" },
  ],
  created_at: "2026-08-18T12:00:00Z",
};

const forecast = (name: string) => ({
  scenario: name.toLowerCase(),
  name,
  generated_at: "2026-08-19T12:00:00Z",
  opening_balance: "9200.00",
  monthly_income: "20000.00",
  monthly_expenses: "12000.00",
  monthly_goal_allocation: "1000.00",
  assumptions: {},
  points: [
    { month: "2026-09-01", balance: "16200.00", income: "20000.00", expenses: "13000.00" },
    { month: "2026-10-01", balance: "23200.00", income: "20000.00", expenses: "13000.00" },
  ],
});

async function mockApi(page: Page, authenticated = true, failedPath?: string) {
  if (authenticated) await page.addInitScript(() => sessionStorage.setItem("finance_session", "test-access"));
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (failedPath && path.endsWith(failedPath)) {
      await route.fulfill({ status: 500, contentType: "text/plain", body: "Internal Server Error" });
      return;
    }
    const json = path.endsWith("/auth/bootstrap") ? { access_token: "test-access", refresh_token: "test-refresh", expires_in: 900, session_id: "session-1" }
      : path.endsWith("/accounts") ? [account]
      : path.endsWith("/transactions") ? [transaction]
      : path.endsWith("/budgets") ? [{ id: "b1", month: "2026-08-01", category: "Supermercado", limit_amount: "3000.00", rollover: true, used: "800.00", rollover_amount: "0.00", available: "2200.00", percent_used: "26.67", status: "healthy" }]
      : path.endsWith("/analytics/summary") ? { transaction_count: 1, account_count: 1, imports_to_review: 0, base_currency: "MXN", net_worth: "9200.00", income_month: "20000.00", expenses_month: "800.00", net_flow_month: "19200.00", savings_rate: "96.00", freshness: "2026-08-18T12:00:00Z" }
      : path.endsWith("/analytics/cash-flow") ? [{ month: "2026-08-01", income: "20000.00", expenses: "800.00", net: "19200.00" }]
      : path.endsWith("/forecasts") ? forecast(route.request().url().includes("conservative") ? "Conservador" : "Base")
      : path.endsWith("/imports") || path.endsWith("/admin/audit") || path.endsWith("/forecasts/scenarios") ? []
      : {};
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
  });
}

test("one failed endpoint does not hide healthy PostgreSQL-backed sections", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockApi(page, true, "/transactions");
  await page.goto("/");

  await expect(page.getByText("PostgreSQL local")).toBeVisible();
  await expect(page.getByText("Datos parcialmente disponibles")).toBeVisible();
  await expect(page.getByText(/No se pudo actualizar: Movimientos/)).toBeVisible();
  await expect(page.locator("strong").filter({ hasText: /^Débito$/ })).toBeVisible();
});

test("master token bootstrap works when randomUUID is unavailable on LAN HTTP", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
  });
  await mockApi(page, false);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await page.getByLabel("Nombre del dispositivo").fill("Laptop LAN");
  await page.getByLabel("Token maestro").fill("test-master-token");
  const bootstrapRequest = page.waitForRequest((request) => request.url().endsWith("/api/v1/auth/bootstrap"));
  await page.getByRole("button", { name: "Continuar" }).click();

  const request = await bootstrapRequest;
  expect(request.headers()["idempotency-key"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("finance_session"))).toBe("test-access");
  await expect(page.getByText("PostgreSQL local")).toBeVisible();
});

for (const width of [390, 1024, 1440]) {
  test(`finance application renders real API state at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockApi(page);
    await page.goto("/");
    if (width < 1024) {
      await expect(page.getByRole("region", { name: "Cuentas" }).locator("strong")).toHaveText("Débito");
      await expect(page.getByRole("button", { name: "Presupuesto" })).toBeVisible();
      await page.getByRole("button", { name: "Presupuesto" }).click();
      await expect(page.getByText("Supermercado")).toBeVisible();
    } else {
      await expect(page.locator("strong").filter({ hasText: /^Débito$/ })).toBeVisible();
      await expect(page.getByText("PostgreSQL local")).toBeVisible();
      await page.getByRole("button", { name: "Presupuestos" }).click();
      await expect(page.getByRole("button", { name: "Nuevo presupuesto" })).toBeVisible();
      await page.getByRole("button", { name: "Proyección" }).click();
      await expect(page.getByText("Proyección de saldo")).toBeVisible();
    }
  });
}
