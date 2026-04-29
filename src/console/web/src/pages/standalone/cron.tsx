import Cron from '../Cron';
import { StandalonePage } from './chrome';

export default function CronPage() {
  return (
    <StandalonePage showHeader={false}>
      <Cron embedded />
    </StandalonePage>
  );
}
