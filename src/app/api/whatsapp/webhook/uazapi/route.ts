import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabaseAdmin } from "@/lib/automations/admin-client";
import { normalizePhone } from "@/lib/whatsapp/phone-utils";
import { findExistingContact, isUniqueViolation } from "@/lib/contacts/dedupe";

// ============================================================
// Webhook de ENTRADA do provedor uazapi (uazapiGO).
//
// O servidor uazapi faz POST aqui a cada evento da instância:
//   { event: "messages" | "messages_update" | "connection" | ...,
//     instance: "<id_da_instancia>",
//     data: <Message> }
//
// Não é autenticado por usuário — resolvemos a conta pela instância
// (whatsapp_config.uazapi_instance_id). Espelha EXATAMENTE a lógica de
// banco do webhook da Meta (src/app/api/whatsapp/webhook/route.ts):
// findOrCreate de contato/conversa, insert em `messages` com
// sender_type:'customer', e bump de conversations.unread_count.
//
// Regra de ouro: responder 200 rápido SEMPRE (mesmo em erro), para o
// uazapi não reenviar em loop. Processamos de forma resiliente.
// ============================================================

export const runtime = "nodejs";

// ------------------------------------------------------------
// Tipos do payload uazapi (apenas os campos que consumimos).
// ------------------------------------------------------------
interface UazapiMessage {
  instance?: string; // alguns payloads repetem a instância dentro de data
  sender?: string; // JID, ex "5511999999999@s.whatsapp.net"
  sender_pn?: string;
  senderName?: string;
  chatid?: string;
  isGroup?: boolean;
  fromMe?: boolean;
  wasSentByApi?: boolean;
  text?: string;
  messageType?: string;
  content?: unknown;
  fileURL?: string;
  messageid?: string;
  id?: string;
  reaction?: unknown;
  status?: string;
  messageTimestamp?: number; // ms
}

interface UazapiWebhookBody {
  event?: string;
  instance?: string;
  data?: UazapiMessage;
}

// ------------------------------------------------------------
// Handler.
// ------------------------------------------------------------
export async function POST(request: Request) {
  let body: UazapiWebhookBody;
  try {
    body = (await request.json()) as UazapiWebhookBody;
  } catch {
    // Corpo inválido — nada a fazer, mas respondemos 200 para não haver
    // reenvio. (Um payload inválido não vai melhorar num retry.)
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  // Todo o processamento é resiliente: qualquer erro é logado e engolido
  // para garantirmos o 200 abaixo.
  try {
    await processWebhook(body);
  } catch (error) {
    console.error("[uazapi-webhook] erro ao processar:", error);
  }

  return NextResponse.json({ status: "received" }, { status: 200 });
}

async function processWebhook(body: UazapiWebhookBody) {
  const event = body.event;
  const instanceId = body.instance ?? body.data?.instance;
  const data = body.data;

  // Log de diagnóstico (aparece nos logs da Vercel) para conferir o
  // formato REAL do payload entregue pelo uazapi.
  console.log(
    "[uazapi-webhook] recebido — event:",
    event,
    "| instance:",
    instanceId,
    "| data keys:",
    data ? Object.keys(data).join(",") : "(sem data)",
  );

  if (!instanceId || !data) return;

  // 1) Resolver a conta pela instância.
  const db = supabaseAdmin();
  const { data: config, error: configError } = await db
    .from("whatsapp_config")
    .select("id, account_id, user_id")
    .eq("uazapi_instance_id", instanceId)
    .maybeSingle();

  if (configError) {
    console.error(
      "[uazapi-webhook] erro ao buscar whatsapp_config para instância:",
      instanceId,
      configError,
    );
    return;
  }
  if (!config) {
    // Instância desconhecida — ignora silenciosamente (200 no handler).
    return;
  }

  const ev = (event ?? "").toLowerCase();

  // 2) Eventos de STATUS (messages_update / message_update / status).
  if (ev.includes("update") || ev === "status") {
    await handleStatusUpdate(db, data);
    return;
  }

  // 3) Eventos de MENSAGEM recebida. Tolerante ao nome do evento
  // ("messages"/"message"/variações) e, como fallback, detecta pela
  // presença de conteúdo de mensagem no payload.
  const looksLikeMessage =
    ev.startsWith("message") ||
    data.text !== undefined ||
    data.content !== undefined ||
    Boolean(data.fileURL);
  if (looksLikeMessage) {
    await processMessage(db, config.account_id, config.user_id, data);
    return;
  }

  // "connection" e demais eventos não têm efeito no inbox — ignoramos.
}

// ------------------------------------------------------------
// STATUS — sobe na escada, nunca regride.
// ------------------------------------------------------------
// Escada do destinatário (igual ao webhook da Meta). `failed` é um ramo
// terminal, válido apenas a partir de estados iniciais.
const STATUS_LADDER = ["pending", "sent", "delivered", "read"] as const;

function ladderLevel(s: string): number {
  const idx = (STATUS_LADDER as readonly string[]).indexOf(s);
  return idx < 0 ? -1 : idx;
}

function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === "failed") {
    return current === "pending" || current === "sent";
  }
  if (current === "failed") return false; // failed é terminal
  const ci = ladderLevel(current);
  const ii = ladderLevel(incoming);
  if (ii < 0) return false; // status de entrada desconhecido
  if (ci < 0) return true; // status atual desconhecido — aceita
  return ii > ci;
}

