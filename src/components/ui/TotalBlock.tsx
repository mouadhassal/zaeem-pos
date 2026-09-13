import { formatAmount } from "../../lib/money";

interface Props {
  totalCents: number;
  currencySymbol: string;
}

export default function TotalBlock({ totalCents, currencySymbol }: Props) {
  // Currency-scale-aware -- was raw cents.toLocaleString(), which silently
  // assumed scale 0 (see lib/money.ts's formatAmount doc comment).
  const fmt = formatAmount;

  return (
    <div className="text-center">
      <div
        className="tabular-nums tabular text-text font-medium leading-none"
        style={{
          fontSize: 44,
          letterSpacing: "-0.02em",
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        {currencySymbol}{fmt(totalCents)}
      </div>
    </div>
  );
}
