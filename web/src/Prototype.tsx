import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRightIcon,
  CaretDownIcon,
  CheckCircledIcon,
  ChevronRightIcon,
  FileTextIcon,
  PaperPlaneIcon,
  PlusIcon,
} from "@radix-ui/react-icons";
import {
  ArrowDownRight,
  ArrowUpRight,
  Bank,
  Bell,
  ChartLineUp,
  ChartPieSlice,
  ChatsCircle,
  CheckCircle,
  ClockCounterClockwise,
  Coffee,
  FileMagnifyingGlass,
  GearSix,
  Gauge,
  House,
  ListBullets,
  LockKey,
  MagnifyingGlass,
  Microphone,
  Paperclip,
  Receipt,
  ShieldCheck,
  ShoppingCartSimple,
  Sparkle,
  Target,
  Train,
  TrendUp,
  UserCircle,
  type Icon,
} from "@phosphor-icons/react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { BottomSheet, KeyboardTextarea, MobileScroll, useKeyboard } from "./mobile";
import { financeApi, useFinance } from "./FinanceContext";
import type { Account, AuditItem, Budget, CashFlowPoint, FinanceState, Forecast, Scenario } from "./api";
import { saveEncryptedDraft } from "./offlineDrafts";
import { createRequestId } from "./requestId";

type TabId = "home" | "transactions" | "budget" | "forecast" | "chat";
type CaptureState = "idle" | "saving" | "saved" | "offline" | "file-offline";

const tabs: Array<{ id: TabId; label: string; icon: Icon }> = [
  { id: "home", label: "Inicio", icon: House },
  { id: "transactions", label: "Movimientos", icon: ListBullets },
  { id: "budget", label: "Presupuesto", icon: ChartPieSlice },
  { id: "forecast", label: "Proyección", icon: TrendUp },
  { id: "chat", label: "Chat", icon: ChatsCircle },
];

function TransactionGlyph({ kind }: { kind: string }) {
  if (kind === "cup") return <Coffee aria-hidden="true" weight="regular" />;
  if (kind === "train") return <Train aria-hidden="true" weight="regular" />;
  return <ShoppingCartSimple aria-hidden="true" weight="regular" />;
}

function PartialDataWarning({ warnings, mobile = false }: { warnings: string[]; mobile?: boolean }) {
  if (!warnings.length) return null;
  return (
    <div className={`partial-data-warning${mobile ? " mobile" : ""}`} role="status">
      <ShieldCheck aria-hidden="true" />
      <span><strong>Datos parcialmente disponibles</strong> No se pudo actualizar: {warnings.join(", ")}. Las demás secciones siguen funcionando.</span>
    </div>
  );
}

const money = (value: string | number, currency = "MXN") => new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency,
  maximumFractionDigits: 2,
}).format(Number(value));

function ConnectionView({ mobile = false }: { mobile?: boolean }) {
  const { connect, connectPasskey, error, status } = useFinance();
  const [masterToken, setMasterToken] = useState("");
  const [deviceLabel, setDeviceLabel] = useState(mobile ? "iPhone personal" : "Navegador personal");
  const submit = async () => {
    if (!masterToken.trim()) return;
    try { await connect(masterToken.trim(), deviceLabel.trim() || "Dispositivo personal"); } catch { /* Error is rendered by the context. */ }
  };
  const fields = mobile ? <>
    <label>Nombre del dispositivo<KeyboardTextarea rows={1} value={deviceLabel} onChange={(event) => setDeviceLabel(event.target.value)} /></label>
    <label>Token maestro<KeyboardTextarea rows={2} value={masterToken} onChange={(event) => setMasterToken(event.target.value)} /></label>
  </> : <>
    <label>Nombre del dispositivo<input value={deviceLabel} onChange={(event) => setDeviceLabel(event.target.value)} /></label>
    <label>Token maestro<input type="password" value={masterToken} onChange={(event) => setMasterToken(event.target.value)} /></label>
  </>;
  return <main className={`connection-view ${mobile ? "mobile" : "desktop"}`}>
    <span className="connection-icon"><LockKey weight="duotone" /></span>
    <p className="eyebrow">Acceso privado</p>
    <h1>Conecta tu instalación</h1>
    <p>Usa el token maestro una sola vez. La aplicación creará una sesión corta y renovable para este dispositivo.</p>
    <div className="connection-fields">{fields}</div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="desktop-primary" type="button" disabled={!masterToken.trim() || status === "loading"} onClick={() => void submit()}>{status === "loading" ? "Conectando…" : "Continuar"}</button>
    {"credentials" in navigator && <button className="outline-button passkey-login" type="button" disabled={status === "loading"} onClick={() => void connectPasskey(deviceLabel).catch(() => undefined)}>Usar passkey</button>}
  </main>;
}

function DataStateView({ mobile = false }: { mobile?: boolean }) {
  const { status, error, refresh } = useFinance();
  return <main className={`connection-view ${mobile ? "mobile" : "desktop"}`}>
    <span className="connection-icon"><Gauge weight="duotone" /></span>
    <h1>{status === "offline" ? "Sin conexión privada" : status === "loading" ? "Cargando tus finanzas" : "No pudimos cargar los datos"}</h1>
    <p>{status === "offline" ? "Abre Tailscale y vuelve a intentarlo. Tus borradores permanecen cifrados en este dispositivo." : error ?? "Consultando el libro mayor local…"}</p>
    {status !== "loading" && <button className="desktop-primary" type="button" onClick={() => void refresh()}>Reintentar</button>}
  </main>;
}

