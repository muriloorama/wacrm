"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  Check,
  ImageUp,
  Loader2,
  Moon,
  Palette,
  Pipette,
  SunMoon,
  Sun,
  Trash2,
} from "lucide-react";

import { useTheme } from "@/hooks/use-theme";
import { useAuth } from "@/hooks/use-auth";
import { uploadAccountMedia } from "@/lib/storage/upload-media";
import { MODES, THEMES, type Mode, type ThemeId } from "@/lib/themes";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SettingsPanelHead } from "./settings-panel-head";

const LOGO_MAX_BYTES = 1024 * 1024; // 1 MB
const LOGO_MIME = new Set(["image/png", "image/webp", "image/svg+xml"]);

/**
 * Appearance panel — light/dark mode + accent-color picker.
 *
 * Two independent controls: a mode toggle (light / dark) and the
 * accent grid. Either applies + persists immediately. No save button:
 * each change is a single attribute swap on <html>, there's nothing
 * to roll back.
 *
 * Persistence: localStorage only (device-scoped). The boot script in
 * layout.tsx replays both choices before first paint on subsequent
 * loads.
 */
export function AppearancePanel() {
  const { theme, setTheme, mode, setMode, accent, setAccent } = useTheme();
  // Cor inicial do seletor quando ainda não há cor personalizada: o swatch
  // do preset atual (aproximado por um hex neutro, já que o preset é oklch).
  const pickerValue = accent ?? "#7c3aed";
  return (
    <section className="max-w-3xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Aparência"
        description="Defina o modo e a cor de destaque usados em todo o app. Salvo neste dispositivo — experimente, muda ao vivo."
      />

      <div className="space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <SunMoon className="size-4 text-muted-foreground" />
          Modo
        </h3>

        <div
          role="radiogroup"
          aria-label="Modo de cor"
          className="grid max-w-md grid-cols-2 gap-3"
        >
          {MODES.map((m) => (
            <ModeCard
              key={m}
              mode={m}
              isActive={m === mode}
              onPick={() => setMode(m)}
            />
          ))}
        </div>
      </div>

      <div className="mt-8 space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Palette className="size-4 text-muted-foreground" />
          Cor de destaque
        </h3>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {THEMES.map((t) => (
            <ThemeCard
              key={t.id}
              id={t.id}
              name={t.name}
              tagline={t.tagline}
              swatch={t.swatch}
              // Um preset só está "ativo" se não houver cor personalizada
              // sobrescrevendo. Escolher um preset limpa a cor custom.
              isActive={t.id === theme && !accent}
              onPick={() => {
                setAccent(null);
                setTheme(t.id);
              }}
            />
          ))}
        </div>
      </div>

      <div className="mt-8 space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Pipette className="size-4 text-muted-foreground" />
          Cor personalizada
        </h3>

        <div
          className={cn(
            "flex flex-wrap items-center gap-4 rounded-lg border bg-card p-4",
            accent ? "border-primary/60 ring-2 ring-primary/40" : "border-border",
          )}
        >
          {/* Seletor nativo de cor — troca ao vivo, salvo neste dispositivo. */}
          <input
            type="color"
            value={pickerValue}
            onChange={(e) => setAccent(e.target.value)}
            aria-label="Escolher cor de destaque personalizada"
            className="h-12 w-14 shrink-0 cursor-pointer rounded-lg border border-border bg-transparent p-1"
          />
          <div className="min-w-[160px] flex-1">
            <p className="text-sm font-semibold text-foreground">
              {accent ? "Cor personalizada ativa" : "Escolha qualquer cor"}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {accent
                ? `${accent.toUpperCase()} — sobrescreve o preset acima.`
                : "Sobrescreve a cor de destaque dos presets. Aplica na hora."}
            </p>
          </div>
          {accent && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setAccent(null)}
            >
              <Check className="size-4" />
              Voltar ao preset
            </Button>
          )}
        </div>
      </div>

      <LogoBranding />
    </section>
  );
}

/**
 * Branding por conta (white-label): dois logos — um para fundo claro, outro
 * para fundo escuro. Só admin+ edita. Sem logo, usa o padrão do Super CRM.
 * PNG/WebP/SVG transparente, até 1 MB. Recomendado banner ~4:1 (ex.: 384×96).
 */
