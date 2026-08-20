# Design QA

## Evidence

- Source: `web/design-comparison-v3.png`
- Implementation: `web/implementation-screen-v3.png`
- Combined comparison: `web/design-comparison-v3.png`
- Comparison viewport: 393 × 852 CSS pixels, iPhone preset, home state, keyboard and sheets closed.

## Comparison history

1. The first implementation placed the recent activity too low and allowed the final row to run behind the fixed navigation.
2. Reduced vertical gaps around capture, daily pulse, summary copy, and transactions while preserving the reference hierarchy.
3. The final capture shows all three movements, an unobstructed bottom navigation, matching content order, closely matching type scale, semantic colors, borders, icon treatment, and density.

The template-owned phone bezel, live status bar, Dynamic Island, and home indicator are intentionally present and excluded from app-content fidelity scoring.

## Interaction checks

- Natural-language entry opens a review sheet before confirmation: passed.
- Confirming clears the draft and closes the sheet: passed.
- Attachment action opens private-document options: passed.
- Choosing a file reaches review before accounting: passed.
- Bottom navigation changes the active section and can return home: passed.
- Movements, budget, forecast, and private chat render their working states: passed.
- Sending chat text dismisses the simulated keyboard and adds the local-only response: passed.
- PWA manifest, service worker, install icons, and static worker packaging: passed.
- Production build and protected mobile-runtime integrity check: passed.

## Findings

- P0: none.
- P1: none.
- P2: none.
- P3: the implementation uses the template's live device chrome, so the app-owned content begins lower than the source image. This is the required mobile-runtime exception and does not affect usability.

final result: passed
