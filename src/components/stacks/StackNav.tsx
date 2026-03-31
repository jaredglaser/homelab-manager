import { useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Link } from '@tanstack/react-router';
import { IconButton, Typography } from '@mui/material';
import { Plus, Server } from 'lucide-react';
import { useStacksContext } from '@/components/stacks/stacks-context';
import { getIconUrl } from '@/lib/utils/icon-resolver';

type NavItem =
  | { type: 'host'; host: string }
  | { type: 'stack'; name: string; host: string; icon: string | null; containerCount: number };

const HOST_ROW_HEIGHT = 36;
const STACK_ROW_HEIGHT = 32;

interface StackNavProps {
  onCreateClick: () => void;
}

export default function StackNav({ onCreateClick }: StackNavProps) {
  const { stacks, statusMap } = useStacksContext();
  const listRef = useRef<HTMLDivElement>(null);

  const navItems = useMemo(() => {
    const byHost = new Map<string, typeof stacks>();
    for (const stack of stacks) {
      const list = byHost.get(stack.host) ?? [];
      list.push(stack);
      byHost.set(stack.host, list);
    }

    const items: NavItem[] = [];
    const sortedHosts = Array.from(byHost.keys()).sort();
    const multiHost = sortedHosts.length > 1;
    for (const host of sortedHosts) {
      if (multiHost) {
        items.push({ type: 'host', host });
      }
      const hostStacks = byHost.get(host)!;
      hostStacks.sort((a, b) => a.name.localeCompare(b.name));
      for (const stack of hostStacks) {
        const statusKey = `${stack.host}/${stack.name}`;
        const status = statusMap.get(statusKey);
        items.push({
          type: 'stack',
          name: stack.name,
          host: stack.host,
          icon: stack.icon,
          containerCount: status?.containers.length ?? stack.containerCount,
        });
      }
    }
    return items;
  }, [stacks, statusMap]);

  const virtualizer = useVirtualizer({
    count: navItems.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => navItems[index].type === 'host' ? HOST_ROW_HEIGHT : STACK_ROW_HEIGHT,
    overscan: 10,
    getItemKey: (index) => {
      const item = navItems[index];
      return item.type === 'host' ? `host-${item.host}` : `stack-${item.host}-${item.name}`;
    },
  });

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="w-60 flex-shrink-0 border-r border-[var(--mui-palette-divider)] bg-[var(--mui-palette-background-level1)] flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--mui-palette-divider)]">
        <Typography variant="subtitle2" className="opacity-80">Stacks</Typography>
        <IconButton size="small" onClick={onCreateClick} aria-label="Create stack">
          <Plus size={16} />
        </IconButton>
      </div>
      <div ref={listRef} className="flex-1 overflow-y-auto themed-scrollbar">
        <div
          style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}
        >
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translate3d(0, ${virtualItems[0]?.start ?? 0}px, 0)`,
            }}
          >
            {virtualItems.map((virtualRow) => {
              const item = navItems[virtualRow.index];
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                >
                  {item.type === 'host' ? (
                    <HostNavItem host={item.host} />
                  ) : (
                    <StackNavItem
                      name={item.name}
                      icon={item.icon}
                      containerCount={item.containerCount}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function HostNavItem({ host }: { host: string }) {
  return (
    <Link
      to="/stacks/host/$hostName"
      params={{ hostName: host }}
      className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide opacity-60 hover:opacity-100 hover:bg-[var(--mui-palette-action-hover)] transition-colors cursor-pointer no-underline text-inherit"
      activeProps={{ className: '!opacity-100 !bg-[var(--mui-palette-action-selected)]' }}
    >
      <Server size={12} />
      <span className="truncate">{host}</span>
    </Link>
  );
}

function StackNavItem({ name, icon, containerCount }: { name: string; icon: string | null; containerCount: number }) {
  const iconUrl = icon ? getIconUrl(icon, '') : null;

  return (
    <Link
      to="/stacks/$stackName"
      params={{ stackName: name }}
      className="flex items-center gap-2 pl-7 pr-3 py-1 text-sm hover:bg-[var(--mui-palette-action-hover)] transition-colors cursor-pointer no-underline text-inherit"
      activeProps={{ className: '!bg-[var(--mui-palette-action-selected)]' }}
    >
      {iconUrl ? (
        <img src={iconUrl} alt="" className="w-4 h-4 rounded-sm" />
      ) : (
        <span className="w-4 h-4 rounded-sm bg-[var(--mui-palette-action-disabledBackground)] flex items-center justify-center text-[10px] font-bold opacity-50">
          {name[0].toUpperCase()}
        </span>
      )}
      <span className="truncate flex-1">{name}</span>
      {containerCount > 0 && (
        <span className="text-[10px] opacity-50">{containerCount}</span>
      )}
    </Link>
  );
}
