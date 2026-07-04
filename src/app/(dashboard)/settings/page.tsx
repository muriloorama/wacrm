'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';

import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { SettingsRail } from '@/components/settings/settings-rail';
import { SettingsOverview } from '@/components/settings/settings-overview';
import { ProfileForm } from '@/components/settings/profile-form';
import { SecurityPanel } from '@/components/settings/security-panel';
import { AppearancePanel } from '@/components/settings/appearance-panel';
import { WhatsAppConfig } from '@/components/settings/whatsapp-config';
import { TemplateManager } from '@/components/settings/template-manager';
import { FieldsAndTagsPanel } from '@/components/settings/fields-and-tags-panel';
import { DealsSettings } from '@/components/settings/deals-settings';
import { MembersTab } from '@/components/settings/members-tab';
import { ApiKeysSettings } from '@/components/settings/api-keys-settings';
import { SettingsPanelBoundary } from '@/components/settings/panel-boundary';
import {
  resolveSection,
  type SettingsSection,
} from '@/components/settings/settings-sections';

// Carregado só no cliente (ssr: false): elimina qualquer descompasso de
// hidratação vindo deste painel e o isola em seu próprio chunk.
const FollowupPanel = dynamic(
  () =>
    import('@/components/settings/followup-panel').then((m) => m.FollowupPanel),
  {
    ssr: false,
    loading: () => (
      <p className="text-sm text-muted-foreground">Carregando…</p>
    ),
  },
);

export default function SettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { defaultCurrency } = useAuth();
  const { mode } = useTheme();

  // The URL (`?tab=`) is the single source of truth for the active
  // section — deep-linkable, and it keeps the existing links in the
  // app sidebar/header working. Legacy tab values (tags, custom-fields)
  // resolve onto their new home; unknown/empty → the Overview landing.
  const section = resolveSection(searchParams.get('tab'));

  // Modelos (templates) são um recurso da API Oficial da Meta — sem conta
  // Meta configurada, a seção não faz sentido e fica oculta. null = ainda
  // carregando (não escondemos para não piscar).
  const [metaConfigured, setMetaConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/whatsapp/config', { cache: 'no-store' });
        if (!res.ok) {
          if (!cancelled) setMetaConfigured(false);
          return;
        }
        const data = (await res.json()) as { phone_number_id?: string } | null;
        if (!cancelled) setMetaConfigured(Boolean(data?.phone_number_id));
      } catch {
        if (!cancelled) setMetaConfigured(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // "Modelos" só aparece quando CONFIRMAMOS que há conta Meta. Enquanto
  // metaConfigured é null (carregando) mantemos oculto — assim a seção não
  // "aparece e some" ao resolver a checagem (evita o flash na troca de aba).
  const hiddenSections: SettingsSection[] =
    metaConfigured === true ? [] : ['templates'];

  const go = (next: SettingsSection) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`/settings?${params.toString()}`, { scroll: false });
  };

  // Cheap, fetch-free rail hints. The Overview landing carries the
  // full live status/counts; the rail just surfaces the two that are
  // already in context.
  const hints: Partial<Record<SettingsSection, ReactNode>> = useMemo(
    () => ({
      appearance: mode.charAt(0).toUpperCase() + mode.slice(1),
      deals: defaultCurrency,
    }),
    [mode, defaultCurrency],
  );

  const panel: Record<SettingsSection, ReactNode> = {
    overview: <SettingsOverview onSelect={go} />,
    profile: <ProfileForm />,
    security: <SecurityPanel />,
    appearance: <AppearancePanel />,
    whatsapp: <WhatsAppConfig />,
    templates:
      metaConfigured === false ? (
        <div className="max-w-xl rounded-lg border border-border bg-card p-6 text-center">
          <p className="text-sm font-medium text-foreground">
            Modelos exigem a API Oficial (Meta)
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Modelos de mensagem são aprovados pela Meta e só valem para a API
            Oficial. Conecte uma conta Meta para usá-los. Nos canais por QR
            Code, envie mensagens normalmente sem modelo.
          </p>
          <button
            type="button"
            onClick={() => go('whatsapp')}
            className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Ir para Conexão do WhatsApp
          </button>
        </div>
      ) : (
        <TemplateManager />
      ),
    fields: <FieldsAndTagsPanel />,
    deals: <DealsSettings />,
    followup: <FollowupPanel />,
    members: <MembersTab />,
    api: <ApiKeysSettings />,
  };

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Configurações
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Tudo em um só lugar — sua conta e seu espaço de trabalho. Escolha uma
          seção para gerenciá-la.
        </p>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[236px_minmax(0,1fr)] lg:items-start">
        <SettingsRail
          active={section}
          onSelect={go}
          hints={hints}
          hidden={hiddenSections}
        />
        <div className="min-w-0">
          <SettingsPanelBoundary key={section}>
            {panel[section]}
          </SettingsPanelBoundary>
        </div>
      </div>
    </div>
  );
}
