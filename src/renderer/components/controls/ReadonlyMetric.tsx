export function ReadonlyMetric({ label, value, suffix, decimals = 2 }: {
  label: string;
  value: number;
  suffix: string;
  decimals?: number;
}) {
  return <div className="readonly-metric">
    <span>{label}</span>
    <output>{decimals === 0 ? Math.round(value) : value.toFixed(decimals)} {suffix}</output>
  </div>;
}
