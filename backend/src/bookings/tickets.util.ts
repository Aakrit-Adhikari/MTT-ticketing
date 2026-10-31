import { BadRequestException } from '@nestjs/common';

/** Every passenger needs exactly one ticket number, and no two may be equal. Throws 400 otherwise. */
export function assertTicketLines(passengerIds: string[], tickets: { passengerId: string; ticketNumber: string }[]): void {
  const known = new Set(passengerIds);
  const given = new Set(tickets.map((t) => t.passengerId));
  const numbers = new Set(tickets.map((t) => t.ticketNumber.toUpperCase()));
  if (given.size !== tickets.length || given.size !== known.size || [...given].some((x) => !known.has(x))) {
    throw new BadRequestException('Enter exactly one ticket number for every passenger');
  }
  if (numbers.size !== tickets.length) throw new BadRequestException('Ticket numbers must be different for each passenger');
}
