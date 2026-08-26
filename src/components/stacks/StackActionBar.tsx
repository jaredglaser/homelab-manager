import { useState } from 'react';
import { MoreHorizontal, Play, RefreshCw, Square, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useIsMobile } from '@/hooks/useMediaQuery';

const UPDATE_IMAGES_HINT =
  'Pulls newer images for every service and recreates containers whose image changed. Also applies any undeployed compose changes.';

const DESTRUCTIVE_CLASSES =
  'text-destructive border-destructive/50 hover:border-destructive hover:bg-destructive/5';

interface StackActionBarProps {
  onDeploy: () => void;
  onUpdate: () => void;
  onTeardown: () => void;
  onDelete: () => void;
  isDeploying: boolean;
}

export default function StackActionBar({
  onDeploy,
  onUpdate,
  onTeardown,
  onDelete,
  isDeploying,
}: StackActionBarProps) {
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);

  function runFromSheet(action: () => void) {
    setSheetOpen(false);
    action();
  }

  if (isMobile) {
    return (
      <div className="flex items-center gap-2">
        <Button className="h-11 flex-1" disabled={isDeploying} onClick={onDeploy}>
          {isDeploying ? <Spinner className="size-4 text-inherit" /> : <Play size={16} />}
          Deploy
        </Button>

        <Button
          variant="outline"
          size="icon"
          className="size-11 shrink-0"
          aria-label="More stack actions"
          aria-expanded={sheetOpen}
          onClick={() => setSheetOpen(true)}
        >
          <MoreHorizontal size={18} />
        </Button>

        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="bottom">
            <SheetHeader>
              <SheetTitle>Stack actions</SheetTitle>
            </SheetHeader>
            <SheetBody className="flex flex-col gap-4 p-4">
              <div className="flex flex-col gap-1.5">
                <Button
                  variant="secondary"
                  className="h-11 w-full justify-start"
                  disabled={isDeploying}
                  onClick={() => runFromSheet(onUpdate)}
                >
                  <RefreshCw size={16} />
                  Update images
                </Button>
                <p className="text-xs text-muted-foreground">{UPDATE_IMAGES_HINT}</p>
              </div>

              <Button
                variant="outline"
                className={`h-11 w-full justify-start ${DESTRUCTIVE_CLASSES}`}
                disabled={isDeploying}
                onClick={() => runFromSheet(onTeardown)}
              >
                <Square size={16} />
                Teardown
              </Button>

              <Button
                variant="outline"
                className={`h-11 w-full justify-start ${DESTRUCTIVE_CLASSES}`}
                disabled={isDeploying}
                onClick={() => runFromSheet(onDelete)}
              >
                <Trash2 size={16} />
                Delete Stack
              </Button>
            </SheetBody>
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" disabled={isDeploying} onClick={onDeploy}>
        {isDeploying ? <Spinner className="size-3.5 text-inherit" /> : <Play size={14} />}
        Deploy
      </Button>

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="secondary"
              size="sm"
              disabled={isDeploying}
              onClick={onUpdate}
            />
          }
        >
          <RefreshCw size={14} />
          Update images
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{UPDATE_IMAGES_HINT}</TooltipContent>
      </Tooltip>

      <Button
        variant="outline"
        size="sm"
        disabled={isDeploying}
        onClick={onTeardown}
        className={DESTRUCTIVE_CLASSES}
      >
        <Square size={14} />
        Teardown
      </Button>

      <div className="ml-auto">
        <Button
          variant="outline"
          size="sm"
          disabled={isDeploying}
          onClick={onDelete}
          className={DESTRUCTIVE_CLASSES}
        >
          <Trash2 size={14} />
          Delete Stack
        </Button>
      </div>
    </div>
  );
}
