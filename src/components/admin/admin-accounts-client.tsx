"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, Loader2, LogIn, LogOut, Plus, Trash2 } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  isMember: boolean;
}

// Estado editável por linha: o que está nos inputs + se está salvando.
interface RowDraft {
  name: string;
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
  const { switchAccount, accountId } = useAuth();
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Conta em que uma ação de entrar/sair está em curso (desabilita o botão).
  const [membershipBusy, setMembershipBusy] = useState<string | null>(null);

  // Diálogo "Criar conta".
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newOwnerEmail, setNewOwnerEmail] = useState("");
  const [newMaxChannels, setNewMaxChannels] = useState("2");
  const [newMaxUsers, setNewMaxUsers] = useState("5");
  const [creating, setCreating] = useState(false);
  // Senha temporária do dono recém-criado, mostrada 1x após criar a conta.
  const [tempPassword, setTempPassword] = useState<{
    email: string;
    password: string;
  } | null>(null);
  // Exclusão de conta (destrutivo): exige digitar o nome para confirmar.
  const [deleteTarget, setDeleteTarget] = useState<AdminAccount | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);

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
          name: a.name,
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
    field: "name" | "maxChannels" | "maxUsers",
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

    const name = draft.name.trim();
    const maxChannels = Number(draft.maxChannels);
    const maxUsers = Number(draft.maxUsers);

    if (!name) {
      toast.error("O nome da conta não pode ficar vazio");
      return;
    }
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
          name,
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
      // Reflete nome + limites na tabela sem recarregar tudo.
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === account.id
            ? { ...a, name, max_channels: maxChannels, max_users: maxUsers }
            : a,
        ),
      );
      toast.success(`Conta "${name}" atualizada`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao salvar");
    } finally {
      setDrafts((prev) => ({
        ...prev,
        [account.id]: { ...prev[account.id], saving: false },
      }));
    }
  };

  // Entra (POST) ou sai (DELETE) de uma conta como super admin. Ao entrar,
  // troca imediatamente para ela (switchAccount recarrega a app na conta).
  const toggleMembership = async (account: AdminAccount) => {
    setMembershipBusy(account.id);
    try {
      const res = await fetch(
        `/api/admin/accounts/${encodeURIComponent(account.id)}/membership`,
        { method: account.isMember ? "DELETE" : "POST" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? "Falha na operação");
      }
      if (account.isMember) {
        // Saiu: reflete na tabela. Se era a conta ativa, recarrega para
        // sair do contexto dela.
        setAccounts((prev) =>
          prev.map((a) => (a.id === account.id ? { ...a, isMember: false } : a)),
        );
        toast.success(`Você saiu de "${account.name}"`);
        if (accountId === account.id) window.location.href = "/dashboard";
      } else {
        toast.success(`Entrando em "${account.name}"…`);
        await switchAccount(account.id);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha na operação");
    } finally {
      setMembershipBusy(null);
    }
  };

  const handleCreate = async () => {
    const name = newName.trim();
    const ownerEmail = newOwnerEmail.trim();
    if (!name) {
      toast.error("Digite o nome da conta.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
      toast.error("Digite um e-mail de dono válido.");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/admin/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          ownerEmail,
          max_channels: Number(newMaxChannels) || 0,
          max_users: Number(newMaxUsers) || 0,
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        tempPassword?: string | null;
      } | null;
      if (!res.ok) {
        throw new Error(body?.error ?? "Falha ao criar a conta");
      }
      setCreateOpen(false);
      setNewName("");
      setNewOwnerEmail("");
      setNewMaxChannels("2");
      setNewMaxUsers("5");
      // Se um usuário novo foi criado, mostra a senha temporária 1x.
      if (body?.tempPassword) {
        setTempPassword({ email: ownerEmail, password: body.tempPassword });
      }
      toast.success(`Conta "${name}" criada`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao criar a conta");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/admin/accounts/${encodeURIComponent(deleteTarget.id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? "Falha ao excluir");
      }
      setAccounts((prev) => prev.filter((a) => a.id !== deleteTarget.id));
      toast.success(`Conta "${deleteTarget.name}" excluída`);
      setDeleteTarget(null);
      setDeleteConfirm("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao excluir");
    } finally {
      setDeleting(false);
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

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          Criar conta
        </Button>
      </div>

      {accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nenhuma conta encontrada.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
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
              (draft.name.trim() !== a.name ||
                draft.maxChannels !== String(a.max_channels) ||
                draft.maxUsers !== String(a.max_users));
            return (
              <TableRow key={a.id}>
                <TableCell className="font-medium text-foreground">
                  <Input
                    value={draft?.name ?? ""}
                    onChange={(e) => setDraftField(a.id, "name", e.target.value)}
                    maxLength={80}
                    className="h-8 min-w-40"
                    aria-label={`Nome da conta ${a.name}`}
                  />
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
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      size="sm"
                      variant={a.isMember ? "outline" : "secondary"}
                      onClick={() => toggleMembership(a)}
                      disabled={membershipBusy === a.id}
                      title={
                        a.isMember
                          ? "Sair desta conta"
                          : "Entrar e operar nesta conta"
                      }
                    >
                      {a.isMember ? (
                        <>
                          <LogOut className="size-3.5" />
                          Sair
                        </>
                      ) : (
                        <>
                          <LogIn className="size-3.5" />
                          Entrar
                        </>
                      )}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => save(a)}
                      disabled={draft?.saving || !dirty}
                    >
                      {draft?.saving ? "Salvando…" : "Salvar"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setDeleteConfirm("");
                        setDeleteTarget(a);
                      }}
                      title="Excluir conta"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
        </div>
      )}

      {/* Diálogo: criar conta */}
      <Dialog open={createOpen} onOpenChange={(o) => !creating && setCreateOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Criar conta</DialogTitle>
            <DialogDescription>
              Cria um novo workspace e define o dono pelo e-mail. Se o e-mail
              ainda não tiver login, criamos um e mostramos a senha temporária.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-account-name">Nome da conta</Label>
              <Input
                id="new-account-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Empresa do Cliente"
                maxLength={80}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-owner-email">E-mail do dono</Label>
              <Input
                id="new-owner-email"
                type="email"
                value={newOwnerEmail}
                onChange={(e) => setNewOwnerEmail(e.target.value)}
                placeholder="dono@empresa.com"
              />
            </div>
            <div className="flex gap-3">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="new-max-channels">Limite de canais</Label>
                <Input
                  id="new-max-channels"
                  type="number"
                  min={0}
                  value={newMaxChannels}
                  onChange={(e) => setNewMaxChannels(e.target.value)}
                />
              </div>
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="new-max-users">Limite de usuários</Label>
                <Input
                  id="new-max-users"
                  type="number"
                  min={0}
                  value={newMaxUsers}
                  onChange={(e) => setNewMaxUsers(e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              Cancelar
            </Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Criando…
                </>
              ) : (
                <>
                  <Plus className="size-4" />
                  Criar conta
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Diálogo: senha temporária do dono recém-criado (mostrada 1x) */}
      <Dialog
        open={tempPassword !== null}
        onOpenChange={(o) => {
          if (!o) setTempPassword(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Conta criada — senha temporária</DialogTitle>
            <DialogDescription>
              Repasse estes dados ao dono. A senha aparece só desta vez; ele
              pode trocá-la depois no Perfil.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 rounded-lg border border-border bg-muted p-3 text-sm">
            <p>
              <span className="text-muted-foreground">E-mail: </span>
              <span className="font-medium text-foreground">
                {tempPassword?.email}
              </span>
            </p>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Senha: </span>
              <code className="rounded bg-background px-2 py-1 font-mono text-foreground">
                {tempPassword?.password}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (tempPassword) {
                    void navigator.clipboard?.writeText(tempPassword.password);
                    toast.success("Senha copiada");
                  }
                }}
              >
                <Copy className="size-3.5" />
                Copiar
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setTempPassword(null)}>Entendi</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Diálogo: excluir conta (destrutivo — exige digitar o nome) */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o && !deleting) {
            setDeleteTarget(null);
            setDeleteConfirm("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">
              Excluir conta
            </DialogTitle>
            <DialogDescription>
              Isto apaga <strong>permanentemente</strong> a conta{" "}
              <strong>{deleteTarget?.name}</strong> e TODOS os seus dados
              (contatos, conversas, mensagens, negócios, funis e canais). Os
              usuários (logins) NÃO são apagados. Esta ação é irreversível.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="del-confirm">
              Para confirmar, digite o nome da conta:{" "}
              <span className="font-mono text-foreground">
                {deleteTarget?.name}
              </span>
            </Label>
            <Input
              id="del-confirm"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder={deleteTarget?.name}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleteTarget(null);
                setDeleteConfirm("");
              }}
              disabled={deleting}
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={
                deleting || deleteConfirm.trim() !== deleteTarget?.name.trim()
              }
            >
              {deleting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Excluindo…
                </>
              ) : (
                <>
                  <Trash2 className="size-4" />
                  Excluir tudo
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
