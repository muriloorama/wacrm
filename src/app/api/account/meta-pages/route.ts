// ============================================================
// /api/account/meta-pages
//
//   GET    — páginas do Meta conectadas à conta.        Admin+.
//   DELETE — desconecta uma página (?page_id=...).      Admin+.
//
// O token nunca sai daqui: a resposta diz apenas que existe.
// Não há POST: só o callback de OAuth grava, depois de o Meta confirmar
// que o usuário administra a página.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const ctx = await requireRole('admin');

    const { data, error } = await ctx.supabase
      .from('meta_pages')
      .select('page_id, page_name, created_at')
      .eq('account_id', ctx.accountId)
      .order('created_at');

    if (error) {
      console.error('[meta-pages GET]', error);
      return NextResponse.json(
        { error: 'Falha ao carregar páginas' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      pages: data ?? [],
      configured: Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const pageId = new URL(request.url).searchParams.get('page_id');
    if (!pageId) {
      return NextResponse.json({ error: "'page_id' é obrigatório" }, { status: 400 });
    }

    const { error } = await ctx.supabase
      .from('meta_pages')
      .delete()
      .eq('account_id', ctx.accountId)
      .eq('page_id', pageId);

    if (error) {
      console.error('[meta-pages DELETE]', error);
      return NextResponse.json({ error: 'Falha ao desconectar' }, { status: 500 });
    }

    // Não removemos a assinatura no Meta: se a página for reconectada a
    // esta mesma conta, ela volta a funcionar; e se for para outra conta,
    // o callback reassina. Um lead que chegue nesse intervalo cai em
    // "page_id sem conta mapeada" e é registrado no log.
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
