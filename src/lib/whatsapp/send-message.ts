// ============================================================
// Outbound message send — the core that both the dashboard's
// `/api/whatsapp/send` route and the public `/api/v1/messages`
// endpoint call.
//
// Given a conversation and message params, this:
//   1. validates the params for the message type,
//   2. loads the conversation + contact + WhatsApp config,
//   3. sends to Meta (with phone-variant retry + contact auto-fix),
//   4. persists the message + updates the conversation,
//   5. pauses any active Flow run for the contact (agent stepped in).
//
// It is transport-agnostic: it takes a `SupabaseClient` and an
// `accountId` and throws `SendMessageError` on failure. The callers
// own auth, rate-limiting, body parsing, and mapping the error to
// their respective response shapes (internal `{ error }` vs the v1
// envelope). Behaviour is identical to the original inline route —
// this is a straight extraction so the public endpoint can reuse it
// without duplicating ~250 lines of Meta plumbing.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendTemplateMessage,
  type MediaKind,
} from '@/lib/whatsapp/meta-api';
import { getProvider } from '@/lib/whatsapp/provider';
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import type { MessageTemplate } from '@/types';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';

export const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const;
export const VALID_MESSAGE_TYPES = [
  'text',
  'template',
  ...MEDIA_KINDS,
] as const;

/**
 * Renderiza o corpo de um template substituindo {{1}}, {{2}}… pelos
 * params posicionais. Usado quando o provedor é o uazapi (que não tem
 * templates aprovados pela Meta) — o texto sai como mensagem normal.
 */
function renderTemplateBody(
  row: MessageTemplate | null,
  params: string[] | null | undefined,
): string {
  let body = (row?.body_text as string) ?? '';
  (params ?? []).forEach((p, i) => {
    body = body.replace(new RegExp(`\\{\\{\\s*${i + 1}\\s*\\}\\}`, 'g'), p ?? '');
  });
  return body;
}

/**
 * Typed failure with a machine `code` and a suggested HTTP `status`.
 * Callers map it to their own response shape (`toErrorResponse` for
 * the dashboard route, the v1 envelope for the public endpoint).
 */
export class SendMessageError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'SendMessageError';
    this.code = code;
    this.status = status;
  }
}

export interface SendMessageParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  /** Legacy positional body params (only used if messageParams.body unset). */
  templateParams?: string[];
  /** Structured template params (header/body/buttons). */
  templateMessageParams?: unknown;
  replyToMessageId?: string | null;
  /**
   * Quem envia. Default 'agent' (humano/UI/API). 'bot' marca respostas do
   * atendimento IA — grava messages.sender_type='bot' e NÃO pausa fluxos
   * nem a própria IA (só um humano faz isso). Ver src/lib/ai/reply.ts.
   */
  senderType?: 'agent' | 'bot';
}

export interface SendMessageResult {
  /** Our `messages.id` (the persisted row). */
  messageId: string;
  /** Meta's `wamid` for the delivered message. */
  whatsappMessageId: string;
}

/**
 * Send a message in an existing conversation and persist it.
 *
 * `db` may be an RLS-scoped user client (dashboard) or the service-
 * role client (public API) — every query is filtered by `accountId`
 * either way, so tenancy holds regardless of which client is passed.
 */
/**
 * Validate the message-shape params (type, required content, caption
 * cap) independently of any DB state, throwing `SendMessageError` on a
 * bad payload. Exported so a caller can reject a malformed request
 * *before* it finds-or-creates a contact/conversation — otherwise an
 * invalid payload leaves an orphan empty conversation behind. The send
 * core calls this too, so validation can't be skipped.
 */