export default function Prototype() {
  const keyboard = useKeyboard();
  const finance = useFinance();
  const [activeTab, setActiveTab] = useState<TabId>("home");
  const [capture, setCapture] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [captureState, setCaptureState] = useState<CaptureState>("idle");
  const [chatDraft, setChatDraft] = useState("");
  const [chatMessages, setChatMessages] = useState([
    { role: "assistant", text: "Hola. Puedo ayudarte a entender tus gastos o preparar un movimiento para revisión." },
  ]);
  const [sheet, setSheet] = useState<"attach" | "voice" | "preview" | "shortcuts" | "account" | "budget" | null>(null);
  const [accountDraft, setAccountDraft] = useState({ name: "", kind: "debit", opening_balance: "0", institution: "", last_four: "", credit_limit: "", statement_day: "", due_day: "" });
  const [budgetDraft, setBudgetDraft] = useState({ category: "", limit_amount: "", rollover: false });
  const fileInput = useRef<HTMLInputElement>(null);
  const screenTitle = useMemo(() => tabs.find((tab) => tab.id === activeTab)?.label ?? "Inicio", [activeTab]);

  useEffect(() => {
    if ("serviceWorker" in navigator && import.meta.env.PROD) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      keyboard.hide();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab]);

  if (finance.status === "auth") return <div className="finance-app"><MobileScroll className="app-screen"><ConnectionView mobile /></MobileScroll></div>;
  if (finance.status === "loading" || finance.status === "offline" || finance.status === "error") return <div className="finance-app"><MobileScroll className="app-screen"><DataStateView mobile /></MobileScroll></div>;

  const financeData = finance.data!;
  const accountById = new Map(financeData.accounts.map((account) => [account.id, account]));
  const mobileTransactions = financeData.transactions.map((transaction) => {
    const visiblePosting = transaction.postings.find((posting) => accountById.has(posting.account_id));
    const amount = visiblePosting ? Number(visiblePosting.amount) : 0;
    return {
      id: transaction.id,
      merchant: transaction.merchant || transaction.description,
      meta: new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short" }).format(new Date(`${transaction.occurred_on}T12:00:00`)),
      amount: `${amount > 0 ? "+" : ""}${money(amount, visiblePosting?.currency ?? "MXN")}`,
      tone: transaction.kind === "income" ? "mint" : transaction.category === "Transporte" ? "lilac" : "peach",
      icon: transaction.category === "Transporte" ? "train" : transaction.category === "Restaurantes" ? "cup" : "cart",
    };
  });

  const dismissKeyboard = () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    keyboard.hide();
  };

  const changeTab = (tab: TabId) => {
    dismissKeyboard();
    setActiveTab(tab);
  };

  const submitCapture = () => {
    if (!capture.trim()) return;
    dismissKeyboard();
    setSheet("preview");
  };

  const confirmCapture = async () => {
    const text = capture.trim() || "Súper Chedraui · $542 MXN";
    setCaptureState("saving");
    const apiUrl = import.meta.env.VITE_API_URL ?? "/api/v1";
    const token = window.sessionStorage.getItem("finance_session");
    try {
      if (!token) throw new Error("offline-session");
      const body = selectedFile ? (() => { const form = new FormData(); form.append("document", selectedFile); return form; })() : JSON.stringify({ text, client: "pwa" });
      const response = await fetch(`${apiUrl}/capture/${selectedFile ? "file" : "text"}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": createRequestId(),
          ...(!selectedFile ? { "Content-Type": "application/json" } : {}),
        },
        body,
      });
      if (!response.ok) throw new Error("capture-failed");
      setCaptureState("saved");
      await finance.refresh();
    } catch {
      if (selectedFile) {
        setCaptureState("file-offline");
      } else {
        await saveEncryptedDraft(text);
        setCaptureState("offline");
      }
    }
    setCapture("");
    setSelectedFile(null);
    setSheet(null);
    window.setTimeout(() => setCaptureState("idle"), 3200);
  };

  const sendChat = async () => {
    const text = chatDraft.trim();
    if (!text) return;
    dismissKeyboard();
    setChatMessages((messages) => [...messages, { role: "user", text }]);
    setChatDraft("");
    try {
      const response = await financeApi.chat(text) as { message: string };
      setChatMessages((messages) => [...messages, { role: "assistant", text: response.message }]);
    } catch {
      setChatMessages((messages) => [...messages, { role: "assistant", text: "No pude consultar el servidor local. Revisa Tailscale e inténtalo de nuevo." }]);
    }
  };

  return (
    <div className="finance-app">
      <MobileScroll key={activeTab} className="app-screen">
        {activeTab === "home" ? (
          <main className="home-screen" aria-label="Resumen de hoy">
            <header className="today-header">
              <h1>Hoy</h1>
              <p>Martes, 18 de agosto de 2026</p>
              <div className="pace-status"><CheckCircledIcon aria-hidden="true" /> Vas dentro de tu ritmo</div>
            </header>

            <section className="capture-panel" aria-label="Registrar movimiento">
              <KeyboardTextarea
                value={capture}
                onChange={(event) => setCapture(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submitCapture();
                  }
                }}
                placeholder="¿Qué movimiento quieres registrar?"
                aria-label="Describe el movimiento que quieres registrar"
                rows={2}
              />
              <div className="capture-actions">
                {capture.trim() ? (
                  <button className="round-action primary" type="button" onClick={submitCapture} aria-label="Enviar movimiento"><PaperPlaneIcon /></button>
                ) : (
                  <button className="round-action" type="button" onClick={() => setSheet("voice")} aria-label="Registrar por voz"><Microphone weight="regular" /></button>
                )}
                <button className="round-action" type="button" onClick={() => setSheet("attach")} aria-label="Adjuntar recibo o estado de cuenta"><Paperclip weight="regular" /></button>
              </div>
            </section>

            <section className="daily-pulse" aria-labelledby="daily-pulse-title">
              <h2 id="daily-pulse-title" className="visually-hidden">Ritmo de gasto diario</h2>
              <div className="pulse-values">
                <div><span>Gastos del mes</span><strong>{money(financeData.summary.expenses_month)} <small>MXN</small></strong></div>
                <div><span>Flujo neto</span><strong>{money(financeData.summary.net_flow_month)} <small>MXN</small></strong></div>
              </div>
              <div className="pulse-track" aria-label="Has gastado menos que tu promedio diario"><div className="pulse-fill" /><div className="pulse-marker" /></div>
              <div className="pulse-scale"><span>$0</span><span>$1,540</span></div>
              <p>Tu tasa de ahorro del mes es <strong>{Number(financeData.summary.savings_rate).toFixed(1)}%</strong>.</p>
            </section>

            <section className="recent-section mobile-accounts" aria-labelledby="mobile-accounts-title">
              <div className="section-heading"><h2 id="mobile-accounts-title">Cuentas</h2><button type="button" onClick={() => setSheet("account")}>Agregar</button></div>
              <div className="mobile-account-strip">
                {financeData.accounts.filter((item) => !item.archived_at).slice(0, 3).map((item) => <div key={item.id}><span>{item.kind === "credit" ? "Crédito" : item.kind === "investment" ? "Inversión" : item.kind === "debit" ? "Débito" : item.kind === "savings" ? "Ahorro" : item.kind === "debt" ? "Deuda" : "Efectivo"}</span><strong>{item.alias || item.name}</strong><b>{money(item.balance, item.currency)}</b></div>)}
                {!financeData.accounts.length && <button type="button" className="mobile-empty compact" onClick={() => setSheet("account")}><Bank /><strong>Agrega tu primera cuenta</strong></button>}
              </div>
            </section>

            <section className="recent-section" aria-labelledby="recent-title">
              <div className="section-heading">
                <h2 id="recent-title">Últimos movimientos</h2>
                <button type="button" onClick={() => changeTab("transactions")}>Ver todos</button>
              </div>
              <div className="transaction-list">
                {mobileTransactions.slice(0, 3).map((transaction) => (
                  <button className="transaction-row" type="button" key={transaction.id} onClick={() => setSheet("preview")}>
                    <span className={`transaction-icon ${transaction.tone}`}><TransactionGlyph kind={transaction.icon} /></span>
                    <span className="transaction-copy"><strong>{transaction.merchant}</strong><small>{transaction.meta}</small></span>
                    <span className="transaction-amount">{transaction.amount}</span>
                    <ChevronRightIcon aria-hidden="true" />
                  </button>
                ))}
              </div>
            </section>
          </main>
        ) : activeTab === "transactions" ? (
          <main className="secondary-screen" aria-label={screenTitle}>
            <p className="eyebrow">Agosto de 2026</p>
            <h1>Movimientos</h1>
            <div className="summary-strip"><span>Gastos del mes</span><strong>{money(financeData.summary.expenses_month)}</strong><small>{financeData.summary.transaction_count} movimientos registrados</small></div>
            <div className="transaction-list expanded-list">
              {mobileTransactions.map((transaction) => (
                <button className="transaction-row" type="button" key={transaction.id} onClick={() => setSheet("preview")}>
                  <span className={`transaction-icon ${transaction.tone}`}><TransactionGlyph kind={transaction.icon} /></span>
                  <span className="transaction-copy"><strong>{transaction.merchant}</strong><small>{transaction.meta}</small></span>
                  <span className="transaction-amount">{transaction.amount}</span>
                  <ChevronRightIcon aria-hidden="true" />
                </button>
              ))}
            </div>
          </main>
        ) : activeTab === "budget" ? (
          <main className="secondary-screen" aria-label={screenTitle}>
            <p className="eyebrow">Agosto de 2026</p>
            <div className="mobile-title-row"><h1>Presupuesto</h1><button type="button" onClick={() => setSheet("budget")}><PlusIcon /> Crear</button></div>
            <p>Has usado {money(financeData.budgets.reduce((sum, budget) => sum + Number(budget.used), 0))} de {money(financeData.budgets.reduce((sum, budget) => sum + Number(budget.limit_amount) + Number(budget.rollover_amount), 0))}.</p>
            <div className="budget-list">
              {financeData.budgets.map((budget) => (
                <button type="button" className="budget-card" key={budget.id}>
                  <span><strong>{budget.category}</strong><small>{money(budget.used)} de {money(Number(budget.limit_amount) + Number(budget.rollover_amount))}</small></span><b>{Number(budget.percent_used).toFixed(0)}%</b>
                </button>
              ))}
              {!financeData.budgets.length && <div className="mobile-empty"><Target /><strong>Crea tu primer presupuesto</strong><span>En escritorio puedes definir límites por categoría y rollover.</span></div>}
            </div>
          </main>
        ) : activeTab === "forecast" ? (
          <main className="secondary-screen" aria-label={screenTitle}>
            <p className="eyebrow">Escenario base · 6 meses</p>
            <h1>Proyección</h1>
            <div className="forecast-hero"><span>Saldo estimado al final del periodo</span><strong>{money(financeData.forecastBase.points.at(-1)?.balance ?? 0)}</strong><small>Escenario calculado desde tus datos</small></div>
            <div className="forecast-list" aria-label="Proyección mensual">
              {financeData.forecastBase.points.map((point) => <div key={point.month}>{new Intl.DateTimeFormat("es-MX", { month: "long", year: "numeric" }).format(new Date(`${point.month}T12:00:00`))} · {money(point.balance)}</div>)}
            </div>
            <button type="button" className="secondary-cta">Comparar escenarios <ArrowRightIcon /></button>
          </main>
        ) : (
          <main className="secondary-screen chat-screen" aria-label={screenTitle}>
            <p className="eyebrow">Modelo local</p>
            <h1>Chat</h1>
            <div className="chat-messages" aria-live="polite">
              {chatMessages.map((message, index) => <p className={message.role} key={`${message.role}-${index}`}>{message.text}</p>)}
            </div>
            <div className="chat-composer">
              <KeyboardTextarea value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendChat(); } }} rows={2} placeholder="Pregunta o registra un gasto" aria-label="Mensaje para el chat privado" />
              <button type="button" onClick={() => void sendChat()} aria-label="Enviar mensaje"><PaperPlaneIcon /></button>
            </div>
          </main>
        )}
      </MobileScroll>

      <PartialDataWarning warnings={financeData.warnings} mobile />
      {captureState !== "idle" && <div className={`capture-toast ${captureState}`} role="status">{captureState === "saving" ? "Guardando…" : captureState === "saved" ? "Listo para revisar" : captureState === "file-offline" ? "Conéctate para enviar el archivo; no se almacenó en caché" : "Borrador cifrado; se enviará al reconectar"}</div>}

      <nav className="bottom-nav" aria-label="Navegación principal">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button key={tab.id} type="button" className={activeTab === tab.id ? "active" : ""} onClick={() => changeTab(tab.id)} aria-current={activeTab === tab.id ? "page" : undefined}>
              <Icon aria-hidden="true" weight={activeTab === tab.id ? "fill" : "regular"} /><span>{tab.label}</span>
            </button>
          );
        })}
      </nav>

      <BottomSheet open={sheet === "attach"} onOpenChange={(open) => setSheet(open ? "attach" : null)} title="Agregar documento" description="El archivo se procesa de forma privada en tu servidor.">
        <div className="sheet-options">
          <button type="button" onClick={() => fileInput.current?.click()}><FileTextIcon /><span><strong>Elegir archivo</strong><small>PDF, XML, CSV o imagen</small></span><ChevronRightIcon /></button>
          <button type="button" onClick={() => fileInput.current?.click()}><PlusIcon /><span><strong>Tomar fotografía</strong><small>Recibo o comprobante</small></span><ChevronRightIcon /></button>
          <button type="button" onClick={() => setSheet("shortcuts")}><ArrowRightIcon /><span><strong>Configurar Atajos</strong><small>Dictado y hoja Compartir de iOS</small></span><ChevronRightIcon /></button>
        </div>
      </BottomSheet>
      <input ref={fileInput} className="visually-hidden" type="file" accept="application/pdf,text/csv,application/xml,text/xml,image/jpeg,image/png,image/heic,image/heif" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) { setSelectedFile(file); setCapture(file.name); setSheet("preview"); } }} />

      <BottomSheet open={sheet === "shortcuts"} onOpenChange={(open) => setSheet(open ? "shortcuts" : null)} title="Atajos de iPhone" description="Cada Atajo usa un token que solo puede agregar elementos a revisión.">
        <ol className="shortcut-steps">
          <li><strong>Agregar gasto</strong><span>Dictar texto → Obtener contenido de URL → POST /capture/text.</span></li>
          <li><strong>Enviar a Finanzas</strong><span>Recibir archivos de Compartir → POST /capture/file.</span></li>
          <li><strong>Guardar el token</strong><span>Usa Authorization: Bearer y revócalo desde Administración si pierdes el teléfono.</span></li>
        </ol>
      </BottomSheet>

      <BottomSheet open={sheet === "account"} onOpenChange={(open) => setSheet(open ? "account" : null)} title="Nueva cuenta" description="El saldo inicial se incorpora al libro mayor y puede corregirse después con un ajuste auditable.">
        <div className="mobile-form">
          <label>Nombre<KeyboardTextarea rows={1} value={accountDraft.name} onChange={(event) => setAccountDraft({ ...accountDraft, name: event.target.value })} /></label>
          <label>Tipo<select value={accountDraft.kind} onChange={(event) => setAccountDraft({ ...accountDraft, kind: event.target.value })}><option value="cash">Efectivo</option><option value="debit">Débito</option><option value="savings">Ahorro</option><option value="credit">Crédito</option><option value="debt">Deuda</option><option value="investment">Inversión manual</option></select></label>
          <label>Saldo inicial<KeyboardTextarea rows={1} value={accountDraft.opening_balance} onChange={(event) => setAccountDraft({ ...accountDraft, opening_balance: event.target.value })} /></label>
          <label>Institución<KeyboardTextarea rows={1} value={accountDraft.institution} onChange={(event) => setAccountDraft({ ...accountDraft, institution: event.target.value })} /></label>
          <label>Últimos 4 dígitos<KeyboardTextarea rows={1} value={accountDraft.last_four} onChange={(event) => setAccountDraft({ ...accountDraft, last_four: event.target.value.replace(/\D/g, "").slice(0, 4) })} /></label>
          {accountDraft.kind === "credit" && <><label>Límite de crédito<KeyboardTextarea rows={1} value={accountDraft.credit_limit} onChange={(event) => setAccountDraft({ ...accountDraft, credit_limit: event.target.value })} /></label><div className="mobile-form-pair"><label>Día de corte<KeyboardTextarea rows={1} value={accountDraft.statement_day} onChange={(event) => setAccountDraft({ ...accountDraft, statement_day: event.target.value })} /></label><label>Día de pago<KeyboardTextarea rows={1} value={accountDraft.due_day} onChange={(event) => setAccountDraft({ ...accountDraft, due_day: event.target.value })} /></label></div></>}
          <button className="confirm-button" type="button" disabled={!accountDraft.name.trim()} onClick={() => void finance.mutate(() => financeApi.createAccount({ name: accountDraft.name.trim(), kind: accountDraft.kind, currency: "MXN", opening_balance: accountDraft.opening_balance || "0", institution: accountDraft.institution || null, last_four: accountDraft.last_four || null, credit_limit: accountDraft.kind === "credit" && accountDraft.credit_limit ? accountDraft.credit_limit : null, statement_day: accountDraft.kind === "credit" && accountDraft.statement_day ? Number(accountDraft.statement_day) : null, due_day: accountDraft.kind === "credit" && accountDraft.due_day ? Number(accountDraft.due_day) : null })).then(() => { setSheet(null); setAccountDraft({ name: "", kind: "debit", opening_balance: "0", institution: "", last_four: "", credit_limit: "", statement_day: "", due_day: "" }); })}><CheckCircledIcon /> Guardar cuenta</button>
        </div>
      </BottomSheet>

      <BottomSheet open={sheet === "budget"} onOpenChange={(open) => setSheet(open ? "budget" : null)} title="Nuevo presupuesto" description="El límite se aplica al mes actual y se actualiza con movimientos confirmados.">
        <div className="mobile-form">
          <label>Categoría<KeyboardTextarea rows={1} value={budgetDraft.category} onChange={(event) => setBudgetDraft({ ...budgetDraft, category: event.target.value })} /></label>
          <label>Límite mensual<KeyboardTextarea rows={1} value={budgetDraft.limit_amount} onChange={(event) => setBudgetDraft({ ...budgetDraft, limit_amount: event.target.value })} /></label>
          <label className="mobile-check"><input type="checkbox" checked={budgetDraft.rollover} onChange={(event) => setBudgetDraft({ ...budgetDraft, rollover: event.target.checked })} /> Acumular disponible al siguiente mes</label>
          <button className="confirm-button" type="button" disabled={!budgetDraft.category.trim() || !Number(budgetDraft.limit_amount)} onClick={() => void finance.mutate(() => financeApi.createBudget({ month: `${new Date().toISOString().slice(0, 7)}-01`, category: budgetDraft.category.trim(), limit_amount: budgetDraft.limit_amount, rollover: budgetDraft.rollover })).then(() => { setSheet(null); setBudgetDraft({ category: "", limit_amount: "", rollover: false }); })}><CheckCircledIcon /> Crear presupuesto</button>
        </div>
      </BottomSheet>

      <BottomSheet open={sheet === "voice"} onOpenChange={(open) => setSheet(open ? "voice" : null)} title="Dictar movimiento" description="Usa el dictado del teclado de iOS; revisarás el texto antes de enviarlo.">
        <button className="voice-demo" type="button" onClick={() => setSheet(null)}><Microphone /> Escribir o dictar ahora</button>
      </BottomSheet>

      <BottomSheet open={sheet === "preview"} onOpenChange={(open) => setSheet(open ? "preview" : null)} title="Revisar movimiento" description="Nada se contabiliza sin tu confirmación.">
        <div className="review-card"><span>{selectedFile ? "Documento" : "Gasto"}</span><strong>{capture.trim() || "Súper Chedraui · $542 MXN"}</strong><small>{selectedFile ? "Se cifrará antes de guardarse y quedará pendiente de revisión." : "La categoría se sugerirá al procesarlo."}</small></div>
        <button className="confirm-button" type="button" onClick={confirmCapture}><CheckCircledIcon /> Confirmar</button>
      </BottomSheet>
    </div>
  );
}

type DesktopSection = "overview" | "accounts" | "transactions" | "budgets" | "forecast" | "imports" | "audit" | "settings";

const desktopNavigation: Array<{ id: DesktopSection; label: string; icon: Icon }> = [
  { id: "overview", label: "Resumen", icon: Gauge },
  { id: "accounts", label: "Cuentas", icon: Bank },
  { id: "transactions", label: "Movimientos", icon: ListBullets },
  { id: "budgets", label: "Presupuestos", icon: Target },
  { id: "forecast", label: "Proyección", icon: ChartLineUp },
  { id: "imports", label: "Importaciones", icon: FileMagnifyingGlass },
  { id: "audit", label: "Auditoría", icon: ShieldCheck },
  { id: "settings", label: "Ajustes", icon: GearSix },
];

function CurrencyTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <strong>{label}</strong>
      {payload.map((item) => <span key={item.name}><i style={{ backgroundColor: item.color }} />{item.name}: ${item.value.toLocaleString("es-MX")}</span>)}
    </div>
  );
}

export function DesktopDashboard() {
  const finance = useFinance();
  const [section, setSection] = useState<DesktopSection>("overview");
  const [period, setPeriod] = useState("Últimos 12 meses");
  const [account, setAccount] = useState("Todas las cuentas");
  const [query, setQuery] = useState("");
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureText, setCaptureText] = useState("");
  const [dialog, setDialog] = useState<"account" | "budget" | "transaction" | "scenario" | "recurring" | "goal" | null>(null);
  const [filteredFlow, setFilteredFlow] = useState<CashFlowPoint[] | null>(null);

  useEffect(() => {
    const accountId = finance.data?.accounts.find((item) => (item.alias || item.name) === account)?.id;
    if (!finance.data) return;
    void financeApi.cashFlow(12, accountId).then(setFilteredFlow).catch(() => setFilteredFlow(null));
  }, [account, finance.data]);

  if (finance.status === "auth") return <div className="desktop-app state-only"><ConnectionView /></div>;
  if (finance.status === "loading" || finance.status === "offline" || finance.status === "error") return <div className="desktop-app state-only"><DataStateView /></div>;

  const data = finance.data!;
  const accountMap = new Map(data.accounts.map((item) => [item.id, item]));
  const desktopRows = data.transactions.map((transaction) => {
    const posting = transaction.postings.find((item) => accountMap.has(item.account_id));
    const rowAccount = posting ? accountMap.get(posting.account_id) : undefined;
    return {
      id: transaction.id,
      date: new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${transaction.occurred_on}T12:00:00`)),
      merchant: transaction.merchant || transaction.description,
      category: transaction.category || posting?.category || "Sin categoría",
      account: rowAccount?.alias || rowAccount?.name || "Cuenta interna",
      amount: `${Number(posting?.amount ?? 0) > 0 ? "+" : ""}${money(posting?.amount ?? 0, posting?.currency ?? "MXN")}`,
      status: transaction.reconciled ? "Conciliado" : "Confirmado",
    };
  });
  const reviewItems = data.imports.map((item) => ({ id: item.id, source: item.original_name || item.source_kind, detail: item.status === "review" ? "Pendiente de confirmar" : item.status, confidence: item.confidence ? `${Math.round(Number(item.confidence) * 100)}%` : "—", status: item.status === "review" ? "Revisar" : "Procesando" }));

  const visibleTransactions = desktopRows.filter((row) => {
    const matchesQuery = `${row.merchant} ${row.category} ${row.account}`.toLowerCase().includes(query.toLowerCase());
    const matchesAccount = account === "Todas las cuentas" || row.account === account;
    return matchesQuery && matchesAccount;
  });
  const currentLabel = desktopNavigation.find((item) => item.id === section)?.label ?? "Resumen";

  return (
    <div className="desktop-app">
      <aside className="desktop-sidebar">
        <div className="desktop-brand"><span className="brand-mark"><Receipt weight="duotone" /></span><span><strong>Finanzas</strong><small>Privado · local</small></span></div>
        <nav aria-label="Administración">
          {desktopNavigation.map((item) => {
            const NavIcon = item.icon;
            return <button key={item.id} type="button" className={section === item.id ? "active" : ""} onClick={() => setSection(item.id)}><NavIcon weight={section === item.id ? "fill" : "regular"} /><span>{item.label}</span>{item.id === "imports" && reviewItems.length > 0 && <b>{reviewItems.length}</b>}</button>;
          })}
        </nav>
        <div className="privacy-card"><LockKey weight="duotone" /><span><strong>Solo en tu tailnet</strong><small>Sin telemetría externa</small></span></div>
        <button className="owner-card" type="button"><UserCircle weight="duotone" /><span><strong>Propietario</strong><small>Administrador</small></span><CaretDownIcon /></button>
      </aside>

      <div className="desktop-workspace">
        <header className="desktop-topbar">
          <div><p>Martes, 18 de agosto de 2026</p><h1>{currentLabel}</h1></div>
          <div className="topbar-actions">
            <label className="desktop-search"><MagnifyingGlass /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar movimiento" /></label>
            <button className="icon-button" type="button" aria-label="Alertas"><Bell /></button>
            <button className="desktop-primary" type="button" onClick={() => setCaptureOpen(true)}><PlusIcon /> Registrar</button>
          </div>
        </header>

        <main className="desktop-main">
          <PartialDataWarning warnings={data.warnings} />
          <div className="dashboard-toolbar">
            <div className="demo-source"><ShieldCheck weight="fill" /> PostgreSQL local <span>· {data.summary.freshness ? `Último movimiento ${new Intl.DateTimeFormat("es-MX", { dateStyle: "short", timeStyle: "short" }).format(new Date(data.summary.freshness))}` : "Sin movimientos todavía"}</span></div>
            <div className="dashboard-filters">
              <label>Periodo<select value={period} onChange={(event) => setPeriod(event.target.value)}><option>Últimos 12 meses</option><option>Últimos 6 meses</option><option>Este año</option></select></label>
              <label>Cuenta<select value={account} onChange={(event) => setAccount(event.target.value)}><option>Todas las cuentas</option>{data.accounts.filter((item) => !item.archived_at).map((item) => <option key={item.id}>{item.alias || item.name}</option>)}</select></label>
            </div>
          </div>

          {section === "overview" && <DesktopOverview data={data} flow={filteredFlow ?? data.cashFlow} onReview={() => setSection("imports")} onAccounts={() => setSection("accounts")} reviewCount={reviewItems.length} period={period} account={account} />}
          {section === "accounts" && <DesktopAccountManager accounts={data.accounts} onCreate={() => setDialog("account")} onRefresh={() => void finance.refresh()} mutate={finance.mutate} />}
          {section === "transactions" && <DesktopTransactions rows={visibleTransactions} onCreate={() => setDialog("transaction")} mutate={finance.mutate} />}
          {section === "budgets" && <DesktopBudgets budgets={data.budgets} onCreate={() => setDialog("budget")} mutate={finance.mutate} />}
          {section === "forecast" && <DesktopForecast base={data.forecastBase} conservative={data.forecastConservative} scenarios={data.scenarios} onCreateScenario={() => setDialog("scenario")} onCreateRecurring={() => setDialog("recurring")} onCreateGoal={() => setDialog("goal")} />}
          {section === "imports" && <DesktopImports items={reviewItems} accounts={data.accounts} onRefresh={() => void finance.refresh()} mutate={finance.mutate} />}
          {section === "audit" && <DesktopAudit events={data.audit} />}
          {section === "settings" && <DesktopSettings onSignOut={finance.disconnect} />}
        </main>
      </div>

      {captureOpen && <div className="desktop-modal-backdrop" role="presentation" onMouseDown={() => setCaptureOpen(false)}>
        <section className="desktop-modal" role="dialog" aria-modal="true" aria-labelledby="desktop-capture-title" onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-heading"><span><small>Captura rápida</small><h2 id="desktop-capture-title">Registrar movimiento</h2></span><button type="button" onClick={() => setCaptureOpen(false)} aria-label="Cerrar">×</button></div>
          <label className="desktop-capture-field">Describe el movimiento<textarea autoFocus value={captureText} onChange={(event) => setCaptureText(event.target.value)} placeholder="Gasté 430 en gasolina con la tarjeta" /></label>
          <div className="capture-security"><ShieldCheck /> Se creará una propuesta para revisión; nada se contabiliza automáticamente.</div>
          <div className="modal-actions"><button type="button" onClick={() => setCaptureOpen(false)}>Cancelar</button><button className="desktop-primary" type="button" disabled={!captureText.trim()} onClick={() => void finance.mutate(() => financeApi.captureText(captureText)).then(() => { setCaptureText(""); setCaptureOpen(false); setSection("imports"); })}>Crear propuesta</button></div>
        </section>
      </div>}
      {dialog && <FinanceDialog kind={dialog} accounts={data.accounts} onClose={() => setDialog(null)} mutate={finance.mutate} />}
    </div>
  );
}

