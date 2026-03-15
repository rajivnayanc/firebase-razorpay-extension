import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Razorpay Extension Test App",
  description: "Sample app for testing the Razorpay Firebase Extension",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
