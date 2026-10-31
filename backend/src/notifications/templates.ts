import { routeWords } from '../flights/route.util';
import { OutgoingEmail } from './notifications.module';

export interface MailBooking {
  id: string;
  reference: string;
  contactName: string;
  contactEmail: string;
  pnr: string | null;
  segments: { direction: string; flight: { flightNumber: string; airline: { name: string }; origin?: { city: string } | null; destination?: { city: string } | null; sector?: { name: string } | null; departureAt: Date } }[];
  passengers: { firstName: string; lastName: string; ticketNumber: string | null }[];
}

const when = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', dateStyle: 'medium', timeStyle: 'short' }).format(d) + ' (Nepal time)';
const trip = (b: MailBooking) =>
  b.segments
    .map((s) => `  ${s.direction === 'OUTBOUND' ? 'Outbound' : 'Return'}: ${s.flight.airline.name} ${s.flight.flightNumber}, ${routeWords(s.flight)}, departs ${when(s.flight.departureAt)}`)
    .join('\n');
const people = (b: MailBooking) => `Passengers (${b.passengers.length}): ${b.passengers.map((p) => `${p.firstName} ${p.lastName}`).join(', ')}`;
const footer = (site: string) =>
  `\nCheck your booking status any time: ${site}/lookup\n(you will need your reference and this email address)\n\nWe will never ask for your password or card details by email.`;

export function inquiryReceived(b: MailBooking, site: string): OutgoingEmail {
  return {
    bookingId: b.id,
    to: b.contactEmail,
    template: 'inquiry_received',
    subject: `Booking inquiry received - ${b.reference}`,
    text: `Dear ${b.contactName},\n\nWe have received your booking inquiry.\n\nYOUR BOOKING REFERENCE: ${b.reference}\nStatus: PENDING\n\n${trip(b)}\n${people(b)}\n\nThis is NOT a confirmed booking or a ticket. Our staff will check availability with the airline and contact you.${footer(site)}`,
  };
}

export function bookingApproved(b: MailBooking, site: string): OutgoingEmail {
  return {
    bookingId: b.id,
    to: b.contactEmail,
    template: 'booking_approved',
    subject: `Booking approved - ${b.reference}`,
    text: `Dear ${b.contactName},\n\nGood news: your booking ${b.reference} has been APPROVED. Your seats are confirmed.\n\n${trip(b)}\n${people(b)}\n\nYour ticket details will be emailed to you as soon as the ticket is issued.${footer(site)}`,
  };
}

export function ticketIssued(b: MailBooking, site: string): OutgoingEmail {
  const pax = b.passengers.map((p) => `  ${p.firstName} ${p.lastName}: ticket ${p.ticketNumber ?? '-'}`).join('\n');
  return {
    bookingId: b.id,
    to: b.contactEmail,
    template: 'ticket_issued',
    subject: `Your ticket - ${b.reference}`,
    text: `Dear ${b.contactName},\n\nYour ticket has been issued.\n\nBooking reference: ${b.reference}\nAirline reservation code (PNR): ${b.pnr}\n\n${trip(b)}\n\nPassengers and ticket numbers:\n${pax}\n\nPlease carry a valid photo ID / travel document to the airport.${footer(site)}`,
  };
}

export function bookingClosed(b: MailBooking, kind: 'CANCELLED' | 'REJECTED', site: string): OutgoingEmail {
  return {
    bookingId: b.id,
    to: b.contactEmail,
    template: kind === 'CANCELLED' ? 'booking_cancelled' : 'booking_declined',
    subject: kind === 'CANCELLED' ? `Booking cancelled - ${b.reference}` : `Booking inquiry could not be accepted - ${b.reference}`,
    text: `Dear ${b.contactName},\n\n${kind === 'CANCELLED' ? `Your booking ${b.reference} has been cancelled.` : `We were unable to accept your inquiry ${b.reference}.`} Please contact us if you have questions.\n\n${trip(b)}${footer(site)}`,
  };
}

const typeLabel = (t: 'CANCEL_REFUND' | 'RESCHEDULE') => (t === 'CANCEL_REFUND' ? 'cancellation / refund' : 'date change');

