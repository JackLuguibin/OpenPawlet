import { useTranslation } from "react-i18next";
import { DownOutlined } from "@ant-design/icons";

interface JumpToBottomButtonProps {
  /** Number of unseen rows below the current viewport; 0 hides the "new" hint. */
  unreadBelowCount: number;
  /** Scroll the message list to the latest entry. */
  onJump: () => void;
}

/**
 * Floating "jump to latest" pill rendered at the bottom-right of the
 * timeline whenever the user scrolls away from the tail. The parent fully
 * controls visibility (renders/unmounts based on its own scroll state); we
 * only render the markup and the click action.
 */
export function JumpToBottomButton({
  unreadBelowCount,
  onJump,
}: JumpToBottomButtonProps) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onJump}
      className="absolute bottom-4 right-4 md:right-6 z-10 inline-flex items-center gap-1.5 rounded-full bg-blue-500 hover:bg-blue-600 text-white text-xs px-3 py-1.5 shadow-md transition-colors"
      aria-label={t("chat.jumpToBottom")}
      title={t("chat.jumpToBottom")}
    >
      <DownOutlined aria-hidden />
      <span>
        {unreadBelowCount > 0
          ? t("chat.jumpToBottomNewMessages")
          : t("chat.jumpToBottom")}
      </span>
    </button>
  );
}
