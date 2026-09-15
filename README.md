# api-vista

Fastify + Postgres backend for Vista. This round covers the **money path** only:
authentication, the catalogue bootstrap, shift open/close, checkout, and paid-sale corrections.

Expenses, the cashflow ledger reporting, partner settlement and period closure are not built yet.

## Running it

```bash
npm install
npm run db:up          # Postgres 16 in Docker, bound to 127.0.0.1:5432
cp .env.example .env
npx prisma migrate dev
npm run seed
npm run dev            # http://127.0.0.1:3000
npm run check          # oxlint + tsc + vitest
```

Demo credentials come from the seed: `demo@vistahub.my` / `vista`, counter PIN `1234`.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/healthz` | `SELECT 1` against the pool |
| `POST` | `/auth/login` | email + password → JWT (12h) |
| `GET` | `/bootstrap` | account, brands, categories, products with modifiers — what the tablet caches for offline use |
| `POST` | `/shifts/open` | PIN; resolves the business date; refuses if one is already open |
| `POST` | `/shifts/:id/close` | PIN; aggregates takings server-side; records the variance |
| `POST` | `/checkout` | Idempotent. The money path. |
| `POST` | `/corrections` | Idempotent cancel or exchange against an immutable paid sale. |

## The rules this service enforces

**Money is integer sen, everywhere.** Not because Postgres `numeric` is inexact — it isn't — but
because it stops being exact the moment Node reads it.

**The server prices every online checkout.** The request carries product ids, quantities,
modifier ids and discounts; everything payable is read from the catalogue. Offline sync also
carries the cached price snapshot already charged. The server validates that snapshot's
arithmetic, books the money that actually moved, and stores its current-menu computation beside
it. An incoherent snapshot aborts with `checkout:OFFLINE_TOTAL_MISMATCH`.

**A replayed sale is not a second sale.** Every checkout carries a `client_txn_id` minted once on
the device and reused across retries, behind a unique constraint. A double tap, a retry after a
timeout, or an offline sale flushed hours later all return the *original* order.

**Paid sales are corrected, never rewritten.** `POST /corrections` locks the original order,
rebuilds its outstanding value from the sale plus prior corrections, and computes the new
per-brand split server-side. A cancel writes `MONEY_OUT / REFUND`; an exchange writes the exact
positive and negative brand entries needed. The client-provided delta is only a consistency
check. The endpoint has its own idempotency key, so a retried refund cannot be posted twice.

**Checkout and shift close take the same row lock.** Without it, a sale committing while a shift
closes lands in a closed shift and sits outside its totals — real money missing from the books.
Both do `SELECT … FOR UPDATE` on the shift, so they serialise.

**Queue numbers cannot collide.** `UPDATE … RETURNING` takes the lock itself, so there is no
read-then-increment gap. A rolled-back checkout leaves no hole.

**An offline sale is never dropped and never silently repriced.** A tablet that priced from a
cached menu cannot be blamed for a later price change. The amount charged is the revenue booked;
the current menu price is retained separately so divergence stays reportable. A sale that syncs
after its shift closed is also accepted, and flips that shift back to `UNRECONCILED` so the owner
sees its totals moved. Refusing would destroy a sale where money was already collected.

**Every discount lands on a brand.** Line discounts belong to their own line. The order-wide
discount is apportioned across brands first, then across the lines within each brand, both by
largest remainder — so the parts sum to the whole exactly, no brand can be pushed negative, and
the per-brand totals agree with what the POS displayed. Partner settlement depends on this.

**Shift close takes only the PIN and never touches the ledger.** The cashier declares no bank
figure — they cannot see the account. The server records its own takings (revenue less refunds,
net of discounts). Checking that against the bank is the owner's job in the RMS: a gap is closed
with Adjust Balance, which writes one `RECONCILIATION_ADJUSTMENT` entry. A sale or correction
that syncs after close updates the stored takings and marks the shift `UNRECONCILED`, meaning
*changed after close*.

**Tests use their own database.** `npm test` runs against `<database>_test` (created, migrated
and seeded by `test/global-setup.ts`), because the suite wipes orders, shifts and the ledger
before every test. The development database — and whatever you are trying out by hand in the
POS or RMS — is never touched.

**The database enforces the arithmetic.** `orders_total_adds_up` and `order_items_net_non_negative`
are CHECK constraints, not application conventions — a bug in the checkout transaction fails the
insert rather than writing a wrong number. There is also a partial unique index allowing at most
one `OPEN` shift.

## Schema notes

Brands and categories are **tables**, not enums. Brand is a financial dimension — partner profit
share and overhead allocation both key off it — so a rename or a third brand must never be a code
change. "Shared" is the *absence* of a brand (`brand_id IS NULL`), not an enum member.

Order lines and their modifiers are **snapshots**, written once and never updated, so editing the
catalogue cannot rewrite what an old sale reported.

**Prisma Migrate owns the schema.** Never hand-apply DDL. The predecessor project kept a Prisma
schema as documentation alongside manual SQL and the two silently drifted apart. Raw SQL appears
only inside migrations (for constraints Prisma cannot express) and inside transactions (for the
row locks it cannot express).

## Tests

```bash
npm test
```

51 tests. The ones worth knowing about: idempotent sale and correction replay, both sequentially and concurrently,
eight simultaneous checkouts producing eight distinct sequential queue numbers, an under-claimed
total being rejected online, a coherent charged snapshot being preserved offline, a sale syncing into a closed shift,
sequential exchange-then-cancel refunding only the outstanding amount, same-price exchanges moving
brand attribution, corrections flowing into shift close, the one-open-shift constraint holding
when the route is bypassed entirely, and the business date
rolling at 5am rather than midnight across month and year boundaries.

`test/money-vectors.test.ts` runs against `../money-vectors.json`, shared with the POS. Because
the POS sells offline, the cart arithmetic exists in both places; that fixture is what makes the
two disagree loudly instead of silently.
