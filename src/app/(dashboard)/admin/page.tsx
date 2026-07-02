import { redirect } from "next/navigation";

import { isSuperAdmin } from "@/lib/auth/super-admin";
import { AdminAccountsClient } from "@/components/admin/admin-accounts-client";

// Painel de Super Admin. Server component: o portão roda no servidor
// (isSuperAdmin lê o cookie + profiles.is_super_admin). Quem não for
// super admin nunca chega a ver a tabela — vai direto para /dashboard.
export default async function AdminPage() {
  if (!(await isSuperAdmin())) {
    redirect("/dashboard");
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-foreground">Super Admin</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Todas as contas do sistema. Ajuste os limites de canais e usuários.
        </p>
      </div>
      <AdminAccountsClient />
    </div>
  );
}
