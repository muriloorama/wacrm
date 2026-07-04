"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { BrandLogo } from "@/components/brand-logo";
import { useAuth } from "@/hooks/use-auth";
import { useTotalUnread } from "@/hooks/use-total-unread";
import { useUnreadNotifications } from "@/hooks/use-unread-notifications";
import {
  Bell,
  Check,
  Crown,
  GitBranch,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Radio,
  Settings,
  Shield,
  User,
  UserCog,
  Users,
  UsersRound,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import type { AccountRole } from "@/lib/auth/roles";

// Per-role chip metadata used in the sidebar's account strip + the
// Members tab roster. Keeping this near both consumers in a single
// place avoids drift between the two surfaces — when a designer
// wants to recolour "agent" rows, this is the one diff.
const ROLE_CHIP: Record<
  AccountRole,
  { icon: typeof Crown; label: string; className: string }
> = {
  owner: {
    icon: Crown,
    label: "Proprietário",
    // Amber: scarce, immutable, "the boss" — gets visual emphasis.
    className:
      "border-amber-500/40 bg-amber-500/10 text-amber-300",
  },
  admin: {
    icon: Shield,
    label: "Administrador",
    // Primary-tinted: significant but not as scarce as owner.
    className:
      "border-primary/40 bg-primary/10 text-primary",
  },
  agent: {
    icon: UserCog,
    label: "Agente",
    // Neutral slate: the operational default.
    className:
      "border-border bg-muted text-foreground",
  },
  viewer: {
    icon: User,
    label: "Visualizador",
    // Muted slate: read-only role; visually quieter than agent.
    className:
      "border-border bg-card text-muted-foreground",
  },
};
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /**
   * When true, the nav row renders a small "Beta" chip after the label.
   * Purely informational — doesn't affect routing or access.
   */
  beta?: boolean;
}

const navItems: NavItem[] = [
  { href: "/dashboard", label: "Painel", icon: LayoutDashboard },
  { href: "/inbox", label: "Caixa de entrada", icon: MessageSquare },
  { href: "/notifications", label: "Notificações", icon: Bell },
  { href: "/contacts", label: "Contatos", icon: Users },
  { href: "/pipelines", label: "Funis", icon: GitBranch },
  { href: "/broadcasts", label: "Transmissões", icon: Radio },
  { href: "/automations", label: "Automações", icon: Zap },
  { href: "/flows", label: "Fluxos", icon: Workflow, beta: true },
];

const bottomNavItems = [
  { href: "/settings", label: "Configurações", icon: Settings },
];

interface SidebarProps {
  /** Controlled on mobile by the Header's hamburger button. Ignored on lg+. */
  open?: boolean;
  onClose?: () => void;
}