/** Mapeia o status do uazapi para o vocabulário do CRM. */
function mapUazapiStatus(raw: string | undefined): string | null {
  switch ((raw ?? "").toLowerCase()) {
    case "sent":
      return "sent";
    case "delivered":
    case "received":
      return "delivered";
    case "read":
      return "read";
    case "error":
      return "failed";
    // "queued" e desconhecidos não avançam nada.
    default:
      return null;
  }
}

async function handleStatusUpdate(db: SupabaseClient, data: UazapiMessage) {
  const messageId = data.messageid;
  const incoming = mapUazapiStatus(data.status);
  if (!messageId || !incoming) return;

  // message_id não é único (ids do WhatsApp repetem entre números), então
  // buscamos as linhas correspondentes e atualizamos apenas as que sobem
  // na escada de status.
  const { data: rows, error: fetchErr } = await db
    .from("messages")
    .select("id, status")
    .eq("message_id", messageId);

  if (fetchErr) {
    console.error("[uazapi-webhook] erro ao buscar mensagem p/ status:", fetchErr);
    return;
  }
  if (!rows || rows.length === 0) return;

  for (const row of rows as { id: string; status: string }[]) {
    if (!isValidStatusTransition(row.status, incoming)) continue;
    const { error: updErr } = await db
      .from("messages")
      .update({ status: incoming })
      .eq("id", row.id);
    if (updErr) {
      console.error("[uazapi-webhook] erro ao atualizar status:", updErr);
    }
  }
}

// ------------------------------------------------------------
// MENSAGEM recebida.
// ------------------------------------------------------------

// content_type permitido pela CHECK constraint de `messages`.
const ALLOWED_CONTENT_TYPES = new Set([
  "text",
  "image",
  "document",
  "audio",
  "video",
  "location",
  "template",
  "interactive",
]);

/** messageType do uazapi → content_type do CRM. */
function mapContentType(messageType: string | undefined): string {
  const t = (messageType ?? "").toLowerCase();
  if (t === "ptt") return "audio";
  if (ALLOWED_CONTENT_TYPES.has(t)) return t;
  return "text";
}

/**
 * Extrai o telefone (só dígitos) do contato. Prioriza `sender_pn`
 * (telefone explícito) e o `chatid` (JID da conversa 1:1 = telefone do
 * cliente). NUNCA usa `sender` quando for `@lid` — esse é o identificador
 * de privacidade do WhatsApp (não é telefone).
 */
function extractPhone(data: UazapiMessage): string {
  let raw = data.chatid || data.sender_pn || "";
  if (!raw && data.sender && !data.sender.includes("@lid")) {
    raw = data.sender;
  }
  // Remove o sufixo do JID ("@s.whatsapp.net", "@c.us", "@g.us", "@lid")
  // e, por segurança, qualquer caractere não numérico.
  const withoutSuffix = raw.split("@")[0] ?? "";
  return normalizePhone(withoutSuffix);
}

