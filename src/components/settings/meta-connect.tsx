'use client';

// ============================================================
// Conectar páginas do Facebook para receber leads de formulário
// instantâneo (Lead Ads).
//
// Um clique manda para o diálogo do Meta; na volta, o CRM já gravou a
// página e assinou o webhook. Não há campo de token: o admin nunca
// precisa copiar segredo nenhum.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ClipboardList, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';

interface Page {
  page_id: string;
  page_name: string | null;
  created_at: string;
}

export function MetaConnect() {
  const [pages, setPages] = useState<Page[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const params = useSearchParams();

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/account/meta-pages');
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { pages: Page[]; configured: boolean };
      setPages(data.pages);
      setConfigured(data.configured);
    } catch {
      toast.error('Falha ao carregar as páginas conectadas');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Retorno do OAuth: o callback devolve o resultado na querystring.
  useEffect(() => {
    const connected = params.get('meta_connected');
    const failed = params.get('meta_failed');
    const error = params.get('meta_error');

    if (connected) {
      const n = Number(connected);
      if (n > 0) toast.success(`${n} página(s) conectada(s)`);
      else if (!failed) toast.error('Nenhuma página foi conectada');
    }
    if (failed) toast.error(`Não conectou: ${failed}`);
    if (error) {
      const msgs: Record<string, string> = {
        nao_configurado: 'A integração com o Meta não está configurada neste ambiente.',
        state_invalido: 'A sessão de conexão expirou. Tente de novo.',
        nenhuma_pagina: 'Sua conta do Facebook não administra nenhuma página.',
        sem_code: 'O Facebook não devolveu o código de autorização.',
        falha_na_troca: 'Falha ao trocar o código com o Facebook.',
        access_denied: 'Você cancelou a autorização.',
      };
      toast.error(msgs[error] ?? `Erro do Facebook: ${error}`);
    }
  }, [params]);

  async function disconnect(page: Page) {
    setBusy(page.page_id);
    try {
      const res = await fetch(
        `/api/account/meta-pages?page_id=${encodeURIComponent(page.page_id)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error();
      setPages((prev) => prev.filter((p) => p.page_id !== page.page_id));
      toast.success('Página desconectada');
    } catch {
      toast.error('Falha ao desconectar');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <SettingsPanelHead
        title="Formulários do Meta"
        description="Conecte a página do Facebook para que os leads do formulário instantâneo entrem direto no CRM."
      />

      {!configured && (
        <Card>
          <CardContent className="py-4 text-sm text-muted-foreground">
            A integração com o Meta não está configurada neste ambiente
            (faltam <code>META_APP_ID</code> e <code>META_APP_SECRET</code>).
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-4 py-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">Carregando…</p>
          ) : pages.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhuma página conectada. Ao conectar, o CRM assina o webhook de
              leads da página automaticamente.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {pages.map((p) => (
                <li
                  key={p.page_id}
                  className="flex items-center justify-between gap-3 py-2.5"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {p.page_name || p.page_id}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      ID {p.page_id}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy === p.page_id}
                    onClick={() => disconnect(p)}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="size-4" />
                    Desconectar
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <Button
            disabled={!configured}
            onClick={() => {
              window.location.href = '/api/meta/oauth/start';
            }}
          >
            <ClipboardList className="size-4" />
            {pages.length > 0 ? 'Conectar outra página' : 'Conectar Facebook'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
