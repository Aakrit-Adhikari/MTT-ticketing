# Inventory and booking integrity

## Policy

For every flight departure the agency holds an allocation `total`. Each seat is in **exactly one** state:

| State | Counter | Meaning |
|---|---|---|
| available | *(derived)* | not committed |
| held | `held` | temporary, expiring hold placed by staff |
| confirmed | `confirmed` | staff have secured the seat with the airline |
| ticketed | `ticketed` | ticket issued *(CONFIRMED → TICKETED arrives with the tickets phase)* |
| released / cancelled | *(none)* | seat left its counter and is available again |

```
available = total - held - confirmed - ticketed
```
A seat moves *between* counters (held → confirmed → ticketed) rather than being added to a second one, so it can never be
counted twice. Releasing or cancelling simply removes it from its counter. Infants (lap) do not consume seats.
`total` changes only through audited adjustments (admin, timestamp, reason; before/after recorded).

## A booking inquiry is not a reservation
`INQUIRY` touches no counter. Search and inquiry only *check* availability; staff action is what commits seats.

```
INQUIRY ─hold→ HELD ─confirm→ CONFIRMED ─(tickets phase)→ TICKETED
   │             │                │
   │             ├─ expiry sweep → EXPIRED (seats released)
   └─confirm─────┘                └─cancel→ CANCELLED (seats released)
   └─reject→ REJECTED
```
Confirming a hold that has lapsed first releases it, then re-acquires with a fresh availability check.

## How it is enforced

1. **Atomic guarded UPDATE.** Every move is one SQL statement, e.g.
   `UPDATE "FlightInventory" SET confirmed = confirmed + n WHERE "flightId" = $1 AND total-held-confirmed-ticketed >= n`.
   Concurrent transactions queue on the row lock and PostgreSQL re-evaluates the `WHERE` against the committed value, so two
   requests cannot both take the last seat. Zero rows updated → HTTP 409.
2. **Booking row lock.** Each admin action first does `SELECT … FOR UPDATE` on the booking, serialising double-clicks, two
   staff members, and the expiry sweeper. Confirm/cancel on an already-final state is a no-op (idempotent).
3. **Transaction per action.** A two-leg booking either commits both legs or neither (tested). Multi-flight updates run in
   ascending flight-id order to avoid deadlocks.
4. **Database CHECK constraints** (`held+confirmed+ticketed <= total`, all counters ≥ 0) are the last line of defence even
   if application code is bypassed (tested by direct SQL).
5. **Reductions** below existing commitments are rejected.
6. **Expiry sweeper** runs every 60 s in the backend; per-booking transactions with re-checks make it safe with several
   instances and idempotent.
7. Fares are **snapshotted** onto the booking segment, so later fare edits don't rewrite history.

Public search shows at most `9` seats so the agency's real allocation isn't exposed, and uses Nepal local calendar days
(UTC+05:45, no DST).
