import { useEffect, useState } from "react";
import { MobileRuntime } from "./mobile";
import Prototype, { DesktopDashboard } from "./Prototype";
import { FinanceProvider } from "./FinanceContext";

export default function App() {
  const [desktop, setDesktop] = useState(() => window.matchMedia("(min-width: 1024px)").matches);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const update = () => setDesktop(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  if (desktop) return <FinanceProvider><DesktopDashboard /></FinanceProvider>;

  return (
    <FinanceProvider>
      <MobileRuntime>
        <Prototype />
      </MobileRuntime>
    </FinanceProvider>
  );
}
