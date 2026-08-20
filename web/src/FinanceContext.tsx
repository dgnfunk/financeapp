import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, authenticatePasskey, bootstrap, financeApi, isAuthenticated, loadFinanceState, signOut, type FinanceState } from "./api";
import { syncEncryptedDrafts } from "./offlineDrafts";

type Status = "auth" | "loading" | "ready" | "empty" | "offline" | "error";

type FinanceContextValue = {
  data: FinanceState | null;
  status: Status;
  error: string | null;
  refresh: () => Promise<void>;
  connect: (masterToken: string, deviceLabel: string) => Promise<void>;
  connectPasskey: (deviceLabel: string) => Promise<void>;
  disconnect: () => void;
  mutate: <T>(operation: () => Promise<T>) => Promise<T>;
};

const FinanceContext = createContext<FinanceContextValue | null>(null);

export function FinanceProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<FinanceState | null>(null);
  const [status, setStatus] = useState<Status>(() => isAuthenticated() ? "loading" : "auth");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isAuthenticated()) {
      setStatus("auth");
      setData(null);
      return;
    }
    setStatus((current) => current === "ready" ? current : "loading");
    setError(null);
    try {
      await syncEncryptedDrafts();
      const next = await loadFinanceState();
      setData(next);
      setStatus(next.accounts.length || next.transactions.length || next.budgets.length ? "ready" : "empty");
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        signOut();
        setStatus("auth");
      } else if (!navigator.onLine || caught instanceof TypeError) {
        setStatus("offline");
      } else {
        setStatus("error");
      }
      setError(caught instanceof Error ? caught.message : "No fue posible cargar los datos");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const reconnect = () => { if (isAuthenticated()) void refresh(); };
    window.addEventListener("online", reconnect);
    return () => window.removeEventListener("online", reconnect);
  }, [refresh]);

  const connect = useCallback(async (masterToken: string, deviceLabel: string) => {
    setStatus("loading");
    setError(null);
    try {
      await bootstrap(masterToken, deviceLabel);
      await refresh();
    } catch (caught) {
      setStatus("auth");
      setError(caught instanceof Error ? caught.message : "No fue posible iniciar sesión");
      throw caught;
    }
  }, [refresh]);

  const disconnect = useCallback(() => {
    signOut();
    setData(null);
    setStatus("auth");
  }, []);

  const connectPasskey = useCallback(async (deviceLabel: string) => {
    setStatus("loading");
    setError(null);
    try {
      await authenticatePasskey(deviceLabel);
      await refresh();
    } catch (caught) {
      setStatus("auth");
      setError(caught instanceof Error ? caught.message : "No fue posible usar la passkey");
      throw caught;
    }
  }, [refresh]);

  const mutate = useCallback(async <T,>(operation: () => Promise<T>) => {
    const result = await operation();
    await refresh();
    return result;
  }, [refresh]);

  const value = useMemo(() => ({ data, status, error, refresh, connect, connectPasskey, disconnect, mutate }), [data, status, error, refresh, connect, connectPasskey, disconnect, mutate]);
  return <FinanceContext.Provider value={value}>{children}</FinanceContext.Provider>;
}

export function useFinance() {
  const context = useContext(FinanceContext);
  if (!context) throw new Error("useFinance must be used inside FinanceProvider");
  return context;
}

export { financeApi };
