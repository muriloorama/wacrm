import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError,
} from '@/lib/whatsapp/send-message'

// The dashboard's outbound-send endpoint. It owns auth, per-user rate
// limiting, and the two ways the UI targets a thread — an existing
// `conversation_id` (inbox) or a `contact_id` (Contact detail →
// find-or-create the conversation). The actual Meta plumbing (validate
// → send → persist → pause flows) lives in the shared
// `sendMessageToConversation` core, which the public `/api/v1/messages`
// endpoint reuses. This route is a thin adapter: resolve the
// conversation, delegate, then map `SendMessageError` back onto the
// dashboard's internal `{ error }` shape.
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Per-user rate limit. Bucket key is scoped to this route so
    // `/broadcast` has an independent budget.
    const limit = checkRateLimit(`send:${user.id}`, RATE_LIMITS.send)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    // Resolve the caller's account_id. Every downstream lookup
    // (conversation, whatsapp_config, message_templates) is account-
    // scoped post-multi-user, so the previous `user_id` filters
    // returned nothing for teammates who didn't author the row.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const {
      // `conversation_id` targets an existing thread (inbox). `contact_id`
      // lets a caller initiate from a contact that may have no conversation
      // yet (Contact detail → Send template) — we find-or-create one below.
      conversation_id: conversationIdInput,
      contact_id,
      message_type,
      content_text,
      media_url,
      filename,
      template_name,
      template_language,
      template_params,
      template_message_params,
      reply_to_message_id,
    } = body

    if ((!conversationIdInput && !contact_id) || !message_type) {
      return NextResponse.json(
        {
          error:
            'Either conversation_id or contact_id, plus message_type, are required',
        },
        { status: 400 }
      )
    }

    // Validate the message shape up front — before the contact_id path
    // finds-or-creates a conversation — so an invalid payload 400s
    // without leaving an orphan empty conversation behind.
    try {
      validateSendMessageParams({
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        templateName: template_name,
      })
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }

    // Resolve the target conversation. With `conversation_id` we load the
    // existing thread; with `contact_id` we find-or-create one for the
    // contact so a business-initiated template send (Contact detail view)
    // reuses the shared send core below.
    let conversationId: string | null = null

    if (conversationIdInput) {
      const { data, error: convError } = await supabase
        .from('conversations')
        .select('id')
        .eq('id', conversationIdInput)
        .eq('account_id', accountId)
        .single()

      if (convError || !data) {
        return NextResponse.json(
          { error: 'Conversation not found' },
          { status: 404 }
        )
      }
      conversationId = data.id
    } else {
      // contact_id path: verify the contact is in this account first so a
      // caller can't open a conversation against someone else's contact.
      const { data: contactRow, error: contactErr } = await supabase
        .from('contacts')
        .select('id')
        .eq('id', contact_id)
        .eq('account_id', accountId)
        .maybeSingle()

      if (contactErr || !contactRow) {
        return NextResponse.json(
          { error: 'Contact not found' },
          { status: 404 }
        )
      }

      const resolved = await findOrCreateConversation(
        supabase,
        accountId,
        user.id,
        contact_id
      )
      if (!resolved) {
        return NextResponse.json(
          { error: 'Failed to open a conversation for this contact' },
          { status: 500 }
        )
      }
      conversationId = resolved
    }

    if (!conversationId) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      )
    }

    // Delegate to the shared send core (validates, sends to Meta with
    // phone-variant retry, persists, pauses active flow runs). Its
    // `SendMessageError` carries a machine code + HTTP status; the
    // dashboard maps it to the internal `{ error }` shape.
    try {
      const result = await sendMessageToConversation(supabase, accountId, {
        conversationId,
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        filename,
        templateName: template_name,
        templateLanguage: template_language,
        templateParams: template_params,
        templateMessageParams: template_message_params,
        replyToMessageId: reply_to_message_id,
      })

      // Regra de negócio: quando o VENDEDOR responde, o negócio do contato
      // sai de "Aguardando Atendimento" e vai para "Em Atendimento". Nunca
      // deixa o envio falhar por causa disso — best-effort, erro só logado.
      try {
        await advanceDealOnAgentReply(supabase, accountId, conversationId)
      } catch (e) {
        console.error('advanceDealOnAgentReply:', e)
      }

      return NextResponse.json({
        success: true,
        message_id: result.messageId,
        whatsapp_message_id: result.whatsappMessageId,
      })
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json(
          { error: err.message },
          { status: err.status }
        )
      }
      throw err
    }
  } catch (error) {
    console.error('Error in WhatsApp send POST:', error)
    return NextResponse.json(
      { error: 'Failed to send message' },
      { status: 500 }
    )
  }
}

