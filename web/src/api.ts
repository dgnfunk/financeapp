import { createRequestId } from "./requestId";

export type AccountKind = "cash" | "debit" | "savings" | "credit" | "debt" | "investment";

export type Account = {
  id: string;
  name: string;
  alias?: string | null;
  kind: AccountKind;
  currency: string;
  opening_balance: string;
  institution?: string | null;
  last_four?: string | null;
  credit_limit?: string | null;
  statement_day?: number | null;
  due_day?: number | null;
  balance: string;
  credit_available?: string | null;
  utilization_pct?: string | null;
  archived_at?: string | null;
  created_at: string;
};

export type Posting = {
  id: string;
  account_id: string;
  amount: string;
  currency: string;
  category?: string | null;
};

export type Transaction = {
  id: string;
  occurred_on: string;
  description: string;
  merchant?: string | null;
  category?: string | null;
  note?: string | null;
  reference?: string | null;
  source: string;
  kind: string;
  reconciled: boolean;
  tags: string[];
  postings: Posting[];
  created_at: string;
};

export type Budget = {
  id: string;
  month: string;
  category: string;
  limit_amount: string;
  rollover: boolean;
  used: string;
  rollover_amount: string;
  available: string;
  percent_used: string;
  status: "healthy" | "warning" | "over";
};

export type Summary = {
  transaction_count: number;
  account_count: number;
  imports_to_review: number;
  base_currency: string;
  net_worth: string;
  income_month: string;
  expenses_month: string;
  net_flow_month: string;
  savings_rate: string;
  freshness?: string | null;
};

export type CashFlowPoint = { month: string; income: string; expenses: string; net: string };
export type ImportItem = { id: string; status: string; source_kind: string; original_name?: string | null; confidence?: string | null; created_at: string };
export type AuditItem = { id: string; action: string; actor: string; target_id?: string | null; created_at: string };
export type ForecastPoint = { month: string; balance: string; income: string; expenses: string };
export type Forecast = {
  scenario: string;
  name: string;
  generated_at: string;
  opening_balance: string;
  monthly_income: string;
  monthly_expenses: string;
  monthly_goal_allocation: string;
  assumptions: Record<string, unknown>;
  points: ForecastPoint[];
};
export type Scenario = { id: string; name: string; kind: "custom"; income_adjustment_pct: string; expense_adjustment_pct: string; one_time_adjustment: string; assumptions: Record<string, unknown>; updated_at: string };

export type FinanceState = {
  accounts: Account[];
  transactions: Transaction[];
  budgets: Budget[];
  summary: Summary;
  cashFlow: CashFlowPoint[];
  forecastBase: Forecast;
  forecastConservative: Forecast;
  imports: ImportItem[];
  audit: AuditItem[];
  scenarios: Scenario[];
};

const API_URL = import.meta.env.VITE_API_URL ?? "/api/v1";
const accessKey = "finance_session";
const refreshKey = "finance_refresh";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function token() {
  return window.sessionStorage.getItem(accessKey);
}

async function rawRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const currentToken = token();
  if (currentToken) headers.set("Authorization", `Bearer ${currentToken}`);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET" && !headers.has("Idempotency-Key")) {
    headers.set("Idempotency-Key", createRequestId());
  }
  const response = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = await response.json();
      message = body.detail ?? message;
    } catch {
      // Keep the HTTP status text when the body is not JSON.
    }
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function refreshAccess(): Promise<boolean> {
  const refreshToken = window.sessionStorage.getItem(refreshKey);
  if (!refreshToken) return false;
  try {
    const response = await fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!response.ok) return false;
    const session = await response.json();
    window.sessionStorage.setItem(accessKey, session.access_token);
    window.sessionStorage.setItem(refreshKey, session.refresh_token);
    return true;
  } catch {
    return false;
  }
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  try {
    return await rawRequest<T>(path, options);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401 && await refreshAccess()) {
      return rawRequest<T>(path, options);
    }
    throw error;
  }
}

