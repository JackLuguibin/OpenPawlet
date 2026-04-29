import Queues from '../Queues';
import { StandalonePage } from './chrome';

export default function QueuesPage() {
  return (
    <StandalonePage showHeader={false}>
      <Queues embedded />
    </StandalonePage>
  );
}
