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

## Owner-requested simpler sequential split flow

Public persona and Telegram display name are Chopper (`@chopper67bot` unchanged).
The internal sarangbooks profile and sarang-bookkeeping skill IDs are retained.
Normal categorisation preserves scanned line values and follows RMS defaults:
RAW_MATERIALS and the first brand, with ONE optional group Brand control. No
per-item brand prompts. Split receipt shows checkboxes FIRST; Continue opens
categories for only the selected group. Confirm Save creates RMS expenses AND
marks consumed indices atomically through the shared createExpense engine.
The response prompts remaining items automatically; funding/method carry over.
Scrap has a separate actor/version-bound confirmation, preserves evidence and
records excluded indices without expense/ledger mutations. Partial receipts
remain PENDING_REVIEW for recovery. Source reading changes after allocation are
refused to prevent reordering booked indices. Existing untracked legacy receipts
are not automatically migrated or re-booked.

`receipt-annotation.ts` overlays translucent brand regions / straight scrap
lines on a separate copy of the actual scan plus an explicit per-item legend.
Original and clean scan stay unchanged. Positions come from inspection of the
cropped scan through vista_receipt_annotate; uncertain/missing positions are not
invented. Idempotent tagged-file recovery and a bounded lease keep uploads
separate from financial confirmation. Upload failure cannot repeat spending;
durable receipt jobs retry the annotation-only path. The cron transport guard
permits form READS with notifications forcibly disabled and annotation writes,
but still blocks expense posting/linking/scrapping and arbitrary Drive changes.
No separate financial engine or new destructive migration is introduced.

## 2026-10-12 bulk inbox / confirmation recovery

Incident R-E076B0 (Speed Mart RM17.95) was already posted once to Bites; a
subsequent native confirmation returned RECEIPT_DONE, wrongly displayed as an
unknown save result. Native recovery now reads the exact actor-bound durable
confirmation result and never retries financial posting. Drive annotations
are queued after commit, not awaited in the save HTTP response.

Persistent actor-specific auto-stash uses audited AgentAction settings;
originals are immediately safe, complete OCR/crop/Drive/checks run in the
existing durable worker. No link/categorise interruption while stashing.
Numbered, actor-bound inbox lists support flags-first, other-first, sequential
review, paging and Revisit later. Exact reuploads of fully booked receipts
create review events, not duplicate documents/spending. Fresh-photo/invoice
checks and historical multi-row invoice sums are distinct from ledger writes.
Drive matching is bounded invoice/file metadata inside verified Finances
ancestry, not guaranteed visual matching or a complete Drive OCR index.

Confirmed Vista expense-item history supplies editable category/brand
suggestions (normalized exact names, latest bounded sample, 80% agreement).
Both authorized users' confirmed entries contribute; OCR/guesses do not.
New funding explicitly prefers STALL_FUNDS. Buttons show category, brand,
funding and payment values. This is scoped evidence-based inference, not
model-weight training or owner-only arbitrary code-edit capability.

Bank screenshots retain actual evidence and visible fields, with an explicitly
custom transaction line. User purpose and outgoing direction are required;
incoming/internal transfers are not automatically expenses. No fabricated
supplier invoice or purchased goods. All postings still require native preview
and explicit confirmation through the existing RMS accounting engine.

Owner-only maintenance: vista_edit_expense reads/creates durable before/after
previews; native real-actor Confirm edit invokes the captured existing RMS PUT
handler inside an expense/receipt-locked transaction. No parallel accounting
engine, and actual locked-period/reimbursement/line arithmetic rules remain.
Edit replay/stale/actor/business guards apply. Receipt annotations are queued
again for changed category/brand; changed allocation amounts/items block further
automatic split posting pending review. Originals are never rewritten.

vista_cleanup_receipt requires an explicitly reused duplicate, canonical
evidence present, zero source expenses, no running worker and no shared file IDs.
Native OWNER confirmation locks source/canonical, validates exact preview,
trashes only source-tagged files under Finances, deletes duplicate ReceiptImage
cache and retains an audited ReceiptDocument tombstone. Drive Trash is
recoverable; canonical originals and all accounting remain unchanged. Tools
offer preview only; cron transport cannot access either maintenance tool.
No production receipt was deleted or expense edited by implementation tests.

## /bulk, /endbulk, colour scan retention and business-shared preferences

New native commands are registered in the finance bot's Telegram menu only.
/bulk creates a durable per-actor batch, silently stores uploads (no per-photo
message/menu/model turn) and processes OCR/colour perspective cropping/Drive.
Only new batch originals opt into scan-only retention; after complete reading,
real paper corners, source/scan tags, exact SHA256 readback and image validation,
queue finish trashes the original recoverably, points canonical storage at the
scan and clears image cache. Invalid crop/readback retains original and retries.
Existing receipts/exact repeated historical photos never receive this policy.
PDF originals stay unchanged. Original=true on retired sources safely returns
retained scan instead. No financial data or receipt IDs are rewritten.

/endbulk closes intake, waits for in-flight scans and delivers a durable leased
list of its batch only. Lists are standardized numbered lines with ref, merchant,
DD/MM/YYYY date and RM amount, no flag paragraphs/OCR summaries. Paging keeps
global numbers and actor-bound list IDs. Failed jobs are retained/listed, not
silently omitted. Selecting number sends actual stored scan then initial five
action buttons; native Save prompts success + Next receipt/End/Choose custom,
never automatic next. Remaining split groups remain on their existing card.

Shared preferences have a business-scoped audited registry, accessible to every
registered role. vista_preferences list/set/append/forget handles response style,
terminology, report/receipt/workflow preferences and reusable clarification
lessons. Telegram turns inject current shared preferences with a bounded fetch.
No financial figures, protected staff facts, credentials or permission grants
are learned; hard backend/session guards remain. Batch/progress/confirmations
stay actor-specific, while confirmed item-history suggestions remain shared.

Tests cover invalid readback before Trash, colour pixels, retry idempotence,
non-retroactive retention, command silence, initial scan+menu delivery, manual
advance, global numbered pages, completion-delivery lease and shared preferences
across OWNER/BOOKKEEPER/VIEWER with cross-business/unknown-actor isolation.
