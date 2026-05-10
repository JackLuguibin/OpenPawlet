import { Modal, type ModalProps } from 'antd';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export type ResizableModalProps = ModalProps & {
  /** Minimum width (px) while dragging. */
  minResizeWidth?: number;
  /** Maximum width (px) while dragging; defaults to ~96% of viewport width at drag time. */
  maxResizeWidth?: number;
};

function isResponsiveWidth(w: ModalProps['width']): boolean {
  return w != null && typeof w === 'object' && !Array.isArray(w);
}

function coercePixelWidth(w: ModalProps['width']): number | null {
  if (typeof w === 'number' && Number.isFinite(w)) return w;
  if (typeof w === 'string') {
    const n = parseFloat(w);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function ResizableModal({
  minResizeWidth = 360,
  maxResizeWidth: maxResizeWidthProp,
  width: widthProp,
  modalRender: userModalRender,
  open,
  styles,
  afterOpenChange,
  centered = true,
  ...rest
}: ResizableModalProps) {
  const defaultPx = coercePixelWidth(widthProp) ?? 520;
  const responsive = isResponsiveWidth(widthProp);

  const [dragWidth, setDragWidth] = useState(defaultPx);
  const prevOpenRef = useRef(false);

  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setDragWidth(coercePixelWidth(widthProp) ?? 520);
    }
    prevOpenRef.current = Boolean(open);
  }, [open, widthProp]);

  const mergedModalRender = useCallback(
    (node: ReactNode) => {
      if (responsive) {
        return userModalRender ? userModalRender(node) : node;
      }
      const content = userModalRender ? userModalRender(node) : node;
      return (
        <div style={{ position: 'relative', height: '100%' }}>
          {content}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize dialog width"
            tabIndex={-1}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              const startX = e.clientX;
              const startW = dragWidth;
              const minW = minResizeWidth;
              const onMove = (ev: PointerEvent) => {
                const cap =
                  maxResizeWidthProp ?? Math.max(minW, Math.round(window.innerWidth * 0.96));
                const dx = ev.clientX - startX;
                const next = Math.min(cap, Math.max(minW, startW + dx));
                setDragWidth(next);
              };
              const onUp = () => {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                document.removeEventListener('pointercancel', onUp);
              };
              document.addEventListener('pointermove', onMove);
              document.addEventListener('pointerup', onUp);
              document.addEventListener('pointercancel', onUp);
            }}
            style={{
              // .ant-modal uses pointer-events: none; only .ant-modal-container is auto — without
              // this, the handle never receives clicks (see antd modal style gen).
              pointerEvents: 'auto',
              zIndex: 10,
              position: 'absolute',
              top: 0,
              right: -4,
              width: 8,
              height: '100%',
              cursor: 'col-resize',
              touchAction: 'none',
            }}
          />
        </div>
      );
    },
    [responsive, userModalRender, dragWidth, minResizeWidth, maxResizeWidthProp],
  );

  return (
    <Modal
      {...rest}
      open={open}
      afterOpenChange={afterOpenChange}
      centered={centered}
      width={responsive ? widthProp : dragWidth}
      modalRender={responsive ? userModalRender : mergedModalRender}
      styles={styles}
    />
  );
}
