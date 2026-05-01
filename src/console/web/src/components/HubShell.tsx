import type { ReactNode } from 'react';
import { Tabs, theme } from 'antd';
import type { TabsProps } from 'antd';
import {
  ConsolePageShell,
  ConsolePageHeading,
  ConsolePageTitleBlock,
} from './ConsolePageChrome';

export interface HubTabItem<T extends string> {
  key: T;
  icon?: ReactNode;
  label: ReactNode;
  /** Rendered when the tab is active */
  content: ReactNode;
}

export interface HubShellProps<T extends string> {
  title: ReactNode;
  subtitle?: ReactNode;
  tabs: HubTabItem<T>[];
  activeKey: T;
  onChange: (key: T) => void;
  /** Optional right-side toolbar rendered next to the tab bar */
  tabBarExtra?: ReactNode;
  /** Tabs visual style; defaults to `line` (horizontal underline). */
  tabsType?: TabsProps['type'];
}

/**
 * Shared hub page shell with title block + Ant Design Tabs.
 *
 * Replaces the hand-rolled "title card + segmented tabs" duplicated across
 * AgentsHub / KnowledgeHub / ObservabilityHub / McpAndSkills.
 */
export function HubShell<T extends string>({
  title,
  subtitle,
  tabs,
  activeKey,
  onChange,
  tabBarExtra,
  tabsType = 'line',
}: HubShellProps<T>) {
  const { token } = theme.useToken();
  const items: TabsProps['items'] = tabs.map((tab) => ({
    key: tab.key,
    label: tab.icon ? (
      <span className="inline-flex items-center gap-1.5">
        {tab.icon}
        {tab.label}
      </span>
    ) : (
      tab.label
    ),
    children: (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {tab.content}
      </div>
    ),
  }));

  return (
    <ConsolePageShell>
      <ConsolePageHeading
        surface="hero"
        heading={<ConsolePageTitleBlock title={title} subtitle={subtitle} />}
      />
      <Tabs
        className="hub-shell-tabs flex min-h-0 min-w-0 flex-1 flex-col"
        activeKey={activeKey}
        onChange={(key) => onChange(key as T)}
        items={items}
        type={tabsType}
        tabBarExtraContent={tabBarExtra}
        tabBarGutter={token.marginSM}
        size="small"
        destroyOnHidden
      />
    </ConsolePageShell>
  );
}
