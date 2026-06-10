import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bit-Forge Edge Intelligence",
  description: "Industrial Edge AI factory dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
