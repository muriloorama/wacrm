// ============================================================
// Super Admin — guarda server-side
//
// Super admin é uma flag GLOBAL (profiles.is_super_admin), acima do
// modelo de contas/roles. Quem tem TRUE enxerga o painel /admin e pode
// mexer nos limites de QUALQUER conta via /api/admin/*.
//
// A leitura usa o cliente ligado ao cookie do usuário (createClient de
// @/lib/supabase/server) — RLS deixa cada um ler o PRÓPRIO profile, que
// é tudo o que precisamos aqui. Nada de service-role neste helper: ele
// só responde "o usuário logado é super admin?".
// ============================================================

import { createClient } from "@/lib/supabase/server";

/**
 * Retorna true se houver um usuário logado E o profile dele tiver
 * `is_super_admin = true`. Qualquer outra situação (sem sessão, sem
 * profile, erro de leitura, flag false) retorna false — falha fechada.
 */
export async function isSuperAdmin(): Promise<boolean> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;

  const { data, error } = await supabase
    .from("profiles")
    .select("is_super_admin")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error || !data) return false;
  return data.is_super_admin === true;
}