function LogoBranding() {
  const { account, canEditSettings, refreshProfile } = useAuth();

  if (!canEditSettings) return null;

  return (
    <div className="mt-8 space-y-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <ImageUp className="size-4 text-muted-foreground" />
        Logo da conta
      </h3>
      <p className="max-w-2xl text-xs text-muted-foreground">
        Substitui o logo do Super CRM na barra lateral para toda a equipe.
        Envie 2 versões (fundo claro / fundo escuro). PNG, WebP ou SVG com fundo
        transparente, até 1 MB. Ideal: banner horizontal ~4:1 (ex.: 384×96).
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <LogoSlot
          label="Logo p/ fundo claro"
          field="logo_light_url"
          currentUrl={account?.logo_light_url ?? null}
          previewBg="bg-white"
          onSaved={refreshProfile}
        />
        <LogoSlot
          label="Logo p/ fundo escuro"
          field="logo_dark_url"
          currentUrl={account?.logo_dark_url ?? null}
          previewBg="bg-neutral-900"
          onSaved={refreshProfile}
        />
      </div>
    </div>
  );
}

function LogoSlot({
  label,
  field,
  currentUrl,
  previewBg,
  onSaved,
}: {
  label: string;
  field: "logo_light_url" | "logo_dark_url";
  currentUrl: string | null;
  previewBg: string;
  onSaved: () => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const patch = async (url: string | null) => {
    const res = await fetch("/api/account", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: url }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(body?.error ?? "Falha ao salvar o logo");
    }
  };

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!LOGO_MIME.has(file.type)) {
      toast.error("Formato não suportado", {
        description: "Use PNG, WebP ou SVG.",
      });
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      toast.error("Imagem muito grande", { description: "Máximo de 1 MB." });
      return;
    }
    setBusy(true);
    try {
      const { publicUrl } = await uploadAccountMedia("logos", file);
      await patch(publicUrl);
      await onSaved();
      toast.success("Logo atualizado");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao enviar o logo");
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async () => {
    setBusy(true);
    try {
      await patch(null);
      await onSaved();
      toast.success("Logo removido — voltou ao padrão");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao remover");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="mb-2 text-xs font-medium text-muted-foreground">{label}</p>
      <div
        className={cn(
          "mb-3 flex h-16 items-center justify-center rounded-md",
          previewBg,
        )}
      >
        {currentUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={currentUrl}
            alt={label}
            className="max-h-12 w-auto object-contain"
          />
        ) : (
          <span className="text-xs text-muted-foreground">Padrão Super CRM</span>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/webp,image/svg+xml"
        className="hidden"
        onChange={onPick}
      />
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ImageUp className="size-4" />
          )}
          {currentUrl ? "Trocar" : "Enviar"}
        </Button>
        {currentUrl && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRemove}
            disabled={busy}
            className="text-muted-foreground hover:text-foreground"
          >
            <Trash2 className="size-4" />
            Remover
          </Button>
        )}
      </div>
    </div>
  );
}

function ModeCard({
  mode,
  isActive,
  onPick,
}: {
  mode: Mode;
  isActive: boolean;
  onPick: () => void;
}) {
  const isLight = mode === "light";
  const Icon = isLight ? Sun : Moon;
  return (
    <button
      type="button"
      role="radio"
      onClick={onPick}
      aria-checked={isActive}
      aria-label={`Usar modo ${isLight ? 'claro' : 'escuro'}`}
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-card p-4 text-left transition-colors",
        isActive
          ? "border-primary/60 ring-2 ring-primary/40"
          : "border-border hover:border-border hover:bg-muted/40",
      )}
    >
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground"
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="flex-1 text-sm font-semibold capitalize text-foreground">
        {isLight ? 'Claro' : 'Escuro'}
      </span>
      {isActive && (
        <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
          <Check className="h-3 w-3" />
          Ativo
        </span>
      )}
    </button>
  );
}

function ThemeCard({
  id,
  name,
  tagline,
  swatch,
  isActive,
  onPick,
}: {
  id: ThemeId;
  name: string;
  tagline: string;
  swatch: string;
  isActive: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={isActive}
      aria-label={`Usar tema ${name}`}
      className={cn(
        "flex flex-col gap-3 rounded-lg border bg-card p-4 text-left transition-colors",
        isActive
          ? "border-primary/60 ring-2 ring-primary/40"
          : "border-border hover:border-border hover:bg-muted/40",
      )}
    >
      <div className="flex items-center justify-between">
        <span
          aria-hidden
          className="h-8 w-8 shrink-0 rounded-full"
          style={{
            background: swatch,
            boxShadow: "inset 0 0 0 1px oklch(1 0 0 / 0.15)",
          }}
        />
        {isActive && (
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
            <Check className="h-3 w-3" />
            Ativo
          </span>
        )}
      </div>
      <div>
        <div className="text-sm font-semibold text-foreground">{name}</div>
        <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {tagline}
        </div>
      </div>
      <div
        className="mt-1 flex h-2 overflow-hidden rounded-full"
        aria-hidden
      >
        <span className="flex-1" style={{ background: swatch }} />
        <span className="w-3 bg-muted-foreground/60" />
        <span className="w-3 bg-muted" />
        <span className="w-3 bg-card" />
      </div>
      <span className="sr-only">ID do tema: {id}</span>
    </button>
  );
}
