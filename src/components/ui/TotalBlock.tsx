interface Props {
  totalCents: number;
  currencySymbol: string;
}

export default function TotalBlock({ totalCents, currencySymbol }: Props) {
  const fmt = (c: number) =>
    c.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

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