export async function bootstrap(masterToken: string, deviceLabel: string) {
  const session = await apiRequest<{ access_token: string; refresh_token: string }>("/auth/bootstrap", {
    method: "POST",
    body: JSON.stringify({ master_token: masterToken, device_label: deviceLabel }),
  });
  window.sessionStorage.setItem(accessKey, session.access_token);
  window.sessionStorage.setItem(refreshKey, session.refresh_token);
}

export function isAuthenticated() {
  return Boolean(token());
}

export function signOut() {
  window.sessionStorage.removeItem(accessKey);
  window.sessionStorage.removeItem(refreshKey);
}

const decodeBase64Url = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), (character) => character.charCodeAt(0));
const encodeBase64Url = (value: ArrayBuffer | null) => value ? btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : null;

function storeSession(session: { access_token: string; refresh_token: string }) {
  window.sessionStorage.setItem(accessKey, session.access_token);
  window.sessionStorage.setItem(refreshKey, session.refresh_token);
}

export async function authenticatePasskey(deviceLabel: string) {
  const options = await apiRequest<Record<string, any>>("/auth/passkeys/authenticate/options", { method: "POST" });
  const challengeId = options.challenge_id;
  delete options.challenge_id;
  options.challenge = decodeBase64Url(options.challenge);
  options.allowCredentials = (options.allowCredentials ?? []).map((credential: Record<string, any>) => ({ ...credential, id: decodeBase64Url(credential.id) }));
  const credential = await navigator.credentials.get({ publicKey: options as PublicKeyCredentialRequestOptions }) as PublicKeyCredential | null;
  if (!credential) throw new Error("No se recibió la passkey");
  const response = credential.response as AuthenticatorAssertionResponse;
  const session = await apiRequest<{ access_token: string; refresh_token: string }>("/auth/passkeys/authenticate/verify", {
    method: "POST",
    body: JSON.stringify({
      challenge_id: challengeId,
      device_label: deviceLabel,
      credential: {
        id: credential.id,
        rawId: encodeBase64Url(credential.rawId),
        type: credential.type,
        response: {
          clientDataJSON: encodeBase64Url(response.clientDataJSON),
          authenticatorData: encodeBase64Url(response.authenticatorData),
          signature: encodeBase64Url(response.signature),
          userHandle: encodeBase64Url(response.userHandle),
        },
      },
    }),
  });
  storeSession(session);
}

export async function registerPasskey(label: string) {
  const options = await apiRequest<Record<string, any>>("/auth/passkeys/register/options", { method: "POST" });
  const challengeId = options.challenge_id;
  delete options.challenge_id;
  options.challenge = decodeBase64Url(options.challenge);
  options.user.id = decodeBase64Url(options.user.id);
  options.excludeCredentials = (options.excludeCredentials ?? []).map((credential: Record<string, any>) => ({ ...credential, id: decodeBase64Url(credential.id) }));
  const credential = await navigator.credentials.create({ publicKey: options as PublicKeyCredentialCreationOptions }) as PublicKeyCredential | null;
  if (!credential) throw new Error("No se creó la passkey");
  const response = credential.response as AuthenticatorAttestationResponse;
  return apiRequest("/auth/passkeys/register/verify", {
    method: "POST",
    body: JSON.stringify({
      challenge_id: challengeId,
      label,
      credential: {
        id: credential.id,
        rawId: encodeBase64Url(credential.rawId),
        type: credential.type,
        response: {
          clientDataJSON: encodeBase64Url(response.clientDataJSON),
          attestationObject: encodeBase64Url(response.attestationObject),
          transports: response.getTransports?.() ?? [],
        },
      },
    }),
  });
}