function DesktopOverview({ data, flow, reviewCount, onReview, onAccounts, period, account }: { data: FinanceState; flow: CashFlowPoint[]; reviewCount: number; onReview: () => void; onAccounts: () => void; period: string; account: string }) {
  const start = period === "Últimos 6 meses" ? -6 : period === "Este año" ? -(new Date().getMonth() + 1) : 0;
  const flowData = flow.slice(start).map((point) => ({ month: new Intl.DateTimeFormat("es-MX", { month: "short" }).format(new Date(`${point.month}T12:00:00`)), ingresos: Number(point.income), gastos: Number(point.expenses) }));
  const current = flowData.at(-1) ?? { ingresos: 0, gastos: 0 };
  const net = current.ingresos - current.gastos;
  const savingsRate = current.ingresos ? (net / current.ingresos) * 100 : 0;
  const selectedAccount = data.accounts.find((item) => (item.alias || item.name) === account);
  const balance = selectedAccount ? Number(selectedAccount.balance) : Number(data.summary.net_worth);
  const balanceText = `${balance < 0 ? "-" : ""}$${Math.abs(balance).toLocaleString("es-MX")}`;
  const dashboardBudgetData = data.budgets.map((budget) => ({ category: budget.category, real: Number(budget.used), disponible: Math.max(Number(budget.available), 0) }));
  return <>
    <section className="kpi-grid" aria-label="Indicadores del mes">
      <article><span>Saldo disponible</span><strong>{balanceText} <small>MXN</small></strong><p className="positive"><ArrowUpRight /> +8.4% vs. julio</p></article>
      <article><span>Ingresos del mes</span><strong>${current.ingresos.toLocaleString("es-MX")} <small>MXN</small></strong><p><ClockCounterClockwise /> Movimientos confirmados</p></article>
      <article><span>Gastos del mes</span><strong>${current.gastos.toLocaleString("es-MX")} <small>MXN</small></strong><p><ArrowDownRight /> Desde el libro mayor</p></article>
      <article><span>Tasa de ahorro</span><strong>{savingsRate.toFixed(1)}%</strong><p><Target /> Meta: 20%</p></article>
      <button type="button" className="review-kpi" onClick={onReview}><span>Por revisar</span><strong>{reviewCount}</strong><p><FileMagnifyingGlass /> Abrir bandeja</p></button>
    </section>
    <section className="dashboard-grid">
      <article className="dashboard-card flow-card">
        <div className="card-heading"><span><h2>Ingresos y gastos</h2><p>MXN · {period.toLowerCase()} · {account === "Todas las cuentas" ? "flujo global" : account}</p></span><div className="chart-summary"><strong>{net >= 0 ? "+" : "-"}${Math.abs(net).toLocaleString("es-MX")}</strong><small>flujo neto del último mes</small></div></div>
        <div className="chart-frame" aria-label="Gráfica de ingresos y gastos mensuales">
          <ResponsiveContainer width="100%" height="100%"><AreaChart data={flowData} margin={{ top: 18, right: 10, left: -16, bottom: 0 }}><CartesianGrid stroke="#e9ebf1" vertical={false} /><XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fill: "#778097", fontSize: 12 }} /><YAxis tickLine={false} axisLine={false} tick={{ fill: "#778097", fontSize: 11 }} tickFormatter={(value) => `$${value / 1000}k`} /><Tooltip content={<CurrencyTooltip />} /><Legend iconType="plainline" wrapperStyle={{ fontSize: 12, paddingTop: 10 }} /><Area isAnimationActive={false} type="monotone" dataKey="ingresos" name="Ingresos" stroke="#3f55c8" fill="#3f55c8" fillOpacity={0.1} strokeWidth={2.5} /><Area isAnimationActive={false} type="monotone" dataKey="gastos" name="Gastos" stroke="#8b94a8" fill="#8b94a8" fillOpacity={0.05} strokeWidth={2} /></AreaChart></ResponsiveContainer>
        </div>
      </article>
      <article className="dashboard-card budget-card-desktop">
        <div className="card-heading"><span><h2>Presupuesto por categoría</h2><p>Usado vs. disponible · mes actual</p></span><button type="button">Ver detalle</button></div>
        {dashboardBudgetData.length ? <div className="chart-frame compact" aria-label="Presupuesto usado y disponible por categoría"><ResponsiveContainer width="100%" height="100%"><BarChart data={dashboardBudgetData} layout="vertical" margin={{ top: 8, right: 20, left: 12, bottom: 0 }}><CartesianGrid stroke="#edf0f4" horizontal={false} /><XAxis type="number" hide /><YAxis type="category" dataKey="category" width={92} tickLine={false} axisLine={false} tick={{ fill: "#4b556b", fontSize: 11 }} /><Tooltip content={<CurrencyTooltip />} /><Bar isAnimationActive={false} dataKey="real" name="Usado" stackId="budget" fill="#3f55c8" radius={[5, 0, 0, 5]} /><Bar isAnimationActive={false} dataKey="disponible" name="Disponible" stackId="budget" fill="#e4e7f2" radius={[0, 5, 5, 0]} /></BarChart></ResponsiveContainer></div> : <div className="empty-state compact"><Target /><h3>Sin presupuestos</h3><p>Crea uno para comparar usado y disponible.</p></div>}
      </article>
      <DesktopAccounts accounts={data.accounts} onManage={onAccounts} />
      <article className="dashboard-card recent-table-card"><div className="card-heading"><span><h2>Movimientos recientes</h2><p>Últimas operaciones confirmadas</p></span><button type="button">Ver todos</button></div><TransactionTable rows={data.transactions.slice(0, 5).map((transaction) => { const posting = transaction.postings.find((item) => data.accounts.some((candidate) => candidate.id === item.account_id)); const rowAccount = data.accounts.find((candidate) => candidate.id === posting?.account_id); return { id: transaction.id, date: transaction.occurred_on, merchant: transaction.merchant || transaction.description, category: transaction.category || posting?.category || "Sin categoría", account: rowAccount?.alias || rowAccount?.name || "—", status: transaction.reconciled ? "Conciliado" : "Confirmado", amount: `${Number(posting?.amount ?? 0) > 0 ? "+" : ""}${money(posting?.amount ?? 0, posting?.currency ?? "MXN")}` }; })} /></article>
    </section>
  </>;
}

