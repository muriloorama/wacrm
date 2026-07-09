// ============================================================
// GET /api/cron/followups   (rotina agendada — Vercel Cron)
//
// Follow-up automático, espelhando o CRM antigo. Roda de hora em hora
// (ver vercel.json) e SÓ age em horário comercial (seg–sex, 9h–17h,
// America/Sao_Paulo).
//
// FASE A (envio): negócio em "Orçamento Enviado" cuja ÚLTIMA mensagem foi
//   nossa (sender_type='agent') e já passou `followup_hours` sem o cliente
//   responder → envia a mensagem de follow-up, marca followup_count=1,
//   grava last_followup_at e move o negócio para "Follow-up Automático".
//
// FASE B (escala/retorno): negócio em "Follow-up Automático" →
//   - se o cliente respondeu (última msg = 'customer') → "Respondeu Follow-up";
//   - senão, passadas `followup_hours` desde o envio → "Sem Resposta Follow-up AT".
//
// Segurança: exige CRON_SECRET (ou AUTOMATION_CRON_SECRET). O Vercel Cron
// manda `Authorization: Bearer <CRON_SECRET>`; um pinger externo pode usar
// o header `x-cron-secret`. Sem segredo configurado → 503 (fecha fechado).
// ============================================================

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import {
  sendMessageToConversation,
  SendMessageError,
} from "@/lib/whatsapp/send-message";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TZ = "America/Sao_Paulo";
const DEFAULT_MSG =
  "Olá! Vi que conversamos por aqui e queria saber se você ainda tem interesse. Posso te ajudar em algo? 😊";

const ST_ORCAMENTO = "Orçamento Enviado";
const ST_FOLLOWUP = "Follow-up Automático";
const ST_RESPONDEU = "Respondeu Follow-up";

// Etapa final da escala. Primeiro nome é o atual; os seguintes são nomes
// antigos ainda em uso por contas que não foram renomeadas. Sem esse fallback
// o cron não acha a etapa e para de escalar sem erro nenhum.
const ST_SEM_RESPOSTA = ["Sem Resposta Follow-up AT", "Follow-up Manual"];

// Primeiro nome que existir no funil. undefined = o funil não tem essa etapa.
function pickStage(
  stagesByName: Map<string, string> | undefined,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const id = stagesByName?.get(name);
    if (id) return id;
  }
  return undefined;
}

function withinBusinessHours(d: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hr = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const util = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(wd);
  return util && hr >= 9 && hr < 17;
}

function authorized(request: Request, expected: string): boolean {
  if (request.headers.get("authorization") === `Bearer ${expected}`) return true;
  if (request.headers.get("x-cron-secret") === expected) return true;
  return false;
}

type Admin = ReturnType<typeof supabaseAdmin>;

