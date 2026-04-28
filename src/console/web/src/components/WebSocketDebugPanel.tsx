import { useMemo, useState } from 'react';
import { Button, Drawer, Empty, Typography } from 'antd';
import { DeleteOutlined, WifiOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

import { useAppStore } from '../store';
import { useAgentTimeZone } from '../hooks/useAgentTimeZone';
import { formatAgentLocaleTime } from '../utils/agentDatetime';

const { Text } = Typography;

/**
 * Shows live OpenPawlet channel WebSocket frames. Data is stored in the global store;
 * this panel only renders it.
 */
export default function WebSocketDebugPanel() {
  const { t, i18n } = useTranslation();
  const agentTz = useAgentTimeZone();
  const locale = i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US';
  const [open, setOpen] = useState(false);
  const openpawletWsDebugLines = useAppStore((s) => s.openpawletWsDebugLines);
  const clearOpenPawletWsDebug = useAppStore((s) => s.clearOpenPawletWsDebug);

  const openpawletWsLinesReversed = useMemo(
    () => [...openpawletWsDebugLines].reverse(),
    [openpawletWsDebugLines],
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
              onClick={() => clearOpenPawletWsDebug()}
              disabled={openpawletWsDebugLines.length === 0}
            >
              {t('websocketDebug.clear')}
            </Button>
          </div>
          {openpawletWsDebugLines.length === 0 ? (
            <Empty description={t('websocketDebug.empty')} />
          ) : (
            <div className="max-h-[calc(100vh-220px)] overflow-y-auto space-y-2 pr-1">
              {openpawletWsLinesReversed.map((line, index) => (
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
