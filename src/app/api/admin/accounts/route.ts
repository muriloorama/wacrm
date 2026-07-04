// ============================================================
// /api/admin/accounts  (SUPER ADMIN ONLY)
//
//   GET   — lista TODAS as contas com owner/e-mail, contagem de
//           membros e canais usados, e os limites configurados.
//   PATCH — atualiza max_channels / max_users de UMA conta.
//
// Toda leitura/gravação usa o cliente service-role (supabaseAdmin),
// que ignora RLS e enxerga todas as contas. O portão de segurança é o
// helper isSuperAdmin() — sem ele, 403. Nunca confie no cliente.
// ============================================================

import { NextResponse } from "next/server";

import { isSuperAdmin } from "@/lib/auth/super-admin";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { createClient } from "@/lib/supabase/server";

interface AdminAccountRow {
  id: string;
  name: string;
  ownerEmail: string | null;
  members: number;
  channels: number;
  max_channels: number;
  max_users: number;
  created_at: string | null;
  /** Se o super admin logado já é membro desta conta (mostra Entrar/Sair). */
  isMember: boolean;
}

// Monta o mapa user_id -> e-mail lendo auth.users em páginas. A API de
// admin do Supabase pagina (default 50/página); percorremos até esvaziar.
async function buildEmailMap(): Promise<Map<string, string>> {
  const admin = supabaseAdmin();
  const map = new Map<string, string>();
  const perPage = 1000;
  let page = 1;

  // Teto de segurança para não girar para sempre se a API mudar de
  // contrato — 100 páginas * 1000 = 100k usuários, muito além do real.
  for (let i = 0; i < 100; i++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = data?.users ?? [];
    for (const u of users) {
      if (u.email) map.set(u.id, u.email);
    }
    if (users.length < perPage) break;
    page += 1;
  }
  return map;
}

export async function GET() {
  if (!(await isSuperAdmin())) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  // Quem está chamando — para marcar em quais contas o super admin já é
  // membro (botão Entrar vs Sair). Lê o próprio usuário via cookie.
  const cookieClient = await createClient();
  const {
    data: { user: caller },
  } = await cookieClient.auth.getUser();

  try {
    const admin = supabaseAdmin();

    const [accountsRes, membersRes, superRes, channelsRes, emailMap] =
      await Promise.all([
        admin
          .from("accounts")
          .select("id, name, owner_user_id, max_channels, max_users, created_at")
          .order("created_at", { ascending: true }),
        // Associação real: account_members (pós multi-conta). Traz user_id
        // para excluir super admins da contagem e marcar isMember do caller.
        admin.from("account_members").select("account_id, user_id"),
        // Ids de super admin — memberships deles não contam como assento.
        admin.from("profiles").select("user_id").eq("is_super_admin", true),
        // Todos os canais WhatsApp: contamos por account_id em memória.
        admin.from("whatsapp_channels").select("account_id"),
        buildEmailMap(),
      ]);

    if (accountsRes.error) throw accountsRes.error;
    if (membersRes.error) throw membersRes.error;
    if (superRes.error) throw superRes.error;
    if (channelsRes.error) throw channelsRes.error;

    const superAdminIds = new Set(
      (superRes.data ?? []).map((r) => (r as { user_id: string }).user_id),
    );

    const memberCounts = new Map<string, number>();
    const callerAccounts = new Set<string>();
    for (const row of membersRes.data ?? []) {
      const r = row as { account_id: string | null; user_id: string };
      if (!r.account_id) continue;
      // Super admins não consomem assento — fora da contagem.
      if (!superAdminIds.has(r.user_id)) {
        memberCounts.set(r.account_id, (memberCounts.get(r.account_id) ?? 0) + 1);
      }
      if (caller && r.user_id === caller.id) callerAccounts.add(r.account_id);
    }

    const channelCounts = new Map<string, number>();
    for (const row of channelsRes.data ?? []) {
      const id = (row as { account_id: string | null }).account_id;
      if (id) channelCounts.set(id, (channelCounts.get(id) ?? 0) + 1);
    }

    const accounts: AdminAccountRow[] = (accountsRes.data ?? []).map((a) => {
      const row = a as {
        id: string;
        name: string;
        owner_user_id: string | null;
        max_channels: number | null;
        max_users: number | null;
        created_at: string | null;
      };
      return {
        id: row.id,
        name: row.name,
        ownerEmail: row.owner_user_id
          ? emailMap.get(row.owner_user_id) ?? null
          : null,
        members: memberCounts.get(row.id) ?? 0,
        channels: channelCounts.get(row.id) ?? 0,
        max_channels: row.max_channels ?? 0,
        max_users: row.max_users ?? 0,
        created_at: row.created_at,
        isMember: callerAccounts.has(row.id),
      };
    });

    return NextResponse.json({ accounts });
  } catch (err) {
    console.error("[api/admin/accounts] GET error:", err);
    return NextResponse.json(
      { error: "Falha ao carregar contas" },
      { status: 500 },
    );
  }
}

// Valida um limite: inteiro >= 0. Retorna o número saneado ou null se
// o campo não foi enviado; lança Error com mensagem se for inválido.
function parseLimit(value: unknown, field: string): number | null {
  if (value === undefined) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(`${field} deve ser um inteiro maior ou igual a zero`);
  }
  return value;
}

export async function PATCH(request: Request) {
  if (!(await isSuperAdmin())) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  try {
    const body = (await request.json().catch(() => null)) as {
      accountId?: unknown;
      max_channels?: unknown;
      max_users?: unknown;
    } | null;

    const accountId = body?.accountId;
    if (typeof accountId !== "string" || accountId.length === 0) {
      return NextResponse.json(
        { error: "accountId é obrigatório" },
        { status: 400 },
      );
    }

    let maxChannels: number | null;
    let maxUsers: number | null;
    try {
      maxChannels = parseLimit(body?.max_channels, "max_channels");
      maxUsers = parseLimit(body?.max_users, "max_users");
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Valor inválido" },
        { status: 400 },
      );
    }

    const update: Record<string, number> = {};
    if (maxChannels !== null) update.max_channels = maxChannels;
    if (maxUsers !== null) update.max_users = maxUsers;

    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        { error: "Nenhum limite para atualizar" },
        { status: 400 },
      );
    }

    const admin = supabaseAdmin();
    const { data, error } = await admin
      .from("accounts")
      .update(update)
      .eq("id", accountId)
      .select("id, max_channels, max_users")
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return NextResponse.json(
        { error: "Conta não encontrada" },
        { status: 404 },
      );
    }

    return NextResponse.json({ account: data });
  } catch (err) {
    console.error("[api/admin/accounts] PATCH error:", err);
    return NextResponse.json(
      { error: "Falha ao atualizar limites" },
      { status: 500 },
    );
  }
}
