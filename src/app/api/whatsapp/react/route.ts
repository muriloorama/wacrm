import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getProvider } from '@/lib/whatsapp/provider';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

/**
 * POST /api/whatsapp/react
 *
 * Body: { message_id: <internal UUID>, emoji: <single emoji or "" to remove> }
 *
 * Sends the reaction to Meta and mirrors it into `message_reactions`
 * (delete on empty emoji). Customer-side reactions are handled by the
 * webhook — this route only writes `actor_type = 'agent'` rows.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const limit = checkRateLimit(`react:${user.id}`, RATE_LIMITS.react);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    // Resolve the caller's account_id so conversation + whatsapp_config
    // lookups work for teammates who didn't author the rows directly.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle();
    const accountId = profile?.account_id as string | undefined;
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      );
    }

    const body = await request.json();
    const { message_id, emoji } = body as {
      message_id?: string;
      emoji?: string;
    };

    if (!message_id || typeof emoji !== 'string') {
      return NextResponse.json(
        { error: 'message_id and emoji are required' },
        { status: 400 },
      );
    }

    // Resolve target message + its conversation; verify ownership.
    const { data: targetMessage, error: msgError } = await supabase
      .from('messages')
      .select('id, message_id, conversation_id')
      .eq('id', message_id)
      .maybeSingle();

    if (msgError || !targetMessage) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    if (!targetMessage.message_id) {
      // No Meta ID yet — usually a sending/failed agent message. We can't
      // tell Meta to react to a message it never received.
      return NextResponse.json(
        { error: 'Cannot react to a message that has not been sent to WhatsApp' },
        { status: 400 },
      );
    }

    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id, account_id, channel_id, contact:contacts(phone, is_group)')
      .eq('id', targetMessage.conversation_id)
      .eq('account_id', accountId)
      .maybeSingle();

    if (convError || !conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 },
      );
    }

    const contact = Array.isArray(conversation.contact)
      ? conversation.contact[0]
      : conversation.contact;
    if (!contact?.phone) {
      return NextResponse.json(
        { error: 'Contact phone number not found' },
        { status: 400 },
      );
    }
    const isGroup = contact.is_group === true;

    // Resolve provedor/credenciais. Se a conversa tem um canal
    // (whatsapp_channels), ele define o provedor/token; senão cai no
    // whatsapp_config da conta. Espelha `send-message.ts` — sem isso a rota
    // era Meta-only e fazia `decrypt(null)` em contas uazapi (token no canal,
    // não no config), quebrando 100% das reações do agente no QR Code.
    let providerName: string | null = null;
    let phoneNumberId: string | null = null;
    let accessToken = '';
    let uazapiToken: string | undefined;

    if (conversation.channel_id) {
      const { data: channel, error: channelError } = await supabase
        .from('whatsapp_channels')
        .select('provider, phone_number_id, access_token, uazapi_instance_token')
        .eq('id', conversation.channel_id)
        .eq('account_id', accountId)
        .single();

      if (channelError || !channel) {
        return NextResponse.json(
          { error: 'Canal de WhatsApp não encontrado para esta conversa.' },
          { status: 400 },
        );
      }

      providerName = channel.provider === 'uazapi' ? 'uazapi' : 'meta';
      phoneNumberId = channel.phone_number_id ?? null;

      if (providerName === 'uazapi') {
        if (!channel.uazapi_instance_token) {
          return NextResponse.json(
            { error: 'Canal por QR Code não conectado.' },
            { status: 400 },
          );
        }
        uazapiToken = decrypt(channel.uazapi_instance_token);
      } else {
        if (!channel.access_token) {
          return NextResponse.json(
            { error: 'Canal do WhatsApp (Meta) não configurado.' },
            { status: 400 },
          );
        }
        accessToken = decrypt(channel.access_token);
      }
    } else {
      const { data: config, error: configError } = await supabase
        .from('whatsapp_config')
        .select('provider, phone_number_id, access_token, uazapi_instance_token')
        .eq('account_id', accountId)
        .single();

      if (configError || !config) {
        return NextResponse.json(
          { error: 'WhatsApp not configured.' },
          { status: 400 },
        );
      }

      providerName = config.provider === 'uazapi' ? 'uazapi' : 'meta';
      phoneNumberId = config.phone_number_id ?? null;

      if (providerName === 'uazapi') {
        if (!config.uazapi_instance_token) {
          return NextResponse.json(
            { error: 'WhatsApp por QR Code não conectado.' },
            { status: 400 },
          );
        }
        uazapiToken = decrypt(config.uazapi_instance_token);
      } else {
        if (!config.access_token) {
          return NextResponse.json(
            { error: 'WhatsApp (Meta) não configurado.' },
            { status: 400 },
          );
        }
        accessToken = decrypt(config.access_token);
      }
    }

    const provider = getProvider({
      provider: providerName,
      phoneNumberId,
      accessToken,
      uazapiToken,
    });

    // Destino: Meta exige E164 sanitizado; uazapi aceita telefone ou, para
    // grupos, o JID reconstruído `<id>@g.us`.
    const to =
      provider.kind === 'meta'
        ? sanitizePhoneForMeta(contact.phone)
        : isGroup
          ? `${contact.phone}@g.us`
          : contact.phone;

    try {
      await provider.sendReaction({
        to,
        targetMessageId: targetMessage.message_id,
        emoji,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown WhatsApp API error';
      console.error('[whatsapp/react] provider send failed:', message);
      return NextResponse.json(
        { error: `WhatsApp API error: ${message}` },
        { status: 502 },
      );
    }

    // Mirror into DB. Empty emoji = removal.
    if (emoji === '') {
      const { error: delError } = await supabase
        .from('message_reactions')
        .delete()
        .eq('message_id', targetMessage.id)
        .eq('actor_type', 'agent')
        .eq('actor_id', user.id);

      if (delError) {
        console.error('[whatsapp/react] DB delete failed:', delError.message);
        return NextResponse.json(
          { error: 'Reaction sent to Meta but DB delete failed' },
          { status: 500 },
        );
      }
    } else {
      // Upsert. The unique constraint (message_id, actor_type, actor_id)
      // lets us swap emoji in a single statement.
      const { error: upsertError } = await supabase.from('message_reactions').upsert(
        {
          message_id: targetMessage.id,
          conversation_id: targetMessage.conversation_id,
          actor_type: 'agent',
          actor_id: user.id,
          emoji,
        },
        { onConflict: 'message_id,actor_type,actor_id' },
      );

      if (upsertError) {
        console.error('[whatsapp/react] DB upsert failed:', upsertError.message);
        return NextResponse.json(
          { error: 'Reaction sent to Meta but DB upsert failed' },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error in WhatsApp react POST:', error);
    return NextResponse.json(
      { error: 'Failed to react to message' },
      { status: 500 },
    );
  }
}
