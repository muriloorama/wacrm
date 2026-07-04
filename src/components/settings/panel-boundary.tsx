"use client";

import React from "react";

/**
 * Isola cada painel de Configurações: se um painel quebrar ao renderizar,
 * a rail (fora do boundary) continua clicável e mostramos o erro no lugar,
 * em vez de a página inteira ficar inerte. É "keyed" pela seção ativa no
 * uso, então trocar de seção reseta o estado de erro.
 */
export class SettingsPanelBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[settings panel] erro ao renderizar:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="max-w-xl rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
          <p className="font-medium text-destructive">
            Esta seção teve um erro ao carregar.
          </p>
          <p className="mt-1 break-words text-muted-foreground">
            {this.state.error.message}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-3 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
          >
            Recarregar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
