
interface PageTitleProps {
  title: string;
}

export default function PageTitle({ title }: Readonly<PageTitleProps>) {
  return (
    <div className="py-4 px-4 shrink-0">
      <h4 className="text-[2.125rem] leading-tight">{title}</h4>
    </div>
  );
}
