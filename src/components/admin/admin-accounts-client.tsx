"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface AdminAccount {
  id: string;
  name: string;
  ownerEmail: string | null;
  members: number;
  channels: number;
  max_channels: number;
  max_users: number;
  created_at: string | null;
}

// Estado editável por linha: o que está nos inputs + se está salvando.
interface RowDraft {
  maxChannels: string;
  maxUsers: string;
  saving: boolean;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pt-BR");
}

export function AdminAccountsClient() {
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/accounts", { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? "Falha ao carregar contas");
      }
      const data = (await res.json()) as { accounts: AdminAccount[] };
      setAccounts(data.accounts);
      // Semeia os drafts a partir dos valores salvos.
      const seeded: Record<string, RowDraft> = {};
      for (const a of data.accounts) {
        seeded[a.id] = {
          maxChannels: String(a.max_channels),
          maxUsers: String(a.max_users),
          saving: false,
        };
      }
      setDrafts(seeded);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar contas");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setDraftField = (
    id: string,
    field: "maxChannels" | "maxUsers",
    value: string,
  ) => {
    setDrafts((prev) => ({
      ...prev,
      [id]: { ...prev[id], [field]: value },
    }));
  };

  const save = async (account: AdminAccount) => {
    const draft = drafts[account.id];
    if (!draft) return;

    const maxChannels = Number(draft.maxChannels);
    const maxUsers = Number(draft.maxUsers);

    if (
      !Number.isInteger(maxChannels) ||
      maxChannels < 0 ||
      !Number.isInteger(maxUsers) ||
      maxUsers < 0
    ) {
      toast.error("Limites devem ser inteiros maiores ou iguais a zero");
      return;
    }

    setDrafts((prev) => ({
      ...prev,
      [account.id]: { ...prev[account.id], saving: true },
    }));

    try {
      const res = await fetch("/api/admin/accounts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          max_channels: maxChannels,
          max_users: maxUsers,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? "Falha ao salvar");
      }
      // Reflete os novos limites na tabela sem recarregar tudo.
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === account.id
            ? { ...a, max_channels: maxChannels, max_users: maxUsers }
            : a,
        ),
      );
      toast.success(`Limites de "${account.name}" atualizados`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao salvar");
    } finally {
      setDrafts((prev) => ({
        ...prev,
        [account.id]: { ...prev[account.id], saving: false },
      }));
    }
  };

  if (loading) {
    return (
      <p className="text-sm text-muted-foreground">Carregando contas…</p>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        {error}{" "}
        <button
          type="button"
          onClick={load}
          className="underline underline-offset-2"
        >
          Tentar novamente
        </button>
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">Nenhuma conta encontrada.</p>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Conta</TableHead>
            <TableHead>Proprietário</TableHead>
            <TableHead className="text-center">Membros</TableHead>
            <TableHead className="text-center">Canais</TableHead>
            <TableHead className="text-center">Limite de canais</TableHead>
            <TableHead className="text-center">Limite de usuários</TableHead>
            <TableHead>Criada em</TableHead>
            <TableHead className="text-right">Ações</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {accounts.map((a) => {
            const draft = drafts[a.id];
            const dirty =
              draft &&
              (draft.maxChannels !== String(a.max_channels) ||
                draft.maxUsers !== String(a.max_users));
            return (
              <TableRow key={a.id}>
                <TableCell className="font-medium text-foreground">
                  {a.name}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {a.ownerEmail ?? "—"}
                </TableCell>
                <TableCell className="text-center tabular-nums">
                  {a.members}/{a.max_users}
                </TableCell>
                <TableCell className="text-center tabular-nums">
                  {a.channels}/{a.max_channels}
                </TableCell>
                <TableCell className="text-center">
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    inputMode="numeric"
                    value={draft?.maxChannels ?? ""}
                    onChange={(e) =>
                      setDraftField(a.id, "maxChannels", e.target.value)
                    }
                    className="mx-auto h-8 w-20 text-center"
                    aria-label={`Limite de canais de ${a.name}`}
                  />
                </TableCell>
                <TableCell className="text-center">
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    inputMode="numeric"
                    value={draft?.maxUsers ?? ""}
                    onChange={(e) =>
                      setDraftField(a.id, "maxUsers", e.target.value)
                    }
                    className="mx-auto h-8 w-20 text-center"
                    aria-label={`Limite de usuários de ${a.name}`}
                  />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDate(a.created_at)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    onClick={() => save(a)}
                    disabled={draft?.saving || !dirty}
                  >
                    {draft?.saving ? "Salvando…" : "Salvar"}
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
