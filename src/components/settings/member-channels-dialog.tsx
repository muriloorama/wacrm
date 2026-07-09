'use client';

// ============================================================
// Escolhe quais canais um membro enxerga.
//
// owner/admin veem todos os canais por definição (a RLS nem consulta a
// tabela de atribuição para eles). Então o diálogo abre em modo leitura
// para esses papéis, explicando o porquê — deixar os checkboxes ativos
// ali sugeriria um controle que não existe.
//
// Para agent/viewer vale deny-by-default: nenhum canal marcado =
// nenhum canal visível, e junto some o inbox, os contatos vindos
// daquele canal e os cards do kanban correspondentes.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { Radio } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { AccountRole } from '@/lib/auth/roles';

interface ChannelRow {
  id: string;
  name: string;
  phone: string | null;
  status: string | null;
  assigned: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  memberName: string;
  role: AccountRole;
}

const SEES_EVERYTHING = (role: AccountRole) =>
  role === 'owner' || role === 'admin';

export function MemberChannelsDialog({
  open,
  onOpenChange,
  userId,
  memberName,
  role,
}: Props) {
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/account/members/${userId}/channels`);
      if (!res.ok) throw new Error('falhou');
      const { channels: rows } = (await res.json()) as {
        channels: ChannelRow[];
      };
      setChannels(rows);
      setSelected(new Set(rows.filter((c) => c.assigned).map((c) => c.id)));
    } catch {
      toast.error('Não foi possível carregar os canais');
      onOpenChange(false);
    } finally {
      setLoading(false);
    }
  }, [userId, onOpenChange]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/account/members/${userId}/channels`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelIds: [...selected] }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: '' }));
        throw new Error(error || 'falhou');
      }
      toast.success('Canais atualizados');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao gravar');
    } finally {
      setSaving(false);
    }
  }

  const readOnly = SEES_EVERYTHING(role);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Radio className="size-4 text-primary" />
            Canais de {memberName}
          </DialogTitle>
          <DialogDescription>
            {readOnly
              ? 'Administradores e o proprietário enxergam todos os canais da conta. Para restringir, rebaixe o membro para Agente.'
              : 'Marque os canais que este membro pode ver. Sem nenhum canal marcado, ele não vê conversa alguma.'}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Carregando…
          </p>
        ) : channels.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Esta conta ainda não tem canais.
          </p>
        ) : (
          <ul className="space-y-1 py-2">
            {channels.map((c) => (
              <li key={c.id}>
                <label
                  className={`flex items-center gap-3 rounded-md border border-transparent px-2 py-2 ${
                    readOnly ? 'opacity-60' : 'cursor-pointer hover:bg-muted/60'
                  }`}
                >
                  <Checkbox
                    checked={readOnly ? true : selected.has(c.id)}
                    disabled={readOnly || saving}
                    onCheckedChange={() => toggle(c.id)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {c.name}
                    </span>
                    {c.phone && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {c.phone}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {readOnly ? 'Fechar' : 'Cancelar'}
          </Button>
          {!readOnly && (
            <Button onClick={save} disabled={saving || loading}>
              {saving ? 'Gravando…' : 'Salvar'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
