import "./globals.css";

export const metadata = {
  title: "PharmIQ — Pharma R&D Intelligence Platform",
  description: "AI-powered natural language queries across FDA, ChEMBL, and global patent datasets for pharmaceutical R&D teams.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
