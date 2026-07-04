"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Clock } from "lucide-react";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { isModuleEnabled } from "@/lib/modules";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { user, loading, profileLoading, accountId, account, signOut } =
    useAuth();
  const router = useRouter();
  const pathname = usePathname();

  // Guard de módulo: se a conta ativa tem o módulo desabilitado e o usuário
  // acessa a rota direto pela URL, redireciona para o Painel. A sidebar já
  // esconde o link; isto fecha o acesso por URL. O gate é pela CONTA ATIVA
  // (um super admin operando dentro de uma conta restrita também respeita a
  // restrição dela). Espera o perfil resolver para não redirecionar durante
  // o carregamento (quando enabled_modules ainda não chegou).
  useEffect(() => {
    if (profileLoading || !account) return;
    if (isModuleEnabled(pathname, account.enabled_modules)) return;
    router.replace("/dashboard");
  }, [pathname, account, profileLoading, router]);

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Carregando...</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  // Sem workspace: o usuário tem login mas não é membro de nenhuma conta
  // (signup é invite-only; o acesso só existe após ser atrelado a uma
  // conta por convite ou pelo super admin). Mostra uma tela de espera em
  // vez do dashboard vazio/quebrado. Espera o perfil resolver para não
  // piscar isso durante o carregamento.
  if (!profileLoading && !accountId) {
    return (
      <div className="flex h-screen items-center justify-center bg-background p-6">
        <div className="flex max-w-sm flex-col items-center gap-4 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Clock className="size-6" />
          </div>
          <h1 className="text-lg font-semibold text-foreground">
            Aguardando acesso
          </h1>
          <p className="text-sm text-muted-foreground">
            Sua conta ainda não está vinculada a nenhum workspace. Peça um
            convite ao administrador — assim que você for adicionado, o acesso
            aparece aqui.
          </p>
          <button
            type="button"
            onClick={signOut}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Sair
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless — renders nothing. */}
      <PresenceHeartbeat />
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onOpenSidebar={() => setSidebarOpen(true)} />
        {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
