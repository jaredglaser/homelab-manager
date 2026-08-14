import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';

export interface MarkdownViewerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  content: string | null;
}

/**
 * Shows agent-authored Markdown (a container skill, a daily report) as
 * preformatted text. Deliberately not rendered: the content is model output,
 * and a raw view is both honest about what was produced and free of the
 * injection surface an HTML renderer would add.
 */
export function MarkdownViewerDialog({
  open,
  onOpenChange,
  title,
  description,
  content,
}: Readonly<MarkdownViewerDialogProps>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
        <DialogBody>
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-level1 p-4 font-mono text-xs">
            {content ?? 'Nothing written yet.'}
          </pre>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
