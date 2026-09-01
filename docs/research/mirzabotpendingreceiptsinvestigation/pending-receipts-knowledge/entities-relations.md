# Entities & relations

```
   Customer ──submits──► Receipt (image/file, via card-to-card in PV)
                              │
                              ▼
                    ┌──────────────────┐
                    │ Unverified queue │ ← `💵 رسید های تایید نشده`
                    └────────┬─────────┘
                             │ approve (human) OR auto-approve (timer)
                             ▼
                     Payment / Wallet credit ?
```

| Relationship | Status |
|---|---|
| Receipt → Gateway (card-to-card) | **INFERRED** — the only gateway with receipt-approval settings; no other gateway has any |
| Receipt → User | **INFERRED** — a per-user auto-approval exemption exists, so receipts are user-scoped |
| Receipt → Wallet | **UNKNOWN** — not proven that approval credits the wallet rather than settling an order |
| Receipt → Order | **UNKNOWN** |
| Receipt → Payment | **UNKNOWN** — see PRBR-004; the two terms are used interchangeably by the UI |
| Receipt → Admin (reviewer identity) | **UNKNOWN** — no reviewer field observed anywhere |

**Nothing here is VERIFIED**, because no receipt was ever observed. The diagram is the hypothesis this
phase leaves behind, not a finding.
