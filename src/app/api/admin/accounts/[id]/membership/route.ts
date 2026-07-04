// ============================================================
// /api/admin/accounts/[id]/membership  (SUPER ADMIN ONLY)
//
//   POST   — o super admin entra na conta (vira membro 'admin') para
//            poder operar dentro dela. Idempotente.
//   DELETE — o super admin sai da conta; se era sua conta ativa,
//            reaponta para outra membership (ou nenhuma).
//
// Membership de super admin é EXCLUÍDA da contagem de membros e do
// limite max_users (ver GET /api/admin/accounts), então entrar numa
// conta de cliente não consome um assento dela.
//
// Portão: isSuperAdmin(). Escrita via service-role (ignora RLS).
// ============================================================

import { NextResponse } from "next/server";

import { isSuperAdmin } from "@/lib/auth/super-admin";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { createClient } from "@/lib/supabase/server";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isSuperAdmin())) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const { id: accountId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = supabaseAdmin();

  const { data: acct } = await admin
    .from("accounts")
    .select("id")
    .eq("id", accountId)
    .maybeSingle();
  if (!acct) {
    return NextResponse.json({ error: "Conta não encontrada" }, { status: 404 });
  }

  // Entra como 'admin' (opera tudo, mas não é dono). Idempotente.
  const { error } = await admin.from("account_members").upsert(
    { account_id: accountId, user_id: user.id, role: "admin" },
    { onConflict: "account_id,user_id", ignoreDuplicates: true },
  );
  if (error) {
    console.error("[admin/membership POST] error:", error);
    return NextResponse.json(
      { error: "Falha ao entrar na conta" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isSuperAdmin())) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const { id: accountId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = supabaseAdmin();

  const { error } = await admin
    .from("account_members")
    .delete()
    .eq("account_id", accountId)
    .eq("user_id", user.id);
  if (error) {
    console.error("[admin/membership DELETE] error:", error);
    return NextResponse.json(
      { error: "Falha ao sair da conta" },
      { status: 500 },
    );
  }

  // Se esta era a conta ativa, reaponta para outra membership do usuário
  // (ou NULL — sem workspace). Espelha remove_account_member.
  const { data: prof } = await admin
    .from("profiles")
    .select("account_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (prof?.account_id === accountId) {
    const { data: remaining } = await admin
      .from("account_members")
      .select("account_id, role")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    await admin
      .from("profiles")
      .update({
        account_id: remaining?.account_id ?? null,
        account_role: remaining?.role ?? null,
      })
      .eq("user_id", user.id);
  }

  return NextResponse.json({ ok: true });
}
