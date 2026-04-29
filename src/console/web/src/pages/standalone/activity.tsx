import Activity from '../Activity';
import { StandalonePage } from './chrome';

export default function ActivityPage() {
  return (
    <StandalonePage showHeader={false}>
      <Activity embedded />
    </StandalonePage>
  );
}
