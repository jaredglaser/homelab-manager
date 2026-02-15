import { Typography } from '@mui/joy';
import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  children?: ReactNode;
}

export default function PageHeader({ title, children }: PageHeaderProps) {
  return (
    <div className="mb-8">
      <Typography level="h2" className="tracking-tight">{title}</Typography>
      {children}
    </div>
  );
}
