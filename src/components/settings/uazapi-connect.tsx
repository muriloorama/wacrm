'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  CheckCircle2,
  Loader2,
  Pencil,
  Plus,
  QrCode,
  RefreshCw,
  Smartphone,
  Trash2,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// Um canal de WhatsApp (linha de whatsapp_channels + status ao vivo do provedor).
type Channel = {
  id: string;
  name: string;
  status: string;
  connected: boolean;
  phone?: string | null;
  /** Nome do perfil do WhatsApp conectado (ex.: "Murilo Amaro"). */
  profileName?: string | null;
  qrcode?: string;
  paircode?: string;
};

/** Formata só-dígitos BR em +55 (11) 95555-5555 quando reconhecível. */
function formatPhone(raw?: string | null): string | null {
  if (!raw) return null;
  const d = raw.replace(/\D/g, "");
  const m = d.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  if (m) return `+55 (${m[1]}) ${m[2]}-${m[3]}`;
  return `+${d}`;
}

type ConnectResponse = {
  configured: boolean;
  channels?: Channel[];
  error?: string;
};

// Estado agregado reportado ao componente pai (usado para resolver o método
// de conexão padrão ao abrir o painel de configurações).
type StatusReport = {
  configured: boolean;
  hasInstance: boolean;
  connected: boolean;
};

// Dados do QR/pair code atualmente visível (canal recém-criado ou reconectado).
type QrView = {
  channelId: string;
  name: string;
  qrcode: string;
  paircode: string;
  connected: boolean;
};

const POLL_INTERVAL_MS = 3000;

type UazapiConnectProps = {
  // Reporta o status da conexão por QR para o componente pai, que o usa
  // para decidir o método de conexão padrão ao abrir o painel.
  onStatusChange?: (state: StatusReport | null) => void;
};

