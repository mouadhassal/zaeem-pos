interface Props {
  totalCents: number;
  currencySymbol: string;
  usdTotal?: string;
}

export default function TotalBlock({ totalCents, currencySymbol, usdTotal }: Props) {
  const fmt = (c: number) =>
    (c / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  return (
    <div className="text-center">
      {usdTotal && (
        <div className="tabular text-[11px] text-text-muted mb-0.5">≈ {usdTotal} USD</div>
      )}
      <div
        className="tabular text-text font-medium leading-none"
        style={{
          fontSize: 44,
          letterSpacing: "-0.02em",
          fontFamily: "'IBM Plex Mono', monospace",
        }}
      >
        {currencySymbol}{fmt(totalCents)}
      </div>
    </div>
  );
}
