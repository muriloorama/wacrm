"use client";

import { useState } from "react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NONE = "__none__";

/**
 * Seletor da ORIGEM de um contato (de onde veio o lead). As opções vêm de
 * `account.origens` (configuráveis por conta); grava em `contacts.origem`.
 * Some quando a conta não tem origens configuradas.
 */
export function OrigemSelect({
  contactId,
  value,
}: {
  contactId: string;
  value: string | null | undefined;
}) {
  const { account } = useAuth();
  const origens = account?.origens ?? [];
  const [origem, setOrigem] = useState<string | null>(value ?? null);
  const [saving, setSaving] = useState(false);

  if (origens.length === 0) return null;

  // Base UI Select precisa do mapa value→rótulo para o trigger mostrar o nome.
  const items: Record<string, string> = {
    [NONE]: "Sem origem",
    ...Object.fromEntries(origens.map((o) => [o.id, o.label])),
  };

  const handleChange = async (v: string | null) => {
    const next = !v || v === NONE ? null : v;
    const prev = origem;
    setOrigem(next);
    setSaving(true);
    const supabase = createClient();
    const { error } = await supabase
      .from("contacts")
      .update({ origem: next })
      .eq("id", contactId);
    setSaving(false);
    if (error) {
      setOrigem(prev);
      toast.error("Falha ao salvar a origem");
    }
  };

  const current = origens.find((o) => o.id === origem);

  return (
    <Select
      value={origem ?? NONE}
      onValueChange={handleChange}
      items={items}
      disabled={saving}
    >
      <SelectTrigger className="h-8 w-full border-border bg-muted text-sm text-foreground">
        <span className="flex items-center gap-2">
          {current && (
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: current.color }}
            />
          )}
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectContent className="border-border bg-popover">
        <SelectItem value={NONE}>Sem origem</SelectItem>
        {origens.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            <span className="flex items-center gap-2">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: o.color }}
              />
              {o.label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
