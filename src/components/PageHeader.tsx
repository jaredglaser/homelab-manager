import { Typography } from '@mui/material';
import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  children?: ReactNode;
}

/**
 * Renders a page header with a title and optional adjacent content.
 *
 * @param title - The header text to display
 * @param children - Optional React nodes rendered next to the title
 * @returns The header container element with a styled title and any provided children
 */
export default function PageHeader({ title, children }: PageHeaderProps) {
  return (
    <div className="mb-6">
      <Typography variant="h4">{title}</Typography>
      {children}
    </div>
  );
}
