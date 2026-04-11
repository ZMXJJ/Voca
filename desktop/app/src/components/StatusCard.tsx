type StatusCardProps = {
  title: string;
  value: string;
  hint: string;
};

export function StatusCard({ title, value, hint }: StatusCardProps) {
  return (
    <section className="status-card">
      <div className="status-card__label">{title}</div>
      <div className="status-card__value">{value}</div>
      <div className="status-card__hint">{hint}</div>
    </section>
  );
}
