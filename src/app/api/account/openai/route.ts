// ============================================================
// /api/account/openai
//
//   GET — a conta tem chave OpenAI configurada? (só um booleano). Admin+.
//   PUT — define/limpa a chave OpenAI da conta. Admin+.
//
// A chave é do CLIENTE (por conta) e usada para transcrever áudios. É
// guardada CIFRADA em accounts.openai_api_key; nunca devolvemos o valor.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { encrypt } from "@/lib/whatsapp/encryption";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function GET() {
  try {
    const ctx = await requireRole("admin");
    const { data } = await ctx.supabase
      .from("accounts")
      .select("openai_api_key")
      .eq("id", ctx.accountId)
      .maybeSingle();
    return NextResponse.json({
      configured: Boolean(data?.openai_api_key),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:openai:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      apiKey?: unknown;
    } | null;
    const raw = body?.apiKey;

    // null / string vazia → limpa a chave (desliga a transcrição).
    if (raw === null || raw === "" || raw === undefined) {
      const { error } = await ctx.supabase
        .from("accounts")
        .update({ openai_api_key: null })
        .eq("id", ctx.accountId);
      if (error) {
        console.error("[PUT /api/account/openai] clear error:", error);
        return NextResponse.json(
          { error: "Falha ao salvar" },
          { status: 500 },
        );
      }
      return NextResponse.json({ configured: false });
    }

    if (typeof raw !== "string") {
      return NextResponse.json(
        { error: "'apiKey' deve ser uma string" },
        { status: 400 },
      );
    }
    const apiKey = raw.trim();
    if (!apiKey.startsWith("sk-") || apiKey.length < 20) {
      return NextResponse.json(
        { error: "Chave OpenAI inválida (deve começar com 'sk-')." },
        { status: 400 },
      );
    }

    const { error } = await ctx.supabase
      .from("accounts")
      .update({ openai_api_key: encrypt(apiKey) })
      .eq("id", ctx.accountId);
    if (error) {
      console.error("[PUT /api/account/openai] save error:", error);
      return NextResponse.json({ error: "Falha ao salvar" }, { status: 500 });
    }

    return NextResponse.json({ configured: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
