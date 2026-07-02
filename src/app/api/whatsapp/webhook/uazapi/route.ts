import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabaseAdmin } from "@/lib/automations/admin-client";
import { normalizePhone } from "@/lib/whatsapp/phone-utils";
import { findExistingContact, isUniqueViolation } from "@/lib/contacts/dedupe";
import { decrypt } from "@/lib/whatsapp/encryption";
import { downloadMedia } from "@/lib/whatsapp/uazapi-api";

// ============================================================
// Webhook de ENTRADA do provedor uazapi (uazapiGO).
//
// O servidor uazapi faz POST aqui a cada evento da instância:
//   { event: "messages" | "messages_update" | "connection" | ...,
//     instance: "<id_da_instancia>",
//     data: <Message> }
//
// Não é autenticado por usuário — resolvemos o CANAL pela instância
// (whatsapp_channels). Espelha EXATAMENTE a lógica de
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
  // Formato REAL entregue pelo uazapi:
  EventType?: string; // ex.: "messages", "messages_update"
  instanceName?: string; // nós criamos como "account-<accountId>"
  token?: string;
  owner?: string;
  message?: UazapiMessage;
  // Dados do chat (contato): traz a foto de perfil do WhatsApp.
  chat?: { image?: string; imagePreview?: string };
  // Aliases tolerados (spec / variações):
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
  const event = body.EventType ?? body.event;
  const data = body.message ?? body.data;
  const instanceName = body.instanceName ?? body.instance ?? "";

  console.log(
    "[uazapi-webhook] EventType:",
    event,
    "| instanceName:",
    instanceName,
    "| tem message:",
    Boolean(data),
  );

  if (!data) return;

  const db = supabaseAdmin();

  // 1) Resolver o CANAL (whatsapp_channels) pela instância.
  //   - Canais novos nomeiam a instância "channel-<id-da-linha>".
  //   - O canal "Principal" migrado usa "account-<accountId>" — resolvemos
  //     pelo account_id (pegamos o primeiro canal da conta).
  //   - Fallback: casar por uazapi_instance_id, caso o payload traga a
  //     instância dentro da mensagem.
  type ChannelRow = {
    id: string;
    account_id: string;
    created_by: string | null;
    uazapi_instance_token: string | null;
  };
  const CHANNEL_COLS = "id, account_id, created_by, uazapi_instance_token";
  let channel: ChannelRow | null = null;

  if (instanceName.startsWith("channel-")) {
    const channelId = instanceName.slice("channel-".length);
    const { data: byId } = await db
      .from("whatsapp_channels")
      .select(CHANNEL_COLS)
      .eq("id", channelId)
      .maybeSingle();
    channel = (byId as ChannelRow) ?? null;
  } else if (instanceName.startsWith("account-")) {
    const accountId = instanceName.slice("account-".length);
    const { data: byAccount } = await db
      .from("whatsapp_channels")
      .select(CHANNEL_COLS)
      .eq("account_id", accountId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    channel = (byAccount as ChannelRow) ?? null;
  }
  if (!channel && data.instance) {
    const { data: byInstance } = await db
      .from("whatsapp_channels")
      .select(CHANNEL_COLS)
      .eq("uazapi_instance_id", data.instance)
      .maybeSingle();
    channel = (byInstance as ChannelRow) ?? null;
  }

  if (!channel) {
    console.warn(
      "[uazapi-webhook] canal não resolvido — instanceName:",
      instanceName,
    );
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
    const instanceToken = channel.uazapi_instance_token
      ? decrypt(channel.uazapi_instance_token)
      : "";
    const avatarUrl = body.chat?.imagePreview || body.chat?.image || null;
    await processMessage(
      db,
      channel.account_id,
      channel.created_by ?? channel.account_id,
      channel.id,
      data,
      instanceToken,
      avatarUrl,
    );
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

/**
 * messageType do WhatsApp/uazapi → content_type do CRM. Os valores reais
 * são "Conversation", "ExtendedTextMessage", "AudioMessage",
 * "ImageMessage", "VideoMessage", "DocumentMessage", "StickerMessage"…
 */
function mapContentType(messageType: string | undefined): string {
  const t = (messageType ?? "").toLowerCase();
  if (t.includes("audio") || t === "ptt") return "audio";
  if (t.includes("sticker") || t.includes("image")) return "image";
  if (t.includes("video")) return "video";
  if (t.includes("document")) return "document";
  if (ALLOWED_CONTENT_TYPES.has(t)) return t;
  return "text";
}

/** Prévia da conversa quando a mensagem não tem texto (mídia). */
function previewText(contentType: string, text: string | null): string {
  if (text) return text;
  const labels: Record<string, string> = {
    audio: "[áudio]",
    image: "[imagem]",
    video: "[vídeo]",
    document: "[documento]",
  };
  return labels[contentType] ?? "[mensagem]";
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
  channelId: string,
  data: UazapiMessage,
  instanceToken: string,
  avatarUrl: string | null,
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
  // Mídia inbound vem criptografada (.enc) e o `fileURL` do payload
  // costuma vir vazio; resolve para uma URL servível via /message/download.
  let mediaUrl = data.fileURL || null;
  const isMedia =
    contentType === "audio" ||
    contentType === "image" ||
    contentType === "video" ||
    contentType === "document";
  if (isMedia && !mediaUrl && instanceToken) {
    const mid = data.id || data.messageid;
    if (mid) {
      try {
        const dl = await downloadMedia(instanceToken, mid);
        if (dl.fileURL) mediaUrl = dl.fileURL;
      } catch (err) {
        console.error("[uazapi-webhook] falha ao baixar mídia:", err);
      }
    }
  }

  // findOrCreate contato (account-scoped, por telefone).
  const contact = await findOrCreateContact(
    db,
    accountId,
    configOwnerUserId,
    phone,
    contactName,
    avatarUrl,
  );
  if (!contact) return;

  // findOrCreate conversa (grava o canal de origem).
  const conversation = await findOrCreateConversation(
    db,
    accountId,
    configOwnerUserId,
    channelId,
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
      last_message_text: previewText(contentType, contentText),
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
  avatarUrl: string | null,
): Promise<ContactRow | null> {
  const existing = await findExistingContact(db, accountId, phone);
  if (existing) {
    const patch: Record<string, unknown> = {};
    if (name && name !== existing.name) patch.name = name;
    // Preenche a foto se o contato ainda não tem (ou mudou).
    if (avatarUrl && avatarUrl !== existing.avatar_url) patch.avatar_url = avatarUrl;
    if (Object.keys(patch).length > 0) {
      patch.updated_at = new Date().toISOString();
      await db.from("contacts").update(patch).eq("id", existing.id);
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
      avatar_url: avatarUrl,
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
  channelId: string,
  contactId: string,
): Promise<ConversationRow | null> {
  const { data: existing, error: findError } = await db
    .from("conversations")
    .select("*")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .single();

  if (!findError && existing) {
    // Garante que a conversa aponte para o canal de origem (retro-preenche
    // conversas anteriores à existência de canais nomeados).
    if (!existing.channel_id) {
      await db
        .from("conversations")
        .update({ channel_id: channelId })
        .eq("id", existing.id);
      existing.channel_id = channelId;
    }
    return existing;
  }

  const { data: newConv, error: createError } = await db
    .from("conversations")
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
      channel_id: channelId,
    })
    .select()
    .single();

  if (createError) {
    console.error("[uazapi-webhook] erro ao criar conversa:", createError);
    return null;
  }

  return newConv;
}