export async function loadFinanceState(months = 12): Promise<FinanceState> {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const [accounts, transactions, budgets, summary, cashFlow, forecastBase, forecastConservative, imports, audit, scenarios] = await Promise.all([
    apiRequest<Account[]>("/accounts"),
    apiRequest<Transaction[]>("/transactions?limit=200"),
    apiRequest<Budget[]>(`/budgets?month=${currentMonth}`),
    apiRequest<Summary>("/analytics/summary"),
    apiRequest<CashFlowPoint[]>(`/analytics/cash-flow?months=${months}`),
    apiRequest<Forecast>("/forecasts?months=6&scenario=base"),
    apiRequest<Forecast>("/forecasts?months=6&scenario=conservative"),
    apiRequest<ImportItem[]>("/imports"),
    apiRequest<AuditItem[]>("/admin/audit"),
    apiRequest<Scenario[]>("/forecasts/scenarios"),
  ]);
  return { accounts, transactions, budgets, summary, cashFlow, forecastBase, forecastConservative, imports, audit, scenarios };
}

export const financeApi = {
  registerPasskey,
  recoveryCodes: () => apiRequest<{ codes: string[] }>("/auth/recovery-codes", { method: "POST" }),
  cashFlow: (months = 12, accountId?: string) => apiRequest<CashFlowPoint[]>(`/analytics/cash-flow?months=${months}${accountId ? `&account_id=${accountId}` : ""}`),
  captureText: (text: string) => apiRequest("/capture/text", { method: "POST", body: JSON.stringify({ text, client: "pwa" }) }),
  captureFile: (file: File) => { const body = new FormData(); body.append("document", file); return apiRequest("/capture/file", { method: "POST", body }); },
  importDetail: (id: string) => apiRequest<Record<string, unknown>>(`/imports/${id}`),
  createAccount: (payload: Record<string, unknown>) => apiRequest<Account>("/accounts", { method: "POST", body: JSON.stringify(payload) }),
  updateAccount: (id: string, payload: Record<string, unknown>) => apiRequest<Account>(`/accounts/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  archiveAccount: (id: string) => apiRequest<void>(`/accounts/${id}`, { method: "DELETE" }),
  createBudget: (payload: Record<string, unknown>) => apiRequest<Budget>("/budgets", { method: "POST", body: JSON.stringify(payload) }),
  updateBudget: (id: string, payload: Record<string, unknown>) => apiRequest<Budget>(`/budgets/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteBudget: (id: string) => apiRequest<void>(`/budgets/${id}`, { method: "DELETE" }),
  copyBudgets: (source: string, target: string) => apiRequest<Budget[]>(`/budgets/copy/${source}?target_month=${target}`, { method: "POST" }),
  createSimpleTransaction: (payload: Record<string, unknown>) => apiRequest<Transaction>("/transactions/simple", { method: "POST", body: JSON.stringify(payload) }),
  updateTransaction: (id: string, payload: Record<string, unknown>) => apiRequest<Transaction>(`/transactions/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  createScenario: (payload: Record<string, unknown>) => apiRequest("/forecasts/scenarios", { method: "POST", body: JSON.stringify(payload) }),
  forecast: (months: 3 | 6 | 12, scenario: "base" | "conservative" | "custom", scenarioId?: string) => apiRequest<Forecast>(`/forecasts?months=${months}&scenario=${scenario}${scenarioId ? `&scenario_id=${scenarioId}` : ""}`),
  createRecurring: (payload: Record<string, unknown>) => apiRequest("/recurring", { method: "POST", body: JSON.stringify(payload) }),
  createGoal: (payload: Record<string, unknown>) => apiRequest("/goals", { method: "POST", body: JSON.stringify(payload) }),
  chat: (message: string) => apiRequest("/chat", { method: "POST", body: JSON.stringify({ message }) }),
  confirmImport: (id: string, transaction: Record<string, unknown>) => apiRequest(`/imports/${id}/confirm`, { method: "POST", body: JSON.stringify({ transaction }) }),
  confirmImportSimple: (id: string, transaction: Record<string, unknown>) => apiRequest(`/imports/${id}/confirm-simple`, { method: "POST", body: JSON.stringify(transaction) }),
};