export function requestAckToCustomer(b: MailBooking, type: 'CANCEL_REFUND' | 'RESCHEDULE', site: string): OutgoingEmail {
  return {
    bookingId: b.id, to: b.contactEmail, template: 'request_received', subject: `We received your ${typeLabel(type)} request - ${b.reference}`,
    text: `Dear ${b.contactName},\n\nWe have received your ${typeLabel(type)} request for booking ${b.reference}. ${type === 'CANCEL_REFUND' ? 'Our team will contact you about your refund after reviewing your request. Any refund depends on the airline\'s fare rules.' : 'Our staff will review it and contact you.'} ${type === 'CANCEL_REFUND' ? '' : 'A date change depends on seat availability and the airline\'s rules.'}\n\nYour booking is unchanged until our staff confirm.${footer(site)}`,
  };
}

export function requestAlertToStaff(b: MailBooking, to: string, type: 'CANCEL_REFUND' | 'RESCHEDULE', message: string, preferredDate: string | null, site: string): OutgoingEmail {
  return {
    bookingId: b.id, to, template: 'request_staff_alert', subject: `[Action needed] ${typeLabel(type)} request - ${b.reference}`,
    text: `A customer has requested a ${typeLabel(type)}.\n\nBooking: ${b.reference}\nCustomer: ${b.contactName} (${b.contactEmail})\n${preferredDate ? `Preferred new date: ${preferredDate}\n` : ''}\nMessage from customer:\n${message}\n\nOpen in the back office: ${site}/admin/requests`,
  };
}

export function requestResolved(b: MailBooking, type: 'CANCEL_REFUND' | 'RESCHEDULE', outcome: 'DONE' | 'REJECTED', note: string | null, refund: string | null, site: string): OutgoingEmail {
  const head = outcome === 'DONE' ? `Your ${typeLabel(type)} request for booking ${b.reference} has been processed.` : `We could not approve your ${typeLabel(type)} request for booking ${b.reference}.`;
  return {
    bookingId: b.id, to: b.contactEmail, template: 'request_resolved', subject: `Update on your ${typeLabel(type)} request - ${b.reference}`,
    text: `Dear ${b.contactName},\n\n${head}\n${refund ? `\nRefund amount: NPR ${refund}\n` : ''}${note ? `\nMessage from our staff:\n${note}\n` : ''}${footer(site)}`,
  };
}

export function bookingRescheduled(b: MailBooking, site: string, ticketsChanged: boolean): OutgoingEmail {
  const pax = b.passengers.map((p) => `  ${p.firstName} ${p.lastName}: ticket ${p.ticketNumber ?? '-'}`).join('\n');
  return {
    bookingId: b.id, to: b.contactEmail, template: 'booking_rescheduled', subject: `Your booking was rescheduled - ${b.reference}`,
    text: `Dear ${b.contactName},\n\nYour booking ${b.reference} has been rescheduled. Your NEW itinerary:\n\n${trip(b)}\n${ticketsChanged ? `\nUpdated airline reservation code (PNR): ${b.pnr}\n${pax}\n` : ''}${footer(site)}`,
  };
}

interface MoneyArgs { receipt: string; amount: string; method: string; balance: string; at: Date }
const methodLabel = (m: string) => m.replace('_', ' ').toLowerCase();

export function paymentReceived(b: MailBooking, a: MoneyArgs, site: string): OutgoingEmail {
  return {
    bookingId: b.id, to: b.contactEmail, template: 'payment_received', subject: `Payment received - receipt ${a.receipt}`,
    text: `Dear ${b.contactName},\n\nWe have received your payment.\n\nReceipt number: ${a.receipt}\nBooking reference: ${b.reference}\nAmount: NPR ${a.amount}\nMethod: ${methodLabel(a.method)}\nDate: ${when(a.at)}\n${Number(a.balance) > 0 ? `Balance still to pay: NPR ${a.balance}\n` : 'Your booking is fully paid.\n'}${footer(site)}`,
  };
}

export function refundRecorded(b: MailBooking, a: MoneyArgs, site: string): OutgoingEmail {
  return {
    bookingId: b.id, to: b.contactEmail, template: 'refund_recorded', subject: `Refund recorded - ${a.receipt}`,
    text: `Dear ${b.contactName},\n\nA refund has been recorded for booking ${b.reference}.\n\nReference: ${a.receipt}\nAmount: NPR ${a.amount}\nMethod: ${methodLabel(a.method)}\nDate: ${when(a.at)}${footer(site)}`,
  };
}
