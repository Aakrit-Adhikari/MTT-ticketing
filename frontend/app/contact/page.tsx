import SiteShell from '@/components/SiteShell';

export const metadata = { title: 'Contact us' };

// PLACEHOLDER CONTENT: replace with the agency's real details before launch.
export default function ContactPage() {
  return (
    <SiteShell>
      <h1>Contact and assistance</h1>
      <p className="notice"><b>Agency to complete before go-live:</b> add the real office address, phone numbers, email and opening hours.</p>
      <section className="panel">
        <p>When you contact us, please quote your booking reference (format <code>MT-XXXXX-XXXXX</code>).</p>
        <p>We will never ask for your password or card security code by email or phone.</p>
        <p>To check an existing inquiry, use <a href="/lookup">Find my booking</a>.</p>
      </section>
    </SiteShell>
  );
}
