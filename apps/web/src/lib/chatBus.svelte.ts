// A one-value bus the thread page bumps after it renames/deletes a conversation, so the chat list
// column (a sibling route layout, not a parent) refreshes at once instead of staying stale. Mirrors
// agentsBus.svelte.ts.
export const chatBus = $state({ rev: 0 });

export function conversationsChanged(): void {
  chatBus.rev++;
}
