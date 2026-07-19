import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FrameLock — Verified Generative Reshoots",
  description:
    "Generate the world outside a protected subject, then verify its canonical pre-encode frame sequence.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
