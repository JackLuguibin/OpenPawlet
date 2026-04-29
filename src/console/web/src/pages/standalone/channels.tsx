import Channels from '../Channels';
import { StandalonePage } from './chrome';

export default function ChannelsPage() {
  return (
    <StandalonePage showHeader={false}>
      <Channels embedded />
    </StandalonePage>
  );
}
