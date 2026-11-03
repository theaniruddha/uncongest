import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Uncongest — Less stress between A and B",
  description: "Web-first AI roadside stop recommendations for groups of 1–3 cars. Works offline with clearly labeled simulated data."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
