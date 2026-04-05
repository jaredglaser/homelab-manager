import { Typography } from '@mui/material';
import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  children?: ReactNode;
}

export default function PageHeader({ title, children }: PageHeaderProps) {
  return (
    <div className="py-4 px-4 flex-shrink-0">
      <Typography variant="h4">{title}</Typography>
      {children}
    </div>
  );
}
