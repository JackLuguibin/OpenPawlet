import type { ReactNode } from 'react';
import { Tabs } from 'antd';
import type { TabsProps } from 'antd';
import { PageLayout } from './PageLayout';

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
    <PageLayout className="min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="shrink-0 pb-2">
          <h1 className="m-0 text-[20px] font-semibold leading-tight tracking-tight text-gray-900 dark:text-white">
            {title}
          </h1>
          {subtitle ? (
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-gray-500 dark:text-gray-400">
              {subtitle}
            </p>
          ) : null}
        </header>
        <Tabs
          className="hub-shell-tabs flex min-h-0 min-w-0 flex-1 flex-col"
          activeKey={activeKey}
          onChange={(key) => onChange(key as T)}
          items={items}
          type={tabsType}
          tabBarExtraContent={tabBarExtra}
          size="small"
          destroyOnHidden
        />
      </div>
    </PageLayout>
  );
}
