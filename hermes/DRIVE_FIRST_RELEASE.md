# Chopper Drive-first release — 14 October 2026 (MYT)

## Live implementation

Chopper's native Hermes Telegram photo/text/callback hooks now own receipt intake.
Photos are uploaded directly to Drive Processing before any model reading.
Two bounded Hermes GPT-6 Luna readers use the existing openai-codex provider.
The private Pillow/OpenCV worker performs EXIF correction, paper-edge detection,
real-pixel perspective flattening, colour contrast and sharpening. Explicitly
corrected corners override automatic detection. A second image reading verifies
completeness/readability and unchanged total before original retirement.

One Drive `pending-receipts.jsonl` register contains all temporary readings,
selected fields, receipt keys, states and actual Drive IDs. Private SQLite/WAL
provides the queue and submission recovery journal; it is not another public
stash document. Unconfigured/Configured have no date folders. Native field
menus use the live Vista options. Only exact native confirmation submits the
signed preview to Vista. The writer is deterministic code, not a financial
model worker. After acknowledgement, complete receipts move to
Submitted/YYYY/MM and leave the pending register. Split receipts keep remaining
items pending. RMS uses the stored Drive ID to fetch the private scan for that
expense; no filename search or provisional Vista image upload is needed.

`/bulk` suppresses individual intake cards. `/endbulk` waits for processing and
delivers a numbered merchant/date/amount list. `/inbox` retrieves pending
receipts. Next/End/Choose are explicit actions. Originals go to recoverable
Drive Trash only after scan/hash/register readback; uncertain cases keep the
source. Failed jobs expose the real scan review reasons. A lost submit response
uses the same submission ID; no automatic refund/repost.

Source: chopper_receipts.py, chopper_scan.py, chopper-receipt-worker.py,
telegram_receipts.py, vista_mcp.py and ../src/routes/agent-sealed-receipts.ts.
No replacement agent framework, separate Telegram bots or extra provider keys.

## Deployment and operations

- API: aztechdigital / vista-api; Fastify, Node 24, function sin1.
- Production build: `dpl_53MHQxe5Tf3EUU6pHM1hyGa9m3ad`,
  https://vista-l3eslyqk5-aztechdigital.vercel.app; READY and promoted.
- `/healthz` returned `{"ok":true}`; authenticated Chopper context and a real
  RM17.95 preview succeeded. Preview created no expense.
- Host: `/home/ubuntu/.hermes/profiles/sarangbooks`; Drive-first flag enabled.
- `hermes-chopper-receipts.service` enabled/active; gateway gracefully reloaded.
- Legacy Vista receipt cron `60522e453a6e` paused.
- Drive Receipts root `1xsog3UVSvP9jZN7gggNWhqNTZYH8axen`;
  register `1X1bWKqX_EA6olMku2YrvGsGsDoPGWZH0`.
- No database schema migration required.

## Existing receipts and authorised cleanup

All 32 former ReceiptDocuments were adopted before removing Vista drafts.
Previously selected fields on the linked 99 Speed Mart expense were restored
for review/confirmation, not automatically replayed. Recursive Drive inventory
accounted for every active file: known receipt sources/scans plus one old
allocation overlay. That exact overlay was moved to recoverable Trash after
verified readback of its clean canonical scan. Existing scans are verified;
failed ones are reprocessed from their originals or marked NEEDS_REVIEW.
Use verify-drive-first.py for current counts rather than assuming all passed.

Exact backup (private, not committed):
`C:/Users/User/Documents/DEV/Vista/backups/chopper-drive-first-1791928778367.json`
and `.json.cleanup-result.json`. Host also has a private migration backup.

Removed by the owner-authorised guarded transaction:

- Linked experimental expense `15c8a26c-ada5-4b6f-b66a-737e063933e2` (RM17.95).
- Ledger 771 (RM17.95 OUT) and matched correction pair 539/540 (RM81.95
  OUT/IN; net zero).
- 32 former provisional receipt records, cascading old image/job metadata.

Cashbook balance increases RM17.95; no new reversal was added. All 738 POS
orders are unchanged. Unlinked partner-funded expense
`a7b110c6-2961-40af-8307-a88e3f005687` remains: it was outside Chopper-linked
cleanup. Existing AgentActions remain, with an added cleanup audit. Recovery is
from the exact exported rows, not a blind whole-database restore.

## Verification and honest boundaries

- TypeScript build passes. Isolated real Postgres test passes preview-no-draft,
  atomic submission, replay, duplicate invoice rejection and linked RMS image
  retrieval (Google response mocked). Test DB is localhost:5433/vista_test.
- 66 local Python tests pass; 9 Drive-first tests pass on the runtime host,
  including intake-before-reading, restart/revision, split, preview/confirm,
  acknowledgement/filing and uncertain submit recovery.
- Actual Luna read/scanning was exercised on real existing receipt images.
  A crop clipping the vendor was caught and corrected; a .source filename
  rejection was diagnosed and fixed using typed temporary vision filenames.
- Native pending inbox was delivered through the installed Telegram bot.
  Read-only verification checked all 32 register IDs against local pending IDs.
- Actual production expense creation/native owner Confirm click and RMS browser
  click-through were not impersonated. Owner confirmation is the remaining
  production acceptance step; no fictitious test expense/refund was posted.
- This is real-pixel crop/deskew, not all CamScanner features. Curved-paper
  dewarping, obscured print, glare and already-cut-off source text cannot be
  guaranteed. Uncertain images remain reviewable with originals retained.
- Native PDF intake currently requires document review and retains the source.
  Matching invoice/vendor/date/total blocks repeated invoices; it is not a
  universal visual duplicate detector. Performance gains are not yet benchmarked.

## Rollback

Runtime adapter/SOUL backups: `backups/drive-first-20261014` within the profile;
old integrations have `.before-drive-first-20261014` copies. Stop the new queue
and clear the cutover flag before restoring native routing. Restore matching
API/runtime versions together. Do not resume the legacy cron or old Vista
ingress against deleted drafts without an explicit migration/recovery plan.
Do not roll back by re-posting or refunding expenses. Drive originals/overlay
in Trash can be restored; cleanup rows have the private exact backup above.
