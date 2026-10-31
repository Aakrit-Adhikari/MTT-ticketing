import { bookingApproved, inquiryReceived } from './templates';

const b = {
  id: 'x', reference: 'MT-AAAAA-BBBBB', contactName: 'Sita', contactEmail: 's@example.com', pnr: null,
  segments: [{ direction: 'OUTBOUND', flight: { flightNumber: 'RA 101', airline: { name: 'Nepal Airlines' }, origin: { city: 'Kathmandu' }, destination: { city: 'Pokhara' }, departureAt: new Date('2030-01-01T05:00:00Z') } }],
  passengers: [{ firstName: 'Sita', lastName: 'Sharma', ticketNumber: null }, { firstName: 'Ram', lastName: 'Sharma', ticketNumber: null }, { firstName: 'Mini', lastName: 'Sharma', ticketNumber: null }],
};

describe('customer emails', () => {
  it('state how many people are travelling and who', () => {
    for (const mail of [inquiryReceived(b, 'https://x.test'), bookingApproved(b, 'https://x.test')]) {
      expect(mail.text).toContain('Passengers (3): Sita Sharma, Ram Sharma, Mini Sharma');
    }
  });
  it('put the reference in the inquiry email and say it is not a booking yet', () => {
    const t = inquiryReceived(b, 'https://x.test').text;
    expect(t).toContain('MT-AAAAA-BBBBB');
    expect(t).toContain('NOT a confirmed booking');
  });
});