function DesktopAccounts({ accounts, onManage }: { accounts: Account[]; onManage: () => void }) {
  return <article className="dashboard-card accounts-card"><div className="card-heading"><span><h2>Cuentas</h2><p>Saldo y utilización</p></span><button type="button" onClick={onManage}>Administrar</button></div><div className="account-list">{accounts.filter((item) => !item.archived_at).slice(0, 4).map((item) => <div key={item.id}><span className="account-icon">{item.kind === "credit" ? <Receipt /> : <Bank />}</span><span><strong>{item.alias || item.name}</strong><small>{item.kind === "credit" ? `${Number(item.utilization_pct ?? 0).toFixed(0)}% utilizado` : item.institution || item.kind}</small></span><b>{money(item.balance, item.currency)}</b></div>)}{!accounts.length && <div className="empty-row"><span className="account-icon"><Bank /></span><span><strong>Sin cuentas</strong><small>Agrega tu primera cuenta.</small></span></div>}</div></article>;
}

type DesktopTransactionRow = { id: string; date: string; merchant: string; category: string; account: string; status: string; amount: string };

function TransactionTable({ rows, onEdit }: { rows: DesktopTransactionRow[]; onEdit?: (row: DesktopTransactionRow) => void }) {
  return <div className="desktop-table-wrap"><table><thead><tr><th>Fecha</th><th>Comercio</th><th>Categoría</th><th>Cuenta</th><th>Estado</th><th>Importe</th>{onEdit && <th />}</tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{row.date}</td><td><strong>{row.merchant}</strong></td><td>{row.category}</td><td>{row.account}</td><td><span className={`table-status ${row.status === "Por revisar" ? "warning" : ""}`}>{row.status}</span></td><td className={row.amount.startsWith("+") ? "money positive" : "money"}>{row.amount}</td>{onEdit && <td><button className="table-action" type="button" onClick={() => onEdit(row)}>Editar</button></td>}</tr>)}</tbody></table></div>;
}