export function UazapiConnect({ onStatusChange }: UazapiConnectProps) {
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);

  // Diálogo "Adicionar canal".
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  // Diálogo do QR Code (para canal novo ou reconexão).
  const [qrView, setQrView] = useState<QrView | null>(null);

  // Diálogo "Renomear canal".
  const [renameTarget, setRenameTarget] = useState<Channel | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renaming, setRenaming] = useState(false);

  // Ações por canal em andamento (reconectar/excluir), para desabilitar botões.
  const [busyId, setBusyId] = useState<string | null>(null);

  // O loop de polling lê sempre o valor mais recente via ref, sem recriar o
  // intervalo a cada render.
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qrChannelIdRef = useRef<string | null>(null);
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const report = useCallback((data: ConnectResponse | null) => {
    if (!data) {
      onStatusChangeRef.current?.(null);
      return;
    }
    const list = data.channels ?? [];
    onStatusChangeRef.current?.({
      configured: data.configured,
      hasInstance: list.length > 0,
      connected: list.some((c) => c.connected),
    });
  }, []);

  const fetchChannels = useCallback(async (): Promise<ConnectResponse | null> => {
    try {
      const res = await fetch('/api/whatsapp/uazapi/connect', { method: 'GET' });
      const data = (await res.json()) as ConnectResponse;
      if (!res.ok) {
        toast.error(data.error || 'Falha ao consultar os canais de WhatsApp.');
        report(null);
        return null;
      }
      setConfigured(data.configured);
      setChannels(data.channels ?? []);
      report(data);
      return data;
    } catch (err) {
      console.error('channels status error:', err);
      toast.error('Falha ao consultar os canais. Verifique a rede.');
      report(null);
      return null;
    }
  }, [report]);

  // Carga inicial: lista os canais da conta.
  useEffect(() => {
    (async () => {
      setLoadingStatus(true);
      await fetchChannels();
      setLoadingStatus(false);
    })();
    return () => stopPolling();
  }, [fetchChannels, stopPolling]);

  // Enquanto um QR está visível, faz polling até aquele canal conectar.
  const startPolling = useCallback(
    (channelId: string) => {
      stopPolling();
      qrChannelIdRef.current = channelId;
      pollingRef.current = setInterval(async () => {
        const data = await fetchChannels();
        if (!data) return;
        const target = (data.channels ?? []).find((c) => c.id === channelId);
        if (!target) {
          // Canal sumiu (excluído em outra aba) — encerra o QR.
          stopPolling();
          setQrView(null);
          return;
        }
        if (target.connected) {
          stopPolling();
          setQrView((prev) =>
            prev && prev.channelId === channelId
              ? { ...prev, connected: true }
              : prev,
          );
          toast.success('Canal conectado!');
        } else {
          // O QR/pair code pode ser renovado pelo servidor — mantém o mais recente.
          setQrView((prev) =>
            prev && prev.channelId === channelId
              ? {
                  ...prev,
                  qrcode: target.qrcode || prev.qrcode,
                  paircode: target.paircode || prev.paircode,
                }
              : prev,
          );
        }
      }, POLL_INTERVAL_MS);
    },
    [fetchChannels, stopPolling],
  );

  const openQrFor = useCallback(
    (channelId: string, name: string, qrcode: string, paircode: string) => {
      setQrView({ channelId, name, qrcode, paircode, connected: false });
      startPolling(channelId);
    },
    [startPolling],
  );

  // ---- Adicionar canal ----
  async function handleCreate() {
    const name = newName.trim();
    if (!name) {
      toast.error('Digite um nome para o canal.');
      return;
    }
    setCreating(true);
    try {
      const res = await fetch('/api/whatsapp/uazapi/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = (await res.json()) as {
        channelId?: string;
        qrcode?: string;
        paircode?: string;
        connected?: boolean;
        error?: string;
      };

      if (!res.ok) {
        // 403 → limite de canais atingido (ou sem permissão).
        toast.error(data.error || 'Falha ao criar o canal.');
        return;
      }

      setAddOpen(false);
      setNewName('');
      await fetchChannels();

      if (data.connected) {
        toast.success('Canal conectado!');
        return;
      }
      if (data.channelId && (data.qrcode || data.paircode)) {
        toast.success('Escaneie o QR code com o WhatsApp para conectar.');
        openQrFor(data.channelId, name, data.qrcode || '', data.paircode || '');
      } else {
        toast.error('O servidor não retornou um QR code. Tente reconectar o canal.');
      }
    } catch (err) {
      console.error('create channel error:', err);
      toast.error('Falha ao criar o canal. Verifique a rede e tente novamente.');
    } finally {
      setCreating(false);
    }
  }

  // ---- Reconectar canal (regenera QR) ----
  async function handleReconnect(channel: Channel) {
    setBusyId(channel.id);
    try {
      const res = await fetch('/api/whatsapp/uazapi/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: channel.id }),
      });
      const data = (await res.json()) as {
        channelId?: string;
        qrcode?: string;
        paircode?: string;
        connected?: boolean;
        error?: string;
      };

      if (!res.ok) {
        toast.error(data.error || 'Falha ao reconectar o canal.');
        return;
      }

      if (data.connected) {
        await fetchChannels();
        toast.success('Canal já está conectado!');
        return;
      }
      if (data.qrcode || data.paircode) {
        toast.success('Escaneie o QR code com o WhatsApp para conectar.');
        openQrFor(channel.id, channel.name, data.qrcode || '', data.paircode || '');
      } else {
        toast.error('O servidor não retornou um QR code. Tente novamente.');
      }
    } catch (err) {
      console.error('reconnect channel error:', err);
      toast.error('Falha ao reconectar. Verifique a rede e tente novamente.');
    } finally {
      setBusyId(null);
    }
  }

  // ---- Excluir canal ----
  async function handleDelete(channel: Channel) {
    if (
      !confirm(
        `Excluir o canal "${channel.name}"? Esta ação remove a conexão do WhatsApp deste canal.`,
      )
    ) {
      return;
    }
    setBusyId(channel.id);
    try {
      const res = await fetch('/api/whatsapp/uazapi/connect', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: channel.id }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        toast.error(data.error || 'Falha ao excluir o canal.');
        return;
      }
      // Se o QR aberto era deste canal, encerra.
      if (qrChannelIdRef.current === channel.id) {
        stopPolling();
        setQrView(null);
      }
      toast.success('Canal excluído.');
      await fetchChannels();
    } catch (err) {
      console.error('delete channel error:', err);
      toast.error('Falha ao excluir o canal. Verifique a rede e tente novamente.');
    } finally {
      setBusyId(null);
    }
  }

  // ---- Renomear canal ----
  function openRename(channel: Channel) {
    setRenameTarget(channel);
    setRenameName(channel.name);
  }

  async function handleRename() {
    if (!renameTarget) return;
    const name = renameName.trim();
    if (!name) {
      toast.error('Digite um nome para o canal.');
      return;
    }
    if (name === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    setRenaming(true);
    try {
      const res = await fetch('/api/whatsapp/uazapi/connect', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: renameTarget.id, name }),
      });
      const data = (await res.json()) as { channel?: Channel; error?: string };
      if (!res.ok) {
        toast.error(data.error || 'Falha ao renomear o canal.');
        return;
      }
      setRenameTarget(null);
      setRenameName('');
      await fetchChannels();
      toast.success('Canal renomeado.');
    } catch (err) {
      console.error('rename channel error:', err);
      toast.error('Falha ao renomear. Verifique a rede e tente novamente.');
    } finally {
      setRenaming(false);
    }
  }

  function handleCloseQr() {
    stopPolling();
    qrChannelIdRef.current = null;
    setQrView(null);
    void fetchChannels();
  }

  // O provedor não está configurado no servidor — não renderiza nada.
  if (!loadingStatus && configured === false) {
    return null;
  }

  const qrSrc = (qr: string) =>
    qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <CardTitle className="text-foreground">
              Canais de WhatsApp (QR Code)
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              Conecte um ou mais números do WhatsApp escaneando um QR code — cada
              canal funciona como uma caixa de entrada separada.
            </CardDescription>
          </div>
          <Button
            onClick={() => {
              setNewName('');
              setAddOpen(true);
            }}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            <Plus className="size-4" />
            Adicionar canal
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {loadingStatus && configured === null ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        ) : channels.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center">
            <QrCode className="mx-auto mb-2 size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Nenhum canal ainda. Clique em <strong>Adicionar canal</strong> para
              conectar um número do WhatsApp.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {channels.map((channel) => (
              <li
                key={channel.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2.5"
              >
                <div className="flex min-w-0 items-center gap-3">
                  {/* Avatar/ícone com estado de conexão sobreposto. */}
                  <div className="relative shrink-0">
                    <div
                      className={cn(
                        "flex size-10 items-center justify-center rounded-full",
                        channel.connected
                          ? "bg-emerald-500/15 text-emerald-500"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      <Smartphone className="size-5" />
                    </div>
                    <span
                      className={cn(
                        "absolute -bottom-0.5 -right-0.5 size-3 rounded-full ring-2 ring-card",
                        channel.connected ? "bg-emerald-500" : "bg-red-500",
                      )}
                      aria-hidden
                    />
                  </div>

                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-foreground">
                        {channel.name}
                      </span>
                      {channel.connected ? (
                        <Badge variant="default" className="gap-1">
                          <CheckCircle2 className="size-3" />
                          Conectado
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="gap-1 text-red-400 border-red-900"
                        >
                          <XCircle className="size-3" />
                          Desconectado
                        </Badge>
                      )}
                    </div>
                    {/* Linha 2: perfil do WhatsApp. Linha 3: número (em linha
                        própria, sem truncar — senão nomes longos cobrem o
                        telefone). */}
                    {channel.profileName && (
                      <p className="mt-0.5 truncate text-xs text-foreground/80">
                        {channel.profileName}
                      </p>
                    )}
                    {formatPhone(channel.phone) ? (
                      <p className="text-xs text-muted-foreground">
                        {formatPhone(channel.phone)}
                      </p>
                    ) : !channel.profileName ? (
                      <p className="mt-0.5 text-xs italic text-muted-foreground">
                        Aguardando conexão…
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openRename(channel)}
                    disabled={busyId === channel.id}
                    aria-label="Renomear canal"
                    title="Renomear canal"
                    className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleReconnect(channel)}
                    disabled={busyId === channel.id}
                    className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                  >
                    {busyId === channel.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <RefreshCw className="size-4" />
                    )}
                    Reconectar
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDelete(channel)}
                    disabled={busyId === channel.id}
                    className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
                  >
                    <Trash2 className="size-4" />
                    Excluir
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {/* Diálogo: adicionar canal (pede o nome) */}
      <Dialog open={addOpen} onOpenChange={(o) => !creating && setAddOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adicionar canal</DialogTitle>
            <DialogDescription>
              Dê um nome para identificar este canal (ex.: &quot;Vendas&quot;,
              &quot;Suporte&quot;).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !creating) {
                  e.preventDefault();
                  handleCreate();
                }
              }}
              placeholder="Nome do canal"
              maxLength={60}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAddOpen(false)}
              disabled={creating}
              className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              Cancelar
            </Button>
            <Button
              onClick={handleCreate}
              disabled={creating}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {creating ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Criando...
                </>
              ) : (
                <>
                  <QrCode className="size-4" />
                  Criar e gerar QR
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Diálogo: renomear canal */}
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(o) => {
          if (!o && !renaming) setRenameTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Renomear canal</DialogTitle>
            <DialogDescription>
              Escolha um novo nome para identificar esta caixa de entrada.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input
              autoFocus
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !renaming) {
                  e.preventDefault();
                  handleRename();
                }
              }}
              placeholder="Nome do canal"
              maxLength={60}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenameTarget(null)}
              disabled={renaming}
              className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              Cancelar
            </Button>
            <Button
              onClick={handleRename}
              disabled={renaming}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {renaming ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Salvando...
                </>
              ) : (
                'Salvar'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Diálogo: QR Code (canal novo ou reconexão) */}
      <Dialog
        open={qrView !== null}
        onOpenChange={(o) => {
          if (!o) handleCloseQr();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{qrView?.name ?? 'Conectar canal'}</DialogTitle>
            <DialogDescription>
              {qrView?.connected
                ? 'Canal conectado com sucesso.'
                : 'Abra o WhatsApp no celular → Aparelhos conectados → Conectar um aparelho e escaneie o código.'}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col items-center gap-3 py-2">
            {qrView?.connected ? (
              <div className="flex items-center gap-2 rounded-md border border-emerald-700/50 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200">
                <CheckCircle2 className="size-4 text-emerald-400 shrink-0" />
                Canal conectado. Seu número do WhatsApp está pronto para uso.
              </div>
            ) : qrView?.qrcode ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qrSrc(qrView.qrcode)}
                  alt="QR code para conectar o WhatsApp"
                  className="size-56 rounded bg-white p-2"
                />
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  Aguardando a leitura do QR code...
                </p>
              </>
            ) : qrView?.paircode ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Digite este código no seu WhatsApp:
                </p>
                <p className="font-mono text-2xl font-bold tracking-widest text-foreground">
                  {qrView.paircode}
                </p>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  Aguardando a confirmação...
                </p>
              </>
            ) : (
              <div className="flex items-center py-6">
                <Loader2 className="size-5 animate-spin text-primary" />
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleCloseQr}
              className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              {qrView?.connected ? 'Fechar' : 'Cancelar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
