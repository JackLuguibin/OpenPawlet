import Skills from '../Skills';
import { StandalonePage } from './chrome';

export default function SkillsPage() {
  return (
    <StandalonePage showHeader={false}>
      <Skills embedded standaloneSurface />
    </StandalonePage>
  );
}
