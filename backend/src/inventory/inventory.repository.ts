import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, SeatState } from '@prisma/client';
import { PrismaService, Tx } from '../database/prisma.service';

/**
 * INVENTORY POLICY (see docs/INVENTORY.md)
 *   available = total - held - confirmed - ticketed
 * A seat sits in exactly one of {held, confirmed, ticketed} or in none (REQUESTED / RELEASED).
 * Moving a seat between counters is ONE atomic UPDATE with its guard in the WHERE clause, so concurrent
 * transactions serialize on the row lock and the guard is re-evaluated against the committed value.
 * The CHECK constraints in the migration are the final backstop.
 */
const COUNTER: Partial<Record<SeatState, string>> = { HELD: 'held', CONFIRMED: 'confirmed', TICKETED: 'ticketed' };

@Injectable()
export class InventoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  get(flightId: string, tx?: Tx) {
    return (tx ?? this.prisma).flightInventory.findUnique({ where: { flightId } });
  }

  create(flightId: string, total: number, tx: Tx) {
    return tx.flightInventory.create({ data: { flightId, total } });
  }

  /**
   * Atomically move `seats` from one state to another. Throws ConflictException if the source counter lacks
   * the seats or (when newly committing seats) availability is insufficient.
   * Callers touching several flights must do so in ascending flightId order to avoid deadlocks.
   */
  async move(tx: Tx, flightId: string, seats: number, from: SeatState, to: SeatState): Promise<void> {
    if (from === to) return;
    const fromCol = COUNTER[from];
    const toCol = COUNTER[to];
    if (!fromCol && !toCol) return;

    const sets: Prisma.Sql[] = [];
    const guards: Prisma.Sql[] = [Prisma.sql`"flightId" = ${flightId}::uuid`];
    if (fromCol) {
      sets.push(Prisma.sql`${Prisma.raw(`"${fromCol}"`)} = ${Prisma.raw(`"${fromCol}"`)} - ${seats}`);
      guards.push(Prisma.sql`${Prisma.raw(`"${fromCol}"`)} >= ${seats}`);
    }
    if (toCol) {
      sets.push(Prisma.sql`${Prisma.raw(`"${toCol}"`)} = ${Prisma.raw(`"${toCol}"`)} + ${seats}`);
      // Newly committing seats (not shuffling between counters) must fit in what is still available.
      if (!fromCol) guards.push(Prisma.sql`total - held - confirmed - ticketed >= ${seats}`);
    }
    sets.push(Prisma.sql`"updatedAt" = now()`);

    const updated = await tx.$executeRaw`UPDATE "FlightInventory" SET ${Prisma.join(sets, ', ')} WHERE ${Prisma.join(guards, ' AND ')}`;
    if (updated !== 1) throw new ConflictException('Insufficient seat inventory for this operation');
  }

  /** Set a new total; refuses to go below existing commitments. Caller supplies tx. */
  async setTotal(tx: Tx, flightId: string, newTotal: number): Promise<void> {
    const updated = await tx.$executeRaw`
      UPDATE "FlightInventory" SET total = ${newTotal}, "updatedAt" = now()
      WHERE "flightId" = ${flightId}::uuid AND held + confirmed + ticketed <= ${newTotal}`;
    if (updated !== 1) throw new ConflictException('Cannot reduce allocation below seats already held, confirmed or ticketed');
  }

  addAdjustment(tx: Tx, data: Prisma.InventoryAdjustmentUncheckedCreateInput) {
    return tx.inventoryAdjustment.create({ data });
  }

  listAdjustments(flightId: string) {
    return this.prisma.inventoryAdjustment.findMany({
      where: { flightId },
      orderBy: { createdAt: 'desc' },
      include: { admin: { select: { email: true } } },
    });
  }
}

export const availableSeats = (i: { total: number; held: number; confirmed: number; ticketed: number }): number =>
  i.total - i.held - i.confirmed - i.ticketed;
