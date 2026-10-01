import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "PR review agent",
  description: "LangGraph.js pull-request reviewer with human approval",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <a href="/">PR review agent</a>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