function DesktopTransactions({ rows, onCreate, mutate }: { rows: DesktopTransactionRow[]; onCreate: () => void; mutate: <T>(operation: () => Promise<T>) => Promise<T> }) {
  const edit = (row: DesktopTransactionRow) => { const category = window.prompt("Categoría", row.category); if (category?.trim()) void mutate(() => financeApi.updateTransaction(row.id, { category: category.trim() })); };
  return <><div className="page-actions"><button className="desktop-primary" type="button" onClick={onCreate}><PlusIcon /> Nuevo movimiento</button></div><section className="page-card"><div className="page-card-heading"><span><h2>Todos los movimientos</h2><p>{rows.length} resultados · filtros aplicados globalmente</p></span><button className="outline-button" type="button" onClick={() => { const csv = ["Fecha,Comercio,Categoría,Cuenta,Estado,Importe", ...rows.map((row) => [row.date, row.merchant, row.category, row.account, row.status, row.amount].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))].join("\n"); const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); link.download = "movimientos.csv"; link.click(); URL.revokeObjectURL(link.href); }}>Exportar CSV</button></div><TransactionTable rows={rows} onEdit={edit} /></section></>;
}

function DesktopAccountManager({ accounts, onCreate, mutate }: { accounts: Account[]; onCreate: () => void; onRefresh: () => void; mutate: <T>(operation: () => Promise<T>) => Promise<T> }) {
  return <><div className="page-actions"><button className="desktop-primary" type="button" onClick={onCreate}><PlusIcon /> Nueva cuenta</button></div><section className="account-manager-grid">{accounts.map((item) => <article className={`page-card account-admin-card ${item.archived_at ? "archived" : ""}`} key={item.id}><div className="account-admin-head"><span className="account-icon"><Bank /></span><span><small>{item.kind === "investment" ? "Inversión manual" : item.kind === "credit" ? "Tarjeta de crédito" : item.kind}</small><h2>{item.alias || item.name}</h2></span><b>{money(item.balance, item.currency)}</b></div><dl><div><dt>Institución</dt><dd>{item.institution || "Sin definir"}</dd></div><div><dt>Terminación</dt><dd>{item.last_four ? `•• ${item.last_four}` : "—"}</dd></div>{item.kind === "credit" && <><div><dt>Crédito disponible</dt><dd>{money(item.credit_available ?? 0)}</dd></div><div><dt>Utilización</dt><dd>{Number(item.utilization_pct ?? 0).toFixed(1)}%</dd></div><div><dt>Corte / pago</dt><dd>{item.statement_day || "—"} / {item.due_day || "—"}</dd></div></>}</dl><div className="account-card-actions"><button type="button" disabled={Boolean(item.archived_at)} onClick={() => { const next = window.prompt("Nuevo nombre", item.name); if (next?.trim()) void mutate(() => financeApi.updateAccount(item.id, { name: next.trim() })); }}>Editar</button><button className="text-danger" type="button" disabled={Boolean(item.archived_at)} onClick={() => { if (window.confirm(`Archivar ${item.name}? Sus movimientos se conservarán.`)) void mutate(() => financeApi.archiveAccount(item.id)); }}>Archivar</button></div></article>)}{!accounts.length && <article className="page-card empty-state"><Bank /><h2>No hay cuentas</h2><p>Agrega efectivo, débito, ahorro, crédito, deuda o inversión manual.</p><button className="desktop-primary" type="button" onClick={onCreate}>Crear primera cuenta</button></article>}</section></>;
}