async function processMessage(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  data: UazapiMessage,
) {
  // Ignora só o que o PRÓPRIO CRM enviou pela API (senão duplicaria o que
  // já está no banco). Mensagens enviadas do CELULAR (fromMe) são
  // espelhadas como saída, para o inbox refletir o aparelho. Grupos: fora
  // por enquanto.
  if (data.wasSentByApi === true) return;
  if (data.isGroup === true) return;
  const isOutgoing = data.fromMe === true;

  const phone = extractPhone(data);
  if (!phone) return;

  const contactName = data.senderName || phone;
  const contentType = mapContentType(data.messageType);
  const contentText =
    data.text ||
    (data.content && typeof data.content === "object" && "text" in data.content
      ? String((data.content as { text?: unknown }).text ?? "")
      : "") ||
    null;
  const mediaUrl = data.fileURL ? data.fileURL : null;

  // findOrCreate contato (account-scoped, por telefone).
  const contact = await findOrCreateContact(
    db,
    accountId,
    configOwnerUserId,
    phone,
    contactName,
  );
  if (!contact) return;

  // findOrCreate conversa.
  const conversation = await findOrCreateConversation(
    db,
    accountId,
    configOwnerUserId,
    contact.id,
  );
  if (!conversation) return;

  // Idempotência: o uazapi pode entregar o mesmo evento mais de uma vez
  // (webhooks duplicados / reenvios). Se a mensagem já existe nesta
  // conversa, não insere de novo.
  if (data.messageid) {
    const { data: dup } = await db
      .from("messages")
      .select("id")
      .eq("conversation_id", conversation.id)
      .eq("message_id", data.messageid)
      .limit(1)
      .maybeSingle();
    if (dup) return;
  }

  // Timestamp do WhatsApp vem em ms; cai para "agora" se ausente.
  const createdAt = data.messageTimestamp
    ? new Date(data.messageTimestamp).toISOString()
    : new Date().toISOString();

  // Insert da mensagem — mesmos campos/valores do webhook da Meta
  // (sender_type:'customer', status:'delivered').
  const { error: msgError } = await db.from("messages").insert({
    conversation_id: conversation.id,
    sender_type: isOutgoing ? "agent" : "customer",
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: data.messageid ?? null,
    status: isOutgoing ? "sent" : "delivered",
    created_at: createdAt,
  });

  if (msgError) {
    console.error("[uazapi-webhook] erro ao inserir mensagem:", msgError);
    return;
  }

  // Atualiza a conversa (última mensagem + unread_count).
  const { error: convError } = await db
    .from("conversations")
    .update({
      last_message_text: contentText || `[${contentType}]`,
      last_message_at: new Date().toISOString(),
      unread_count: isOutgoing
        ? conversation.unread_count || 0
        : (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversation.id);

  if (convError) {
    console.error("[uazapi-webhook] erro ao atualizar conversa:", convError);
  }
}

// ------------------------------------------------------------
// findOrCreate helpers — equivalentes aos do webhook da Meta.
// ------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ConversationRow = any;

async function findOrCreateContact(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string,
): Promise<ContactRow | null> {
  const existing = await findExistingContact(db, accountId, phone);
  if (existing) {
    if (name && name !== existing.name) {
      await db
        .from("contacts")
        .update({ name, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
    }
    return existing;
  }

  const { data: newContact, error: createError } = await db
    .from("contacts")
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single();

  if (createError) {
    // Corrida perdida: outra entrega concorrente criou o contato entre
    // nosso lookup e o insert. Re-resolve em vez de perder a mensagem.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(db, accountId, phone);
      if (raced) return raced;
    }
    console.error("[uazapi-webhook] erro ao criar contato:", createError);
    return null;
  }

  return newContact;
}

async function findOrCreateConversation(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
): Promise<ConversationRow | null> {
  const { data: existing, error: findError } = await db
    .from("conversations")
    .select("*")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .single();

  if (!findError && existing) return existing;

  const { data: newConv, error: createError } = await db
    .from("conversations")
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single();

  if (createError) {
    console.error("[uazapi-webhook] erro ao criar conversa:", createError);
    return null;
  }

  return newConv;
}
