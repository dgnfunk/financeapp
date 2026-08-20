# Desktop dashboard QA

## Brief and source

- Audience: single owner acting as administrator and auditor.
- Purpose: monitor financial status, understand movement and drivers, review imported documents, and inspect sensitive activity.
- Visual source: the approved mobile direction preserved in `web/design-comparison-v3.png`, extended with the same warm surface, navy typography, indigo actions, green reassurance, progressive detail, and Phosphor icon family.
- Current data source: clearly labeled demonstration fixtures shaped to the live API contract. No claim is made that these are the owner's real values.
- Final screenshot: `web/desktop-dashboard-final.jpg` at 1440 × 1000.

## Metric model

- Saldo disponible: current accessible balance in the selected account scope.
- Ingresos del mes: inflow for the latest visible month.
- Gastos del mes: outflow for the latest visible month.
- Tasa de ahorro: `(ingresos - gastos) / ingresos`; $32,000 - $25,700 = $6,300 and $6,300 / $32,000 = 19.7%.
- Por revisar: count of import proposals not yet removed from the review queue.

## Chart map

1. Ingresos y gastos
   - Question: how are monthly inflows and outflows moving relative to each other?
   - Form: two-series area/line trend with 12 monthly observations, reduced to 8 or 6 when the period filter changes.
   - Encoding: indigo for income, neutral grey for expenses, direct legend, common zero-based MXN axis.
2. Presupuesto por categoría
   - Question: which categories have consumed the most of their available budget?
   - Form: horizontal stacked bars for used and remaining amounts across five categories.
   - Encoding: indigo used amount plus light neutral remaining amount; category labels provide non-color identification.
3. Proyección de saldo
   - Question: how does the base balance path compare with a conservative scenario?
   - Form: two-series line/area trend across seven monthly anchors.
   - Encoding: solid indigo base versus dashed neutral conservative line, with exact scenario assumptions below.

## Interaction and reconciliation checks

- Sidebar navigation renders Resumen, Movimientos, Presupuestos, Proyección, Importaciones, Auditoría, and Ajustes: passed.
- Period selection changes chart grain and KPI calculation scope: passed.
- Account selection changes KPIs, chart values, and transaction rows: passed.
- Search filters the movements table: passed.
- Review action removes an item and reconciles the sidebar and KPI counts: passed.
- Quick capture opens a modal, validates non-empty text, and routes the proposal to review: passed.
- Audit and security views render their operational detail: passed.
- 1024 px desktop breakpoint has no horizontal document or main-content overflow: passed.
- 390 px viewport retains the approved phone experience: passed.
- Production build, protected runtime integrity, and Sites packaging tests: passed.

## Visual QA

- Summary-first hierarchy is visible before interaction.
- Cards, chart titles, units, periods, legends, tables, and source status are readable at laptop scale.
- Charts use honest shared axes, quiet grids, no gradients, and no color-only status distinction.
- No clipping, overlapping labels, broken containers, or unintended horizontal scrolling were observed.

final result: passed