function FinanceDialog({ kind, accounts, onClose, mutate }: { kind: "account" | "budget" | "transaction" | "scenario" | "recurring" | "goal"; accounts: Account[]; onClose: () => void; mutate: <T>(operation: () => Promise<T>) => Promise<T> }) {
  const [form, setForm] = useState<Record<string, string | boolean>>({ type: kind === "account" ? "debit" : "expense", currency: "MXN", opening: "0", rollover: false, month: `${new Date().toISOString().slice(0, 7)}-01`, occurred_on: new Date().toISOString().slice(0, 10), income_pct: "0", expense_pct: "0", one_time: "0" });
  const set = (key: string, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }));
  const save = async () => {
    if (kind === "account") await mutate(() => financeApi.createAccount({ name: form.name, alias: form.alias || null, kind: form.type, currency: form.currency, opening_balance: form.opening || "0", institution: form.institution || null, last_four: form.last_four || null, credit_limit: form.type === "credit" && form.credit_limit ? form.credit_limit : null, statement_day: form.type === "credit" && form.statement_day ? Number(form.statement_day) : null, due_day: form.type === "credit" && form.due_day ? Number(form.due_day) : null }));
    if (kind === "budget") await mutate(() => financeApi.createBudget({ month: form.month, category: form.category, limit_amount: form.amount, rollover: Boolean(form.rollover) }));
    if (kind === "transaction") {
      const splits = form.split_category_1 && form.split_amount_1 ? [{ category: form.split_category_1, amount: form.split_amount_1 }, ...(form.split_category_2 && form.split_amount_2 ? [{ category: form.split_category_2, amount: form.split_amount_2 }] : [])] : [];
      await mutate(() => financeApi.createSimpleTransaction({ occurred_on: form.occurred_on, kind: form.type, account_id: form.account_id, target_account_id: form.target_account_id || null, amount: form.amount, description: form.description, merchant: form.merchant || null, category: splits.length ? null : form.category || null, note: form.note || null, tags: String(form.tags || "").split(",").map((item) => item.trim()).filter(Boolean), splits, reconciled: Boolean(form.reconciled) }));
    }
    if (kind === "scenario") await mutate(() => financeApi.createScenario({ name: form.name, kind: "custom", income_adjustment_pct: form.income_pct || "0", expense_adjustment_pct: form.expense_pct || "0", one_time_adjustment: form.one_time || "0", assumptions: {} }));
    if (kind === "recurring") await mutate(() => financeApi.createRecurring({ name: form.name, kind: form.type, amount: form.amount, currency: "MXN", cadence: form.cadence || "monthly", next_date: form.next_date || new Date().toISOString().slice(0, 10), account_id: form.account_id || null, counterparty_account_id: form.target_account_id || null, category: form.category || null, active: true, confirmed: true }));
    if (kind === "goal") await mutate(() => financeApi.createGoal({ name: form.name, target_amount: form.amount, target_date: form.target_date || null, account_id: form.account_id || null, active: true }));
    onClose();
  };
  const title = kind === "account" ? "Nueva cuenta" : kind === "budget" ? "Nuevo presupuesto" : kind === "transaction" ? "Nuevo movimiento" : kind === "scenario" ? "Escenario personalizado" : kind === "recurring" ? "Nueva recurrencia" : "Nueva meta";
  return <div className="desktop-modal-backdrop" role="presentation" onMouseDown={onClose}><section className="desktop-modal finance-form-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}><div className="modal-heading"><span><small>Datos persistentes</small><h2>{title}</h2></span><button type="button" onClick={onClose}>×</button></div><div className="desktop-form-grid">
    {kind === "account" && <><label>Nombre<input value={String(form.name || "")} onChange={(event) => set("name", event.target.value)} /></label><label>Alias<input value={String(form.alias || "")} onChange={(event) => set("alias", event.target.value)} /></label><label>Tipo<select value={String(form.type)} onChange={(event) => set("type", event.target.value)}><option value="cash">Efectivo</option><option value="debit">Débito</option><option value="savings">Ahorro</option><option value="credit">Crédito</option><option value="debt">Deuda</option><option value="investment">Inversión manual</option></select></label><label>Saldo inicial<input type="number" step="0.01" value={String(form.opening)} onChange={(event) => set("opening", event.target.value)} /></label><label>Institución<input value={String(form.institution || "")} onChange={(event) => set("institution", event.target.value)} /></label><label>Últimos 4<input maxLength={4} value={String(form.last_four || "")} onChange={(event) => set("last_four", event.target.value.replace(/\D/g, ""))} /></label>{form.type === "credit" && <><label>Límite<input type="number" step="0.01" value={String(form.credit_limit || "")} onChange={(event) => set("credit_limit", event.target.value)} /></label><label>Día de corte<input type="number" min="1" max="31" value={String(form.statement_day || "")} onChange={(event) => set("statement_day", event.target.value)} /></label><label>Día de pago<input type="number" min="1" max="31" value={String(form.due_day || "")} onChange={(event) => set("due_day", event.target.value)} /></label></>}</>}
    {kind === "budget" && <><label>Mes<input type="date" value={String(form.month)} onChange={(event) => set("month", `${event.target.value.slice(0, 7)}-01`)} /></label><label>Categoría<input value={String(form.category || "")} onChange={(event) => set("category", event.target.value)} /></label><label>Límite<input type="number" step="0.01" value={String(form.amount || "")} onChange={(event) => set("amount", event.target.value)} /></label><label className="desktop-check"><input type="checkbox" checked={Boolean(form.rollover)} onChange={(event) => set("rollover", event.target.checked)} /> Aplicar rollover positivo</label></>}
    {kind === "transaction" && <><label>Fecha<input type="date" value={String(form.occurred_on)} onChange={(event) => set("occurred_on", event.target.value)} /></label><label>Tipo<select value={String(form.type)} onChange={(event) => set("type", event.target.value)}><option value="expense">Gasto</option><option value="income">Ingreso</option><option value="transfer">Transferencia</option><option value="debt_payment">Pago de deuda</option><option value="valuation">Valuación de inversión</option></select></label><label>Cuenta<select value={String(form.account_id || "")} onChange={(event) => set("account_id", event.target.value)}><option value="">Selecciona</option>{accounts.filter((item) => !item.archived_at).map((item) => <option value={item.id} key={item.id}>{item.alias || item.name}</option>)}</select></label>{(form.type === "transfer" || form.type === "debt_payment") && <label>Cuenta destino<select value={String(form.target_account_id || "")} onChange={(event) => set("target_account_id", event.target.value)}><option value="">Selecciona</option>{accounts.filter((item) => !item.archived_at).map((item) => <option value={item.id} key={item.id}>{item.alias || item.name}</option>)}</select></label>}<label>Importe<input type="number" step="0.01" value={String(form.amount || "")} onChange={(event) => set("amount", event.target.value)} /></label><label>Descripción<input value={String(form.description || "")} onChange={(event) => set("description", event.target.value)} /></label><label>Categoría<input value={String(form.category || "")} onChange={(event) => set("category", event.target.value)} /></label><label>Comercio<input value={String(form.merchant || "")} onChange={(event) => set("merchant", event.target.value)} /></label><label>Etiquetas separadas por coma<input value={String(form.tags || "")} onChange={(event) => set("tags", event.target.value)} /></label><label>Nota<input value={String(form.note || "")} onChange={(event) => set("note", event.target.value)} /></label>{form.type === "expense" && <><p className="form-section-label">División opcional</p><span /><label>Categoría 1<input value={String(form.split_category_1 || "")} onChange={(event) => set("split_category_1", event.target.value)} /></label><label>Importe 1<input type="number" step="0.01" value={String(form.split_amount_1 || "")} onChange={(event) => set("split_amount_1", event.target.value)} /></label><label>Categoría 2<input value={String(form.split_category_2 || "")} onChange={(event) => set("split_category_2", event.target.value)} /></label><label>Importe 2<input type="number" step="0.01" value={String(form.split_amount_2 || "")} onChange={(event) => set("split_amount_2", event.target.value)} /></label></>}<label className="desktop-check"><input type="checkbox" checked={Boolean(form.reconciled)} onChange={(event) => set("reconciled", event.target.checked)} /> Marcar como conciliado</label></>}
    {kind === "scenario" && <><label>Nombre<input value={String(form.name || "")} onChange={(event) => set("name", event.target.value)} /></label><label>Ajuste de ingresos (%)<input type="number" value={String(form.income_pct)} onChange={(event) => set("income_pct", event.target.value)} /></label><label>Ajuste de gastos (%)<input type="number" value={String(form.expense_pct)} onChange={(event) => set("expense_pct", event.target.value)} /></label><label>Ajuste único<input type="number" step="0.01" value={String(form.one_time)} onChange={(event) => set("one_time", event.target.value)} /></label></>}
    {kind === "recurring" && <><label>Nombre<input value={String(form.name || "")} onChange={(event) => set("name", event.target.value)} /></label><label>Tipo<select value={String(form.type)} onChange={(event) => set("type", event.target.value)}><option value="expense">Gasto</option><option value="income">Ingreso</option><option value="debt_payment">Pago de deuda</option></select></label><label>Importe<input type="number" step="0.01" value={String(form.amount || "")} onChange={(event) => set("amount", event.target.value)} /></label><label>Frecuencia<select value={String(form.cadence || "monthly")} onChange={(event) => set("cadence", event.target.value)}><option value="weekly">Semanal</option><option value="biweekly">Quincenal</option><option value="monthly">Mensual</option><option value="yearly">Anual</option></select></label><label>Próxima fecha<input type="date" value={String(form.next_date || "")} onChange={(event) => set("next_date", event.target.value)} /></label><label>Cuenta<select value={String(form.account_id || "")} onChange={(event) => set("account_id", event.target.value)}><option value="">Sin asignar</option>{accounts.filter((item) => !item.archived_at).map((item) => <option value={item.id} key={item.id}>{item.alias || item.name}</option>)}</select></label><label>Categoría<input value={String(form.category || "")} onChange={(event) => set("category", event.target.value)} /></label></>}
    {kind === "goal" && <><label>Nombre<input value={String(form.name || "")} onChange={(event) => set("name", event.target.value)} /></label><label>Objetivo<input type="number" step="0.01" value={String(form.amount || "")} onChange={(event) => set("amount", event.target.value)} /></label><label>Fecha objetivo<input type="date" value={String(form.target_date || "")} onChange={(event) => set("target_date", event.target.value)} /></label><label>Cuenta vinculada<select value={String(form.account_id || "")} onChange={(event) => set("account_id", event.target.value)}><option value="">Sin asignar</option>{accounts.filter((item) => !item.archived_at).map((item) => <option value={item.id} key={item.id}>{item.alias || item.name}</option>)}</select></label></>}
  </div><div className="modal-actions"><button type="button" onClick={onClose}>Cancelar</button><button className="desktop-primary" type="button" onClick={() => void save()}>Guardar</button></div></section></div>;
}

