# Sarang runtime completion — 12 October 2026

The Telegram ingress is now deterministic, not just an agent prompt. The native
PTB adapter has three narrow hooks, active only when its profile home is
`/home/ubuntu/.hermes/profiles/sarangbooks`: photo, image-document and callback.
Original upstream backup: adapter.py.before-vista-receipts. Source installer:
install-telegram-receipts.py. Reapply after a Hermes upstream update only if
anchors match; the installer refuses unexpected upstream layouts.

Photo → authenticated Vista staging/queue → immediate four labelled buttons.
Callback UUIDs survive restarts; gateway gates the user and Vista checks their
role again. Key in/Edit enters the existing conversation under the actual clicker
identity; Stash never posts an expense. Viewer/foreign-business guards remain.

New API contracts:

- /agent/receipts/:id/duplicates: fresh-photo OCR identity candidates and reasons.
- /reuse: explicit same-paper confirmation, returns canonical UUID; alternate
  evidence retained, not deleted. Allocated receipts cannot be silently merged.
- /preview and /post append=true: additional NEW brand allocation after a new
  preview/confirmation. Existing allocation and remaining/combined totals are
  shown; stale repeated confirmation tokens are rejected.
- /link accepts additional historical rows on completed receipts too, without
  creating expenses. Persistent missing-evidence cases resolve on linking.
- /agent/data: approved paginated owner business resources, no raw SQL/secrets.
- /agent/item-sales: actual historical per-product modifier quantities/revenue.
  Later order-level corrections are identified as a separate ledger caveat.
- /agent/products/:id/cost: sourced owner-recorded ingredient recipe quantities,
  per-declared-unit purchase costs, overhead and effective date. Missing cost is
  explicit; selling price is never used as cost. Changes are audited.
- /agent/reconciliation: persistent OPEN/RESOLVED discrepancy cases; /refresh
  maintains missing-receipt cases without changing accounting records.
- /agent/queue: durable jobs with 10-minute leases, crash recovery and five
  attempts. Eligible monitoring excludes exhausted jobs to avoid starvation.

The background worker is Hermes cron job 60522e453a6e, "Vista receipt processing",
in sarangbooks, every minute, local delivery, skill sarang-bookkeeping. Monitor
is scripts/receipt-queue-monitor.py. No model call when monitor output is
unchanged. Service context is the explicitly owner-authorised registered
Telegram ID from VISTA_BACKGROUND_TELEGRAM_USER. Worker only processes evidence,
never posts, links, skips, rejects or edits financial/roster/stock records.
`only_missing=true` preserves existing user corrections during background OCR.

Once reading completes, vista_receipt_notify sends a fixed summary/possible-
duplicate warning and four real buttons to the stored photo's origin only.
It has no arbitrary destination/text and reads only the finance profile's
private token (never the host's personal/marketing token). Notification state
persists. An ambiguous Telegram send/network failure can be retried; financial
operations remain separately preview-token-protected.

Migration 20261012053000_agent_completion adds receipt_jobs,
reconciliation_cases and product_recipes; no existing accounting rows rewritten.
Rollback code to prior release leaves these additive tables intact. Restore the
native adapter backup only during a coordinated maintenance window, and pause
the worker when rolling back API routes it requires. Do not re-run seed against
production. Test seed cleanup is explicitly gated by *_test database validation.

Verification: live Telegram menu accepted (message 32), real existing receipt
queued and completed by Hermes cron, originals/scans still in Drive with DB
cache absent, no expense posted. Hermes session 20261012_052102_90497a confirmed
Latte's 93 sales and named add-ons, 41 persistent missing-photo cases, missing
ingredient inputs and corrected BFEE-vs-Speed-Mart matching. Five Python
transport tests verify immediate menus, duplicate explanation, image documents,
non-Sarang isolation and callback identity. Backend completion tests verify
fresh-photo candidates, explicit reuse, later allocations/replay protection,
leases/retry, case persistence, legacy attachments, cost calculation/isolation
and actual add-on checkout snapshots.

Owner acceptance still requires a NEW Telegram receipt photo and actual button
clicks. A delivered menu and transport tests do not prove an owner click-through.
Recipe costs cannot be populated without real owner-supplied recipe/purchase
data. Named bank reconciliation cannot be represented as a separate bank ledger
because existing Vista keeps one combined stall cash book; explain that clearly.

## Native receipt card and faster model (12 October 2026)

`GET/PATCH /agent/receipts/:id/form` exposes actor-specific persistent drafts
using live Vista options; line categories map to Expense.category and brands
to Expense.brandId. Identical settings are grouped into entries while quantity,
unit and price map to ExpenseItem. Missing OCR values block preview. Printed
total differences are explicit adjustment rows, never silently distributed.
`/form/preview` uses the existing RMS accounting engine and durable actor-bound
confirmation records; `/form/post` revalidates reading, choices, draft version
and the exact shared preview token. No new financial schema or second ledger.
Completed receipts cannot be saved in full again. Reading/scan writes serialize
with draft updates so processing cannot erase concurrent categorisation.

`receipt_form.py` renders real native Telegram line category/brand buttons,
global funding/method/brand controls, pagination, exact preview and Confirm Save.
Callbacks carry durable IDs and option fingerprints, never credentials. Old
`vr:...:key` callbacks still work; visible label is now Categorise. Cancel keeps
the evidence and does not skip/reject/post it. Actor identity and role are
revalidated for every action. Possible duplicate/matching records are shown and
can be handed back to Hermes for explicit reuse or linking. Original and scan
remain in Drive; all new entries point at the same receipt document.

`configure-speed.py` changes sarangbooks only to GPT-6 Luna, low reasoning and
direct Vista schemas (no tool-discovery round trips), preserving all toolsets,
MCP settings and credentials. Backup: config.yaml.before-speed-v1. Telegram
events preload sarang-bookkeeping through Hermes' supported auto-skill path.
SOUL contains short accurate routing and multi-brand workflow examples. This
is instruction/tool optimisation, not weight fine-tuning. The current provider
is openai-codex with subscription_included billing; public API token pricing
does not describe the owner's actual bill. `model-eval.py` runs bounded live
read-only cases and checks effective model, expected tools, actual sender ID
and forbidden mutations. Do not interpret passing tool assertions as exhaustive
accuracy proof; inspect the returned answers and verify native owner clicks.

Adversarial testing caught attempted identity substitution from untrusted user
text. `vista_actor_guard.py` now binds calls to Hermes' trusted task-local
Telegram session; an explicit mismatching ID is rejected BEFORE the MCP RPC.
`install-vista-actor-guard.py` installs the exact finance-bridge-only hook in
tools/mcp_tool_handlers.py, with .py.before-vista-actor rollback backup. Other
connections are unchanged. Cron is restricted to receipt evidence tools and
the explicitly authorised owner service actor; posting, linking and Drive
reorganisation are blocked in that background channel. The normal owner's
interactive requests still support the existing approved Vista/Drive workflows.
`verify-actor-transport.py` tested the installed transport with concurrent
distinct actors, substitution attempts and worker posting; all passed.
Three repeated actual Luna denied-access cases after guard/instruction fixes
refused alternate identities and returned no protected staff/payroll data.
