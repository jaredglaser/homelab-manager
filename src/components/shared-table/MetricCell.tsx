const alignClass = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
} as const;

interface MetricCellProps {
  children: React.ReactNode;
  align?: keyof typeof alignClass;
}

export function MetricCell({ children, align = 'right' }: MetricCellProps) {
  return (
    <td className={`${alignClass[align]} pr-16`}>
      {children}
    </td>
  );
}
