import type { Metadata } from "next";
import type { ReactNode } from "react";

// Shared metadata for auth pages (login / signup / forgot-password).
// None of these should be indexed — they'd compete with the marketing
// landing in SERPs and offer nothing to a searcher who hasn't already
// signed up. Each page still gets its own <title> via its own
// metadata.title override below the route group layout.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10">
      {/* Fundo decorativo — brilho da marca (aplica a todas as telas de auth). */}
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-24 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-primary/25 blur-[130px]" />
        <div className="absolute -bottom-24 right-[5%] h-[360px] w-[360px] rounded-full bg-blue-500/15 blur-[120px]" />
        <div className="absolute inset-0 bg-gradient-to-b from-background/0 via-background/40 to-background" />
      </div>
      {children}
    </div>
  );
}
