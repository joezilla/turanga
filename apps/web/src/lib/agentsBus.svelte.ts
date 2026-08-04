// A one-value bus the editor bumps after it writes an agent, so the list column refreshes at once
// instead of waiting up to a poll interval. The list is a sibling route layout, not a parent of the
// editor, so there is no props path between them; the 5s poll stays as the backstop for changes
// made elsewhere.
export const agentsBus = $state({ rev: 0 });

export function agentsChanged(): void {
  agentsBus.rev++;
}
