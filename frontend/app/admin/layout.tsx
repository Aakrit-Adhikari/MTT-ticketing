import AuthProvider from '@/components/AuthProvider';

export const metadata = { title: 'Back office', robots: { index: false, follow: false } };

export default function AdminRoot({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
