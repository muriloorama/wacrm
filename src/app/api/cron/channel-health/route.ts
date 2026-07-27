// ============================================================
// GET /api/cron/channel-health   (rotina agendada — Vercel Cron)
//
// Confere, de tempos em tempos, se cada número de WhatsApp por QR Code
// continua conectado de verdade, e grava o resultado em
// `whatsapp_channels.status`.
//
// Por que existe: até aqui o status só mudava em duas situações — quando a
// uazapi mandava um evento `connection` para o webhook, ou quando alguém
// abria a tela de Configurações. Se o celular perdesse a sessão e o evento
// não chegasse, o CRM continuava dizendo "conectado" para sempre, e o
// aviso na tela nunca acendia. Quem responde é o provedor, não a memória
// do nosso banco.
//
// Só toca em canais `uazapi` (a API Oficial da Meta não tem esse conceito
// de sessão que cai) e só escreve quando o estado MUDOU — assim o
// `updated_at` do canal continua significando "quando a conexão mudou".
//
// Segurança: mesmo padrão dos outros crons — exige CRON_SECRET (ou
// AUTOMATION_CRON_SECRET). Sem segredo configurado → 503.
// ============================================================

import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/automations/admin-client";
import { decrypt } from "@/lib/whatsapp/encryption";
import { getInstanceStatus, UazapiError } from "@/lib/whatsapp/uazapi-api";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(request: Request, expected: string): boolean {
  if (request.headers.get("authorization") === `Bearer ${expected}`) return true;
  if (request.headers.get("x-cron-secret") === expected) return true;
  return false;
}

export async function GET(request: Request) {
  const expected =
    process.env.CRON_SECRET || process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  }
  if (!authorized(request, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = supabaseAdmin();
  const { data: channels, error } = await db
    .from("whatsapp_channels")
    .select("id, name, status, uazapi_instance_token")
    .eq("provider", "uazapi");

  if (error) {
    console.error("[channel-health] falha ao listar canais:", error.message);
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }

  let verificados = 0;
  let mudaram = 0;
  const quedas: string[] = [];

  for (const channel of channels ?? []) {
    const cipher = channel.uazapi_instance_token as string | null;
    // Canal sem token nunca chegou a conectar — nada a verificar.
    if (!cipher) continue;

    let conectado: boolean;
    try {
      const status = await getInstanceStatus(decrypt(cipher));
      conectado = status.status?.connected ?? false;
    } catch (err) {
      // 401/403 é resposta AUTORITATIVA do provedor: o token da instância
      // não vale mais (instância removida, token trocado). Não dá para
      // enviar nem receber por esse número, então conta como caído — é
      // exatamente o tipo de queda silenciosa que ninguém percebia.
      const status = err instanceof UazapiError ? err.status : 0;
      if (status !== 401 && status !== 403) {
        // Qualquer outra falha (provedor fora do ar, timeout, 5xx) é "não
        // sei": marcar desconectado acenderia o alarme de todos os
        // clientes num blip da uazapi. A próxima rodada resolve.
        console.error(
          `[channel-health] falha ao consultar canal ${channel.id}:`,
          err,
        );
        continue;
      }
      conectado = false;
    }

    verificados += 1;
    const novo = conectado ? "connected" : "disconnected";
    if (novo === channel.status) continue;

    const { error: updateError } = await db
      .from("whatsapp_channels")
      .update({ status: novo, updated_at: new Date().toISOString() })
      .eq("id", channel.id);

    if (updateError) {
      console.error(
        `[channel-health] falha ao gravar canal ${channel.id}:`,
        updateError.message,
      );
      continue;
    }

    mudaram += 1;
    if (!conectado) quedas.push((channel.name as string) ?? channel.id);
  }

  if (quedas.length > 0) {
    console.warn("[channel-health] números caíram:", quedas.join(", "));
  }

  return NextResponse.json({ ok: true, verificados, mudaram, quedas });
}
