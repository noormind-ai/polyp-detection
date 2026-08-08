import type { Metadata } from "next";
import "./globals.css";
import { vazirmatn } from "@/lib/fonts";
import { LanguageProvider } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Polyp Detection AI",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fa" dir="rtl" className={vazirmatn.variable}>
      <body className={vazirmatn.className}>
        <LanguageProvider>{children}</LanguageProvider>
      </body>
    </html>
  );
}
