import { MCPServersPanel } from '../MCPServers';
import { StandalonePage } from './chrome';

export default function McpPage() {
  return (
    <StandalonePage showHeader={false}>
      <MCPServersPanel embedded standaloneSurface />
    </StandalonePage>
  );
}
