interface MetricCellProps {
  children: React.ReactNode;
  align?: 'left' | 'center' | 'right';
}

export default function MetricCell({ children, align = 'right' }: MetricCellProps) {
  return (
    <td style={{ textAlign: align }}>
      {children}
    </td>
  );
}
