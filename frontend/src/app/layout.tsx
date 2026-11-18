import type { Metadata } from "next";
import "./globals.css";
import { vazirmatn } from "@/lib/fonts";
import { AuthProvider } from "@/lib/auth";
import { LanguageProvider } from "@/lib/i18n";
import KioskWakeWatcher from "@/components/KioskWakeWatcher";

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
        <LanguageProvider>
          <AuthProvider>
            <KioskWakeWatcher />
            {children}
          </AuthProvider>
        </LanguageProvider>
      </body>
    </html>
  );
}
