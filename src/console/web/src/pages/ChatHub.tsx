import { useCallback, useMemo, type ReactNode } from 'react';
import { useSearchParams, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MessageSquare, FolderOpen } from 'lucide-react';
import { SegmentedTabs } from '../components/SegmentedTabs';
import Chat from './Chat';
import Sessions from './Sessions';

type ChatSection = 'chat' | 'sessions';

const SECTION_QUERY = 'section';

function readSection(searchParams: URLSearchParams, hasSessionKey: boolean): ChatSection {
  // Always default to chat when navigating to a specific session conversation.
  if (hasSessionKey) return 'chat';
  return searchParams.get(SECTION_QUERY) === 'sessions' ? 'sessions' : 'chat';
}

/**
 * Wrapper around Chat + Sessions that renders a small segmented control on top.
 * Sessions is shown as a sibling tab to keep the conversation list a single
 * click away while chatting.
 */
export default function ChatHub() {
  const { t } = useTranslation();
  const params = useParams<{ sessionKey?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const hasSessionKey = Boolean(params.sessionKey);
  const section = readSection(searchParams, hasSessionKey);

  const setSectionInUrl = useCallback(
    (next: ChatSection) => {
      const params = new URLSearchParams(searchParams);
      if (next === 'chat') {
        params.delete(SECTION_QUERY);
      } else {
        params.set(SECTION_QUERY, next);
      }
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const tabs: { key: ChatSection; label: ReactNode }[] = useMemo(
    () => [
      {
        key: 'chat',
        label: (
          <span className="inline-flex items-center justify-center gap-1.5">
            <MessageSquare className="h-3.5 w-3.5 opacity-80" aria-hidden />
            {t('chatHub.tabChat')}
          </span>
        ),
      },
      {
        key: 'sessions',
        label: (
          <span className="inline-flex items-center justify-center gap-1.5">
            <FolderOpen className="h-3.5 w-3.5 opacity-80" aria-hidden />
            {t('chatHub.tabSessions')}
          </span>
        ),
      },
    ],
    [t],
  );

  // Hide the toolbar while a specific session is open in chat to give the
  // conversation as much vertical room as possible.
  const showSwitcher = !hasSessionKey;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {showSwitcher && (
        <div className="shrink-0 border-b border-gray-200/70 bg-white/70 px-4 py-2 backdrop-blur-sm dark:border-gray-700/50 dark:bg-gray-900/40 sm:px-6">
          <SegmentedTabs
            ariaLabel={t('chatHub.ariaTabs')}
            tabs={tabs}
            value={section}
            onChange={setSectionInUrl}
            size="sm"
            margins="none"
          />
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {section === 'sessions' ? <Sessions embedded /> : <Chat />}
      </div>
    </div>
  );
}
