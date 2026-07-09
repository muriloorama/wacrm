// ============================================================
// /api/account/members/[userId]/channels
//
//   GET — canais da conta + quais estão atribuídos ao membro. Admin+.
//   PUT — troca o conjunto de canais do membro.                Admin+.
//
// owner/admin enxergam todos os canais por definição (ver
// can_access_channel na migration 048), então atribuir canal a eles não
// muda nada. A UI deixa isso claro; aqui a gravação é permitida mesmo
// assim, para que um futuro rebaixamento a `agent` já encontre o
// conjunto certo.
//
// A autorização real é da RLS de channel_members (INSERT/DELETE exigem
// admin+). O que esta rota acrescenta é garantir que os canais gravados
// pertencem à conta do chamador — sem isso um admin poderia atribuir o
// canal de outra conta, já que a policy só olha `account_id` da linha
// que ele mesmo está inserindo.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole("admin");
    const { userId } = await params;

    const [{ data: channels, error: chErr }, { data: assigned, error: asErr }] =
      await Promise.all([
        ctx.supabase
          .from("whatsapp_channels")
          .select("id, name, phone, status")
          .eq("account_id", ctx.accountId)
          .order("name"),
        ctx.supabase
          .from("channel_members")
          .select("channel_id")
          .eq("account_id", ctx.accountId)
          .eq("user_id", userId),
      ]);

    if (chErr || asErr) {
      console.error("[GET member channels]", chErr ?? asErr);
      return NextResponse.json(
        { error: "Falha ao carregar canais" },
        { status: 500 },
      );
    }

    const assignedIds = new Set((assigned ?? []).map((r) => r.channel_id));

    return NextResponse.json({
      channels: (channels ?? []).map((c) => ({
        ...c,
        assigned: assignedIds.has(c.id),
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:memberChannels:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;
    const body = (await request.json().catch(() => null)) as {
      channelIds?: unknown;
    } | null;

    const raw = body?.channelIds;
    if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) {
      return NextResponse.json(
        { error: "'channelIds' deve ser uma lista de ids" },
        { status: 400 },
      );
    }
    const channelIds = [...new Set(raw as string[])];

    // O alvo precisa ser membro desta conta.
    const { data: member } = await ctx.supabase
      .from("account_members")
      .select("user_id")
      .eq("account_id", ctx.accountId)
      .eq("user_id", userId)
      .maybeSingle();

    if (!member) {
      return NextResponse.json(
        { error: "Membro não encontrado nesta conta" },
        { status: 404 },
      );
    }

    // Todo id precisa ser um canal DESTA conta.
    if (channelIds.length > 0) {
      const { data: valid } = await ctx.supabase
        .from("whatsapp_channels")
        .select("id")
        .eq("account_id", ctx.accountId)
        .in("id", channelIds);

      if ((valid?.length ?? 0) !== channelIds.length) {
        return NextResponse.json(
          { error: "Algum canal não pertence a esta conta" },
          { status: 400 },
        );
      }
    }

    // Troca do conjunto. Não é atômico: um erro no insert deixa o membro
    // sem canal nenhum — que é o lado seguro do deny-by-default, e a UI
    // reexibe o estado real depois de gravar.
    const { error: delErr } = await ctx.supabase
      .from("channel_members")
      .delete()
      .eq("account_id", ctx.accountId)
      .eq("user_id", userId);

    if (delErr) {
      console.error("[PUT member channels] delete:", delErr);
      return NextResponse.json({ error: "Falha ao gravar" }, { status: 500 });
    }

    if (channelIds.length > 0) {
      const { error: insErr } = await ctx.supabase
        .from("channel_members")
        .insert(
          channelIds.map((channelId) => ({
            channel_id: channelId,
            user_id: userId,
            account_id: ctx.accountId,
            created_by: ctx.userId,
          })),
        );

      if (insErr) {
        console.error("[PUT member channels] insert:", insErr);
        return NextResponse.json({ error: "Falha ao gravar" }, { status: 500 });
      }
    }

    return NextResponse.json({ ok: true, count: channelIds.length });
  } catch (err) {
    return toErrorResponse(err);
  }
}
