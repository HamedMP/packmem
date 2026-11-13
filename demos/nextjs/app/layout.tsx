import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "packmem flights",
  description: "336,776 flight records held as packed columns inside a Next.js server",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
