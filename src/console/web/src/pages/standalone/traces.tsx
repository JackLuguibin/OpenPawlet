import { Button } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import Observability from '../Observability';
import { ConsolePageShell } from '../../components/ConsolePageChrome';

type TracesLocationState = { tracesReturnTo?: string };

export default function TracesPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const returnTo = (location.state as TracesLocationState | null)?.tracesReturnTo;

  return (
    <ConsolePageShell innerClassName="min-h-0 flex-1 flex-col overflow-hidden">
      {returnTo ? (
        <div className="shrink-0 border-b border-gray-200/80 px-1 pb-2 dark:border-gray-700/60">
          <Button
            type="link"
            className="!h-auto !px-0 !py-0 text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate(returnTo)}
          >
            {t('activity.returnToActivity')}
          </Button>
        </div>
      ) : null}
      <Observability embedded />
    </ConsolePageShell>
  );
}
