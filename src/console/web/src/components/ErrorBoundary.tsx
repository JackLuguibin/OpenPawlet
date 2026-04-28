import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from 'antd';
import i18n from '../i18n';
import { PAGE_PRIMARY_TITLE_CLASS } from '../utils/pageTitleClasses';

type Props = { children: ReactNode };

type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          <h1 className={PAGE_PRIMARY_TITLE_CLASS}>
            {i18n.t('app.crashTitle')}
          </h1>
          <p className="max-w-md text-sm text-gray-600 dark:text-gray-400">
            {i18n.t('app.crashHint')}
          </p>
          <Button type="primary" onClick={() => window.location.reload()}>
            {i18n.t('app.reload')}
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
