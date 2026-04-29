import Runtime from '../Runtime';
import { StandalonePage } from './chrome';

export default function RuntimePage() {
  return (
    <StandalonePage showHeader={false}>
      <Runtime embedded />
    </StandalonePage>
  );
}
