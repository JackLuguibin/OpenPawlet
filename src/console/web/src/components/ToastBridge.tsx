import { useEffect, useRef } from 'react';
import { App } from 'antd';
import { useAppStore } from '../store';

export default function ToastBridge() {
  const { message } = App.useApp();
  const toasts = useAppStore((s) => s.toasts);
  const shownIds = useRef(new Set<string>());

  useEffect(() => {
    toasts.forEach((toast) => {
      if (!shownIds.current.has(toast.id)) {
        shownIds.current.add(toast.id);
        const duration = (toast.duration ?? 4000) / 1000;
        switch (toast.type) {
          case 'success':
            message.success(toast.message, duration);
            break;
          case 'error':
            message.error(toast.message, duration);
            break;
          case 'warning':
            message.warning(toast.message, duration);
            break;
          default:
            message.info(toast.message, duration);
        }
      }
    });
  }, [toasts, message]);

  return null;
}
