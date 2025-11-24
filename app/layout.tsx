import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AuditIA',
  description: 'Extracción inteligente de formularios administrativos',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="antialiased">{children}</body>
    </html>
  );
}
