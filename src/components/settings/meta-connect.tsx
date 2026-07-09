'use client';

// ============================================================
// Conectar páginas do Facebook para receber leads de formulário
// instantâneo (Lead Ads).
//
// Duas etapas, de propósito:
//   1. "Conectar Facebook" → OAuth → volta com `?meta_session=<id>`;
//   2. escolha explícita de QUAIS páginas conectar.
//
// A etapa 2 existe porque quem conecta costuma ser o gestor de tráfego,
// que administra as páginas de vários clientes. Conectar tudo o que o
// Facebook devolve ligaria as páginas dos outros clientes a esta conta.
// Nada vem marcado por padrão.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { ClipboardList, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';

interface Page {
  page_id: string;
  page_name: string | null;
  created_at: string;
}

interface Choice {
  id: string;
  name: string;
  alreadyHere: boolean;
  takenByOtherAccount: boolean;
}

export function MetaConnect() {
  const [pages, setPages] = useState<Page[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  // Etapa 2: só existe logo após o retorno do OAuth.
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

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

  // Retorno do OAuth.
  //
  // Lido de `window.location` de propósito, e não com `useSearchParams`:
  // esse hook SUSPENDE a árvore até o `Suspense` mais próximo, e não há um
  // aqui — o painel inteiro travava.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const session = params.get('meta_session');
    const error = params.get('meta_error');

    if (error) {
      const msgs: Record<string, string> = {
        nao_configurado: 'A integração com o Meta não está configurada neste ambiente.',
        state_invalido: 'A sessão de conexão expirou. Tente de novo.',
        sem_code: 'O Facebook não devolveu o código de autorização.',
        falha_na_troca: 'Falha ao trocar o código com o Facebook.',
        falha_na_sessao: 'Falha ao iniciar a escolha de páginas.',
        access_denied: 'Você cancelou a autorização.',
      };
      toast.error(msgs[error] ?? `Erro do Facebook: ${error}`);
    }

    if (session) setSessionId(session);

    if (session || error) {
      window.history.replaceState({}, '', '/settings?tab=meta');
    }
  }, []);

  // Carrega as páginas administradas assim que a sessão aparece.
  useEffect(() => {
    if (!sessionId) return;
    (async () => {
      try {
        const res = await fetch(`/api/meta/pages?session=${sessionId}`);
        if (!res.ok) {
          const { error } = await res.json().catch(() => ({ error: '' }));
          throw new Error(error || 'Falha ao listar páginas');
        }
        const { pages: rows } = (await res.json()) as { pages: Choice[] };
        setChoices(rows);
        setPicked(new Set());
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Falha ao listar páginas');
        setSessionId(null);
      }
    })();
  }, [sessionId]);

  async function connectPicked() {
    if (!sessionId || picked.size === 0) return;
    setSaving(true);
    try {
      const res = await fetch('/api/meta/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: sessionId, pageIds: [...picked] }),
      });
      const data = (await res.json()) as {
        connected?: string[];
        failed?: string[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || 'Falha ao conectar');

      if (data.connected?.length) {
        toast.success(`Conectada(s): ${data.connected.join(', ')}`);
      }
      if (data.failed?.length) {
        toast.error(`Não conectou: ${data.failed.join('; ')}`);
      }
      setSessionId(null);
      setChoices(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao conectar');
    } finally {
      setSaving(false);
    }
  }

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

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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

      {/* Etapa 2 — escolha. */}
      {choices && (
        <Card className="border-primary/40">
          <CardContent className="space-y-4 py-4">
            <div>
              <p className="text-sm font-medium">
                Escolha as páginas desta conta
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Só as marcadas serão conectadas. Se você administra páginas de
                outros clientes, deixe-as desmarcadas — elas ficariam ligadas a
                esta conta e os leads delas cairiam aqui.
              </p>
            </div>

            {choices.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Sua conta do Facebook não administra nenhuma página.
              </p>
            ) : (
              <ul className="space-y-1">
                {choices.map((c) => {
                  const bloqueada = c.takenByOtherAccount;
                  return (
                    <li key={c.id}>
                      <label
                        className={`flex items-center gap-3 rounded-md px-2 py-2 ${
                          bloqueada ? 'opacity-60' : 'cursor-pointer hover:bg-muted/60'
                        }`}
                      >
                        <Checkbox
                          checked={picked.has(c.id)}
                          disabled={bloqueada || saving}
                          onCheckedChange={() => toggle(c.id)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {c.name}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {bloqueada
                              ? 'Já conectada a outra conta'
                              : c.alreadyHere
                                ? 'Já conectada aqui — reconectar renova o token'
                                : `ID ${c.id}`}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="flex gap-2">
              <Button
                onClick={connectPicked}
                disabled={saving || picked.size === 0}
              >
                {saving
                  ? 'Conectando…'
                  : `Conectar ${picked.size || ''} selecionada(s)`}
              </Button>
              <Button
                variant="outline"
                disabled={saving}
                onClick={() => {
                  setChoices(null);
                  setSessionId(null);
                }}
              >
                Cancelar
              </Button>
            </div>
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
