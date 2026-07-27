'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, KeyRound } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';

const MIN_PASSWORD = 8;

export function PasswordForm() {
  const supabase = createClient();

  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next.length < MIN_PASSWORD) {
      setConfirmError(`A senha deve ter pelo menos ${MIN_PASSWORD} caracteres`);
      return;
    }
    if (next !== confirm) {
      setConfirmError('A nova senha e a confirmação não coincidem');
      return;
    }
    setConfirmError(null);
    setSaving(true);

    try {
      // A sessão já autentica o usuário — não pedimos a senha atual.
      const { error: updateError } = await supabase.auth.updateUser({
        password: next,
      });
      if (updateError) {
        toast.error(`Falha ao atualizar a senha: ${updateError.message}`);
        return;
      }

      setNext('');
      setConfirm('');
      toast.success('Senha atualizada');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro desconhecido';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <KeyRound className="size-4 text-primary" />
          Senha
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          Use pelo menos {MIN_PASSWORD} caracteres. Você continuará conectado
          neste dispositivo após alterá-la.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="new-password" className="text-foreground">
                Nova senha
              </Label>
              <Input
                id="new-password"
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
                minLength={MIN_PASSWORD}
                disabled={saving}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password" className="text-foreground">
                Confirmar nova senha
              </Label>
              <Input
                id="confirm-password"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                minLength={MIN_PASSWORD}
                disabled={saving}
                required
              />
            </div>
          </div>

          {confirmError && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {confirmError}
            </p>
          )}

          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={saving || !next || !confirm}
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Atualizando…
                </>
              ) : (
                'Atualizar senha'
              )}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
