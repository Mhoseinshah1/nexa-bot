# Printed pages (SFR A4)

`pnpm web:print-shots` (needs Chrome; `NEXA_CHROMIUM=/usr/bin/google-chrome` where Playwright's
is absent) prints `/recovery` with a Mirza dry-run report (fixture set `print-dry-run-report`)
in print media at A4 width, in both themes, and refuses a capture when any report value lies
outside the page or the sidebar/top bar are printed.

| file                                      | what                    |
| ----------------------------------------- | ----------------------- |
| `recovery-dry-run-report.print-dark.jpg`  | dark theme, as printed  |
| `recovery-dry-run-report.print-light.jpg` | light theme, as printed |

Without `styles/print.css` the same run fails: `1 value(s) outside the page: -9..47; chrome printed: .sidebar, .topbar`.
