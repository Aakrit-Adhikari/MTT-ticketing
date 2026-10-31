import SiteShell from '@/components/SiteShell';

export const metadata = { title: 'Cancellation and refund policy' };

// PLACEHOLDER CONTENT: the agency must replace this with its real, airline-specific terms before launch.
export default function PoliciesPage() {
  return (
    <SiteShell>
      <h1>Cancellation, change and refund policy</h1>
      <p className="notice">
        <b>Agency to complete before go-live.</b> The text below is a neutral outline. It deliberately states no fees, deadlines or
        refund percentages, because these depend on each airline&apos;s fare rules and the agency&apos;s own agreements.
      </p>
      <section className="panel">
        <h2 style={{ marginTop: 0 }}>How bookings work</h2>
        <p>A booking inquiry is a request. A booking becomes confirmed only after our staff confirm the seats with the airline and tell you. Tickets are issued separately.</p>
      </section>
      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Cancellations and changes</h2>
        <p>Contact us with your booking reference to request a cancellation or date change. Eligibility, fees and any fare difference depend on the airline&apos;s fare conditions and are confirmed by our staff before anything is changed.</p>
      </section>
      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Refunds</h2>
        <p>Refund eligibility and amounts depend on the fare rules, what has been paid, and non-refundable components such as some taxes and fees. Approved refunds are processed manually and recorded against your booking.</p>
      </section>
      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Airline-initiated changes</h2>
        <p>If an airline cancels or reschedules a flight, we will contact you with the options available under the airline&apos;s rules.</p>
      </section>
    </SiteShell>
  );
}
