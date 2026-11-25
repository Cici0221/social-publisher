import { Send } from "lucide-react";

export function Brand({ subtitle }: { subtitle?: string }) {
  return (
    <span className="brand">
      <span className="brand-mark" aria-hidden="true"><Send size={19} strokeWidth={1.9} /></span>
      <span className="brand-copy">
        <span className="brand-name">一键发布</span>
        {subtitle && <span className="brand-subtitle">{subtitle}</span>}
      </span>
    </span>
  );
}
