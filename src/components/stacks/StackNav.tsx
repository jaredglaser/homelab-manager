import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { IconButton, Typography } from '@mui/material';
import { Plus, Server } from 'lucide-react';
import { useStackListContext, useStackStatusContext } from '@/components/stacks/stacks-context';
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
  const { stacks } = useStackListContext();
  const { statusMap } = useStackStatusContext();
  const listRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState(0);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setContainerHeight(entry.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

  const totalNaturalHeight = navItems.reduce(
    (sum, item) => sum + (item.type === 'host' ? HOST_ROW_HEIGHT : STACK_ROW_HEIGHT),
    0,
  );
  const scale = containerHeight > 0 && totalNaturalHeight > containerHeight
    ? containerHeight / totalNaturalHeight
    : 1;

  return (
    <div className="w-60 flex-shrink-0 border-r border-[var(--mui-palette-divider)] bg-[var(--mui-palette-background-level1)] flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--mui-palette-divider)]">
        <Typography variant="subtitle2" className="opacity-80">Stacks</Typography>
        <IconButton size="small" onClick={onCreateClick} aria-label="Create stack">
          <Plus size={16} />
        </IconButton>
      </div>
      <div ref={listRef} className="flex-1 overflow-hidden flex flex-col">
        {navItems.map((item) => {
          const naturalHeight = item.type === 'host' ? HOST_ROW_HEIGHT : STACK_ROW_HEIGHT;
          const height = Math.floor(naturalHeight * scale);
          const key = item.type === 'host' ? `host-${item.host}` : `stack-${item.host}-${item.name}`;
          return (
            <div key={key} style={{ height, flexShrink: 0, overflow: 'hidden' }}>
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
  );
}

function HostNavItem({ host }: { host: string }) {
  return (
    <Link
      to="/stacks/host/$hostName"
      params={{ hostName: host }}
      className="h-full flex items-center gap-2 px-3 text-xs font-semibold uppercase tracking-wide opacity-60 hover:opacity-100 hover:bg-[var(--mui-palette-action-hover)] transition-colors cursor-pointer no-underline text-inherit"
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
      className="h-full flex items-center gap-2 pl-7 pr-3 text-sm hover:bg-[var(--mui-palette-action-hover)] transition-colors cursor-pointer no-underline text-inherit"
      activeProps={{ className: '!bg-[var(--mui-palette-action-selected)]' }}
    >
      {iconUrl ? (
        <img src={iconUrl} alt="" className="w-4 h-4 rounded-sm" />
      ) : (
        <span className="w-4 h-4 rounded-sm bg-[var(--mui-palette-action-disabledBackground)] flex items-center justify-center text-[10px] font-bold opacity-50">
          {(name.charAt(0) || '?').toUpperCase()}
        </span>
      )}
      <span className="truncate flex-1">{name}</span>
      {containerCount > 0 && (
        <span className="text-[10px] opacity-50">{containerCount}</span>
      )}
    </Link>
  );
}
