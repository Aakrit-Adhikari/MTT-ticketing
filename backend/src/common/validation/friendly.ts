import { BadRequestException } from '@nestjs/common';
import { ValidationError } from 'class-validator';

/** What a person sees for a field, instead of the property name in the code. */
const LABEL: Record<string, string> = {
  contactName: 'Contact name', contactEmail: 'Email address', contactPhone: 'Phone number', notes: 'Notes', email: 'Email address', password: 'Password',
  firstName: 'First name', lastName: 'Last name', dateOfBirth: 'Date of birth', documentNumber: 'Passport number', nationality: 'Nationality',
  documentExpiry: 'Passport expiry date', requestedDate: 'Travel date', requestedReturnDate: 'Return date', preferredDate: 'Preferred date',
  tripType: 'Trip type', outboundFlightId: 'Going flight', returnFlightId: 'Return flight', flightNumber: 'Flight number', airlineId: 'Airline',
  originId: 'Departure airport', destinationId: 'Arrival airport', sectorId: 'Sector', departureAt: 'Departure time', arrivalAt: 'Arrival time',
  adultFare: 'Adult fare', childFare: 'Child fare', seatsAllocated: 'Seats allocated', delta: 'Seat change', reason: 'Reason', pnr: 'PNR',
  ticketNumber: 'Ticket number', message: 'Message', minutes: 'Hold minutes', amount: 'Amount', method: 'Payment method', reference: 'Reference',
  name: 'Name', code: 'Code', iata: 'Airport code', city: 'City', role: 'Role', note: 'Note', refundAmount: 'Refund amount', status: 'Status',
  month: 'Month', q: 'Search text', page: 'Page', newFlightId: 'New flight', direction: 'Leg',
};
/** Collections whose items are numbered in the message ("Passenger 2: ..."). */
const ITEM: Record<string, string> = { passengers: 'Passenger', tickets: 'Ticket', changes: 'Change', retimes: 'Time change' };

/** Fields that use a pattern: the default message ("must match /regex/") means nothing to a person, so say what is allowed. */
const PATTERN: Record<string, string> = {
  contactName: 'can only contain letters, spaces and the characters . \' - (no digits or symbols)',
  firstName: 'can only contain letters, spaces and the characters . \' - (no digits or symbols)',
  lastName: 'can only contain letters, spaces and the characters . \' - (no digits or symbols)',
  nationality: 'can only contain letters and spaces (for example Nepal or India)',
  name: 'can only contain letters, spaces and the characters . \' - (no digits or symbols)',
  contactPhone: 'should be digits only, optionally starting with + (for example +977 9812345678)',
  documentNumber: 'should be 5 to 20 letters or digits, with no spaces or dashes',
  pnr: 'should be 5 to 8 letters or digits',
  ticketNumber: 'should be 6 to 20 letters, digits or dashes',
  flightNumber: 'does not look right (for example RA 301)',
  adultFare: 'should be an amount like 5500 or 5500.50',
  childFare: 'should be an amount like 3500 or 3500.50',
  refundAmount: 'should be an amount like 1500 or 1500.50',
  amount: 'should be an amount like 1500 or 1500.50',
  month: 'should look like 2026-11',
};
const DATE_FIELDS = new Set(['dateOfBirth', 'documentExpiry', 'requestedDate', 'requestedReturnDate', 'preferredDate', 'flightFrom', 'flightTo', 'flyFrom', 'flyTo', 'from', 'to']);

const humanize = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
const label = (key: string) => LABEL[key] ?? humanize(key);

/** One sentence per failed rule, in plain language. */
function sentence(property: string, rule: string, raw: string): string {
  const who = label(property);
  const num = raw.match(/(\d+)\s*(?:characters|elements)?\s*$/)?.[1] ?? raw.match(/(?:longer than or equal to|shorter than or equal to|not be (?:less|greater) than|least|most)\s+(\d+)/)?.[1];
  switch (rule) {
    case 'isNotEmpty': return `${who} is required.`;
    case 'isEmail': return `${who} is not a valid email address (for example name@example.com).`;
    case 'minLength': return num === '1' ? `${who} is required.` : `${who} is too short${num ? ` (at least ${num} characters)` : ''}.`;
    case 'maxLength': return `${who} is too long${num ? ` (at most ${num} characters)` : ''}.`;
    case 'isUuid': return `${who} was not chosen correctly. Please choose it from the list.`;
    case 'isEnum': case 'isIn': return `${who} has a value that is not allowed. Please choose one of the listed options.`;
    case 'isInt': case 'isNumber': return `${who} must be a whole number.`;
    case 'min': return `${who} is too small${num ? ` (minimum ${num})` : ''}.`;
    case 'max': return `${who} is too big${num ? ` (maximum ${num})` : ''}.`;
    case 'arrayMinSize': return `${who} needs at least ${num ?? '1'} entr${num === '1' || !num ? 'y' : 'ies'}.`;
    case 'arrayMaxSize': return `${who} has too many entries${num ? ` (at most ${num})` : ''}.`;
    case 'isDateString': return `${who} is not a valid date and time.`;
    case 'isString': return `${who} must be text.`;
    case 'isArray': return `${who} must be a list.`;
    case 'whitelistValidation': return `"${property}" is not something this form accepts.`;
    case 'matches':
      if (DATE_FIELDS.has(property)) return `${who} should be a date in the form 2026-11-30.`;
      return PATTERN[property] ? `${who} ${PATTERN[property]}.` : `${who} is not in the expected format.`;
    default:
      // A message written by hand in the DTO (e.g. "pnr must be 5-8 letters or digits") is already readable.
      return raw.charAt(0).toUpperCase() + raw.slice(1) + (/[.!?]$/.test(raw) ? '' : '.');
  }
}

function collect(errors: ValidationError[], prefix: string, out: string[]): void {
  for (const e of errors) {
    if (e.constraints) {
      // An empty value fails several rules at once (required, too short, wrong format). One clear sentence is enough.
      if ((e.value === '' || e.value === undefined || e.value === null) && (e.constraints.minLength || e.constraints.isNotEmpty || e.constraints.matches || e.constraints.isString)) {
        out.push(prefix ? `${prefix}: ${label(e.property)} is required.` : `${label(e.property)} is required.`);
        continue;
      }
      for (const [rule, raw] of Object.entries(e.constraints)) {
        // class-validator's default messages start with the property name; anything else was written on purpose.
        const custom = !raw.startsWith(e.property) && rule !== 'whitelistValidation';
        const text = custom ? raw.charAt(0).toUpperCase() + raw.slice(1) + (/[.!?]$/.test(raw) ? '' : '.') : sentence(e.property, rule, raw);
        out.push(prefix ? `${prefix}: ${text}` : text);
      }
    }
    if (e.children?.length) {
      const item = ITEM[e.property];
      for (const child of e.children) {
        if (/^\d+$/.test(child.property)) collect(child.children ?? [], `${item ?? humanize(e.property)} ${Number(child.property) + 1}`, out);
        else collect([child], prefix, out);
      }
    }
  }
}

/** Used as ValidationPipe's exceptionFactory: turns technical rule failures into sentences a person can act on. */
export function friendlyValidation(errors: ValidationError[]): BadRequestException {
  const messages: string[] = [];
  collect(errors, '', messages);
  const unique = [...new Set(messages)];
  return new BadRequestException(unique.length ? unique : ['Some of the details are not valid. Please check the form and try again.']);
}
