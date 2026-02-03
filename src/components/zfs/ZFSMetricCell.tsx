interface ZFSMetricCellProps {
  children: React.ReactNode;
  align?: 'left' | 'center' | 'right';
}

export default function ZFSMetricCell({ children, align = 'right' }: ZFSMetricCellProps) {
  return (
    <td style={{ textAlign: align }}>
      {children}
    </td>
  );
}
