import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  // Users may still pinch-zoom; only auto-zoom on input focus is suppressed.
  userScalable: true,
  themeColor: "#070a12",
};

export const metadata: Metadata = {
  title: "DYNAMIC ENGINE — Market Structure & Options Intelligence",
  description:
    "Real-time dynamic support/resistance, market structure, options chain, Greeks, strike selection and intraday trade intelligence for NIFTY 50 and SENSEX.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