function DesktopBudgets({ budgets, onCreate, mutate }: { budgets: Budget[]; onCreate: () => void; mutate: <T>(operation: () => Promise<T>) => Promise<T> }) {
  const chartData = budgets.map((budget) => ({ category: budget.category, real: Number(budget.used), disponible: Math.max(Number(budget.available), 0) }));
  const used = budgets.reduce((sum, budget) => sum + Number(budget.used), 0);
  const total = budgets.reduce((sum, budget) => sum + Number(budget.limit_amount) + Number(budget.rollover_amount), 0);
  const current = new Date();
  const targetMonth = current.toISOString().slice(0, 7);
  const sourceMonth = new Date(current.getFullYear(), current.getMonth() - 1, 1).toISOString().slice(0, 7);
  return <><div className="page-actions"><button className="outline-button" type="button" onClick={() => void mutate(() => financeApi.copyBudgets(sourceMonth, targetMonth))}>Copiar mes anterior</button><button className="desktop-primary" type="button" onClick={onCreate}><PlusIcon /> Nuevo presupuesto</button></div><section className="wide-two-column"><article className="page-card"><div className="page-card-heading"><span><h2>Ejecución del presupuesto</h2><p>{money(used)} de {money(total)} usados</p></span><span className="health-pill"><CheckCircle weight="fill" /> {budgets.some((item) => item.status === "over") ? "Requiere atención" : "Dentro del plan"}</span></div>{chartData.length ? <div className="chart-frame tall"><ResponsiveContainer width="100%" height="100%"><BarChart data={chartData} margin={{ top: 16, right: 18, left: 0, bottom: 0 }}><CartesianGrid stroke="#e9ebf1" vertical={false} /><XAxis dataKey="category" tickLine={false} axisLine={false} tick={{ fill: "#657087", fontSize: 12 }} /><YAxis tickLine={false} axisLine={false} tickFormatter={(value) => `$${value / 1000}k`} /><Tooltip content={<CurrencyTooltip />} /><Legend /><Bar isAnimationActive={false} dataKey="real" name="Usado" stackId="a" fill="#3f55c8" radius={[5, 5, 0, 0]} /><Bar isAnimationActive={false} dataKey="disponible" name="Disponible" stackId="a" fill="#e4e7f2" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div> : <div className="empty-state"><Target /><h3>Aún no hay presupuestos</h3><p>Define límites por categoría para comenzar.</p><button className="desktop-primary" type="button" onClick={onCreate}>Crear presupuesto</button></div>}</article><article className="page-card"><div className="page-card-heading"><span><h2>Categorías</h2><p>Rollover, avance y acciones</p></span></div><div className="insight-list">{budgets.map((budget) => <div key={budget.id}><span className={budget.status === "over" ? "warning-dot" : budget.status === "warning" ? "neutral-dot" : "healthy-dot"} /><span><strong>{budget.category} · {Number(budget.percent_used).toFixed(0)}%</strong><small>{money(budget.available)} disponibles{budget.rollover ? ` · rollover ${money(budget.rollover_amount)}` : ""}</small></span><button type="button" onClick={() => { const next = window.prompt(`Nuevo límite para ${budget.category}`, budget.limit_amount); if (next && Number(next) > 0) void mutate(() => financeApi.updateBudget(budget.id, { month: budget.month, category: budget.category, limit_amount: next, rollover: budget.rollover })); }}>Editar</button><button className="text-danger" type="button" onClick={() => { if (window.confirm(`Eliminar el presupuesto de ${budget.category}?`)) void mutate(() => financeApi.deleteBudget(budget.id)); }}>Eliminar</button></div>)}{!budgets.length && <p className="muted-copy">Las alertas aparecerán cuando exista ejecución real.</p>}</div></article></section></>;
}