export function validateSendMessageParams(params: {
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  templateName?: string | null;
}): void {
  const { messageType, contentText, mediaUrl, templateName } = params;

  if (!messageType) {
    throw new SendMessageError('bad_request', 'message_type is required', 400);
  }

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(messageType)) {
    throw new SendMessageError(
      'bad_request',
      `Unsupported message_type "${messageType}"`,
      400
    );
  }

  if (messageType === 'text' && !contentText) {
    throw new SendMessageError(
      'bad_request',
      'content_text is required for text messages',
      400
    );
  }

  if (messageType === 'template' && !templateName) {
    throw new SendMessageError(
      'bad_request',
      'template_name is required for template messages',
      400
    );
  }

  if (isMediaKind && !mediaUrl) {
    throw new SendMessageError(
      'bad_request',
      `media_url is required for ${messageType} messages`,
      400
    );
  }

  // Meta caps media captions at 1024 chars (audio carries none).
  if (
    isMediaKind &&
    messageType !== 'audio' &&
    typeof contentText === 'string' &&
    contentText.length > 1024
  ) {
    throw new SendMessageError(
      'bad_request',
      'Caption exceeds the 1024-character limit',
      400
    );
  }
}

export async function sendMessageToConversation(
  db: SupabaseClient,
  accountId: string,
  params: SendMessageParams
): Promise<SendMessageResult> {
  const {
    conversationId,
    messageType,
    contentText,
    mediaUrl,
    filename,
    templateName,
    templateLanguage,
    templateParams,
    templateMessageParams,
    replyToMessageId,
    senderType = 'agent',
  } = params;

  if (!conversationId) {
    throw new SendMessageError(
      'bad_request',
      'conversation_id is required',
      400
    );
  }

  validateSendMessageParams({ messageType, contentText, mediaUrl, templateName });

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  // Conversation + contact, account-scoped.
  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .single();

  if (convError || !conversation) {
    throw new SendMessageError('not_found', 'Conversation not found', 404);
  }

  const contact = conversation.contact;
  if (!contact?.phone) {
    throw new SendMessageError(
      'bad_request',
      'Contact phone number not found',
      400
    );
  }

  // Grupos são armazenados como contatos com is_group=true e
  // phone = id do grupo (só dígitos, ex.: "120363999888777"); o JID do
  // grupo no WhatsApp é `<id>@g.us`. A validação E164 é específica da
  // Meta e agora acontece por-provider no momento do envio (o uazapi
  // aceita telefone ou JID de grupo e normaliza sozinho).
  const isGroup = contact.is_group === true;

  // Resolve as credenciais de envio. Se a conversa tem um canal
  // (whatsapp_channels), ele tem prioridade e define o provedor/token.
  // Caso contrário, cai no comportamento anterior (whatsapp_config da conta).
  let providerName: string | null = null;
  let phoneNumberId: string | null = null;
  let accessToken = '';
  let uazapiToken: string | undefined;

  if (conversation.channel_id) {
    const { data: channel, error: channelError } = await db
      .from('whatsapp_channels')
      .select('*')
      .eq('id', conversation.channel_id)
      .eq('account_id', accountId)
      .single();

    if (channelError || !channel) {
      throw new SendMessageError(
        'whatsapp_not_configured',
        'Canal de WhatsApp não encontrado para esta conversa.',
        400
      );
    }

    providerName = channel.provider === 'uazapi' ? 'uazapi' : 'meta';
    phoneNumberId = channel.phone_number_id ?? null;

    if (providerName === 'uazapi') {
      if (!channel.uazapi_instance_token) {
        throw new SendMessageError(
          'whatsapp_not_configured',
          'Canal por QR Code não conectado. Conecte um número em Configurações.',
          400
        );
      }
      uazapiToken = decrypt(channel.uazapi_instance_token);
    } else {
      if (!channel.access_token) {
        throw new SendMessageError(
          'whatsapp_not_configured',
          'Canal do WhatsApp (Meta) não configurado.',
          400
        );
      }
      accessToken = decrypt(channel.access_token);
    }
  } else {
    // Fallback: WhatsApp config, account-scoped.
    const { data: config, error: configError } = await db
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single();

    if (configError || !config) {
      throw new SendMessageError(
        'whatsapp_not_configured',
        'WhatsApp not configured. Please set up your WhatsApp integration first.',
        400
      );
    }

    providerName = config.provider === 'uazapi' ? 'uazapi' : 'meta';
    phoneNumberId = config.phone_number_id ?? null;

    if (providerName === 'uazapi') {
      if (!config.uazapi_instance_token) {
        throw new SendMessageError(
          'whatsapp_not_configured',
          'WhatsApp por QR Code não conectado. Conecte um número em Configurações.',
          400
        );
      }
      uazapiToken = decrypt(config.uazapi_instance_token);
    } else {
      if (!config.access_token) {
        throw new SendMessageError(
          'whatsapp_not_configured',
          'WhatsApp (Meta) não configurado.',
          400
        );
      }
      accessToken = decrypt(config.access_token);

      // Self-heal legacy CBC ciphertexts. Fire-and-forget; idempotent.
      if (isLegacyFormat(config.access_token)) {
        void db
          .from('whatsapp_config')
          .update({ access_token: encrypt(accessToken) })
          .eq('id', config.id)
          .then(({ error }: { error: { message: string } | null }) => {
            if (error) {
              console.warn(
                '[send-message] access_token GCM upgrade failed:',
                error.message
              );
            }
          });
      }
    }
  }

  const provider = getProvider({
    provider: providerName,
    phoneNumberId,
    accessToken,
    uazapiToken,
  });

  // Resolve the reply target to its Meta message_id. The parent must
  // belong to this same conversation — otherwise a caller could quote
  // messages they can't see by guessing UUIDs.
  let contextMessageId: string | undefined;
  if (replyToMessageId) {
    const { data: parent, error: parentError } = await db
      .from('messages')
      .select('message_id, conversation_id')
      .eq('id', replyToMessageId)
      .eq('conversation_id', conversationId)
      .maybeSingle();

    if (parentError || !parent) {
      throw new SendMessageError(
        'bad_request',
        'reply_to_message_id not found in this conversation',
        400
      );
    }
    if (!parent.message_id) {
      console.warn(
        '[send-message] reply target has no Meta message_id; sending without context'
      );
    } else {
      contextMessageId = parent.message_id;
    }
  }

  // Template row (for header + button components). isMessageTemplate
  // guards against a malformed local row crashing the send-builder.
  let templateRow: MessageTemplate | null = null;
  if (messageType === 'template' && templateName) {
    const { data } = await db
      .from('message_templates')
      .select('*')
      .eq('account_id', accountId)
      .eq('name', templateName)
      .eq('language', templateLanguage || 'en_US')
      .maybeSingle();
    if (data && !isMessageTemplate(data)) {
      throw new SendMessageError(
        'template_malformed',
        'Template row is malformed locally — run "Sync from Meta" in Settings to repair it.',
        500
      );
    }
    templateRow = data ?? null;
  }

  const attempt = async (phone: string): Promise<string> => {
    if (messageType === 'template') {
      // uazapi não tem templates aprovados pela Meta — envia o corpo do
      // template renderizado como texto simples.
      if (provider.kind === 'uazapi') {
        const body =
          renderTemplateBody(templateRow, templateParams) || contentText || '';
        const r = await provider.sendText({
          to: phone,
          text: body,
          contextMessageId,
        });
        return r.messageId;
      }
      const result = await sendTemplateMessage({
        phoneNumberId: phoneNumberId!,
        accessToken,
        to: phone,
        templateName: templateName!,
        language: templateLanguage || 'en_US',
        template: templateRow ?? undefined,
        messageParams: templateMessageParams ?? undefined,
        params: templateParams || [],
        contextMessageId,
      });
      return result.messageId;
    }
    if (isMediaKind) {
      const result = await provider.sendMedia({
        to: phone,
        kind: messageType as MediaKind,
        link: mediaUrl!,
        caption: contentText || undefined,
        filename: filename || undefined,
        contextMessageId,
      });
      return result.messageId;
    }
    const result = await provider.sendText({
      to: phone,
      text: contentText!,
      contextMessageId,
    });
    return result.messageId;
  };

  let waMessageId = '';

  if (provider.kind === 'uazapi') {
    // uazapi: NÃO exige E164. O campo `number` aceita telefone ou JID de
    // grupo e é normalizado do lado do uazapi. Grupos usam o JID
    // reconstruído (`<id>@g.us`); 1:1 usa o telefone como está. Sem retry
    // por variantes — isso é específico da Meta.
    const to = isGroup ? `${contact.phone}@g.us` : contact.phone;
    try {
      waMessageId = await attempt(to);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown uazapi API error';
      console.error('[send-message] uazapi send failed:', message);
      throw new SendMessageError(
        'uazapi_error',
        `uazapi API error: ${message}`,
        502
      );
    }
  } else {
    // Send via Meta — exige E164. Sanitiza, valida, e faz retry across
    // phone-number variants if Meta rejects with "recipient not in
    // allowed list"; persist a working variant back to the contact so the
    // next send goes straight through.
    const sanitizedPhone = sanitizePhoneForMeta(contact.phone);
    if (!isValidE164(sanitizedPhone)) {
      throw new SendMessageError(
        'bad_request',
        'Invalid phone number format',
        400
      );
    }

    let workingPhone = sanitizedPhone;
    try {
      const variants = phoneVariants(sanitizedPhone);
      let lastError: unknown = null;

      for (const variant of variants) {
        try {
          waMessageId = await attempt(variant);
          workingPhone = variant;
          lastError = null;
          break;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!isRecipientNotAllowedError(message)) {
            throw err;
          }
          lastError = err;
          console.warn(
            `[send-message] variant "${variant}" rejected by Meta, trying next…`
          );
        }
      }

      if (lastError) throw lastError;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown Meta API error';
      console.error(
        '[send-message] Meta send failed for all variants:',
        message
      );
      throw new SendMessageError('meta_error', `Meta API error: ${message}`, 502);
    }

    if (workingPhone !== sanitizedPhone) {
      console.log(
        `[send-message] Auto-corrected contact phone: ${sanitizedPhone} → ${workingPhone}`
      );
      await db
        .from('contacts')
        .update({ phone: workingPhone })
        .eq('id', contact.id);
    }
  }

  // Persist the sent message. Field names MUST match the messages
  // schema (see 001_initial_schema.sql).
  const { data: messageRecord, error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: senderType,
      content_type: messageType,
      content_text: contentText || null,
      media_url: mediaUrl || null,
      template_name: templateName || null,
      message_id: waMessageId,
      status: 'sent',
      reply_to_message_id: replyToMessageId || null,
    })
    .select()
    .single();

  if (msgError) {
    console.error('[send-message] error inserting sent message:', msgError);
    throw new SendMessageError(
      'db_error',
      `Message sent to Meta but failed to save to DB: ${msgError.message}`,
      500
    );
  }

  await db
    .from('conversations')
    .update({
      last_message_text: contentText || `[${messageType}]`,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);

  // Um humano (ou a API) enviando é o "cede o lugar, tem gente aqui" mais
  // forte: pausa fluxos ativos E o atendimento IA nesta conversa. Respostas
  // da própria IA (senderType 'bot') NÃO disparam isso. Best-effort.
  if (senderType !== 'bot') {
    try {
      const { error: pauseErr } = await supabaseAdmin()
        .from('flow_runs')
        .update({
          status: 'paused_by_agent',
          ended_at: new Date().toISOString(),
          end_reason: 'agent_replied',
        })
        .eq('account_id', accountId)
        .eq('contact_id', contact.id)
        .eq('status', 'active');
      if (pauseErr) {
        console.error('[flows] pause-on-agent-send failed:', pauseErr.message);
      }
    } catch (err) {
      console.error(
        '[flows] pause-on-agent-send threw:',
        err instanceof Error ? err.message : err
      );
    }

    // Cala a IA nesta conversa até um humano reativar (toggle no inbox).
    try {
      await db
        .from('conversations')
        .update({ ai_paused: true })
        .eq('id', conversationId)
        .eq('account_id', accountId);
    } catch (err) {
      console.error(
        '[ai] pause-on-agent-send threw:',
        err instanceof Error ? err.message : err
      );
    }
  }

  return { messageId: messageRecord.id, whatsappMessageId: waMessageId };
}
