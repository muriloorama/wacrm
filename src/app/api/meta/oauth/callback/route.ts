// ============================================================
// GET /api/meta/oauth/callback — o Facebook devolve o usuário aqui.
//
// Troca o `code` por um user token longo, lista as páginas que ele
// administra, grava cada uma em `meta_pages` (token cifrado) e assina o
// campo `leadgen` de cada página. É isso que substitui o INSERT manual
// por cliente.
//
// A conta NÃO vem da sessão: vem do `state` assinado emitido no /start.
// Assim o callback não depende de cookie e não pode ser apontado para a
// conta de outro.
//
// Erros voltam para /settings como querystring, porque quem está aqui é
// um navegador, não um cliente de API.
// ============================================================

import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { encrypt } from '@/lib/whatsapp/encryption';
import {
  exchangeCode,
  listPages,
  subscribePageToLeadgen,
  toLongLivedToken,
  verifyState,
} from '@/lib/meta/oauth';

export const dynamic = 'force-dynamic';

function backToSettings(request: Request, params: Record<string, string>) {
  const base = (
    process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin
  ).replace(/\/+$/, '');
  // O painel de settings faz deep-link por `?tab=`, não `?section=`.
  return NextResponse.redirect(
    `${base}/settings?tab=meta&${new URLSearchParams(params)}`,
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);

  // `verifyState` precisa do app secret para conferir o HMAC e LANÇA se ele
  // faltar. Sem esta guarda, um callback com state malformado num ambiente
  // sem a env vira 500 em vez de uma mensagem.
  if (!process.env.META_APP_SECRET) {
    console.error('[meta-oauth] META_APP_SECRET não configurado');
    return backToSettings(request, { meta_error: 'nao_configurado' });
  }

  // O usuário pode ter cancelado no diálogo do Facebook.
  const denied = url.searchParams.get('error');
  if (denied) {
    return backToSettings(request, { meta_error: denied });
  }

  const session = verifyState(url.searchParams.get('state'));
  if (!session) {
    console.warn('[meta-oauth] state inválido ou expirado');
    return backToSettings(request, { meta_error: 'state_invalido' });
  }

  const code = url.searchParams.get('code');
  if (!code) return backToSettings(request, { meta_error: 'sem_code' });

  try {
    const longLived = await toLongLivedToken(await exchangeCode(code, request));
    const pages = await listPages(longLived);

    if (pages.length === 0) {
      return backToSettings(request, { meta_error: 'nenhuma_pagina' });
    }

    const db = supabaseAdmin();
    let connected = 0;
    const failed: string[] = [];

    for (const page of pages) {
      // `page_id` é chave primária global. Sem esta checagem, um admin da
      // conta A que administre uma página já ligada à conta B a puxaria
      // para si num upsert — e os leads dela passariam a cair na conta
      // errada. Reconectar a MESMA conta continua permitido (renova token).
      const { data: owner } = await db
        .from('meta_pages')
        .select('account_id')
        .eq('page_id', page.id)
        .maybeSingle();

      if (owner && owner.account_id !== session.accountId) {
        console.error(
          '[meta-oauth] página já pertence a outra conta:',
          page.id,
        );
        failed.push(`${page.name} (já ligada a outra conta)`);
        continue;
      }

      // Assinar ANTES de gravar: se o Meta recusar, não deixamos uma
      // página no banco que nunca vai receber webhook.
      try {
        await subscribePageToLeadgen(page.id, page.access_token);
      } catch (err) {
        console.error('[meta-oauth] falha ao assinar leadgen:', page.id, err);
        failed.push(page.name);
        continue;
      }

      const { error } = await db.from('meta_pages').upsert(
        {
          page_id: page.id,
          account_id: session.accountId,
          page_name: page.name,
          page_access_token: encrypt(page.access_token),
          created_by: session.userId,
        },
        { onConflict: 'page_id' },
      );

      if (error) {
        console.error('[meta-oauth] falha ao gravar página:', page.id, error);
        failed.push(page.name);
        continue;
      }
      connected++;
    }

    return backToSettings(request, {
      meta_connected: String(connected),
      ...(failed.length > 0 ? { meta_failed: failed.join(', ') } : {}),
    });
  } catch (err) {
    console.error('[meta-oauth] erro no callback:', err);
    return backToSettings(request, { meta_error: 'falha_na_troca' });
  }
}
