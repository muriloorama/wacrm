// ============================================================
// GET /api/account/members
//
// Lists every member of the caller's account. Any member can call
// it (the Members tab is shown to admins+, but agents/viewers see
// a read-only roster too).
//
// Field visibility
//   Sensitive fields (email) are returned only when the caller is
//   admin+. Agents and viewers see name + avatar + role + joined
//   date only. This mirrors the design decision from the planning
//   phase: "agent/viewer sees names only".
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { canManageMembers, isAccountRole } from "@/lib/auth/roles";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import type { AccountMember } from "@/types";

interface MemberRow {
  user_id: string;
  role: string;
  created_at: string;
  is_attendant: boolean;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    // Fonte de verdade da associação é account_members (pós-multi-conta).
    // A RLS de account_members só devolve linhas de contas de que o caller
    // é membro, então isto já é escopado pela conta ativa do caller.
    const { data: memberRows, error } = await ctx.supabase
      .from("account_members")
      .select("user_id, role, created_at, is_attendant")
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[GET /api/account/members] fetch error:", error);
      return NextResponse.json(
        { error: "Failed to load members" },
        { status: 500 },
      );
    }

    const rows = (memberRows ?? []) as MemberRow[];

    // Dados de exibição (nome/email/avatar) vivem em profiles, cujo
    // account_id é a conta ATIVA do membro — que pode diferir desta. Um
    // co-membro com outra conta ativa não seria legível via RLS de
    // profiles, então buscamos os campos de exibição pelo admin client,
    // restrito exatamente aos user_ids já autorizados acima.
    const userIds = rows.map((r) => r.user_id);
    const profilesById = new Map<
      string,
      { full_name: string | null; email: string | null; avatar_url: string | null }
    >();
    if (userIds.length > 0) {
      const { data: profileRows, error: profErr } = await supabaseAdmin()
        .from("profiles")
        .select("user_id, full_name, email, avatar_url")
        .in("user_id", userIds);
      if (profErr) {
        console.error("[GET /api/account/members] profiles fetch error:", profErr);
      } else {
        for (const p of profileRows ?? []) {
          profilesById.set(p.user_id as string, {
            full_name: (p.full_name as string) ?? null,
            email: (p.email as string) ?? null,
            avatar_url: (p.avatar_url as string) ?? null,
          });
        }
      }
    }

    const canSeeEmails = canManageMembers(ctx.role);

    const members: AccountMember[] = rows.flatMap((row) => {
      // Defensive: skip rows whose role the TS union doesn't recognize.
      if (!isAccountRole(row.role)) return [];
      const p = profilesById.get(row.user_id);
      return [
        {
          user_id: row.user_id,
          full_name: p?.full_name ?? "",
          email: canSeeEmails ? (p?.email ?? null) : null,
          avatar_url: p?.avatar_url ?? null,
          role: row.role,
          joined_at: row.created_at,
          is_attendant: row.is_attendant !== false,
        },
      ];
    });

    return NextResponse.json({ members });
  } catch (err) {
    return toErrorResponse(err);
  }
}
