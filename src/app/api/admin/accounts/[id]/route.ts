// ============================================================
// DELETE /api/admin/accounts/[id]  (SUPER ADMIN)
//
// Apaga a conta e TODOS os seus dados (contatos, conversas, mensagens,
// negócios, funis, canais, convites, membros…) via ON DELETE CASCADE do
// account_id. NÃO apaga usuários (auth.users) — antes de deletar, os
// perfis cuja conta ATIVA é esta são repontuados para outra conta de que
// o usuário é membro (ou NULL = sem workspace), evitando o cascade que
// apagaria o profile.
// ============================================================

import { NextResponse } from "next/server";

import { isSuperAdmin } from "@/lib/auth/super-admin";
import { supabaseAdmin } from "@/lib/automations/admin-client";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isSuperAdmin())) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const { id: accountId } = await params;
  const admin = supabaseAdmin();

  const { data: acct } = await admin
    .from("accounts")
    .select("id, name")
    .eq("id", accountId)
    .maybeSingle();
  if (!acct) {
    return NextResponse.json({ error: "Conta não encontrada" }, { status: 404 });
  }

  try {
    // 1) Repontua os perfis cuja conta ativa é esta, para preservar os
    //    usuários (profiles.account_id tem ON DELETE CASCADE). Cada um vai
    //    para outra membership sua, ou fica sem workspace (NULL).
    const { data: affected } = await admin
      .from("profiles")
      .select("user_id")
      .eq("account_id", accountId);

    for (const p of affected ?? []) {
      const userId = p.user_id as string;
      const { data: other } = await admin
        .from("account_members")
        .select("account_id, role")
        .eq("user_id", userId)
        .neq("account_id", accountId)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      await admin
        .from("profiles")
        .update({
          account_id: other?.account_id ?? null,
          account_role: other?.role ?? null,
        })
        .eq("user_id", userId);
    }

    // 2) Apaga a conta — o cascade remove todo o dado do tenant e as
    //    memberships. Usuários (auth.users) permanecem.
    const { error } = await admin.from("accounts").delete().eq("id", accountId);
    if (error) {
      console.error("[admin/accounts DELETE] erro:", error);
      return NextResponse.json(
        { error: "Falha ao excluir a conta" },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[admin/accounts DELETE] erro:", err);
    return NextResponse.json(
      { error: "Falha ao excluir a conta" },
      { status: 500 },
    );
  }
}
