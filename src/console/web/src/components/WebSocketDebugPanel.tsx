import { useMemo, useState } from 'react';
import { Button, Drawer, Empty, Typography } from 'antd';
import { DeleteOutlined, WifiOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

import { useAppStore } from '../store';
import { useAgentTimeZone } from '../hooks/useAgentTimeZone';
import { formatAgentLocaleTime } from '../utils/agentDatetime';

const { Text } = Typography;

/**
 * Shows live nanobot channel WebSocket frames. Data is stored in the global store;
 * this panel only renders it.
 */
export default function WebSocketDebugPanel() {
  const { t, i18n } = useTranslation();
  const agentTz = useAgentTimeZone();
  const locale = i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US';
  const [open, setOpen] = useState(false);
  const nanobotWsDebugLines = useAppStore((s) => s.nanobotWsDebugLines);
  const clearNanobotWsDebug = useAppStore((s) => s.clearNanobotWsDebug);

  const nanobotReversed = useMemo(
    () => [...nanobotWsDebugLines].reverse(),
    [nanobotWsDebugLines],
  );

  return (
    <>
      <Button
        type="text"
        size="small"
        aria-label={t('websocketDebug.openAria')}
        title={t('websocketDebug.openTitle')}
        icon={<WifiOutlined />}
        onClick={() => setOpen(true)}
      />
      <Drawer
        title={t('websocketDebug.drawerTitle')}
        placement="right"
        size={480}
        open={open}
        onClose={() => setOpen(false)}
        destroyOnClose={false}
      >
        <div className="flex flex-col gap-3">
          <Text type="secondary" className="text-xs">
            {t('websocketDebug.hint')}
          </Text>
          <div className="flex justify-end">
            <Button
              size="small"
              icon={<DeleteOutlined />}
              onClick={() => clearNanobotWsDebug()}
              disabled={nanobotWsDebugLines.length === 0}
            >
              {t('websocketDebug.clear')}
            </Button>
          </div>
          {nanobotWsDebugLines.length === 0 ? (
            <Empty description={t('websocketDebug.empty')} />
          ) : (
            <div className="max-h-[calc(100vh-220px)] overflow-y-auto space-y-2 pr-1">
              {nanobotReversed.map((line, index) => (
                <div key={`${line.ts}-${index}`}>
                  <Text type="secondary" className="text-[10px]">
                    {formatAgentLocaleTime(line.ts, agentTz, locale)}
                  </Text>
                  <pre className="text-xs font-mono mt-0.5 p-2 rounded bg-gray-100 dark:bg-gray-800/80 whitespace-pre-wrap break-words">
                    {line.body}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      </Drawer>
    </>
  );
}