type SendSupabase = Awaited<ReturnType<typeof createClient>>

/**
 * Return the contact's conversation id in this account, creating one if
 * it doesn't exist yet. Mirrors the webhook's find-or-create so an
 * inbound-then-outbound (or outbound-first) sequence converges on a single
 * thread per contact. Runs under the caller's RLS — the conversations_insert
 * policy requires account agent membership, which the caller already is.
 */
async function findOrCreateConversation(
  supabase: SendSupabase,
  accountId: string,
  userId: string,
  contactId: string,
): Promise<string | null> {
  // Um contato pode ter VÁRIAS conversas (uma por canal). O `.maybeSingle()`
  // sem `.limit(1)` dava erro "multiple rows" nesse caso — e como o erro era
  // descartado, caía no insert e criava uma conversa duplicada/órfã. Aqui
  // reusamos a conversa mais recente do contato (sem canal para escolher, a
  // ativa é a aposta certa) e tratamos o erro explicitamente.
  const { data: existing, error: lookupError } = await supabase
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()

  if (lookupError) {
    console.error(
      'Error looking up conversation for contact send:',
      lookupError.message,
    )
    return null
  }

  if (existing) return existing.id

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
    })
    .select('id')
    .single()

  if (error) {
    console.error('Error creating conversation for contact send:', error.message)
    return null
  }

  return created.id
}

// Nomes das etapas que definem o fluxo "chegou → aguardando → em atendimento".
// Baseado em nome (não em id) para funcionar em qualquer conta que use esse
// padrão de funil; contas sem essas etapas simplesmente não são afetadas.
const WAITING_STAGE_NAME = 'Aguardando Atendimento'
const IN_SERVICE_STAGE_NAME = 'Em Atendimento'

/**
 * Quando o agente responde uma conversa, avança o(s) negócio(s) ABERTO(s) do
 * contato que estão em "Aguardando Atendimento" para "Em Atendimento", dentro
 * do MESMO funil. Idempotente: negócios já adiante são ignorados. Roda sob a
 * RLS do agente (que pode atualizar negócios da própria conta).
 */
async function advanceDealOnAgentReply(
  supabase: SendSupabase,
  accountId: string,
  conversationId: string,
): Promise<void> {
  const { data: conv } = await supabase
    .from('conversations')
    .select('contact_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  const contactId = conv?.contact_id as string | undefined
  if (!contactId) return

  const { data: deals } = await supabase
    .from('deals')
    .select('id, stage_id, pipeline_id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'open')
  if (!deals || deals.length === 0) return

  const pipelineIds = [...new Set(deals.map((d) => d.pipeline_id as string))]
  const { data: stages } = await supabase
    .from('pipeline_stages')
    .select('id, name, pipeline_id')
    .in('pipeline_id', pipelineIds)
    .in('name', [WAITING_STAGE_NAME, IN_SERVICE_STAGE_NAME])
  if (!stages) return

  // Por funil: qual é a etapa "Aguardando" e qual é a "Em Atendimento".
  const waitingByPipeline = new Map<string, string>()
  const inServiceByPipeline = new Map<string, string>()
  for (const s of stages) {
    if (s.name === WAITING_STAGE_NAME)
      waitingByPipeline.set(s.pipeline_id as string, s.id as string)
    else if (s.name === IN_SERVICE_STAGE_NAME)
      inServiceByPipeline.set(s.pipeline_id as string, s.id as string)
  }

  for (const d of deals) {
    const pid = d.pipeline_id as string
    const target = inServiceByPipeline.get(pid)
    if (!target) continue
    if (d.stage_id !== waitingByPipeline.get(pid)) continue // só sai de Aguardando
    await supabase
      .from('deals')
      .update({ stage_id: target, updated_at: new Date().toISOString() })
      .eq('id', d.id)
      .eq('account_id', accountId)
  }
}
