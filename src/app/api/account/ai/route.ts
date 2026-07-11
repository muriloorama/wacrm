// ============================================================
// /api/account/ai
//
//   GET — config do Atendimento IA da conta (enabled, prompt, modelo) +
//         se já existe chave OpenAI configurada. Admin+.
//   PUT — atualiza enabled / ai_system_prompt / ai_model. Admin+.
//
// A IA usa a MESMA chave OpenAI da conta (accounts.openai_api_key, cifrada,
// configurada em Transcrição de áudio). Aqui só guardamos config não secreta.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

const ALLOWED_MODELS = ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1"];
const MAX_PROMPT_LEN = 8000;

export async function GET() {
  try {
    const ctx = await requireRole("admin");
    const { data } = await ctx.supabase
      .from("accounts")
      .select("ai_enabled, ai_system_prompt, ai_model, openai_api_key")
      .eq("id", ctx.accountId)
      .maybeSingle();
    return NextResponse.json({
      enabled: Boolean(data?.ai_enabled),
      systemPrompt: (data?.ai_system_prompt as string | null) ?? "",
      model: (data?.ai_model as string | null) ?? "gpt-4o-mini",
      hasOpenAiKey: Boolean(data?.openai_api_key),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:ai:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      enabled?: unknown;
      systemPrompt?: unknown;
      model?: unknown;
    } | null;
    if (!body) {
      return NextResponse.json({ error: "Corpo inválido" }, { status: 400 });
    }

    const updates: Record<string, unknown> = {};

    if (typeof body.enabled === "boolean") {
      updates.ai_enabled = body.enabled;
    }

    if (typeof body.systemPrompt === "string") {
      const prompt = body.systemPrompt.trim();
      if (prompt.length > MAX_PROMPT_LEN) {
        return NextResponse.json(
          { error: `O prompt excede ${MAX_PROMPT_LEN} caracteres.` },
          { status: 400 },
        );
      }
      updates.ai_system_prompt = prompt || null;
    }

    if (typeof body.model === "string") {
      if (!ALLOWED_MODELS.includes(body.model)) {
        return NextResponse.json(
          { error: "Modelo não suportado." },
          { status: 400 },
        );
      }
      updates.ai_model = body.model;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: "Nada para atualizar." },
        { status: 400 },
      );
    }

    const { error } = await ctx.supabase
      .from("accounts")
      .update(updates)
      .eq("id", ctx.accountId);
    if (error) {
      console.error("[PUT /api/account/ai] save error:", error);
      return NextResponse.json({ error: "Falha ao salvar" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
