import React from 'react';

/**
 * components/chat/formatMessage.jsx
 * The AI's replies come back as plain markdown-ish text (**bold**, "- " /
 * "1. " lists) but were rendered as raw text, so "**Rust and Corrosion**"
 * showed up with literal asterisks. This renders just those two patterns
 * as JSX — not a full markdown parser, since that's all the system prompt
 * actually produces.
 */
function renderInline(text, keyPrefix) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={`${keyPrefix}-${i}`} className="font-bold">{part.slice(2, -2)}</strong>;
    }
    return part ? <React.Fragment key={`${keyPrefix}-${i}`}>{part}</React.Fragment> : null;
  });
}

export function renderMessageContent(content) {
  if (!content) return content;
  return content.split('\n').map((line, i) => {
    const listMatch = line.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      return (
        <div key={i} className="flex gap-1.5">
          <span className="opacity-60 shrink-0">{listMatch[1] === '-' || listMatch[1] === '*' ? '•' : listMatch[1]}</span>
          <span>{renderInline(listMatch[2], `l${i}`)}</span>
        </div>
      );
    }
    if (line.trim() === '') return <div key={i}>&nbsp;</div>;
    return <div key={i}>{renderInline(line, `t${i}`)}</div>;
  });
}
