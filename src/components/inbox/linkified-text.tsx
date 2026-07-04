import React from "react";

// Pontuação final que não faz parte de um link.
const TRAILING_RE = /[.,;:!?)\]}'"»]+$/;

// Marcadores reconhecidos, na ordem em que são testados. O primeiro que
// aparecer (menor índice) no texto vence. Formatação segue o padrão do
// WhatsApp: *negrito*  _itálico_  ~riscado~  ```mono```  `mono`.
const PATTERNS: {
  name: "url" | "mono" | "bold" | "italic" | "strike";
  re: RegExp;
}[] = [
  { name: "url", re: /(https?:\/\/[^\s<]+|www\.[^\s<]+)/i },
  { name: "mono", re: /```([\s\S]+?)```/ },
  { name: "mono", re: /`([^`\n]+?)`/ },
  { name: "bold", re: /\*([^*\n]+?)\*/ },
  { name: "italic", re: /_([^_\n]+?)_/ },
  { name: "strike", re: /~([^~\n]+?)~/ },
];

/**
 * Remove os marcadores de formatação do WhatsApp (*negrito*, _itálico_,
 * ~riscado~, `mono`/```mono```) mantendo só o texto. Usado em PRÉVIAS de
 * uma linha (ex.: coluna do lead na lista de conversas), onde renderizar
 * negrito/mono/links fica estranho — o WhatsApp também mostra o texto limpo
 * ali. Não toca em URLs (ficam legíveis como texto).
 */
export function stripWhatsAppMarkers(text: string): string {
  return text
    .replace(/```([\s\S]+?)```/g, "$1")
    .replace(/`([^`\n]+?)`/g, "$1")
    .replace(/\*([^*\n]+?)\*/g, "$1")
    .replace(/_([^_\n]+?)_/g, "$1")
    .replace(/~([^~\n]+?)~/g, "$1");
}

function formatInline(
  text: string,
  counter: { n: number },
): React.ReactNode[] {
  // Acha o marcador de menor índice no texto.
  let best: { name: string; match: RegExpExecArray; index: number } | null =
    null;
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (m && (best === null || m.index < best.index)) {
      best = { name: p.name, match: m, index: m.index };
    }
  }

  if (!best) return text ? [text] : [];

  const nodes: React.ReactNode[] = [];
  const { name, match, index } = best;
  const full = match[0];
  const key = `t${counter.n++}`;

  if (index > 0) nodes.push(text.slice(0, index));

  if (name === "url") {
    const trailing = full.match(TRAILING_RE)?.[0] ?? "";
    const url = trailing ? full.slice(0, full.length - trailing.length) : full;
    const href = url.startsWith("www.") ? `https://${url}` : url;
    nodes.push(
      <a
        key={key}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all underline underline-offset-2 hover:opacity-80"
      >
        {url}
      </a>,
    );
    if (trailing) nodes.push(trailing);
  } else if (name === "mono") {
    nodes.push(
      <code
        key={key}
        className="rounded bg-black/10 px-1 font-mono text-[0.85em] dark:bg-white/15"
      >
        {match[1]}
      </code>,
    );
  } else {
    // Negrito/itálico/riscado — o conteúdo interno também é formatado (aninha).
    const inner = formatInline(match[1], counter);
    if (name === "bold") {
      nodes.push(
        <strong key={key} className="font-semibold">
          {inner}
        </strong>,
      );
    } else if (name === "italic") {
      nodes.push(<em key={key}>{inner}</em>);
    } else {
      nodes.push(<s key={key}>{inner}</s>);
    }
  }

  // Continua no restante do texto (mesmo contador → chaves únicas).
  nodes.push(...formatInline(text.slice(index + full.length), counter));
  return nodes;
}

/**
 * Renderiza texto de mensagem com links clicáveis e formatação estilo WhatsApp
 * (*negrito*, _itálico_, ~riscado~, ```mono```). O <p> pai preserva as quebras
 * de linha.
 */
export function FormattedText({ text }: { text: string }) {
  if (!text) return null;
  return <>{formatInline(text, { n: 0 })}</>;
}
