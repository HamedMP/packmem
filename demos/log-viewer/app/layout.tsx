import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "packmem log viewer",
  description: "A million log records sent to the browser as packmem bytes, next to the same rows as JSON",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
