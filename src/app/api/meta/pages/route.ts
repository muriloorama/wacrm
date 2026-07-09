// ============================================================
// /api/meta/pages — escolha das páginas após o OAuth.
//
//   GET  ?session=<id>  — lista as páginas que o usuário administra,
//                         marcando as que já pertencem a outra conta.
//   POST { session, pageIds } — conecta APENAS as escolhidas.
//
// Existe porque quem conecta é o gestor de tráfego, que administra as
// páginas de vários clientes. Conectar tudo o que o Facebook devolve
// misturaria os leads de clientes diferentes.
//
// O user token nunca chega ao navegador: fica cifrado na sessão e é
// usado só aqui, no servidor.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { listPages, subscribePageToLeadgen } from '@/lib/meta/oauth';

export const dynamic = 'force-dynamic';

type Admin = ReturnType<typeof supabaseAdmin>;

/**
 * A sessão só vale para quem a criou, na conta em que a criou, e por 15
 * minutos. Sem isso, um id vazado deixaria outro admin usar o token do
 * Facebook de um colega.
 */
async function loadSession(
  db: Admin,
  sessionId: string,
  userId: string,
  accountId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('meta_oauth_sessions')
    .select('user_token, expires_at, user_id, account_id')
    .eq('id', sessionId)
    .maybeSingle();

  if (error) throw new Error(`sessão: ${error.message}`);
  if (!data) return null;
  if (data.user_id !== userId || data.account_id !== accountId) return null;
  if (new Date(data.expires_at as string).getTime() < Date.now()) return null;

  return decrypt(data.user_token as string);
}

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const sessionId = new URL(request.url).searchParams.get('session');
    if (!sessionId) {
      return NextResponse.json({ error: "'session' é obrigatório" }, { status: 400 });
    }

    const db = supabaseAdmin();
    const userToken = await loadSession(db, sessionId, ctx.userId, ctx.accountId);
    if (!userToken) {
      return NextResponse.json(
        { error: 'Sessão de conexão expirada. Clique em Conectar de novo.' },
        { status: 410 },
      );
    }

    const pages = await listPages(userToken);

    // Marca as que já estão em outra conta: aparecem na lista, mas
    // desabilitadas, com o motivo. Melhor que sumir sem explicação.
    const { data: existing } = await db
      .from('meta_pages')
      .select('page_id, account_id')
      .in('page_id', pages.length > 0 ? pages.map((p) => p.id) : ['-']);

    const owners = new Map(
      (existing ?? []).map((r) => [r.page_id as string, r.account_id as string]),
    );

    return NextResponse.json({
      // Devolvido para a tela dizer A QUAL conta a página será ligada.
      // Um gestor alterna entre contas o dia inteiro; conectar a página da
      // Vila Real com o Lourival ativo mandaria os leads para o cliente
      // errado, sem erro nenhum.
      accountName: ctx.account.name,
      pages: pages.map((p) => {
        const owner = owners.get(p.id);
        return {
          id: p.id,
          name: p.name,
          alreadyHere: owner === ctx.accountId,
          takenByOtherAccount: Boolean(owner) && owner !== ctx.accountId,
        };
      }),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const body = (await request.json().catch(() => null)) as {
      session?: unknown;
      pageIds?: unknown;
    } | null;

    const sessionId = typeof body?.session === 'string' ? body.session : null;
    const wanted = Array.isArray(body?.pageIds)
      ? (body.pageIds as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];

    if (!sessionId || wanted.length === 0) {
      return NextResponse.json(
        { error: "Informe 'session' e ao menos uma página" },
        { status: 400 },
      );
    }

    const db = supabaseAdmin();
    const userToken = await loadSession(db, sessionId, ctx.userId, ctx.accountId);
    if (!userToken) {
      return NextResponse.json(
        { error: 'Sessão de conexão expirada. Clique em Conectar de novo.' },
        { status: 410 },
      );
    }

    // A verdade é o Facebook, não o corpo da requisição: só conectamos
    // páginas que ESTE usuário administra de fato.
    const administradas = await listPages(userToken);
    const porId = new Map(administradas.map((p) => [p.id, p]));

    const connected: string[] = [];
    const failed: string[] = [];

    for (const pageId of wanted) {
      const page = porId.get(pageId);
      if (!page) {
        failed.push(`${pageId} (você não administra esta página)`);
        continue;
      }

      // `page_id` é PK global: recusar página de outra conta, senão o
      // upsert a sequestraria e os leads dela cairiam aqui.
      const { data: owner } = await db
        .from('meta_pages')
        .select('account_id')
        .eq('page_id', pageId)
        .maybeSingle();

      if (owner && owner.account_id !== ctx.accountId) {
        failed.push(`${page.name} (já ligada a outra conta)`);
        continue;
      }

      // Assinar ANTES de gravar: página que o Meta recusa não vira linha
      // morta no banco.
      try {
        await subscribePageToLeadgen(page.id, page.access_token);
      } catch (err) {
        console.error('[meta-pages] falha ao assinar leadgen:', page.id, err);
        failed.push(`${page.name} (falha ao assinar o webhook)`);
        continue;
      }

      const { error } = await db.from('meta_pages').upsert(
        {
          page_id: page.id,
          account_id: ctx.accountId,
          page_name: page.name,
          page_access_token: encrypt(page.access_token),
          created_by: ctx.userId,
        },
        { onConflict: 'page_id' },
      );

      if (error) {
        console.error('[meta-pages] falha ao gravar:', page.id, error);
        failed.push(`${page.name} (falha ao gravar)`);
        continue;
      }
      connected.push(page.name);
    }

    // Token de uso único: some assim que a escolha é feita.
    await db.from('meta_oauth_sessions').delete().eq('id', sessionId);

    return NextResponse.json({ connected, failed });
  } catch (err) {
    return toErrorResponse(err);
  }
}