// Última mensagem (sender + quando) da conversa mais recente do contato.
// Retorna também o conversationId para o envio. null = sem conversa/mensagem.
async function latestForContact(
  db: Admin,
  accountId: string,
  contactId: string,
  preferredConversationId: string | null,
): Promise<{
  conversationId: string;
  senderType: string;
  createdAt: string;
} | null> {
  let conversationId = preferredConversationId;
  if (!conversationId) {
    const { data: conv } = await db
      .from("conversations")
      .select("id")
      .eq("account_id", accountId)
      .eq("contact_id", contactId)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    conversationId = (conv?.id as string) ?? null;
  }
  if (!conversationId) return null;

  const { data: msg } = await db
    .from("messages")
    .select("sender_type, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!msg) return null;

  return {
    conversationId,
    senderType: msg.sender_type as string,
    createdAt: msg.created_at as string,
  };
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

  if (!withinBusinessHours(new Date())) {
    return NextResponse.json({ ok: true, skipped: "fora_horario_comercial" });
  }

  const db = supabaseAdmin();

  const { data: accounts } = await db
    .from("accounts")
    .select("id, followup_message, followup_hours")
    .eq("followup_enabled", true);
  if (!accounts || accounts.length === 0) {
    return NextResponse.json({ ok: true, accounts: 0 });
  }

  let sent = 0;
  let escalated = 0;
  let replied = 0;
  const errors: string[] = [];

  for (const acct of accounts) {
    try {
      const accountId = acct.id as string;
      const hours = Number(acct.followup_hours) || 24;
      const cutoffMs = Date.now() - hours * 3600 * 1000;
      const msg =
        (acct.followup_message as string | null)?.trim() || DEFAULT_MSG;

      // Etapas da conta, resolvidas por NOME dentro de cada funil.
      const { data: pipes } = await db
        .from("pipelines")
        .select("id")
        .eq("account_id", accountId);
      const pipelineIds = (pipes ?? []).map((p) => p.id as string);
      if (pipelineIds.length === 0) continue;

      const { data: stages } = await db
        .from("pipeline_stages")
        .select("id, name, pipeline_id")
        .in("pipeline_id", pipelineIds);
      // pipeline_id -> { nome -> stage_id }
      const byPipe = new Map<string, Map<string, string>>();
      for (const s of stages ?? []) {
        const pid = s.pipeline_id as string;
        const m = byPipe.get(pid) ?? new Map<string, string>();
        m.set(s.name as string, s.id as string);
        byPipe.set(pid, m);
      }
      const orcamentoIds = [...byPipe.values()]
        .map((m) => m.get(ST_ORCAMENTO))
        .filter((x): x is string => !!x);
      const followupIds = [...byPipe.values()]
        .map((m) => m.get(ST_FOLLOWUP))
        .filter((x): x is string => !!x);

      // ---------- FASE A: envio ----------
      if (orcamentoIds.length > 0) {
        const { data: dealsA } = await db
          .from("deals")
          .select("id, contact_id, conversation_id, pipeline_id")
          .eq("account_id", accountId)
          .eq("status", "open")
          .eq("followup_opt_out", false)
          .eq("followup_count", 0)
          .in("stage_id", orcamentoIds)
          .limit(100);

        for (const d of dealsA ?? []) {
          const contactId = d.contact_id as string | null;
          if (!contactId) continue;
          const latest = await latestForContact(
            db,
            accountId,
            contactId,
            (d.conversation_id as string | null) ?? null,
          );
          if (!latest) continue;
          // Só cutuca se a ÚLTIMA mensagem foi NOSSA (cliente calado)...
          if (latest.senderType !== "agent") continue;
          // ...e já se passaram `hours` desde então.
          if (new Date(latest.createdAt).getTime() > cutoffMs) continue;

          try {
            await sendMessageToConversation(db, accountId, {
              conversationId: latest.conversationId,
              messageType: "text",
              contentText: msg,
            });
          } catch (e) {
            if (e instanceof SendMessageError) {
              errors.push(`A ${d.id}: ${e.message}`);
              continue; // canal off/erro → tenta no próximo ciclo
            }
            throw e;
          }

          const dest = byPipe.get(d.pipeline_id as string)?.get(ST_FOLLOWUP);
          await db
            .from("deals")
            .update({
              followup_count: 1,
              last_followup_at: new Date().toISOString(),
              ...(dest ? { stage_id: dest } : {}),
              updated_at: new Date().toISOString(),
            })
            .eq("id", d.id)
            .eq("account_id", accountId);
          sent++;
        }
      }

      // ---------- FASE B: retorno / escala ----------
      if (followupIds.length > 0) {
        const { data: dealsB } = await db
          .from("deals")
          .select("id, contact_id, conversation_id, pipeline_id, last_followup_at")
          .eq("account_id", accountId)
          .eq("status", "open")
          .in("stage_id", followupIds)
          .limit(200);

        for (const d of dealsB ?? []) {
          const contactId = d.contact_id as string | null;
          if (!contactId) continue;
          const latest = await latestForContact(
            db,
            accountId,
            contactId,
            (d.conversation_id as string | null) ?? null,
          );
          const pipeMap = byPipe.get(d.pipeline_id as string);

          // Cliente respondeu → "Respondeu Follow-up" (o quanto antes).
          if (latest && latest.senderType === "customer") {
            const dest = pipeMap?.get(ST_RESPONDEU);
            if (dest) {
              await db
                .from("deals")
                .update({
                  stage_id: dest,
                  last_followup_at: null,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", d.id)
                .eq("account_id", accountId);
              replied++;
            }
            continue;
          }

          // Sem resposta e passou o prazo → "Sem Resposta Follow-up AT".
          const lastFu = d.last_followup_at
            ? new Date(d.last_followup_at as string).getTime()
            : 0;
          if (lastFu && lastFu <= cutoffMs) {
            const dest = pickStage(pipeMap, ST_SEM_RESPOSTA);
            if (dest) {
              await db
                .from("deals")
                .update({
                  stage_id: dest,
                  last_followup_at: null,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", d.id)
                .eq("account_id", accountId);
              escalated++;
            }
          }
        }
      }
    } catch (e) {
      errors.push(`acct ${acct.id}: ${(e as Error).message}`);
    }
  }

  return NextResponse.json({
    ok: true,
    sent,
    replied,
    escalated,
    errors: errors.slice(0, 10),
  });
}