export function Sidebar({ open = false, onClose }: SidebarProps) {
  const pathname = usePathname();
  const {
    profile,
    profileLoading,
    account,
    accountRole,
    accounts,
    accountId,
    switchAccount,
    signOut,
  } = useAuth();
  const totalUnread = useTotalUnread();
  const unreadNotifications = useUnreadNotifications();

  // Estado "recolhido" — só afeta o desktop (lg+). Começa expandido no
  // servidor (evita mismatch de hidratação) e, após montar no cliente,
  // lê a preferência salva. O drawer mobile ignora esse estado por
  // completo: as classes de recolher usam o prefixo `lg:`, que não vale
  // abaixo do breakpoint lg.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(
        localStorage.getItem("sidebar-collapsed") === "true",
      );
    } catch {
      // localStorage indisponível (SSR/modo privado) — mantém expandido.
    }
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("sidebar-collapsed", String(next));
      } catch {
        // Falha ao persistir não deve quebrar o toggle.
      }
      return next;
    });
  };
  // Only surface the account-name strip when it actually carries
  // information. A solo user's personal account is named after them
  // (the 017 signup trigger seeds it from `full_name`), so showing it
  // here would just duplicate the user name in the footer below. Once
  // the account is renamed or the user joins a shared account, the
  // name diverges and the strip becomes meaningful — that's the signal
  // we gate on. Wait for the profile fetch to settle first, otherwise
  // the strip flashes in once the row resolves (a layout jump).
  const showAccountStrip =
    !profileLoading &&
    !!account?.name &&
    account.name !== profile?.full_name;

  // Close the drawer when route changes — users opened it to navigate,
  // so once they pick a destination the drawer should get out of the way.
  useEffect(() => {
    onClose?.();
    // Only pathname drives this — onClose identity doesn't need to re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Lock body scroll and allow Escape to close while the drawer is open on
  // mobile. No-ops on desktop because the sidebar isn't positioned there.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <>
      {/* Backdrop — only exists on mobile and only when open. Clicking
          it closes the drawer. Hidden from lg+ since the sidebar is
          part of the main flex row there. */}
      <button
        type="button"
        aria-label="Fechar menu"
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-30 bg-background/70 backdrop-blur-sm transition-opacity lg:hidden",
          open
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0",
        )}
      />

      <aside
        className={cn(
          // Mobile: fixed drawer that slides in from the left.
          "fixed inset-y-0 left-0 z-40 flex h-full w-64 flex-col border-r border-border bg-card",
          "transition-transform duration-200 ease-out will-change-transform",
          open ? "translate-x-0" : "-translate-x-full",
          // Desktop: static, always visible — reset all the mobile framing.
          // Largura alterna conforme o estado recolhido (só no lg+).
          "lg:static lg:z-0 lg:translate-x-0 lg:transition-none",
          collapsed ? "lg:w-16" : "lg:w-60",
        )}
        aria-label="Principal"
      >
        {/* Logo row. On mobile we put a close button here; on desktop the
            close button is hidden since the sidebar is always-visible. */}
        <div
          className={cn(
            "flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4",
            // Recolhido no desktop: centraliza o botão de expandir.
            collapsed && "lg:justify-center lg:px-2",
          )}
        >
          {/* Banner da marca — escondido no desktop quando recolhido para
              caber na faixa estreita (o botão de expandir fica no lugar). */}
          <Link
            href="/dashboard"
            className={cn(
              "flex items-center",
              collapsed && "lg:hidden",
            )}
          >
            <BrandLogo
              className="h-8"
              lightSrc={account?.logo_light_url}
              darkSrc={account?.logo_dark_url}
            />
          </Link>
          {/* Botão recolher/expandir — só no desktop (lg+). No mobile o
              controle é o hambúrguer do Header. */}
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expandir barra lateral" : "Recolher barra lateral"}
            title={collapsed ? "Expandir barra lateral" : "Recolher barra lateral"}
            className="hidden h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:flex"
          >
            {collapsed ? (
              <PanelLeftOpen className="h-5 w-5" />
            ) : (
              <PanelLeftClose className="h-5 w-5" />
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar menu"
            className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Main navigation */}
        <nav
          className={cn(
            "flex-1 overflow-y-auto px-3 py-4",
            collapsed && "lg:px-2",
          )}
        >
          <ul className="flex flex-col gap-1">
            {navItems.map((item) => {
              const isActive =
                pathname === item.href ||
                (item.href !== "/dashboard" && pathname.startsWith(item.href));

              const showUnreadDot =
                item.href === "/inbox" && totalUnread > 0 && !isActive;

              // Unlike the inbox dot, the notifications count stays visible
              // even while the page is active — it reflects unread state
              // (cleared by marking notifications read), not "currently
              // viewing this section".
              const showNotificationBadge =
                item.href === "/notifications" && unreadNotifications > 0;

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    // No modo recolhido o label some, então o `title`
                    // expõe o nome do item no hover (tooltip nativo).
                    title={collapsed ? item.label : undefined}
                    className={cn(
                      // Taller on mobile so fingers can hit the row reliably (≥44px).
                      "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2",
                      collapsed && "lg:justify-center lg:px-0",
                      isActive
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    <span
                      className={cn(
                        "flex-1",
                        collapsed && "lg:hidden",
                      )}
                    >
                      {item.label}
                    </span>
                    {item.beta && (
                      <span
                        aria-label="Recurso beta"
                        className={cn(
                          "rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-300",
                          collapsed && "lg:hidden",
                        )}
                      >
                        Beta
                      </span>
                    )}
                    {showUnreadDot && (
                      <span
                        aria-label={`${totalUnread} conversa${totalUnread === 1 ? "" : "s"} não lida${totalUnread === 1 ? "" : "s"}`}
                        className={cn(
                          "relative flex h-2 w-2",
                          collapsed && "lg:hidden",
                        )}
                      >
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                      </span>
                    )}
                    {showNotificationBadge && (
                      <span
                        aria-label={`${unreadNotifications} notificação${unreadNotifications === 1 ? "" : "es"} não lida${unreadNotifications === 1 ? "" : "s"}`}
                        className={cn(
                          "flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground",
                          collapsed && "lg:hidden",
                        )}
                      >
                        {unreadNotifications > 9 ? "9+" : unreadNotifications}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>

          <div className="my-4 border-t border-border" />

          <ul className="flex flex-col gap-1">
            {bottomNavItems.map((item) => {
              const isActive = pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    title={collapsed ? item.label : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2",
                      collapsed && "lg:justify-center lg:px-0",
                      isActive
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    <span className={cn(collapsed && "lg:hidden")}>
                      {item.label}
                    </span>
                  </Link>
                </li>
              );
            })}
            {/* Super Admin — flag global (profiles.is_super_admin). Só
                aparece para quem tem a flag; todo mundo mais nem vê o
                link (a página /admin também barra no servidor). */}
            {profile?.is_super_admin ? (
              <li>
                <Link
                  href="/admin"
                  title={collapsed ? "Super Admin" : undefined}
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2",
                    collapsed && "lg:justify-center lg:px-0",
                    pathname.startsWith("/admin")
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <Shield className="h-4 w-4 shrink-0" />
                  <span className={cn(collapsed && "lg:hidden")}>
                    Super Admin
                  </span>
                </Link>
              </li>
            ) : null}
          </ul>
        </nav>

        {/* User section */}
        <div
          className={cn(
            "shrink-0 border-t border-border p-3",
            collapsed && "lg:px-2",
          )}
        >
          {/* Account name display — surfaced only when the account
              name differs from the user's own name (see
              `showAccountStrip`). For a default solo account the two
              match, so we hide it to avoid duplicating the user name
              below; for renamed or shared accounts it tells the user
              which account they're acting in. */}
          {showAccountStrip && account?.name ? (
            <div
              className={cn(
                "mb-2 flex items-center gap-2 px-3 text-xs text-muted-foreground",
                collapsed && "lg:hidden",
              )}
            >
              <UsersRound className="size-3.5 shrink-0" />
              {/* `title=` exposes the full name on hover when it
                  gets truncated (long account names + narrow
                  sidebars). Cheap a11y win. */}
              <span className="truncate" title={account.name}>
                {account.name}
              </span>
              {accountRole ? (
                // Always render the chip — owners used to be
                // invisible here, which made them indistinguishable
                // from admins at a glance. Now everyone sees their
                // role (with a colour cue) regardless of tier.
                (() => {
                  const meta = ROLE_CHIP[accountRole];
                  const Icon = meta.icon;
                  return (
                    <span
                      className={`ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${meta.className}`}
                    >
                      <Icon className="size-3" />
                      {meta.label}
                    </span>
                  );
                })()
              ) : null}
            </div>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              title={
                collapsed ? (profile?.full_name ?? "Usuário") : undefined
              }
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted/60 focus:bg-muted/60 focus:outline-none data-popup-open:bg-muted/60",
                collapsed && "lg:justify-center lg:px-0",
              )}
            >
              <Avatar className="size-8 shrink-0">
                {profile?.avatar_url ? (
                  <AvatarImage
                    src={profile.avatar_url}
                    alt={profile.full_name ?? "Avatar"}
                  />
                ) : null}
                <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
                  {profile?.full_name?.charAt(0)?.toUpperCase() ??
                    profile?.email?.charAt(0)?.toUpperCase() ??
                    "U"}
                </AvatarFallback>
              </Avatar>
              <div
                className={cn(
                  "min-w-0 flex-1",
                  collapsed && "lg:hidden",
                )}
              >
                <p className="truncate text-sm font-medium text-foreground">
                  {profile?.full_name ?? "Usuário"}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {profile?.email ?? ""}
                </p>
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="top"
              sideOffset={6}
              className="min-w-56 bg-popover text-popover-foreground ring-border"
            >
              {/* Seletor de conta — só quando o usuário é membro de mais de
                  uma. Troca a conta ATIVA (switch_account) e recarrega. */}
              {accounts.length > 1 ? (
                <>
                  <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                    Contas
                  </div>
                  {accounts.map((a) => (
                    <DropdownMenuItem
                      key={a.id}
                      closeOnClick={false}
                      onClick={() => switchAccount(a.id)}
                      className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                    >
                      <UsersRound className="size-4 shrink-0" />
                      <span className="flex-1 truncate" title={a.name}>
                        {a.name}
                      </span>
                      {a.id === accountId ? (
                        <Check className="size-4 shrink-0 text-primary" />
                      ) : null}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator className="bg-border" />
                </>
              ) : null}
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=profile"
                    onClick={onClose}
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  />
                }
              >
                <User className="size-4" />
                Perfil
              </DropdownMenuItem>
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=whatsapp"
                    onClick={onClose}
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  />
                }
              >
                <Settings className="size-4" />
                Configurações
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem
                onClick={signOut}
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              >
                <LogOut className="size-4" />
                Sair
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
    </>
  );
}
