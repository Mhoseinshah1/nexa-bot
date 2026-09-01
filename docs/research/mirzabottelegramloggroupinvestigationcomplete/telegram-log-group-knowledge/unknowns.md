# Unknowns — Telegram log-group phase

| ID | Question | Why unresolved | How to resolve |
|---|---|---|---|
| UNK-LGR-001 | What does the `⚙️ مدیریت کاربر` inline button do? | **NOT_TESTED** — the brief forbids pressing buttons that may mutate state. | Read the callback handler in the source, or press it in a staging bot. |
| UNK-LGR-002 | What does `ارسال پیام به کاربر` do (opens a compose flow? sends immediately?) | NOT_TESTED, same reason. | Source, or staging. |
| UNK-LGR-003 | What selects renewal template R1 vs R2? | Both appear on the same day for the same panel; no field distinguishes them. | Source diff of the two renewal code paths. |
| UNK-LGR-004 | Why do some 10-minute cleanup runs post nothing while other empty runs post a header-only message? | The suppression condition is not visible in the output. | Source. |
| UNK-LGR-005 | What is the referral-commission **rate**? | Never printed; only the resulting amount. | Bot referral settings screen (already audited surface) or source. |
| UNK-LGR-006 | Is the backup the **main** bot's DB or the **reseller** bot's DB? | Topic name and caption contradict each other; archive not opened. | Ask the owner, or read the backup cron in the source. |
| UNK-LGR-007 | What prize does a lucky-wheel win grant? | Not logged. | Lucky-wheel settings surface. |
| UNK-LGR-008 | Full body of the card-to-card receipt-approval message. | Only the pinned preview was visible in the sampled window. | Search the group for `رسید پرداخت` over a wider window. |
| UNK-LGR-009 | Exact period of the notification cron. | Gaps are event-driven (0–7 min), so the loop period is masked. | Source. Do **not** infer it from the logs. |
| UNK-LGR-010 | Whether warnings repeat if the customer ignores them. | 11-hour window showed no repeats, but that is shorter than a plausible repeat interval. | Longer capture or source. |
| UNK-LGR-011 | Backup retention / pruning. | No pruning message; Telegram keeps everything. | Source, or owner policy. |
| UNK-LGR-012 | Whether commission is reversed on refund. | No clawback message exists. | Source. |
| UNK-LGR-013 | Meaning of `محدودیت محصول` (0 in 100% of samples). | Never non-zero in the window. | Product settings surface (device/IP limit). |
| UNK-LGR-014 | Why topic ids 2–6 are missing. | Telegram does not expose deleted-topic history. | Owner. |
| UNK-LGR-015 | Whether `📝 گزارش اطلاع رسانی ها` records *sent* notifications or merely *matched conditions*. | No delivery-status field. | Source. |

## Explicitly NOT_INSPECTED_FOR_SECURITY (per the brief)
- Contents of any `backup_*.zip`: schema, tables, customer rows, credentials, tokens, keys.
- Any credential appearing inside an error stack trace (none were reproduced).
- The bot token (never reproduced anywhere in this knowledge base).
- The customer crypto wallet address (recorded only as `WALLET_ADDRESS_REDACTED`).
