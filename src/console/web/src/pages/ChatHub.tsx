import Chat from './Chat';

/**
 * Wrapper around the Chat page kept for routing compatibility. The previous
 * segmented switcher between "Chat" and "Sessions" has been removed; this
 * component now simply renders the chat view.
 */
export default function ChatHub() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <Chat />
    </div>
  );
}
