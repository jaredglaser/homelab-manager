import { Typography } from '@mui/material';

interface PageTitleProps {
  title: string;
}

export default function PageTitle({ title }: Readonly<PageTitleProps>) {
  return (
    <div className="py-4 px-4 shrink-0">
      <Typography variant="h4">{title}</Typography>
    </div>
  );
}
