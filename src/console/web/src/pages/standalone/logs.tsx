import Logs from '../Logs';
import { StandalonePage } from './chrome';

export default function LogsPage() {
  return (
    <StandalonePage showHeader={false}>
      <Logs embedded />
    </StandalonePage>
  );
}
