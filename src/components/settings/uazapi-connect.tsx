'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, QrCode, RefreshCw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

type ConnectState = {
  configured: boolean;
  hasInstance: boolean;
  connected: boolean;
  instanceStatus?: string;
  qrcode?: string;
  paircode?: string;
};

const POLL_INTERVAL_MS = 3000;

type UazapiConnectProps = {
  // Reporta o status da conexão por QR para o componente pai, que o usa
  // para decidir o método de conexão padrão ao abrir o painel.
  onStatusChange?: (state: ConnectState | null) => void;
};

export function UazapiConnect({ onStatusChange }: UazapiConnectProps) {
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [state, setState] = useState<ConnectState | null>(null);
  const [qrcode, setQrcode] = useState('');
  const [paircode, setPaircode] = useState('');
  // Kept in a ref so the polling loop always reads the latest value
  // without re-subscribing the interval on every render.
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Mantém a callback mais recente sem forçar a recriação de fetchStatus.
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const fetchStatus = useCallback(async (): Promise<ConnectState | null> => {
    try {
      const res = await fetch('/api/whatsapp/uazapi/connect', { method: 'GET' });
      const data = (await res.json()) as ConnectState & { error?: string };
      if (!res.ok) {
        toast.error(data.error || 'Falha ao consultar o status da conexão via QR Code.');
        onStatusChangeRef.current?.(null);
        return null;
      }
      setState(data);
      onStatusChangeRef.current?.(data);
      return data;
    } catch (err) {
      console.error('qr status error:', err);
      toast.error('Falha ao consultar o status da conexão via QR Code. Verifique a rede.');
      onStatusChangeRef.current?.(null);
      return null;
    }
  }, []);

  // Initial load: descobre se já existe instância / se está conectado.
  useEffect(() => {
    (async () => {
      setLoadingStatus(true);
      await fetchStatus();
      setLoadingStatus(false);
    })();
    return () => stopPolling();
  }, [fetchStatus, stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollingRef.current = setInterval(async () => {
      const data = await fetchStatus();
      if (data?.connected) {
        stopPolling();
        setQrcode('');
        setPaircode('');
        toast.success('Conectado com sucesso!');
      } else if (data && (data.qrcode || data.paircode)) {
        // O QR/pair code pode ser renovado pelo servidor — mantém o mais recente.
        setQrcode(data.qrcode || '');
        setPaircode(data.paircode || '');
      }
    }, POLL_INTERVAL_MS);
  }, [fetchStatus, stopPolling]);

  async function handleConnect() {
    setConnecting(true);
    setQrcode('');
    setPaircode('');
    try {
      const res = await fetch('/api/whatsapp/uazapi/connect', { method: 'POST' });
      const data = (await res.json()) as {
        qrcode?: string;
        paircode?: string;
        connected?: boolean;
        error?: string;
      };

      if (!res.ok) {
        toast.error(data.error || 'Falha ao gerar o QR Code.');
        return;
      }

      if (data.connected) {
        await fetchStatus();
        toast.success('Já está conectado!');
        return;
      }

      if (data.qrcode) {
        setQrcode(data.qrcode);
        setPaircode('');
      } else if (data.paircode) {
        setPaircode(data.paircode);
        setQrcode('');
      }

      if (data.qrcode || data.paircode) {
        toast.success('Escaneie o QR code com o WhatsApp para conectar.');
        startPolling();
      } else {
        toast.error('O servidor não retornou um QR code. Tente atualizar o status.');
      }
    } catch (err) {
      console.error('qr connect error:', err);
      toast.error('Falha ao gerar o QR Code. Verifique a rede e tente novamente.');
    } finally {
      setConnecting(false);
    }
  }

  async function handleRefresh() {
    setLoadingStatus(true);
    const data = await fetchStatus();
    setLoadingStatus(false);
    if (data?.connected) {
      stopPolling();
      setQrcode('');
      setPaircode('');
    }
  }

  // O provedor não está configurado no servidor — não mostra a seção.
  if (!loadingStatus && state && state.configured === false) {
    return null;
  }

  const connected = Boolean(state?.connected);
  const showQrArea = !connected && (Boolean(qrcode) || Boolean(paircode));

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <CardTitle className="text-foreground">Conexão via QR Code</CardTitle>
            <CardDescription className="text-muted-foreground">
              Conecte um número do WhatsApp escaneando um QR code — sem precisar da
              API oficial da Meta.
            </CardDescription>
          </div>
          {loadingStatus && !state ? (
            <Badge variant="outline" className="gap-1">
              <Loader2 className="size-3 animate-spin" />
              Verificando...
            </Badge>
          ) : connected ? (
            <Badge variant="default" className="gap-1">
              <CheckCircle2 className="size-3" />
              Conectado
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1 text-red-400 border-red-900">
              <XCircle className="size-3" />
              Desconectado
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {connected ? (
          <div className="flex items-center gap-2 rounded-md border border-emerald-700/50 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200">
            <CheckCircle2 className="size-4 text-emerald-400 shrink-0" />
            Conectado com sucesso. Seu número do WhatsApp está pronto para uso.
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Clique em <strong>Gerar QR</strong> e escaneie com o WhatsApp
            (Aparelhos conectados) para vincular seu número.
          </p>
        )}

        {showQrArea && (
          <div className="flex flex-col items-center gap-3 rounded-md border border-border bg-muted/40 p-4">
            {qrcode ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:image/png;base64,${qrcode}`}
                  alt="QR code para conectar o WhatsApp"
                  className="size-56 rounded bg-white p-2"
                />
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  Aguardando a leitura do QR code...
                </p>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Digite este código no seu WhatsApp:
                </p>
                <p className="font-mono text-2xl font-bold tracking-widest text-foreground">
                  {paircode}
                </p>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  Aguardando a confirmação...
                </p>
              </>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          <Button
            onClick={handleConnect}
            disabled={connecting || connected}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {connecting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Gerando QR...
              </>
            ) : (
              <>
                <QrCode className="size-4" />
                {qrcode || paircode ? 'Gerar novo QR' : 'Gerar QR'}
              </>
            )}
          </Button>
          <Button
            variant="outline"
            onClick={handleRefresh}
            disabled={loadingStatus}
            className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
          >
            {loadingStatus ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Atualizando...
              </>
            ) : (
              <>
                <RefreshCw className="size-4" />
                Atualizar status
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
