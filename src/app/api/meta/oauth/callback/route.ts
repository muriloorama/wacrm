// ============================================================
// GET /api/meta/oauth/callback — o Facebook devolve o usuário aqui.
//
// NÃO conecta nada. Troca o `code` por um user token longo, guarda-o
// cifrado numa sessão de 15 min e manda o navegador para a tela de
// escolha das páginas.
//
// Por que não conectar direto: quem conecta é o gestor de tráfego, e ele
// administra as páginas de vários clientes. Conectar tudo o que o
// Facebook devolve ligaria as páginas dos outros clientes a esta conta —
// e os leads deles cairiam aqui.
//
// A conta NÃO vem da sessão do CRM: vem do `state` assinado emitido no
// /start. Assim o callback não depende de cookie e não pode ser apontado
// para a conta de outro.
// ============================================================

import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { encrypt } from '@/lib/whatsapp/encryption';
import { exchangeCode, toLongLivedToken, verifyState } from '@/lib/meta/oauth';

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
  if (denied) return backToSettings(request, { meta_error: denied });

  const session = verifyState(url.searchParams.get('state'));
  if (!session) {
    console.warn('[meta-oauth] state inválido ou expirado');
    return backToSettings(request, { meta_error: 'state_invalido' });
  }

  const code = url.searchParams.get('code');
  if (!code) return backToSettings(request, { meta_error: 'sem_code' });

  try {
    const longLived = await toLongLivedToken(await exchangeCode(code, request));

    const db = supabaseAdmin();
    const { data, error } = await db
      .from('meta_oauth_sessions')
      .insert({
        account_id: session.accountId,
        user_id: session.userId,
        user_token: encrypt(longLived),
      })
      .select('id')
      .single();

    if (error || !data) {
      console.error('[meta-oauth] falha ao gravar sessão:', error);
      return backToSettings(request, { meta_error: 'falha_na_sessao' });
    }

    return backToSettings(request, { meta_session: data.id as string });
  } catch (err) {
    console.error('[meta-oauth] erro no callback:', err);
    return backToSettings(request, { meta_error: 'falha_na_troca' });
  }
}