function DesktopForecast({ base, conservative, scenarios, onCreateScenario, onCreateRecurring, onCreateGoal }: { base: Forecast; conservative: Forecast; scenarios: Scenario[]; onCreateScenario: () => void; onCreateRecurring: () => void; onCreateGoal: () => void }) {
  const [months, setMonths] = useState<3 | 6 | 12>(6);
  const [selectedScenario, setSelectedScenario] = useState("comparison");
  const [dynamicBase, setDynamicBase] = useState(base);
  const [dynamicComparison, setDynamicComparison] = useState(conservative);
  useEffect(() => {
    void Promise.all([
      financeApi.forecast(months, "base"),
      selectedScenario === "comparison" ? financeApi.forecast(months, "conservative") : financeApi.forecast(months, "custom", selectedScenario),
    ]).then(([nextBase, nextComparison]) => { setDynamicBase(nextBase); setDynamicComparison(nextComparison); });
  }, [months, selectedScenario]);
  const chartData = dynamicBase.points.map((point, index) => ({ month: new Intl.DateTimeFormat("es-MX", { month: "short" }).format(new Date(`${point.month}T12:00:00`)), base: Number(point.balance), comparison: Number(dynamicComparison.points[index]?.balance ?? point.balance) }));
  return <><div className="forecast-controls"><label>Horizonte<select value={months} onChange={(event) => setMonths(Number(event.target.value) as 3 | 6 | 12)}><option value="3">3 meses</option><option value="6">6 meses</option><option value="12">12 meses</option></select></label><label>Comparar con<select value={selectedScenario} onChange={(event) => setSelectedScenario(event.target.value)}><option value="comparison">Conservador</option>{scenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.name}</option>)}</select></label><button className="outline-button" type="button" onClick={onCreateRecurring}>Recurrencia</button><button className="outline-button" type="button" onClick={onCreateGoal}>Meta</button><button className="desktop-primary" type="button" onClick={onCreateScenario}><PlusIcon /> Escenario</button></div><section className="page-card"><div className="page-card-heading"><span><h2>Proyección de saldo</h2><p>Base y {dynamicComparison.name.toLowerCase()} · MXN · {months} meses · generado {new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeStyle: "short" }).format(new Date(dynamicBase.generated_at))}</p></span><span className="forecast-total"><small>Base al final</small><strong>{money(dynamicBase.points.at(-1)?.balance ?? 0)}</strong></span></div><div className="chart-frame forecast-chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={chartData} margin={{ top: 20, right: 28, left: 4, bottom: 0 }}><CartesianGrid stroke="#e9ebf1" vertical={false} /><XAxis dataKey="month" tickLine={false} axisLine={false} /><YAxis tickLine={false} axisLine={false} tickFormatter={(value) => `$${value / 1000}k`} /><Tooltip content={<CurrencyTooltip />} /><Legend /><Area isAnimationActive={false} type="monotone" dataKey="base" name="Base" stroke="#3f55c8" fill="#3f55c8" fillOpacity={0.09} strokeWidth={3} /><Area isAnimationActive={false} type="monotone" dataKey="comparison" name={dynamicComparison.name} stroke="#69748b" fill="#69748b" fillOpacity={0.04} strokeWidth={2} strokeDasharray="6 5" /></AreaChart></ResponsiveContainer></div><div className="forecast-assumptions"><span><strong>{money(dynamicBase.monthly_income)}</strong><small>Ingreso recurrente</small></span><span><strong>{money(dynamicBase.monthly_expenses)}</strong><small>Gasto y presupuesto</small></span><span><strong>{money(dynamicBase.monthly_goal_allocation)}</strong><small>Metas mensuales</small></span><span><strong>{dynamicComparison.name}</strong><small>Escenario comparado</small></span></div></section></>;
}

function DesktopImports({ items, accounts, onRefresh, mutate }: { items: Array<{ id: string; source: string; detail: string; confidence: string; status: string }>; accounts: Account[]; onRefresh: () => void; mutate: <T>(operation: () => Promise<T>) => Promise<T> }) {
  const input = useRef<HTMLInputElement>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [review, setReview] = useState({ occurred_on: new Date().toISOString().slice(0, 10), account_id: "", amount: "", description: "", category: "" });
  const open = async (id: string) => { const next = await financeApi.importDetail(id); const proposal = (next.proposal ?? {}) as Record<string, unknown>; setSelectedId(id); setDetail(next); setReview({ occurred_on: String(proposal.date || new Date().toISOString().slice(0, 10)).slice(0, 10), account_id: String(proposal.account_id || ""), amount: String(proposal.amount || proposal.total || ""), description: String(proposal.description || next.original_name || "Movimiento importado"), category: String(proposal.category || "") }); };
  const confirm = async () => { if (!selectedId) return; await mutate(() => financeApi.confirmImportSimple(selectedId, { occurred_on: review.occurred_on, kind: "expense", account_id: review.account_id, amount: review.amount, description: review.description, category: review.category || null })); setDetail(null); setSelectedId(null); };
  return <section className="page-card"><div className="page-card-heading"><span><h2>Bandeja de revisión</h2><p>Documentos procesados localmente; confirma antes de contabilizar.</p></span><button className="desktop-primary" type="button" onClick={() => input.current?.click()}><PlusIcon /> Importar archivo</button><input ref={input} hidden type="file" accept="application/pdf,text/csv,application/xml,text/xml,image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void financeApi.captureFile(file).then(onRefresh); }} /></div>{items.length ? <div className="review-list-desktop">{items.map((item) => <article key={item.id}><span className="review-file-icon"><FileMagnifyingGlass /></span><span><strong>{item.source}</strong><small>{item.detail}</small></span><span className="confidence"><small>Confianza</small><strong>{item.confidence}</strong></span><span className={`review-state ${item.status === "Revisar" ? "warning" : ""}`}>{item.status}</span><button type="button" onClick={() => void open(item.id)}>Revisar</button></article>)}</div> : <div className="empty-state"><CheckCircle weight="duotone" /><h3>Todo revisado</h3><p>No quedan documentos pendientes.</p></div>}{detail && <div className="import-detail"><div className="page-card-heading"><span><h3>Confirmar movimiento</h3><p>Datos extraídos no confiables; revisa cada campo.</p></span><button type="button" onClick={() => setDetail(null)}>Cerrar</button></div><div className="desktop-form-grid"><label>Fecha<input type="date" value={review.occurred_on} onChange={(event) => setReview({ ...review, occurred_on: event.target.value })} /></label><label>Cuenta<select value={review.account_id} onChange={(event) => setReview({ ...review, account_id: event.target.value })}><option value="">Selecciona</option>{accounts.filter((item) => !item.archived_at).map((item) => <option value={item.id} key={item.id}>{item.alias || item.name}</option>)}</select></label><label>Importe<input type="number" step="0.01" value={review.amount} onChange={(event) => setReview({ ...review, amount: event.target.value })} /></label><label>Categoría<input value={review.category} onChange={(event) => setReview({ ...review, category: event.target.value })} /></label><label className="full-field">Descripción<input value={review.description} onChange={(event) => setReview({ ...review, description: event.target.value })} /></label></div><details><summary>Ver extracción original</summary><pre>{JSON.stringify(detail, null, 2)}</pre></details><div className="modal-actions"><button type="button" onClick={() => setDetail(null)}>Cancelar</button><button className="desktop-primary" type="button" disabled={!review.account_id || !Number(review.amount) || !review.description.trim()} onClick={() => void confirm()}>Confirmar y contabilizar</button></div></div>}</section>;
}

function DesktopAudit({ events }: { events: AuditItem[] }) {
  return <section className="page-card"><div className="page-card-heading"><span><h2>Bitácora de auditoría</h2><p>Accesos, importaciones y cambios sensibles</p></span><button className="outline-button" type="button" onClick={() => { const payload = JSON.stringify(events, null, 2); const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([payload], { type: "application/json" })); link.download = "auditoria.json"; link.click(); URL.revokeObjectURL(link.href); }}>Descargar registro</button></div><div className="audit-list">{events.map((event) => <div key={event.id}><time>{new Intl.DateTimeFormat("es-MX", { dateStyle: "short", timeStyle: "short" }).format(new Date(event.created_at))}</time><span className="audit-symbol"><ClockCounterClockwise /></span><span><strong>{event.action}</strong><small>{event.target_id || "Evento del sistema"}</small></span><b>{event.actor}</b></div>)}{!events.length && <div className="empty-state compact"><ClockCounterClockwise /><h3>Sin eventos</h3></div>}</div></section>;
}

function DesktopSettings({ onSignOut }: { onSignOut: () => void }) {
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [securityMessage, setSecurityMessage] = useState("");
  return <section className="settings-grid"><article className="page-card"><div className="page-card-heading"><span><h2>Privacidad y acceso</h2><p>Estado verificable de la instalación</p></span></div><div className="settings-list"><div><ShieldCheck weight="duotone" /><span><strong>Acceso privado</strong><small>Tailscale Serve · HTTPS requerido</small></span><b>Configurado por host</b></div><div><LockKey weight="duotone" /><span><strong>Documentos cifrados</strong><small>AES-256-GCM</small></span><b>Activo en API</b></div><div><UserCircle weight="duotone" /><span><strong>Passkey</strong><small>Touch ID, Face ID o llave de seguridad</small></span><button className="outline-button" type="button" onClick={() => void financeApi.registerPasskey("Passkey personal").then(() => setSecurityMessage("Passkey registrada correctamente")).catch((error) => setSecurityMessage(error instanceof Error ? error.message : "No fue posible registrar la passkey"))}>Configurar</button></div></div><div className="security-actions"><button className="outline-button" type="button" onClick={() => void financeApi.recoveryCodes().then((result) => setRecoveryCodes(result.codes))}>Generar códigos de recuperación</button><button className="outline-button" type="button" onClick={onSignOut}>Cerrar sesión</button></div>{securityMessage && <p className="security-message">{securityMessage}</p>}{recoveryCodes.length > 0 && <div className="recovery-codes"><strong>Guárdalos fuera del servidor. Cada código funciona una sola vez.</strong>{recoveryCodes.map((code) => <code key={code}>{code}</code>)}</div>}</article><article className="page-card"><div className="page-card-heading"><span><h2>Operación</h2><p>Servicios y almacenamiento</p></span></div><div className="settings-list"><div><Gauge /><span><strong>Servicios base</strong><small>PostgreSQL, Redis y API</small></span><b>Según /health</b></div><div><Sparkle /><span><strong>Modelo local</strong><small>qwen3:4b · Ollama</small></span><b>Opcional</b></div><div><ClockCounterClockwise /><span><strong>Respaldos</strong><small>Consulta el registro de restic en el host</small></span><b>Verificación manual</b></div></div></article></section>;
}
